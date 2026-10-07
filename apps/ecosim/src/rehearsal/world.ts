import type { ScenarioInput, ScenarioInputKind } from "@wendoo/assistant-bridge";
import type { IBrainDef, Vector2, WendooEnvironment } from "@wendoo/core/app";
import MatterBodyModule from "phaser/src/physics/matter-js/lib/body/Body.js";
import MatterCompositeModule from "phaser/src/physics/matter-js/lib/body/Composite.js";
import MatterEngineModule from "phaser/src/physics/matter-js/lib/core/Engine.js";
import MatterEventsModule from "phaser/src/physics/matter-js/lib/core/Events.js";
import MatterBodiesModule from "phaser/src/physics/matter-js/lib/factory/Bodies.js";
import type { Actor, Archetype } from "@/brain/actor";
import { ARCHETYPE_NAMES, ARCHETYPES } from "@/brain/archetypes";
import { BLIP_RADIUS, type Blip } from "@/brain/blip";
import { Engine } from "@/brain/engine";
import {
  actorBodyOptions,
  actorBodyRadiusBeforeScale,
  blipBodyOptions,
  blipCollisionFilter,
  boundaryWalls,
  defaultDesiredCounts,
  randomFacing,
  randomSpawnPosition,
  WORLD_FPS,
  WORLD_GRAVITY,
  WORLD_HEIGHT,
  WORLD_WIDTH,
  type WorldRandom,
} from "@/brain/world-definition";
import type { Playground } from "@/game/scenes/Playground";
import { deserializeBrainFromArrayBuffer } from "@/services/brain-persistence";
import type { EcosimEnvironmentStore } from "@/services/ecosim-environment-store";
import type { ShippedBrainDefs } from "./content";
import { shippedBrainBytes } from "./content";

// -- Matter.js, loaded without Phaser -------------------------------------------

const MatterEngine = MatterEngineModule as typeof MatterJS.Engine;
const MatterEvents = MatterEventsModule as typeof MatterJS.Events;
const MatterBodies = MatterBodiesModule as typeof MatterJS.Bodies;
const MatterBody = MatterBodyModule as typeof MatterJS.Body;
const MatterComposite = MatterCompositeModule as typeof MatterJS.Composite;

/** Fixed simulation step in milliseconds: one frame at the world's frame rate. */
export const STEP_MS = 1000 / WORLD_FPS;

/** Project namespace the shipped brain documents deserialize under. */
const PROJECT_NAMESPACE = "ecosim-rehearsal";

/** The world-construction draws of one run, taken from its seeded stream. */
function seededRandom(rng: () => number): WorldRandom {
  return {
    int: (min: number, max: number) => Math.floor(rng() * (max - min + 1)) + min,
    unit: rng,
  };
}

// -- Observation ----------------------------------------------------------------

/**
 * Hooks a caller installs to watch the world's presentation events. Every hook is
 * optional; a hook that is absent is not called.
 */
export interface WorldObserver {
  /** An actor that has just been spawned into the world and given a body. */
  onSpawn?(actor: Actor): void;
  /** A chat bubble reaching presentation, one per `say` the world renders. */
  onSay?(): void;
  /** A blip put into flight, one per `shoot` the world launches. */
  onBlipFired?(): void;
}

// -- Stubs standing in for Phaser presentation ----------------------------------

/** A drawing surface stand-in: accepts every draw call and records nothing. */
function stubGraphics(): Phaser.GameObjects.Graphics {
  const gfx = {
    setDepth: () => gfx,
    clear: () => gfx,
    destroy: () => {},
    fillStyle: () => gfx,
    lineStyle: () => gfx,
    fillRect: () => gfx,
    fillRoundedRect: () => gfx,
    strokeRoundedRect: () => gfx,
    fillTriangle: () => gfx,
    lineBetween: () => gfx,
    beginPath: () => gfx,
    moveTo: () => gfx,
    lineTo: () => gfx,
    closePath: () => gfx,
    strokePath: () => gfx,
    fillPath: () => gfx,
    arc: () => gfx,
  };
  return gfx as unknown as Phaser.GameObjects.Graphics;
}

/** Key/value store stand-in for a game object's data manager. */
class StubData {
  private readonly values = new Map<string, unknown>();
  get(key: string): unknown {
    return this.values.get(key);
  }
  set(key: string, value: unknown): void {
    this.values.set(key, value);
  }
}

// -- Matter-backed sprite stand-in ----------------------------------------------

/**
 * The surface of `Phaser.Physics.Matter.Sprite` that engine, actor, movement,
 * sensor and actuator code touches, backed by a real Matter body. Transform and
 * velocity operations delegate to the same `Matter.Body` calls the Phaser
 * component makes. {@link destroy} leaves the sprite as Phaser leaves a
 * destroyed one: `body` is undefined, and every transform or velocity call
 * throws `TypeError`.
 */
class BodySprite {
  readonly data = new StubData();
  /** The sprite's Matter body, or undefined once the sprite is destroyed. */
  body: MatterJS.BodyType | undefined;

  constructor(
    body: MatterJS.BodyType,
    readonly scene: HeadlessScene
  ) {
    this.body = body;
  }

  get x(): number {
    return this.liveBody().position.x;
  }

  get y(): number {
    return this.liveBody().position.y;
  }

  get rotation(): number {
    return this.liveBody().angle;
  }

  setPosition(x: number, y: number): this {
    MatterBody.setPosition(this.liveBody(), { x, y });
    return this;
  }

  setRotation(radians: number): this {
    MatterBody.setAngle(this.liveBody(), radians);
    return this;
  }

  setVelocity(x: number, y: number): this {
    MatterBody.setVelocity(this.liveBody(), { x, y });
    return this;
  }

  applyForce(force: { x: number; y: number }): this {
    const body = this.liveBody();
    MatterBody.applyForce(body, { x: body.position.x, y: body.position.y }, force);
    return this;
  }

  setVisible(_visible: boolean): this {
    return this;
  }

  setActive(_active: boolean): this {
    return this;
  }

  destroy(): void {
    if (!this.body) return;
    MatterComposite.remove(this.scene.matterWorld, this.body);
    this.body = undefined;
  }

  /** The sprite's body. Throws `TypeError` once the sprite is destroyed. */
  private liveBody(): MatterJS.BodyType {
    if (!this.body) throw new TypeError("the sprite has been destroyed");
    return this.body;
  }
}

// -- Headless scene -------------------------------------------------------------

/** Listener registration, keyed by event name, matching the emitter surface the engine uses. */
interface WorldListener {
  fn: (event: { timestamp: number }) => void;
  context: unknown;
}

/**
 * The `Playground` surface the engine and actors depend on, backed by a real
 * Matter engine stepped directly by {@link HeadlessScene.step}. Owns the world
 * bodies (walls, actor bodies, blip bodies), the collision wiring that turns
 * Matter pairs into engine bump / blip events, and the seeded placement its
 * world construction draws.
 */
class HeadlessScene {
  readonly scale = { width: WORLD_WIDTH, height: WORLD_HEIGHT };
  readonly matterEngine: MatterJS.Engine;
  /** Static line-of-sight blockers; a rehearsal arena holds none. */
  readonly obstacleBodies: MatterJS.BodyType[] = [];
  readonly matter: { world: unknown };
  readonly add = {
    graphics: () => stubGraphics(),
    text: () => {
      this.observer.onSay?.();
      return {
        width: 40,
        height: 12,
        setOrigin: () => undefined,
        setPosition: () => undefined,
        destroy: () => undefined,
      } as unknown as Phaser.GameObjects.Text;
    },
    container: () =>
      ({
        setDepth: () => undefined,
        setPosition: () => undefined,
        destroy: () => undefined,
      }) as unknown as Phaser.GameObjects.Container,
  };
  readonly time = {
    delayedCall: () => ({ elapsed: 0, remove: () => undefined }) as unknown as Phaser.Time.TimerEvent,
  };

  private readonly listeners = new Map<string, WorldListener[]>();
  private readonly random: WorldRandom;
  private engine!: Engine;
  /** Where the next {@link spawn} puts its actor; unset until {@link placeNextSpawn} sets it. */
  private placement?: { readonly x: number; readonly y: number; readonly facing: number };

  constructor(
    rng: () => number,
    private readonly observer: WorldObserver
  ) {
    this.random = seededRandom(rng);
    this.matterEngine = MatterEngine.create();
    this.matterEngine.world.gravity.x = WORLD_GRAVITY.x;
    this.matterEngine.world.gravity.y = WORLD_GRAVITY.y;
    this.matterEngine.world.gravity.scale = WORLD_GRAVITY.scale;

    this.matter = {
      world: {
        drawDebug: false,
        on: (event: string, fn: WorldListener["fn"], context: unknown) => {
          const list = this.listeners.get(event) ?? [];
          list.push({ fn, context });
          this.listeners.set(event, list);
        },
        off: (event: string, fn: WorldListener["fn"], context: unknown) => {
          const list = this.listeners.get(event) ?? [];
          this.listeners.set(
            event,
            list.filter((entry) => entry.fn !== fn || entry.context !== context)
          );
        },
      },
    };

    this.createWalls();
    this.wireMatterEvents();
  }

  /** The Matter composite every body in this world belongs to. */
  get matterWorld(): MatterJS.CompositeType {
    return this.matterEngine.world as unknown as MatterJS.CompositeType;
  }

  /** Bind the ecosim engine whose actors this scene spawns bodies for. */
  attachEngine(engine: Engine): void {
    this.engine = engine;
  }

  /**
   * Advance the world one fixed step: gameplay first (brains think, steering is
   * applied), then physics, in the order the scene's update and the Matter
   * plugin run in.
   */
  step(time: number): void {
    this.engine.tick(time, STEP_MS);
    MatterEngine.update(this.matterEngine, STEP_MS);
  }

  private createWalls(): void {
    for (const { x, y, width, height } of boundaryWalls()) {
      const body = MatterBodies.rectangle(x + width / 2, y + height / 2, width, height, {
        isStatic: true,
        friction: 0,
        frictionStatic: 0,
      });
      MatterComposite.add(this.matterWorld, body);
    }
  }

  /**
   * Forward the Matter engine's own events to the listeners the ecosim engine
   * registered, and translate collision pairs into engine bump / blip calls the
   * same way the scene does.
   */
  private wireMatterEvents(): void {
    MatterEvents.on(this.matterEngine, "afterUpdate", (event: { timestamp: number }) => {
      for (const entry of this.listeners.get("afterupdate") ?? []) {
        entry.fn.call(entry.context, event);
      }
    });
    const onPairs = (event: { pairs: Array<{ bodyA: MatterJS.BodyType; bodyB: MatterJS.BodyType }> }) => {
      for (const pair of event.pairs) {
        this.handlePair(pair.bodyA, pair.bodyB);
      }
    };
    MatterEvents.on(this.matterEngine, "collisionStart", onPairs);
    MatterEvents.on(this.matterEngine, "collisionActive", onPairs);
  }

  private handlePair(bodyA: MatterJS.BodyType, bodyB: MatterJS.BodyType): void {
    const spriteA = bodyA.gameObject as unknown as BodySprite | undefined;
    const spriteB = bodyB.gameObject as unknown as BodySprite | undefined;
    if (spriteA && spriteB) {
      const actorIdA = spriteA.data.get("actorId") as number | undefined;
      const actorIdB = spriteB.data.get("actorId") as number | undefined;
      const blipIdA = spriteA.data.get("blipId") as number | undefined;
      const blipIdB = spriteB.data.get("blipId") as number | undefined;

      if (blipIdA !== undefined && actorIdB !== undefined) {
        this.engine.handleBlipActorCollision(blipIdA, actorIdB);
      } else if (blipIdB !== undefined && actorIdA !== undefined) {
        this.engine.handleBlipActorCollision(blipIdB, actorIdA);
      } else if (actorIdA !== undefined && actorIdB !== undefined) {
        this.engine.handleActorCollision(actorIdA, actorIdB);
      }
      return;
    }
    for (const sprite of [spriteA, spriteB]) {
      const blipId = sprite?.data.get("blipId") as number | undefined;
      if (blipId !== undefined) this.engine.handleBlipWallCollision(blipId);
    }
  }

  /** A spawn position inside the world bounds that clears every obstacle by `radius` pixels. */
  randomPositionWithinBounds(radius?: number): Vector2 {
    return randomSpawnPosition(this.random, this.obstacleBodies, radius);
  }

  /**
   * Put the next actor this scene spawns at (`x`, `y`) turned to `facing`
   * radians, drawing nothing for its placement. Spent by the {@link spawn} that
   * follows; every later spawn draws its placement again.
   */
  placeNextSpawn(x: number, y: number, facing: number): void {
    this.placement = { x, y, facing };
  }

  /** Create the physical body and presentation resources for a newly spawned actor. */
  spawn(actor: Actor): Phaser.Physics.Matter.Sprite {
    const config = ARCHETYPES[actor.archetype].physics;
    const placed = this.placement;
    this.placement = undefined;
    const pos = placed ? { X: placed.x, Y: placed.y } : this.randomPositionWithinBounds(config.radius);
    const body = MatterBodies.circle(pos.X, pos.Y, actorBodyRadiusBeforeScale(config), actorBodyOptions(config));
    MatterBody.scale(body, config.scale, config.scale);
    MatterBody.setAngle(body, placed ? placed.facing : randomFacing(this.random));
    MatterComposite.add(this.matterWorld, body);

    const sprite = new BodySprite(body, this);
    body.gameObject = sprite as unknown as Phaser.GameObjects.GameObject;
    sprite.data.set("actorId", actor.actorId);

    if (actor.plantComp) {
      actor.plantComp.springAnchor = { x: pos.X, y: pos.Y };
    }
    actor.debugGraphics = stubGraphics();
    actor.healthBarGfx = stubGraphics();
    this.observer.onSpawn?.(actor);

    return sprite as unknown as Phaser.Physics.Matter.Sprite;
  }

  /** Put a pooled blip into flight, creating its sensor body on first use. */
  activateBlip(blip: Blip, x: number, y: number, velX: number, velY: number): void {
    this.observer.onBlipFired?.();
    if (!blip.sprite) {
      const body = MatterBodies.circle(x, y, BLIP_RADIUS, blipBodyOptions());
      MatterBody.setInertia(body, Number.POSITIVE_INFINITY);
      MatterComposite.add(this.matterWorld, body);
      const sprite = new BodySprite(body, this);
      body.gameObject = sprite as unknown as Phaser.GameObjects.GameObject;
      blip.sprite = sprite as unknown as Phaser.Physics.Matter.Sprite;
    } else {
      const body = blip.sprite.body as MatterJS.BodyType;
      const filter = blipCollisionFilter();
      body.collisionFilter.category = filter.category;
      body.collisionFilter.mask = filter.mask;
      blip.sprite.setPosition(x, y);
      blip.sprite.setVisible(true);
      blip.sprite.setActive(true);
    }
    blip.sprite.data.set("blipId", blip.blipId);
    blip.sprite.setVelocity(velX, velY);
  }
}

// -- World content --------------------------------------------------------------

/** The brain the app ships for each archetype, deserialized through the app's own loader. */
function loadShippedBrains(env: WendooEnvironment, shipped: ShippedBrainDefs): Record<Archetype, IBrainDef> {
  const brains: Partial<Record<Archetype, IBrainDef>> = {};
  for (const archetype of ARCHETYPE_NAMES) {
    const brain = deserializeBrainFromArrayBuffer(env, shippedBrainBytes(shipped, archetype), PROJECT_NAMESPACE);
    if (!brain) throw new Error(`the shipped ${archetype} brain did not deserialize`);
    brains[archetype] = brain;
  }
  return brains as Record<Archetype, IBrainDef>;
}

/**
 * The environment-store surface the engine reads: the live environment, the
 * fresh-project population targets, and the per-archetype brains, with no
 * project override.
 */
function headlessStore(env: WendooEnvironment, brains: Record<Archetype, IBrainDef>): EcosimEnvironmentStore {
  return {
    env,
    getDesiredCounts: () => defaultDesiredCounts(),
    loadBrainFromProject: async () => undefined,
    getDefaultBrain: (archetype: Archetype) => brains[archetype],
    saveBrainForArchetype: async () => {},
    flushPendingBrainRebuilds: () => {},
  } as unknown as EcosimEnvironmentStore;
}

// -- Scripted world causes ------------------------------------------------------

/** Suffix the input kind of each archetype ends in. */
const AHEAD_SUFFIX = "-ahead";

/** Archetype each scenario input kind stages a creature of, keyed by kind. */
const STAGED_ARCHETYPES: Readonly<Record<string, Archetype>> = Object.fromEntries(
  ARCHETYPE_NAMES.map((archetype) => [`${archetype}${AHEAD_SUFFIX}`, archetype])
);

/** Every percept kind a scenario may script for this world, one per archetype, sorted by name. */
export const SCENARIO_INPUT_KINDS: readonly ScenarioInputKind[] = Object.entries(STAGED_ARCHETYPES)
  .map(([name, archetype]) => ({
    name,
    description:
      `Distance in world pixels at which one ${archetype} is held directly ahead of the creature ` +
      "under study; 0 takes it out of the world.",
  }))
  .sort((a, b) => (a.name < b.name ? -1 : 1));

/** What a run scripts into the world it stages. */
export interface ScriptedCauses {
  /** Percepts the run scripts, each applied before the think it names. */
  readonly inputs: readonly ScenarioInput[];
  /** The creature under study once it has spawned, or undefined before then. */
  subject(): Actor | undefined;
}

/**
 * The creatures a scenario's inputs put in the world. Each archetype a scenario
 * stages is held to a single creature standing a fixed distance directly ahead
 * of the creature under study, and the world keeps no others of that kind.
 */
class StagedCreatures {
  /** Distance in world pixels each staged archetype stands at; zero for a kind taken out of the world. */
  private readonly heldAt = new Map<Archetype, number>();
  /** The creature standing at the staged distance for each archetype the staging holds one of. */
  private readonly standing = new Map<Archetype, Actor>();

  constructor(
    private readonly engine: Engine,
    private readonly scene: HeadlessScene,
    private readonly causes: ScriptedCauses
  ) {}

  /**
   * Apply every input scheduled for the zero-based think `think`, in scenario
   * order. Every entry must name one of {@link SCENARIO_INPUT_KINDS}.
   */
  applyScheduled(think: number): void {
    for (const input of this.causes.inputs) {
      if (input.at !== think) continue;
      this.hold(STAGED_ARCHETYPES[input.kind], Number(input.value));
    }
  }

  /**
   * Put every held creature where the scenario holds it, taking over the
   * world's own creature of a staged kind, or spawning one when the world
   * has none. Does nothing while the creature under study is not in the
   * world: before it spawns, and after the engine has killed it.
   */
  place(): void {
    const subject = this.causes.subject();
    if (!subject || this.engine.getActorById(subject.actorId) !== subject) return;
    for (const [archetype, distance] of this.heldAt) {
      if (distance <= 0) continue;
      const facing = subject.sprite.rotation;
      const x = subject.sprite.x + Math.cos(facing) * distance;
      const y = subject.sprite.y + Math.sin(facing) * distance;
      const creature = this.standingCreature(archetype, subject, x, y, facing);
      if (!creature) continue;
      creature.sprite.setPosition(x, y);
      creature.sprite.setVelocity(0, 0);
    }
  }

  /**
   * Take the world's population of `archetype` down to what `distance` asks:
   * one creature held that far ahead of the creature under study, or none at
   * all at zero. Every other creature of that kind dies where it stands, the
   * creature under study excepted.
   */
  private hold(archetype: Archetype, distance: number): void {
    this.heldAt.set(archetype, distance);
    this.engine.setDesiredCount(archetype, distance > 0 ? 1 : 0);
    const kept = distance > 0 ? this.standing.get(archetype) : undefined;
    if (!kept) this.standing.delete(archetype);
    const subject = this.causes.subject();
    for (const actor of this.engine.getActorsByArchetype(archetype)) {
      if (actor !== kept && actor !== subject) actor.drainEnergy(actor.energy);
    }
  }

  /**
   * The creature standing for `archetype`: the one the staging already holds
   * while it lives, else a creature of that kind the world put there on its
   * own, else one spawned at (`x`, `y`) facing `facing`. Never `subject`.
   */
  private standingCreature(
    archetype: Archetype,
    subject: Actor,
    x: number,
    y: number,
    facing: number
  ): Actor | undefined {
    const held = this.standing.get(archetype);
    if (held && this.engine.getActorById(held.actorId) === held) return held;
    const taken = this.takeOver(archetype, subject);
    if (taken) {
      this.standing.set(archetype, taken);
      return taken;
    }
    this.scene.placeNextSpawn(x, y, facing);
    const spawned = this.engine.spawn(archetype);
    if (spawned) this.standing.set(archetype, spawned);
    return spawned;
  }

  /**
   * A creature of `archetype` the staging can hold in place of spawning its
   * own: one the world's own population keeps, neither the creature under
   * study nor one this staging has already drained.
   */
  private takeOver(archetype: Archetype, subject: Actor): Actor | undefined {
    for (const actor of this.engine.getActorsByArchetype(archetype)) {
      if (actor !== subject && actor.energy > 0) return actor;
    }
    return undefined;
  }
}

/** Every live actor, ordered by actor id. */
export function liveActors(engine: Engine): Actor[] {
  const actors: Actor[] = [];
  for (const archetype of ARCHETYPE_NAMES) {
    actors.push(...engine.getActorsByArchetype(archetype));
  }
  actors.sort((a, b) => a.actorId - b.actorId);
  return actors;
}

// -- Rehearsal world ------------------------------------------------------------

/** How one rehearsal world is staged. */
export interface RehearsalWorldOptions {
  /** Environment the world's brains are built and run in. */
  readonly environment: WendooEnvironment;
  /**
   * The run's seeded random stream. Every world-construction choice draws from
   * it -- spawn positions, spawn facing -- so the same stream reproduces the
   * world exactly.
   */
  readonly next: () => number;
  readonly observer: WorldObserver;
  /** The brain document the app ships for each archetype, which the world populates from. */
  readonly shippedBrains: ShippedBrainDefs;
  /** Brains to run in place of the shipped defaults, built against {@link environment}. */
  readonly brains?: Partial<Record<Archetype, IBrainDef>>;
  /** World causes the run scripts. */
  readonly scripted?: ScriptedCauses;
}

/** A staged, running rehearsal world. */
export interface RehearsalWorld {
  /** Static line-of-sight blockers standing in the world; a rehearsal arena holds none. */
  readonly obstacleCount: number;
  /** Advance the world one fixed step of {@link STEP_MS} milliseconds. */
  step(): void;
  /** Every live actor, ordered by actor id. */
  actors(): Actor[];
  /** Tear the world down; no step may follow. */
  shutdown(): void;
}

/**
 * Stage a whole ecosim world headlessly: the app's shipped brains loaded into
 * `options.environment`, and a Matter world stepped directly. The world is
 * populated by its first {@link RehearsalWorld.step}.
 */
export async function createRehearsalWorld(options: RehearsalWorldOptions): Promise<RehearsalWorld> {
  const { environment, next, observer } = options;
  const brains = { ...loadShippedBrains(environment, options.shippedBrains), ...options.brains };

  const scene = new HeadlessScene(next, observer);
  const engine = new Engine(scene as unknown as Playground, scene.obstacleBodies, headlessStore(environment, brains));
  scene.attachEngine(engine);
  engine.start();
  await engine.loadBrains();

  const staged = options.scripted ? new StagedCreatures(engine, scene, options.scripted) : undefined;
  let time = 0;
  let think = 0;
  return {
    obstacleCount: scene.obstacleBodies.length,
    step: () => {
      staged?.applyScheduled(think);
      staged?.place();
      scene.step(time);
      time += STEP_MS;
      think++;
    },
    actors: () => liveActors(engine),
    shutdown: () => engine.shutdown(),
  };
}
