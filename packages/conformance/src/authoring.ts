import type { IBrainTileDef, WendooEnvironment } from "@wendoo/core/app";
import {
  BrainTileLiteralDef,
  CoreControlFlowId,
  CoreHostActions,
  CoreTypeIds,
  mkActuatorTileId,
  mkControlFlowTileId,
  mkLiteralTileId,
  mkParameterTileId,
  mkSensorTileId,
} from "@wendoo/core/app";
import { BrainDef, type BrainPageDef, type BrainRuleDef } from "@wendoo/core/brain/model";
import { BrainTileOperatorDef, BrainTileVariableDef } from "@wendoo/core/brain/tiles";
import type { TypeCodec, TypeId } from "@wendoo/core/runtime";
import { ConformanceHostActions, ConformanceParameterId } from "./profile";

/** The tiles a conformance case authors its rules from. */
export interface ConformanceTiles {
  /** WHEN-side sensor tile of `echo(value)`. */
  readonly echo: IBrainTileDef;
  /** DO-side actuator tile of `emit(value)`. */
  readonly emit: IBrainTileDef;
  /** DO-side actuator tile of `defer echo(value, ticks)`. */
  readonly deferEcho: IBrainTileDef;
  /** DO-side actuator tile of `defer fail(ticks)`. */
  readonly deferFail: IBrainTileDef;
  /** DO-side actuator tile of `fault()`. */
  readonly fault: IBrainTileDef;
  /** WHEN-side presence-gated sensor tile of `signal(period)`. */
  readonly signal: IBrainTileDef;
  /** WHEN-side sensor tile of `counter()`. */
  readonly counter: IBrainTileDef;
  /** DO-side actuator tile of `defer cancel(ticks)`. */
  readonly deferCancel: IBrainTileDef;
  /** Parameter tile naming the `ticks` argument of a deferred call. */
  readonly ticks: IBrainTileDef;
  /** Parameter tile naming the `period` argument of `signal`. */
  readonly period: IBrainTileDef;
}

/** The core page tiles a conformance case authors its page lifecycle from. */
export interface CorePageTiles {
  /** DO-side actuator tile of `switch page <number>`, taking the 1-based page ordinal. */
  readonly switchPage: IBrainTileDef;
  /** DO-side actuator tile of `restart page`. */
  readonly restartPage: IBrainTileDef;
  /** WHEN-side sensor tile of `current page`, reading the active page's stable id. */
  readonly currentPage: IBrainTileDef;
  /** WHEN-side sensor tile of `previous page`, reading the most recently deactivated page's stable id. */
  readonly previousPage: IBrainTileDef;
  /** WHEN-side sensor tile of `on page entered`, true on the first read after each activation. */
  readonly onPageEntered: IBrainTileDef;
}

function requireTile(environment: WendooEnvironment, tileId: string): IBrainTileDef {
  const tile = environment.brainServices.edit.tiles.get(tileId);
  if (!tile) {
    throw new Error(`conformance profile did not register tile '${tileId}'`);
  }
  return tile;
}

/**
 * Looks up the conformance profile's tiles in `environment`.
 *
 * @param environment - Environment the conformance module is installed in.
 */
export function conformanceTiles(environment: WendooEnvironment): ConformanceTiles {
  return {
    echo: requireTile(environment, mkSensorTileId(ConformanceHostActions.Echo.key)),
    emit: requireTile(environment, mkActuatorTileId(ConformanceHostActions.Emit.key)),
    deferEcho: requireTile(environment, mkActuatorTileId(ConformanceHostActions.DeferEcho.key)),
    deferFail: requireTile(environment, mkActuatorTileId(ConformanceHostActions.DeferFail.key)),
    fault: requireTile(environment, mkActuatorTileId(ConformanceHostActions.Fault.key)),
    signal: requireTile(environment, mkSensorTileId(ConformanceHostActions.Signal.key)),
    counter: requireTile(environment, mkSensorTileId(ConformanceHostActions.Counter.key)),
    deferCancel: requireTile(environment, mkActuatorTileId(ConformanceHostActions.DeferCancel.key)),
    ticks: requireTile(environment, mkParameterTileId(ConformanceParameterId.Ticks)),
    period: requireTile(environment, mkParameterTileId(ConformanceParameterId.Period)),
  };
}

/**
 * Looks up the core module's page-lifecycle tiles in `environment`.
 *
 * @param environment - Environment the core module is installed in.
 */
export function corePageTiles(environment: WendooEnvironment): CorePageTiles {
  return {
    switchPage: requireTile(environment, mkActuatorTileId(CoreHostActions.SwitchPage.key)),
    restartPage: requireTile(environment, mkActuatorTileId(CoreHostActions.RestartPage.key)),
    currentPage: requireTile(environment, mkSensorTileId(CoreHostActions.CurrentPage.key)),
    previousPage: requireTile(environment, mkSensorTileId(CoreHostActions.PreviousPage.key)),
    onPageEntered: requireTile(environment, mkSensorTileId(CoreHostActions.OnPageEntered.key)),
  };
}

/** A freshly created one-page brain and the page its rules are authored on. */
export interface AuthoredBrain {
  /** The brain document. */
  readonly brainDef: BrainDef;
  /** Page 0 of the brain, carrying one empty rule. */
  readonly page: BrainPageDef;
  /** Page 0's first rule, created with the page. */
  readonly firstRule: BrainRuleDef;
}

/**
 * Creates the empty one-page brain a case authors into.
 *
 * @param environment - Environment the brain's services and id stream come from.
 * @param name - Document name of the brain.
 */
export function newBrain(environment: WendooEnvironment, name: string): AuthoredBrain {
  const brainDef = BrainDef.emptyBrainDef(environment.brainServices, name);
  const page = brainDef.pages().get(0)! as BrainPageDef;
  return { brainDef, page, firstRule: page.children().get(0)! as BrainRuleDef };
}

/** A page appended to an existing brain and the empty rule created with it. */
export interface AuthoredPage {
  /** The appended page. */
  readonly page: BrainPageDef;
  /** The page's first rule, created with the page. */
  readonly firstRule: BrainRuleDef;
}

/**
 * Appends a page to `brainDef`. The `switch page` ordinal of the new page is
 * one more than the number of pages the brain held before the call.
 *
 * @param brainDef - Brain to append the page to.
 * @throws When the brain is already at its page limit.
 */
export function appendPage(brainDef: BrainDef): AuthoredPage {
  const appended = brainDef.appendNewPage();
  if (!appended.success) {
    throw new Error(`brain '${brainDef.name()}' refused another page: ${appended.error.message}`);
  }
  const page = appended.value.page;
  return { page, firstRule: page.children().get(0)! as BrainRuleDef };
}

/**
 * Mints a Number literal tile and registers it in `brainDef`'s catalog, as a
 * document-scoped tile must be to survive serialization.
 *
 * @param environment - Environment supplying the brain services and id stream.
 * @param brainDef - Document the literal belongs to.
 * @param value - Numeric value the literal carries.
 */
export function numberLiteral(environment: WendooEnvironment, brainDef: BrainDef, value: number): IBrainTileDef {
  const literal = new BrainTileLiteralDef(CoreTypeIds.Number, value, {}, environment.brainServices);
  brainDef.catalog().registerTileDef(literal);
  return literal;
}

/**
 * Mints a String literal tile and registers it in `brainDef`'s catalog, as a
 * document-scoped tile must be to survive serialization.
 *
 * @param environment - Environment supplying the brain services and id stream.
 * @param brainDef - Document the literal belongs to.
 * @param value - Text the literal carries.
 */
export function stringLiteral(environment: WendooEnvironment, brainDef: BrainDef, value: string): IBrainTileDef {
  const literal = new BrainTileLiteralDef(CoreTypeIds.String, value, {}, environment.brainServices);
  brainDef.catalog().registerTileDef(literal);
  return literal;
}

/** The core-registered literal tile of `value` at `valueType`. Throws when the catalog holds none. */
function wellKnownLiteral(environment: WendooEnvironment, valueType: TypeId, value: unknown): IBrainTileDef {
  const typeDef = environment.brainServices.runtime.types.get(valueType);
  if (!typeDef) {
    throw new Error(`core registered no type '${valueType}'`);
  }
  return requireTile(environment, mkLiteralTileId(valueType, (typeDef.codec as TypeCodec).stringify(value)));
}

/**
 * The core-registered `true` or `false` literal tile. Throws when the core
 * module registered no Boolean literal for `value`.
 *
 * @param environment - Environment the core module is installed in.
 * @param value - Which of the two tiles to take.
 */
export function booleanLiteral(environment: WendooEnvironment, value: boolean): IBrainTileDef {
  return wellKnownLiteral(environment, CoreTypeIds.Boolean, value);
}

/**
 * The core-registered `nil` literal tile, the one authored operand whose
 * static type is Nil.
 *
 * @param environment - Environment the core module is installed in.
 */
export function nilLiteral(environment: WendooEnvironment): IBrainTileDef {
  return wellKnownLiteral(environment, CoreTypeIds.Nil, undefined);
}

/**
 * `tiles` wrapped in the core parenthesis tiles, so the sequence binds as one
 * operand of the surrounding expression.
 *
 * @param environment - Environment the core module is installed in.
 * @param tiles - Tiles to group, in order.
 */
export function grouped(environment: WendooEnvironment, ...tiles: IBrainTileDef[]): IBrainTileDef[] {
  return [
    requireTile(environment, mkControlFlowTileId(CoreControlFlowId.OpenParen)),
    ...tiles,
    requireTile(environment, mkControlFlowTileId(CoreControlFlowId.CloseParen)),
  ];
}

/**
 * Mints a brain-scoped Number variable tile and registers it in `brainDef`'s
 * catalog. The tile id and the variable's unique id are derived from `name`, so
 * one authored case always names one variable slot.
 *
 * @param brainDef - Document the variable belongs to.
 * @param name - Variable name, as authored and as compiled into the slot pool.
 */
export function numberVariable(brainDef: BrainDef, name: string): IBrainTileDef {
  const variable = new BrainTileVariableDef(`variable:conformance.${name}`, name, CoreTypeIds.Number, name);
  brainDef.catalog().registerTileDef(variable);
  return variable;
}

/**
 * Builds an operator tile for `opId` (a {@link CoreOpId} value).
 *
 * @param environment - Environment supplying the brain services.
 * @param opId - Identifier of the operator, e.g. `CoreOpId.Add`.
 */
export function operatorTile(environment: WendooEnvironment, opId: string): BrainTileOperatorDef {
  return new BrainTileOperatorDef(opId, {}, environment.brainServices);
}

/**
 * Appends `tiles` to `rule`'s DO side, in order.
 *
 * @param rule - Rule to author.
 * @param tiles - Tiles to append.
 */
export function appendDo(rule: BrainRuleDef, ...tiles: IBrainTileDef[]): void {
  for (const tile of tiles) {
    rule.do().appendTile(tile);
  }
}

/**
 * Appends `tiles` to `rule`'s WHEN side, in order.
 *
 * @param rule - Rule to author.
 * @param tiles - Tiles to append.
 */
export function appendWhen(rule: BrainRuleDef, ...tiles: IBrainTileDef[]): void {
  for (const tile of tiles) {
    rule.when().appendTile(tile);
  }
}
