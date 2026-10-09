import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { List, runtime } from "@wendoo/core";
import type { BrainServices } from "@wendoo/core/brain";
import { __test__createBrainServices } from "@wendoo/core/brain/__test__";
import type { ExecutionContext, Scheduler } from "@wendoo/core/runtime";
import {
  HandleTable,
  isStructValue,
  type MapValue,
  mkClosedStructValue,
  mkNativeStructValue,
  mkNumberValue,
  mkTypeId,
  NativeType,
  NIL_VALUE,
  type NumberValue,
  type StructTypeDef,
  type StructValue,
  type Value,
  ValueDict,
  VmStatus,
} from "@wendoo/core/runtime";
import { __test__createPlatformServices } from "@wendoo/core/runtime/__test__";
import { TEST_PROJECT_NAMESPACE } from "../testing/index.js";
import { buildAmbientDeclarations } from "./ambient.js";
import { compileUserTile } from "./compile.js";
import { CompileDiagCode, LoweringDiagCode } from "./diag-codes.js";

let services: BrainServices;

let nextTypeAtomId = 1024;
function mkTestAtomId(): number {
  return nextTypeAtomId++;
}

function toVmServices(b: BrainServices) {
  return __test__createPlatformServices({ runtime: { functions: b.runtime.functions, types: b.runtime.types } })
    .runtime;
}

function mkCtx(): ExecutionContext {
  return {
    services: __test__createPlatformServices(),
    getVariableBySlot: () => NIL_VALUE,
    setVariableBySlot: () => {},
    getSystemVarBySlot: () => NIL_VALUE,
    setSystemVarBySlot: () => {},
    time: 0,
    dt: 0,
    currentTick: 0,
  };
}

function mkScheduler(): Scheduler {
  return {
    onHandleCompleted: () => {},
    enqueueRunnable: () => {},
    getFiber: () => undefined,
  };
}

function getStructField(source: StructValue, fieldName: string): Value | undefined {
  const def = services.runtime.types.get(source.typeId) as StructTypeDef | undefined;
  const fieldIndex = def?.fieldIndexByName.get(fieldName);
  return fieldIndex === undefined ? undefined : source.v?.at(fieldIndex);
}

function assertNumberField(source: StructValue, fieldName: string, expected: number): void {
  const value = getStructField(source, fieldName);
  assert.ok(value && value.t === NativeType.Number, `expected numeric field '${fieldName}'`);
  assert.equal((value as NumberValue).v, expected);
}

describe("struct field assignment", () => {
  before(() => {
    services = __test__createBrainServices();

    const types = services.runtime.types;
    const numTypeId = mkTypeId(NativeType.Number, "number");

    const vec2TypeId = mkTypeId(NativeType.Struct, "Vector2");
    if (!types.get(vec2TypeId)) {
      types.addStructType("Vector2", {
        atomId: mkTestAtomId(),
        fields: List.from([
          { name: "x", typeId: numTypeId, fieldIndex: 0 },
          { name: "y", typeId: numTypeId, fieldIndex: 1 },
        ]),
      });
    }

    const entityTypeId = mkTypeId(NativeType.Struct, "Entity");
    if (!types.get(entityTypeId)) {
      types.addStructType("Entity", {
        atomId: mkTestAtomId(),
        fields: List.from([
          { name: "position", typeId: vec2TypeId, fieldIndex: 0 },
          { name: "health", typeId: numTypeId, fieldIndex: 1 },
        ]),
      });
    }
  });

  test("simple field assignment on a plain struct", () => {
    const ambientSource = buildAmbientDeclarations(services.runtime.types);
    const source = `
import { Sensor, type Context, type Vector2 } from "wendoo";

export default Sensor({
  name: "set-field",
  onExecute(ctx: Context): number {
    const v: Vector2 = { x: 1, y: 2 };
    v.x = 10;
    return v.x;
  },
});
`;
    const result = compileUserTile(source, {
      projectNamespace: TEST_PROJECT_NAMESPACE,
      ambientFiles: [{ path: "ambient.d.ts", content: ambientSource }],
      services,
    });
    assert.deepStrictEqual(result.diagnostics, [], `Unexpected diagnostics: ${JSON.stringify(result.diagnostics)}`);
    assert.ok(result.program);

    const prog = result.program!;
    const handles = new HandleTable(100);
    const vm = new runtime.VM(prog, toVmServices(services), { handles });
    const fiber = vm.spawnFiber(1, 0, List.empty<Value>(), mkCtx());
    fiber.instrBudget = 1000;

    const runResult = vm.runFiber(fiber, mkScheduler());
    assert.equal(runResult.status, VmStatus.DONE);
    assert.ok(runResult.result);
    assert.equal((runResult.result as NumberValue).v, 10);
  });

  test("field assignment on a nested struct field", () => {
    const ambientSource = buildAmbientDeclarations(services.runtime.types);
    const source = `
import { Sensor, type Context, type Entity, type Vector2 } from "wendoo";

export default Sensor({
  name: "set-nested",
  onExecute(ctx: Context): number {
    const e: Entity = { position: { x: 0, y: 0 }, health: 50 };
    e.health = 99;
    return e.health;
  },
});
`;
    const result = compileUserTile(source, {
      projectNamespace: TEST_PROJECT_NAMESPACE,
      ambientFiles: [{ path: "ambient.d.ts", content: ambientSource }],
      services,
    });
    assert.deepStrictEqual(result.diagnostics, [], `Unexpected diagnostics: ${JSON.stringify(result.diagnostics)}`);
    assert.ok(result.program);

    const prog = result.program!;
    const handles = new HandleTable(100);
    const vm = new runtime.VM(prog, toVmServices(services), { handles });
    const fiber = vm.spawnFiber(1, 0, List.empty<Value>(), mkCtx());
    fiber.instrBudget = 1000;

    const runResult = vm.runFiber(fiber, mkScheduler());
    assert.equal(runResult.status, VmStatus.DONE);
    assert.ok(runResult.result);
    assert.equal((runResult.result as NumberValue).v, 99);
  });

  test("struct field assignment to another struct value", () => {
    const ambientSource = buildAmbientDeclarations(services.runtime.types);
    const source = `
import { Sensor, type Context, type Entity, type Vector2 } from "wendoo";

export default Sensor({
  name: "set-struct-field",
  onExecute(ctx: Context): Vector2 {
    const e: Entity = { position: { x: 1, y: 2 }, health: 10 };
    e.position = { x: 30, y: 40 };
    return e.position;
  },
});
`;
    const result = compileUserTile(source, {
      projectNamespace: TEST_PROJECT_NAMESPACE,
      ambientFiles: [{ path: "ambient.d.ts", content: ambientSource }],
      services,
    });
    assert.deepStrictEqual(result.diagnostics, [], `Unexpected diagnostics: ${JSON.stringify(result.diagnostics)}`);
    assert.ok(result.program);

    const prog = result.program!;
    const handles = new HandleTable(100);
    const vm = new runtime.VM(prog, toVmServices(services), { handles });
    const fiber = vm.spawnFiber(1, 0, List.empty<Value>(), mkCtx());
    fiber.instrBudget = 1000;

    const runResult = vm.runFiber(fiber, mkScheduler());
    assert.equal(runResult.status, VmStatus.DONE);
    assert.ok(runResult.result);
    assert.ok(isStructValue(runResult.result!));
    const pos = runResult.result as StructValue;
    assertNumberField(pos, "x", 30);
    assertNumberField(pos, "y", 40);
  });
});

describe("struct field assignment with fieldSetter", () => {
  let setterCalls: Array<{ field: number; value: Value }>;

  before(() => {
    services = __test__createBrainServices();
    setterCalls = [];

    const types = services.runtime.types;
    const numTypeId = mkTypeId(NativeType.Number, "number");

    const nativeTypeId = mkTypeId(NativeType.Struct, "NativeWidget");
    if (!types.get(nativeTypeId)) {
      types.addStructType("NativeWidget", {
        atomId: mkTestAtomId(),
        fields: List.from([
          { name: "value", typeId: numTypeId, fieldIndex: 0 },
          { name: "id", typeId: numTypeId, readOnly: true, fieldIndex: 1 },
        ]),
        // Field ids: value=0, id=1.
        fieldGetter: (source, fieldId) => {
          const data = source.native as { value: number; id: number };
          if (fieldId === 0) return mkNumberValue(data.value);
          if (fieldId === 1) return mkNumberValue(data.id);
          return undefined;
        },
        fieldSetter: (source, fieldId, val) => {
          if (fieldId === 0) {
            (source.native as { value: number }).value = (val as NumberValue).v;
            setterCalls.push({ field: fieldId, value: val });
            return true;
          }
          return false;
        },
      });
    }
  });

  test("assignment triggers fieldSetter on a native-backed struct", () => {
    setterCalls = [];
    const ambientSource = buildAmbientDeclarations(services.runtime.types);
    const source = `
import { Sensor, param, type Context, type NativeWidget } from "wendoo";

export default Sensor({
  name: "native-set",
  args: [
    param("w", { type: "NativeWidget" }),
  ],
  onExecute(ctx: Context, args: { w: NativeWidget }): number {
    args.w.value = 42;
    return args.w.value;
  },
});
`;
    const result = compileUserTile(source, {
      projectNamespace: TEST_PROJECT_NAMESPACE,
      ambientFiles: [{ path: "ambient.d.ts", content: ambientSource }],
      services,
    });
    assert.deepStrictEqual(result.diagnostics, [], `Unexpected diagnostics: ${JSON.stringify(result.diagnostics)}`);
    assert.ok(result.program);

    const prog = result.program!;
    const handles = new HandleTable(100);
    const vm = new runtime.VM(prog, toVmServices(services), { handles });
    const ctx = mkCtx();

    const nativeWidget = mkNativeStructValue(mkTypeId(NativeType.Struct, "NativeWidget"), { value: 0, id: 7 });
    const args = List.from<Value>([nativeWidget]);
    const fiber = vm.spawnFiber(1, 0, args, ctx);
    fiber.instrBudget = 1000;

    const runResult = vm.runFiber(fiber, mkScheduler());
    assert.equal(runResult.status, VmStatus.DONE);
    assert.ok(runResult.result);
    assert.equal((runResult.result as NumberValue).v, 42);
    assert.equal(setterCalls.length, 1);
    assert.equal(setterCalls[0].field, 0);
  });
});

describe("struct field assignment diagnostics", () => {
  before(() => {
    services = __test__createBrainServices();

    const types = services.runtime.types;
    const numTypeId = mkTypeId(NativeType.Number, "number");

    const readOnlyTypeId = mkTypeId(NativeType.Struct, "Sensor_ReadOnly");
    if (!types.get(readOnlyTypeId)) {
      types.addStructType("Sensor_ReadOnly", {
        atomId: mkTestAtomId(),
        fields: List.from([
          { name: "value", typeId: numTypeId, readOnly: true, fieldIndex: 0 },
          { name: "mutable", typeId: numTypeId, fieldIndex: 1 },
        ]),
        fieldGetter: () => mkNumberValue(0),
      });
    }
  });

  test("assigning to a readOnly field produces a diagnostic", () => {
    const ambientSource = buildAmbientDeclarations(services.runtime.types);
    const source = `
import { Sensor, param, type Context, type Sensor_ReadOnly } from "wendoo";

export default Sensor({
  name: "ro-assign",
  args: [
    param("s", { type: "Sensor_ReadOnly" }),
  ],
  onExecute(ctx: Context, args: { s: Sensor_ReadOnly }): number {
    args.s.value = 5;
    return 0;
  },
});
`;
    const result = compileUserTile(source, {
      projectNamespace: TEST_PROJECT_NAMESPACE,
      ambientFiles: [{ path: "ambient.d.ts", content: ambientSource }],
      services,
    });
    assert.ok(result.diagnostics.length > 0, "Expected a diagnostic");
    assert.ok(
      result.diagnostics.some(
        (d) => d.code === CompileDiagCode.TypeScriptError || d.code === LoweringDiagCode.ReadOnlyFieldAssignment
      ),
      `Expected readonly assignment error, got: ${JSON.stringify(result.diagnostics)}`
    );
  });

  test("assigning to a writable field on a struct with readOnly fields compiles without error", () => {
    const ambientSource = buildAmbientDeclarations(services.runtime.types);
    const source = `
import { Sensor, param, type Context, type Sensor_ReadOnly } from "wendoo";

export default Sensor({
  name: "mutable-assign",
  args: [
    param("s", { type: "Sensor_ReadOnly" }),
  ],
  onExecute(ctx: Context, args: { s: Sensor_ReadOnly }): number {
    args.s.mutable = 7;
    return args.s.mutable;
  },
});
`;
    const result = compileUserTile(source, {
      projectNamespace: TEST_PROJECT_NAMESPACE,
      ambientFiles: [{ path: "ambient.d.ts", content: ambientSource }],
      services,
    });
    assert.deepStrictEqual(result.diagnostics, [], `Unexpected diagnostics: ${JSON.stringify(result.diagnostics)}`);
    assert.ok(result.program);
  });
});

describe("struct field compound assignment", () => {
  before(() => {
    services = __test__createBrainServices();

    const types = services.runtime.types;
    const numTypeId = mkTypeId(NativeType.Number, "number");

    const vec2TypeId = mkTypeId(NativeType.Struct, "Vector2");
    if (!types.get(vec2TypeId)) {
      types.addStructType("Vector2", {
        atomId: mkTestAtomId(),
        fields: List.from([
          { name: "x", typeId: numTypeId, fieldIndex: 0 },
          { name: "y", typeId: numTypeId, fieldIndex: 1 },
        ]),
      });
    }
  });

  test("compound += on a struct field", () => {
    const ambientSource = buildAmbientDeclarations(services.runtime.types);
    const source = `
import { Sensor, type Context, type Vector2 } from "wendoo";

export default Sensor({
  name: "compound-field",
  onExecute(ctx: Context): number {
    const v: Vector2 = { x: 10, y: 20 };
    v.x += 5;
    return v.x;
  },
});
`;
    const result = compileUserTile(source, {
      projectNamespace: TEST_PROJECT_NAMESPACE,
      ambientFiles: [{ path: "ambient.d.ts", content: ambientSource }],
      services,
    });
    assert.deepStrictEqual(result.diagnostics, [], `Unexpected diagnostics: ${JSON.stringify(result.diagnostics)}`);
    assert.ok(result.program);

    const prog = result.program!;
    const handles = new HandleTable(100);
    const vm = new runtime.VM(prog, toVmServices(services), { handles });
    const fiber = vm.spawnFiber(1, 0, List.empty<Value>(), mkCtx());
    fiber.instrBudget = 1000;

    const runResult = vm.runFiber(fiber, mkScheduler());
    assert.equal(runResult.status, VmStatus.DONE);
    assert.ok(runResult.result);
    assert.equal((runResult.result as NumberValue).v, 15);
  });

  test("compound -= on a struct field", () => {
    const ambientSource = buildAmbientDeclarations(services.runtime.types);
    const source = `
import { Sensor, type Context, type Vector2 } from "wendoo";

export default Sensor({
  name: "compound-sub",
  onExecute(ctx: Context): number {
    const v: Vector2 = { x: 10, y: 20 };
    v.y -= 8;
    return v.y;
  },
});
`;
    const result = compileUserTile(source, {
      projectNamespace: TEST_PROJECT_NAMESPACE,
      ambientFiles: [{ path: "ambient.d.ts", content: ambientSource }],
      services,
    });
    assert.deepStrictEqual(result.diagnostics, [], `Unexpected diagnostics: ${JSON.stringify(result.diagnostics)}`);
    assert.ok(result.program);

    const prog = result.program!;
    const handles = new HandleTable(100);
    const vm = new runtime.VM(prog, toVmServices(services), { handles });
    const fiber = vm.spawnFiber(1, 0, List.empty<Value>(), mkCtx());
    fiber.instrBudget = 1000;

    const runResult = vm.runFiber(fiber, mkScheduler());
    assert.equal(runResult.status, VmStatus.DONE);
    assert.ok(runResult.result);
    assert.equal((runResult.result as NumberValue).v, 12);
  });

  test("compound *= on a struct field", () => {
    const ambientSource = buildAmbientDeclarations(services.runtime.types);
    const source = `
import { Sensor, type Context, type Vector2 } from "wendoo";

export default Sensor({
  name: "compound-mul",
  onExecute(ctx: Context): number {
    const v: Vector2 = { x: 3, y: 4 };
    v.x *= 7;
    return v.x;
  },
});
`;
    const result = compileUserTile(source, {
      projectNamespace: TEST_PROJECT_NAMESPACE,
      ambientFiles: [{ path: "ambient.d.ts", content: ambientSource }],
      services,
    });
    assert.deepStrictEqual(result.diagnostics, [], `Unexpected diagnostics: ${JSON.stringify(result.diagnostics)}`);
    assert.ok(result.program);

    const prog = result.program!;
    const handles = new HandleTable(100);
    const vm = new runtime.VM(prog, toVmServices(services), { handles });
    const fiber = vm.spawnFiber(1, 0, List.empty<Value>(), mkCtx());
    fiber.instrBudget = 1000;

    const runResult = vm.runFiber(fiber, mkScheduler());
    assert.equal(runResult.status, VmStatus.DONE);
    assert.ok(runResult.result);
    assert.equal((runResult.result as NumberValue).v, 21);
  });
});

describe("struct field assignment integration", () => {
  let nativeState: { hp: number; armor: number; x: number; y: number };

  before(() => {
    services = __test__createBrainServices();

    const types = services.runtime.types;
    const numTypeId = mkTypeId(NativeType.Number, "number");

    const vec2TypeId = mkTypeId(NativeType.Struct, "Vector2");
    if (!types.get(vec2TypeId)) {
      types.addStructType("Vector2", {
        atomId: mkTestAtomId(),
        fields: List.from([
          { name: "x", typeId: numTypeId, fieldIndex: 0 },
          { name: "y", typeId: numTypeId, fieldIndex: 1 },
        ]),
      });
    }

    const unitTypeId = mkTypeId(NativeType.Struct, "Unit");
    if (!types.get(unitTypeId)) {
      types.addStructType("Unit", {
        atomId: mkTestAtomId(),
        fields: List.from([
          { name: "hp", typeId: numTypeId, fieldIndex: 0 },
          { name: "armor", typeId: numTypeId, readOnly: true, fieldIndex: 1 },
          { name: "x", typeId: numTypeId, fieldIndex: 2 },
          { name: "y", typeId: numTypeId, fieldIndex: 3 },
        ]),
        // Field ids: hp=0, armor=1 (read-only), x=2, y=3.
        fieldGetter: (source, fieldId) => {
          const data = source.native as typeof nativeState;
          if (fieldId === 0) return mkNumberValue(data.hp);
          if (fieldId === 1) return mkNumberValue(data.armor);
          if (fieldId === 2) return mkNumberValue(data.x);
          if (fieldId === 3) return mkNumberValue(data.y);
          return undefined;
        },
        fieldSetter: (source, fieldId, val) => {
          const data = source.native as typeof nativeState;
          const n = (val as NumberValue).v;
          if (fieldId === 0) {
            data.hp = n;
            return true;
          }
          if (fieldId === 2) {
            data.x = n;
            return true;
          }
          if (fieldId === 3) {
            data.y = n;
            return true;
          }
          return false;
        },
      });
    }
  });

  test("param struct field reads, writes, compound ops, conditionals, loop, and struct return", () => {
    nativeState = { hp: 100, armor: 5, x: 0, y: 0 };

    const ambientSource = buildAmbientDeclarations(services.runtime.types);
    const source = `
import { Sensor, param, type Context, type Unit, type Vector2 } from "wendoo";

export default Sensor({
  name: "integration",
  args: [
    param("unit", { type: "Unit" }),
    param("damage", { type: "number" }),
    param("steps", { type: "number" }),
  ],
  onExecute(ctx: Context, args: { unit: Unit; damage: number; steps: number }): Vector2 {
    const u = args.unit;

    // apply damage reduced by armor: hp -= max(damage - armor, 1)
    let effectiveDamage = args.damage - u.armor;
    if (effectiveDamage < 1) {
      effectiveDamage = 1;
    }
    u.hp -= effectiveDamage;

    // move diagonally for 'steps' iterations
    let i = 0;
    while (i < args.steps) {
      u.x += 3;
      u.y += 2;
      i += 1;
    }

    // if hp dropped below 50, halve remaining hp
    if (u.hp < 50) {
      u.hp = u.hp / 2;
    }

    // return final position as a plain struct
    const result: Vector2 = { x: u.x, y: u.y };
    return result;
  },
});
`;
    const result = compileUserTile(source, {
      projectNamespace: TEST_PROJECT_NAMESPACE,
      ambientFiles: [{ path: "ambient.d.ts", content: ambientSource }],
      services,
    });
    assert.deepStrictEqual(result.diagnostics, [], `Unexpected diagnostics: ${JSON.stringify(result.diagnostics)}`);
    assert.ok(result.program);

    const prog = result.program!;
    const handles = new HandleTable(100);
    const vm = new runtime.VM(prog, toVmServices(services), { handles });
    const ctx = mkCtx();

    const unitStruct = mkNativeStructValue(mkTypeId(NativeType.Struct, "Unit"), nativeState);
    const args = List.from<Value>([unitStruct, mkNumberValue(60), mkNumberValue(4)]);
    const fiber = vm.spawnFiber(1, 0, args, ctx);
    fiber.instrBudget = 2000;

    const runResult = vm.runFiber(fiber, mkScheduler());
    assert.equal(runResult.status, VmStatus.DONE);
    assert.ok(runResult.result);

    // damage = 60, armor = 5, effective = 55, hp: 100 - 55 = 45
    // 45 < 50, so hp = 45 / 2 = 22.5
    assert.equal(nativeState.hp, 22.5);

    // 4 steps: x += 3 each -> 12, y += 2 each -> 8
    assert.equal(nativeState.x, 12);
    assert.equal(nativeState.y, 8);

    // returned Vector2 should match final position
    assert.ok(isStructValue(runResult.result!));
    const pos = runResult.result as StructValue;
    assertNumberField(pos, "x", 12);
    assertNumberField(pos, "y", 8);
  });
});

describe("struct field assignment through a member chain writes back every link", () => {
  let owner: { x: number; y: number };
  let posWrites: number;

  before(() => {
    services = __test__createBrainServices();
    owner = { x: 0, y: 0 };
    posWrites = 0;

    const types = services.runtime.types;
    const numTypeId = mkTypeId(NativeType.Number, "number");

    const vec2TypeId = mkTypeId(NativeType.Struct, "Vector2");
    if (!types.get(vec2TypeId)) {
      types.addStructType("Vector2", {
        atomId: mkTestAtomId(),
        fields: List.from([
          { name: "x", typeId: numTypeId, fieldIndex: 0 },
          { name: "y", typeId: numTypeId, fieldIndex: 1 },
        ]),
      });
    }
    const snapshot = (x: number, y: number): Value =>
      mkClosedStructValue(vec2TypeId, List.from<Value>([mkNumberValue(x), mkNumberValue(y)]));

    if (!types.get(mkTypeId(NativeType.Struct, "Mover"))) {
      types.addStructType("Mover", {
        atomId: mkTestAtomId(),
        fields: List.from([
          { name: "pos", typeId: vec2TypeId, fieldIndex: 0 },
          { name: "facing", typeId: vec2TypeId, readOnly: true, fieldIndex: 1 },
        ]),
        // Field ids: pos=0 (a fresh snapshot per read), facing=1 (read-only).
        fieldGetter: (source, fieldId) => {
          const data = source.native as typeof owner;
          if (fieldId === 0) return snapshot(data.x, data.y);
          if (fieldId === 1) return snapshot(1, 0);
          return undefined;
        },
        fieldSetter: (source, fieldId, val) => {
          if (fieldId !== 0 || !isStructValue(val)) return false;
          const data = source.native as typeof owner;
          data.x = (getStructField(val, "x") as NumberValue).v;
          data.y = (getStructField(val, "y") as NumberValue).v;
          posWrites++;
          return true;
        },
      });
    }

    const segmentTypeId = mkTypeId(NativeType.Struct, "Segment");
    if (!types.get(segmentTypeId)) {
      types.addStructType("Segment", {
        atomId: mkTestAtomId(),
        fields: List.from([
          { name: "from", typeId: vec2TypeId, fieldIndex: 0 },
          { name: "to", typeId: vec2TypeId, fieldIndex: 1 },
        ]),
      });
    }
    if (!types.get(mkTypeId(NativeType.Struct, "Route"))) {
      types.addStructType("Route", {
        atomId: mkTestAtomId(),
        fields: List.from([{ name: "leg", typeId: segmentTypeId, fieldIndex: 0 }]),
      });
    }
  });

  function compileAndRun(source: string, args: Value[]): { result: Value | undefined; diagnostics: unknown[] } {
    const ambientSource = buildAmbientDeclarations(services.runtime.types);
    const compiled = compileUserTile(source, {
      projectNamespace: TEST_PROJECT_NAMESPACE,
      ambientFiles: [{ path: "ambient.d.ts", content: ambientSource }],
      services,
    });
    if (!compiled.program) {
      return { result: undefined, diagnostics: compiled.diagnostics };
    }
    const vm = new runtime.VM(compiled.program, toVmServices(services), { handles: new HandleTable(100) });
    const fiber = vm.spawnFiber(1, 0, List.from<Value>(args), mkCtx());
    fiber.instrBudget = 2000;
    const runResult = vm.runFiber(fiber, mkScheduler());
    assert.equal(runResult.status, VmStatus.DONE);
    return { result: runResult.result, diagnostics: compiled.diagnostics };
  }

  function mover(): Value {
    return mkNativeStructValue(mkTypeId(NativeType.Struct, "Mover"), owner);
  }

  test("a field write through a getter's snapshot reaches the host through the setter", () => {
    owner.x = 1;
    owner.y = 2;
    posWrites = 0;
    const { result, diagnostics } = compileAndRun(
      `
import { Sensor, param, type Context, type Mover } from "wendoo";

export default Sensor({
  name: "chain-set",
  args: [param("m", { type: "Mover" })],
  onExecute(ctx: Context, args: { m: Mover }): number {
    args.m.pos.x = 42;
    return args.m.pos.x;
  },
});
`,
      [mover()]
    );
    assert.deepStrictEqual(diagnostics, []);
    assert.equal((result as NumberValue).v, 42);
    assert.deepEqual({ x: owner.x, y: owner.y, writes: posWrites }, { x: 42, y: 2, writes: 1 });
  });

  test("a compound write through a getter's snapshot reaches the host through the setter", () => {
    owner.x = 1;
    owner.y = 2;
    posWrites = 0;
    const { result, diagnostics } = compileAndRun(
      `
import { Sensor, param, type Context, type Mover } from "wendoo";

export default Sensor({
  name: "chain-compound",
  args: [param("m", { type: "Mover" })],
  onExecute(ctx: Context, args: { m: Mover }): number {
    args.m.pos.y += 5;
    return args.m.pos.y;
  },
});
`,
      [mover()]
    );
    assert.deepStrictEqual(diagnostics, []);
    assert.equal((result as NumberValue).v, 7);
    assert.deepEqual({ x: owner.x, y: owner.y, writes: posWrites }, { x: 1, y: 7, writes: 1 });
  });

  test("a depth-three chain of plain struct fields stores in place", () => {
    const { result, diagnostics } = compileAndRun(
      `
import { Sensor, type Context, type Route } from "wendoo";

export default Sensor({
  name: "chain-plain",
  onExecute(ctx: Context): number {
    const r: Route = { leg: { from: { x: 0, y: 0 }, to: { x: 3, y: 4 } } };
    r.leg.from.x = 9;
    return r.leg.from.x + r.leg.to.x;
  },
});
`,
      []
    );
    assert.deepStrictEqual(diagnostics, []);
    assert.equal((result as NumberValue).v, 12);
  });

  test("a write through a read-only field of a hooked struct is refused", () => {
    const { diagnostics } = compileAndRun(
      `
import { Sensor, param, type Context, type Mover } from "wendoo";

export default Sensor({
  name: "chain-read-only",
  args: [param("m", { type: "Mover" })],
  onExecute(ctx: Context, args: { m: Mover }): number {
    args.m.facing.x = 5;
    return 0;
  },
});
`,
      [mover()]
    );
    assert.ok(
      (diagnostics as { code: number }[]).some((d) => d.code === LoweringDiagCode.ReadOnlyFieldAssignment),
      `Expected a read-only diagnostic, got: ${JSON.stringify(diagnostics)}`
    );
  });

  test("a field write through a getter's snapshot yields the stored value", () => {
    owner.x = 1;
    owner.y = 2;
    posWrites = 0;
    const { result, diagnostics } = compileAndRun(
      `
import { Sensor, param, type Context, type Mover } from "wendoo";

export default Sensor({
  name: "chain-set-value",
  args: [param("m", { type: "Mover" })],
  onExecute(ctx: Context, args: { m: Mover }): number {
    const stored = (args.m.pos.x = 42);
    return stored;
  },
});
`,
      [mover()]
    );
    assert.deepStrictEqual(diagnostics, []);
    assert.equal((result as NumberValue).v, 42);
    assert.deepEqual({ x: owner.x, y: owner.y, writes: posWrites }, { x: 42, y: 2, writes: 1 });
  });

  test("a compound write through a getter's snapshot yields the stored value", () => {
    owner.x = 1;
    owner.y = 2;
    posWrites = 0;
    const { result, diagnostics } = compileAndRun(
      `
import { Sensor, param, type Context, type Mover } from "wendoo";

export default Sensor({
  name: "chain-compound-value",
  args: [param("m", { type: "Mover" })],
  onExecute(ctx: Context, args: { m: Mover }): number {
    const stored = (args.m.pos.y += 5);
    return stored;
  },
});
`,
      [mover()]
    );
    assert.deepStrictEqual(diagnostics, []);
    assert.equal((result as NumberValue).v, 7);
    assert.deepEqual({ x: owner.x, y: owner.y, writes: posWrites }, { x: 1, y: 7, writes: 1 });
  });

  test("statement-position writes through a getter's snapshot store and write back once each", () => {
    owner.x = 1;
    owner.y = 2;
    posWrites = 0;
    const { result, diagnostics } = compileAndRun(
      `
import { Sensor, param, type Context, type Mover } from "wendoo";

export default Sensor({
  name: "chain-statement",
  args: [param("m", { type: "Mover" })],
  onExecute(ctx: Context, args: { m: Mover }): number {
    for (let i = 0; i < 3; i++) {
      args.m.pos.x = i;
      args.m.pos.y += 1;
    }
    return args.m.pos.x * 10 + args.m.pos.y;
  },
});
`,
      [mover()]
    );
    assert.deepStrictEqual(diagnostics, []);
    assert.equal((result as NumberValue).v, 25);
    assert.deepEqual({ x: owner.x, y: owner.y, writes: posWrites }, { x: 2, y: 5, writes: 6 });
  });

  /**
   * Compiles a sensor taking one `Mover` argument whose `onExecute` body is `body`, runs it against the shared
   * `owner` reset to (1, 2), and returns its number result. Fails the test on any diagnostic.
   */
  function runMoverBody(body: string): number {
    owner.x = 1;
    owner.y = 2;
    posWrites = 0;
    const { result, diagnostics } = compileAndRun(
      `
import { Sensor, param, type Context, type Mover, type Vector2 } from "wendoo";

export default Sensor({
  name: "chain-wrapped",
  args: [param("m", { type: "Mover" })],
  onExecute(ctx: Context, args: { m: Mover }): number {
${body}
  },
});
`,
      [mover()]
    );
    assert.deepStrictEqual(diagnostics, []);
    return (result as NumberValue).v;
  }

  const wrappedLinks: ReadonlyArray<readonly [string, string]> = [
    ["a parenthesized", "(args.m.pos)"],
    ["a double-parenthesized", "((args.m.pos))"],
    ["an as-cast", "(args.m.pos as Vector2)"],
    ["a non-null asserted", "args.m.pos!"],
    ["a parenthesized optional", "(args.m?.pos)"],
    ["an as-cast optional", "(args.m?.pos as Vector2)"],
    ["a non-null asserted parenthesized optional", "(args.m?.pos)!"],
  ];

  for (const [label, link] of wrappedLinks) {
    test(`= through ${label} hooked link writes back once and yields the stored value`, () => {
      assert.equal(runMoverBody(`const stored = (${link}.x = 42);\nreturn stored * 1000 + args.m.pos.x;`), 42042);
      assert.deepEqual({ x: owner.x, y: owner.y, writes: posWrites }, { x: 42, y: 2, writes: 1 });
    });

    test(`+= through ${label} hooked link writes back once and yields the stored value`, () => {
      assert.equal(runMoverBody(`const stored = (${link}.y += 5);\nreturn stored * 1000 + args.m.pos.y;`), 7007);
      assert.deepEqual({ x: owner.x, y: owner.y, writes: posWrites }, { x: 1, y: 7, writes: 1 });
    });

    test(`statement-position writes through ${label} hooked link write back once each`, () => {
      assert.equal(runMoverBody(`${link}.x = 42;\n${link}.y += 5;\nreturn args.m.pos.x * 10 + args.m.pos.y;`), 427);
      assert.deepEqual({ x: owner.x, y: owner.y, writes: posWrites }, { x: 42, y: 7, writes: 2 });
    });
  }

  test("writes through a parenthesized optional link on a narrowed nullable root write back once each", () => {
    assert.equal(
      runMoverBody(
        "const m: Mover | undefined = args.m;\nif (m) {\n  (m?.pos).x = 42;\n  const stored = ((m?.pos).y += 5);\n  return stored * 1000 + m.pos.x;\n}\nreturn 0;"
      ),
      7042
    );
    assert.deepEqual({ x: owner.x, y: owner.y, writes: posWrites }, { x: 42, y: 7, writes: 2 });
  });

  test("a write through a wrapped read-only field of a hooked struct is refused", () => {
    const { diagnostics } = compileAndRun(
      `
import { Sensor, param, type Context, type Mover, type Vector2 } from "wendoo";

export default Sensor({
  name: "chain-wrapped-read-only",
  args: [param("m", { type: "Mover" })],
  onExecute(ctx: Context, args: { m: Mover }): number {
    (args.m.facing as Vector2).x = 5;
    return 0;
  },
});
`,
      [mover()]
    );
    assert.ok(
      (diagnostics as { code: number }[]).some((d) => d.code === LoweringDiagCode.ReadOnlyFieldAssignment),
      `Expected a read-only diagnostic, got: ${JSON.stringify(diagnostics)}`
    );
  });

  test("a parenthesized optional link over a nil root faults like the unwrapped chain", () => {
    const statuses = ["(args.m?.pos).x = 42;", "args.m.pos.x = 42;"].map((statement) => {
      const compiled = compileUserTile(
        `
import { Sensor, param, type Context, type Mover } from "wendoo";

export default Sensor({
  name: "chain-nil-root",
  args: [param("m", { type: "Mover" })],
  onExecute(ctx: Context, args: { m: Mover }): number {
    ${statement}
    return 0;
  },
});
`,
        {
          projectNamespace: TEST_PROJECT_NAMESPACE,
          ambientFiles: [{ path: "ambient.d.ts", content: buildAmbientDeclarations(services.runtime.types) }],
          services,
        }
      );
      assert.deepStrictEqual(compiled.diagnostics, []);
      const vm = new runtime.VM(compiled.program!, toVmServices(services), { handles: new HandleTable(100) });
      const fiber = vm.spawnFiber(1, 0, List.from<Value>([NIL_VALUE]), mkCtx());
      fiber.instrBudget = 2000;
      return vm.runFiber(fiber, mkScheduler()).status;
    });
    assert.deepEqual(statuses, [VmStatus.FAULT, VmStatus.FAULT]);
  });

  test("writes through wrapped plain links store in place and yield the stored value", () => {
    const { result, diagnostics } = compileAndRun(
      `
import { Sensor, type Context, type Route, type Segment } from "wendoo";

export default Sensor({
  name: "chain-plain-wrapped",
  onExecute(ctx: Context): number {
    const r: Route = { leg: { from: { x: 0, y: 0 }, to: { x: 3, y: 4 } } };
    (r.leg.from).x = 1;
    const a = ((r.leg as Segment).to.x += 2);
    const b = (r.leg!.from.y = 6);
    return a * 1000 + b * 100 + r.leg.from.x * 10 + r.leg.to.x + r.leg.from.y;
  },
});
`,
      []
    );
    assert.deepStrictEqual(diagnostics, []);
    assert.equal((result as NumberValue).v, 5621);
  });
});

describe("a field assignment's value is the value it stored", () => {
  before(() => {
    services = __test__createBrainServices();

    const types = services.runtime.types;
    const numTypeId = mkTypeId(NativeType.Number, "number");

    const vec2TypeId = mkTypeId(NativeType.Struct, "Vector2");
    if (!types.get(vec2TypeId)) {
      types.addStructType("Vector2", {
        atomId: mkTestAtomId(),
        fields: List.from([
          { name: "x", typeId: numTypeId, fieldIndex: 0 },
          { name: "y", typeId: numTypeId, fieldIndex: 1 },
        ]),
      });
    }
  });

  /**
   * Compiles and runs a sensor whose `onExecute` body is `body` (after `prelude` at module level) and returns its
   * number result. Fails the test on any diagnostic or a run that does not finish.
   */
  function runNumber(body: string, prelude = ""): number {
    const ambientSource = buildAmbientDeclarations(services.runtime.types);
    const source = `
import { Sensor, type Context, type Vector2 } from "wendoo";
${prelude}
export default Sensor({
  name: "assignment-value",
  onExecute(ctx: Context): number {
${body}
  },
});
`;
    const compiled = compileUserTile(source, {
      projectNamespace: TEST_PROJECT_NAMESPACE,
      ambientFiles: [{ path: "ambient.d.ts", content: ambientSource }],
      services,
    });
    assert.deepStrictEqual(compiled.diagnostics, [], `Unexpected diagnostics: ${JSON.stringify(compiled.diagnostics)}`);
    assert.ok(compiled.program);
    const vm = new runtime.VM(compiled.program!, toVmServices(services), { handles: new HandleTable(100) });
    const fiber = vm.spawnFiber(1, 0, List.empty<Value>(), mkCtx());
    fiber.instrBudget = 2000;
    const runResult = vm.runFiber(fiber, mkScheduler());
    assert.equal(runResult.status, VmStatus.DONE);
    assert.ok(runResult.result && runResult.result.t === NativeType.Number, "expected a number result");
    return (runResult.result as NumberValue).v;
  }

  test("= on a struct field yields the stored value", () => {
    assert.equal(
      runNumber("const v: Vector2 = { x: 1, y: 2 };\nconst stored = (v.x = 5);\nreturn stored * 10 + v.x;"),
      55
    );
  });

  test("+= on a struct field yields the stored value", () => {
    assert.equal(
      runNumber("const v: Vector2 = { x: 1, y: 2 };\nconst stored = (v.x += 3);\nreturn stored * 10 + v.x;"),
      44
    );
  });

  test("a chained field assignment stores the value in every target", () => {
    assert.equal(
      runNumber(
        "const a: Vector2 = { x: 1, y: 2 };\nconst b: Vector2 = { x: 1, y: 2 };\na.x = b.x = 9;\nreturn a.x * 10 + b.x;"
      ),
      99
    );
  });

  test("= and += on a class instance field yield the stored value", () => {
    assert.equal(
      runNumber(
        "const c = new Counter();\nconst set = (c.n = 7);\nconst added = (c.n += 2);\nreturn set * 100 + added * 10 + c.n - 9;",
        "class Counter { n = 0; }"
      ),
      790
    );
  });

  test("= and += on this.field in a method yield the stored value", () => {
    assert.equal(
      runNumber(
        "return new Counter().run();",
        "class Counter {\n  n = 0;\n  run(): number {\n    const set = (this.n = 7);\n    const added = (this.n += 2);\n    return set * 100 + added * 10 + this.n - 9;\n  }\n}"
      ),
      790
    );
  });

  test("a write through a class getter mutates the getter's result and never calls the setter", () => {
    const prelude = `
class Holder {
  gets = 0;
  sets = 0;
  inner: Vector2 = { x: 1, y: 2 };
  get p(): Vector2 {
    this.gets += 1;
    return this.inner;
  }
  set p(v: Vector2) {
    this.sets += 1;
    this.inner = v;
  }
}`;
    assert.equal(
      runNumber("const h = new Holder();\nh.p.x = 5;\nreturn h.inner.x * 100 + h.gets * 10 + h.sets;", prelude),
      510
    );
  });

  describe("on an element", () => {
    test("= on a list element yields the stored value", () => {
      assert.equal(
        runNumber("const arr: number[] = [1, 2];\nconst stored = (arr[0] = 7);\nreturn stored * 10 + arr[0];"),
        77
      );
    });

    test("+= on a list element yields the stored value", () => {
      assert.equal(
        runNumber("const arr: number[] = [1, 2];\nconst stored = (arr[1] += 3);\nreturn stored * 10 + arr[1];"),
        55
      );
    });

    test("= on a map entry yields the stored value", () => {
      assert.equal(
        runNumber('const o: { [k: string]: number } = {};\nconst stored = (o["k"] = 7);\nreturn stored * 10 + o["k"];'),
        77
      );
    });

    test("+= on a map entry yields the stored value", () => {
      assert.equal(
        runNumber(
          'const o: { [k: string]: number } = {};\no["k"] = 2;\nconst stored = (o["k"] += 3);\nreturn stored * 10 + o["k"];'
        ),
        55
      );
    });

    test("a chained element assignment stores the value in every target", () => {
      assert.equal(
        runNumber(
          'const arr: number[] = [1, 2];\nconst o: { [k: string]: number } = {};\narr[0] = o["k"] = arr[1] = 9;\nreturn arr[0] * 100 + o["k"] * 10 + arr[1];'
        ),
        999
      );
    });

    test("statement-position element writes store once each", () => {
      assert.equal(
        runNumber(
          'const arr: number[] = [0, 0];\nconst o: { [k: string]: number } = {};\no["k"] = 0;\nfor (let i = 0; i < 3; i++) {\n  arr[0] = i;\n  arr[1] += 2;\n  o["k"] += 1;\n}\nreturn arr[0] * 100 + arr[1] * 10 + o["k"];'
        ),
        263
      );
    });
  });
});
