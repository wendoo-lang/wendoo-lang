/**
 * Parser tests -- verifies that the brain tile parser correctly handles
 * action call specs, parentheses, conditionals, field access, and bag
 * repeat interleaving.
 */

import assert from "node:assert/strict";
import { before, describe, test } from "node:test";

import { List } from "@wendoo/core";
import {
  type BrainServices,
  CoreControlFlowId,
  type IBrainTileDef,
  mkVariableTileId,
  TilePlacement,
} from "@wendoo/core/brain";
import { __test__createBrainServices } from "@wendoo/core/brain/__test__";
import type { SensorExpr } from "@wendoo/core/brain/compiler";
import { parseBrainTiles, parseRule, TypeDiagCode, whenResultConsumerEligible } from "@wendoo/core/brain/compiler";
import {
  BrainTileAccessorDef,
  BrainTileActuatorDef,
  BrainTileControlFlowDef,
  BrainTileLiteralDef,
  BrainTileModifierDef,
  BrainTileOperatorDef,
  BrainTileOutputDef,
  BrainTileParameterDef,
  BrainTileSensorDef,
  BrainTileVariableDef,
} from "@wendoo/core/brain/tiles";
import {
  type BrainActionCallSpec,
  bag,
  CoreTypeIds,
  choice,
  mkActionDescriptor,
  mkCallDef,
  mkModifierTileId,
  mkParameterTileId,
  mkTypeId,
  mod,
  NativeType,
  optional,
  param,
  repeated,
  VOID_VALUE,
} from "@wendoo/core/runtime";

// ---- Shared setup ----

let nextTypeAtomId = 20000;

function mkTestAtomId(): number {
  return nextTypeAtomId++;
}

let services: BrainServices;
let everySensor: BrainTileSensorDef;
let modTimeMs: BrainTileModifierDef;
let modTimeSecs: BrainTileModifierDef;
let paramDelayMs: BrainTileParameterDef;
let literal5: BrainTileLiteralDef;
let literal1000: BrainTileLiteralDef;
let literal2: BrainTileLiteralDef;
let literal3: BrainTileLiteralDef;
let literal10: BrainTileLiteralDef;
let opAdd: BrainTileOperatorDef;
let opMultiply: BrainTileOperatorDef;
let opSubtract: BrainTileOperatorDef;
let opAssign: BrainTileOperatorDef;
let openParen: BrainTileControlFlowDef;
let closeParen: BrainTileControlFlowDef;

before(() => {
  services = __test__createBrainServices();

  const kParameterId_AnonymousNumber = "anon.number";
  const kModifierId_TimeMs = "time.ms";
  const kModifierId_TimeSecs = "time.secs";
  const kSensorId_Every = "every";
  const kParameterId_DelayMs = "delay.ms";

  const kEverySensorCallSpec: BrainActionCallSpec = {
    type: "bag",
    items: [
      {
        type: "arg",
        name: "anonNumber",
        tileId: mkParameterTileId(kParameterId_AnonymousNumber),
        required: true,
        anonymous: true,
      },
      {
        type: "conditional",
        condition: "anonNumber",
        then: {
          type: "optional",
          item: {
            type: "choice",
            options: [
              { type: "arg", tileId: mkModifierTileId(kModifierId_TimeMs) },
              { type: "arg", tileId: mkModifierTileId(kModifierId_TimeSecs) },
            ],
          },
        },
      },
      {
        type: "optional",
        item: {
          type: "arg",
          tileId: mkParameterTileId(kParameterId_DelayMs),
        },
      },
    ],
  };

  const everyFnEntry = services.runtime.functions.register(
    4001,
    kSensorId_Every,
    false,
    { exec: () => VOID_VALUE },
    mkCallDef(kEverySensorCallSpec)
  );

  everySensor = new BrainTileSensorDef(kSensorId_Every, mkActionDescriptor("sensor", everyFnEntry, CoreTypeIds.Void));
  modTimeMs = new BrainTileModifierDef(kModifierId_TimeMs);
  modTimeSecs = new BrainTileModifierDef(kModifierId_TimeSecs);
  paramDelayMs = new BrainTileParameterDef(kParameterId_DelayMs, CoreTypeIds.Number);
  literal5 = new BrainTileLiteralDef(CoreTypeIds.Number, 5, {}, services);
  literal1000 = new BrainTileLiteralDef(CoreTypeIds.Number, 1000, {}, services);
  literal2 = new BrainTileLiteralDef(CoreTypeIds.Number, 2, {}, services);
  literal3 = new BrainTileLiteralDef(CoreTypeIds.Number, 3, {}, services);
  literal10 = new BrainTileLiteralDef(CoreTypeIds.Number, 10, {}, services);
  opAdd = new BrainTileOperatorDef("add", {}, services);
  opMultiply = new BrainTileOperatorDef("mul", {}, services);
  opSubtract = new BrainTileOperatorDef("sub", {}, services);
  opAssign = new BrainTileOperatorDef("assign", {}, services);
  openParen = new BrainTileControlFlowDef(CoreControlFlowId.OpenParen);
  closeParen = new BrainTileControlFlowDef(CoreControlFlowId.CloseParen);
});

// ---- Helpers ----

interface TestCase {
  name: string;
  tiles: IBrainTileDef[];
  shouldPass: boolean;
}

function runParseTest(tc: TestCase): void {
  test(tc.name, () => {
    const tiles = List.from(tc.tiles);
    const emptyTiles = List.empty<IBrainTileDef>();
    const result = parseRule(
      tiles,
      emptyTiles,
      List.from([services.edit.tiles]),
      services.shared.conversions,
      services.runtime.types,
      services.app.localizer
    );
    const hasDiags = result.parseResult.diags.size() > 0;

    if (tc.shouldPass) {
      assert.ok(!hasDiags, `Expected no diagnostics but got ${result.parseResult.diags.size()}`);
    } else {
      assert.ok(hasDiags, "Expected diagnostics but got none");
    }
  });
}

// ---- Every sensor call spec tests ----

describe("Every sensor call spec", () => {
  const cases: TestCase[] = [
    { name: "Every [5] - anonymous parameter only", tiles: () => [everySensor, literal5], shouldPass: true } as never,
  ];

  test("Every [5] - anonymous parameter only", () => {
    runParseTest({ name: "Every [5]", tiles: [everySensor, literal5], shouldPass: true });
  });
  test("Every [5] TimeMs - anonymous parameter with child modifier", () => {
    runParseTest({ name: "Every [5] TimeMs", tiles: [everySensor, literal5, modTimeMs], shouldPass: true });
  });
  test("Every [5] TimeSecs - anonymous parameter with different child modifier", () => {
    runParseTest({ name: "Every [5] TimeSecs", tiles: [everySensor, literal5, modTimeSecs], shouldPass: true });
  });
  test("Every TimeMs - child modifier without required parent arg", () => {
    runParseTest({ name: "Every TimeMs", tiles: [everySensor, modTimeMs], shouldPass: false });
  });
  test("Every [5] TimeMs TimeSecs - both child modifiers (should reject second)", () => {
    runParseTest({ name: "both mods", tiles: [everySensor, literal5, modTimeMs, modTimeSecs], shouldPass: false });
  });
  test("Every [5] TimeMs TimeMs - duplicate modifier", () => {
    runParseTest({ name: "dup mod", tiles: [everySensor, literal5, modTimeMs, modTimeMs], shouldPass: false });
  });
  test("Every [5] [5] - duplicate anon parameter", () => {
    runParseTest({ name: "dup anon", tiles: [everySensor, literal5, literal5], shouldPass: false });
  });
  test("Every [5] TimeMs delayMs [1000] - full valid with all args", () => {
    runParseTest({
      name: "full valid",
      tiles: [everySensor, literal5, modTimeMs, paramDelayMs, literal1000],
      shouldPass: true,
    });
  });
  test("Every [5] delayMs [1000] TimeMs - full valid, reordered", () => {
    runParseTest({
      name: "reordered",
      tiles: [everySensor, literal5, paramDelayMs, literal1000, modTimeMs],
      shouldPass: true,
    });
  });
  test("Every delayMs [1000] [5] TimeMs - full valid, reordered v2", () => {
    runParseTest({
      name: "reordered v2",
      tiles: [everySensor, paramDelayMs, literal1000, literal5, modTimeMs],
      shouldPass: true,
    });
  });
  test("Every delayMs [1000] - missing required anonymous parameter", () => {
    runParseTest({
      name: "missing anon",
      tiles: [everySensor, paramDelayMs, literal1000],
      shouldPass: false,
    });
  });
  test("Every - missing required anonymous parameter (empty)", () => {
    runParseTest({ name: "empty", tiles: [everySensor], shouldPass: false });
  });
});

// ---- Parentheses expression tests ----

describe("Parentheses expressions", () => {
  test("Every (5) - parenthesized literal", () => {
    runParseTest({
      name: "(5)",
      tiles: [everySensor, openParen, literal5, closeParen],
      shouldPass: true,
    });
  });
  test("Every (2 + 3) - parenthesized addition", () => {
    runParseTest({
      name: "(2+3)",
      tiles: [everySensor, openParen, literal2, opAdd, literal3, closeParen],
      shouldPass: true,
    });
  });
  test("Every (2 + 3) * 10 - parentheses override precedence", () => {
    runParseTest({
      name: "(2+3)*10",
      tiles: [everySensor, openParen, literal2, opAdd, literal3, closeParen, opMultiply, literal10],
      shouldPass: true,
    });
  });
  test("Every ((2 + 3)) - nested parentheses", () => {
    runParseTest({
      name: "((2+3))",
      tiles: [everySensor, openParen, openParen, literal2, opAdd, literal3, closeParen, closeParen],
      shouldPass: true,
    });
  });
  test("Every 2 * (3 + (5 - 2)) - complex nested parentheses", () => {
    runParseTest({
      name: "2*(3+(5-2))",
      tiles: [
        everySensor,
        literal2,
        opMultiply,
        openParen,
        literal3,
        opAdd,
        openParen,
        literal5,
        opSubtract,
        literal2,
        closeParen,
        closeParen,
      ],
      shouldPass: true,
    });
  });
  test("Every (2 + 3) TimeMs delayMs [1000] - parentheses with modifiers", () => {
    runParseTest({
      name: "(2+3) with mods",
      tiles: [everySensor, openParen, literal2, opAdd, literal3, closeParen, modTimeMs, paramDelayMs, literal1000],
      shouldPass: true,
    });
  });
  test("Every (2 + 3 - missing closing paren", () => {
    runParseTest({
      name: "missing close",
      tiles: [everySensor, openParen, literal2, opAdd, literal3],
      shouldPass: false,
    });
  });
  test("Every 2 + 3) - unmatched closing paren", () => {
    runParseTest({
      name: "unmatched close",
      tiles: [everySensor, literal2, opAdd, literal3, closeParen],
      shouldPass: false,
    });
  });
  test("Every () - empty parentheses", () => {
    runParseTest({
      name: "empty parens",
      tiles: [everySensor, openParen, closeParen],
      shouldPass: false,
    });
  });
  test("Every (2 + (3 - missing inner closing paren", () => {
    runParseTest({
      name: "missing inner close",
      tiles: [everySensor, openParen, literal2, opAdd, openParen, literal3, closeParen],
      shouldPass: false,
    });
  });
  test("Every (+) - operator without operands in parentheses", () => {
    runParseTest({
      name: "(+)",
      tiles: [everySensor, openParen, opAdd, closeParen],
      shouldPass: false,
    });
  });

  test("a group marks the expression it holds with its closure state", () => {
    const closed = parseBrainTiles(
      List.from<IBrainTileDef>([openParen, literal2, opAdd, literal3, closeParen]),
      services.app.localizer
    );
    assert.equal(closed.exprs.get(0).parenGroup, "closed");

    const unclosed = parseBrainTiles(
      List.from<IBrainTileDef>([openParen, literal2, opAdd, literal3]),
      services.app.localizer
    );
    assert.equal(unclosed.exprs.get(0).parenGroup, "unclosed");

    const ungrouped = parseBrainTiles(List.from<IBrainTileDef>([literal2, opAdd, literal3]), services.app.localizer);
    assert.equal(ungrouped.exprs.get(0).parenGroup, undefined);
  });

  test("directly nested groups keep the innermost group's state", () => {
    const outerOpen = parseBrainTiles(
      List.from<IBrainTileDef>([openParen, openParen, literal2, closeParen]),
      services.app.localizer
    );
    assert.equal(outerOpen.exprs.get(0).parenGroup, "closed");
  });

  test("a group inside a call marks the argument, not the call", () => {
    const parsed = parseBrainTiles(
      List.from<IBrainTileDef>([everySensor, openParen, literal2, opAdd, literal3, closeParen]),
      services.app.localizer
    );
    const call = parsed.exprs.get(0);
    assert.equal(call.kind, "sensor");
    assert.equal(call.parenGroup, undefined);
    assert.equal((call as SensorExpr).anons.get(0).expr.parenGroup, "closed");
  });
});

// ---- Parentheses in parameter value tests ----

describe("Parentheses in parameter values", () => {
  test("Every [5] delayMs [(2 + 3)] - parentheses in named parameter value", () => {
    runParseTest({
      name: "parens in param",
      tiles: [everySensor, literal5, paramDelayMs, openParen, literal2, opAdd, literal3, closeParen],
      shouldPass: true,
    });
  });
  test("Every delayMs [(2 + 3) * 10] [5] - complex expression in parameter value", () => {
    runParseTest({
      name: "complex in param",
      tiles: [
        everySensor,
        paramDelayMs,
        openParen,
        literal2,
        opAdd,
        literal3,
        closeParen,
        opMultiply,
        literal10,
        literal5,
      ],
      shouldPass: true,
    });
  });
  test("Every delayMs [((2 + 3))] [10] - nested parentheses in parameter value", () => {
    runParseTest({
      name: "nested in param",
      tiles: [
        everySensor,
        paramDelayMs,
        openParen,
        openParen,
        literal2,
        opAdd,
        literal3,
        closeParen,
        closeParen,
        literal10,
      ],
      shouldPass: true,
    });
  });
  test("Every [2 + 3] delayMs [(5 * 2)] - parentheses in both anon and named", () => {
    runParseTest({
      name: "parens in both",
      tiles: [
        everySensor,
        literal2,
        opAdd,
        literal3,
        paramDelayMs,
        openParen,
        literal5,
        opMultiply,
        literal2,
        closeParen,
      ],
      shouldPass: true,
    });
  });
  test("Every [(2 + 3)] delayMs [10] TimeMs - parens in anon with modifiers", () => {
    runParseTest({
      name: "parens anon + mods",
      tiles: [everySensor, openParen, literal2, opAdd, literal3, closeParen, paramDelayMs, literal10, modTimeMs],
      shouldPass: true,
    });
  });
  test("Every delayMs [2 * (3 + 5)] [(1000)] - nested parens in param", () => {
    runParseTest({
      name: "nested parens mix",
      tiles: [
        everySensor,
        paramDelayMs,
        literal2,
        opMultiply,
        openParen,
        literal3,
        opAdd,
        literal5,
        closeParen,
        openParen,
        literal1000,
        closeParen,
      ],
      shouldPass: true,
    });
  });
  test("Every [5] delayMs [(2 + 3] - missing closing paren in parameter value", () => {
    runParseTest({
      name: "missing close in param",
      tiles: [everySensor, literal5, paramDelayMs, openParen, literal2, opAdd, literal3],
      shouldPass: false,
    });
  });
  test("Every delayMs [2 + 3)] [5] - unmatched closing paren in parameter value", () => {
    runParseTest({
      name: "unmatched close in param",
      tiles: [everySensor, paramDelayMs, literal2, opAdd, literal3, closeParen, literal5],
      shouldPass: false,
    });
  });
  test("Every [(5] delayMs [10] - missing closing paren in anonymous parameter", () => {
    runParseTest({
      name: "missing close in anon",
      tiles: [everySensor, openParen, literal5, paramDelayMs, literal10],
      shouldPass: false,
    });
  });
  test("Every delayMs [()] [5] - empty parentheses in parameter value", () => {
    runParseTest({
      name: "empty parens in param",
      tiles: [everySensor, paramDelayMs, openParen, closeParen, literal5],
      shouldPass: false,
    });
  });
  test("Every [5] delayMs [(2 + (3)] - mismatched nested parens in parameter", () => {
    runParseTest({
      name: "mismatched nested",
      tiles: [everySensor, literal5, paramDelayMs, openParen, literal2, opAdd, openParen, literal3, closeParen],
      shouldPass: false,
    });
  });
});

// ---- Conditional call spec tests ----

describe("Conditional call specs", () => {
  test("Every [5] TimeMs - conditional allows TimeMs when anon present", () => {
    runParseTest({
      name: "cond allows mod",
      tiles: [everySensor, literal5, modTimeMs],
      shouldPass: true,
    });
  });
  test("Every TimeMs [5] - conditional rejects TimeMs before anon", () => {
    runParseTest({
      name: "cond rejects early mod",
      tiles: [everySensor, modTimeMs, literal5],
      shouldPass: false,
    });
  });

  test("ConditionalTest RequiredFirst - just required modifier", () => {
    const kSensorId = "conditional-test";
    const kModRequired = "required-first";
    const kParamOptional = "optional-after";

    const callSpec: BrainActionCallSpec = {
      type: "bag",
      items: [
        { type: "arg", name: "requiredFirstMod", tileId: mkModifierTileId(kModRequired), required: true },
        {
          type: "conditional",
          condition: "requiredFirstMod",
          then: { type: "optional", item: { type: "arg", tileId: mkParameterTileId(kParamOptional) } },
        },
      ],
    };

    const fnEntry = services.runtime.functions.register(
      4002,
      kSensorId,
      false,
      { exec: () => VOID_VALUE },
      mkCallDef(callSpec)
    );

    const sensor = new BrainTileSensorDef(kSensorId, mkActionDescriptor("sensor", fnEntry, CoreTypeIds.Void));
    const modReq = new BrainTileModifierDef(kModRequired);
    const paramOpt = new BrainTileParameterDef(kParamOptional, CoreTypeIds.Number);

    runParseTest({ name: "just required mod", tiles: [sensor, modReq], shouldPass: true });
  });

  test("ConditionalTest RequiredFirst OptionalAfter [100] - modifier enables param", () => {
    const kSensorId = "conditional-test-2";
    const kModRequired = "required-first-2";
    const kParamOptional = "optional-after-2";

    const callSpec: BrainActionCallSpec = {
      type: "bag",
      items: [
        { type: "arg", name: "requiredFirstMod", tileId: mkModifierTileId(kModRequired), required: true },
        {
          type: "conditional",
          condition: "requiredFirstMod",
          then: { type: "optional", item: { type: "arg", tileId: mkParameterTileId(kParamOptional) } },
        },
      ],
    };

    const fnEntry = services.runtime.functions.register(
      4003,
      kSensorId,
      false,
      { exec: () => VOID_VALUE },
      mkCallDef(callSpec)
    );

    const sensor = new BrainTileSensorDef(kSensorId, mkActionDescriptor("sensor", fnEntry, CoreTypeIds.Void));
    const modReq = new BrainTileModifierDef(kModRequired);
    const paramOpt = new BrainTileParameterDef(kParamOptional, CoreTypeIds.Number);

    runParseTest({
      name: "mod enables param",
      tiles: [sensor, modReq, paramOpt, literal1000],
      shouldPass: true,
    });
  });

  test("ConditionalTest OptionalAfter [100] - parameter without required modifier fails", () => {
    const kSensorId = "conditional-test-3";
    const kModRequired = "required-first-3";
    const kParamOptional = "optional-after-3";

    const callSpec: BrainActionCallSpec = {
      type: "bag",
      items: [
        { type: "arg", name: "requiredFirstMod", tileId: mkModifierTileId(kModRequired), required: true },
        {
          type: "conditional",
          condition: "requiredFirstMod",
          then: { type: "optional", item: { type: "arg", tileId: mkParameterTileId(kParamOptional) } },
        },
      ],
    };

    const fnEntry = services.runtime.functions.register(
      4004,
      kSensorId,
      false,
      { exec: () => VOID_VALUE },
      mkCallDef(callSpec)
    );

    const sensor = new BrainTileSensorDef(kSensorId, mkActionDescriptor("sensor", fnEntry, CoreTypeIds.Void));
    const paramOpt = new BrainTileParameterDef(kParamOptional, CoreTypeIds.Number);

    runParseTest({
      name: "param without mod fails",
      tiles: [sensor, paramOpt, literal1000],
      shouldPass: false,
    });
  });

  test("ConditionalTest - missing required modifier", () => {
    const kSensorId = "conditional-test-4";
    const kModRequired = "required-first-4";

    const callSpec: BrainActionCallSpec = {
      type: "bag",
      items: [{ type: "arg", name: "requiredFirstMod", tileId: mkModifierTileId(kModRequired), required: true }],
    };

    const fnEntry = services.runtime.functions.register(
      4005,
      kSensorId,
      false,
      { exec: () => VOID_VALUE },
      mkCallDef(callSpec)
    );

    const sensor = new BrainTileSensorDef(kSensorId, mkActionDescriptor("sensor", fnEntry, CoreTypeIds.Void));

    runParseTest({ name: "missing required mod", tiles: [sensor], shouldPass: false });
  });
});

// ---- Conditional with else branch ----

describe("Conditional with else branch", () => {
  let condElseSensor: BrainTileSensorDef;
  let modToggle: BrainTileModifierDef;
  let paramWhenPresent: BrainTileParameterDef;
  let paramWhenAbsent: BrainTileParameterDef;

  before(() => {
    const kSensorId = "conditional-else-test";
    const kModToggle = "toggle";
    const kParamPresent = "when-present";
    const kParamAbsent = "when-absent";

    const callSpec: BrainActionCallSpec = {
      type: "bag",
      items: [
        { type: "arg", name: "toggleMod", tileId: mkModifierTileId(kModToggle), required: false },
        {
          type: "conditional",
          condition: "toggleMod",
          then: { type: "optional", item: { type: "arg", tileId: mkParameterTileId(kParamPresent) } },
          else: { type: "optional", item: { type: "arg", tileId: mkParameterTileId(kParamAbsent) } },
        },
      ],
    };

    const fnEntry = services.runtime.functions.register(
      4006,
      kSensorId,
      false,
      { exec: () => VOID_VALUE },
      mkCallDef(callSpec)
    );

    condElseSensor = new BrainTileSensorDef(kSensorId, mkActionDescriptor("sensor", fnEntry, CoreTypeIds.Void));
    modToggle = new BrainTileModifierDef(kModToggle);
    paramWhenPresent = new BrainTileParameterDef(kParamPresent, CoreTypeIds.Number);
    paramWhenAbsent = new BrainTileParameterDef(kParamAbsent, CoreTypeIds.Number);
  });

  test("Toggle WhenPresent [5] - toggle present, use then branch", () => {
    runParseTest({
      name: "then branch",
      tiles: [condElseSensor, modToggle, paramWhenPresent, literal5],
      shouldPass: true,
    });
  });
  test("WhenAbsent [5] - no toggle, use else branch", () => {
    runParseTest({
      name: "else branch",
      tiles: [condElseSensor, paramWhenAbsent, literal5],
      shouldPass: true,
    });
  });
  test("Toggle WhenAbsent [5] - toggle present but wrong param", () => {
    runParseTest({
      name: "wrong branch param",
      tiles: [condElseSensor, modToggle, paramWhenAbsent, literal5],
      shouldPass: false,
    });
  });
  test("WhenPresent [5] - no toggle but using then param", () => {
    runParseTest({
      name: "then without toggle",
      tiles: [condElseSensor, paramWhenPresent, literal5],
      shouldPass: false,
    });
  });
  test("Toggle - toggle alone with no optional params", () => {
    runParseTest({ name: "toggle alone", tiles: [condElseSensor, modToggle], shouldPass: true });
  });
  test("Empty - empty call with optional params available from else", () => {
    runParseTest({ name: "empty call", tiles: [condElseSensor], shouldPass: true });
  });
});

// ---- Conditional ordering in bags ----

describe("Conditional ordering in bags", () => {
  test("Every [5] delayMs [1000] - has-param allows delayMs", () => {
    runParseTest({
      name: "has-param",
      tiles: [everySensor, literal5, paramDelayMs, literal1000],
      shouldPass: true,
    });
  });
  test("Every delayMs [1000] [5] TimeMs - bag reorders to satisfy conditional", () => {
    runParseTest({
      name: "bag reorder",
      tiles: [everySensor, paramDelayMs, literal1000, literal5, modTimeMs],
      shouldPass: true,
    });
  });
  test("Every TimeMs delayMs [1000] [5] - TimeMs tried first but fails before anon", () => {
    runParseTest({
      name: "TimeMs before anon",
      tiles: [everySensor, modTimeMs, paramDelayMs, literal1000, literal5],
      shouldPass: false,
    });
  });
});

// ---- Field access (accessor tile) tests ----

describe("Field access (accessor tiles)", () => {
  let varPosition: BrainTileVariableDef;
  let accessorX: BrainTileAccessorDef;
  let accessorY: BrainTileAccessorDef;
  let accessorMag: BrainTileAccessorDef;

  before(() => {
    const vector2TypeId = mkTypeId(NativeType.Struct, "vector2");
    accessorX = new BrainTileAccessorDef(vector2TypeId, "x", CoreTypeIds.Number);
    accessorY = new BrainTileAccessorDef(vector2TypeId, "y", CoreTypeIds.Number);
    accessorMag = new BrainTileAccessorDef(vector2TypeId, "mag", CoreTypeIds.Number, { readOnly: true });
    varPosition = new BrainTileVariableDef(
      mkVariableTileId("my-position"),
      "my_position",
      vector2TypeId,
      "my-position"
    );
  });

  test("[$pos] [x] - simple field access", () => {
    runParseTest({ name: "pos.x", tiles: [varPosition, accessorX], shouldPass: true });
  });
  test("[$pos] [y] - simple field access (y)", () => {
    runParseTest({ name: "pos.y", tiles: [varPosition, accessorY], shouldPass: true });
  });
  test("[$pos] [x] + [5] - field access in arithmetic", () => {
    runParseTest({ name: "pos.x+5", tiles: [varPosition, accessorX, opAdd, literal5], shouldPass: true });
  });
  test("[5] + [$pos] [x] - field access on right side", () => {
    runParseTest({ name: "5+pos.x", tiles: [literal5, opAdd, varPosition, accessorX], shouldPass: true });
  });
  test("[$pos] [x] + [$pos] [y] - two field accesses", () => {
    runParseTest({
      name: "pos.x+pos.y",
      tiles: [varPosition, accessorX, opAdd, varPosition, accessorY],
      shouldPass: true,
    });
  });
  test("[$pos] [x] * [2] + [$pos] [y] - with precedence", () => {
    runParseTest({
      name: "pos.x*2+pos.y",
      tiles: [varPosition, accessorX, opMultiply, literal2, opAdd, varPosition, accessorY],
      shouldPass: true,
    });
  });
  test("([$pos] [x]) - in parentheses", () => {
    runParseTest({
      name: "(pos.x)",
      tiles: [openParen, varPosition, accessorX, closeParen],
      shouldPass: true,
    });
  });
  test("([$pos] [x] + [3]) * [2] - complex parenthesized", () => {
    runParseTest({
      name: "(pos.x+3)*2",
      tiles: [openParen, varPosition, accessorX, opAdd, literal3, closeParen, opMultiply, literal2],
      shouldPass: true,
    });
  });
  test("[$pos] [x] = [10] - field assignment", () => {
    runParseTest({
      name: "pos.x=10",
      tiles: [varPosition, accessorX, opAssign, literal10],
      shouldPass: true,
    });
  });
  test("[$pos] [y] = [5] + [3] - field assignment with expression", () => {
    runParseTest({
      name: "pos.y=5+3",
      tiles: [varPosition, accessorY, opAssign, literal5, opAdd, literal3],
      shouldPass: true,
    });
  });
  test("[x] - accessor without object (bare accessor)", () => {
    runParseTest({ name: "bare x", tiles: [accessorX], shouldPass: false });
  });
  test("[5] [x] - accessor on non-struct literal (parser allows, type checker rejects)", () => {
    runParseTest({ name: "5.x", tiles: [literal5, accessorX], shouldPass: true });
  });
  test("[5] = [10] - assignment to literal", () => {
    runParseTest({ name: "5=10", tiles: [literal5, opAssign, literal10], shouldPass: false });
  });
  test("[$pos] [mag] = [10] - assignment to read-only field", () => {
    runParseTest({
      name: "pos.mag=10",
      tiles: [varPosition, accessorMag, opAssign, literal10],
      shouldPass: false,
    });
  });
});

// ---- Field access AST shape checks ----

describe("Field access AST shape", () => {
  let varPosition: BrainTileVariableDef;
  let accessorX: BrainTileAccessorDef;
  let accessorMag: BrainTileAccessorDef;

  before(() => {
    const vector2TypeId = mkTypeId(NativeType.Struct, "vector2-shape");
    accessorX = new BrainTileAccessorDef(vector2TypeId, "x", CoreTypeIds.Number);
    accessorMag = new BrainTileAccessorDef(vector2TypeId, "mag", CoreTypeIds.Number, { readOnly: true });
    varPosition = new BrainTileVariableDef(
      mkVariableTileId("my-position-shape"),
      "my_position",
      vector2TypeId,
      "my-position-shape"
    );
  });

  test("[$pos] [x] produces fieldAccess node", () => {
    const tiles = List.from<IBrainTileDef>([varPosition, accessorX]);
    const emptyTiles = List.empty<IBrainTileDef>();
    const result = parseRule(
      tiles,
      emptyTiles,
      List.from([services.edit.tiles]),
      services.shared.conversions,
      services.runtime.types,
      services.app.localizer
    );
    const expr = result.parseResult.exprs.get(0);

    assert.equal(expr.kind, "fieldAccess");
    if (expr.kind === "fieldAccess") {
      assert.equal(expr.object.kind, "variable");
      assert.equal(expr.accessor.fieldName, "x");
    }
  });

  test("[$pos] [x] + [5] produces binaryOp(fieldAccess, literal)", () => {
    const tiles = List.from<IBrainTileDef>([varPosition, accessorX, opAdd, literal5]);
    const emptyTiles = List.empty<IBrainTileDef>();
    const result = parseRule(
      tiles,
      emptyTiles,
      List.from([services.edit.tiles]),
      services.shared.conversions,
      services.runtime.types,
      services.app.localizer
    );
    const expr = result.parseResult.exprs.get(0);

    assert.equal(expr.kind, "binaryOp");
    if (expr.kind === "binaryOp") {
      assert.equal(expr.left.kind, "fieldAccess");
      assert.equal(expr.right.kind, "literal");
    }
  });

  test("[$pos] [x] = [10] produces assignment(fieldAccess, literal)", () => {
    const tiles = List.from<IBrainTileDef>([varPosition, accessorX, opAssign, literal10]);
    const emptyTiles = List.empty<IBrainTileDef>();
    const result = parseRule(
      tiles,
      emptyTiles,
      List.from([services.edit.tiles]),
      services.shared.conversions,
      services.runtime.types,
      services.app.localizer
    );
    const expr = result.parseResult.exprs.get(0);

    assert.equal(expr.kind, "assignment");
    if (expr.kind === "assignment") {
      assert.equal(expr.target.kind, "fieldAccess");
      assert.equal(expr.value.kind, "literal");
    }
  });

  test("[$pos] [mag] = [10] produces errorExpr (read-only)", () => {
    const tiles = List.from<IBrainTileDef>([varPosition, accessorMag, opAssign, literal10]);
    const emptyTiles = List.empty<IBrainTileDef>();
    const result = parseRule(
      tiles,
      emptyTiles,
      List.from([services.edit.tiles]),
      services.shared.conversions,
      services.runtime.types,
      services.app.localizer
    );
    const expr = result.parseResult.exprs.get(0);

    assert.equal(expr.kind, "errorExpr");
    assert.ok(result.parseResult.diags.size() > 0, "should have diagnostic for read-only assignment");
    const diag = result.parseResult.diags.get(0);
    assert.equal(diag.code, 1014, "diagnostic code should be ReadOnlyFieldAssignment (1014)");
  });
});

// ---- Assignment target l-value (base-aware) tests ----

describe("Assignment target l-value (read-only sensor result)", () => {
  let accessorX: BrainTileAccessorDef;
  let accessorInner: BrainTileAccessorDef;
  let structVar: BrainTileVariableDef;
  let readOnlySensor: BrainTileSensorDef;
  let writableSensor: BrainTileSensorDef;

  before(() => {
    const outerTypeId = mkTypeId(NativeType.Struct, "lvalue-outer");
    const innerTypeId = mkTypeId(NativeType.Struct, "lvalue-inner");
    accessorX = new BrainTileAccessorDef(innerTypeId, "x", CoreTypeIds.Number);
    accessorInner = new BrainTileAccessorDef(outerTypeId, "inner", innerTypeId);
    structVar = new BrainTileVariableDef(mkVariableTileId("lvalue-var"), "my_struct", innerTypeId, "lvalue-var");

    const roFn = services.runtime.functions.register(
      4901,
      "lvalue-ro-sensor",
      false,
      { exec: () => VOID_VALUE },
      mkCallDef(bag())
    );
    readOnlySensor = new BrainTileSensorDef("lvalue-ro-sensor", mkActionDescriptor("sensor", roFn, innerTypeId), {
      metadata: { label: "stick position" },
      placement: TilePlacement.EitherSide | TilePlacement.Inline,
    });

    const rwFn = services.runtime.functions.register(
      4902,
      "lvalue-rw-sensor",
      false,
      { exec: () => VOID_VALUE },
      mkCallDef(bag())
    );
    writableSensor = new BrainTileSensorDef("lvalue-rw-sensor", mkActionDescriptor("sensor", rwFn, innerTypeId), {
      metadata: { label: "game actor" },
      placement: TilePlacement.EitherSide | TilePlacement.Inline,
      writableResult: true,
    });
  });

  function parse(tiles: IBrainTileDef[]) {
    return parseRule(
      List.from(tiles),
      List.empty<IBrainTileDef>(),
      List.from([services.edit.tiles]),
      services.shared.conversions,
      services.runtime.types,
      services.app.localizer
    ).parseResult;
  }

  test("[sensor] [x] = [10] -> rejected with ReadOnlyResultFieldAssignment (1015)", () => {
    const result = parse([readOnlySensor, accessorX, opAssign, literal10]);
    const expr = result.exprs.get(0);
    assert.equal(expr.kind, "errorExpr");
    assert.ok(result.diags.size() > 0, "should have a diagnostic");
    const diag = result.diags.get(0);
    assert.equal(diag.code, 1015, "diagnostic code should be ReadOnlyResultFieldAssignment (1015)");
    assert.ok(diag.message.indexOf("stick position") >= 0, "message should name the sensor");
    assert.ok(diag.message.indexOf("read-only") >= 0, "message should say the result is read-only");
  });

  test("[writableSensor] [x] = [10] -> accepted (writableResult opt-in)", () => {
    const result = parse([writableSensor, accessorX, opAssign, literal10]);
    const expr = result.exprs.get(0);
    assert.equal(expr.kind, "assignment");
    assert.equal(result.diags.size(), 0, "should have no diagnostics");
  });

  test("[5] [x] = [10] -> rejected (literal base is not an l-value)", () => {
    const result = parse([literal5, accessorX, opAssign, literal10]);
    const expr = result.exprs.get(0);
    assert.equal(expr.kind, "errorExpr");
    const diag = result.diags.get(0);
    assert.equal(diag.code, 1015, "literal base yields ReadOnlyResultFieldAssignment (1015)");
  });

  test("[$struct] [x] = [10] -> accepted (variable base)", () => {
    const result = parse([structVar, accessorX, opAssign, literal10]);
    const expr = result.exprs.get(0);
    assert.equal(expr.kind, "assignment");
    assert.equal(result.diags.size(), 0, "variable base is an l-value");
  });

  test("[sensor] [inner] [x] = [10] -> rejected (recurses through read-only base)", () => {
    const result = parse([readOnlySensor, accessorInner, accessorX, opAssign, literal10]);
    const expr = result.exprs.get(0);
    assert.equal(expr.kind, "errorExpr");
    assert.equal(result.diags.get(0).code, 1015);
  });

  test("[$struct] [inner] [x] = [10] -> accepted (variable root, all writable)", () => {
    const result = parse([structVar, accessorInner, accessorX, opAssign, literal10]);
    const expr = result.exprs.get(0);
    assert.equal(expr.kind, "assignment");
    assert.equal(result.diags.size(), 0);
  });
});

describe("Assignment target l-value (output base)", () => {
  let accessorX: BrainTileAccessorDef;
  let accessorMag: BrainTileAccessorDef;
  let accessorInner: BrainTileAccessorDef;
  let readOnlyOutput: BrainTileOutputDef;
  let writableOutput: BrainTileOutputDef;
  let writableOuterOutput: BrainTileOutputDef;
  let readOnlyOuterOutput: BrainTileOutputDef;

  before(() => {
    const outerTypeId = mkTypeId(NativeType.Struct, "lvalue-out-outer");
    const innerTypeId = mkTypeId(NativeType.Struct, "lvalue-out-inner");
    accessorX = new BrainTileAccessorDef(innerTypeId, "x", CoreTypeIds.Number);
    accessorMag = new BrainTileAccessorDef(innerTypeId, "mag", CoreTypeIds.Number, { readOnly: true });
    accessorInner = new BrainTileAccessorDef(outerTypeId, "inner", innerTypeId);
    readOnlyOutput = new BrainTileOutputDef(innerTypeId, "seen", { metadata: { label: "seen spot" } });
    writableOutput = new BrainTileOutputDef(innerTypeId, "found", {
      metadata: { label: "found spot" },
      writableResult: true,
    });
    writableOuterOutput = new BrainTileOutputDef(outerTypeId, "found", { writableResult: true });
    readOnlyOuterOutput = new BrainTileOutputDef(outerTypeId, "seen");
  });

  function parse(tiles: IBrainTileDef[]) {
    return parseBrainTiles(List.from(tiles), services.app.localizer);
  }

  test("[writableOutput] [x] = [10] -> accepted (writableResult opt-in)", () => {
    const result = parse([writableOutput, accessorX, opAssign, literal10]);
    const expr = result.exprs.get(0);
    assert.equal(expr.kind, "assignment");
    if (expr.kind === "assignment") {
      assert.equal(expr.target.kind, "fieldAccess");
      if (expr.target.kind === "fieldAccess") {
        assert.equal(expr.target.object.kind, "output");
      }
    }
    assert.equal(result.diags.size(), 0, "should have no diagnostics");
  });

  test("[output] [x] = [10] -> rejected with ReadOnlyResultFieldAssignment (1015) naming the output", () => {
    const result = parse([readOnlyOutput, accessorX, opAssign, literal10]);
    const expr = result.exprs.get(0);
    assert.equal(expr.kind, "errorExpr");
    assert.equal(result.diags.size(), 1);
    const diag = result.diags.get(0);
    assert.equal(diag.code, 1015, "diagnostic code should be ReadOnlyResultFieldAssignment (1015)");
    assert.equal(diag.params?.tileId, readOnlyOutput.tileId, "the diagnostic should name the read-only output tile");
  });

  test("[writableOutput] = [10] -> rejected with InvalidAssignmentTarget (1013): the output itself is no target", () => {
    const result = parse([writableOutput, opAssign, literal10]);
    const expr = result.exprs.get(0);
    assert.equal(expr.kind, "errorExpr");
    assert.equal(result.diags.size(), 1);
    assert.equal(result.diags.get(0).code, 1013, "diagnostic code should be InvalidAssignmentTarget (1013)");
  });

  test("[writableOutput] [mag] = [10] -> rejected with ReadOnlyFieldAssignment (1014): the field stays read-only", () => {
    const result = parse([writableOutput, accessorMag, opAssign, literal10]);
    const expr = result.exprs.get(0);
    assert.equal(expr.kind, "errorExpr");
    assert.equal(result.diags.size(), 1);
    assert.equal(result.diags.get(0).code, 1014, "diagnostic code should be ReadOnlyFieldAssignment (1014)");
  });

  test("[writableOuterOutput] [inner] [x] = [10] -> accepted (writable output root, all writable)", () => {
    const result = parse([writableOuterOutput, accessorInner, accessorX, opAssign, literal10]);
    assert.equal(result.exprs.get(0).kind, "assignment");
    assert.equal(result.diags.size(), 0);
  });

  test("[outerOutput] [inner] [x] = [10] -> rejected (recurses through the read-only output base)", () => {
    const result = parse([readOnlyOuterOutput, accessorInner, accessorX, opAssign, literal10]);
    assert.equal(result.exprs.get(0).kind, "errorExpr");
    const diag = result.diags.get(0);
    assert.equal(diag.code, 1015);
    assert.equal(diag.params?.tileId, readOnlyOuterOutput.tileId);
  });
});

describe("Assignment target l-value (literal base)", () => {
  let accessorX: BrainTileAccessorDef;
  let accessorLevel: BrainTileAccessorDef;
  let accessorIndex: BrainTileAccessorDef;
  let accessorInner: BrainTileAccessorDef;
  let accessorRoutedInner: BrainTileAccessorDef;
  let innerLiteral: BrainTileLiteralDef;
  let outerLiteral: BrainTileLiteralDef;

  before(() => {
    const innerTypeId = services.runtime.types.addStructType("LValueLitInner", {
      atomId: mkTestAtomId(),
      fields: List.empty(),
    });
    const outerTypeId = services.runtime.types.addStructType("LValueLitOuter", {
      atomId: mkTestAtomId(),
      fields: List.empty(),
    });
    accessorX = new BrainTileAccessorDef(innerTypeId, "x", CoreTypeIds.Number);
    accessorLevel = new BrainTileAccessorDef(innerTypeId, "level", CoreTypeIds.Number, { routed: true });
    accessorIndex = new BrainTileAccessorDef(innerTypeId, "index", CoreTypeIds.Number, { readOnly: true });
    accessorInner = new BrainTileAccessorDef(outerTypeId, "inner", innerTypeId);
    accessorRoutedInner = new BrainTileAccessorDef(outerTypeId, "routed inner", innerTypeId, { routed: true });
    innerLiteral = new BrainTileLiteralDef(innerTypeId, VOID_VALUE, { valueLabel: "dial one" }, services);
    outerLiteral = new BrainTileLiteralDef(outerTypeId, VOID_VALUE, { valueLabel: "rig one" }, services);
  });

  function parse(tiles: IBrainTileDef[]) {
    return parseBrainTiles(List.from(tiles), services.app.localizer);
  }

  test("[literal] [routed] = [10] -> accepted: the store routes through the type's setter", () => {
    const result = parse([innerLiteral, accessorLevel, opAssign, literal10]);
    assert.equal(result.exprs.get(0).kind, "assignment");
    assert.equal(result.diags.size(), 0);
  });

  test("[literal] [plain] = [10] -> rejected with ReadOnlyResultFieldAssignment (1015) naming the literal", () => {
    const result = parse([innerLiteral, accessorX, opAssign, literal10]);
    assert.equal(result.exprs.get(0).kind, "errorExpr");
    assert.equal(result.diags.size(), 1);
    const diag = result.diags.get(0);
    assert.equal(diag.code, 1015);
    assert.equal(diag.params?.tileId, innerLiteral.tileId, "the diagnostic should name the literal tile");
  });

  test("[literal] [read-only] = [10] -> rejected with ReadOnlyFieldAssignment (1014)", () => {
    const result = parse([innerLiteral, accessorIndex, opAssign, literal10]);
    assert.equal(result.exprs.get(0).kind, "errorExpr");
    assert.equal(result.diags.get(0).code, 1014);
  });

  test("[literal] [plain] [routed] = [10] -> accepted: the terminal field decides", () => {
    const result = parse([outerLiteral, accessorInner, accessorLevel, opAssign, literal10]);
    assert.equal(result.exprs.get(0).kind, "assignment");
    assert.equal(result.diags.size(), 0);
  });

  test("[literal] [routed] [plain] = [10] -> rejected: a routed link above a plain terminal does not admit it", () => {
    const result = parse([outerLiteral, accessorRoutedInner, accessorX, opAssign, literal10]);
    assert.equal(result.exprs.get(0).kind, "errorExpr");
    const diag = result.diags.get(0);
    assert.equal(diag.code, 1015);
    assert.equal(diag.params?.tileId, outerLiteral.tileId);
  });
});

// ---- Bag repeat interleaving tests ----

describe("Bag repeat interleaving", () => {
  test("[act] [slowly] [priority] [1] [slowly] -- interleaved repeat", () => {
    const kActId = "bag-repeat-test";
    const kModSlowly = "bag-repeat.slowly";
    const kModQuickly = "bag-repeat.quickly";
    const kParamPriority = "bag-repeat.priority";

    const callDef = mkCallDef(
      bag(
        optional(choice(repeated(mod(kModSlowly), { max: 3 }), repeated(mod(kModQuickly), { max: 3 }))),
        optional(param(kParamPriority))
      )
    );
    const fnEntry = services.runtime.functions.register(4007, kActId, false, { exec: () => VOID_VALUE }, callDef);
    const actuator = new BrainTileActuatorDef(kActId, mkActionDescriptor("actuator", fnEntry));
    const modSlowly = new BrainTileModifierDef(kModSlowly);
    const paramPriority = new BrainTileParameterDef(kParamPriority, CoreTypeIds.Number);

    const tiles = List.from<IBrainTileDef>([actuator, modSlowly, paramPriority, literal1000, modSlowly]);
    const emptyTiles = List.empty<IBrainTileDef>();
    const result = parseRule(
      emptyTiles,
      tiles,
      List.from([services.edit.tiles]),
      services.shared.conversions,
      services.runtime.types,
      services.app.localizer
    );
    const expr = result.parseResult.exprs.get(0);

    assert.equal(result.parseResult.diags.size(), 0, "should have no diagnostics");
    if (expr.kind === "actuator") {
      assert.equal(expr.modifiers.size(), 2, "2 modifier slots filled");
      assert.equal(expr.parameters.size(), 1, "1 parameter slot filled");
    }
  });

  test("[act] [slowly] [slowly] [priority] [1] -- consecutive repeats", () => {
    const kActId = "bag-repeat-test-2";
    const kModSlowly = "bag-repeat.slowly2";
    const kModQuickly = "bag-repeat.quickly2";
    const kParamPriority = "bag-repeat.priority2";

    const callDef = mkCallDef(
      bag(
        optional(choice(repeated(mod(kModSlowly), { max: 3 }), repeated(mod(kModQuickly), { max: 3 }))),
        optional(param(kParamPriority))
      )
    );
    const fnEntry = services.runtime.functions.register(4008, kActId, false, { exec: () => VOID_VALUE }, callDef);
    const actuator = new BrainTileActuatorDef(kActId, mkActionDescriptor("actuator", fnEntry));
    const modSlowly = new BrainTileModifierDef(kModSlowly);
    const paramPriority = new BrainTileParameterDef(kParamPriority, CoreTypeIds.Number);

    const tiles = List.from<IBrainTileDef>([actuator, modSlowly, modSlowly, paramPriority, literal1000]);
    const emptyTiles = List.empty<IBrainTileDef>();
    const result = parseRule(
      emptyTiles,
      tiles,
      List.from([services.edit.tiles]),
      services.shared.conversions,
      services.runtime.types,
      services.app.localizer
    );

    assert.equal(result.parseResult.diags.size(), 0, "should have no diagnostics");
  });

  test("[act] [slowly] [priority] [1] [slowly] [slowly] -- three repeats interleaved", () => {
    const kActId = "bag-repeat-test-3";
    const kModSlowly = "bag-repeat.slowly3";
    const kModQuickly = "bag-repeat.quickly3";
    const kParamPriority = "bag-repeat.priority3";

    const callDef = mkCallDef(
      bag(
        optional(choice(repeated(mod(kModSlowly), { max: 3 }), repeated(mod(kModQuickly), { max: 3 }))),
        optional(param(kParamPriority))
      )
    );
    const fnEntry = services.runtime.functions.register(4009, kActId, false, { exec: () => VOID_VALUE }, callDef);
    const actuator = new BrainTileActuatorDef(kActId, mkActionDescriptor("actuator", fnEntry));
    const modSlowly = new BrainTileModifierDef(kModSlowly);
    const paramPriority = new BrainTileParameterDef(kParamPriority, CoreTypeIds.Number);

    const tiles = List.from<IBrainTileDef>([actuator, modSlowly, paramPriority, literal1000, modSlowly, modSlowly]);
    const emptyTiles = List.empty<IBrainTileDef>();
    const result = parseRule(
      emptyTiles,
      tiles,
      List.from([services.edit.tiles]),
      services.shared.conversions,
      services.runtime.types,
      services.app.localizer
    );

    assert.equal(result.parseResult.diags.size(), 0, "should have no diagnostics");
  });
});

describe("anonymous choice type discrimination", () => {
  let services: BrainServices;

  before(() => {
    services = __test__createBrainServices();
  });

  test("variable matches correct anonymous type in choice(anon.A, anon.B)", () => {
    const kActId = "type-disc-act";
    const kTypeAlpha = mkTypeId(NativeType.Struct, "Alpha");
    const kTypeBeta = mkTypeId(NativeType.Struct, "Beta");

    const callDef = mkCallDef(
      bag(optional(choice(param("anon.Alpha", { anonymous: true }), param("anon.Beta", { anonymous: true }))))
    );
    const fnEntry = services.runtime.functions.register(4010, kActId, false, { exec: () => VOID_VALUE }, callDef);
    const actuator = new BrainTileActuatorDef(kActId, mkActionDescriptor("actuator", fnEntry));

    services.edit.tiles.registerTileDef(new BrainTileParameterDef("anon.Alpha", kTypeAlpha, { hidden: true }));
    services.edit.tiles.registerTileDef(new BrainTileParameterDef("anon.Beta", kTypeBeta, { hidden: true }));

    const betaVar = new BrainTileVariableDef(mkVariableTileId("betaVar"), "betaVar", kTypeBeta, "unique-beta-1");

    const tiles = List.from<IBrainTileDef>([actuator, betaVar]);
    const emptyTiles = List.empty<IBrainTileDef>();
    const result = parseRule(
      emptyTiles,
      tiles,
      List.from([services.edit.tiles]),
      services.shared.conversions,
      services.runtime.types,
      services.app.localizer
    );

    assert.equal(result.parseResult.diags.size(), 0, "should have no diagnostics");

    const doExprs = result.doParseResult.exprs;
    assert.equal(doExprs.size(), 1, "should have one do expression");
    const doExpr = doExprs.get(0);
    assert.ok(doExpr, "should have a do expression");
    assert.equal(doExpr.kind, "actuator");
    if (doExpr.kind === "actuator") {
      assert.equal(doExpr.anons.size(), 1, "should have one anonymous arg");
      const slotId = doExpr.anons.get(0)!.slotId;
      assert.equal(slotId, 1, "variable with Beta type should match anon.Beta at slot 1, not anon.Alpha at slot 0");
    }
  });

  test("literal matches correct anonymous type in choice(anon.A, anon.B)", () => {
    const kActId = "type-disc-lit";
    const kTypeAlpha = services.runtime.types.addStructType("AlphaLit", {
      atomId: mkTestAtomId(),
      fields: List.empty(),
    });
    const kTypeBeta = services.runtime.types.addStructType("BetaLit", {
      atomId: mkTestAtomId(),
      fields: List.empty(),
    });

    const callDef = mkCallDef(
      bag(optional(choice(param("anon.AlphaLit", { anonymous: true }), param("anon.BetaLit", { anonymous: true }))))
    );
    const fnEntry = services.runtime.functions.register(4011, kActId, false, { exec: () => VOID_VALUE }, callDef);
    const actuator = new BrainTileActuatorDef(kActId, mkActionDescriptor("actuator", fnEntry));

    services.edit.tiles.registerTileDef(new BrainTileParameterDef("anon.AlphaLit", kTypeAlpha, { hidden: true }));
    services.edit.tiles.registerTileDef(new BrainTileParameterDef("anon.BetaLit", kTypeBeta, { hidden: true }));

    const betaLiteral = new BrainTileLiteralDef(kTypeBeta, {}, { valueLabel: "beta-val" }, services);

    const tiles = List.from<IBrainTileDef>([actuator, betaLiteral]);
    const emptyTiles = List.empty<IBrainTileDef>();
    const result = parseRule(
      emptyTiles,
      tiles,
      List.from([services.edit.tiles]),
      services.shared.conversions,
      services.runtime.types,
      services.app.localizer
    );

    assert.equal(result.parseResult.diags.size(), 0, "should have no diagnostics");

    const doExprs = result.doParseResult.exprs;
    assert.equal(doExprs.size(), 1, "should have one do expression");
    const doExpr = doExprs.get(0);
    assert.ok(doExpr, "should have a do expression");
    assert.equal(doExpr.kind, "actuator");
    if (doExpr.kind === "actuator") {
      assert.equal(doExpr.anons.size(), 1, "should have one anonymous arg");
      const slotId = doExpr.anons.get(0)!.slotId;
      assert.equal(
        slotId,
        1,
        "literal with BetaLit type should match anon.BetaLit at slot 1, not anon.AlphaLit at slot 0"
      );
    }
  });
});

// ---- Field id resolution from the object's type ----
//
// An accessor must pair with a base of its own struct type; a mismatched
// pairing is rejected with AccessorBaseTypeMismatch. For a matching pairing,
// the field id and field type resolve during inference from the OBJECT's
// concrete struct type in the live registry -- never from the accessor's
// declared fieldTypeId, which can desync from the registered definition.

describe("Field id resolution from object type", () => {
  let av2Var: BrainTileVariableDef;
  let av3Var: BrainTileVariableDef;
  let numVar: BrainTileVariableDef;
  let entityVar: BrainTileVariableDef;
  let av2AccessorX: BrainTileAccessorDef;
  let av3AccessorX: BrainTileAccessorDef;
  let entityPosAccessorWrongType: BrainTileAccessorDef;

  before(() => {
    const types = services.runtime.types;
    // x is id 0 on Av2 but id 1 on Av3 -- the same field name, different ids.
    const av2 = types.addStructType("Av2Resolve", {
      atomId: mkTestAtomId(),
      fields: List.from([
        { name: "x", typeId: CoreTypeIds.Number, fieldIndex: 0 },
        { name: "y", typeId: CoreTypeIds.Number, fieldIndex: 1 },
      ]),
    });
    const av3 = types.addStructType("Av3Resolve", {
      atomId: mkTestAtomId(),
      fields: List.from([
        { name: "y", typeId: CoreTypeIds.Number, fieldIndex: 0 },
        { name: "x", typeId: CoreTypeIds.Number, fieldIndex: 1 },
        { name: "z", typeId: CoreTypeIds.Number, fieldIndex: 2 },
      ]),
    });
    const entity = types.addStructType("EntityResolve", {
      atomId: mkTestAtomId(),
      fields: List.from([{ name: "pos", typeId: av2, fieldIndex: 0 }]),
    });
    av2Var = new BrainTileVariableDef(mkVariableTileId("av2-resolve"), "av2v", av2, "av2-resolve");
    av3Var = new BrainTileVariableDef(mkVariableTileId("av3-resolve"), "av3v", av3, "av3-resolve");
    numVar = new BrainTileVariableDef(mkVariableTileId("num-resolve"), "numv", CoreTypeIds.Number, "num-resolve");
    entityVar = new BrainTileVariableDef(mkVariableTileId("entity-resolve"), "entv", entity, "entity-resolve");
    av2AccessorX = new BrainTileAccessorDef(av2, "x", CoreTypeIds.Number);
    av3AccessorX = new BrainTileAccessorDef(av3, "x", CoreTypeIds.Number);
    // An Entity.pos accessor whose declared field type is wrong (Av3 rather than
    // the real Av2) -- simulates a stale binding on a nested chain.
    entityPosAccessorWrongType = new BrainTileAccessorDef(entity, "pos", av3);
  });

  function typeDiagCodes(result: ReturnType<typeof parseRule>): number[] {
    const codes: number[] = [];
    for (let i = 0; i < result.typeInfo.diags.size(); i++) {
      codes.push(result.typeInfo.diags.get(i).code as number);
    }
    return codes;
  }

  test("mismatched pairing: an accessor of a different struct type is rejected with no field id", () => {
    for (const [objectVar, accessor] of [
      [av2Var, av3AccessorX],
      [av3Var, av2AccessorX],
      [numVar, av2AccessorX],
    ] as const) {
      const result = parseRule(
        List.from<IBrainTileDef>([objectVar, accessor]),
        List.empty<IBrainTileDef>(),
        List.from([services.edit.tiles]),
        services.shared.conversions,
        services.runtime.types,
        services.app.localizer
      );
      const expr = result.parseResult.exprs.get(0);
      assert.equal(expr.kind, "fieldAccess");
      assert.ok(typeDiagCodes(result).includes(TypeDiagCode.AccessorBaseTypeMismatch));
      assert.equal(result.typeInfo.typeEnv.get(expr.nodeId)?.fieldId, undefined);
    }
  });

  test("nested chain: fields resolve against each object's REAL type, not the accessor's declared field type", () => {
    // entity.pos.x : pos's accessor declares its field type as Av3, but pos's
    // real type is Av2, so the chain pairs and x resolves to Av2.x (0), not
    // Av3.x (1).
    const result = parseRule(
      List.from<IBrainTileDef>([entityVar, entityPosAccessorWrongType, av2AccessorX]),
      List.empty<IBrainTileDef>(),
      List.from([services.edit.tiles]),
      services.shared.conversions,
      services.runtime.types,
      services.app.localizer
    );
    assert.deepEqual(typeDiagCodes(result), []);
    const outer = result.parseResult.exprs.get(0);
    assert.equal(outer.kind, "fieldAccess");
    assert.equal(result.typeInfo.typeEnv.get(outer.nodeId)?.fieldId, 0);
    if (outer.kind === "fieldAccess") {
      // the inner pos access resolved to id 0 as well
      assert.equal(result.typeInfo.typeEnv.get(outer.object.nodeId)?.fieldId, 0);
    }
  });

  test("unregistered struct type: field id is undefined (emitter falls back to the name-keyed path)", () => {
    const phantomTypeId = mkTypeId(NativeType.Struct, "PhantomResolve");
    const phantomVar = new BrainTileVariableDef(
      mkVariableTileId("phantom-resolve"),
      "phv",
      phantomTypeId,
      "phantom-resolve"
    );
    const phantomAccessorX = new BrainTileAccessorDef(phantomTypeId, "x", CoreTypeIds.Number);
    const result = parseRule(
      List.from<IBrainTileDef>([phantomVar, phantomAccessorX]),
      List.empty<IBrainTileDef>(),
      List.from([services.edit.tiles]),
      services.shared.conversions,
      services.runtime.types,
      services.app.localizer
    );
    assert.deepEqual(typeDiagCodes(result), []);
    const expr = result.parseResult.exprs.get(0);
    assert.equal(expr.kind, "fieldAccess");
    assert.equal(result.typeInfo.typeEnv.get(expr.nodeId)?.fieldId, undefined);
  });
});

// ---- Continuation after a complete non-inline sensor ----

describe("Continuation after a complete non-inline sensor", () => {
  let plainStructSensor: BrainTileSensorDef;
  let inlineStructSensor: BrainTileSensorDef;
  let accessorF: BrainTileAccessorDef;

  before(() => {
    const structTypeId = services.runtime.types.addStructType("SensorReadingCont", {
      atomId: mkTestAtomId(),
      fields: List.from([{ name: "f", typeId: CoreTypeIds.Number, fieldIndex: 0 }]),
    });
    accessorF = new BrainTileAccessorDef(structTypeId, "f", CoreTypeIds.Number);

    const plainFnEntry = services.runtime.functions.register(
      4020,
      "reading-cont-plain",
      false,
      { exec: () => VOID_VALUE },
      mkCallDef(bag())
    );
    plainStructSensor = new BrainTileSensorDef(
      "reading-cont-plain",
      mkActionDescriptor("sensor", plainFnEntry, structTypeId)
    );

    const inlineFnEntry = services.runtime.functions.register(
      4021,
      "reading-cont-inline",
      false,
      { exec: () => VOID_VALUE },
      mkCallDef(bag())
    );
    inlineStructSensor = new BrainTileSensorDef(
      "reading-cont-inline",
      mkActionDescriptor("sensor", inlineFnEntry, structTypeId),
      { placement: TilePlacement.EitherSide | TilePlacement.Inline }
    );
  });

  test("[plain sensor] [f] - accessor cannot follow a non-inline sensor at top level", () => {
    runParseTest({ name: "plain.f", tiles: [plainStructSensor, accessorF], shouldPass: false });
  });

  test("[plain sensor] [+] [5] - infix operator cannot follow a non-inline sensor at top level", () => {
    runParseTest({ name: "plain+5", tiles: [plainStructSensor, opAdd, literal5], shouldPass: false });
  });

  test("[inline sensor] [f] - accessor follows an inline sensor", () => {
    runParseTest({ name: "inline.f", tiles: [inlineStructSensor, accessorF], shouldPass: true });
  });

  test("[inline sensor] [f] [+] [5] - infix operator follows an inline sensor's field access", () => {
    runParseTest({ name: "inline.f+5", tiles: [inlineStructSensor, accessorF, opAdd, literal5], shouldPass: true });
  });
});

// ---- WHEN-result consumer eligibility ----

describe("WHEN-result consumer eligibility", () => {
  // Isolated services: the conversion registered below is visible only to these tests.
  let isolated: BrainServices;
  let stringConsumer: BrainTileSensorDef;

  before(() => {
    isolated = __test__createBrainServices();
    const fnEntry = isolated.runtime.functions.register(
      4030,
      "when-result-string-consumer",
      false,
      { exec: () => VOID_VALUE },
      mkCallDef(bag())
    );
    stringConsumer = new BrainTileSensorDef(
      "when-result-string-consumer",
      mkActionDescriptor("sensor", fnEntry, CoreTypeIds.Boolean),
      { consumesWhenResult: CoreTypeIds.String }
    );
    // Buffer reaches String only as Buffer -> Number -> String.
    isolated.shared.conversions.register({
      id: 4031,
      fromType: CoreTypeIds.Buffer,
      toType: CoreTypeIds.Number,
      cost: 1,
      fn: { exec: () => VOID_VALUE },
    });
  });

  test("a WHEN result one conversion from the required type is eligible", () => {
    assert.ok(whenResultConsumerEligible(stringConsumer, CoreTypeIds.Number, isolated.shared.conversions));
  });

  test("a WHEN result reaching the required type only through two conversions is not eligible", () => {
    assert.equal(isolated.shared.conversions.get(CoreTypeIds.Buffer, CoreTypeIds.String), undefined);
    assert.notEqual(
      isolated.shared.conversions.findBestPath(CoreTypeIds.Buffer, CoreTypeIds.String),
      undefined,
      "an unbounded search reaches String through Number"
    );

    assert.ok(!whenResultConsumerEligible(stringConsumer, CoreTypeIds.Buffer, isolated.shared.conversions));
  });
});
