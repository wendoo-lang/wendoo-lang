import { CoreHostActions } from "@wendoo/core/runtime";
/**
 * Tile suggestion language service tests.
 *
 * Verifies that suggestTiles returns the correct tile suggestions based on
 * insertion context, rule side, type constraints, action call specs,
 * operator overloads, parentheses depth, and capability requirements.
 */

import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { List, type ReadonlyList, UniqueSet } from "@wendoo/core";
import {
  type BrainServices,
  CoreCapabilityBits,
  CoreControlFlowId,
  type IBrainTileDef,
  type ITileCatalog,
  mkAccessorTileId,
  mkControlFlowTileId,
  mkOperatorTileId,
  RuleSide,
  RuleTriggerMode,
  type SlotExpr,
  TilePlacement,
} from "@wendoo/core/brain";
import { __test__appendTile, __test__createBrainServices } from "@wendoo/core/brain/__test__";
import type {
  ActuatorExpr,
  BinaryOpExpr,
  Expr,
  FieldAccessExpr,
  LiteralExpr,
  ParameterExpr,
  SensorExpr,
  UnaryOpExpr,
  VariableExpr,
} from "@wendoo/core/brain/compiler";
import {
  availableTriggerModes,
  buildInsertionContext,
  collectRuleHierarchyCapabilities,
  collectRuleHierarchyOutputKeys,
  countUnclosedParens,
  getRuleWhenResultType,
  getTileOutputType,
  type InsertionContext,
  parseTilesForSuggestions,
  suggestTiles,
  TileCompatibility,
  type TileSuggestionResult,
} from "@wendoo/core/brain/language-service";
import { BrainDef, type BrainRuleDef } from "@wendoo/core/brain/model";
import {
  BrainTileAccessorDef,
  BrainTileActuatorDef,
  BrainTileLiteralDef,
  BrainTileModifierDef,
  type BrainTileOperatorDef,
  BrainTileOutputDef,
  BrainTilePageDef,
  BrainTileParameterDef,
  BrainTileSensorDef,
  BrainTileVariableDef,
} from "@wendoo/core/brain/tiles";
import type { ExecutionContext } from "@wendoo/core/runtime";
import {
  bag,
  CoreOpId,
  CoreParameterId,
  CoreTypeIds,
  choice,
  conditional,
  type IConversionRegistry,
  mkActionDescriptor,
  mkActuatorTileId,
  mkCallDef,
  mkModifierTileId,
  mkParameterTileId,
  mkSensorTileId,
  mod,
  NIL_VALUE,
  optional,
  param,
  repeated,
  seq,
  TRUE_VALUE,
  type Value,
  VOID_VALUE,
} from "@wendoo/core/runtime";
import { BitSet } from "@wendoo/core/util";

// ---- Initialize ----

let services: BrainServices;

before(() => {
  services = __test__createBrainServices();
});

let nextTypeAtomId = 20000;

function mkTestAtomId(): number {
  return nextTypeAtomId++;
}

// ---- Helpers ----

function catalogList(): List<ITileCatalog> {
  return List.from([services.edit.tiles]);
}

function listFind<T>(list: List<T>, predicate: (item: T) => boolean): T | undefined {
  for (let i = 0; i < list.size(); i++) {
    const item = list.get(i);
    if (predicate(item)) return item;
  }
  return undefined;
}

function listEvery<T>(list: List<T>, predicate: (item: T) => boolean): boolean {
  for (let i = 0; i < list.size(); i++) {
    if (!predicate(list.get(i))) return false;
  }
  return true;
}

function resultContains(result: TileSuggestionResult, tileId: string): boolean {
  return listFind(result.exact, (s) => s.tileDef.tileId === tileId) !== undefined;
}

// ---- Test 1: No type constraint, WHEN side ----

test("Test 1: Expression position, WHEN side, no type constraint", () => {
  const ctx: InsertionContext = { ruleSide: RuleSide.When };
  const result = suggestTiles(ctx, catalogList(), services);

  const hasSensor = listFind(result.exact, (s) => s.tileDef.kind === "sensor") !== undefined;
  assert.ok(hasSensor, "Should include sensor tiles on WHEN side");

  const hasActuator = listFind(result.exact, (s) => s.tileDef.kind === "actuator") !== undefined;
  assert.ok(!hasActuator, "Should NOT include actuator tiles on WHEN side");

  const hasParam = listFind(result.exact, (s) => s.tileDef.kind === "parameter") !== undefined;
  const hasMod = listFind(result.exact, (s) => s.tileDef.kind === "modifier") !== undefined;
  assert.ok(!hasParam, "Should NOT include parameter tiles outside action context");
  assert.ok(!hasMod, "Should NOT include modifier tiles outside action context");

  const allUnchecked = listEvery(result.exact, (s) => s.compatibility === TileCompatibility.Unchecked);
  assert.ok(allUnchecked, "All exact results should be Unchecked when no expectedType");

  assert.equal(result.withConversion.size(), 0, "No conversion results when no type constraint");
});

// ---- Test 2: Expected Number type, Either side ----

test("Test 2: Expression position, Either side, expected Number", () => {
  const ctx: InsertionContext = {
    ruleSide: RuleSide.Either,
    expectedType: CoreTypeIds.Number,
  };
  const result = suggestTiles(ctx, catalogList(), services);

  const hasFactory =
    listFind(
      result.exact,
      (s) => s.tileDef.kind === "factory" && getTileOutputType(s.tileDef) === CoreTypeIds.Number
    ) !== undefined;
  assert.ok(hasFactory, "Should include Number factory as exact match");

  const hasRandom =
    listFind(
      result.exact,
      (s) => s.tileDef.kind === "sensor" && getTileOutputType(s.tileDef) === CoreTypeIds.Number
    ) !== undefined;
  assert.ok(hasRandom, "Should include Random sensor as exact match for Number");

  const boolConversion = listFind(result.withConversion, (s) => getTileOutputType(s.tileDef) === CoreTypeIds.Boolean);
  assert.ok(boolConversion !== undefined, "Boolean tiles should be in withConversion for Number");
  if (boolConversion) {
    assert.ok(boolConversion.conversionCost > 0, "Conversion cost should be > 0");
  }

  const strConversion = listFind(result.withConversion, (s) => getTileOutputType(s.tileDef) === CoreTypeIds.String);
  assert.ok(strConversion !== undefined, "String tiles should be in withConversion for Number");
});

// ---- Test 3: DO side placement filtering ----

test("Test 3: Expression position, DO side, no type constraint", () => {
  const ctx: InsertionContext = { ruleSide: RuleSide.Do };
  const result = suggestTiles(ctx, catalogList(), services);

  const hasActuator = listFind(result.exact, (s) => s.tileDef.kind === "actuator") !== undefined;
  assert.ok(hasActuator, "Should include actuator tiles on DO side");

  const hasInfixOp =
    listFind(
      result.exact,
      (s) => s.tileDef.kind === "operator" && (s.tileDef as BrainTileOperatorDef).op.parse.fixity === "infix"
    ) !== undefined;
  assert.ok(!hasInfixOp, "Should NOT include infix operators at expression start");

  const hasCompare =
    listFind(result.exact, (s) => s.tileDef.kind === "operator" && s.tileDef.tileId.includes("eq")) !== undefined;
  assert.ok(!hasCompare, "Should NOT include comparison operators on DO side");
});

// ---- Test 4: Action call context (switch-page actuator) ----

test("Test 4: Action call context for switch-page actuator", () => {
  const switchPageTileId = mkActuatorTileId(CoreHostActions.SwitchPage.key);
  const switchPageTile = services.edit.tiles.get(switchPageTileId) as BrainTileActuatorDef;
  assert.ok(switchPageTile !== undefined, "switch-page actuator exists in catalog");

  if (switchPageTile) {
    const expr: ActuatorExpr = {
      nodeId: 0,
      kind: "actuator",
      tileDef: switchPageTile,
      anons: List.empty<SlotExpr>(),
      parameters: List.empty<SlotExpr>(),
      modifiers: List.empty<SlotExpr>(),
      span: { from: 0, to: 0 },
    };

    const ctx: InsertionContext = { ruleSide: RuleSide.Do, expr };
    const result = suggestTiles(ctx, catalogList(), services);

    const hasNumberMatch =
      listFind(result.exact, (s) => getTileOutputType(s.tileDef) === CoreTypeIds.Number) !== undefined;
    const hasStringMatch =
      listFind(result.exact, (s) => getTileOutputType(s.tileDef) === CoreTypeIds.String) !== undefined;
    assert.ok(hasNumberMatch, "Should suggest Number-typed tiles for switch-page anonymous slot");
    assert.ok(hasStringMatch, "Should suggest String-typed tiles for switch-page anonymous slot");

    const boolInConversion =
      listFind(result.withConversion, (s) => getTileOutputType(s.tileDef) === CoreTypeIds.Boolean) !== undefined;
    assert.ok(boolInConversion, "Boolean tiles should be in withConversion for switch-page");
  }
});

// ---- Test 5: Expected Boolean type ----

test("Test 5: Expression position, WHEN side, expected Boolean", () => {
  const ctx: InsertionContext = {
    ruleSide: RuleSide.When,
    expectedType: CoreTypeIds.Boolean,
  };
  const result = suggestTiles(ctx, catalogList(), services);

  const hasTrueLit =
    listFind(
      result.exact,
      (s) => s.tileDef.kind === "literal" && getTileOutputType(s.tileDef) === CoreTypeIds.Boolean
    ) !== undefined;
  assert.ok(hasTrueLit, "Should include Boolean literals as exact match");

  const numInConv =
    listFind(result.withConversion, (s) => getTileOutputType(s.tileDef) === CoreTypeIds.Number) !== undefined;
  assert.ok(numInConv, "Number tiles should be in withConversion for Boolean");
});

// ---- Test 6: getTileOutputType utility ----

test("Test 6: getTileOutputType helper", () => {
  const allTiles = services.edit.tiles.getAll();
  let checkedCount = 0;
  for (let i = 0; i < allTiles.size(); i++) {
    const tileDef = allTiles.get(i);
    const outputType = getTileOutputType(tileDef);
    if (tileDef.kind === "literal" || tileDef.kind === "variable" || tileDef.kind === "sensor") {
      assert.ok(
        outputType !== undefined,
        `getTileOutputType should return a type for ${tileDef.kind} tile ${tileDef.tileId}`
      );
      checkedCount++;
    }
  }
  assert.ok(checkedCount > 0, "Should have checked at least some tiles");
});

// ---- Test 7: Complete value expr -> infix operators only ----

test("Test 7: Complete value expr (literal) -> infix operators only", () => {
  const litTileDef = new BrainTileLiteralDef(CoreTypeIds.Number, 42, {}, services);
  const expr: LiteralExpr = { nodeId: 0, kind: "literal", tileDef: litTileDef, span: { from: 0, to: 0 } };
  const ctx: InsertionContext = { ruleSide: RuleSide.Either, expr };
  const result = suggestTiles(ctx, catalogList(), services);

  const allOperators = listEvery(result.exact, (s) => s.tileDef.kind === "operator");
  assert.ok(allOperators, "Complete value expr should only suggest operator tiles");
  assert.ok(result.exact.size() > 0, "Should suggest at least some infix operators");

  const hasNot = listFind(result.exact, (s) => s.tileDef.tileId.includes("not")) !== undefined;
  const hasNegate = listFind(result.exact, (s) => s.tileDef.tileId.includes("neg")) !== undefined;
  assert.ok(!hasNot, "Should NOT include prefix-only 'not' operator");
  assert.ok(!hasNegate, "Should NOT include prefix-only 'negate' operator");

  const hasAdd = listFind(result.exact, (s) => s.tileDef.tileId.includes("add")) !== undefined;
  assert.ok(hasAdd, "Should include infix 'add' operator");

  assert.equal(result.withConversion.size(), 0, "No conversion results for infix operators");
});

// ---- Test 8: Complete actuator -> nothing ----

test("Test 8: Complete actuator (all slots filled) -> nothing", () => {
  const switchPageTileId = mkActuatorTileId(CoreHostActions.SwitchPage.key);
  const switchPageTile = services.edit.tiles.get(switchPageTileId) as BrainTileActuatorDef;

  if (switchPageTile) {
    const callDef = switchPageTile.action.callDef;
    const filledAnons = List.empty<SlotExpr>();
    const filledParams = List.empty<SlotExpr>();
    const filledMods = List.empty<SlotExpr>();
    for (let i = 0; i < callDef.argSlots.size(); i++) {
      const slot = callDef.argSlots.get(i);
      const fakeSlot: SlotExpr = { slotId: slot.slotId, expr: { nodeId: 100 + i, kind: "empty" } };
      if (slot.argSpec.anonymous) {
        filledAnons.push(fakeSlot);
      } else {
        filledParams.push(fakeSlot);
      }
    }

    const expr: ActuatorExpr = {
      nodeId: 0,
      kind: "actuator",
      tileDef: switchPageTile,
      anons: filledAnons,
      parameters: filledParams,
      modifiers: filledMods,
      span: { from: 0, to: 0 },
    };
    const ctx: InsertionContext = { ruleSide: RuleSide.Do, expr };
    const result = suggestTiles(ctx, catalogList(), services);

    assert.equal(result.exact.size(), 0, "Complete actuator should suggest nothing (exact)");
    assert.equal(result.withConversion.size(), 0, "Complete actuator should suggest nothing (conversion)");
  }
});

// ---- Test 9: Parameter needing value (errorExpr) -> value tiles ----

test("Test 9: Actuator with parameter needing value (errorExpr) -> value tiles", () => {
  const restartPageTileId = mkActuatorTileId(CoreHostActions.RestartPage.key);
  const restartPageTile = services.edit.tiles.get(restartPageTileId) as BrainTileActuatorDef;

  if (restartPageTile) {
    const priorityParamDef = new BrainTileParameterDef("test.priority", CoreTypeIds.Number, {
      metadata: { label: "priority" },
    });
    const paramExpr: ParameterExpr = {
      nodeId: 10,
      kind: "parameter",
      tileDef: priorityParamDef,
      value: { nodeId: 11, kind: "errorExpr", message: "Expected expression" },
      span: { from: 0, to: 0 },
    };
    const paramSlot: SlotExpr = { slotId: 999, expr: paramExpr };

    const expr: ActuatorExpr = {
      nodeId: 0,
      kind: "actuator",
      tileDef: restartPageTile,
      anons: List.empty<SlotExpr>(),
      parameters: List.from<SlotExpr>([paramSlot]),
      modifiers: List.empty<SlotExpr>(),
      span: { from: 0, to: 0 },
    };
    const ctx: InsertionContext = { ruleSide: RuleSide.Do, expr };
    const result = suggestTiles(ctx, catalogList(), services);

    const hasNumberMatch =
      listFind(result.exact, (s) => getTileOutputType(s.tileDef) === CoreTypeIds.Number) !== undefined;
    assert.ok(hasNumberMatch, "Should suggest Number-typed tiles for parameter needing value");

    const hasActuator = listFind(result.exact, (s) => s.tileDef.kind === "actuator") !== undefined;
    assert.ok(!hasActuator, "Should NOT suggest actuators for parameter value");

    const hasPrefixOp =
      listFind(
        result.exact,
        (s) => s.tileDef.kind === "operator" && (s.tileDef as BrainTileOperatorDef).op.parse.fixity === "prefix"
      ) !== undefined;
    assert.ok(hasPrefixOp, "Should suggest prefix operators for parameter value");

    const hasInfixOp =
      listFind(
        result.exact,
        (s) => s.tileDef.kind === "operator" && (s.tileDef as BrainTileOperatorDef).op.parse.fixity === "infix"
      ) !== undefined;
    assert.ok(!hasInfixOp, "Should NOT suggest infix operators for parameter value");

    const boolConversion = listFind(result.withConversion, (s) => getTileOutputType(s.tileDef) === CoreTypeIds.Boolean);
    assert.ok(boolConversion !== undefined, "Boolean tiles should be in withConversion for Number parameter");
  }
});

// ---- Test 10: Integration -- parse [actuator, parameter] -> suggest values ----

test("Test 10: Integration -- parse [actuator, priority] -> suggest value tiles", () => {
  const testParamId = "test.priority.10";
  const testParamDef = new BrainTileParameterDef(testParamId, CoreTypeIds.Number, { metadata: { label: "priority" } });
  services.edit.tiles.registerTileDef(testParamDef);

  const testCallDef = mkCallDef(bag(optional(param(testParamId))));
  const testFnEntry = services.runtime.functions.register(
    4001,
    "test-move-10",
    false,
    { exec: () => VOID_VALUE },
    testCallDef
  );
  const testActuatorDef = new BrainTileActuatorDef("test-move-10", mkActionDescriptor("actuator", testFnEntry), {
    metadata: { label: "move" },
  });
  services.edit.tiles.registerTileDef(testActuatorDef);

  const tileSequence = List.from([testActuatorDef as IBrainTileDef, testParamDef as IBrainTileDef]);
  const expr = parseTilesForSuggestions(tileSequence);

  assert.equal(expr.kind, "actuator", "Parsed expr should be an ActuatorExpr");
  if (expr.kind === "actuator") {
    assert.equal(expr.parameters.size(), 1, "Should have 1 filled parameter slot");
    const paramSlotExpr = expr.parameters.get(0).expr;
    assert.equal(paramSlotExpr.kind, "parameter", "Parameter slot should contain a ParameterExpr");
    if (paramSlotExpr.kind === "parameter") {
      assert.ok(
        paramSlotExpr.value.kind === "errorExpr" || paramSlotExpr.value.kind === "empty",
        "Parameter value should be errorExpr or empty"
      );
    }

    const ctx: InsertionContext = { ruleSide: RuleSide.Do, expr };
    const result = suggestTiles(ctx, catalogList(), services);

    const hasNumberMatch =
      listFind(result.exact, (s) => getTileOutputType(s.tileDef) === CoreTypeIds.Number) !== undefined;
    assert.ok(hasNumberMatch, "Integration: should suggest Number tiles after [move] [priority]");

    const hasActuator = listFind(result.exact, (s) => s.tileDef.kind === "actuator") !== undefined;
    assert.ok(!hasActuator, "Integration: should NOT suggest actuators for parameter value");

    const hasBoolConv =
      listFind(result.withConversion, (s) => getTileOutputType(s.tileDef) === CoreTypeIds.Boolean) !== undefined;
    assert.ok(hasBoolConv, "Integration: Boolean should be in withConversion for Number parameter");
  }
});

// ---- Test 11-17: Replace operand tests ----

describe("Replace operand/operator in binary expression", () => {
  test("Test 11: Replace left operand in [lit] [+] [lit] -> value tiles", () => {
    const litTileDef = services.edit.tiles
      .getAll()
      .toArray()
      .find((t) => t.kind === "literal") as BrainTileLiteralDef;
    const addOpDef = services.edit.tiles.get(mkOperatorTileId(CoreOpId.Add)) as BrainTileOperatorDef;

    const leftLit: LiteralExpr = { nodeId: 1, kind: "literal", tileDef: litTileDef, span: { from: 0, to: 1 } };
    const rightLit: LiteralExpr = { nodeId: 2, kind: "literal", tileDef: litTileDef, span: { from: 2, to: 3 } };
    const binaryExpr: BinaryOpExpr = {
      nodeId: 0,
      kind: "binaryOp",
      operator: addOpDef,
      left: leftLit,
      right: rightLit,
      span: { from: 0, to: 3 },
    };

    const ctx: InsertionContext = { ruleSide: RuleSide.Either, expr: binaryExpr, replaceTileIndex: 0 };
    const result = suggestTiles(ctx, catalogList(), services);

    // The operand position is constrained to the types add's overloads accept;
    // the Boolean literals reach Number/String via conversion.
    const hasLiteral =
      listFind(result.exact, (s) => s.tileDef.kind === "literal") !== undefined ||
      listFind(result.withConversion, (s) => s.tileDef.kind === "literal") !== undefined;
    assert.ok(hasLiteral, "Replace left operand should include literal tiles");

    const hasOperator = listFind(result.exact, (s) => s.tileDef.kind === "operator") !== undefined;
    assert.ok(hasOperator, "Replace value operand should include operators (prefix ops start expressions)");

    const hasParam = listFind(result.exact, (s) => s.tileDef.kind === "parameter") !== undefined;
    assert.ok(!hasParam, "Replace left operand should NOT include parameter tiles");
  });

  test("Test 12: Replace operator in [lit] [+] [lit] -> infix operators only", () => {
    const litTileDef = new BrainTileLiteralDef(CoreTypeIds.Number, 42, {}, services);
    const addOpDef = services.edit.tiles.get(mkOperatorTileId(CoreOpId.Add)) as BrainTileOperatorDef;

    const leftLit: LiteralExpr = { nodeId: 1, kind: "literal", tileDef: litTileDef, span: { from: 0, to: 1 } };
    const rightLit: LiteralExpr = { nodeId: 2, kind: "literal", tileDef: litTileDef, span: { from: 2, to: 3 } };
    const binaryExpr: BinaryOpExpr = {
      nodeId: 0,
      kind: "binaryOp",
      operator: addOpDef,
      left: leftLit,
      right: rightLit,
      span: { from: 0, to: 3 },
    };

    const ctx: InsertionContext = { ruleSide: RuleSide.Either, expr: binaryExpr, replaceTileIndex: 1 };
    const result = suggestTiles(ctx, catalogList(), services);

    const allOperators = listEvery(result.exact, (s) => s.tileDef.kind === "operator");
    assert.ok(allOperators, "Replace operator position should only suggest operators");
    assert.ok(result.exact.size() > 0, "Should suggest at least some infix operators");

    const hasSub =
      listFind(result.exact, (s) => s.tileDef.tileId === mkOperatorTileId(CoreOpId.Subtract)) !== undefined;
    assert.ok(hasSub, "Should include subtract operator");

    const hasNot = listFind(result.exact, (s) => s.tileDef.tileId === mkOperatorTileId(CoreOpId.Not)) !== undefined;
    const hasNegate =
      listFind(result.exact, (s) => s.tileDef.tileId === mkOperatorTileId(CoreOpId.Negate)) !== undefined;
    assert.ok(!hasNot, "Should NOT include prefix-only 'not' in infix position");
    assert.ok(!hasNegate, "Should NOT include prefix-only 'negate' in infix position");

    assert.equal(result.withConversion.size(), 0, "No conversion results for infix operator position");
  });

  test("Test 13: Replace prefix operator in [not] [lit] -> prefix operators only", () => {
    const litTileDef = services.edit.tiles
      .getAll()
      .toArray()
      .find((t) => t.kind === "literal") as BrainTileLiteralDef;
    const notOpDef = services.edit.tiles.get(mkOperatorTileId(CoreOpId.Not)) as BrainTileOperatorDef;

    const operandLit: LiteralExpr = { nodeId: 1, kind: "literal", tileDef: litTileDef, span: { from: 1, to: 2 } };
    const unaryExpr: UnaryOpExpr = {
      nodeId: 0,
      kind: "unaryOp",
      operator: notOpDef,
      operand: operandLit,
      span: { from: 0, to: 2 },
    };

    const ctx: InsertionContext = { ruleSide: RuleSide.Either, expr: unaryExpr, replaceTileIndex: 0 };
    const result = suggestTiles(ctx, catalogList(), services);

    // The operand is a Boolean literal, so only prefix operators with a
    // Boolean-operand overload are valid; the open paren can also stand here
    // (it groups the operand), and a non-inline sensor can host the operand
    // in an anonymous slot.
    const allValid = listEvery(
      result.exact,
      (s) =>
        s.tileDef.kind === "operator" ||
        s.tileDef.kind === "sensor" ||
        s.tileDef.tileId === mkControlFlowTileId(CoreControlFlowId.OpenParen)
    );
    assert.ok(allValid, "Replace prefix position should only suggest operators, sensors, and the open paren");
    assert.ok(result.exact.size() > 0, "Should suggest at least some prefix operators");

    const hasNot = listFind(result.exact, (s) => s.tileDef.tileId === mkOperatorTileId(CoreOpId.Not)) !== undefined;
    const hasNegate =
      listFind(result.exact, (s) => s.tileDef.tileId === mkOperatorTileId(CoreOpId.Negate)) !== undefined;
    assert.ok(hasNot, "Should include 'not' (Boolean-operand overload)");
    assert.ok(!hasNegate, "Should NOT include 'negate' (no Boolean-operand overload)");

    // A non-inline sensor is valid here only when an anonymous slot can host
    // the displaced operand: [timeout] takes the Boolean literal as its
    // anonymous Number value (via conversion), while [on-page-entered] has
    // no anonymous slot and would leave the operand dangling.
    assert.ok(
      listFind(result.exact, (s) => s.tileDef.tileId === mkSensorTileId(CoreHostActions.Timeout.key)) !== undefined,
      "Should include [timeout]: its anonymous slot hosts the displaced operand"
    );
    assert.ok(
      listFind(result.exact, (s) => s.tileDef.tileId === mkSensorTileId(CoreHostActions.OnPageEntered.key)) ===
        undefined,
      "Should NOT include [on-page-entered]: no anonymous slot to host the operand"
    );

    const hasOpenParen =
      listFind(result.exact, (s) => s.tileDef.tileId === mkControlFlowTileId(CoreControlFlowId.OpenParen)) !==
      undefined;
    assert.ok(hasOpenParen, "Should include the open paren at a prefix-operator replacement");

    const hasAdd = listFind(result.exact, (s) => s.tileDef.tileId === mkOperatorTileId(CoreOpId.Add)) !== undefined;
    assert.ok(!hasAdd, "Should NOT include infix 'add' in prefix position");
  });

  test("Test 14: Replace operand in [not] [lit] -> value tiles", () => {
    const litTileDef = services.edit.tiles
      .getAll()
      .toArray()
      .find((t) => t.kind === "literal") as BrainTileLiteralDef;
    const notOpDef = services.edit.tiles.get(mkOperatorTileId(CoreOpId.Not)) as BrainTileOperatorDef;

    const operandLit: LiteralExpr = { nodeId: 1, kind: "literal", tileDef: litTileDef, span: { from: 1, to: 2 } };
    const unaryExpr: UnaryOpExpr = {
      nodeId: 0,
      kind: "unaryOp",
      operator: notOpDef,
      operand: operandLit,
      span: { from: 0, to: 2 },
    };

    const ctx: InsertionContext = { ruleSide: RuleSide.Either, expr: unaryExpr, replaceTileIndex: 1 };
    const result = suggestTiles(ctx, catalogList(), services);

    const hasLiteral = listFind(result.exact, (s) => s.tileDef.kind === "literal") !== undefined;
    assert.ok(hasLiteral, "Replace operand should include literal tiles");

    const hasOperator = listFind(result.exact, (s) => s.tileDef.kind === "operator") !== undefined;
    assert.ok(hasOperator, "Replace value operand should include operators (prefix ops start expressions)");
  });

  test("Test 15: Replace parameter value in [test-move] [priority] [42] -> Number", () => {
    const testParamId = "test.priority.15";
    const testParamDef = new BrainTileParameterDef(testParamId, CoreTypeIds.Number, {
      metadata: { label: "priority" },
    });
    services.edit.tiles.registerTileDef(testParamDef);
    const testCallDef = mkCallDef(bag(optional(param(testParamId))));
    const testFnEntry = services.runtime.functions.register(
      4002,
      "test-move-15",
      false,
      { exec: () => VOID_VALUE },
      testCallDef
    );
    const testActuatorDef = new BrainTileActuatorDef("test-move-15", mkActionDescriptor("actuator", testFnEntry), {
      metadata: { label: "move" },
    });
    services.edit.tiles.registerTileDef(testActuatorDef);

    const litTileDef = services.edit.tiles
      .getAll()
      .toArray()
      .find((t) => t.kind === "literal") as BrainTileLiteralDef;
    const valueLit: LiteralExpr = { nodeId: 3, kind: "literal", tileDef: litTileDef, span: { from: 2, to: 3 } };
    const paramExpr: ParameterExpr = {
      nodeId: 2,
      kind: "parameter",
      tileDef: testParamDef,
      value: valueLit,
      span: { from: 1, to: 3 },
    };
    const paramSlot: SlotExpr = { slotId: 0, expr: paramExpr };
    const actuatorExpr: ActuatorExpr = {
      nodeId: 1,
      kind: "actuator",
      tileDef: testActuatorDef,
      anons: List.empty<SlotExpr>(),
      parameters: List.from<SlotExpr>([paramSlot]),
      modifiers: List.empty<SlotExpr>(),
      span: { from: 0, to: 3 },
    };

    const ctx: InsertionContext = { ruleSide: RuleSide.Do, expr: actuatorExpr, replaceTileIndex: 2 };
    const result = suggestTiles(ctx, catalogList(), services);

    const hasNumberMatch =
      listFind(result.exact, (s) => getTileOutputType(s.tileDef) === CoreTypeIds.Number) !== undefined;
    assert.ok(hasNumberMatch, "Replace param value should suggest Number tiles");

    const hasActuator = listFind(result.exact, (s) => s.tileDef.kind === "actuator") !== undefined;
    assert.ok(!hasActuator, "Replace param value should NOT include actuators");

    const boolConv =
      listFind(result.withConversion, (s) => getTileOutputType(s.tileDef) === CoreTypeIds.Boolean) !== undefined;
    assert.ok(boolConv, "Boolean should be in withConversion for Number parameter value");
  });

  test("Test 16: Replace action tile itself -> expression tiles", () => {
    const testActuatorDef = services.edit.tiles.get(mkActuatorTileId("test-move-15")) as BrainTileActuatorDef;
    const testParamDef = services.edit.tiles.get(mkParameterTileId("test.priority.15")) as BrainTileParameterDef;

    if (testActuatorDef && testParamDef) {
      const paramExpr: ParameterExpr = {
        nodeId: 2,
        kind: "parameter",
        tileDef: testParamDef,
        value: { nodeId: 3, kind: "empty" },
        span: { from: 1, to: 2 },
      };
      const paramSlot: SlotExpr = { slotId: 0, expr: paramExpr };
      const actuatorExpr: ActuatorExpr = {
        nodeId: 1,
        kind: "actuator",
        tileDef: testActuatorDef,
        anons: List.empty<SlotExpr>(),
        parameters: List.from<SlotExpr>([paramSlot]),
        modifiers: List.empty<SlotExpr>(),
        span: { from: 0, to: 2 },
      };

      const ctx: InsertionContext = { ruleSide: RuleSide.Do, expr: actuatorExpr, replaceTileIndex: 0 };
      const result = suggestTiles(ctx, catalogList(), services);

      const hasActuator = listFind(result.exact, (s) => s.tileDef.kind === "actuator") !== undefined;
      assert.ok(hasActuator, "Replace action tile should include other actuators");

      const hasParam = listFind(result.exact, (s) => s.tileDef.kind === "parameter") !== undefined;
      const hasMod = listFind(result.exact, (s) => s.tileDef.kind === "modifier") !== undefined;
      assert.ok(!hasParam, "Replace action tile should NOT include parameter tiles");
      assert.ok(!hasMod, "Replace action tile should NOT include modifier tiles");
    }
  });

  test("Test 17: Replace parameter tile in action call -> other arg tiles", () => {
    const testActuatorDef = services.edit.tiles.get(mkActuatorTileId("test-move-15")) as BrainTileActuatorDef;
    const testParamDef = services.edit.tiles.get(mkParameterTileId("test.priority.15")) as BrainTileParameterDef;

    if (testActuatorDef && testParamDef) {
      const paramExpr: ParameterExpr = {
        nodeId: 2,
        kind: "parameter",
        tileDef: testParamDef,
        value: { nodeId: 3, kind: "errorExpr", message: "Expected expression" },
        span: { from: 1, to: 2 },
      };
      const paramSlot: SlotExpr = { slotId: 0, expr: paramExpr };
      const actuatorExpr: ActuatorExpr = {
        nodeId: 1,
        kind: "actuator",
        tileDef: testActuatorDef,
        anons: List.empty<SlotExpr>(),
        parameters: List.from<SlotExpr>([paramSlot]),
        modifiers: List.empty<SlotExpr>(),
        span: { from: 0, to: 2 },
      };

      const ctx: InsertionContext = { ruleSide: RuleSide.Do, expr: actuatorExpr, replaceTileIndex: 1 };
      const result = suggestTiles(ctx, catalogList(), services);

      const hasOperator = listFind(result.exact, (s) => s.tileDef.kind === "operator") !== undefined;
      assert.ok(!hasOperator, "Replace param tile in action call should NOT include operators");
    }
  });
});

// ---- Test 18-23: Parameter value expression tests ----

describe("Parameter value expression chains", () => {
  let testActuatorDef: BrainTileActuatorDef;
  let testParamDef: BrainTileParameterDef;
  let numLitDef: BrainTileLiteralDef;

  before(() => {
    const id = "test.priority.18";
    testParamDef = new BrainTileParameterDef(id, CoreTypeIds.Number, { metadata: { label: "priority" } });
    services.edit.tiles.registerTileDef(testParamDef);
    const callDef = mkCallDef(bag(optional(param(id))));
    const fnEntry = services.runtime.functions.register(
      4008,
      "test-move-18",
      false,
      { exec: () => VOID_VALUE },
      callDef
    );
    testActuatorDef = new BrainTileActuatorDef("test-move-18", mkActionDescriptor("actuator", fnEntry), {
      metadata: { label: "move" },
    });
    services.edit.tiles.registerTileDef(testActuatorDef);

    numLitDef = new BrainTileLiteralDef(CoreTypeIds.Number, "1", { metadata: { label: "1" } }, services);
    services.edit.tiles.registerTileDef(numLitDef);
  });

  test("Test 18: [move] [priority] [1] -> infix operators", () => {
    const tiles = List.from<IBrainTileDef>([testActuatorDef, testParamDef, numLitDef]);
    const expr = parseTilesForSuggestions(tiles);

    assert.equal(expr.kind, "actuator");
    if (expr.kind === "actuator") {
      const ctx: InsertionContext = { ruleSide: RuleSide.Do, expr };
      const result = suggestTiles(ctx, catalogList(), services);

      const hasOperator = listFind(result.exact, (s) => s.tileDef.kind === "operator") !== undefined;
      assert.ok(hasOperator, "[move] [priority] [1] should offer infix operators");

      const hasLiteral = listFind(result.exact, (s) => s.tileDef.kind === "literal") !== undefined;
      assert.ok(!hasLiteral, "[move] [priority] [1] should NOT offer literal tiles");
    }
  });

  test("Test 19: [move] [priority] [1] [+] -> value tiles", () => {
    const addOpDef = services.edit.tiles.get(mkOperatorTileId(CoreOpId.Add)) as BrainTileOperatorDef;
    const tiles = List.from<IBrainTileDef>([testActuatorDef, testParamDef, numLitDef, addOpDef]);
    const expr = parseTilesForSuggestions(tiles);

    assert.equal(expr.kind, "actuator");
    if (expr.kind === "actuator") {
      const ctx: InsertionContext = { ruleSide: RuleSide.Do, expr };
      const result = suggestTiles(ctx, catalogList(), services);

      const hasNumberValue =
        listFind(result.exact, (s) => getTileOutputType(s.tileDef) === CoreTypeIds.Number) !== undefined;
      assert.ok(hasNumberValue, "[move] [priority] [1] [+] should offer Number value tiles");

      const hasPrefixOp =
        listFind(
          result.exact,
          (s) => s.tileDef.kind === "operator" && (s.tileDef as BrainTileOperatorDef).op.parse.fixity === "prefix"
        ) !== undefined;
      assert.ok(hasPrefixOp, "[move] [priority] [1] [+] should offer prefix operators");

      const hasInfixOp =
        listFind(
          result.exact,
          (s) => s.tileDef.kind === "operator" && (s.tileDef as BrainTileOperatorDef).op.parse.fixity === "infix"
        ) !== undefined;
      assert.ok(!hasInfixOp, "[move] [priority] [1] [+] should NOT offer infix operators");
    }
  });

  test("Test 20: [move] [priority] [1] [+] [1] -> infix operators", () => {
    const addOpDef = services.edit.tiles.get(mkOperatorTileId(CoreOpId.Add)) as BrainTileOperatorDef;
    const tiles = List.from<IBrainTileDef>([testActuatorDef, testParamDef, numLitDef, addOpDef, numLitDef]);
    const expr = parseTilesForSuggestions(tiles);

    assert.equal(expr.kind, "actuator");
    if (expr.kind === "actuator") {
      const ctx: InsertionContext = { ruleSide: RuleSide.Do, expr };
      const result = suggestTiles(ctx, catalogList(), services);

      const hasOperator = listFind(result.exact, (s) => s.tileDef.kind === "operator") !== undefined;
      assert.ok(hasOperator, "[move] [priority] [1] [+] [1] should offer infix operators");

      const hasLiteral = listFind(result.exact, (s) => s.tileDef.kind === "literal") !== undefined;
      assert.ok(!hasLiteral, "[move] [priority] [1] [+] [1] should NOT offer literal tiles");
    }
  });

  test("Test 21: Top-level [1] [+] -> value tiles, not operators", () => {
    const addOpDef = services.edit.tiles.get(mkOperatorTileId(CoreOpId.Add)) as BrainTileOperatorDef;
    const localNumLit = services.edit.tiles
      .getAll()
      .toArray()
      .find(
        (t) => t.kind === "literal" && (t as BrainTileLiteralDef).valueType === CoreTypeIds.Number
      ) as BrainTileLiteralDef;

    const tiles = List.from<IBrainTileDef>([localNumLit, addOpDef]);
    const expr = parseTilesForSuggestions(tiles);

    assert.equal(expr.kind, "binaryOp");
    if (expr.kind === "binaryOp") {
      assert.equal(expr.right.kind, "errorExpr");
    }

    const ctx: InsertionContext = { ruleSide: RuleSide.Either, expr };
    const result = suggestTiles(ctx, catalogList(), services);

    const hasValueTile =
      listFind(
        result.exact,
        (s) => s.tileDef.kind === "literal" || s.tileDef.kind === "sensor" || s.tileDef.kind === "factory"
      ) !== undefined;
    assert.ok(hasValueTile, "Top-level [1] [+] should offer value tiles");

    const hasPrefixOp =
      listFind(
        result.exact,
        (s) => s.tileDef.kind === "operator" && (s.tileDef as BrainTileOperatorDef).op.parse.fixity === "prefix"
      ) !== undefined;
    assert.ok(hasPrefixOp, "Top-level [1] [+] should offer prefix operators");

    const hasInfixOp =
      listFind(
        result.exact,
        (s) => s.tileDef.kind === "operator" && (s.tileDef as BrainTileOperatorDef).op.parse.fixity === "infix"
      ) !== undefined;
    assert.ok(!hasInfixOp, "Top-level [1] [+] should NOT offer infix operators");
  });

  test("Test 22: [move] [priority] -> includes prefix operators", () => {
    const tiles = List.from<IBrainTileDef>([testActuatorDef, testParamDef]);
    const expr = parseTilesForSuggestions(tiles);

    assert.equal(expr.kind, "actuator");
    if (expr.kind === "actuator") {
      const ctx: InsertionContext = { ruleSide: RuleSide.Do, expr };
      const result = suggestTiles(ctx, catalogList(), services);

      const hasNumberValue =
        listFind(result.exact, (s) => getTileOutputType(s.tileDef) === CoreTypeIds.Number) !== undefined;
      assert.ok(hasNumberValue, "[move] [priority] should offer Number value tiles");

      const hasPrefixOp =
        listFind(
          result.exact,
          (s) => s.tileDef.kind === "operator" && (s.tileDef as BrainTileOperatorDef).op.parse.fixity === "prefix"
        ) !== undefined;
      assert.ok(hasPrefixOp, "[move] [priority] should offer prefix operators");

      const hasInfixOp =
        listFind(
          result.exact,
          (s) => s.tileDef.kind === "operator" && (s.tileDef as BrainTileOperatorDef).op.parse.fixity === "infix"
        ) !== undefined;
      assert.ok(!hasInfixOp, "[move] [priority] should NOT offer infix operators");
    }
  });

  test("Test 23: [move] [priority] [negative] [1] -> infix operators", () => {
    const negOpDef = services.edit.tiles.get(mkOperatorTileId(CoreOpId.Negate)) as BrainTileOperatorDef;
    const tiles = List.from<IBrainTileDef>([testActuatorDef, testParamDef, negOpDef, numLitDef]);
    const expr = parseTilesForSuggestions(tiles);

    assert.equal(expr.kind, "actuator");
    if (expr.kind === "actuator") {
      const paramExpr = expr.parameters.get(0).expr;
      assert.equal(paramExpr.kind, "parameter");
      if (paramExpr.kind === "parameter") {
        assert.equal(paramExpr.value.kind, "unaryOp");
      }

      const ctx: InsertionContext = { ruleSide: RuleSide.Do, expr };
      const result = suggestTiles(ctx, catalogList(), services);

      const hasInfixOp =
        listFind(
          result.exact,
          (s) => s.tileDef.kind === "operator" && (s.tileDef as BrainTileOperatorDef).op.parse.fixity === "infix"
        ) !== undefined;
      assert.ok(hasInfixOp, "[move] [priority] [negative] [1] should offer infix operators");

      const hasLiteral = listFind(result.exact, (s) => s.tileDef.kind === "literal") !== undefined;
      assert.ok(!hasLiteral, "[move] [priority] [negative] [1] should NOT offer literal tiles");
    }
  });

  test("Test 77: [move] [priority] _ -> open paren suggested", () => {
    const tiles = List.from<IBrainTileDef>([testActuatorDef, testParamDef]);
    const expr = parseTilesForSuggestions(tiles);

    assert.equal(expr.kind, "actuator");
    if (expr.kind === "actuator") {
      const ctx: InsertionContext = { ruleSide: RuleSide.Do, expr };
      const result = suggestTiles(ctx, catalogList(), services);

      const openParenId = mkControlFlowTileId(CoreControlFlowId.OpenParen);
      const hasOpenParen = listFind(result.exact, (s) => s.tileDef.tileId === openParenId) !== undefined;
      assert.ok(hasOpenParen, "[move] [priority] should offer open paren");
    }
  });
});

// ---- Test 24-29: Call spec constraint tests ----

describe("Call spec constraints (choice, repeat, conditional)", () => {
  let richActuatorDef: BrainTileActuatorDef;
  let richCallDef: ReturnType<typeof mkCallDef>;
  let modADef: BrainTileModifierDef;
  let modBDef: BrainTileModifierDef;
  let modCDef: BrainTileModifierDef;
  let modFastDef: BrainTileModifierDef;
  let modSlowDef: BrainTileModifierDef;
  let slotFast: number;

  function getSlotIdForTile(tileId: string): number {
    for (let i = 0; i < richCallDef.argSlots.size(); i++) {
      if (richCallDef.argSlots.get(i).argSpec.tileId === tileId) return richCallDef.argSlots.get(i).slotId;
    }
    return -1;
  }

  function buildRichExpr(
    mods: { slotId: number; tileDef: BrainTileModifierDef }[],
    params: { slotId: number; tileDef: BrainTileParameterDef; value: Expr }[]
  ): ActuatorExpr {
    const modSlots = List.empty<SlotExpr>();
    for (const m of mods) {
      modSlots.push({
        slotId: m.slotId,
        expr: { nodeId: 100 + m.slotId, kind: "modifier", tileDef: m.tileDef, span: { from: 0, to: 0 } },
      });
    }
    const paramSlots = List.empty<SlotExpr>();
    for (const p of params) {
      paramSlots.push({
        slotId: p.slotId,
        expr: {
          nodeId: 200 + p.slotId,
          kind: "parameter",
          tileDef: p.tileDef,
          value: p.value,
          span: { from: 0, to: 0 },
        },
      });
    }
    return {
      nodeId: 0,
      kind: "actuator",
      tileDef: richActuatorDef,
      anons: List.empty<SlotExpr>(),
      parameters: paramSlots,
      modifiers: modSlots,
      span: { from: 0, to: 0 },
    };
  }

  before(() => {
    modADef = new BrainTileModifierDef("test.modA", { metadata: { label: "A" } });
    modBDef = new BrainTileModifierDef("test.modB", { metadata: { label: "B" } });
    modCDef = new BrainTileModifierDef("test.modC", { metadata: { label: "C" } });
    modFastDef = new BrainTileModifierDef("test.fast", { metadata: { label: "fast" } });
    modSlowDef = new BrainTileModifierDef("test.slow", { metadata: { label: "slow" } });
    services.edit.tiles.registerTileDef(modADef);
    services.edit.tiles.registerTileDef(modBDef);
    services.edit.tiles.registerTileDef(modCDef);
    services.edit.tiles.registerTileDef(modFastDef);
    services.edit.tiles.registerTileDef(modSlowDef);

    const priorityId = "test.priority.24";
    const priorityDef = new BrainTileParameterDef(priorityId, CoreTypeIds.Number, { metadata: { label: "priority" } });
    services.edit.tiles.registerTileDef(priorityDef);

    richCallDef = mkCallDef(
      bag(
        choice(mod("test.modA"), mod("test.modB"), mod("test.modC")),
        choice(repeated(mod("test.fast"), { max: 2 }), repeated(mod("test.slow"), { max: 2 })),
        optional(param(priorityId))
      )
    );
    const richFnEntry = services.runtime.functions.register(
      4003,
      "test-rich",
      false,
      { exec: () => VOID_VALUE },
      richCallDef
    );
    richActuatorDef = new BrainTileActuatorDef("test-rich", mkActionDescriptor("actuator", richFnEntry), {
      metadata: { label: "rich" },
    });
    services.edit.tiles.registerTileDef(richActuatorDef);

    slotFast = getSlotIdForTile(mkModifierTileId("test.fast"));
  });

  test("Test 24: Choice -- no selection -> all options available", () => {
    const expr = buildRichExpr([], []);
    const ctx: InsertionContext = { ruleSide: RuleSide.Do, expr };
    const result = suggestTiles(ctx, catalogList(), services);

    assert.ok(resultContains(result, modADef.tileId), "modA should be available");
    assert.ok(resultContains(result, modBDef.tileId), "modB should be available");
    assert.ok(resultContains(result, modCDef.tileId), "modC should be available");
    assert.ok(resultContains(result, modFastDef.tileId), "modFast should be available");
    assert.ok(resultContains(result, modSlowDef.tileId), "modSlow should be available");
  });

  test("Test 25: Choice -- modA selected -> modB/modC excluded", () => {
    const slotA = getSlotIdForTile(mkModifierTileId("test.modA"));
    const expr = buildRichExpr([{ slotId: slotA, tileDef: modADef }], []);
    const ctx: InsertionContext = { ruleSide: RuleSide.Do, expr };
    const result = suggestTiles(ctx, catalogList(), services);

    assert.ok(!resultContains(result, modADef.tileId), "modA should NOT be available (already placed)");
    assert.ok(!resultContains(result, modBDef.tileId), "modB should NOT be available (excluded by choice)");
    assert.ok(!resultContains(result, modCDef.tileId), "modC should NOT be available (excluded by choice)");
    assert.ok(resultContains(result, modFastDef.tileId), "modFast should still be available");
    assert.ok(resultContains(result, modSlowDef.tileId), "modSlow should still be available");
  });

  test("Test 26: Choice+Repeat -- modFast x1 -> modSlow excluded, modFast available", () => {
    const expr = buildRichExpr([{ slotId: slotFast, tileDef: modFastDef }], []);
    const ctx: InsertionContext = { ruleSide: RuleSide.Do, expr };
    const result = suggestTiles(ctx, catalogList(), services);

    assert.ok(resultContains(result, modFastDef.tileId), "modFast should still be available (max 2, placed 1)");
    assert.ok(!resultContains(result, modSlowDef.tileId), "modSlow should NOT be available (excluded by choice)");
  });

  test("Test 27: Repeat max -- modFast x2 -> modFast exhausted", () => {
    const modSlots = List.empty<SlotExpr>();
    modSlots.push({
      slotId: slotFast,
      expr: { nodeId: 101, kind: "modifier", tileDef: modFastDef, span: { from: 0, to: 1 } },
    });
    modSlots.push({
      slotId: slotFast,
      expr: { nodeId: 102, kind: "modifier", tileDef: modFastDef, span: { from: 1, to: 2 } },
    });

    const expr: ActuatorExpr = {
      nodeId: 0,
      kind: "actuator",
      tileDef: richActuatorDef,
      anons: List.empty<SlotExpr>(),
      parameters: List.empty<SlotExpr>(),
      modifiers: modSlots,
      span: { from: 0, to: 2 },
    };
    const ctx: InsertionContext = { ruleSide: RuleSide.Do, expr };
    const result = suggestTiles(ctx, catalogList(), services);

    assert.ok(!resultContains(result, modFastDef.tileId), "modFast should NOT be available (max 2, placed 2)");
    assert.ok(!resultContains(result, modSlowDef.tileId), "modSlow should NOT be available (excluded by choice)");
  });

  test("Test 28: Optional parameter -- not placed -> available; placed -> not available", () => {
    const priorityTileId = mkParameterTileId("test.priority.24");

    // Not placed
    const expr1 = buildRichExpr([], []);
    const result1 = suggestTiles({ ruleSide: RuleSide.Do, expr: expr1 }, catalogList(), services);
    assert.ok(resultContains(result1, priorityTileId), "optional priority param should be available when not placed");

    // Placed
    const slotPriority = getSlotIdForTile(priorityTileId);
    const priorityParamDef = services.edit.tiles.get(priorityTileId) as BrainTileParameterDef;
    const litDef = services.edit.tiles
      .getAll()
      .toArray()
      .find((t) => t.kind === "literal") as BrainTileLiteralDef;
    const expr2 = buildRichExpr(
      [],
      [
        {
          slotId: slotPriority,
          tileDef: priorityParamDef,
          value: { nodeId: 300, kind: "literal", tileDef: litDef, span: { from: 0, to: 0 } },
        },
      ]
    );
    const result2 = suggestTiles({ ruleSide: RuleSide.Do, expr: expr2 }, catalogList(), services);
    assert.ok(!resultContains(result2, priorityTileId), "optional priority param should NOT be available when placed");
  });

  test("Test 29: Conditional -- args available only when condition met", () => {
    const modXDef = new BrainTileModifierDef("test.modX", { metadata: { label: "X" } });
    const modYDef = new BrainTileModifierDef("test.modY", { metadata: { label: "Y" } });
    services.edit.tiles.registerTileDef(modXDef);
    services.edit.tiles.registerTileDef(modYDef);

    const testCondParamId = "test.condValue";
    const testCondParamDef = new BrainTileParameterDef(testCondParamId, CoreTypeIds.Number, {
      metadata: { label: "val" },
    });
    services.edit.tiles.registerTileDef(testCondParamDef);

    const condCallDef = mkCallDef(
      bag(
        param(testCondParamId, { name: "theValue", required: true, anonymous: true }),
        conditional("theValue", optional(choice(mod("test.modX"), mod("test.modY"))))
      )
    );
    const condFnEntry = services.runtime.functions.register(
      4004,
      "test-cond",
      false,
      { exec: () => VOID_VALUE },
      condCallDef
    );
    const condActuatorDef = new BrainTileActuatorDef("test-cond", mkActionDescriptor("actuator", condFnEntry), {
      metadata: { label: "cond" },
    });
    services.edit.tiles.registerTileDef(condActuatorDef);

    // No value -> condition not met
    {
      const expr: ActuatorExpr = {
        nodeId: 0,
        kind: "actuator",
        tileDef: condActuatorDef,
        anons: List.empty<SlotExpr>(),
        parameters: List.empty<SlotExpr>(),
        modifiers: List.empty<SlotExpr>(),
        span: { from: 0, to: 0 },
      };
      const result = suggestTiles({ ruleSide: RuleSide.Do, expr }, catalogList(), services);
      assert.ok(!resultContains(result, modXDef.tileId), "modX should NOT be available when condition not met");
      assert.ok(!resultContains(result, modYDef.tileId), "modY should NOT be available when condition not met");
    }

    // Value placed -> condition met
    {
      const anonSlotId = condCallDef.argSlots.get(0).slotId;
      const litDef = services.edit.tiles
        .getAll()
        .toArray()
        .find((t) => t.kind === "literal") as BrainTileLiteralDef;
      const anonSlots = List.empty<SlotExpr>();
      anonSlots.push({
        slotId: anonSlotId,
        expr: { nodeId: 50, kind: "literal", tileDef: litDef, span: { from: 0, to: 1 } },
      });

      const expr: ActuatorExpr = {
        nodeId: 0,
        kind: "actuator",
        tileDef: condActuatorDef,
        anons: anonSlots,
        parameters: List.empty<SlotExpr>(),
        modifiers: List.empty<SlotExpr>(),
        span: { from: 0, to: 1 },
      };
      const result = suggestTiles({ ruleSide: RuleSide.Do, expr }, catalogList(), services);
      assert.ok(resultContains(result, modXDef.tileId), "modX should be available when condition met");
      assert.ok(resultContains(result, modYDef.tileId), "modY should be available when condition met");
    }

    // Value placed + modX -> modY excluded by choice
    {
      const anonSlotId = condCallDef.argSlots.get(0).slotId;
      const modXSlotId = condCallDef.argSlots
        .toArray()
        .find((s) => s.argSpec.tileId === mkModifierTileId("test.modX"))!.slotId;
      const litDef = services.edit.tiles
        .getAll()
        .toArray()
        .find((t) => t.kind === "literal") as BrainTileLiteralDef;

      const anonSlots = List.empty<SlotExpr>();
      anonSlots.push({
        slotId: anonSlotId,
        expr: { nodeId: 50, kind: "literal", tileDef: litDef, span: { from: 0, to: 1 } },
      });
      const modSlots = List.empty<SlotExpr>();
      modSlots.push({
        slotId: modXSlotId,
        expr: { nodeId: 60, kind: "modifier", tileDef: modXDef, span: { from: 1, to: 2 } },
      });

      const expr: ActuatorExpr = {
        nodeId: 0,
        kind: "actuator",
        tileDef: condActuatorDef,
        anons: anonSlots,
        parameters: List.empty<SlotExpr>(),
        modifiers: modSlots,
        span: { from: 0, to: 2 },
      };
      const result = suggestTiles({ ruleSide: RuleSide.Do, expr }, catalogList(), services);
      assert.ok(!resultContains(result, modXDef.tileId), "modX should NOT be available (already placed)");
      assert.ok(!resultContains(result, modYDef.tileId), "modY should NOT be available (excluded by choice)");
    }
  });
});

// ---- Test 30: Non-inline sensor tests ----

describe("Non-inline sensor operator suggestions", () => {
  test("Test 30: Non-inline sensor with satisfied choice -> no infix operators", () => {
    const modPDef = new BrainTileModifierDef("test.modP", { metadata: { label: "P" } });
    const modQDef = new BrainTileModifierDef("test.modQ", { metadata: { label: "Q" } });
    services.edit.tiles.registerTileDef(modPDef);
    services.edit.tiles.registerTileDef(modQDef);

    const sensorCallDef = mkCallDef(choice(mod("test.modP"), mod("test.modQ")));
    const sensorFnEntry = services.runtime.functions.register(
      4005,
      "test-sense",
      false,
      { exec: () => VOID_VALUE },
      sensorCallDef
    );
    const testSensorDef = new BrainTileSensorDef(
      "test-sense",
      mkActionDescriptor("sensor", sensorFnEntry, CoreTypeIds.Number),
      {
        metadata: { label: "sense" },
      }
    );
    services.edit.tiles.registerTileDef(testSensorDef);

    const modPSlotId = sensorCallDef.argSlots
      .toArray()
      .find((s) => s.argSpec.tileId === mkModifierTileId("test.modP"))!.slotId;
    const modSlots = List.empty<SlotExpr>();
    modSlots.push({
      slotId: modPSlotId,
      expr: { nodeId: 70, kind: "modifier", tileDef: modPDef, span: { from: 0, to: 1 } },
    });

    const expr = {
      nodeId: 0,
      kind: "sensor" as const,
      tileDef: testSensorDef,
      anons: List.empty<SlotExpr>(),
      parameters: List.empty<SlotExpr>(),
      modifiers: modSlots,
      span: { from: 0, to: 1 },
    };
    const result = suggestTiles({ ruleSide: RuleSide.When, expr }, catalogList(), services);

    const hasInfixOp = listFind(result.exact, (s) => s.tileDef.kind === "operator") !== undefined;
    assert.ok(!hasInfixOp, "Non-inline sensor with satisfied choice should NOT offer infix operators");
    assert.ok(!resultContains(result, modQDef.tileId), "modQ should NOT be available (excluded by choice)");
    assert.equal(result.exact.size(), 0, "Completed non-inline sensor should suggest nothing");
  });

  test("Test 30b: Inline sensor (no args) -> infix operators offered", () => {
    const randomSensorDef = services.edit.tiles
      .getAll()
      .toArray()
      .find((t) => t.kind === "sensor") as BrainTileSensorDef;
    if (randomSensorDef) {
      const sensorExpr: SensorExpr = {
        nodeId: 0,
        kind: "sensor",
        tileDef: randomSensorDef,
        anons: List.empty<SlotExpr>(),
        parameters: List.empty<SlotExpr>(),
        modifiers: List.empty<SlotExpr>(),
        span: { from: 0, to: 0 },
      };
      const result = suggestTiles({ ruleSide: RuleSide.When, expr: sensorExpr }, catalogList(), services);
      const hasInfixOp = listFind(result.exact, (s) => s.tileDef.kind === "operator") !== undefined;
      assert.ok(hasInfixOp, "Inline sensor (no args) should offer infix operators");
    }
  });

  test("Test 30c: Non-inline sensor at max capacity -> no operators", () => {
    const modRDef = new BrainTileModifierDef("test.modR", { metadata: { label: "R" } });
    const modSDef = new BrainTileModifierDef("test.modS", { metadata: { label: "S" } });
    const modNrDef = new BrainTileModifierDef("test.modNr", { metadata: { label: "Near" } });
    const modFrDef = new BrainTileModifierDef("test.modFr", { metadata: { label: "Far" } });
    services.edit.tiles.registerTileDef(modRDef);
    services.edit.tiles.registerTileDef(modSDef);
    services.edit.tiles.registerTileDef(modNrDef);
    services.edit.tiles.registerTileDef(modFrDef);

    const senseCallDef = mkCallDef(
      bag(
        choice(mod("test.modR"), mod("test.modS")),
        choice(repeated(mod("test.modNr"), { max: 3 }), repeated(mod("test.modFr"), { max: 3 }))
      )
    );
    const senseFnEntry = services.runtime.functions.register(
      4006,
      "test-sense2",
      false,
      { exec: () => VOID_VALUE },
      senseCallDef
    );
    const senseDef = new BrainTileSensorDef(
      "test-sense2",
      mkActionDescriptor("sensor", senseFnEntry, CoreTypeIds.Boolean),
      {
        metadata: { label: "sense2" },
      }
    );
    services.edit.tiles.registerTileDef(senseDef);

    const modRSlotId = senseCallDef.argSlots
      .toArray()
      .find((s) => s.argSpec.tileId === mkModifierTileId("test.modR"))!.slotId;
    const modNrSlotId = senseCallDef.argSlots
      .toArray()
      .find((s) => s.argSpec.tileId === mkModifierTileId("test.modNr"))!.slotId;

    const mods = List.empty<SlotExpr>();
    mods.push({
      slotId: modRSlotId,
      expr: { nodeId: 80, kind: "modifier", tileDef: modRDef, span: { from: 1, to: 2 } },
    });
    mods.push({
      slotId: modNrSlotId,
      expr: { nodeId: 81, kind: "modifier", tileDef: modNrDef, span: { from: 2, to: 3 } },
    });
    mods.push({
      slotId: modNrSlotId,
      expr: { nodeId: 82, kind: "modifier", tileDef: modNrDef, span: { from: 3, to: 4 } },
    });
    mods.push({
      slotId: modNrSlotId,
      expr: { nodeId: 83, kind: "modifier", tileDef: modNrDef, span: { from: 4, to: 5 } },
    });

    const senseExpr = {
      nodeId: 0,
      kind: "sensor" as const,
      tileDef: senseDef,
      anons: List.empty<SlotExpr>(),
      parameters: List.empty<SlotExpr>(),
      modifiers: mods,
      span: { from: 0, to: 5 },
    };
    const result = suggestTiles({ ruleSide: RuleSide.When, expr: senseExpr }, catalogList(), services);

    assert.ok(
      !listFind(result.exact, (s) => s.tileDef.kind === "operator"),
      "Fully filled non-inline sensor should NOT suggest any operators"
    );
    assert.equal(result.exact.size(), 0, "Fully filled non-inline sensor should suggest nothing");
    assert.equal(
      result.withConversion.size(),
      0,
      "Fully filled non-inline sensor should have no conversion suggestions"
    );
  });

  test("Test 30d: Complete non-inline sensor (no args) -> no infix operators", () => {
    const plainFnEntry = services.runtime.functions.register(
      4014,
      "test-sense-plain",
      false,
      { exec: () => VOID_VALUE },
      mkCallDef(bag())
    );
    const plainSensorDef = new BrainTileSensorDef(
      "test-sense-plain",
      mkActionDescriptor("sensor", plainFnEntry, CoreTypeIds.Number),
      { metadata: { label: "sense plain" } }
    );
    services.edit.tiles.registerTileDef(plainSensorDef);

    const expr = parseTilesForSuggestions(List.from<IBrainTileDef>([plainSensorDef]));
    assert.equal(expr.kind, "sensor");
    const result = suggestTiles({ ruleSide: RuleSide.When, expr }, catalogList(), services);

    const hasInfixOp = listFind(result.exact, (s) => s.tileDef.kind === "operator") !== undefined;
    assert.ok(!hasInfixOp, "Complete non-inline sensor should NOT offer infix operators");
    assert.equal(result.exact.size(), 0, "Complete non-inline sensor should suggest nothing");
  });

  test("Test 30e: Complete inline sensor (no args) -> infix operators offered", () => {
    const inlineFnEntry = services.runtime.functions.register(
      4015,
      "test-sense-inline",
      false,
      { exec: () => VOID_VALUE },
      mkCallDef(bag())
    );
    const inlineSensorDef = new BrainTileSensorDef(
      "test-sense-inline",
      mkActionDescriptor("sensor", inlineFnEntry, CoreTypeIds.Number),
      { metadata: { label: "sense inline" }, placement: TilePlacement.EitherSide | TilePlacement.Inline }
    );
    services.edit.tiles.registerTileDef(inlineSensorDef);

    const expr = parseTilesForSuggestions(List.from<IBrainTileDef>([inlineSensorDef]));
    assert.equal(expr.kind, "sensor");
    const result = suggestTiles({ ruleSide: RuleSide.When, expr }, catalogList(), services);

    assert.ok(
      resultContains(result, mkOperatorTileId(CoreOpId.Add)),
      "Complete inline sensor should offer the add infix operator"
    );
  });
});

// ---- Test 31-34: Operator overload filtering ----

describe("Operator overload filtering", () => {
  test("Test 31: Number LHS -> operators filtered by overload", () => {
    const numLitDef = services.edit.tiles
      .getAll()
      .toArray()
      .find(
        (t) => t.kind === "literal" && (t as BrainTileLiteralDef).valueType === CoreTypeIds.Number
      ) as BrainTileLiteralDef;

    const expr: LiteralExpr = { nodeId: 0, kind: "literal", tileDef: numLitDef, span: { from: 0, to: 0 } };
    const result = suggestTiles({ ruleSide: RuleSide.Either, expr }, catalogList(), services);

    assert.ok(
      listFind(result.exact, (s) => s.tileDef.tileId === mkOperatorTileId(CoreOpId.Add)) !== undefined,
      "add should be in exact"
    );
    assert.ok(
      listFind(result.exact, (s) => s.tileDef.tileId === mkOperatorTileId(CoreOpId.Subtract)) !== undefined,
      "sub should be in exact"
    );
    assert.ok(
      listFind(result.exact, (s) => s.tileDef.tileId === mkOperatorTileId(CoreOpId.EqualTo)) !== undefined,
      "eq should be in exact"
    );

    assert.ok(
      listFind(result.exact, (s) => s.tileDef.tileId === mkOperatorTileId(CoreOpId.Assign)) === undefined,
      "assign should NOT be in exact (literal is not l-value)"
    );
    assert.ok(
      listFind(result.exact, (s) => s.tileDef.tileId === mkOperatorTileId(CoreOpId.And)) === undefined,
      "and should NOT be suggested for Number LHS"
    );
    assert.ok(
      listFind(result.exact, (s) => s.tileDef.tileId === mkOperatorTileId(CoreOpId.Or)) === undefined,
      "or should NOT be suggested for Number LHS"
    );
    assert.ok(
      listFind(result.withConversion, (s) => s.tileDef.tileId === mkOperatorTileId(CoreOpId.And)) === undefined,
      "and should NOT be in withConversion"
    );
    assert.ok(
      listFind(result.withConversion, (s) => s.tileDef.tileId === mkOperatorTileId(CoreOpId.Or)) === undefined,
      "or should NOT be in withConversion"
    );
  });

  test("Test 32: Boolean LHS -> operators filtered by overload", () => {
    const boolLitDef = services.edit.tiles
      .getAll()
      .toArray()
      .find(
        (t) => t.kind === "literal" && (t as BrainTileLiteralDef).valueType === CoreTypeIds.Boolean
      ) as BrainTileLiteralDef;

    const expr: LiteralExpr = { nodeId: 0, kind: "literal", tileDef: boolLitDef, span: { from: 0, to: 0 } };
    const result = suggestTiles({ ruleSide: RuleSide.Either, expr }, catalogList(), services);

    assert.ok(
      listFind(result.exact, (s) => s.tileDef.tileId === mkOperatorTileId(CoreOpId.And)) !== undefined,
      "and should be in exact"
    );
    assert.ok(
      listFind(result.exact, (s) => s.tileDef.tileId === mkOperatorTileId(CoreOpId.Or)) !== undefined,
      "or should be in exact"
    );
    assert.ok(
      listFind(result.exact, (s) => s.tileDef.tileId === mkOperatorTileId(CoreOpId.EqualTo)) !== undefined,
      "eq should be in exact"
    );

    assert.ok(
      listFind(result.exact, (s) => s.tileDef.tileId === mkOperatorTileId(CoreOpId.Assign)) === undefined,
      "assign should NOT be in exact"
    );
    assert.ok(
      listFind(result.exact, (s) => s.tileDef.tileId === mkOperatorTileId(CoreOpId.Add)) === undefined,
      "add should NOT be suggested for Boolean LHS"
    );
    assert.ok(
      listFind(result.withConversion, (s) => s.tileDef.tileId === mkOperatorTileId(CoreOpId.Add)) === undefined,
      "add should NOT be in withConversion"
    );
  });

  test("Test 34: Replace operator with LHS type awareness", () => {
    const numLitDef = services.edit.tiles
      .getAll()
      .toArray()
      .find(
        (t) => t.kind === "literal" && (t as BrainTileLiteralDef).valueType === CoreTypeIds.Number
      ) as BrainTileLiteralDef;
    const addOpDef = services.edit.tiles.get(mkOperatorTileId(CoreOpId.Add)) as BrainTileOperatorDef;

    const leftLit: LiteralExpr = { nodeId: 1, kind: "literal", tileDef: numLitDef, span: { from: 0, to: 0 } };
    const rightLit: LiteralExpr = { nodeId: 2, kind: "literal", tileDef: numLitDef, span: { from: 2, to: 2 } };
    const binaryExpr: BinaryOpExpr = {
      nodeId: 3,
      kind: "binaryOp",
      operator: addOpDef,
      left: leftLit,
      right: rightLit,
      span: { from: 0, to: 2 },
    };

    const result = suggestTiles(
      { ruleSide: RuleSide.Either, expr: binaryExpr, replaceTileIndex: 1 },
      catalogList(),
      services
    );

    assert.ok(
      listFind(result.exact, (s) => s.tileDef.tileId === mkOperatorTileId(CoreOpId.Multiply)) !== undefined,
      "mul should be in exact"
    );
    assert.ok(
      listFind(result.exact, (s) => s.tileDef.tileId === mkOperatorTileId(CoreOpId.And)) === undefined,
      "and should NOT be suggested"
    );
    assert.ok(
      listFind(result.withConversion, (s) => s.tileDef.tileId === mkOperatorTileId(CoreOpId.And)) === undefined,
      "and should NOT be in withConversion"
    );
  });
});

// ---- Test 35-37: Incomplete expressions and type-constrained suggestions ----

describe("Incomplete expression type constraints", () => {
  test("Test 35: [say] ['hi'] [+] -> suggests string-producing value tiles", () => {
    const anonStringSpec = param(CoreParameterId.AnonymousString, { name: "anonStr", required: true, anonymous: true });
    const sayCallDef = mkCallDef(bag(anonStringSpec));
    const sayFnEntry = services.runtime.functions.register(
      4009,
      "test-say",
      false,
      { exec: () => VOID_VALUE },
      sayCallDef
    );
    const sayDef = new BrainTileActuatorDef("test-say", mkActionDescriptor("actuator", sayFnEntry), {
      metadata: { label: "say" },
    });
    services.edit.tiles.registerTileDef(sayDef);

    const strLitDef = new BrainTileLiteralDef(CoreTypeIds.String, "hi", { metadata: { label: "hi" } }, services);
    services.edit.tiles.registerTileDef(strLitDef);
    const addOpDef = services.edit.tiles.get(mkOperatorTileId(CoreOpId.Add)) as BrainTileOperatorDef;

    const tiles = List.from<IBrainTileDef>([sayDef, strLitDef, addOpDef]);
    const expr = parseTilesForSuggestions(tiles);

    assert.equal(expr.kind, "actuator");
    if (expr.kind === "actuator") {
      const result = suggestTiles({ ruleSide: RuleSide.Do, expr }, catalogList(), services);

      const hasStringLit = listFind(
        result.exact,
        (s) => s.tileDef.kind === "literal" && getTileOutputType(s.tileDef) === CoreTypeIds.String
      );
      assert.ok(hasStringLit !== undefined, "Should suggest String literal as exact match");

      const numInConv = listFind(result.withConversion, (s) => getTileOutputType(s.tileDef) === CoreTypeIds.Number);
      assert.ok(numInConv !== undefined, "Number tiles should be in withConversion for String");

      const hasPrefixOp = listFind(
        result.exact,
        (s) => s.tileDef.kind === "operator" && (s.tileDef as BrainTileOperatorDef).op.parse.fixity === "prefix"
      );
      assert.ok(hasPrefixOp === undefined, "Should NOT include prefix operators (none produce String)");

      const hasInfixOp = listFind(
        result.exact,
        (s) => s.tileDef.kind === "operator" && (s.tileDef as BrainTileOperatorDef).op.parse.fixity === "infix"
      );
      assert.ok(hasInfixOp === undefined, "Should NOT suggest infix operators when value is needed");
    }
  });

  test("Test 36: Variable LHS -> assign suggested; literal LHS -> assign excluded", () => {
    const numVarDef = new BrainTileVariableDef("test.numVar", "score", CoreTypeIds.Number, "var-score-1");
    services.edit.tiles.registerTileDef(numVarDef);

    const assignTileId = mkOperatorTileId(CoreOpId.Assign);

    // Variable LHS
    const varExpr: VariableExpr = { nodeId: 0, kind: "variable", tileDef: numVarDef, span: { from: 0, to: 0 } };
    const varResult = suggestTiles({ ruleSide: RuleSide.Do, expr: varExpr }, catalogList(), services);
    assert.ok(
      listFind(varResult.exact, (s) => s.tileDef.tileId === assignTileId) !== undefined,
      "assign should be in exact for variable LHS"
    );

    // Literal LHS
    const numLitDef = services.edit.tiles
      .getAll()
      .toArray()
      .find(
        (t) => t.kind === "literal" && (t as BrainTileLiteralDef).valueType === CoreTypeIds.Number
      ) as BrainTileLiteralDef;
    const litExpr: LiteralExpr = { nodeId: 1, kind: "literal", tileDef: numLitDef, span: { from: 0, to: 0 } };
    const litResult = suggestTiles({ ruleSide: RuleSide.Do, expr: litExpr }, catalogList(), services);
    assert.ok(
      listFind(litResult.exact, (s) => s.tileDef.tileId === assignTileId) === undefined,
      "assign should NOT be in exact for literal LHS"
    );

    // Sensor LHS
    const randomSensorDef = services.edit.tiles
      .getAll()
      .toArray()
      .find((t) => t.kind === "sensor") as BrainTileSensorDef;
    if (randomSensorDef) {
      const sensorExpr: SensorExpr = {
        nodeId: 2,
        kind: "sensor",
        tileDef: randomSensorDef,
        anons: List.empty<SlotExpr>(),
        parameters: List.empty<SlotExpr>(),
        modifiers: List.empty<SlotExpr>(),
        span: { from: 0, to: 0 },
      };
      const sensorResult = suggestTiles({ ruleSide: RuleSide.When, expr: sensorExpr }, catalogList(), services);
      assert.ok(
        listFind(sensorResult.exact, (s) => s.tileDef.tileId === assignTileId) === undefined,
        "assign should NOT be in exact for sensor LHS"
      );
    }

    // BinaryOp LHS
    const addOpDef = services.edit.tiles.get(mkOperatorTileId(CoreOpId.Add)) as BrainTileOperatorDef;
    const binaryExpr: BinaryOpExpr = {
      nodeId: 3,
      kind: "binaryOp",
      operator: addOpDef,
      left: { nodeId: 4, kind: "literal", tileDef: numLitDef, span: { from: 0, to: 0 } },
      right: { nodeId: 5, kind: "literal", tileDef: numLitDef, span: { from: 2, to: 2 } },
      span: { from: 0, to: 2 },
    };
    const binResult = suggestTiles({ ruleSide: RuleSide.Do, expr: binaryExpr }, catalogList(), services);
    assert.ok(
      listFind(binResult.exact, (s) => s.tileDef.tileId === assignTileId) === undefined,
      "assign should NOT be in exact for binaryOp LHS"
    );
  });

  test("Test 37: Number expected -> negate suggested", () => {
    const anonNumSpec = param(CoreParameterId.AnonymousNumber, { name: "anonNum", required: true, anonymous: true });
    const numActCallDef = mkCallDef(bag(anonNumSpec));
    const numActFnEntry = services.runtime.functions.register(
      4007,
      "test-numact",
      false,
      { exec: () => VOID_VALUE },
      numActCallDef
    );
    const numActDef = new BrainTileActuatorDef("test-numact", mkActionDescriptor("actuator", numActFnEntry), {
      metadata: { label: "numact" },
    });
    services.edit.tiles.registerTileDef(numActDef);

    const numLitDef = services.edit.tiles.get(
      services.edit.tiles
        .getAll()
        .toArray()
        .find((t) => t.kind === "literal" && getTileOutputType(t) === CoreTypeIds.Number)!.tileId
    )!;
    const addOpDef = services.edit.tiles.get(mkOperatorTileId(CoreOpId.Add)) as BrainTileOperatorDef;
    const negateTileId = mkOperatorTileId(CoreOpId.Negate);

    const numTiles = List.from<IBrainTileDef>([numActDef, numLitDef, addOpDef]);
    const numExpr = parseTilesForSuggestions(numTiles);
    assert.equal(numExpr.kind, "actuator");
    if (numExpr.kind === "actuator") {
      const result = suggestTiles({ ruleSide: RuleSide.Do, expr: numExpr }, catalogList(), services);
      const negateInExact = listFind(result.exact, (s) => s.tileDef.tileId === negateTileId);
      assert.ok(negateInExact !== undefined, "negate should be suggested when Number is expected");
    }
  });
});

// ---- Test 38-46: Accessor / struct field tests ----

describe("Accessor / struct field suggestions", () => {
  let posStructTypeId: string;
  let accessorXDef: BrainTileAccessorDef;
  let accessorYDef: BrainTileAccessorDef;
  let accessorMagDef: BrainTileAccessorDef;
  let posVarDef: BrainTileVariableDef;

  before(() => {
    posStructTypeId = services.runtime.types.addStructType("Position", {
      atomId: mkTestAtomId(),
      fields: List.from([
        { name: "x", typeId: CoreTypeIds.Number, fieldIndex: 0 },
        { name: "y", typeId: CoreTypeIds.Number, fieldIndex: 1 },
        { name: "mag", typeId: CoreTypeIds.Number, fieldIndex: 2 },
      ]),
    });
    accessorXDef = new BrainTileAccessorDef(posStructTypeId, "x", CoreTypeIds.Number, { metadata: { label: "x" } });
    accessorYDef = new BrainTileAccessorDef(posStructTypeId, "y", CoreTypeIds.Number, { metadata: { label: "y" } });
    accessorMagDef = new BrainTileAccessorDef(posStructTypeId, "mag", CoreTypeIds.Number, {
      metadata: { label: "mag" },
      readOnly: true,
    });
    services.edit.tiles.registerTileDef(accessorXDef);
    services.edit.tiles.registerTileDef(accessorYDef);
    services.edit.tiles.registerTileDef(accessorMagDef);

    posVarDef = new BrainTileVariableDef("test.posVar", "my_position", posStructTypeId, "var-pos-1");
    services.edit.tiles.registerTileDef(posVarDef);
  });

  test("Test 38: Struct variable -> accessor tiles suggested", () => {
    const varExpr: VariableExpr = { nodeId: 0, kind: "variable", tileDef: posVarDef, span: { from: 0, to: 1 } };
    const result = suggestTiles({ ruleSide: RuleSide.Either, expr: varExpr }, catalogList(), services);

    assert.ok(resultContains(result, accessorXDef.tileId), "accessor 'x' should be suggested");
    assert.ok(resultContains(result, accessorYDef.tileId), "accessor 'y' should be suggested");

    const hasOperator = listFind(result.exact, (s) => s.tileDef.kind === "operator") !== undefined;
    assert.ok(hasOperator, "Infix operators should also be suggested");
  });

  test("Test 39: Number variable -> accessor tiles NOT suggested", () => {
    const numVarDef2 = services.edit.tiles
      .getAll()
      .toArray()
      .find(
        (t) => t.kind === "variable" && (t as BrainTileVariableDef).varType === CoreTypeIds.Number
      ) as BrainTileVariableDef;

    if (numVarDef2) {
      const varExpr: VariableExpr = { nodeId: 0, kind: "variable", tileDef: numVarDef2, span: { from: 0, to: 1 } };
      const result = suggestTiles({ ruleSide: RuleSide.Either, expr: varExpr }, catalogList(), services);
      const hasAccessor = listFind(result.exact, (s) => s.tileDef.kind === "accessor") !== undefined;
      assert.ok(!hasAccessor, "Accessor tiles should NOT be suggested after Number variable");
    }
  });

  test("Test 40: Empty expression -> accessor tiles NOT suggested", () => {
    const result = suggestTiles({ ruleSide: RuleSide.Either }, catalogList(), services);
    const hasAccessor = listFind(result.exact, (s) => s.tileDef.kind === "accessor") !== undefined;
    assert.ok(!hasAccessor, "Accessor tiles should NOT be suggested in empty expression position");
  });

  test("Test 41: [$pos] [x] -> assignment operator suggested (l-value)", () => {
    const fieldAccessExpr: FieldAccessExpr = {
      nodeId: 0,
      kind: "fieldAccess",
      object: { nodeId: 1, kind: "variable", tileDef: posVarDef, span: { from: 0, to: 1 } },
      accessor: accessorXDef,
      span: { from: 0, to: 2 },
    };
    const result = suggestTiles({ ruleSide: RuleSide.Do, expr: fieldAccessExpr }, catalogList(), services);

    const assignTileId = mkOperatorTileId(CoreOpId.Assign);
    assert.ok(
      listFind(result.exact, (s) => s.tileDef.tileId === assignTileId) !== undefined,
      "assign should be suggested after field access"
    );
    assert.ok(
      listFind(result.exact, (s) => s.tileDef.tileId === mkOperatorTileId(CoreOpId.Add)) !== undefined,
      "add should be suggested after field access"
    );
  });

  test("Test 42: parseTilesForSuggestions [$pos] [x] -> fieldAccess expr", () => {
    const tiles = List.from<IBrainTileDef>([posVarDef, accessorXDef]);
    const expr = parseTilesForSuggestions(tiles);

    assert.equal(expr.kind, "fieldAccess");
    if (expr.kind === "fieldAccess") {
      assert.equal(expr.object.kind, "variable");
      assert.equal(expr.accessor.fieldName, "x");

      const result = suggestTiles({ ruleSide: RuleSide.Either, expr }, catalogList(), services);
      const hasInfixOp = listFind(result.exact, (s) => s.tileDef.kind === "operator") !== undefined;
      assert.ok(hasInfixOp, "[$pos] [x] should offer infix operators");

      const doResult = suggestTiles({ ruleSide: RuleSide.Do, expr }, catalogList(), services);
      assert.ok(
        listFind(doResult.exact, (s) => s.tileDef.tileId === mkOperatorTileId(CoreOpId.Assign)) !== undefined,
        "[$pos] [x] on DO side should offer assign"
      );
    }
  });

  test("Test 43: [$pos] [x] [=] -> value tiles for assignment RHS", () => {
    const assignOpDef = services.edit.tiles.get(mkOperatorTileId(CoreOpId.Assign)) as BrainTileOperatorDef;
    const tiles = List.from<IBrainTileDef>([posVarDef, accessorXDef, assignOpDef]);
    const expr = parseTilesForSuggestions(tiles);

    assert.equal(expr.kind, "assignment");
    if (expr.kind === "assignment") {
      assert.equal(expr.target.kind, "fieldAccess");
      assert.equal(expr.value.kind, "errorExpr");

      const result = suggestTiles({ ruleSide: RuleSide.Do, expr }, catalogList(), services);

      const hasValueTile =
        listFind(
          result.exact,
          (s) => s.tileDef.kind === "literal" || s.tileDef.kind === "variable" || s.tileDef.kind === "factory"
        ) !== undefined;
      assert.ok(hasValueTile, "[$pos] [x] [=] should offer value tiles for RHS");

      const hasInfixOp =
        listFind(
          result.exact,
          (s) => s.tileDef.kind === "operator" && (s.tileDef as BrainTileOperatorDef).op.parse.fixity === "infix"
        ) !== undefined;
      assert.ok(!hasInfixOp, "[$pos] [x] [=] should NOT offer infix operators");
    }
  });

  test("Test 44: [$pos] [x] [=] [1] -> infix ops to extend value", () => {
    const assignOpDef = services.edit.tiles.get(mkOperatorTileId(CoreOpId.Assign)) as BrainTileOperatorDef;
    const numLitDef = services.edit.tiles
      .getAll()
      .toArray()
      .find(
        (t) => t.kind === "literal" && (t as BrainTileLiteralDef).valueType === CoreTypeIds.Number
      ) as BrainTileLiteralDef;

    const tiles = List.from<IBrainTileDef>([posVarDef, accessorXDef, assignOpDef, numLitDef]);
    const expr = parseTilesForSuggestions(tiles);

    assert.equal(expr.kind, "assignment");
    if (expr.kind === "assignment") {
      const result = suggestTiles({ ruleSide: RuleSide.Do, expr }, catalogList(), services);

      const hasInfixOp = listFind(result.exact, (s) => s.tileDef.kind === "operator") !== undefined;
      assert.ok(hasInfixOp, "[$pos] [x] [=] [1] should offer infix operators");

      const hasLiteral = listFind(result.exact, (s) => s.tileDef.kind === "literal") !== undefined;
      assert.ok(!hasLiteral, "[$pos] [x] [=] [1] should NOT offer literal tiles");
    }
  });

  test("Test 45: Replace accessor tile -> other accessors for same struct", () => {
    const fieldAccessExpr: FieldAccessExpr = {
      nodeId: 0,
      kind: "fieldAccess",
      object: { nodeId: 1, kind: "variable", tileDef: posVarDef, span: { from: 0, to: 1 } },
      accessor: accessorXDef,
      span: { from: 0, to: 2 },
    };

    const result = suggestTiles(
      { ruleSide: RuleSide.Either, expr: fieldAccessExpr, replaceTileIndex: 1 },
      catalogList(),
      services
    );

    assert.ok(resultContains(result, accessorXDef.tileId), "Replace accessor should suggest Position.x");
    assert.ok(resultContains(result, accessorYDef.tileId), "Replace accessor should suggest Position.y");

    const hasValueTile =
      listFind(result.exact, (s) => s.tileDef.kind === "literal" || s.tileDef.kind === "variable") !== undefined;
    assert.ok(!hasValueTile, "Replace accessor should NOT suggest value tiles");

    const hasOperator = listFind(result.exact, (s) => s.tileDef.kind === "operator") !== undefined;
    assert.ok(!hasOperator, "Replace accessor should NOT suggest operators");
  });

  test("Test 46: Different struct type -> only matching accessors suggested", () => {
    const velStructTypeId = services.runtime.types.addStructType("Velocity", {
      atomId: mkTestAtomId(),
      fields: List.from([
        { name: "dx", typeId: CoreTypeIds.Number, fieldIndex: 0 },
        { name: "dy", typeId: CoreTypeIds.Number, fieldIndex: 1 },
      ]),
    });
    const accessorDxDef = new BrainTileAccessorDef(velStructTypeId, "dx", CoreTypeIds.Number, {
      metadata: { label: "dx" },
    });
    const accessorDyDef = new BrainTileAccessorDef(velStructTypeId, "dy", CoreTypeIds.Number, {
      metadata: { label: "dy" },
    });
    services.edit.tiles.registerTileDef(accessorDxDef);
    services.edit.tiles.registerTileDef(accessorDyDef);

    const velVarDef = new BrainTileVariableDef("test.velVar", "my_velocity", velStructTypeId, "var-vel-1");
    services.edit.tiles.registerTileDef(velVarDef);

    // Position variable -> Position accessors only
    {
      const varExpr: VariableExpr = { nodeId: 0, kind: "variable", tileDef: posVarDef, span: { from: 0, to: 1 } };
      const result = suggestTiles({ ruleSide: RuleSide.Either, expr: varExpr }, catalogList(), services);
      assert.ok(resultContains(result, accessorXDef.tileId), "Position var should suggest Position.x");
      assert.ok(resultContains(result, accessorYDef.tileId), "Position var should suggest Position.y");
      assert.ok(!resultContains(result, accessorDxDef.tileId), "Position var should NOT suggest Velocity.dx");
      assert.ok(!resultContains(result, accessorDyDef.tileId), "Position var should NOT suggest Velocity.dy");
    }

    // Velocity variable -> Velocity accessors only
    {
      const varExpr: VariableExpr = { nodeId: 0, kind: "variable", tileDef: velVarDef, span: { from: 0, to: 1 } };
      const result = suggestTiles({ ruleSide: RuleSide.Either, expr: varExpr }, catalogList(), services);
      assert.ok(!resultContains(result, accessorXDef.tileId), "Velocity var should NOT suggest Position.x");
      assert.ok(resultContains(result, accessorDxDef.tileId), "Velocity var should suggest Velocity.dx");
      assert.ok(resultContains(result, accessorDyDef.tileId), "Velocity var should suggest Velocity.dy");
    }
  });

  test("Test 77: [$pos] [=] [$pos2] -> accessors filtered by assignment target type", () => {
    // When the assignment is complete and the RHS type matches the target type,
    // adding an accessor would change the RHS to an incompatible type.
    // No Position accessors should be suggested since they all produce Number,
    // which does not match the Position target type.
    const posVarDef2 = new BrainTileVariableDef("test.posVar2", "other_position", posStructTypeId, "var-pos-2");
    services.edit.tiles.registerTileDef(posVarDef2);

    const assignOpDef = services.edit.tiles.get(mkOperatorTileId(CoreOpId.Assign)) as BrainTileOperatorDef;
    const tiles = List.from<IBrainTileDef>([posVarDef, assignOpDef, posVarDef2]);
    const expr = parseTilesForSuggestions(tiles);

    assert.equal(expr.kind, "assignment");
    const result = suggestTiles({ ruleSide: RuleSide.Do, expr }, catalogList(), services);

    // All Position accessors produce Number, which is not Position -- all filtered out
    const hasAccessor = listFind(result.exact, (s) => s.tileDef.kind === "accessor") !== undefined;
    assert.ok(!hasAccessor, "[$pos] [=] [$pos2] should NOT suggest accessors (field types incompatible with target)");
  });

  test("Test 78: [$numVar] [=] [$pos] -> accessors filtered to Number fields only", () => {
    // When the assignment target is Number and the RHS is a struct,
    // accessors producing Number should be suggested.
    const numVarDef = new BrainTileVariableDef("test.numVar78", "my_number", CoreTypeIds.Number, "var-num-78");
    services.edit.tiles.registerTileDef(numVarDef);

    const assignOpDef = services.edit.tiles.get(mkOperatorTileId(CoreOpId.Assign)) as BrainTileOperatorDef;
    const tiles = List.from<IBrainTileDef>([numVarDef, assignOpDef, posVarDef]);
    const expr = parseTilesForSuggestions(tiles);

    assert.equal(expr.kind, "assignment");
    const result = suggestTiles({ ruleSide: RuleSide.Do, expr }, catalogList(), services);

    // Position.x and Position.y produce Number -> should be suggested
    assert.ok(resultContains(result, accessorXDef.tileId), "x accessor should be suggested (Number matches target)");
    assert.ok(resultContains(result, accessorYDef.tileId), "y accessor should be suggested (Number matches target)");
  });

  test("Test 79: [$pos] standalone -> all accessors still suggested (no enclosing constraint)", () => {
    // A standalone struct variable with no enclosing assignment or operator
    // should still suggest all accessors for that struct type.
    const varExpr: VariableExpr = { nodeId: 0, kind: "variable", tileDef: posVarDef, span: { from: 0, to: 1 } };
    const result = suggestTiles({ ruleSide: RuleSide.Either, expr: varExpr }, catalogList(), services);

    assert.ok(resultContains(result, accessorXDef.tileId), "standalone [$pos] should suggest Position.x");
    assert.ok(resultContains(result, accessorYDef.tileId), "standalone [$pos] should suggest Position.y");
    assert.ok(resultContains(result, accessorMagDef.tileId), "standalone [$pos] should suggest Position.mag");
  });

  test("Test 80: Replace [=] after struct variable -> struct accessors offered", () => {
    const assignOpDef = services.edit.tiles.get(mkOperatorTileId(CoreOpId.Assign)) as BrainTileOperatorDef;
    const tiles = List.from<IBrainTileDef>([posVarDef, assignOpDef]);
    const expr = parseTilesForSuggestions(tiles);
    assert.equal(expr.kind, "assignment");

    const result = suggestTiles({ ruleSide: RuleSide.Do, expr, replaceTileIndex: 1 }, catalogList(), services);

    assert.ok(resultContains(result, accessorXDef.tileId), "Replacing [=] should offer Position.x");
    assert.ok(resultContains(result, accessorYDef.tileId), "Replacing [=] should offer Position.y");
    assert.ok(resultContains(result, accessorMagDef.tileId), "Replacing [=] should offer Position.mag");

    // The assignment operator is still offered where valid (l-value target).
    assert.ok(
      listFind(result.exact, (s) => s.tileDef.tileId === mkOperatorTileId(CoreOpId.Assign)) !== undefined,
      "Replacing [=] should still offer the assignment operator"
    );
  });

  test("Test 81: Replace operator after NON-struct left -> no accessors offered", () => {
    const numVarDef = new BrainTileVariableDef("test.numVar81", "num81", CoreTypeIds.Number, "var-num-81");
    services.edit.tiles.registerTileDef(numVarDef);
    const assignOpDef = services.edit.tiles.get(mkOperatorTileId(CoreOpId.Assign)) as BrainTileOperatorDef;
    const tiles = List.from<IBrainTileDef>([numVarDef, assignOpDef]);
    const expr = parseTilesForSuggestions(tiles);
    assert.equal(expr.kind, "assignment");

    const result = suggestTiles({ ruleSide: RuleSide.Do, expr, replaceTileIndex: 1 }, catalogList(), services);

    const hasAccessor = listFind(result.exact, (s) => s.tileDef.kind === "accessor") !== undefined;
    assert.ok(!hasAccessor, "Replacing an operator after a Number left should NOT offer accessors");
  });

  test("Test 82: Replace binaryOp operator with struct left -> struct accessors offered", () => {
    const addOpDef = services.edit.tiles.get(mkOperatorTileId(CoreOpId.Add)) as BrainTileOperatorDef;
    const leftVar: VariableExpr = { nodeId: 1, kind: "variable", tileDef: posVarDef, span: { from: 0, to: 1 } };
    const rightVar: VariableExpr = { nodeId: 2, kind: "variable", tileDef: posVarDef, span: { from: 2, to: 3 } };
    const binaryExpr: BinaryOpExpr = {
      nodeId: 0,
      kind: "binaryOp",
      operator: addOpDef,
      left: leftVar,
      right: rightVar,
      span: { from: 0, to: 3 },
    };

    const result = suggestTiles(
      { ruleSide: RuleSide.Either, expr: binaryExpr, replaceTileIndex: 1 },
      catalogList(),
      services
    );

    assert.ok(resultContains(result, accessorXDef.tileId), "Replacing binaryOp operator should offer Position.x");
    assert.ok(resultContains(result, accessorYDef.tileId), "Replacing binaryOp operator should offer Position.y");
  });

  test("Value slot after [$pos] [x] [=] applies the output-identity gate both ways", () => {
    const assignOpDef = services.edit.tiles.get(mkOperatorTileId(CoreOpId.Assign)) as BrainTileOperatorDef;
    // A Number-typed output tile whose declaring sensor may or may not be in scope.
    const receivedValueOut = new BrainTileOutputDef(CoreTypeIds.Number, "receivedValue", {
      metadata: { label: "received value" },
    });
    services.edit.tiles.registerTileDef(receivedValueOut);

    const tiles = List.from<IBrainTileDef>([posVarDef, accessorXDef, assignOpDef]);
    const expr = parseTilesForSuggestions(tiles);
    assert.equal(expr.kind, "assignment");

    // Root rule: no output keys are provided. The output tile is type-compatible
    // (Number matches the x field) but must be filtered because no declaring
    // sensor is in scope.
    const suppressed = suggestTiles(
      { ruleSide: RuleSide.Do, expr, availableOutputKeys: new UniqueSet<string>() },
      catalogList(),
      services
    );
    assert.ok(
      !resultContains(suppressed, receivedValueOut.tileId),
      "output tile must not leak into the value slot without a declaring sensor"
    );

    // The gate did not over-filter: plain Number value tiles are still offered.
    const hasNumberValue =
      listFind(
        suppressed.exact,
        (s) =>
          (s.tileDef.kind === "literal" || s.tileDef.kind === "variable" || s.tileDef.kind === "factory") &&
          getTileOutputType(s.tileDef) === CoreTypeIds.Number
      ) !== undefined;
    assert.ok(hasNumberValue, "type-compatible non-output value tiles remain offered in the value slot");

    // Declaring sensor in scope (its output key available): the same tile surfaces.
    const withKey = suggestTiles(
      { ruleSide: RuleSide.Do, expr, availableOutputKeys: new UniqueSet<string>([receivedValueOut.outputKey]) },
      catalogList(),
      services
    );
    assert.ok(
      resultContains(withKey, receivedValueOut.tileId),
      "output tile must surface in the value slot when its declaring sensor is in scope"
    );

    services.edit.tiles.delete(receivedValueOut.tileId);
  });

  test("Value slot after [$pos] [x] [=] applies capability gating both ways", () => {
    const assignOpDef = services.edit.tiles.get(mkOperatorTileId(CoreOpId.Assign)) as BrainTileOperatorDef;
    const requireBit = 7;
    const guardedLit = new BrainTileLiteralDef(
      CoreTypeIds.Number,
      { t: 3, v: 77 },
      {
        metadata: { label: "cap-guarded-77" },
        persist: false,
        valueLabel: "cap-guarded-77",
        requirements: new BitSet().set(requireBit),
      },
      services
    );
    services.edit.tiles.registerTileDef(guardedLit);

    const tiles = List.from<IBrainTileDef>([posVarDef, accessorXDef, assignOpDef]);
    const expr = parseTilesForSuggestions(tiles);
    assert.equal(expr.kind, "assignment");

    const withoutCap = suggestTiles(
      { ruleSide: RuleSide.Do, expr, availableCapabilities: new BitSet() },
      catalogList(),
      services
    );
    assert.ok(
      !resultContains(withoutCap, guardedLit.tileId),
      "capability-gated value tile is filtered when its capability is unavailable"
    );

    const withCap = suggestTiles(
      { ruleSide: RuleSide.Do, expr, availableCapabilities: new BitSet().set(requireBit) },
      catalogList(),
      services
    );
    assert.ok(
      resultContains(withCap, guardedLit.tileId),
      "capability-gated value tile is offered when its capability is available"
    );

    services.edit.tiles.delete(guardedLit.tileId);
  });

  test("Replacing the value tile in [$pos] [x] [=] [1] applies the output-identity gate both ways", () => {
    const assignOpDef = services.edit.tiles.get(mkOperatorTileId(CoreOpId.Assign)) as BrainTileOperatorDef;
    const numLitDef = services.edit.tiles
      .getAll()
      .toArray()
      .find(
        (t) => t.kind === "literal" && (t as BrainTileLiteralDef).valueType === CoreTypeIds.Number
      ) as BrainTileLiteralDef;
    const rssiOut = new BrainTileOutputDef(CoreTypeIds.Number, "signalStrength", {
      metadata: { label: "signal strength" },
    });
    services.edit.tiles.registerTileDef(rssiOut);

    const tiles = List.from<IBrainTileDef>([posVarDef, accessorXDef, assignOpDef, numLitDef]);
    const expr = parseTilesForSuggestions(tiles);
    assert.equal(expr.kind, "assignment");

    // Replace the RHS literal (flat index 3): the value replacement role.
    const suppressed = suggestTiles(
      { ruleSide: RuleSide.Do, expr, replaceTileIndex: 3, availableOutputKeys: new UniqueSet<string>() },
      catalogList(),
      services
    );
    assert.ok(
      !resultContains(suppressed, rssiOut.tileId),
      "output tile must not leak when replacing the value with no declaring sensor in scope"
    );

    // With the declaring sensor in scope, the same replacement offers the tile --
    // this also proves the replacement resolved to the value role (not infix).
    const withKey = suggestTiles(
      {
        ruleSide: RuleSide.Do,
        expr,
        replaceTileIndex: 3,
        availableOutputKeys: new UniqueSet<string>([rssiOut.outputKey]),
      },
      catalogList(),
      services
    );
    assert.ok(
      resultContains(withKey, rssiOut.tileId),
      "output tile must surface when replacing the value with its declaring sensor in scope"
    );

    services.edit.tiles.delete(rssiOut.tileId);
  });
});

// ---- Accessor suggestions after value sensors ----

describe("Accessor suggestions after value sensors", () => {
  let readingStructTypeId: string;
  let accValueDef: BrainTileAccessorDef;
  let accDataDef: BrainTileAccessorDef;
  let readingSensorDef: BrainTileSensorDef;
  let writableReadingSensorDef: BrainTileSensorDef;
  let readingVarDef: BrainTileVariableDef;
  let observeNumberDef: BrainTileActuatorDef;
  let senseNumberDef: BrainTileSensorDef;
  let notOpDef: BrainTileOperatorDef;

  before(() => {
    // A struct with a Number field and a Buffer field. Buffer does not convert
    // to Number, so a Number-typed slot excludes the Buffer accessor -- letting
    // the restriction tests distinguish "filtered" from "offered".
    readingStructTypeId = services.runtime.types.addStructType("Reading", {
      atomId: mkTestAtomId(),
      fields: List.from([
        { name: "value", typeId: CoreTypeIds.Number, fieldIndex: 0 },
        { name: "data", typeId: CoreTypeIds.Buffer, fieldIndex: 1 },
      ]),
    });
    accValueDef = new BrainTileAccessorDef(readingStructTypeId, "value", CoreTypeIds.Number, {
      metadata: { label: "value" },
    });
    accDataDef = new BrainTileAccessorDef(readingStructTypeId, "data", CoreTypeIds.Buffer, {
      metadata: { label: "data" },
    });
    services.edit.tiles.registerTileDef(accValueDef);
    services.edit.tiles.registerTileDef(accDataDef);

    // A complete no-arg inline value sensor that returns the struct, mirroring
    // a gamepad's `stick position` sensor.
    const readFn = services.runtime.functions.register(
      4300,
      "test-reading-sensor",
      false,
      { exec: () => VOID_VALUE },
      mkCallDef(bag())
    );
    readingSensorDef = new BrainTileSensorDef(
      "test-reading-sensor",
      mkActionDescriptor("sensor", readFn, readingStructTypeId),
      { metadata: { label: "reading" }, placement: TilePlacement.EitherSide | TilePlacement.Inline }
    );
    services.edit.tiles.registerTileDef(readingSensorDef);

    // The same struct-returning no-arg sensor, but opted into a writable result:
    // field writes on its result are permitted.
    const writableReadFn = services.runtime.functions.register(
      4303,
      "test-writable-reading-sensor",
      false,
      { exec: () => VOID_VALUE },
      mkCallDef(bag())
    );
    writableReadingSensorDef = new BrainTileSensorDef(
      "test-writable-reading-sensor",
      mkActionDescriptor("sensor", writableReadFn, readingStructTypeId),
      {
        metadata: { label: "writable reading" },
        placement: TilePlacement.EitherSide | TilePlacement.Inline,
        writableResult: true,
      }
    );
    services.edit.tiles.registerTileDef(writableReadingSensorDef);

    readingVarDef = new BrainTileVariableDef("test.readingVar", "my_reading", readingStructTypeId, "var-reading-1");
    services.edit.tiles.registerTileDef(readingVarDef);

    // An actuator with a single anonymous Number value slot, mirroring `observe x`.
    const anonNumberSpec = param(CoreParameterId.AnonymousNumber, {
      name: "anonNum",
      required: true,
      anonymous: true,
    });
    const observeFn = services.runtime.functions.register(
      4301,
      "test-observe-number",
      false,
      { exec: () => VOID_VALUE },
      mkCallDef(bag(anonNumberSpec))
    );
    observeNumberDef = new BrainTileActuatorDef("test-observe-number", mkActionDescriptor("actuator", observeFn), {
      metadata: { label: "observe number" },
    });
    services.edit.tiles.registerTileDef(observeNumberDef);

    // A non-inline sensor with a single anonymous Number value slot. Non-inline
    // sensors consume juxtaposed value args through parseActionCall, so this one
    // holds a struct value in a Number slot.
    const senseFn = services.runtime.functions.register(
      4302,
      "test-sense-number",
      false,
      { exec: () => VOID_VALUE },
      mkCallDef(bag(anonNumberSpec))
    );
    senseNumberDef = new BrainTileSensorDef(
      "test-sense-number",
      mkActionDescriptor("sensor", senseFn, CoreTypeIds.Number),
      { metadata: { label: "sense number" }, placement: TilePlacement.EitherSide }
    );
    services.edit.tiles.registerTileDef(senseNumberDef);

    notOpDef = services.edit.tiles.get(mkOperatorTileId(CoreOpId.Not)) as BrainTileOperatorDef;
  });

  test("no-arg value sensor -> its struct accessors are offered", () => {
    const expr = parseTilesForSuggestions(List.from<IBrainTileDef>([readingSensorDef]));
    assert.equal(expr.kind, "sensor");
    const result = suggestTiles({ ruleSide: RuleSide.Do, expr }, catalogList(), services);

    assert.ok(resultContains(result, accValueDef.tileId), "[reading] should offer the 'value' accessor");
    assert.ok(resultContains(result, accDataDef.tileId), "[reading] should offer the 'data' accessor");
  });

  test("no-arg NON-inline value sensor -> no accessors (parser cannot attach them)", () => {
    const plainReadFn = services.runtime.functions.register(
      4304,
      "test-reading-sensor-plain",
      false,
      { exec: () => VOID_VALUE },
      mkCallDef(bag())
    );
    const plainReadingSensorDef = new BrainTileSensorDef(
      "test-reading-sensor-plain",
      mkActionDescriptor("sensor", plainReadFn, readingStructTypeId),
      { metadata: { label: "plain reading" }, placement: TilePlacement.EitherSide }
    );
    services.edit.tiles.registerTileDef(plainReadingSensorDef);

    const expr = parseTilesForSuggestions(List.from<IBrainTileDef>([plainReadingSensorDef]));
    assert.equal(expr.kind, "sensor");
    const result = suggestTiles({ ruleSide: RuleSide.Do, expr }, catalogList(), services);

    const hasAccessor = listFind(result.exact, (s) => s.tileDef.kind === "accessor") !== undefined;
    assert.ok(!hasAccessor, "[plain reading] should NOT offer accessors -- the parser cannot continue the sensor");
  });

  test("[not] [value sensor] -> its struct accessors are offered (unary-wrapped parity)", () => {
    const expr = parseTilesForSuggestions(List.from<IBrainTileDef>([notOpDef, readingSensorDef]));
    assert.equal(expr.kind, "unaryOp");
    const result = suggestTiles({ ruleSide: RuleSide.Do, expr }, catalogList(), services);

    assert.ok(resultContains(result, accValueDef.tileId), "[not] [reading] should offer the 'value' accessor");
    assert.ok(resultContains(result, accDataDef.tileId), "[not] [reading] should offer the 'data' accessor");
  });

  test("struct value in an actuator Number slot -> only accessors the slot accepts", () => {
    const expr = parseTilesForSuggestions(List.from<IBrainTileDef>([observeNumberDef, readingSensorDef]));
    assert.equal(expr.kind, "actuator");
    const result = suggestTiles({ ruleSide: RuleSide.Do, expr }, catalogList(), services);

    assert.ok(resultContains(result, accValueDef.tileId), "'value' (Number) accessor should be offered");
    assert.ok(
      !resultContains(result, accDataDef.tileId),
      "'data' (Buffer) accessor should NOT be offered -- the slot wants Number"
    );
  });

  test("struct value in a sensor Number slot -> only accessors the slot accepts", () => {
    const expr = parseTilesForSuggestions(List.from<IBrainTileDef>([senseNumberDef, readingSensorDef]));
    assert.equal(expr.kind, "sensor");
    const result = suggestTiles({ ruleSide: RuleSide.Do, expr }, catalogList(), services);

    assert.ok(resultContains(result, accValueDef.tileId), "'value' (Number) accessor should be offered");
    assert.ok(
      !resultContains(result, accDataDef.tileId),
      "'data' (Buffer) accessor should NOT be offered -- the slot wants Number"
    );
  });

  test("value sensor as an assignment RHS -> no accessors (whole struct assigned)", () => {
    const assignOpDef = services.edit.tiles.get(mkOperatorTileId(CoreOpId.Assign)) as BrainTileOperatorDef;
    const expr = parseTilesForSuggestions(List.from<IBrainTileDef>([readingVarDef, assignOpDef, readingSensorDef]));
    assert.equal(expr.kind, "assignment");
    const result = suggestTiles({ ruleSide: RuleSide.Do, expr }, catalogList(), services);

    const hasAccessor = listFind(result.exact, (s) => s.tileDef.kind === "accessor") !== undefined;
    assert.ok(!hasAccessor, "[$reading] [:=] [reading] should NOT offer accessors -- the whole struct is assigned");
  });

  test("[reading] [value] -> assign NOT offered (sensor result is read-only)", () => {
    const expr = parseTilesForSuggestions(List.from<IBrainTileDef>([readingSensorDef, accValueDef]));
    assert.equal(expr.kind, "fieldAccess");
    const result = suggestTiles({ ruleSide: RuleSide.Do, expr }, catalogList(), services);

    const assignTileId = mkOperatorTileId(CoreOpId.Assign);
    assert.ok(
      listFind(result.exact, (s) => s.tileDef.tileId === assignTileId) === undefined,
      "assign should NOT be offered after a field access on a read-only sensor result"
    );
  });

  test("[writable reading] [value] -> assign offered (writableResult sensor)", () => {
    const expr = parseTilesForSuggestions(List.from<IBrainTileDef>([writableReadingSensorDef, accValueDef]));
    assert.equal(expr.kind, "fieldAccess");
    const result = suggestTiles({ ruleSide: RuleSide.Do, expr }, catalogList(), services);

    const assignTileId = mkOperatorTileId(CoreOpId.Assign);
    assert.ok(
      listFind(result.exact, (s) => s.tileDef.tileId === assignTileId) !== undefined,
      "assign should be offered after a field access on a writableResult sensor result"
    );
  });

  test("[writable output] [value] -> assign offered; [output] [value] -> assign NOT offered", () => {
    const writableOutput = new BrainTileOutputDef(readingStructTypeId, "found", { writableResult: true });
    const readOnlyOutput = new BrainTileOutputDef(readingStructTypeId, "seen");
    const assignTileId = mkOperatorTileId(CoreOpId.Assign);
    const availableOutputKeys = new UniqueSet<string>([writableOutput.outputKey, readOnlyOutput.outputKey]);

    const writableExpr = parseTilesForSuggestions(List.from<IBrainTileDef>([writableOutput, accValueDef]));
    assert.equal(writableExpr.kind, "fieldAccess");
    const writable = suggestTiles(
      { ruleSide: RuleSide.Do, expr: writableExpr, availableOutputKeys },
      catalogList(),
      services
    );
    assert.ok(
      listFind(writable.exact, (s) => s.tileDef.tileId === assignTileId) !== undefined,
      "assign should be offered after a field access on a writableResult output"
    );

    const readOnlyExpr = parseTilesForSuggestions(List.from<IBrainTileDef>([readOnlyOutput, accValueDef]));
    assert.equal(readOnlyExpr.kind, "fieldAccess");
    const readOnly = suggestTiles(
      { ruleSide: RuleSide.Do, expr: readOnlyExpr, availableOutputKeys },
      catalogList(),
      services
    );
    assert.ok(
      listFind(readOnly.exact, (s) => s.tileDef.tileId === assignTileId) === undefined,
      "assign should NOT be offered after a field access on an output not declared writableResult"
    );
  });

  test("[$reading] [value] -> assign offered (variable base, unchanged)", () => {
    const expr = parseTilesForSuggestions(List.from<IBrainTileDef>([readingVarDef, accValueDef]));
    assert.equal(expr.kind, "fieldAccess");
    const result = suggestTiles({ ruleSide: RuleSide.Do, expr }, catalogList(), services);

    const assignTileId = mkOperatorTileId(CoreOpId.Assign);
    assert.ok(
      listFind(result.exact, (s) => s.tileDef.tileId === assignTileId) !== undefined,
      "assign should still be offered after a field access on a variable"
    );
  });
});

// ---- Test 47-58: Sub-expression filtering, prefix ops, non-inline sensors ----

describe("Sub-expression filtering", () => {
  test("Test 47: ['hello'] [!=] _ -> type-constrained String, no non-inline sensors", () => {
    const strLitDef = new BrainTileLiteralDef(
      CoreTypeIds.String,
      "hello",
      {
        persist: false,
        metadata: { label: "hello" },
      },
      services
    );
    services.edit.tiles.registerTileDef(strLitDef);
    const neOpDef = services.edit.tiles.get(mkOperatorTileId(CoreOpId.NotEqualTo)) as BrainTileOperatorDef;

    const tiles = List.from<IBrainTileDef>([strLitDef, neOpDef]);
    const expr = parseTilesForSuggestions(tiles);

    assert.equal(expr.kind, "binaryOp");
    const result = suggestTiles({ ruleSide: RuleSide.When, expr }, catalogList(), services);

    const hasStringValue =
      listFind(result.exact, (s) => getTileOutputType(s.tileDef) === CoreTypeIds.String) !== undefined;
    assert.ok(hasStringValue, "Should offer String value tiles as exact");

    const hasNonInlineSensor =
      listFind(
        result.exact,
        (s) => s.tileDef.kind === "sensor" && (s.tileDef.placement === undefined || (s.tileDef.placement! & 16) === 0)
      ) !== undefined;
    assert.ok(!hasNonInlineSensor, "Should NOT include non-inline sensors in sub-expression position");

    const hasNegate =
      listFind(result.exact, (s) => s.tileDef.tileId === mkOperatorTileId(CoreOpId.Negate)) !== undefined;
    assert.ok(!hasNegate, "Should NOT include [negate] when expected type is String");

    const numConversion = listFind(result.withConversion, (s) => getTileOutputType(s.tileDef) === CoreTypeIds.Number);
    assert.ok(numConversion !== undefined, "Number tiles should be in withConversion for String");

    const boolConversion = listFind(result.withConversion, (s) => getTileOutputType(s.tileDef) === CoreTypeIds.Boolean);
    assert.ok(boolConversion !== undefined, "Boolean tiles should be in withConversion for String");
  });

  test("Test 48: Top-level empty expr still includes non-inline sensors", () => {
    const result = suggestTiles({ ruleSide: RuleSide.When }, catalogList(), services);
    const hasNonInlineSensor =
      listFind(
        result.exact,
        (s) => s.tileDef.kind === "sensor" && (s.tileDef.placement === undefined || (s.tileDef.placement! & 16) === 0)
      ) !== undefined;
    assert.ok(hasNonInlineSensor, "Top-level should include non-inline sensors");
  });

  test("Test 49: [1] [+] _ without overloads -- prefix ops still offered", () => {
    const numLitDef = services.edit.tiles
      .getAll()
      .toArray()
      .find(
        (t) => t.kind === "literal" && (t as BrainTileLiteralDef).valueType === CoreTypeIds.Number
      ) as BrainTileLiteralDef;
    const addOpDef = services.edit.tiles.get(mkOperatorTileId(CoreOpId.Add)) as BrainTileOperatorDef;

    const tiles = List.from<IBrainTileDef>([numLitDef, addOpDef]);
    const expr = parseTilesForSuggestions(tiles);

    const result = suggestTiles({ ruleSide: RuleSide.Either, expr }, catalogList(), services);

    const hasPrefixOp =
      listFind(
        result.exact,
        (s) => s.tileDef.kind === "operator" && (s.tileDef as BrainTileOperatorDef).op.parse.fixity === "prefix"
      ) !== undefined;
    assert.ok(hasPrefixOp, "[1] [+] _ without overloads should still offer prefix operators");

    const hasNonInlineSensor =
      listFind(
        result.exact,
        (s) => s.tileDef.kind === "sensor" && (s.tileDef.placement === undefined || (s.tileDef.placement! & 16) === 0)
      ) !== undefined;
    assert.ok(!hasNonInlineSensor, "[1] [+] _ should NOT include non-inline sensors");
  });

  test("Test 50: [1] [+] _ with overloads -> [negate] offered, [not] excluded", () => {
    const numLitDef = services.edit.tiles
      .getAll()
      .toArray()
      .find(
        (t) => t.kind === "literal" && (t as BrainTileLiteralDef).valueType === CoreTypeIds.Number
      ) as BrainTileLiteralDef;
    const addOpDef = services.edit.tiles.get(mkOperatorTileId(CoreOpId.Add)) as BrainTileOperatorDef;

    const tiles = List.from<IBrainTileDef>([numLitDef, addOpDef]);
    const expr = parseTilesForSuggestions(tiles);

    const result = suggestTiles({ ruleSide: RuleSide.Either, expr }, catalogList(), services);

    assert.ok(
      listFind(result.exact, (s) => s.tileDef.tileId === mkOperatorTileId(CoreOpId.Negate)) !== undefined,
      "[negate] should be offered (Number result matches)"
    );
    assert.ok(
      listFind(result.exact, (s) => s.tileDef.tileId === mkOperatorTileId(CoreOpId.Not)) === undefined,
      "[not] should NOT be offered (Boolean result doesn't match Number)"
    );
  });

  test("Test 51: [not] [on-page-entered] -> UnaryOp(NOT, SensorExpr)", () => {
    const notOpDef = services.edit.tiles.get(mkOperatorTileId(CoreOpId.Not)) as BrainTileOperatorDef;
    const sensorDef = services.edit.tiles.get(mkSensorTileId(CoreHostActions.OnPageEntered.key)) as BrainTileSensorDef;

    const tiles = List.from<IBrainTileDef>([notOpDef, sensorDef]);
    const expr = parseTilesForSuggestions(tiles);

    assert.equal(expr.kind, "unaryOp");
    if (expr.kind === "unaryOp") {
      assert.equal(expr.operator.op.id, CoreOpId.Not);
      assert.equal(expr.operand.kind, "sensor");
      if (expr.operand.kind === "sensor") {
        assert.equal(expr.operand.tileDef.sensorId, CoreHostActions.OnPageEntered.key);
      }
    }
  });

  test("Test 52: Incomplete [not] -> non-inline sensors suggested", () => {
    const notOpDef = services.edit.tiles.get(mkOperatorTileId(CoreOpId.Not)) as BrainTileOperatorDef;
    const tiles = List.from<IBrainTileDef>([notOpDef]);
    const expr = parseTilesForSuggestions(tiles);

    const result = suggestTiles({ ruleSide: RuleSide.When, expr }, catalogList(), services);

    const sensorTileId = mkSensorTileId(CoreHostActions.OnPageEntered.key);
    assert.ok(
      listFind(result.exact, (s) => s.tileDef.tileId === sensorTileId) !== undefined,
      "[not] _ should include non-inline sensors"
    );
    assert.ok(
      listFind(result.exact, (s) => s.tileDef.kind === "sensor") !== undefined,
      "[not] _ should include inline sensors"
    );
    assert.ok(!listFind(result.exact, (s) => s.tileDef.kind === "actuator"), "[not] _ should NOT include actuators");
    assert.ok(
      listFind(result.exact, (s) => s.tileDef.kind === "literal") !== undefined,
      "[not] _ should include literals"
    );
  });

  test("Test 53: Complete [not] [on-page-entered] -> Boolean infix operators", () => {
    const notOpDef = services.edit.tiles.get(mkOperatorTileId(CoreOpId.Not)) as BrainTileOperatorDef;
    const sensorDef = services.edit.tiles.get(mkSensorTileId(CoreHostActions.OnPageEntered.key)) as BrainTileSensorDef;

    const tiles = List.from<IBrainTileDef>([notOpDef, sensorDef]);
    const expr = parseTilesForSuggestions(tiles);

    const result = suggestTiles({ ruleSide: RuleSide.When, expr }, catalogList(), services);

    assert.ok(
      listFind(result.exact, (s) => s.tileDef.tileId === mkOperatorTileId(CoreOpId.And)) !== undefined,
      "Should offer [and]"
    );
    assert.ok(
      listFind(result.exact, (s) => s.tileDef.tileId === mkOperatorTileId(CoreOpId.Or)) !== undefined,
      "Should offer [or]"
    );
    assert.ok(
      listFind(result.exact, (s) => s.tileDef.tileId === mkOperatorTileId(CoreOpId.EqualTo)) !== undefined,
      "Should offer [==]"
    );
    assert.ok(
      listFind(result.exact, (s) => s.tileDef.tileId === mkOperatorTileId(CoreOpId.Add)) === undefined,
      "Should NOT offer [+]"
    );
  });

  test("Test 54: [not] [sensor-with-args] -> call spec tiles suggested", () => {
    const modNearDef = new BrainTileModifierDef("test.near54", { metadata: { label: "near" } });
    const modFarDef = new BrainTileModifierDef("test.far54", { metadata: { label: "far" } });
    services.edit.tiles.registerTileDef(modNearDef);
    services.edit.tiles.registerTileDef(modFarDef);

    const callDef54 = mkCallDef(bag(choice(mod("test.near54"), mod("test.far54"))));
    const fnEntry54 = services.runtime.functions.register(
      4010,
      "test-see54",
      false,
      { exec: () => TRUE_VALUE },
      callDef54
    );
    const seeDef = new BrainTileSensorDef("test-see54", mkActionDescriptor("sensor", fnEntry54, CoreTypeIds.Boolean), {
      placement: TilePlacement.WhenSide,
      metadata: { label: "see" },
    });
    services.edit.tiles.registerTileDef(seeDef);

    const notOpDef = services.edit.tiles.get(mkOperatorTileId(CoreOpId.Not)) as BrainTileOperatorDef;
    const tiles = List.from<IBrainTileDef>([notOpDef, seeDef]);
    const expr = parseTilesForSuggestions(tiles);

    assert.equal(expr.kind, "unaryOp");
    const result = suggestTiles({ ruleSide: RuleSide.When, expr }, catalogList(), services);

    assert.ok(
      listFind(result.exact, (s) => s.tileDef.tileId === modNearDef.tileId) !== undefined,
      "Should offer [near] modifier"
    );
    assert.ok(
      listFind(result.exact, (s) => s.tileDef.tileId === modFarDef.tileId) !== undefined,
      "Should offer [far] modifier"
    );
  });

  test("Test 55: [not] [sensor] [near] -> [far] excluded, Boolean infix ops offered", () => {
    const notOpDef = services.edit.tiles.get(mkOperatorTileId(CoreOpId.Not)) as BrainTileOperatorDef;
    const seeDef = services.edit.tiles.get(mkSensorTileId("test-see54")) as BrainTileSensorDef;
    const modNearDef = services.edit.tiles.get(mkModifierTileId("test.near54")) as BrainTileModifierDef;

    const tiles = List.from<IBrainTileDef>([notOpDef, seeDef, modNearDef]);
    const expr = parseTilesForSuggestions(tiles);

    const result = suggestTiles({ ruleSide: RuleSide.When, expr }, catalogList(), services);

    const modFarDef = services.edit.tiles.get(mkModifierTileId("test.far54")) as BrainTileModifierDef;
    assert.ok(
      !listFind(result.exact, (s) => s.tileDef.tileId === modFarDef.tileId),
      "[far] should be excluded by choice"
    );

    // The operand sensor's required choice is satisfied, so the expression
    // is complete and the parser accepts an infix continuation on the whole
    // unary expression (Boolean).
    assert.ok(
      listFind(result.exact, (s) => s.tileDef.tileId === mkOperatorTileId(CoreOpId.And)) !== undefined,
      "Should offer [and] after the completed operand sensor"
    );
    assert.ok(
      listFind(result.exact, (s) => s.tileDef.tileId === mkOperatorTileId(CoreOpId.Add)) === undefined,
      "Should NOT offer [+] (no Boolean overload)"
    );
  });

  test("Test 56: Replace operand in [not] [sensor] -> operator-compatible tiles only", () => {
    const notOpDef = services.edit.tiles.get(mkOperatorTileId(CoreOpId.Not)) as BrainTileOperatorDef;
    const sensorDef = services.edit.tiles.get(mkSensorTileId(CoreHostActions.OnPageEntered.key)) as BrainTileSensorDef;

    // An inline Boolean sensor: a valid operand for `not`.
    const boolReadFn = services.runtime.functions.register(
      4056,
      "test-bool-read-56",
      false,
      { exec: () => TRUE_VALUE },
      mkCallDef(bag())
    );
    const boolReadDef = new BrainTileSensorDef(
      "test-bool-read-56",
      mkActionDescriptor("sensor", boolReadFn, CoreTypeIds.Boolean),
      { placement: TilePlacement.EitherSide | TilePlacement.Inline, metadata: { label: "bool reading" } }
    );
    services.edit.tiles.registerTileDef(boolReadDef);

    const tiles = List.from<IBrainTileDef>([notOpDef, sensorDef]);
    const expr = parseTilesForSuggestions(tiles);

    const result = suggestTiles({ ruleSide: RuleSide.When, expr, replaceTileIndex: 1 }, catalogList(), services);

    // Types the `not` overloads accept directly (Boolean or nil) are exact
    // matches; convertible types (Number -> Boolean) are offered as
    // conversions, matching the compiler's unary operand conversions.
    assert.ok(
      listFind(
        result.exact,
        (s) => s.tileDef.kind === "literal" && getTileOutputType(s.tileDef) === CoreTypeIds.Boolean
      ) !== undefined,
      "Should include Boolean literals"
    );
    assert.ok(
      listFind(result.exact, (s) => s.tileDef.tileId === boolReadDef.tileId) !== undefined,
      "Should include the inline Boolean sensor"
    );
    const randomTileId = mkSensorTileId(CoreHostActions.Random.key);
    assert.ok(
      listFind(result.withConversion, (s) => s.tileDef.tileId === randomTileId) !== undefined,
      "Should include the Number-typed random sensor as a conversion"
    );

    services.edit.tiles.delete(boolReadDef.tileId);
  });

  test("Test 57: Replace modifier inside [not] [sensor] [mod] -> action call arg tiles", () => {
    const notOpDef = services.edit.tiles.get(mkOperatorTileId(CoreOpId.Not)) as BrainTileOperatorDef;
    const seeDef = services.edit.tiles.get(mkSensorTileId("test-see54")) as BrainTileSensorDef;
    const modNearDef = services.edit.tiles.get(mkModifierTileId("test.near54")) as BrainTileModifierDef;

    const tiles = List.from<IBrainTileDef>([notOpDef, seeDef, modNearDef]);
    const expr = parseTilesForSuggestions(tiles);

    const result = suggestTiles({ ruleSide: RuleSide.When, expr, replaceTileIndex: 2 }, catalogList(), services);

    const modFarDef = services.edit.tiles.get(mkModifierTileId("test.far54")) as BrainTileModifierDef;
    assert.ok(listFind(result.exact, (s) => s.tileDef.tileId === modFarDef.tileId) !== undefined, "Should offer [far]");
    assert.ok(
      listFind(result.exact, (s) => s.tileDef.tileId === modNearDef.tileId) !== undefined,
      "Should offer [near]"
    );
  });

  test("Test 58: [1] [+] _ still excludes non-inline sensors", () => {
    const numLitDef = services.edit.tiles
      .getAll()
      .toArray()
      .find(
        (t) => t.kind === "literal" && (t as BrainTileLiteralDef).valueType === CoreTypeIds.Number
      ) as BrainTileLiteralDef;
    const addOpDef = services.edit.tiles.get(mkOperatorTileId(CoreOpId.Add)) as BrainTileOperatorDef;

    const tiles = List.from<IBrainTileDef>([numLitDef, addOpDef]);
    const expr = parseTilesForSuggestions(tiles);

    const result = suggestTiles({ ruleSide: RuleSide.When, expr }, catalogList(), services);

    const sensorTileId = mkSensorTileId(CoreHostActions.OnPageEntered.key);
    const hasNonInlineSensor =
      listFind(result.exact, (s) => s.tileDef.tileId === sensorTileId) !== undefined ||
      listFind(result.withConversion, (s) => s.tileDef.tileId === sensorTileId) !== undefined;
    assert.ok(!hasNonInlineSensor, "[1] [+] _ should still NOT include non-inline sensors");
  });
});

// ---- Test 59-61: Capability requirements ----

describe("Capability requirements filtering", () => {
  test("Test 59: Tile with requirements excluded when capabilities not satisfied", () => {
    const requireBit = 5;
    const reqBitSet = new BitSet().set(requireBit);
    const reqLitDef = new BrainTileLiteralDef(
      CoreTypeIds.Number,
      { t: 3, v: 99 },
      {
        metadata: { label: "guarded-99" },
        persist: false,
        valueLabel: "guarded-99",
        requirements: reqBitSet,
      },
      services
    );
    services.edit.tiles.registerTileDef(reqLitDef);

    // No capability context at all -> excluded (fail closed)
    const result1 = suggestTiles({ ruleSide: RuleSide.When }, catalogList(), services);
    assert.ok(
      listFind(result1.exact, (s) => s.tileDef.tileId === reqLitDef.tileId) === undefined,
      "Should be excluded when the capability context is absent"
    );

    // Empty capabilities -> excluded
    const result2 = suggestTiles(
      { ruleSide: RuleSide.When, availableCapabilities: new BitSet() },
      catalogList(),
      services
    );
    assert.ok(
      listFind(result2.exact, (s) => s.tileDef.tileId === reqLitDef.tileId) === undefined,
      "Should be excluded when empty capabilities"
    );

    // Matching capabilities -> included
    const capBitSet = new BitSet().set(requireBit);
    const result3 = suggestTiles(
      { ruleSide: RuleSide.When, availableCapabilities: capBitSet },
      catalogList(),
      services
    );
    assert.ok(
      listFind(result3.exact, (s) => s.tileDef.tileId === reqLitDef.tileId) !== undefined,
      "Should be included when matching"
    );

    // Non-matching capabilities -> excluded
    const wrongCapBitSet = new BitSet().set(requireBit + 1);
    const result4 = suggestTiles(
      { ruleSide: RuleSide.When, availableCapabilities: wrongCapBitSet },
      catalogList(),
      services
    );
    assert.ok(
      listFind(result4.exact, (s) => s.tileDef.tileId === reqLitDef.tileId) === undefined,
      "Should be excluded when wrong bits"
    );

    services.edit.tiles.delete(reqLitDef.tileId);
  });

  test("An output tile is suggested only when a declaring sensor provides its identity key", () => {
    const outputDef = new BrainTileOutputDef(CoreTypeIds.Number, "rssi", {
      metadata: { label: "signal strength" },
    });
    services.edit.tiles.registerTileDef(outputDef);

    // Absent declaring sensor (empty provided-key set) -> not surfaced.
    const without = suggestTiles(
      { ruleSide: RuleSide.When, availableOutputKeys: new UniqueSet<string>() },
      catalogList(),
      services
    );
    assert.ok(
      listFind(without.exact, (s) => s.tileDef.tileId === outputDef.tileId) === undefined,
      "output tile must be hidden without a declaring sensor"
    );

    // Declaring sensor present (its provided key available) -> surfaced.
    const withSensor = suggestTiles(
      { ruleSide: RuleSide.When, availableOutputKeys: new UniqueSet<string>([outputDef.outputKey]) },
      catalogList(),
      services
    );
    assert.ok(
      listFind(withSensor.exact, (s) => s.tileDef.tileId === outputDef.tileId) !== undefined,
      "output tile must surface downstream of a declaring sensor"
    );

    services.edit.tiles.delete(outputDef.tileId);
  });

  test("Output tiles are fail-closed: no keys context means no output tiles", () => {
    const outputDef = new BrainTileOutputDef(CoreTypeIds.Number, "rssi", {
      metadata: { label: "signal strength" },
    });
    services.edit.tiles.registerTileDef(outputDef);

    // No availableOutputKeys context at all -> the output tile is not offered.
    const result = suggestTiles({ ruleSide: RuleSide.When }, catalogList(), services);
    assert.ok(
      listFind(result.exact, (s) => s.tileDef.tileId === outputDef.tileId) === undefined,
      "output tile must not be offered when the keys context is absent"
    );
    assert.ok(
      listFind(result.withConversion, (s) => s.tileDef.tileId === outputDef.tileId) === undefined,
      "output tile must not be offered via conversion when the keys context is absent"
    );

    services.edit.tiles.delete(outputDef.tileId);
  });

  test("Output tiles with distinct identities gate independently", () => {
    // Two number outputs differing only by name resolve to distinct identity keys.
    const valueOut = new BrainTileOutputDef(CoreTypeIds.Number, "value", { metadata: { label: "value" } });
    const speedOut = new BrainTileOutputDef(CoreTypeIds.Number, "speed", { metadata: { label: "speed" } });
    services.edit.tiles.registerTileDef(valueOut);
    services.edit.tiles.registerTileDef(speedOut);

    // Only the "value" identity is provided; "speed" must stay hidden.
    const result = suggestTiles(
      { ruleSide: RuleSide.When, availableOutputKeys: new UniqueSet<string>([valueOut.outputKey]) },
      catalogList(),
      services
    );
    assert.ok(
      listFind(result.exact, (s) => s.tileDef.tileId === valueOut.tileId) !== undefined,
      "the provided output tile must surface"
    );
    assert.ok(
      listFind(result.exact, (s) => s.tileDef.tileId === speedOut.tileId) === undefined,
      "a different-identity output tile must not surface from another output's key"
    );

    services.edit.tiles.delete(valueOut.tileId);
    services.edit.tiles.delete(speedOut.tileId);
  });

  test("Test 61: Multi-bit requirements need all bits present", () => {
    const reqMulti = new BitSet().set(2).set(4);
    const multiLitDef = new BrainTileLiteralDef(
      CoreTypeIds.Number,
      { t: 3, v: 55 },
      {
        metadata: { label: "multi-req" },
        persist: false,
        valueLabel: "multi-req",
        requirements: reqMulti,
      },
      services
    );
    services.edit.tiles.registerTileDef(multiLitDef);

    // Partial
    const result1 = suggestTiles(
      { ruleSide: RuleSide.When, availableCapabilities: new BitSet().set(2) },
      catalogList(),
      services
    );
    assert.ok(
      listFind(result1.exact, (s) => s.tileDef.tileId === multiLitDef.tileId) === undefined,
      "Partial capabilities should exclude"
    );

    // Full
    const result2 = suggestTiles(
      { ruleSide: RuleSide.When, availableCapabilities: new BitSet().set(2).set(4) },
      catalogList(),
      services
    );
    assert.ok(
      listFind(result2.exact, (s) => s.tileDef.tileId === multiLitDef.tileId) !== undefined,
      "Full capabilities should include"
    );

    // Superset
    const result3 = suggestTiles(
      { ruleSide: RuleSide.When, availableCapabilities: new BitSet().set(2).set(3).set(4) },
      catalogList(),
      services
    );
    assert.ok(
      listFind(result3.exact, (s) => s.tileDef.tileId === multiLitDef.tileId) !== undefined,
      "Superset should include"
    );

    services.edit.tiles.delete(multiLitDef.tileId);
  });
});

// ---- Test 62-65: Struct-specific operator and accessor tests ----

describe("Struct-specific operator and accessor behavior", () => {
  let posStructTypeId: string;
  let accessorXDef: BrainTileAccessorDef;
  let accessorYDef: BrainTileAccessorDef;
  let accessorMagDef: BrainTileAccessorDef;
  let posVarDef: BrainTileVariableDef;

  before(() => {
    posStructTypeId = services.runtime.types.addStructType("Position62", {
      atomId: mkTestAtomId(),
      fields: List.from([
        { name: "x", typeId: CoreTypeIds.Number, fieldIndex: 0 },
        { name: "y", typeId: CoreTypeIds.Number, fieldIndex: 1 },
        { name: "mag", typeId: CoreTypeIds.Number, fieldIndex: 2 },
      ]),
    });
    accessorXDef = new BrainTileAccessorDef(posStructTypeId, "x", CoreTypeIds.Number, { metadata: { label: "x" } });
    accessorYDef = new BrainTileAccessorDef(posStructTypeId, "y", CoreTypeIds.Number, { metadata: { label: "y" } });
    accessorMagDef = new BrainTileAccessorDef(posStructTypeId, "mag", CoreTypeIds.Number, {
      metadata: { label: "mag" },
      readOnly: true,
    });
    services.edit.tiles.registerTileDef(accessorXDef);
    services.edit.tiles.registerTileDef(accessorYDef);
    services.edit.tiles.registerTileDef(accessorMagDef);

    posVarDef = new BrainTileVariableDef("test.posVar62", "my_position", posStructTypeId, "var-pos-62");
    services.edit.tiles.registerTileDef(posVarDef);
  });

  test("Test 62: Struct variable with no Assign overload -> assign + accessors", () => {
    assert.equal(
      services.edit.operatorOverloads.resolve(CoreOpId.Assign, [posStructTypeId, posStructTypeId]),
      undefined,
      "no Assign overload is registered for the struct"
    );

    const varExpr: VariableExpr = { nodeId: 0, kind: "variable", tileDef: posVarDef, span: { from: 0, to: 0 } };
    const result = suggestTiles({ ruleSide: RuleSide.Do, expr: varExpr }, catalogList(), services);

    assert.ok(
      listFind(result.exact, (s) => s.tileDef.tileId === mkOperatorTileId(CoreOpId.Assign)) !== undefined,
      "assign should be suggested"
    );
    assert.ok(resultContains(result, accessorXDef.tileId), "accessor 'x' should be suggested");
    assert.ok(resultContains(result, accessorYDef.tileId), "accessor 'y' should be suggested");
    assert.ok(
      listFind(result.exact, (s) => s.tileDef.tileId === mkOperatorTileId(CoreOpId.Add)) === undefined,
      "add should NOT be suggested for struct"
    );
  });

  test("Test 64: Read-only accessor -> assignment NOT suggested", () => {
    const fieldAccessExpr: FieldAccessExpr = {
      nodeId: 0,
      kind: "fieldAccess",
      object: { nodeId: 1, kind: "variable", tileDef: posVarDef, span: { from: 0, to: 1 } },
      accessor: accessorMagDef,
      span: { from: 0, to: 2 },
    };
    const result = suggestTiles({ ruleSide: RuleSide.Do, expr: fieldAccessExpr }, catalogList(), services);

    assert.ok(
      listFind(result.exact, (s) => s.tileDef.tileId === mkOperatorTileId(CoreOpId.Assign)) === undefined,
      "assign should NOT be suggested after read-only field"
    );
    assert.ok(
      listFind(result.exact, (s) => s.tileDef.tileId === mkOperatorTileId(CoreOpId.Add)) !== undefined,
      "add should still be suggested"
    );
  });

  test("Test 65: parseTilesForSuggestions [$pos] [mag] -> assign excluded (read-only)", () => {
    const tiles = List.from<IBrainTileDef>([posVarDef, accessorMagDef]);
    const expr = parseTilesForSuggestions(tiles);

    assert.equal(expr.kind, "fieldAccess");
    if (expr.kind === "fieldAccess") {
      assert.ok(expr.accessor.readOnly === true, "Accessor should be read-only");

      const result = suggestTiles({ ruleSide: RuleSide.Do, expr }, catalogList(), services);
      assert.ok(
        listFind(result.exact, (s) => s.tileDef.tileId === mkOperatorTileId(CoreOpId.Assign)) === undefined,
        "assign should NOT be suggested after read-only [mag]"
      );

      // Non-readOnly accessor on same struct should still allow assign
      const tiles2 = List.from<IBrainTileDef>([posVarDef, accessorXDef]);
      const expr2 = parseTilesForSuggestions(tiles2);
      const result2 = suggestTiles({ ruleSide: RuleSide.Do, expr: expr2 }, catalogList(), services);
      assert.ok(
        listFind(result2.exact, (s) => s.tileDef.tileId === mkOperatorTileId(CoreOpId.Assign)) !== undefined,
        "assign should be suggested after non-readOnly [x]"
      );
    }
  });
});

// ---- Test 66-73: Parentheses / countUnclosedParens ----

describe("Parentheses (countUnclosedParens and close-paren suggestions)", () => {
  test("Test 66: countUnclosedParens utility", () => {
    const openParen = services.edit.tiles.get(mkControlFlowTileId(CoreControlFlowId.OpenParen))!;
    const closeParen = services.edit.tiles.get(mkControlFlowTileId(CoreControlFlowId.CloseParen))!;
    const numLitDef = services.edit.tiles
      .getAll()
      .toArray()
      .find(
        (t) => t.kind === "literal" && (t as BrainTileLiteralDef).valueType === CoreTypeIds.Number
      ) as BrainTileLiteralDef;
    const addOpDef = services.edit.tiles.get(mkOperatorTileId(CoreOpId.Add)) as IBrainTileDef;

    assert.equal(countUnclosedParens(List.empty<IBrainTileDef>()), 0, "empty list -> 0");
    assert.equal(countUnclosedParens(List.from([openParen])), 1, "[(] -> 1");
    assert.equal(countUnclosedParens(List.from([openParen, numLitDef, closeParen])), 0, "[(] [2] [)] -> 0");
    assert.equal(countUnclosedParens(List.from<IBrainTileDef>([openParen, numLitDef])), 1, "[(] [2] -> 1");
    assert.equal(
      countUnclosedParens(List.from<IBrainTileDef>([openParen, openParen, numLitDef])),
      2,
      "[(] [(] [2] -> 2"
    );
    assert.equal(
      countUnclosedParens(List.from<IBrainTileDef>([openParen, openParen, numLitDef, closeParen])),
      1,
      "[(] [(] [2] [)] -> 1"
    );
    assert.equal(
      countUnclosedParens(
        List.from<IBrainTileDef>([openParen, openParen, numLitDef, closeParen, addOpDef, numLitDef, closeParen])
      ),
      0,
      "fully balanced nested -> 0"
    );
  });

  test("Test 67: [(] [2] _ -> close paren suggested, actuators excluded", () => {
    const openParen = services.edit.tiles.get(mkControlFlowTileId(CoreControlFlowId.OpenParen))!;
    const numLitDef = services.edit.tiles
      .getAll()
      .toArray()
      .find(
        (t) => t.kind === "literal" && (t as BrainTileLiteralDef).valueType === CoreTypeIds.Number
      ) as BrainTileLiteralDef;

    const tiles = List.from<IBrainTileDef>([openParen, numLitDef]);
    const expr = parseTilesForSuggestions(tiles);
    const depth = countUnclosedParens(tiles);

    assert.equal(depth, 1);
    const result = suggestTiles(
      { ruleSide: RuleSide.Either, expr, unclosedParenDepth: depth },
      catalogList(),
      services
    );

    const closeParenId = mkControlFlowTileId(CoreControlFlowId.CloseParen);
    assert.ok(
      listFind(result.exact, (s) => s.tileDef.tileId === closeParenId) !== undefined,
      "Close paren should be suggested"
    );
    assert.ok(
      listFind(result.exact, (s) => s.tileDef.tileId === mkOperatorTileId(CoreOpId.Add)) !== undefined,
      "Infix operators should be available"
    );
    assert.ok(
      !listFind(result.exact, (s) => s.tileDef.kind === "actuator"),
      "Actuators should NOT be suggested inside parens"
    );
  });

  test("Test 68: [(] _ (empty) -> no actuators, no non-inline sensors", () => {
    const openParen = services.edit.tiles.get(mkControlFlowTileId(CoreControlFlowId.OpenParen))!;
    const tiles = List.from<IBrainTileDef>([openParen]);
    const expr = parseTilesForSuggestions(tiles);
    const depth = countUnclosedParens(tiles);

    assert.equal(depth, 1);
    const result = suggestTiles(
      { ruleSide: RuleSide.Either, expr, unclosedParenDepth: depth },
      catalogList(),
      services
    );

    assert.ok(
      listFind(result.exact, (s) => s.tileDef.kind === "literal") !== undefined,
      "Literals should be suggested"
    );
    assert.ok(
      !listFind(result.exact, (s) => s.tileDef.kind === "actuator"),
      "Actuators should NOT be suggested inside parens"
    );
    assert.ok(
      !listFind(
        result.exact,
        (s) => s.tileDef.kind === "sensor" && (s.tileDef.placement === undefined || (s.tileDef.placement! & 16) === 0)
      ),
      "Non-inline sensors should NOT be suggested inside parens"
    );
  });

  test("Test 69: Balanced parens (depth=0) -> no close paren", () => {
    const numLitDef = services.edit.tiles
      .getAll()
      .toArray()
      .find(
        (t) => t.kind === "literal" && (t as BrainTileLiteralDef).valueType === CoreTypeIds.Number
      ) as BrainTileLiteralDef;

    const litExpr: LiteralExpr = { nodeId: 0, kind: "literal", tileDef: numLitDef, span: { from: 0, to: 1 } };
    const result = suggestTiles(
      { ruleSide: RuleSide.Do, expr: litExpr, unclosedParenDepth: 0 },
      catalogList(),
      services
    );

    const closeParenId = mkControlFlowTileId(CoreControlFlowId.CloseParen);
    assert.ok(
      !listFind(result.exact, (s) => s.tileDef.tileId === closeParenId),
      "Close paren should NOT be suggested when depth 0"
    );
  });

  test("Test 70: [(] [2] [+] _ -> incomplete inside parens, actuators excluded", () => {
    const openParen = services.edit.tiles.get(mkControlFlowTileId(CoreControlFlowId.OpenParen))!;
    const numLitDef = services.edit.tiles
      .getAll()
      .toArray()
      .find(
        (t) => t.kind === "literal" && (t as BrainTileLiteralDef).valueType === CoreTypeIds.Number
      ) as BrainTileLiteralDef;
    const addOpDef = services.edit.tiles.get(mkOperatorTileId(CoreOpId.Add)) as IBrainTileDef;

    const tiles = List.from<IBrainTileDef>([openParen, numLitDef, addOpDef]);
    const expr = parseTilesForSuggestions(tiles);
    const depth = countUnclosedParens(tiles);

    assert.equal(depth, 1);
    const result = suggestTiles(
      { ruleSide: RuleSide.Either, expr, unclosedParenDepth: depth },
      catalogList(),
      services
    );

    assert.ok(
      listFind(result.exact, (s) => s.tileDef.kind === "literal") !== undefined,
      "Literals should be suggested"
    );
    assert.ok(!listFind(result.exact, (s) => s.tileDef.kind === "actuator"), "Actuators should NOT be suggested");
    assert.ok(
      !listFind(result.exact, (s) => s.tileDef.tileId === mkControlFlowTileId(CoreControlFlowId.CloseParen)),
      "Close paren should NOT be suggested when expression incomplete"
    );
  });

  test("Test 71: countUnclosedParens with excludeIndex", () => {
    const openParen = services.edit.tiles.get(mkControlFlowTileId(CoreControlFlowId.OpenParen))!;
    const closeParen = services.edit.tiles.get(mkControlFlowTileId(CoreControlFlowId.CloseParen))!;
    const numLitDef = services.edit.tiles
      .getAll()
      .toArray()
      .find(
        (t) => t.kind === "literal" && (t as BrainTileLiteralDef).valueType === CoreTypeIds.Number
      ) as BrainTileLiteralDef;

    const tiles = List.from<IBrainTileDef>([openParen, numLitDef, closeParen]);
    assert.equal(countUnclosedParens(tiles, 2), 1, "excluding close paren -> 1");
    assert.equal(countUnclosedParens(tiles, 0), 0, "excluding open paren -> 0");
    assert.equal(countUnclosedParens(tiles), 0, "no exclude -> 0");
  });

  test("Test 72: Replace close paren in [(] [2] [)] -> infix ops + close paren", () => {
    const openParen = services.edit.tiles.get(mkControlFlowTileId(CoreControlFlowId.OpenParen))!;
    const closeParen = services.edit.tiles.get(mkControlFlowTileId(CoreControlFlowId.CloseParen))!;
    const numLitDef = services.edit.tiles
      .getAll()
      .toArray()
      .find(
        (t) => t.kind === "literal" && (t as BrainTileLiteralDef).valueType === CoreTypeIds.Number
      ) as BrainTileLiteralDef;

    const tiles = List.from<IBrainTileDef>([openParen, numLitDef, closeParen]);
    const expr = parseTilesForSuggestions(tiles);
    const depth = countUnclosedParens(tiles, 2);

    assert.equal(depth, 1);
    const result = suggestTiles(
      {
        ruleSide: RuleSide.Either,
        expr,
        replaceTileIndex: 2,
        unclosedParenDepth: depth,
      },
      catalogList(),
      services
    );

    assert.ok(
      listFind(result.exact, (s) => s.tileDef.kind === "operator") !== undefined,
      "Infix operators should be suggested"
    );
    assert.ok(
      listFind(result.exact, (s) => s.tileDef.tileId === mkControlFlowTileId(CoreControlFlowId.CloseParen)) !==
        undefined,
      "Close paren should be suggested"
    );
    assert.ok(
      !listFind(result.exact, (s) => s.tileDef.kind === "actuator"),
      "Actuators should NOT be suggested inside parens"
    );
  });

  test("Test 73: Replace [divided by] in [(] [2] [divided by] -> close paren suggested", () => {
    const openParen = services.edit.tiles.get(mkControlFlowTileId(CoreControlFlowId.OpenParen))!;
    const numLitDef = services.edit.tiles
      .getAll()
      .toArray()
      .find(
        (t) => t.kind === "literal" && (t as BrainTileLiteralDef).valueType === CoreTypeIds.Number
      ) as BrainTileLiteralDef;
    const divOpDef = services.edit.tiles.get(mkOperatorTileId(CoreOpId.Divide)) as IBrainTileDef;

    const tiles = List.from<IBrainTileDef>([openParen, numLitDef, divOpDef]);
    const expr = parseTilesForSuggestions(tiles);
    const depth = countUnclosedParens(tiles, 2);

    assert.equal(depth, 1);
    const result = suggestTiles(
      {
        ruleSide: RuleSide.Either,
        expr,
        replaceTileIndex: 2,
        unclosedParenDepth: depth,
      },
      catalogList(),
      services
    );

    assert.ok(
      listFind(result.exact, (s) => s.tileDef.kind === "operator") !== undefined,
      "Infix operators should be suggested"
    );
    assert.ok(
      listFind(result.exact, (s) => s.tileDef.tileId === mkControlFlowTileId(CoreControlFlowId.CloseParen)) !==
        undefined,
      "Close paren should be suggested when replacing operator inside unclosed parens"
    );
  });
});

// ---- Test 78-80: Paren suppression inside action calls ----

describe("Unclosed parens suppress named tiles in action calls", () => {
  let sayActuatorDef: BrainTileActuatorDef;
  let durationParamDef: BrainTileParameterDef;
  let numLitDef: BrainTileLiteralDef;
  let strLitDef: BrainTileLiteralDef;
  let addOpDef: BrainTileOperatorDef;
  let openParen: IBrainTileDef;
  let closeParen: IBrainTileDef;

  before(() => {
    const durationId = "test.duration.78";
    durationParamDef = new BrainTileParameterDef(durationId, CoreTypeIds.Number, { metadata: { label: "duration" } });
    services.edit.tiles.registerTileDef(durationParamDef);

    const anonStr = param(CoreParameterId.AnonymousString, { anonymous: true });
    const durationParam = param(durationId);
    const callDef = mkCallDef(bag(optional(anonStr), optional(durationParam)));
    const fnEntry = services.runtime.functions.register(
      4011,
      "test-say-78",
      false,
      { exec: () => VOID_VALUE },
      callDef
    );
    sayActuatorDef = new BrainTileActuatorDef("test-say-78", mkActionDescriptor("actuator", fnEntry), {
      metadata: { label: "say" },
      placement: TilePlacement.DoSide,
    });
    services.edit.tiles.registerTileDef(sayActuatorDef);

    numLitDef = new BrainTileLiteralDef(CoreTypeIds.Number, "5", { metadata: { label: "5" } }, services);
    services.edit.tiles.registerTileDef(numLitDef);

    strLitDef = new BrainTileLiteralDef(
      CoreTypeIds.String,
      "test78greet",
      { metadata: { label: "test78greet" } },
      services
    );
    services.edit.tiles.registerTileDef(strLitDef);

    addOpDef = services.edit.tiles.get(mkOperatorTileId(CoreOpId.Add)) as BrainTileOperatorDef;
    openParen = services.edit.tiles.get(mkControlFlowTileId(CoreControlFlowId.OpenParen))!;
    closeParen = services.edit.tiles.get(mkControlFlowTileId(CoreControlFlowId.CloseParen))!;
  });

  test("Test 78: [say] [(] _ -> named params suppressed, value tiles offered", () => {
    const tiles = List.from<IBrainTileDef>([sayActuatorDef, openParen]);
    const expr = parseTilesForSuggestions(tiles);
    const depth = countUnclosedParens(tiles);

    assert.equal(depth, 1);
    const result = suggestTiles({ ruleSide: RuleSide.Do, expr, unclosedParenDepth: depth }, catalogList(), services);

    const hasDuration = listFind(result.exact, (s) => s.tileDef.tileId === durationParamDef.tileId) !== undefined;
    assert.ok(!hasDuration, "[say] [(] should NOT offer [duration] (paren not closed)");

    // String literal should be exact (AnonString slot expects String)
    const hasStrLiteral = listFind(result.exact, (s) => s.tileDef.tileId === strLitDef.tileId) !== undefined;
    assert.ok(hasStrLiteral, "[say] [(] should offer string literal tiles (exact for AnonString)");

    // Number literal should appear via conversion (Number -> String)
    const hasNumLiteral =
      listFind(result.exact, (s) => s.tileDef.tileId === numLitDef.tileId) !== undefined ||
      listFind(result.withConversion, (s) => s.tileDef.tileId === numLitDef.tileId) !== undefined;
    assert.ok(hasNumLiteral, "[say] [(] should offer number literal tiles (via conversion)");
  });

  test("Test 79: [say] [(] [5] _ -> named params suppressed, close paren + infix ops", () => {
    const tiles = List.from<IBrainTileDef>([sayActuatorDef, openParen, numLitDef]);
    const expr = parseTilesForSuggestions(tiles);
    const depth = countUnclosedParens(tiles);

    assert.equal(depth, 1);
    const result = suggestTiles({ ruleSide: RuleSide.Do, expr, unclosedParenDepth: depth }, catalogList(), services);

    const hasDuration = listFind(result.exact, (s) => s.tileDef.tileId === durationParamDef.tileId) !== undefined;
    assert.ok(!hasDuration, "[say] [(] [5] should NOT offer [duration] (paren not closed)");

    const hasCloseParen =
      listFind(result.exact, (s) => s.tileDef.tileId === mkControlFlowTileId(CoreControlFlowId.CloseParen)) !==
      undefined;
    assert.ok(hasCloseParen, "[say] [(] [5] should offer close paren");

    const hasInfixOp =
      listFind(
        result.exact,
        (s) => s.tileDef.kind === "operator" && (s.tileDef as BrainTileOperatorDef).op.parse.fixity === "infix"
      ) !== undefined;
    assert.ok(hasInfixOp, "[say] [(] [5] should offer infix operators");
  });

  test("Test 80: [say] [(] [5] [)] _ -> named params available again", () => {
    const tiles = List.from<IBrainTileDef>([sayActuatorDef, openParen, numLitDef, closeParen]);
    const expr = parseTilesForSuggestions(tiles);
    const depth = countUnclosedParens(tiles);

    assert.equal(depth, 0);
    const result = suggestTiles({ ruleSide: RuleSide.Do, expr, unclosedParenDepth: depth }, catalogList(), services);

    const hasDuration = listFind(result.exact, (s) => s.tileDef.tileId === durationParamDef.tileId) !== undefined;
    assert.ok(hasDuration, "[say] [(] [5] [)] should offer [duration] (parens balanced)");
  });

  test("Test 81: Replace [(] in [say] [(] -> no actuators, value tiles offered", () => {
    const tiles = List.from<IBrainTileDef>([sayActuatorDef, openParen]);
    const expr = parseTilesForSuggestions(tiles);
    const depth = countUnclosedParens(tiles, 1);

    assert.equal(depth, 0);
    const result = suggestTiles(
      { ruleSide: RuleSide.Do, expr, replaceTileIndex: 1, unclosedParenDepth: depth },
      catalogList(),
      services
    );

    const hasActuator = listFind(result.exact, (s) => s.tileDef.kind === "actuator") !== undefined;
    assert.ok(!hasActuator, "Replacing [(] in [say] [(] should NOT offer actuators");

    // String literals should be offered (AnonString slot expects String)
    const hasStrLiteral =
      listFind(
        result.exact,
        (s) => s.tileDef.kind === "literal" && getTileOutputType(s.tileDef) === CoreTypeIds.String
      ) !== undefined;
    assert.ok(hasStrLiteral, "Replacing [(] in [say] [(] should offer String literals");

    // Open paren should be offered (to re-place a paren)
    const openParenId = mkControlFlowTileId(CoreControlFlowId.OpenParen);
    const hasOpenParen = listFind(result.exact, (s) => s.tileDef.tileId === openParenId) !== undefined;
    assert.ok(hasOpenParen, "Replacing [(] in [say] [(] should offer open paren");
  });

  test("Test 82: Replace [(] in [say] [(] [5] [)] -> no actuators, value tiles offered", () => {
    const tiles = List.from<IBrainTileDef>([sayActuatorDef, openParen, numLitDef, closeParen]);
    const expr = parseTilesForSuggestions(tiles);
    const depth = countUnclosedParens(tiles, 1);

    const result = suggestTiles(
      { ruleSide: RuleSide.Do, expr, replaceTileIndex: 1, unclosedParenDepth: depth },
      catalogList(),
      services
    );

    const hasActuator = listFind(result.exact, (s) => s.tileDef.kind === "actuator") !== undefined;
    assert.ok(!hasActuator, "Replacing [(] in [say] [(] [5] [)] should NOT offer actuators");

    // Value tiles should be available (replacing the paren in the anon slot)
    const hasStrLiteral =
      listFind(
        result.exact,
        (s) => s.tileDef.kind === "literal" && getTileOutputType(s.tileDef) === CoreTypeIds.String
      ) !== undefined;
    assert.ok(hasStrLiteral, "Replacing [(] in [say] [(] [5] [)] should offer String literals");
  });

  test("Test 84: [say] [(] [5] [+] _ -> Number is exact, String is conversion only", () => {
    const tiles = List.from<IBrainTileDef>([sayActuatorDef, openParen, numLitDef, addOpDef]);
    const expr = parseTilesForSuggestions(tiles);
    const depth = countUnclosedParens(tiles);

    assert.equal(depth, 1);
    const result = suggestTiles({ ruleSide: RuleSide.Do, expr, unclosedParenDepth: depth }, catalogList(), services);

    // Number literal should be an exact match (the + operator with Number LHS expects Number RHS),
    // not just a conversion match via the outer AnonString slot's String type.
    const numExact = listFind(result.exact, (s) => s.tileDef.tileId === numLitDef.tileId) !== undefined;
    assert.ok(numExact, "[say] [(] [5] [+] _ should offer Number literal as exact match");

    // String literal should NOT be an exact match -- the operator context expects
    // Number, so String is only available via conversion (same as the standalone
    // expression [(] [1] [+] _ outside an action call).
    const strExact = listFind(result.exact, (s) => s.tileDef.tileId === strLitDef.tileId) !== undefined;
    assert.ok(!strExact, "[say] [(] [5] [+] _ should NOT offer String literal as exact match");

    const strConversion = listFind(result.withConversion, (s) => s.tileDef.tileId === strLitDef.tileId) !== undefined;
    assert.ok(strConversion, "[say] [(] [5] [+] _ should offer String literal as conversion match");
  });

  test("Test 83: Replace [say] in [say] [(] -> actuators available", () => {
    const tiles = List.from<IBrainTileDef>([sayActuatorDef, openParen]);
    const expr = parseTilesForSuggestions(tiles);
    const depth = countUnclosedParens(tiles, 0);

    const result = suggestTiles(
      { ruleSide: RuleSide.Do, expr, replaceTileIndex: 0, unclosedParenDepth: depth },
      catalogList(),
      services
    );

    const hasActuator = listFind(result.exact, (s) => s.tileDef.kind === "actuator") !== undefined;
    assert.ok(hasActuator, "Replacing [say] in [say] [(] should offer actuators");
  });

  test("Test 85: Replace [(] in [say] [(] [5] [+] -> parameters available", () => {
    const tiles = List.from<IBrainTileDef>([sayActuatorDef, openParen, numLitDef, addOpDef]);
    const expr = parseTilesForSuggestions(tiles);
    const depth = countUnclosedParens(tiles, 1);

    const result = suggestTiles(
      { ruleSide: RuleSide.Do, expr, replaceTileIndex: 1, unclosedParenDepth: depth },
      catalogList(),
      services
    );

    // When replacing [(] at index 1, the incomplete anon value [1] [+] belongs
    // to the slot being replaced, so it should be excluded from the valuePending
    // check. Named parameters like [duration] should be available.
    const hasDuration = listFind(result.exact, (s) => s.tileDef.tileId === durationParamDef.tileId) !== undefined;
    assert.ok(hasDuration, "Replacing [(] in [say] [(] [5] [+] should offer [duration]");
  });

  test("Test 86: Replace [5] in [say] [(] [5] [+] -> no actuators", () => {
    const tiles = List.from<IBrainTileDef>([sayActuatorDef, openParen, numLitDef, addOpDef]);
    const expr = parseTilesForSuggestions(tiles);
    const depth = countUnclosedParens(tiles, 2);

    assert.equal(depth, 1);
    const result = suggestTiles(
      { ruleSide: RuleSide.Do, expr, replaceTileIndex: 2, unclosedParenDepth: depth },
      catalogList(),
      services
    );

    // Inside an unclosed paren, actuators are not valid -- only value-producing
    // tiles should be offered when replacing the [5] literal.
    const hasActuator = listFind(result.exact, (s) => s.tileDef.kind === "actuator") !== undefined;
    assert.ok(!hasActuator, "Replacing [5] in [say] [(] [5] [+] should NOT offer actuators");

    // Number literal should still be available as a value tile
    const hasNumLiteral = listFind(result.exact, (s) => s.tileDef.tileId === numLitDef.tileId) !== undefined;
    assert.ok(hasNumLiteral, "Replacing [5] in [say] [(] [5] [+] should offer Number literals");
  });

  test("Test 87: Replace [5] in [say] [5] [+] -> no actuators (value position)", () => {
    const tiles = List.from<IBrainTileDef>([sayActuatorDef, numLitDef, addOpDef]);
    const expr = parseTilesForSuggestions(tiles);
    const depth = countUnclosedParens(tiles, 1);

    assert.equal(depth, 0);
    const result = suggestTiles(
      { ruleSide: RuleSide.Do, expr, replaceTileIndex: 1, unclosedParenDepth: depth },
      catalogList(),
      services
    );

    // Even without parens, replacing a value operand inside a binary expression
    // should not offer actuators (they return Void, not a value).
    const hasActuator = listFind(result.exact, (s) => s.tileDef.kind === "actuator") !== undefined;
    assert.ok(!hasActuator, "Replacing [5] in [say] [5] [+] should NOT offer actuators");

    // Number and String literals should be available as value tiles
    const hasNumLiteral = listFind(result.exact, (s) => s.tileDef.tileId === numLitDef.tileId) !== undefined;
    assert.ok(hasNumLiteral, "Replacing [5] in [say] [5] [+] should offer Number literals");
  });

  test("Test 88: Insert before [(] in DO [(] [1] -> negate prefix operator available", () => {
    // When inserting before position 0, the tiles preceding the insertion point
    // are empty. parseTilesForSuggestions on an empty list returns EmptyExpr,
    // and countUnclosedParens returns 0. This simulates what the UI should
    // pass to suggestTiles for insert-before mode.
    const tilesBeforeInsert = List.empty<IBrainTileDef>();
    const expr = parseTilesForSuggestions(tilesBeforeInsert);
    const depth = countUnclosedParens(tilesBeforeInsert);

    assert.equal(depth, 0);
    assert.equal(expr.kind, "empty", "No tiles before insertion point -> EmptyExpr");
    const result = suggestTiles({ ruleSide: RuleSide.Do, expr, unclosedParenDepth: depth }, catalogList(), services);

    // Negate (prefix operator) should be available at expression start
    const hasNegate =
      listFind(result.exact, (s) => s.tileDef.tileId === mkOperatorTileId(CoreOpId.Negate)) !== undefined;
    assert.ok(hasNegate, "Insert before [(] should offer negate prefix operator");

    // Open paren should also be available
    const hasOpenParen =
      listFind(result.exact, (s) => s.tileDef.tileId === mkControlFlowTileId(CoreControlFlowId.OpenParen)) !==
      undefined;
    assert.ok(hasOpenParen, "Insert before [(] should offer open paren");

    // Number literals should be available (expression start)
    const hasNumLiteral = listFind(result.exact, (s) => s.tileDef.tileId === numLitDef.tileId) !== undefined;
    assert.ok(hasNumLiteral, "Insert before [(] should offer number literals");
  });
});

// ---- Paren groups around and inside a call ----

describe("Paren groups around and inside a call", () => {
  let pgOpenParen: IBrainTileDef;
  let pgCloseParen: IBrainTileDef;
  /** Two optional modifiers, so one remains available after the other is placed. */
  let pgKind: BrainTileModifierDef;
  let pgRange: BrainTileModifierDef;
  /** Non-inline Boolean sensor whose modifiers are all optional. */
  let pgSensor: BrainTileSensorDef;
  /** Non-inline Boolean sensor with a required anonymous Number argument. */
  let pgReqSensor: BrainTileSensorDef;
  /** Actuator with a required anonymous Number argument and an optional named parameter. */
  let pgDrive: BrainTileActuatorDef;
  let pgPower: BrainTileParameterDef;
  let pgNumLit: BrainTileLiteralDef;

  before(() => {
    pgOpenParen = services.edit.tiles.get(mkControlFlowTileId(CoreControlFlowId.OpenParen))!;
    pgCloseParen = services.edit.tiles.get(mkControlFlowTileId(CoreControlFlowId.CloseParen))!;
    pgNumLit = new BrainTileLiteralDef(CoreTypeIds.Number, 7, { metadata: { label: "7" } }, services);

    pgKind = new BrainTileModifierDef("pg.kind", { metadata: { label: "pg kind" } });
    pgRange = new BrainTileModifierDef("pg.range", { metadata: { label: "pg range" } });
    const seeFn = services.runtime.functions.register(
      4600,
      "pg-see",
      false,
      { exec: () => TRUE_VALUE },
      mkCallDef(bag(optional(mod("pg.kind")), optional(mod("pg.range"))))
    );
    pgSensor = new BrainTileSensorDef("pg-see", mkActionDescriptor("sensor", seeFn, CoreTypeIds.Boolean), {
      metadata: { label: "pg see" },
    });

    const pgReqNum = new BrainTileParameterDef("pg.reqNum", CoreTypeIds.Number, { metadata: { label: "pg req" } });
    const reqFn = services.runtime.functions.register(
      4601,
      "pg-req-see",
      false,
      { exec: () => TRUE_VALUE },
      mkCallDef(seq(param("pg.reqNum", { name: "pgReq", required: true, anonymous: true })))
    );
    pgReqSensor = new BrainTileSensorDef("pg-req-see", mkActionDescriptor("sensor", reqFn, CoreTypeIds.Boolean), {
      metadata: { label: "pg req see" },
    });

    pgPower = new BrainTileParameterDef("pg.power", CoreTypeIds.Number, { metadata: { label: "pg power" } });
    const pgSpeed = new BrainTileParameterDef("pg.speed", CoreTypeIds.Number, { metadata: { label: "pg speed" } });
    const driveFn = services.runtime.functions.register(
      4602,
      "pg-drive",
      false,
      { exec: () => VOID_VALUE },
      mkCallDef(
        seq(param("pg.speed", { name: "pgSpeed", required: true, anonymous: true }), bag(optional(param("pg.power"))))
      )
    );
    pgDrive = new BrainTileActuatorDef("pg-drive", mkActionDescriptor("actuator", driveFn), {
      metadata: { label: "pg drive" },
    });

    for (const def of [pgNumLit, pgKind, pgRange, pgSensor, pgReqNum, pgReqSensor, pgPower, pgSpeed, pgDrive]) {
      services.edit.tiles.registerTileDef(def);
    }
  });

  /** The offering at the end of `tiles`, as the editor computes it for an append. */
  function offeringAfter(tiles: IBrainTileDef[]): TileSuggestionResult {
    const list = List.from(tiles);
    return suggestTiles(
      {
        ruleSide: RuleSide.Either,
        expr: parseTilesForSuggestions(list),
        unclosedParenDepth: countUnclosedParens(list),
      },
      catalogList(),
      services
    );
  }

  function offers(result: TileSuggestionResult, tileId: string): boolean {
    return (
      listFind(result.exact, (s) => s.tileDef.tileId === tileId) !== undefined ||
      listFind(result.withConversion, (s) => s.tileDef.tileId === tileId) !== undefined
    );
  }

  test("a closed group around a call ends it: its remaining argument slots are not offered", () => {
    const result = offeringAfter([pgOpenParen, pgSensor, pgKind, pgCloseParen]);

    assert.ok(!offers(result, pgRange.tileId), "the call's remaining modifier is not valid after the group closed");
    assert.ok(!offers(result, pgKind.tileId));
  });

  test("a closed group around a call offers what may follow a complete value", () => {
    const result = offeringAfter([pgOpenParen, pgSensor, pgKind, pgCloseParen]);

    assert.ok(offers(result, mkOperatorTileId(CoreOpId.And)), "the group is a complete Boolean value");
  });

  test("an open group around a call still offers the call's remaining argument slots", () => {
    const result = offeringAfter([pgOpenParen, pgSensor, pgKind]);

    assert.ok(offers(result, pgRange.tileId), "the call is still taking arguments inside the open group");
  });

  test("an open group around a complete call offers the closing paren", () => {
    const result = offeringAfter([pgOpenParen, pgSensor, pgKind]);

    assert.ok(offers(result, mkControlFlowTileId(CoreControlFlowId.CloseParen)));
  });

  test("an open group whose call still needs a required argument does not offer the closing paren", () => {
    const result = offeringAfter([pgOpenParen, pgReqSensor]);

    assert.ok(!offers(result, mkControlFlowTileId(CoreControlFlowId.CloseParen)));
  });

  test("a group closed inside a call's argument leaves the call taking arguments", () => {
    const result = offeringAfter([pgDrive, pgOpenParen, pgNumLit, pgCloseParen]);

    assert.ok(offers(result, pgPower.tileId), "the group closed the argument, not the call");
  });

  test("a group open inside a call's argument suppresses the call's named arguments", () => {
    const result = offeringAfter([pgDrive, pgOpenParen, pgNumLit]);

    assert.ok(!offers(result, pgPower.tileId), "the argument's group must close first");
    assert.ok(offers(result, mkControlFlowTileId(CoreControlFlowId.CloseParen)));
  });
});

// ---- Test 74-76: Replace repeated modifier, anon slot value ----

describe("Replace repeated modifier and anonymous slot value", () => {
  let richActuatorDef: BrainTileActuatorDef;
  let richCallDef: ReturnType<typeof mkCallDef>;
  let modFastDef: BrainTileModifierDef;
  let modSlowDef: BrainTileModifierDef;
  let slotFast: number;

  before(() => {
    modFastDef = services.edit.tiles.get(mkModifierTileId("test.fast")) as BrainTileModifierDef;
    modSlowDef = services.edit.tiles.get(mkModifierTileId("test.slow")) as BrainTileModifierDef;
    richActuatorDef = services.edit.tiles.get(mkActuatorTileId("test-rich")) as BrainTileActuatorDef;
    richCallDef = richActuatorDef.action.callDef;
    slotFast = richCallDef.argSlots.toArray().find((s) => s.argSpec.tileId === mkModifierTileId("test.fast"))!.slotId;
  });

  test("Test 74: Replace repeated modifier preserves choice exclusion", () => {
    const modSlots74 = List.empty<SlotExpr>();
    modSlots74.push({
      slotId: slotFast,
      expr: { nodeId: 101, kind: "modifier", tileDef: modFastDef, span: { from: 1, to: 2 } },
    });
    modSlots74.push({
      slotId: slotFast,
      expr: { nodeId: 102, kind: "modifier", tileDef: modFastDef, span: { from: 2, to: 3 } },
    });
    const expr74: ActuatorExpr = {
      nodeId: 0,
      kind: "actuator",
      tileDef: richActuatorDef,
      anons: List.empty<SlotExpr>(),
      parameters: List.empty<SlotExpr>(),
      modifiers: modSlots74,
      span: { from: 0, to: 3 },
    };

    const result74 = suggestTiles(
      { ruleSide: RuleSide.Do, expr: expr74, replaceTileIndex: 2 },
      catalogList(),
      services
    );
    assert.ok(
      resultContains(result74, modFastDef.tileId),
      "modFast should be available when replacing one of two (max 2)"
    );
    assert.ok(
      !resultContains(result74, modSlowDef.tileId),
      "modSlow should NOT be available -- other [fast] still fills the choice"
    );
  });

  test("Test 75: Replace value in anonymous slot -> actuators excluded", () => {
    const anonNumParamId = "test.anonNum75";
    const anonNumParamDef = new BrainTileParameterDef(anonNumParamId, CoreTypeIds.Number, {
      metadata: { label: "amt" },
    });
    services.edit.tiles.registerTileDef(anonNumParamDef);

    const callDef75 = mkCallDef(bag(param(anonNumParamId, { anonymous: true })));
    const fnEntry75 = services.runtime.functions.register(
      4012,
      "test-anon75",
      false,
      { exec: () => VOID_VALUE },
      callDef75
    );
    const actuatorDef75 = new BrainTileActuatorDef("test-anon75", mkActionDescriptor("actuator", fnEntry75), {
      metadata: { label: "anon75" },
    });
    services.edit.tiles.registerTileDef(actuatorDef75);

    const litDef = services.edit.tiles
      .getAll()
      .toArray()
      .find((t) => t.kind === "literal" && getTileOutputType(t) === CoreTypeIds.Number) as BrainTileLiteralDef;
    const anonSlotId = callDef75.argSlots.get(0).slotId;
    const anonSlots75 = List.empty<SlotExpr>();
    anonSlots75.push({
      slotId: anonSlotId,
      expr: { nodeId: 50, kind: "literal", tileDef: litDef, span: { from: 1, to: 2 } },
    });

    const expr75: ActuatorExpr = {
      nodeId: 0,
      kind: "actuator",
      tileDef: actuatorDef75,
      anons: anonSlots75,
      parameters: List.empty<SlotExpr>(),
      modifiers: List.empty<SlotExpr>(),
      span: { from: 0, to: 2 },
    };

    const result75 = suggestTiles(
      { ruleSide: RuleSide.Do, expr: expr75, replaceTileIndex: 1 },
      catalogList(),
      services
    );

    assert.ok(
      listFind(result75.exact, (s) => getTileOutputType(s.tileDef) === CoreTypeIds.Number) !== undefined,
      "Should suggest Number tiles"
    );
    assert.ok(!listFind(result75.exact, (s) => s.tileDef.kind === "actuator"), "Actuators should NOT appear in exact");
    assert.ok(
      !listFind(result75.withConversion, (s) => s.tileDef.kind === "actuator"),
      "Actuators should NOT appear in withConversion"
    );
  });

  test("Test 76: Replace page tile in choice(AnonNumber, AnonString) -> page is exact match", () => {
    // The switch-page actuator has choice(AnonNumber, AnonString). A page tile
    // outputs String. The parser greedily assigns the page to AnonNumber (first
    // choice). When replacing, the system should still recognize String as an
    // exact match (via the AnonString sibling), not a conversion.
    const switchPageTileId = mkActuatorTileId(CoreHostActions.SwitchPage.key);
    const switchPageTile = services.edit.tiles.get(switchPageTileId) as BrainTileActuatorDef;
    assert.ok(switchPageTile, "switch-page actuator must exist");

    const pageDef = new BrainTilePageDef("test-page-76", "My Page");
    services.edit.tiles.registerTileDef(pageDef);

    // Find the AnonNumber slot (first choice option) -- this is what the parser
    // would greedily assign a page tile to.
    const callDef = switchPageTile.action.callDef;
    const anonNumberSlot = callDef.argSlots.toArray().find((s) => s.argSpec.anonymous);
    assert.ok(anonNumberSlot, "switch-page should have an anonymous slot");

    // Build the AST: [switch page] [My Page]
    // The page tile is in the anon slot with AnonNumber's slotId (parser greediness).
    const anonSlots = List.empty<SlotExpr>();
    anonSlots.push({
      slotId: anonNumberSlot.slotId,
      expr: {
        nodeId: 50,
        kind: "literal",
        tileDef: pageDef as unknown as BrainTileLiteralDef,
        span: { from: 1, to: 2 },
      },
    });

    const expr76: ActuatorExpr = {
      nodeId: 0,
      kind: "actuator",
      tileDef: switchPageTile,
      anons: anonSlots,
      parameters: List.empty<SlotExpr>(),
      modifiers: List.empty<SlotExpr>(),
      span: { from: 0, to: 2 },
    };

    const result76 = suggestTiles(
      { ruleSide: RuleSide.Do, expr: expr76, replaceTileIndex: 1 },
      catalogList(),
      services
    );

    // Page tiles produce String, which should be an exact match for AnonString
    const pageInExact = listFind(result76.exact, (s) => s.tileDef.tileId === pageDef.tileId);
    assert.ok(pageInExact !== undefined, "Page tile should appear in exact suggestions");
    assert.equal(
      pageInExact?.compatibility,
      TileCompatibility.Exact,
      "Page tile should have Exact compatibility, not Conversion"
    );

    // String tiles in general should also be exact
    const stringInExact = listFind(
      result76.exact,
      (s) => s.tileDef.kind === "literal" && getTileOutputType(s.tileDef) === CoreTypeIds.String
    );
    assert.ok(stringInExact !== undefined, "String literals should be in exact");

    // Number tiles should also be exact (via AnonNumber sibling)
    const numberInExact = listFind(
      result76.exact,
      (s) => s.tileDef.kind === "literal" && getTileOutputType(s.tileDef) === CoreTypeIds.Number
    );
    assert.ok(numberInExact !== undefined, "Number literals should also be in exact");

    // Page tile should NOT appear in withConversion
    const pageInConversion = listFind(result76.withConversion, (s) => s.tileDef.tileId === pageDef.tileId);
    assert.ok(pageInConversion === undefined, "Page tile should NOT appear in withConversion");
  });
});

// ---- Test 77-78: See-like sensor with optional(choice(repeated())) ----

describe("See-like sensor optional+choice+repeated modifiers", () => {
  test("Test 77: [see-like] -> nearby and faraway modifiers available", () => {
    const modCarnDef = new BrainTileModifierDef("test.carn77", { metadata: { label: "carnivore" } });
    const modHerbDef = new BrainTileModifierDef("test.herb77", { metadata: { label: "herbivore" } });
    const modPlantDef = new BrainTileModifierDef("test.plant77", { metadata: { label: "plant" } });
    const modNearDef77 = new BrainTileModifierDef("test.near77", { metadata: { label: "nearby" } });
    const modFarDef77 = new BrainTileModifierDef("test.far77", { metadata: { label: "far away" } });
    services.edit.tiles.registerTileDef(modCarnDef);
    services.edit.tiles.registerTileDef(modHerbDef);
    services.edit.tiles.registerTileDef(modPlantDef);
    services.edit.tiles.registerTileDef(modNearDef77);
    services.edit.tiles.registerTileDef(modFarDef77);

    const seeCallDef = mkCallDef(
      bag(
        optional(choice(mod("test.carn77"), mod("test.herb77"), mod("test.plant77"))),
        optional(choice(repeated(mod("test.near77"), { max: 3 }), repeated(mod("test.far77"), { max: 3 })))
      )
    );
    const seeFnEntry = services.runtime.functions.register(
      4013,
      "test-see77",
      false,
      { exec: () => TRUE_VALUE },
      seeCallDef
    );
    const seeDef77 = new BrainTileSensorDef(
      "test-see77",
      mkActionDescriptor("sensor", seeFnEntry, CoreTypeIds.Boolean),
      {
        metadata: { label: "see" },
      }
    );
    services.edit.tiles.registerTileDef(seeDef77);

    // Build sensor expr with no modifiers placed
    const seeExpr: SensorExpr = {
      nodeId: 0,
      kind: "sensor",
      tileDef: seeDef77,
      anons: List.empty<SlotExpr>(),
      parameters: List.empty<SlotExpr>(),
      modifiers: List.empty<SlotExpr>(),
      span: { from: 0, to: 0 },
    };

    const result = suggestTiles({ ruleSide: RuleSide.When, expr: seeExpr }, catalogList(), services);

    assert.ok(resultContains(result, modCarnDef.tileId), "carnivore should be available");
    assert.ok(resultContains(result, modHerbDef.tileId), "herbivore should be available");
    assert.ok(resultContains(result, modPlantDef.tileId), "plant should be available");
    assert.ok(resultContains(result, modNearDef77.tileId), "nearby should be available");
    assert.ok(resultContains(result, modFarDef77.tileId), "far away should be available");
  });

  test("Test 78: [see-like] [carnivore] -> nearby and faraway still available", () => {
    const seeDef = services.edit.tiles.get(mkSensorTileId("test-see77")) as BrainTileSensorDef;
    const modCarnDef = services.edit.tiles.get(mkModifierTileId("test.carn77")) as BrainTileModifierDef;
    const modNearDef = services.edit.tiles.get(mkModifierTileId("test.near77")) as BrainTileModifierDef;
    const modFarDef = services.edit.tiles.get(mkModifierTileId("test.far77")) as BrainTileModifierDef;

    const carnSlotId = seeDef.action.callDef.argSlots
      .toArray()
      .find((s) => s.argSpec.tileId === mkModifierTileId("test.carn77"))!.slotId;

    const mods = List.empty<SlotExpr>();
    mods.push({
      slotId: carnSlotId,
      expr: { nodeId: 10, kind: "modifier", tileDef: modCarnDef, span: { from: 1, to: 2 } },
    });

    const seeExpr: SensorExpr = {
      nodeId: 0,
      kind: "sensor",
      tileDef: seeDef,
      anons: List.empty<SlotExpr>(),
      parameters: List.empty<SlotExpr>(),
      modifiers: mods,
      span: { from: 0, to: 2 },
    };

    const result = suggestTiles({ ruleSide: RuleSide.When, expr: seeExpr }, catalogList(), services);

    assert.ok(resultContains(result, modNearDef.tileId), "nearby should be available after carnivore placed");
    assert.ok(resultContains(result, modFarDef.tileId), "far away should be available after carnivore placed");
  });
});

// ---- Test 89: Right-spine operator rebinding ----

describe("Right-spine operator rebinding", () => {
  test("Test 89: [numVar] [>] [numVar] -> numeric operators suggested via right-spine rebinding", () => {
    const numVarDef = services.edit.tiles
      .getAll()
      .toArray()
      .find(
        (t) => t.kind === "variable" && (t as BrainTileVariableDef).varType === CoreTypeIds.Number
      ) as BrainTileVariableDef;
    assert.ok(numVarDef, "Need a Number variable tile");

    const gtOpDef = services.edit.tiles.get(mkOperatorTileId(CoreOpId.GreaterThan)) as BrainTileOperatorDef;
    assert.ok(gtOpDef, "Need the > operator tile");

    // Build [a] [>] [b] as a complete binaryOp expression
    const leftVar: VariableExpr = { nodeId: 0, kind: "variable", tileDef: numVarDef, span: { from: 0, to: 1 } };
    const rightVar: VariableExpr = { nodeId: 1, kind: "variable", tileDef: numVarDef, span: { from: 2, to: 3 } };
    const binaryExpr: BinaryOpExpr = {
      nodeId: 2,
      kind: "binaryOp",
      operator: gtOpDef,
      left: leftVar,
      right: rightVar,
      span: { from: 0, to: 3 },
    };

    const result = suggestTiles({ ruleSide: RuleSide.When, expr: binaryExpr }, catalogList(), services);

    // Boolean-compatible operators should be suggested (overall expr type is Boolean)
    assert.ok(resultContains(result, mkOperatorTileId(CoreOpId.And)), "and should be suggested (Boolean LHS)");
    assert.ok(resultContains(result, mkOperatorTileId(CoreOpId.Or)), "or should be suggested (Boolean LHS)");

    // Numeric operators should ALSO be suggested because they have higher precedence
    // than > and would rebind with the right operand [b] (Number) via Pratt parsing.
    // e.g., [a] [>] [b] [*] [c] parses as a > (b * c)
    assert.ok(
      resultContains(result, mkOperatorTileId(CoreOpId.Multiply)),
      "multiply should be suggested (rebinds with Number right operand)"
    );
    assert.ok(
      resultContains(result, mkOperatorTileId(CoreOpId.Add)),
      "add should be suggested (rebinds with Number right operand)"
    );
    assert.ok(
      resultContains(result, mkOperatorTileId(CoreOpId.Subtract)),
      "subtract should be suggested (rebinds with Number right operand)"
    );
    assert.ok(
      resultContains(result, mkOperatorTileId(CoreOpId.Divide)),
      "divide should be suggested (rebinds with Number right operand)"
    );
  });

  test("Test 89b: parseTilesForSuggestions [numVar] [>] [numVar] -> numeric operators available", () => {
    const numVarDef = services.edit.tiles
      .getAll()
      .toArray()
      .find(
        (t) => t.kind === "variable" && (t as BrainTileVariableDef).varType === CoreTypeIds.Number
      ) as BrainTileVariableDef;
    assert.ok(numVarDef, "Need a Number variable tile");

    const gtOpDef = services.edit.tiles.get(mkOperatorTileId(CoreOpId.GreaterThan)) as BrainTileOperatorDef;
    assert.ok(gtOpDef, "Need the > operator tile");

    // Use parseTilesForSuggestions to match the real UI flow
    const tiles = List.from<IBrainTileDef>([numVarDef, gtOpDef, numVarDef]);
    const expr = parseTilesForSuggestions(tiles);

    const result = suggestTiles({ ruleSide: RuleSide.When, expr }, catalogList(), services);

    assert.ok(
      resultContains(result, mkOperatorTileId(CoreOpId.Multiply)),
      "multiply should be suggested after [numVar] [>] [numVar]"
    );
    assert.ok(
      resultContains(result, mkOperatorTileId(CoreOpId.Add)),
      "add should be suggested after [numVar] [>] [numVar]"
    );
  });
});

// ---- WHEN-result consumption ----

describe("WHEN-result consumption", () => {
  // A type-specific consumer that requires a Buffer WHEN result, usable on either
  // side and inline (mirroring the inline gamepad decoder sensor).
  let bufferConsumerDef: BrainTileSensorDef;
  // A type-specific consumer that requires a Number WHEN result.
  let numberConsumerDef: BrainTileActuatorDef;
  // A non-consumer inline sensor: declares no WHEN-result consumption, so it is
  // never gated (mirroring the undeclared `display text` actuator).
  let plainSensorDef: BrainTileSensorDef;
  // WHEN-side producers whose values type the rule's WHEN result.
  let bufferProducerDef: BrainTileSensorDef;
  let booleanProducerDef: BrainTileSensorDef;
  let numberProducerDef: BrainTileSensorDef;

  before(() => {
    const emptyCall = mkCallDef(bag());
    const noop = { exec: () => VOID_VALUE };

    const bufFn = services.runtime.functions.register(4201, "test-when-buffer-consumer", false, noop, emptyCall);
    bufferConsumerDef = new BrainTileSensorDef(
      "test-when-buffer-consumer",
      mkActionDescriptor("sensor", bufFn, CoreTypeIds.Buffer),
      {
        metadata: { label: "decoded value" },
        placement: TilePlacement.EitherSide | TilePlacement.Inline,
        consumesWhenResult: CoreTypeIds.Buffer,
      }
    );
    services.edit.tiles.registerTileDef(bufferConsumerDef);

    const numFn = services.runtime.functions.register(4202, "test-when-number-consumer", false, noop, emptyCall);
    numberConsumerDef = new BrainTileActuatorDef("test-when-number-consumer", mkActionDescriptor("actuator", numFn), {
      metadata: { label: "show number" },
      placement: TilePlacement.DoSide,
      consumesWhenResult: CoreTypeIds.Number,
    });
    services.edit.tiles.registerTileDef(numberConsumerDef);

    const plainFn = services.runtime.functions.register(4206, "test-when-plain-sensor", false, noop, emptyCall);
    plainSensorDef = new BrainTileSensorDef(
      "test-when-plain-sensor",
      mkActionDescriptor("sensor", plainFn, CoreTypeIds.Number),
      { metadata: { label: "plain value" }, placement: TilePlacement.EitherSide | TilePlacement.Inline }
    );
    services.edit.tiles.registerTileDef(plainSensorDef);

    const bufSrcFn = services.runtime.functions.register(4203, "test-when-buffer-producer", false, noop, emptyCall);
    bufferProducerDef = new BrainTileSensorDef(
      "test-when-buffer-producer",
      mkActionDescriptor("sensor", bufSrcFn, CoreTypeIds.Buffer),
      { metadata: { label: "receive buffer" }, placement: TilePlacement.WhenSide }
    );
    services.edit.tiles.registerTileDef(bufferProducerDef);

    const boolSrcFn = services.runtime.functions.register(4204, "test-when-boolean-producer", false, noop, emptyCall);
    booleanProducerDef = new BrainTileSensorDef(
      "test-when-boolean-producer",
      mkActionDescriptor("sensor", boolSrcFn, CoreTypeIds.Boolean),
      { metadata: { label: "is pressed" }, placement: TilePlacement.WhenSide }
    );
    services.edit.tiles.registerTileDef(booleanProducerDef);

    const numSrcFn = services.runtime.functions.register(4205, "test-when-number-producer", false, noop, emptyCall);
    numberProducerDef = new BrainTileSensorDef(
      "test-when-number-producer",
      mkActionDescriptor("sensor", numSrcFn, CoreTypeIds.Number),
      { metadata: { label: "read number" }, placement: TilePlacement.WhenSide }
    );
    services.edit.tiles.registerTileDef(numberProducerDef);
  });

  function offered(result: TileSuggestionResult, tileId: string): boolean {
    return (
      listFind(result.exact, (s) => s.tileDef.tileId === tileId) !== undefined ||
      listFind(result.withConversion, (s) => s.tileDef.tileId === tileId) !== undefined
    );
  }

  function firstRule(): BrainRuleDef {
    const brainDef = new BrainDef(services);
    const pageResult = brainDef.appendNewPage();
    assert.ok(pageResult.success);
    return pageResult.value!.page.children().get(0)! as BrainRuleDef;
  }

  // -- A required consumer is offered only where a compatible WHEN result is available --

  test("a Buffer consumer is not offered on the WHEN side of an empty root rule", () => {
    const rule = firstRule();
    const result = suggestTiles({ ruleSide: RuleSide.When, ruleDef: rule }, catalogList(), services);
    assert.ok(!offered(result, bufferConsumerDef.tileId), "no ancestor WHEN result -> not a valid suggestion");
  });

  test("a Buffer consumer is not offered on the DO side of an empty root rule", () => {
    const rule = firstRule();
    const result = suggestTiles({ ruleSide: RuleSide.Do, ruleDef: rule }, catalogList(), services);
    assert.ok(!offered(result, bufferConsumerDef.tileId), "no WHEN result in scope -> not a valid suggestion");
  });

  test("a Buffer consumer is not offered on the WHEN side even when the rule's own WHEN produces a Buffer", () => {
    const rule = firstRule();
    __test__appendTile(rule.when(), bufferProducerDef);
    const result = suggestTiles({ ruleSide: RuleSide.When, ruleDef: rule }, catalogList(), services);
    assert.ok(
      !offered(result, bufferConsumerDef.tileId),
      "the rule's own WHEN result is not captured while its WHEN is edited"
    );
  });

  test("a Buffer consumer is offered on the DO side of a rule whose WHEN produces a Buffer", () => {
    const rule = firstRule();
    __test__appendTile(rule.when(), bufferProducerDef);
    const result = suggestTiles({ ruleSide: RuleSide.Do, ruleDef: rule }, catalogList(), services);
    assert.ok(offered(result, bufferConsumerDef.tileId), "the DO side reads the rule's own Buffer WHEN result");
  });

  test("a Buffer consumer is offered on a child rule's WHEN side when the ancestor produces a Buffer", () => {
    const parent = firstRule();
    __test__appendTile(parent.when(), bufferProducerDef);
    const child = parent.appendNewRule();
    const result = suggestTiles({ ruleSide: RuleSide.When, ruleDef: child }, catalogList(), services);
    assert.ok(offered(result, bufferConsumerDef.tileId), "the child WHEN side reads the ancestor's Buffer result");
  });

  test("a Buffer consumer is offered on the DO side of an empty-WHEN child that falls through to a Buffer ancestor", () => {
    const parent = firstRule();
    __test__appendTile(parent.when(), bufferProducerDef);
    const child = parent.appendNewRule();
    const result = suggestTiles({ ruleSide: RuleSide.Do, ruleDef: child }, catalogList(), services);
    assert.ok(
      offered(result, bufferConsumerDef.tileId),
      "empty-WHEN child DO side falls through to the ancestor Buffer"
    );
  });

  test("a Number consumer is offered on the DO side under a Number WHEN", () => {
    const rule = firstRule();
    __test__appendTile(rule.when(), numberProducerDef);
    const result = suggestTiles({ ruleSide: RuleSide.Do, ruleDef: rule }, catalogList(), services);
    assert.ok(offered(result, numberConsumerDef.tileId));
  });

  test("a Number consumer is not offered on the DO side under a Buffer WHEN", () => {
    const rule = firstRule();
    __test__appendTile(rule.when(), bufferProducerDef);
    const result = suggestTiles({ ruleSide: RuleSide.Do, ruleDef: rule }, catalogList(), services);
    assert.ok(!offered(result, numberConsumerDef.tileId), "Buffer does not convert to Number");
  });

  test("a Number consumer is offered on the DO side under a convertible (Boolean) WHEN", () => {
    const rule = firstRule();
    __test__appendTile(rule.when(), booleanProducerDef);
    const result = suggestTiles({ ruleSide: RuleSide.Do, ruleDef: rule }, catalogList(), services);
    assert.ok(offered(result, numberConsumerDef.tileId), "Boolean converts to Number, so the consumer is valid");
  });

  test("a non-consumer tile is offered on both sides of an empty root rule", () => {
    const rule = firstRule();
    const doResult = suggestTiles({ ruleSide: RuleSide.Do, ruleDef: rule }, catalogList(), services);
    const whenResult = suggestTiles({ ruleSide: RuleSide.When, ruleDef: rule }, catalogList(), services);
    assert.ok(offered(doResult, plainSensorDef.tileId), "a tile declaring no WHEN consumption is never gated (DO)");
    assert.ok(offered(whenResult, plainSensorDef.tileId), "a tile declaring no WHEN consumption is never gated (WHEN)");
  });

  test("supplying a rule leaves non-consumer suggestions unchanged", () => {
    const rule = firstRule();
    const withRule = suggestTiles({ ruleSide: RuleSide.Do, ruleDef: rule }, catalogList(), services);
    const withoutRule = suggestTiles({ ruleSide: RuleSide.Do }, catalogList(), services);
    assert.ok(offered(withRule, plainSensorDef.tileId));
    assert.equal(offered(withRule, plainSensorDef.tileId), offered(withoutRule, plainSensorDef.tileId));
    // The required consumer is absent either way: no WHEN result is available on an empty DO side.
    assert.ok(!offered(withRule, bufferConsumerDef.tileId));
    assert.ok(!offered(withoutRule, bufferConsumerDef.tileId));
  });

  // -- getRuleWhenResultType (model helper + ancestor fall-through) --

  test("getRuleWhenResultType types a value-bearing WHEN sensor", () => {
    const rule = firstRule();
    __test__appendTile(rule.when(), bufferProducerDef);
    assert.equal(
      getRuleWhenResultType(rule, services.edit.operatorOverloads, services.shared.conversions),
      CoreTypeIds.Buffer
    );
  });

  test("getRuleWhenResultType types a boolean WHEN as Boolean", () => {
    const rule = firstRule();
    __test__appendTile(rule.when(), booleanProducerDef);
    assert.equal(
      getRuleWhenResultType(rule, services.edit.operatorOverloads, services.shared.conversions),
      CoreTypeIds.Boolean
    );
  });

  test("getRuleWhenResultType returns undefined for a lone empty WHEN", () => {
    const rule = firstRule();
    assert.equal(rule.when().tiles().size(), 0);
    assert.equal(getRuleWhenResultType(rule, services.edit.operatorOverloads, services.shared.conversions), undefined);
  });

  test("getRuleWhenResultType falls through an empty child WHEN to the ancestor's result type", () => {
    const parent = firstRule();
    __test__appendTile(parent.when(), bufferProducerDef);
    const child = parent.appendNewRule();
    assert.equal(child.when().tiles().size(), 0, "child WHEN is empty");
    assert.equal(
      getRuleWhenResultType(child, services.edit.operatorOverloads, services.shared.conversions),
      CoreTypeIds.Buffer,
      "child sees the parent's WHEN-result type"
    );
  });

  test("getRuleWhenResultType types an empty WHEN under a trigger mode as its Boolean arming read", () => {
    const parent = firstRule();
    __test__appendTile(parent.when(), bufferProducerDef);
    parent.appendNewRule();
    const child = parent.appendNewRule();
    child.setTrigger(RuleTriggerMode.Then);
    assert.equal(child.when().tiles().size(), 0, "child WHEN is empty");
    assert.equal(
      getRuleWhenResultType(child, services.edit.operatorOverloads, services.shared.conversions),
      CoreTypeIds.Boolean,
      "the mode's arming read is the rule's own captured WHEN result"
    );
  });
});

// ---- Trigger modes available at a position ----

describe("availableTriggerModes", () => {
  function pageWithRules(count: number): BrainRuleDef[] {
    const brainDef = new BrainDef(services);
    const pageResult = brainDef.appendNewPage();
    assert.ok(pageResult.success);
    const page = pageResult.value!.page;
    while (page.children().size() < count) page.appendNewRule();
    const rules: BrainRuleDef[] = [];
    for (let i = 0; i < count; i++) rules.push(page.children().get(i)! as BrainRuleDef);
    return rules;
  }

  test("the first rule at a level takes the when mode alone", () => {
    const [first] = pageWithRules(2);
    assert.deepEqual(availableTriggerModes(first).toArray(), [RuleTriggerMode.When]);
  });

  test("a rule with a preceding sibling takes all three modes", () => {
    const [, second] = pageWithRules(2);
    assert.deepEqual(availableTriggerModes(second).toArray(), [
      RuleTriggerMode.When,
      RuleTriggerMode.Otherwise,
      RuleTriggerMode.Then,
    ]);
  });

  test("the first child rule at its own level takes the when mode alone", () => {
    const [root] = pageWithRules(2);
    const firstChild = root.appendNewRule();
    const secondChild = root.appendNewRule();
    assert.deepEqual(availableTriggerModes(firstChild).toArray(), [RuleTriggerMode.When]);
    assert.equal(availableTriggerModes(secondChild).size(), 3);
  });

  test("no rule takes the when mode alone", () => {
    assert.deepEqual(availableTriggerModes(undefined).toArray(), [RuleTriggerMode.When]);
  });
});

// ---- Replacement roles carry position constraints ----

describe("Replacement roles carry position constraints", () => {
  let ptStructTypeId: string;
  let ptAccNum: BrainTileAccessorDef;
  let ptNumVar: BrainTileVariableDef;
  let ptStrVar: BrainTileVariableDef;
  let ptStructVar: BrainTileVariableDef;
  let ptNumLit: BrainTileLiteralDef;
  let ptNumSensor: BrainTileSensorDef;
  let ptNilLit: IBrainTileDef;

  before(() => {
    ptStructTypeId = services.runtime.types.addStructType("PtReading", {
      atomId: mkTestAtomId(),
      fields: List.from([{ name: "level", typeId: CoreTypeIds.Number, fieldIndex: 0 }]),
    });
    ptAccNum = new BrainTileAccessorDef(ptStructTypeId, "level", CoreTypeIds.Number, { metadata: { label: "level" } });
    ptNumVar = new BrainTileVariableDef("pt.numVar", "pt_num", CoreTypeIds.Number, "pt-var-num");
    ptStrVar = new BrainTileVariableDef("pt.strVar", "pt_str", CoreTypeIds.String, "pt-var-str");
    ptStructVar = new BrainTileVariableDef("pt.structVar", "pt_reading", ptStructTypeId, "pt-var-struct");
    ptNumLit = new BrainTileLiteralDef(CoreTypeIds.Number, 7, { metadata: { label: "7" } }, services);
    const ptNumReadFn = services.runtime.functions.register(
      4210,
      "pt-num-read",
      false,
      { exec: () => NIL_VALUE },
      mkCallDef(bag())
    );
    ptNumSensor = new BrainTileSensorDef("pt-num-read", mkActionDescriptor("sensor", ptNumReadFn, CoreTypeIds.Number), {
      placement: TilePlacement.EitherSide | TilePlacement.Inline,
      metadata: { label: "pt num reading" },
    });
    for (const def of [ptAccNum, ptNumVar, ptStrVar, ptStructVar, ptNumLit, ptNumSensor]) {
      services.edit.tiles.registerTileDef(def);
    }
    ptNilLit = services.edit.tiles
      .getAll()
      .toArray()
      .find((t) => t.kind === "literal" && (t as BrainTileLiteralDef).valueType === CoreTypeIds.Nil)!;
  });

  function offeredAnywhere(result: TileSuggestionResult, tileId: string): boolean {
    return (
      listFind(result.exact, (s) => s.tileDef.tileId === tileId) !== undefined ||
      listFind(result.withConversion, (s) => s.tileDef.tileId === tileId) !== undefined
    );
  }

  test("Replacing an assignment target offers only compatible l-values", () => {
    const assignOpDef = services.edit.tiles.get(mkOperatorTileId(CoreOpId.Assign)) as BrainTileOperatorDef;
    const tiles = List.from<IBrainTileDef>([ptNumVar, assignOpDef, ptNumLit]);
    const expr = parseTilesForSuggestions(tiles);
    assert.equal(expr.kind, "assignment");

    const result = suggestTiles({ ruleSide: RuleSide.Do, expr, replaceTileIndex: 0 }, catalogList(), services);

    assert.ok(offeredAnywhere(result, ptNumVar.tileId), "a Number variable is a valid target for a Number value");
    assert.ok(
      offeredAnywhere(result, ptStructVar.tileId),
      "a struct variable with a Number field is a valid target (refined with an accessor)"
    );
    assert.ok(
      offeredAnywhere(result, ptStrVar.tileId),
      "a String variable is offered: the assigned Number converts to String"
    );
    assert.ok(!offeredAnywhere(result, ptNumLit.tileId), "a literal is not an l-value");
    assert.ok(!offeredAnywhere(result, ptNilLit.tileId), "nil is not an l-value");
    assert.ok(!offeredAnywhere(result, ptNumSensor.tileId), "a plain sensor result is not writable");
    assert.ok(
      !offeredAnywhere(result, mkOperatorTileId(CoreOpId.Negate)) &&
        !offeredAnywhere(result, mkOperatorTileId(CoreOpId.Not)),
      "prefix operators do not produce l-values"
    );
  });

  test("Replacing a field-access base under assignment respects isLValue recursion", () => {
    const assignOpDef = services.edit.tiles.get(mkOperatorTileId(CoreOpId.Assign)) as BrainTileOperatorDef;
    const tiles = List.from<IBrainTileDef>([ptStructVar, ptAccNum, assignOpDef, ptNumLit]);
    const expr = parseTilesForSuggestions(tiles);
    assert.equal(expr.kind, "assignment");

    const result = suggestTiles({ ruleSide: RuleSide.Do, expr, replaceTileIndex: 0 }, catalogList(), services);

    assert.ok(offeredAnywhere(result, ptStructVar.tileId), "a variable base keeps the field access writable");
    assert.ok(offeredAnywhere(result, ptNumVar.tileId), "any variable is a writable base");
    assert.ok(!offeredAnywhere(result, ptNumLit.tileId), "a literal base makes the field access read-only");
    assert.ok(!offeredAnywhere(result, ptNilLit.tileId), "nil is not a writable base");
    assert.ok(!offeredAnywhere(result, ptNumSensor.tileId), "a sensor-result base is not writable");
  });

  test("Replacing a field-access base under assignment offers a writableResult output, not a read-only one", () => {
    const writableOutput = new BrainTileOutputDef(ptStructTypeId, "ptFound", { writableResult: true });
    const readOnlyOutput = new BrainTileOutputDef(ptStructTypeId, "ptSeen");
    services.edit.tiles.registerTileDef(writableOutput);
    services.edit.tiles.registerTileDef(readOnlyOutput);
    const assignOpDef = services.edit.tiles.get(mkOperatorTileId(CoreOpId.Assign)) as BrainTileOperatorDef;
    const tiles = List.from<IBrainTileDef>([ptStructVar, ptAccNum, assignOpDef, ptNumLit]);
    const expr = parseTilesForSuggestions(tiles);
    assert.equal(expr.kind, "assignment");

    const result = suggestTiles(
      {
        ruleSide: RuleSide.Do,
        expr,
        replaceTileIndex: 0,
        availableOutputKeys: new UniqueSet<string>([writableOutput.outputKey, readOnlyOutput.outputKey]),
      },
      catalogList(),
      services
    );

    assert.ok(offeredAnywhere(result, writableOutput.tileId), "a writableResult output is a writable base");
    assert.ok(!offeredAnywhere(result, readOnlyOutput.tileId), "a read-only output base is not writable");
  });

  test("Replacing a binary operand offers only operator-compatible types", () => {
    const addOpDef = services.edit.tiles.get(mkOperatorTileId(CoreOpId.Add)) as BrainTileOperatorDef;
    const tiles = List.from<IBrainTileDef>([ptNumLit, addOpDef, ptNumLit]);
    const expr = parseTilesForSuggestions(tiles);
    assert.equal(expr.kind, "binaryOp");

    const result = suggestTiles({ ruleSide: RuleSide.Do, expr, replaceTileIndex: 2 }, catalogList(), services);

    assert.ok(offeredAnywhere(result, ptNumLit.tileId), "a Number literal fits add's Number overload");
    assert.ok(
      offeredAnywhere(result, ptStructVar.tileId),
      "a struct with a Number field fits via an accessor refinement"
    );
    assert.ok(!offeredAnywhere(result, ptNilLit.tileId), "nil fits no add overload and has no conversion");
    assert.ok(
      offeredAnywhere(result, mkOperatorTileId(CoreOpId.Negate)),
      "negate produces a Number, which add accepts"
    );
    assert.ok(
      !offeredAnywhere(result, mkOperatorTileId(CoreOpId.Not)),
      "not produces a Boolean, which no add overload accepts directly"
    );
  });

  test("Replacing a unary operand offers direct and convertible types", () => {
    const notOpDef = services.edit.tiles.get(mkOperatorTileId(CoreOpId.Not)) as BrainTileOperatorDef;
    const boolLitDef = services.edit.tiles
      .getAll()
      .toArray()
      .find((t) => t.kind === "literal" && (t as BrainTileLiteralDef).valueType === CoreTypeIds.Boolean)!;
    const tiles = List.from<IBrainTileDef>([notOpDef, boolLitDef]);
    const expr = parseTilesForSuggestions(tiles);
    assert.equal(expr.kind, "unaryOp");

    const result = suggestTiles({ ruleSide: RuleSide.When, expr, replaceTileIndex: 1 }, catalogList(), services);

    assert.ok(offeredAnywhere(result, boolLitDef.tileId), "a Boolean literal is a direct operand for not");
    assert.ok(offeredAnywhere(result, ptNilLit.tileId), "nil is a direct operand for not (nil overload)");
    assert.ok(
      offeredAnywhere(result, ptNumVar.tileId),
      "a Number variable is offered: the compiler converts unary operands (Number -> Boolean)"
    );
    assert.ok(
      offeredAnywhere(result, ptStrVar.tileId),
      "a String variable is offered: the compiler converts unary operands (String -> Boolean)"
    );
  });

  test("Close paren is not offered at an operator replacement whose right operand is present", () => {
    const openParen = services.edit.tiles.get(mkControlFlowTileId(CoreControlFlowId.OpenParen))!;
    const addOpDef = services.edit.tiles.get(mkOperatorTileId(CoreOpId.Add)) as BrainTileOperatorDef;
    const tiles = List.from<IBrainTileDef>([openParen, ptNumLit, addOpDef, ptNumLit]);
    const expr = parseTilesForSuggestions(tiles);
    const depth = countUnclosedParens(tiles, 2);
    assert.equal(depth, 1);

    const result = suggestTiles(
      { ruleSide: RuleSide.Do, expr, replaceTileIndex: 2, unclosedParenDepth: depth },
      catalogList(),
      services
    );

    assert.ok(
      !offeredAnywhere(result, mkControlFlowTileId(CoreControlFlowId.CloseParen)),
      "the trailing operand cannot re-parse after a close paren"
    );
    assert.ok(offeredAnywhere(result, mkOperatorTileId(CoreOpId.Subtract)), "infix operators are still offered");
  });
});

// ---- Sensor and operator parity in value positions ----

describe("Sensor and operator parity in value positions", () => {
  /** Non-inline Number sensor with no arguments, valid on either side. */
  let vpNumSensor: BrainTileSensorDef;
  /** Non-inline Boolean sensor whose only argument is an optional modifier. */
  let vpOptSensor: BrainTileSensorDef;
  let vpOptMod: BrainTileModifierDef;
  /** Non-inline Boolean sensor with a required anonymous Number slot. */
  let vpReqSensor: BrainTileSensorDef;
  /** Actuator with a required anonymous Number slot and an optional named param. */
  let vpDrive: BrainTileActuatorDef;
  let vpPower: BrainTileParameterDef;
  let vpNumVar: BrainTileVariableDef;
  let vpNumLit: BrainTileLiteralDef;

  before(() => {
    vpNumLit = new BrainTileLiteralDef(CoreTypeIds.Number, 5, { metadata: { label: "5" } }, services);
    vpNumVar = new BrainTileVariableDef("vp.numVar", "vp_num", CoreTypeIds.Number, "vp-var-num");

    const numFn = services.runtime.functions.register(
      4321,
      "vp-num-sense",
      false,
      { exec: () => NIL_VALUE },
      mkCallDef(bag())
    );
    vpNumSensor = new BrainTileSensorDef("vp-num-sense", mkActionDescriptor("sensor", numFn, CoreTypeIds.Number), {
      placement: TilePlacement.EitherSide,
      metadata: { label: "vp num" },
    });

    vpOptMod = new BrainTileModifierDef("vp.optMod", { metadata: { label: "opt" } });
    const optFn = services.runtime.functions.register(
      4322,
      "vp-opt-sense",
      false,
      { exec: () => TRUE_VALUE },
      mkCallDef(bag(optional(mod("vp.optMod"))))
    );
    vpOptSensor = new BrainTileSensorDef("vp-opt-sense", mkActionDescriptor("sensor", optFn, CoreTypeIds.Boolean), {
      metadata: { label: "vp opt" },
    });

    const vpReqParam = new BrainTileParameterDef("vp.reqNum", CoreTypeIds.Number, { metadata: { label: "req num" } });
    const reqFn = services.runtime.functions.register(
      4323,
      "vp-req-sense",
      false,
      { exec: () => TRUE_VALUE },
      mkCallDef(seq(param("vp.reqNum", { name: "reqNum", required: true, anonymous: true })))
    );
    vpReqSensor = new BrainTileSensorDef("vp-req-sense", mkActionDescriptor("sensor", reqFn, CoreTypeIds.Boolean), {
      metadata: { label: "vp req" },
    });

    vpPower = new BrainTileParameterDef("vp.power", CoreTypeIds.Number, { metadata: { label: "power" } });
    const vpSpeed = new BrainTileParameterDef("vp.speed", CoreTypeIds.Number, { metadata: { label: "speed" } });
    const driveFn = services.runtime.functions.register(
      4324,
      "vp-drive",
      false,
      { exec: () => VOID_VALUE },
      mkCallDef(
        seq(param("vp.speed", { name: "speed", required: true, anonymous: true }), bag(optional(param("vp.power"))))
      )
    );
    vpDrive = new BrainTileActuatorDef("vp-drive", mkActionDescriptor("actuator", driveFn), {
      metadata: { label: "vp drive" },
    });

    for (const def of [
      vpNumLit,
      vpNumVar,
      vpNumSensor,
      vpOptMod,
      vpOptSensor,
      vpReqParam,
      vpReqSensor,
      vpPower,
      vpSpeed,
      vpDrive,
    ]) {
      services.edit.tiles.registerTileDef(def);
    }
  });

  function offeredAnywhere(result: TileSuggestionResult, tileId: string): boolean {
    return (
      listFind(result.exact, (s) => s.tileDef.tileId === tileId) !== undefined ||
      listFind(result.withConversion, (s) => s.tileDef.tileId === tileId) !== undefined
    );
  }

  test("Non-inline sensor offered when replacing a prefix-op operand", () => {
    const notOpDef = services.edit.tiles.get(mkOperatorTileId(CoreOpId.Not)) as BrainTileOperatorDef;
    const tiles = List.from<IBrainTileDef>([notOpDef, vpOptSensor]);
    const expr = parseTilesForSuggestions(tiles);
    assert.equal(expr.kind, "unaryOp");

    const result = suggestTiles({ ruleSide: RuleSide.When, expr, replaceTileIndex: 1 }, catalogList(), services);

    assert.ok(
      offeredAnywhere(result, mkSensorTileId(CoreHostActions.OnPageEntered.key)),
      "a non-inline Boolean sensor is a valid prefix-op operand"
    );
    assert.ok(
      offeredAnywhere(result, vpNumSensor.tileId),
      "a Number sensor is offered: the compiler converts unary operands (Number -> Boolean)"
    );
  });

  test("Non-inline sensor offered when replacing a binary-op operand", () => {
    const addOpDef = services.edit.tiles.get(mkOperatorTileId(CoreOpId.Add)) as BrainTileOperatorDef;
    const tiles = List.from<IBrainTileDef>([vpNumLit, addOpDef, vpNumLit]);
    const expr = parseTilesForSuggestions(tiles);
    assert.equal(expr.kind, "binaryOp");

    const result = suggestTiles({ ruleSide: RuleSide.When, expr, replaceTileIndex: 2 }, catalogList(), services);

    assert.ok(
      offeredAnywhere(result, vpNumSensor.tileId),
      "a non-inline Number sensor is a valid right operand for add"
    );
  });

  test("Non-inline sensor NOT offered in non-operand value positions", () => {
    const assignOpDef = services.edit.tiles.get(mkOperatorTileId(CoreOpId.Assign)) as BrainTileOperatorDef;
    const assignTiles = List.from<IBrainTileDef>([vpNumVar, assignOpDef, vpNumLit]);
    const assignExpr = parseTilesForSuggestions(assignTiles);
    assert.equal(assignExpr.kind, "assignment");

    const assignResult = suggestTiles(
      { ruleSide: RuleSide.Do, expr: assignExpr, replaceTileIndex: 2 },
      catalogList(),
      services
    );
    assert.ok(
      !offeredAnywhere(assignResult, vpNumSensor.tileId),
      "an assignment value position does not offer non-inline sensors"
    );

    const slotTiles = List.from<IBrainTileDef>([vpDrive, vpNumLit]);
    const slotExpr = parseTilesForSuggestions(slotTiles);
    assert.equal(slotExpr.kind, "actuator");

    const slotResult = suggestTiles(
      { ruleSide: RuleSide.Do, expr: slotExpr, replaceTileIndex: 1 },
      catalogList(),
      services
    );
    assert.ok(
      !offeredAnywhere(slotResult, vpNumSensor.tileId),
      "an action call anonymous slot does not offer non-inline sensors"
    );
  });

  test("At the expression head, only a sensor that can host the displaced value is offered", () => {
    const addOpDef = services.edit.tiles.get(mkOperatorTileId(CoreOpId.Add)) as BrainTileOperatorDef;
    const tiles = List.from<IBrainTileDef>([vpNumLit, addOpDef, vpNumLit]);
    const expr = parseTilesForSuggestions(tiles);
    assert.equal(expr.kind, "binaryOp");

    const result = suggestTiles({ ruleSide: RuleSide.When, expr, replaceTileIndex: 0 }, catalogList(), services);

    assert.ok(
      !offeredAnywhere(result, vpNumSensor.tileId),
      "a sensor with no anonymous slot leaves the operator continuation dangling at the head"
    );
    assert.ok(
      offeredAnywhere(result, mkSensorTileId(CoreHostActions.Timeout.key)),
      "[timeout] hosts the displaced expression in its anonymous Number slot"
    );
  });

  test("Infix operators offered after a prefix-op expr with only optional slots unfilled", () => {
    const notOpDef = services.edit.tiles.get(mkOperatorTileId(CoreOpId.Not)) as BrainTileOperatorDef;
    const tiles = List.from<IBrainTileDef>([notOpDef, vpOptSensor]);
    const expr = parseTilesForSuggestions(tiles);
    assert.equal(expr.kind, "unaryOp");

    const result = suggestTiles({ ruleSide: RuleSide.When, expr }, catalogList(), services);

    assert.ok(
      offeredAnywhere(result, mkOperatorTileId(CoreOpId.And)),
      "the expression is complete: unfilled optional slots do not block continuation"
    );
    assert.ok(!offeredAnywhere(result, mkOperatorTileId(CoreOpId.Add)), "no Boolean overload for [+]");
    assert.ok(offeredAnywhere(result, vpOptMod.tileId), "the optional modifier is still offered alongside");
  });

  test("No infix operators while the operand has a required slot unfilled", () => {
    const notOpDef = services.edit.tiles.get(mkOperatorTileId(CoreOpId.Not)) as BrainTileOperatorDef;
    const tiles = List.from<IBrainTileDef>([notOpDef, vpReqSensor]);
    const expr = parseTilesForSuggestions(tiles);
    assert.equal(expr.kind, "unaryOp");

    const result = suggestTiles({ ruleSide: RuleSide.When, expr }, catalogList(), services);

    const hasInfix =
      listFind(
        result.exact,
        (s) => s.tileDef.kind === "operator" && (s.tileDef as BrainTileOperatorDef).op.parse.fixity === "infix"
      ) !== undefined;
    assert.ok(!hasInfix, "the required anonymous slot must be filled before the expression can continue");
  });

  test("Named-arg replacement offers infix operators after a complete trailing value", () => {
    const tiles = List.from<IBrainTileDef>([vpDrive, vpNumLit, vpPower, vpNumLit]);
    const expr = parseTilesForSuggestions(tiles);
    assert.equal(expr.kind, "actuator");

    const result = suggestTiles({ ruleSide: RuleSide.Do, expr, replaceTileIndex: 2 }, catalogList(), services);

    assert.ok(
      offeredAnywhere(result, mkOperatorTileId(CoreOpId.Add)),
      "[+] extends the anonymous value; the displaced tiles re-parse as its right operand"
    );
    assert.ok(!offeredAnywhere(result, mkOperatorTileId(CoreOpId.And)), "no Number overload for [and]");
  });
});

describe("Rule hierarchy gate derivation", () => {
  const HIER_CAP_BIT = 11;

  /** A no-arg Number sensor that provides `output` and the probe capability bit. */
  function mkProviderSensor(fnId: number, id: string, output: BrainTileOutputDef): BrainTileSensorDef {
    const fnEntry = services.runtime.functions.register(fnId, id, false, { exec: () => NIL_VALUE }, mkCallDef(bag()));
    return new BrainTileSensorDef(id, mkActionDescriptor("sensor", fnEntry, CoreTypeIds.Number), {
      metadata: { label: id },
      capabilities: new BitSet().set(HIER_CAP_BIT),
      providedOutputs: List.from([output.outputKey]),
    });
  }

  test("collection covers the rule's WHEN and DO sides and all ancestor rules", () => {
    const out = new BrainTileOutputDef(CoreTypeIds.Number, "hierSignal", { metadata: { label: "hier signal" } });
    const provider = mkProviderSensor(4361, "test-hier-provider", out);

    const brain = BrainDef.emptyBrainDef(services, "hier-walk");
    const rule = brain.pages().get(0).children().get(0) as BrainRuleDef;
    __test__appendTile(rule.when(), provider);
    const child = rule.appendNewRule();

    assert.ok(collectRuleHierarchyOutputKeys(rule).has(out.outputKey), "own WHEN side provides the key");
    assert.ok(collectRuleHierarchyOutputKeys(child).has(out.outputKey), "an ancestor's WHEN side provides the key");
    assert.equal(collectRuleHierarchyCapabilities(child).get(HIER_CAP_BIT), 1, "ancestor capability is visible");

    const otherBrain = BrainDef.emptyBrainDef(services, "hier-empty");
    const otherRule = otherBrain.pages().get(0).children().get(0) as BrainRuleDef;
    assert.ok(!collectRuleHierarchyOutputKeys(otherRule).has(out.outputKey), "an unrelated rule sees no key");
    assert.equal(
      collectRuleHierarchyCapabilities(otherRule).get(HIER_CAP_BIT),
      0,
      "an unrelated rule sees no capability"
    );
  });

  test("collection is a live walk: replacing the providing tile drops its keys", () => {
    const out = new BrainTileOutputDef(CoreTypeIds.Number, "hierSwap", { metadata: { label: "hier swap" } });
    const provider = mkProviderSensor(4362, "test-hier-swap-provider", out);

    const brain = BrainDef.emptyBrainDef(services, "hier-swap");
    const rule = brain.pages().get(0).children().get(0) as BrainRuleDef;
    __test__appendTile(rule.when(), provider);
    assert.ok(collectRuleHierarchyOutputKeys(rule).has(out.outputKey), "the provider's key is collected");
    assert.equal(collectRuleHierarchyCapabilities(rule).get(HIER_CAP_BIT), 1, "the provider's capability is collected");

    // Replace (not remove/append) the WHEN tile: a fresh collection reflects it.
    const replacement = new BrainTileLiteralDef(CoreTypeIds.Boolean, true, {}, services);
    brain.catalog().registerTileDef(replacement);
    rule.when().replaceTileAtIndex(0, replacement);
    assert.ok(!collectRuleHierarchyOutputKeys(rule).has(out.outputKey), "the key disappears with its provider");
    assert.equal(
      collectRuleHierarchyCapabilities(rule).get(HIER_CAP_BIT),
      0,
      "the capability disappears with its provider"
    );
  });
});

// ---- Multi-anonymous-slot action calls ----

describe("Multi-anonymous-slot action calls", () => {
  /** Actuator with two anonymous Number slots (both slots share the anon Number arg tile). */
  let steerDef: BrainTileActuatorDef;
  /** Inline no-arg value sensor returning a struct with a Number field. */
  let axisSensorDef: BrainTileSensorDef;
  /** Accessor for the struct's Number field. */
  let accAxisDef: BrainTileAccessorDef;
  /** Registered Number variable, the probe for second-slot value offers. */
  let axisVarDef: BrainTileVariableDef;

  before(() => {
    const steerFn = services.runtime.functions.register(
      4370,
      "test-steer",
      false,
      { exec: () => VOID_VALUE },
      mkCallDef(
        bag(
          param(CoreParameterId.AnonymousNumber, { name: "x", required: true, anonymous: true }),
          param(CoreParameterId.AnonymousNumber, { name: "y", required: true, anonymous: true })
        )
      )
    );
    steerDef = new BrainTileActuatorDef("test-steer", mkActionDescriptor("actuator", steerFn), {
      metadata: { label: "steer" },
    });
    services.edit.tiles.registerTileDef(steerDef);

    const axisStructTypeId = services.runtime.types.addStructType("AxisReading", {
      atomId: mkTestAtomId(),
      fields: List.from([{ name: "n", typeId: CoreTypeIds.Number, fieldIndex: 0 }]),
    });
    accAxisDef = new BrainTileAccessorDef(axisStructTypeId, "n", CoreTypeIds.Number, { metadata: { label: "n" } });
    services.edit.tiles.registerTileDef(accAxisDef);

    const axisFn = services.runtime.functions.register(
      4371,
      "test-axis-reading",
      false,
      { exec: () => NIL_VALUE },
      mkCallDef(bag())
    );
    axisSensorDef = new BrainTileSensorDef(
      "test-axis-reading",
      mkActionDescriptor("sensor", axisFn, axisStructTypeId),
      {
        placement: TilePlacement.EitherSide | TilePlacement.Inline,
        metadata: { label: "axis reading" },
      }
    );
    services.edit.tiles.registerTileDef(axisSensorDef);

    axisVarDef = new BrainTileVariableDef("test.axisVar", "axis", CoreTypeIds.Number, "var-axis-1");
    services.edit.tiles.registerTileDef(axisVarDef);
  });

  /** True when the tile is offered as an exact or a conversion match. */
  function offered(result: TileSuggestionResult, tileId: string): boolean {
    return (
      resultContains(result, tileId) ||
      listFind(result.withConversion, (s) => s.tileDef.tileId === tileId) !== undefined
    );
  }

  test("literal in the first of two anonymous slots -> second-slot value tiles AND infix operators", () => {
    const numLit = new BrainTileLiteralDef(CoreTypeIds.Number, 7, {}, services);
    const expr = parseTilesForSuggestions(List.from<IBrainTileDef>([steerDef, numLit]));
    assert.equal(expr.kind, "actuator");
    const result = suggestTiles({ ruleSide: RuleSide.Do, expr }, catalogList(), services);

    assert.ok(offered(result, axisVarDef.tileId), "a Number variable should be offered for the second slot");
    assert.ok(
      offered(result, axisSensorDef.tileId),
      "the struct inline sensor should be offered for the second slot (conversion via its Number field)"
    );
    assert.ok(
      resultContains(result, mkOperatorTileId(CoreOpId.Add)),
      "infix operators should extend the first slot's value"
    );
  });

  test("accessor-refined sensor value in the first slot -> second-slot value tiles AND infix operators", () => {
    const expr = parseTilesForSuggestions(List.from<IBrainTileDef>([steerDef, axisSensorDef, accAxisDef]));
    assert.equal(expr.kind, "actuator");
    const result = suggestTiles({ ruleSide: RuleSide.Do, expr }, catalogList(), services);

    assert.ok(offered(result, axisVarDef.tileId), "a Number variable should be offered for the second slot");
    assert.ok(
      offered(result, axisSensorDef.tileId),
      "the struct inline sensor should be offered for the second slot (conversion via its Number field)"
    );
    assert.ok(
      resultContains(result, mkOperatorTileId(CoreOpId.Add)),
      "infix operators should extend the first slot's value"
    );
  });

  test("both anonymous slots filled -> only infix continuation, no value tiles", () => {
    const numLit7 = new BrainTileLiteralDef(CoreTypeIds.Number, 7, {}, services);
    const numLit9 = new BrainTileLiteralDef(CoreTypeIds.Number, 9, {}, services);
    const expr = parseTilesForSuggestions(List.from<IBrainTileDef>([steerDef, numLit7, numLit9]));
    assert.equal(expr.kind, "actuator");
    assert.equal((expr as ActuatorExpr).anons.size(), 2, "the parser fills both anonymous slots");

    const result = suggestTiles({ ruleSide: RuleSide.Do, expr }, catalogList(), services);
    assert.ok(!offered(result, axisVarDef.tileId), "no value tile once every slot is filled");
    assert.ok(
      resultContains(result, mkOperatorTileId(CoreOpId.Add)),
      "infix operators still extend the trailing value"
    );
  });
});

describe("Preceding-sibling consumption", () => {
  // A WHEN-side inline boolean sensor that reads the rule above it, mirroring
  // the `otherwise` tile.
  let siblingReaderDef: BrainTileSensorDef;

  before(() => {
    const fnEntry = services.runtime.functions.register(
      4207,
      "test-preceding-sibling-reader",
      false,
      { exec: () => TRUE_VALUE },
      mkCallDef(bag())
    );
    siblingReaderDef = new BrainTileSensorDef(
      "test-preceding-sibling-reader",
      mkActionDescriptor("sensor", fnEntry, CoreTypeIds.Boolean),
      {
        metadata: { label: "sibling reader" },
        placement: TilePlacement.WhenSide | TilePlacement.Inline,
        capabilities: new BitSet().set(CoreCapabilityBits.RequiresPrecedingSiblingRule),
      }
    );
    services.edit.tiles.registerTileDef(siblingReaderDef);
  });

  function offered(result: TileSuggestionResult, tileId: string): boolean {
    return (
      listFind(result.exact, (s) => s.tileDef.tileId === tileId) !== undefined ||
      listFind(result.withConversion, (s) => s.tileDef.tileId === tileId) !== undefined
    );
  }

  /** A page holding `count` root rules, returned in document order. */
  function rootRules(count: number): BrainRuleDef[] {
    const brainDef = new BrainDef(services);
    const pageResult = brainDef.appendNewPage();
    assert.ok(pageResult.success);
    const page = pageResult.value!.page;
    while (page.children().size() < count) {
      page.appendNewRule();
    }
    const rules: BrainRuleDef[] = [];
    for (let i = 0; i < count; i++) {
      rules.push(page.children().get(i)! as BrainRuleDef);
    }
    return rules;
  }

  test("is not offered in the first root rule, which has no rule above it", () => {
    const [first] = rootRules(2);
    const result = suggestTiles({ ruleSide: RuleSide.When, ruleDef: first }, catalogList(), services);
    assert.ok(!offered(result, siblingReaderDef.tileId));
  });

  test("is offered in the second root rule, which has one", () => {
    const [, second] = rootRules(2);
    const result = suggestTiles({ ruleSide: RuleSide.When, ruleDef: second }, catalogList(), services);
    assert.ok(offered(result, siblingReaderDef.tileId));
  });

  test("is not offered in a first child rule and is offered in the second", () => {
    const [parent] = rootRules(1);
    const firstChild = parent.appendNewRule();
    const secondChild = parent.appendNewRule();
    const firstResult = suggestTiles({ ruleSide: RuleSide.When, ruleDef: firstChild }, catalogList(), services);
    const secondResult = suggestTiles({ ruleSide: RuleSide.When, ruleDef: secondChild }, catalogList(), services);
    assert.ok(!offered(firstResult, siblingReaderDef.tileId), "a first child has no rule above it at its level");
    assert.ok(offered(secondResult, siblingReaderDef.tileId), "a second child reads the child above it");
  });

  test("is not offered when the insertion point names no rule", () => {
    const result = suggestTiles({ ruleSide: RuleSide.When }, catalogList(), services);
    assert.ok(!offered(result, siblingReaderDef.tileId));
  });

  test("is offered as a prefix operator's operand in the second root rule", () => {
    const [, second] = rootRules(2);
    __test__appendTile(second.when(), services.edit.tiles.get(mkOperatorTileId(CoreOpId.Not))!);
    const expr = parseTilesForSuggestions(second.when().tiles());
    const result = suggestTiles({ ruleSide: RuleSide.When, ruleDef: second, expr }, catalogList(), services);
    assert.ok(offered(result, siblingReaderDef.tileId));
  });

  test("is not offered as a prefix operator's operand in the first root rule", () => {
    const [first] = rootRules(2);
    __test__appendTile(first.when(), services.edit.tiles.get(mkOperatorTileId(CoreOpId.Not))!);
    const expr = parseTilesForSuggestions(first.when().tiles());
    const result = suggestTiles({ ruleSide: RuleSide.When, ruleDef: first, expr }, catalogList(), services);
    assert.ok(!offered(result, siblingReaderDef.tileId));
  });

  /** A Boolean literal tile from the core catalog. */
  function booleanLiteral(): IBrainTileDef {
    return services.edit.tiles
      .getAll()
      .toArray()
      .find((t) => t.kind === "literal" && (t as BrainTileLiteralDef).valueType === CoreTypeIds.Boolean)!;
  }

  /**
   * Fills `rule`'s WHEN with `[bool] [and] [bool]` and returns the insert-before
   * context for position 2: the truncated tile list the picker reads for an
   * insertion point is the conjunction's right-operand position.
   */
  function conjunctionRightOperandInsert(rule: BrainRuleDef): InsertionContext {
    const boolLit = booleanLiteral();
    __test__appendTile(rule.when(), boolLit);
    __test__appendTile(rule.when(), services.edit.tiles.get(mkOperatorTileId(CoreOpId.And))!);
    __test__appendTile(rule.when(), boolLit);
    const before = List.from(rule.when().tiles().toArray().slice(0, 2));
    return {
      ruleSide: RuleSide.When,
      ruleDef: rule,
      expr: parseTilesForSuggestions(before),
      unclosedParenDepth: countUnclosedParens(before),
    };
  }

  test("is offered at an insert point inside a WHEN conjunction in the second root rule", () => {
    const [, second] = rootRules(2);
    const result = suggestTiles(conjunctionRightOperandInsert(second), catalogList(), services);
    assert.ok(offered(result, siblingReaderDef.tileId));
  });

  test("is not offered at an insert point inside a WHEN conjunction in the first root rule", () => {
    const [first] = rootRules(2);
    const result = suggestTiles(conjunctionRightOperandInsert(first), catalogList(), services);
    assert.ok(!offered(result, siblingReaderDef.tileId));
  });

  /**
   * A WHEN-side sensor with one required anonymous Boolean slot, so appending
   * after it lands in an anonymous argument position.
   */
  function anonBooleanSlotSensor(): BrainTileSensorDef {
    const registered = services.edit.tiles.get(mkSensorTileId("test-anon-bool-slot"));
    if (registered) return registered as BrainTileSensorDef;
    const fnEntry = services.runtime.functions.register(
      4208,
      "test-anon-bool-slot",
      false,
      { exec: () => TRUE_VALUE },
      mkCallDef(bag(param(CoreParameterId.AnonymousBoolean, { required: true, anonymous: true })))
    );
    const def = new BrainTileSensorDef(
      "test-anon-bool-slot",
      mkActionDescriptor("sensor", fnEntry, CoreTypeIds.Boolean),
      { metadata: { label: "holds" }, placement: TilePlacement.WhenSide }
    );
    services.edit.tiles.registerTileDef(def);
    return def;
  }

  test("is offered in a WHEN-side anonymous Boolean slot in the second root rule", () => {
    const [, second] = rootRules(2);
    __test__appendTile(second.when(), anonBooleanSlotSensor());
    const expr = parseTilesForSuggestions(second.when().tiles());
    const result = suggestTiles({ ruleSide: RuleSide.When, ruleDef: second, expr }, catalogList(), services);
    assert.ok(offered(result, siblingReaderDef.tileId));
  });

  test("is not offered in a WHEN-side anonymous Boolean slot in the first root rule", () => {
    const [first] = rootRules(2);
    __test__appendTile(first.when(), anonBooleanSlotSensor());
    const expr = parseTilesForSuggestions(first.when().tiles());
    const result = suggestTiles({ ruleSide: RuleSide.When, ruleDef: first, expr }, catalogList(), services);
    assert.ok(!offered(result, siblingReaderDef.tileId));
  });
});

describe("Conversion depth in withConversion offerings", () => {
  /** Actuator with one required anonymous String slot, the position under test. */
  let stringSlotActuatorDef: BrainTileActuatorDef;
  /** Variable of a type reaching String only by chaining two registered conversions. */
  let chainedVarDef: BrainTileVariableDef;
  /** Variable of a type reaching String through one registered conversion. */
  let directVarDef: BrainTileVariableDef;

  before(() => {
    const fnEntry = services.runtime.functions.register(
      4401,
      "test-depth-say",
      false,
      { exec: () => VOID_VALUE },
      mkCallDef(bag(param(CoreParameterId.AnonymousString, { required: true, anonymous: true })))
    );
    stringSlotActuatorDef = new BrainTileActuatorDef("test-depth-say", mkActionDescriptor("actuator", fnEntry), {
      metadata: { label: "depth say" },
    });
    services.edit.tiles.registerTileDef(stringSlotActuatorDef);

    // Buffer reaches String only as Buffer -> Number -> String; Number reaches
    // it directly through core's own conversion.
    services.shared.conversions.register({
      id: 4402,
      fromType: CoreTypeIds.Buffer,
      toType: CoreTypeIds.Number,
      cost: 1,
      fn: { exec: () => NIL_VALUE },
    });
    chainedVarDef = new BrainTileVariableDef("test.depthBuf", "buf", CoreTypeIds.Buffer, "var-depth-buf");
    directVarDef = new BrainTileVariableDef("test.depthNum", "num", CoreTypeIds.Number, "var-depth-num");
    services.edit.tiles.registerTileDef(chainedVarDef);
    services.edit.tiles.registerTileDef(directVarDef);
  });

  /** Tile ids offered in the actuator's anonymous String slot, on either list. */
  function slotOffering(): string[] {
    const expr = parseTilesForSuggestions(List.from<IBrainTileDef>([stringSlotActuatorDef]));
    const result = suggestTiles({ ruleSide: RuleSide.Do, expr }, catalogList(), services);
    return [...result.exact.toArray(), ...result.withConversion.toArray()].map((s) => s.tileDef.tileId);
  }

  test("a value reaching the expected type only by chaining two conversions is not offered", () => {
    assert.ok(
      services.shared.conversions.findBestPath(CoreTypeIds.Buffer, CoreTypeIds.String) !== undefined,
      "the chained path exists, so the offering is decided by depth alone"
    );

    assert.ok(!slotOffering().includes(chainedVarDef.tileId));
  });

  test("a value reaching the expected type through one conversion is offered", () => {
    assert.ok(slotOffering().includes(directVarDef.tileId));
  });
});

// ---- Offers and placeability agree ----

describe("a matched parenthesis offers only itself in its own place", () => {
  const openParenId = mkControlFlowTileId(CoreControlFlowId.OpenParen);
  const closeParenId = mkControlFlowTileId(CoreControlFlowId.CloseParen);

  /** Tile ids offered in place of the tile at `index` of `tiles`, on either list. */
  function replacementOffering(tiles: List<IBrainTileDef>, index: number): string[] {
    const context = buildInsertionContext({
      side: RuleSide.When,
      expr: parseTilesForSuggestions(tiles),
      replaceTileIndex: index,
      existingTiles: tiles,
    });
    const result = suggestTiles(context, catalogList(), services);
    return [...result.exact.toArray(), ...result.withConversion.toArray()].map((s) => s.tileDef.tileId);
  }

  /** `( 42 )`, a group both of whose parens the list balances. */
  function balancedGroup(): List<IBrainTileDef> {
    return List.from<IBrainTileDef>([
      services.edit.tiles.get(openParenId)!,
      new BrainTileLiteralDef(CoreTypeIds.Number, 42, {}, services),
      services.edit.tiles.get(closeParenId)!,
    ]);
  }

  test("the open paren of a balanced group offers the open paren and nothing else", () => {
    assert.deepEqual(replacementOffering(balancedGroup(), 0), [openParenId]);
  });

  test("the close paren of a balanced group offers the close paren and nothing else", () => {
    assert.deepEqual(replacementOffering(balancedGroup(), 2), [closeParenId]);
  });

  test("the value inside the group is unaffected and still offers value tiles", () => {
    const offering = replacementOffering(balancedGroup(), 1);

    assert.ok(offering.length > 1);
    assert.ok(!offering.includes(closeParenId));
  });

  test("an open paren the list leaves unmatched keeps the offering its role earns", () => {
    const unbalanced = List.from<IBrainTileDef>([
      services.edit.tiles.get(openParenId)!,
      new BrainTileLiteralDef(CoreTypeIds.Number, 42, {}, services),
    ]);

    assert.notDeepEqual(replacementOffering(unbalanced, 0), [openParenId]);
  });
});

describe("a sensor standing as a binary operand keeps offering its own arguments", () => {
  let operandSensorDef: BrainTileSensorDef;
  let nearModDef: BrainTileModifierDef;
  let farModDef: BrainTileModifierDef;

  before(() => {
    nearModDef = new BrainTileModifierDef("test.operandNear", { metadata: { label: "nearby" } });
    farModDef = new BrainTileModifierDef("test.operandFar", { metadata: { label: "far away" } });
    services.edit.tiles.registerTileDef(nearModDef);
    services.edit.tiles.registerTileDef(farModDef);

    const callDef = mkCallDef(bag(optional(choice(mod("test.operandNear"), mod("test.operandFar")))));
    const entry = services.runtime.functions.register(
      4211,
      "test-operand-sensor",
      false,
      { exec: () => TRUE_VALUE },
      callDef
    );
    operandSensorDef = new BrainTileSensorDef(
      "test-operand-sensor",
      mkActionDescriptor("sensor", entry, CoreTypeIds.Boolean),
      { metadata: { label: "spot" } }
    );
    services.edit.tiles.registerTileDef(operandSensorDef);
  });

  /** Tile ids offered at the end of `[(] [spot] [)] [and] [spot]`, on either list. */
  function offeringAfterOperand(): string[] {
    const tiles = List.from<IBrainTileDef>([
      services.edit.tiles.get(mkControlFlowTileId(CoreControlFlowId.OpenParen))!,
      operandSensorDef,
      services.edit.tiles.get(mkControlFlowTileId(CoreControlFlowId.CloseParen))!,
      services.edit.tiles.get(mkOperatorTileId(CoreOpId.And))!,
      operandSensorDef,
    ]);
    const context = buildInsertionContext({ side: RuleSide.When, existingTiles: tiles });
    assert.equal(context.expr?.kind, "binaryOp", "the side parses to a binary op whose right operand is the sensor");
    const result = suggestTiles(context, catalogList(), services);
    return [...result.exact.toArray(), ...result.withConversion.toArray()].map((s) => s.tileDef.tileId);
  }

  test("the operand sensor's unfilled modifier slots are offered after it", () => {
    const offering = offeringAfterOperand();

    assert.ok(offering.includes(nearModDef.tileId));
    assert.ok(offering.includes(farModDef.tileId));
  });

  test("the infix operators that extend the whole expression are offered as well", () => {
    assert.ok(offeringAfterOperand().includes(mkOperatorTileId(CoreOpId.And)));
  });
});

describe("a struct value is offered into a field-typed slot only when an accessor reads that field", () => {
  let unreadStructTypeId: string;
  let unreadVarDef: BrainTileVariableDef;
  let readStructTypeId: string;
  let readVarDef: BrainTileVariableDef;
  let numberSlotActuatorDef: BrainTileActuatorDef;

  before(() => {
    const fields = List.from([{ name: "count", typeId: CoreTypeIds.Number, fieldIndex: 0 }]);
    unreadStructTypeId = services.runtime.types.addStructType("Unread", { atomId: mkTestAtomId(), fields });
    readStructTypeId = services.runtime.types.addStructType("Read", { atomId: mkTestAtomId(), fields });
    unreadVarDef = new BrainTileVariableDef("test.unreadStruct", "unread", unreadStructTypeId, "var-unread");
    readVarDef = new BrainTileVariableDef("test.readStruct", "read", readStructTypeId, "var-read");
    services.edit.tiles.registerTileDef(unreadVarDef);
    services.edit.tiles.registerTileDef(readVarDef);
    services.edit.tiles.registerTileDef(
      new BrainTileAccessorDef(readStructTypeId, "count", CoreTypeIds.Number, { metadata: { label: "count" } })
    );

    const paramDef = new BrainTileParameterDef("test.numberSlotArg", CoreTypeIds.Number, {
      metadata: { label: "amount" },
    });
    services.edit.tiles.registerTileDef(paramDef);
    const callDef = mkCallDef(bag(param("test.numberSlotArg", { required: true, anonymous: true })));
    const entry = services.runtime.functions.register(
      4212,
      "test-number-slot",
      false,
      { exec: () => VOID_VALUE },
      callDef
    );
    numberSlotActuatorDef = new BrainTileActuatorDef(
      "test-number-slot",
      mkActionDescriptor("actuator", entry, CoreTypeIds.Void),
      { metadata: { label: "count out" } }
    );
    services.edit.tiles.registerTileDef(numberSlotActuatorDef);
  });

  /** Tile ids offered in the actuator's anonymous Number slot, on either list. */
  function slotOffering(): string[] {
    const expr = parseTilesForSuggestions(List.from<IBrainTileDef>([numberSlotActuatorDef]));
    const result = suggestTiles({ ruleSide: RuleSide.Do, expr }, catalogList(), services);
    return [...result.exact.toArray(), ...result.withConversion.toArray()].map((s) => s.tileDef.tileId);
  }

  test("a struct no accessor tile reads is not offered, whatever fields it declares", () => {
    assert.ok(!slotOffering().includes(unreadVarDef.tileId));
  });

  test("a struct an accessor tile reads the slot's type from is offered", () => {
    assert.ok(slotOffering().includes(readVarDef.tileId));
  });
});
