import type { BrainDef, Vector2, WendooEnvironment } from "@wendoo/core/app";
import * as ECS from "miniplex";
import type { Playground } from "@/game/scenes/Playground";
import { heatColor } from "@/lib/color";
import type { EcosimEnvironmentStore } from "@/services/ecosim-environment-store";
import { Actor, type Archetype } from "./actor";
import { ARCHETYPE_NAMES, ARCHETYPES, createArchetypeFallbackBrain } from "./archetypes";
import { BLIP_DAMAGE, BLIP_RADIUS, BLIP_SPEED, type Blip, BlipPool } from "./blip";
import type { MoverConfig } from "./movement";
import { drawMovementIntent } from "./movement";
import { type ScoreSnapshot, ScoreTracker } from "./score";
import { SpatialGrid } from "./spatial-grid";
import { type PrecomputedObstacle, queryVisibleActors, refreshObstaclesFromBodies, type SightResult } from "./vision";

export class Engine {
  private world: ECS.World<Actor>;
  private actors: { [key in Archetype]: ECS.Query<Actor> };
  /**
   * Per-archetype brain defs. Undefined until {@link loadBrains} resolves.
   */
  private brains?: { [key in Archetype]: BrainDef };
  private moverCfg: { [key in Archetype]: Partial<MoverConfig> };

  get clock(): Phaser.Time.Clock {
    return this.scene.time;
  }

  get env(): WendooEnvironment {
    return this.store.env;
  }

  get worldWidth(): number {
    return this.scene.scale.width;
  }

  get worldHeight(): number {
    return this.scene.scale.height;
  }

  /** Spatial grid rebuilt each tick for fast proximity queries */
  private grid!: SpatialGrid;

  /** Tracks per-archetype stats and computes the ecosystem score. */
  private scoreTracker = new ScoreTracker();

  /** Simulation elapsed time in milliseconds (accounts for time-scaling). */
  private _elapsedMs = 0;

  /** Simulation elapsed time in ms, accounting for time-scaling. */
  get simTime(): number {
    return this._elapsedMs;
  }

  /**
   * Live world-AABBs of every obstacle body, refreshed at the top of each
   * tick from `obstacleBodies`. Exposed via {@link obstacles} for steering
   * and consumed directly by LOS checks. Rebuilt in-place to avoid GC.
   */
  private precomputedObstacles: PrecomputedObstacle[] = [];

  /**
   * Current obstacle AABBs (live). Steering and any other consumers should
   * read this each tick rather than caching, because obstacles can be
   * dragged and rotated by the user.
   */
  get obstacles(): ReadonlyArray<PrecomputedObstacle> {
    return this.precomputedObstacles;
  }

  /** Persistent graphics object for the spatial-grid debug overlay */
  private gridDebugGfx?: Phaser.GameObjects.Graphics;

  /**
   * Queue of pending respawns. Each entry records the archetype and the
   * engine clock time (ms) after which the spawn should fire.
   */
  private pendingRespawns: Array<{ archetype: Archetype; at: number }> = [];

  /**
   * Desired population target per archetype set by the UI sliders.
   * The engine spawns actors when below these targets and suppresses
   * respawns when at or above them. Actors are never actively killed;
   * excess populations die off naturally.
   */
  private desiredCounts: Record<Archetype, number>;

  /** Max actors to spawn per archetype per tick to avoid frame spikes. */
  private static readonly MAX_SPAWNS_PER_TICK = 3;

  /**
   * Monotonically increasing tick counter.
   * Used by actors for phase-based round-robin vision staggering.
   */
  tickCount = 0;

  /** Active blip projectiles. */
  private blipPool!: BlipPool;

  /**
   * Matter world carrying this engine's physics-step listener. Set by
   * {@link start} and cleared by {@link shutdown}; undefined outside that
   * window.
   */
  private matterWorld?: Phaser.Physics.Matter.World;

  private _isShutdown = false;
  private prevPhysicsTimestamp = 0;

  /**
   * Number of vision phases. Actors are assigned phase = actorId % VISION_PHASES.
   * Only actors whose phase matches the current tick run a vision query.
   * Higher = more amortization but staler sight data.
   * 3 phases at 60fps = each actor refreshes vision every ~50ms.
   */
  static readonly VISION_PHASES = 3;

  constructor(
    private scene: Playground,
    readonly obstacleBodies: ReadonlyArray<MatterJS.BodyType> = [],
    private readonly store: EcosimEnvironmentStore
  ) {
    this.world = new ECS.World<Actor>();
    this.actors = {
      carnivore: this.world.where((actor) => actor.archetype === "carnivore"),
      herbivore: this.world.where((actor) => actor.archetype === "herbivore"),
      plant: this.world.where((actor) => actor.archetype === "plant"),
    };

    this.moverCfg = {
      carnivore: ARCHETYPES.carnivore.mover,
      herbivore: ARCHETYPES.herbivore.mover,
      plant: ARCHETYPES.plant.mover,
    };

    this.desiredCounts = { ...store.getDesiredCounts() };
  }

  /**
   * Build the per-run resources the engine owns -- spatial grid, debug
   * overlay, blip pool -- and attach the physics-step listener. Call once,
   * after construction and before {@link tick}. Pair with {@link shutdown}.
   */
  start(): void {
    this.grid = new SpatialGrid(this.worldWidth, this.worldHeight, 150);
    refreshObstaclesFromBodies(this.obstacleBodies, this.precomputedObstacles);
    this.gridDebugGfx = this.scene.add.graphics();
    this.gridDebugGfx.setDepth(-2);
    this.blipPool = new BlipPool(this);
    this.matterWorld = this.scene.matter.world;
    this.matterWorld.on("afterupdate", this.onAfterPhysicsUpdate, this);
  }

  /**
   * Load each archetype's brain from the active project, falling back to the
   * default asset or a generated brain. Until this resolves the engine has no
   * brains and {@link getBrainDef} returns undefined.
   */
  async loadBrains(): Promise<void> {
    this.brains = {
      carnivore: await this.loadBrainDef("carnivore"),
      herbivore: await this.loadBrainDef("herbivore"),
      plant: await this.loadBrainDef("plant"),
    };
  }

  private onAfterPhysicsUpdate(event: { timestamp: number }) {
    const dt = this.prevPhysicsTimestamp > 0 ? event.timestamp - this.prevPhysicsTimestamp : 0;
    this.prevPhysicsTimestamp = event.timestamp;
    if (dt <= 0) return;
    for (const actor of this.world.entities) {
      actor.physicsTick(event.timestamp, dt);
    }
  }

  /**
   * Release everything the engine owns: the physics-step listener, blip
   * sprites, each actor's graphics, timers and brain, the loaded archetype
   * brain defs, and the ECS world. Idempotent -- later calls do nothing. Runs
   * to completion whether the owning scene is still live or has already torn
   * down its plugins.
   */
  shutdown() {
    if (this._isShutdown) return;
    this._isShutdown = true;
    this.brains = undefined;
    this.matterWorld?.off("afterupdate", this.onAfterPhysicsUpdate, this);
    this.matterWorld = undefined;

    // Clean up blips
    this.blipPool.destroyAll();

    this.gridDebugGfx?.destroy();
    this.gridDebugGfx = undefined;

    // Clean up each actor's resources (timers, graphics, etc.)
    for (const actor of this.world.entities) {
      actor.destroy();
    }
    this.world.clear();
  }

  private async loadBrainDef(archetype: Archetype): Promise<BrainDef> {
    const fromProject = await this.store.loadBrainFromProject(archetype);
    if (fromProject) return fromProject;

    const fromAsset = this.store.getDefaultBrain(archetype);
    const brain = fromAsset ? fromAsset.clone() : createArchetypeFallbackBrain(this.env, archetype);
    await this.store.saveBrainForArchetype(archetype, brain);
    return brain;
  }

  tick(time: number, dt: number) {
    if (this._isShutdown) return;
    this.store.flushPendingBrainRebuilds();

    // Refresh obstacle AABBs from live Matter bodies. Obstacles are
    // dynamic (draggable) so their position/rotation can change every
    // frame; any stale snapshot would let LOS rays and avoidance see
    // obstacles where they used to be rather than where they are now.
    refreshObstaclesFromBodies(this.obstacleBodies, this.precomputedObstacles);

    // Rebuild spatial grid once per tick -- O(N) and avoids incremental bookkeeping
    this.grid.rebuild(this.world.entities);

    // Advance tick counter (used for vision phase staggering)
    this.tickCount++;

    for (const actor of this.world.entities) {
      actor.tick(time, dt);
    }

    // Detect actors whose energy reached zero and schedule respawns.
    // Iterate over a snapshot so we can safely mutate the world mid-loop.
    const entities = [...this.world.entities];
    for (const actor of entities) {
      if (!actor.isDying && actor.energy <= 0) {
        this.killActor(actor);
      }
    }

    // Fire any pending respawns whose delay has elapsed, but only if
    // the population is still below the desired count for that archetype.
    const now = this.simTime;
    this.pendingRespawns = this.pendingRespawns.filter((pending) => {
      if (now >= pending.at) {
        if (this.actors[pending.archetype].entities.length < this.desiredCounts[pending.archetype]) {
          this.spawn(pending.archetype);
        }
        return false;
      }
      return true;
    });

    // If any archetype is below its desired count and has no pending
    // respawns that will cover the deficit, spawn some immediately
    // (capped to avoid frame spikes).
    for (const arch of ARCHETYPE_NAMES) {
      const current = this.actors[arch].entities.length;
      const desired = this.desiredCounts[arch];
      const pendingForArch = this.pendingRespawns.filter((p) => p.archetype === arch).length;
      const deficit = desired - current - pendingForArch;
      if (deficit > 0) {
        const toSpawn = Math.min(deficit, Engine.MAX_SPAWNS_PER_TICK);
        for (let i = 0; i < toSpawn; i++) {
          this.spawn(arch);
        }
      }
    }

    // Update score tracker with live population data
    this._elapsedMs += dt;
    const aliveCounts = { carnivore: 0, herbivore: 0, plant: 0 };
    const energySums = { carnivore: 0, herbivore: 0, plant: 0 };
    for (const actor of this.world.entities) {
      aliveCounts[actor.archetype]++;
      energySums[actor.archetype] += actor.energy;
    }
    this.scoreTracker.update(aliveCounts, energySums, this._elapsedMs, dt);

    // Tick blips -- expire old ones and handle out-of-bounds
    this.tickBlips();
  }

  /**
   * Kill an actor: remove it from the ECS world, destroy its sprite and
   * internal resources, then schedule a replacement spawn after the
   * archetype's configured respawn delay.
   */
  private killActor(actor: Actor): void {
    actor.isDying = true;
    const lifespanMs = this.simTime - actor.bornAt;
    this.scoreTracker.recordDeath(actor.archetype, lifespanMs);
    const delay = ARCHETYPES[actor.archetype].respawnDelay;
    this.pendingRespawns.push({
      archetype: actor.archetype,
      at: this.simTime + delay,
    });
    this.world.remove(actor);
    actor.sprite.destroy();
    actor.destroy();
  }

  /**
   * Redraw every actor's floating health bar to reflect current energy.
   * The bar is drawn above the sprite center:
   *   full energy -> green, half -> yellow, empty -> red.
   * Should be called once per rendered frame from the scene's update().
   */
  updateEnergyVisuals(): void {
    const BAR_WIDTH = 26;
    const BAR_HEIGHT = 4;
    const BG_COLOR = 0x222222;
    const BG_ALPHA = 0.75;

    for (const actor of this.world.entities) {
      const gfx = actor.healthBarGfx;
      if (!gfx) continue;

      gfx.clear();

      const ratio = actor.maxEnergy > 0 ? actor.energy / actor.maxEnergy : 1;
      const physCfg = ARCHETYPES[actor.archetype].physics;
      const visualRadius = physCfg.radius * physCfg.scale;

      const cx = actor.sprite.x;
      const barBottom = actor.sprite.y - visualRadius - 5;
      const barTop = barBottom - BAR_HEIGHT;
      const barLeft = cx - BAR_WIDTH / 2;

      // Background track
      gfx.fillStyle(BG_COLOR, BG_ALPHA);
      gfx.fillRect(barLeft, barTop, BAR_WIDTH, BAR_HEIGHT);

      // Filled portion -- heatColor(0) = green, heatColor(1) = red
      const fillColor = heatColor(1 - ratio);
      const fillWidth = Math.round(BAR_WIDTH * ratio);
      if (fillWidth > 0) {
        gfx.fillStyle(fillColor, 1);
        gfx.fillRect(barLeft, barTop, fillWidth, BAR_HEIGHT);
      }
    }
  }

  /**
   * Add a live actor of `archetype`, running the archetype's current brain.
   * Returns undefined until {@link loadBrains} has resolved.
   */
  spawn(archetype: Archetype): Actor | undefined {
    const brains = this.brains;
    if (!brains) return undefined;
    const actor = new Actor(this, archetype, brains[archetype], this.moverCfg[archetype]);
    this.world.add(actor);
    actor.actorId = this.world.id(actor)!;
    actor.sprite = this.scene.spawn(actor);
    return actor;
  }

  handleActorCollision(actorIdA: number, actorIdB: number) {
    const actorA = this.world.entity(actorIdA);
    const actorB = this.world.entity(actorIdB);

    if (actorA && actorB) {
      //console.log(`Collision detected between Actor ${actorA.actorId} and Actor ${actorB.actorId}`);

      // enqueue collision event on both actors for processing in brain logic
      actorA.enqueueBump(actorB.actorId);
      actorB.enqueueBump(actorA.actorId);
    }
  }

  /**
   * Whether the engine currently holds a brain for every archetype. False
   * before {@link loadBrains} resolves, when it rejects, and again once
   * {@link shutdown} has released the engine. While it is false
   * {@link getBrainDef} returns undefined for every archetype.
   */
  get hasLoadedBrains(): boolean {
    return this.brains !== undefined;
  }

  /**
   * The archetype's current brain def, or undefined while {@link loadBrains}
   * has not resolved.
   */
  getBrainDef(archetype: Archetype): BrainDef | undefined {
    return this.brains?.[archetype];
  }

  /**
   * Replace the archetype's brain def and push it onto every live actor of
   * that archetype. Does nothing until {@link loadBrains} has resolved.
   */
  updateBrainDef(archetype: Archetype, newBrainDef: BrainDef) {
    if (!this.brains) return;
    this.brains[archetype] = newBrainDef;
    // Update all existing actors of this archetype with the new brain
    const actorsQuery = this.actors[archetype];
    for (const actor of actorsQuery.entities) {
      actor.replaceBrain(newBrainDef);
    }
  }

  /**
   * Reload the archetype's brain from the active project -- falling back to
   * the default asset or a generated brain, saved to the project, when the
   * project holds none -- and push it onto every live actor of that
   * archetype. Does nothing until {@link loadBrains} has resolved.
   */
  async reloadBrain(archetype: Archetype): Promise<void> {
    if (!this.brains) return;
    this.updateBrainDef(archetype, await this.loadBrainDef(archetype));
  }

  getActorById(actorId: number): Actor | undefined {
    return this.world.entity(actorId) || undefined;
  }

  getActorsByArchetype(archetype: Archetype): readonly Actor[] {
    const query = this.actors[archetype];
    return query ? query.entities : [];
  }

  /** Set the desired population target for an archetype (0-100). */
  setDesiredCount(archetype: Archetype, count: number): void {
    this.desiredCounts[archetype] = Math.max(0, Math.min(100, Math.round(count)));
  }

  /** Get the current desired population target for an archetype. */
  getDesiredCount(archetype: Archetype): number {
    return this.desiredCounts[archetype];
  }

  /** Return a snapshot of the current simulation scores. */
  getScoreSnapshot(): ScoreSnapshot {
    return this.scoreTracker.getSnapshot();
  }

  /**
   * Query which actors are visible to the given actor within a forward-facing cone,
   * accounting for obstacle occlusion.
   *
   * @param self       The observing actor
   * @param range      Maximum sight distance in pixels
   * @param halfAngle  Half-angle of the vision cone in radians
   * @returns          Visible actors sorted nearest-first
   */
  queryVisibleActors(self: Actor, range: number, halfAngle: number): SightResult[] {
    return queryVisibleActors(self, this.grid, range, halfAngle, this.precomputedObstacles, self.sightQueue);
  }

  /**
   * Draw debug visualization for all actors with vision enabled.
   * Should be called every frame - automatically clears when debug mode is off.
   */
  drawDebugVisionCones(): void {
    const debugEnabled = this.scene.matter.world.drawDebug;

    // Draw / clear the spatial grid overlay
    this.drawDebugGrid(debugEnabled);

    // Single time value shared across all target lines this frame.
    const globalT = this.scene.time.now * 0.06;
    const dashLen = 8;
    const gapLen = 6;
    const period = dashLen + gapLen;

    for (const actor of this.world.entities) {
      if (debugEnabled && actor.debugGraphics) {
        // Clear graphics for this frame
        actor.debugGraphics.clear();

        // Draw vision cone if actor has vision
        if (actor.hasVision) {
          //drawVisionCone(actor.debugGraphics, actor, actor.visionRange, actor.visionFOV / 2);
        }

        // Draw movement intent if actor has a saved intent from last tick
        if (actor.lastIntent) {
          drawMovementIntent(actor.debugGraphics, actor, actor.lastIntent);
        }

        // Draw a target line for each actor this brain is currently targeting.
        if (actor.debugTargetPositions.size > 0) {
          const ax = actor.sprite.x;
          const ay = actor.sprite.y;
          actor.debugGraphics.lineStyle(2, 0x44aaff, 0.7);
          for (const targetPos of actor.debugTargetPositions.values()) {
            const tx = targetPos.X;
            const ty = targetPos.Y;
            const dx = tx - ax;
            const dy = ty - ay;
            const len = Math.sqrt(dx * dx + dy * dy);
            if (len > 0) {
              const nx = dx / len;
              const ny = dy / len;
              const phase = globalT % period;
              for (let d = phase - period; d < len; d += period) {
                const s = Math.max(d, 0);
                const e = Math.min(d + dashLen, len);
                if (e > s) {
                  actor.debugGraphics.beginPath();
                  actor.debugGraphics.moveTo(ax + nx * s, ay + ny * s);
                  actor.debugGraphics.lineTo(ax + nx * e, ay + ny * e);
                  actor.debugGraphics.strokePath();
                }
              }
            }
          }
        }
      } else if (actor.debugGraphics) {
        // Clear graphics if debug is off
        actor.debugGraphics.clear();
      }
    }
  }

  /**
   * Draw (or clear) the spatial-grid debug overlay.
   *
   * When enabled, renders:
   * - A **heat-map fill** per cell coloured by actor density
   *   (transparent -> green -> yellow -> red as count increases).
   * - Thin grid lines showing cell boundaries.
   */
  private drawDebugGrid(enabled: boolean): void {
    const gfx = this.gridDebugGfx;
    if (!gfx) return;
    gfx.clear();
    if (!enabled || !this.grid) return;

    const { cells, numCols, numRows, cellSize } = this.grid;

    // Find max occupancy for heat-map normalisation
    let maxCount = 1;
    for (let i = 0; i < cells.length; i++) {
      if (cells[i].length > maxCount) maxCount = cells[i].length;
    }

    // Draw cell heat-map fills
    for (let row = 0; row < numRows; row++) {
      const y = row * cellSize;
      const rowOff = row * numCols;
      for (let col = 0; col < numCols; col++) {
        const count = cells[col + rowOff].length;
        if (count === 0) continue;

        const color = heatColor(count / maxCount);

        const x = col * cellSize;
        gfx.fillStyle(color, 0.15);
        gfx.fillRect(x, y, cellSize, cellSize);
      }
    }

    // Draw grid lines
    gfx.lineStyle(1, 0xffffff, 0.12);
    for (let col = 0; col <= numCols; col++) {
      const x = col * cellSize;
      gfx.lineBetween(x, 0, x, numRows * cellSize);
    }
    for (let row = 0; row <= numRows; row++) {
      const y = row * cellSize;
      gfx.lineBetween(0, y, numCols * cellSize, y);
    }
  }

  randomPosition(): Vector2 {
    return this.scene.randomPositionWithinBounds();
  }

  // -- Blip management ------------------------------------------------

  /**
   * Create a blip projectile at the given position travelling in (dirX, dirY).
   * Called from the shoot actuator. Returns the Blip or undefined if the cap
   * has been reached.
   */
  spawnBlip(shooterActorId: number, x: number, y: number, dirX: number, dirY: number): Blip | undefined {
    const blip = this.blipPool.acquire(shooterActorId, this.simTime);
    if (!blip) return undefined;

    // Offset spawn point slightly so it does not immediately overlap the shooter
    const offset = BLIP_RADIUS * 4;
    const spawnX = x + dirX * offset;
    const spawnY = y + dirY * offset;

    this.scene.activateBlip(blip, spawnX, spawnY, dirX * BLIP_SPEED, dirY * BLIP_SPEED);
    return blip;
  }

  /**
   * Handle a collision between a blip and an actor.
   * The blip is returned to the pool and the actor loses energy.
   */
  handleBlipActorCollision(blipId: number, actorId: number): void {
    const blip = this.blipPool.activeById.get(blipId);
    if (!blip || !blip.alive) return;

    // Don't damage the shooter
    if (actorId === blip.shooterActorId) return;

    const actor = this.getActorById(actorId);
    if (!actor || actor.isDying) return;

    actor.drainEnergy(BLIP_DAMAGE);
    this.blipPool.release(blip);
  }

  /** Handle a blip hitting a wall (return it to the pool). */
  handleBlipWallCollision(blipId: number): void {
    const blip = this.blipPool.activeById.get(blipId);
    if (!blip || !blip.alive) return;
    this.blipPool.release(blip);
  }

  /** Return expired blips to the pool. */
  private tickBlips(): void {
    const now = this.simTime;
    for (const blip of this.blipPool.activeById.values()) {
      if (blip.isExpired(now)) {
        this.blipPool.release(blip);
      }
    }
  }
}
