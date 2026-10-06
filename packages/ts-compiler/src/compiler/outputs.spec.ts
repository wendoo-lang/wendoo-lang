import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { type BrainServices, mkAccessorTileId, mkOperatorTileId, mkVariableTileId } from "@wendoo/core/brain";
import { __test__appendTile, __test__createBrainServices } from "@wendoo/core/brain/__test__";
import { BrainDef, type BrainRuleDef } from "@wendoo/core/brain/model";
import { BrainTileLiteralDef, type BrainTileOutputDef, BrainTileVariableDef } from "@wendoo/core/brain/tiles";
import { CoreOpId, CoreTypeIds, extractNumberValue, mkOutputTileId, mkOutputVarKey } from "@wendoo/core/runtime";
import { buildCompiledActionBundle } from "../runtime/action-bundle.js";
import { registerUserTile } from "../runtime/registration-bridge.js";
import { buildUserTileMetadata } from "../runtime/user-tile-metadata.js";
import { TEST_PROJECT_NAMESPACE } from "../testing/index.js";
import { expectDiagnostic } from "../testsupport/diag-coverage.js";
import { buildAmbientDeclarations } from "./ambient.js";
import { DescriptorDiagCode, LoweringDiagCode } from "./diag-codes.js";
import { UserTileProject } from "./project.js";
import { scopedOutputName } from "./symbol-keys.js";

let services: BrainServices;

function compileProject(files: Record<string, string>) {
  const ambientSource = buildAmbientDeclarations(services.runtime.types);
  const project = new UserTileProject({
    projectNamespace: TEST_PROJECT_NAMESPACE,
    ambientFiles: [{ path: "ambient.d.ts", content: ambientSource }],
    services,
  });
  project.setFiles(new Map(Object.entries(files)));
  return project.compileAll();
}

/** A sensor that declares the given `outputs` array text and writes them in `onExecute`. */
function sensorSource(id: string, name: string, outputs: string, body: string): string {
  return `
import { Sensor, setOutput, type Context } from "wendoo";

export default Sensor({
  id: "${id}",
  name: "${name}",
  outputs: ${outputs},
  onExecute(ctx: Context): number {
${body}
    return 1;
  },
});
`;
}

describe("sensor output extraction", () => {
  before(() => {
    services = __test__createBrainServices();
  });

  test("a valid outputs array is carried onto the compiled program", () => {
    const result = compileProject({
      "rx.ts": sensorSource(
        "snrx",
        "rx",
        `[{ name: "value", type: "string" }, { name: "rssi", type: "number", label: "signal strength" }]`,
        `    setOutput(ctx, "value", "hi");\n    setOutput(ctx, "rssi", 7);`
      ),
    });
    const entry = result.results.get("rx.ts");
    assert.ok(entry?.program, "expected a compiled program");
    assert.deepEqual(entry.program.outputs, [
      { name: "value", type: "string", label: undefined, icon: undefined, docs: undefined, tags: undefined },
      { name: "rssi", type: "number", label: "signal strength", icon: undefined, docs: undefined, tags: undefined },
    ]);
  });

  test("a non-array outputs value is diagnosed", () => {
    const result = compileProject({
      "bad.ts": sensorSource("snbad", "bad", `"nope" as any`, ``),
    });
    const entry = result.results.get("bad.ts");
    assert.ok(entry);
    assert.ok(entry.diagnostics.some((d) => d.code === DescriptorDiagCode.OutputsMustBeArrayLiteral));
  });

  test("a non-string-literal output type is diagnosed", () => {
    const result = compileProject({
      "bad.ts": sensorSource("snbad", "bad", `[{ name: "value", type: ("num" + "ber") as any }]`, ``),
    });
    const entry = result.results.get("bad.ts");
    assert.ok(entry);
    assert.ok(entry.diagnostics.some((d) => d.code === DescriptorDiagCode.OutputTypeMustBeStringLiteral));
  });

  test("a non-string-literal output name is diagnosed", () => {
    const result = compileProject({
      "bad.ts": sensorSource("snbad", "bad", `[{ name: ("v" + "1") as any, type: "number" }]`, ``),
    });
    const entry = result.results.get("bad.ts");
    assert.ok(entry);
    assert.ok(entry.diagnostics.some((d) => d.code === DescriptorDiagCode.OutputNameMustBeStringLiteral));
  });

  test("two outputs sharing a name on one sensor are diagnosed", () => {
    const result = compileProject({
      "bad.ts": sensorSource(
        "snbad",
        "bad",
        `[{ name: "value", type: "number" }, { name: "value", type: "string" }]`,
        ``
      ),
    });
    const entry = result.results.get("bad.ts");
    assert.ok(entry);
    assert.ok(entry.diagnostics.some((d) => d.code === DescriptorDiagCode.DuplicateOutputName));
  });
});

describe("setOutput lowering", () => {
  before(() => {
    services = __test__createBrainServices();
  });

  test("setOutput to a declared output compiles without diagnostics", () => {
    const result = compileProject({
      "rx.ts": sensorSource("snrx", "rx", `[{ name: "value", type: "string" }]`, `    setOutput(ctx, "value", "hi");`),
    });
    const entry = result.results.get("rx.ts");
    assert.ok(entry?.program, "expected a compiled program");
    assert.deepEqual(entry.diagnostics, [], JSON.stringify(entry.diagnostics));
  });

  test("setOutput naming an undeclared output is diagnosed", () => {
    const result = compileProject({
      "rx.ts": sensorSource(
        "snrx",
        "rx",
        `[{ name: "value", type: "string" }]`,
        `    setOutput(ctx, "missing", "hi");`
      ),
    });
    const entry = result.results.get("rx.ts");
    assert.ok(entry);
    expectDiagnostic(entry.diagnostics, LoweringDiagCode.SetOutputUnknownOutput);
  });

  test("setOutput with a non-string-literal name is diagnosed", () => {
    const result = compileProject({
      "rx.ts": sensorSource(
        "snrx",
        "rx",
        `[{ name: "value", type: "string" }]`,
        `    const k = "value";\n    setOutput(ctx, k, "hi");`
      ),
    });
    const entry = result.results.get("rx.ts");
    assert.ok(entry);
    expectDiagnostic(entry.diagnostics, LoweringDiagCode.SetOutputNameNotStringLiteral);
  });

  test("setOutput in an actuator (no outputs in scope) is diagnosed", () => {
    const result = compileProject({
      "act.ts": `
import { Actuator, setOutput, type Context } from "wendoo";

export default Actuator({
  id: "acbad",
  name: "bad",
  onExecute(ctx: Context): void {
    setOutput(ctx, "value", 1);
  },
});
`,
    });
    const entry = result.results.get("act.ts");
    assert.ok(entry);
    expectDiagnostic(entry.diagnostics, LoweringDiagCode.SetOutputOutsideSensor);
  });

  test("an output whose declared type does not resolve is diagnosed, not silently skipped", () => {
    const result = compileProject({
      "rx.ts": sensorSource("snrx", "rx", `[{ name: "it", type: "Bogus" }]`, ``),
    });
    const entry = result.results.get("rx.ts");
    assert.ok(entry);
    expectDiagnostic(entry.diagnostics, LoweringDiagCode.OutputTypeUnresolvable);
  });

  test("setOutput to a declared-but-unresolvable output is not misreported as undeclared", () => {
    const result = compileProject({
      "rx.ts": sensorSource("snrx", "rx", `[{ name: "it", type: "Bogus" }]`, `    setOutput(ctx, "it", 1);`),
    });
    const entry = result.results.get("rx.ts");
    assert.ok(entry);
    expectDiagnostic(entry.diagnostics, LoweringDiagCode.OutputTypeUnresolvable);
    assert.ok(!entry.diagnostics.some((d) => d.code === LoweringDiagCode.SetOutputUnknownOutput));
  });

  test("a setOutput value incompatible with the declared output type is diagnosed", () => {
    const result = compileProject({
      "rx.ts": sensorSource(
        "snrx",
        "rx",
        `[{ name: "rssi", type: "number" }]`,
        `    setOutput(ctx, "rssi", [1, 2, 3]);`
      ),
    });
    const entry = result.results.get("rx.ts");
    assert.ok(entry);
    expectDiagnostic(entry.diagnostics, LoweringDiagCode.SetOutputValueTypeMismatch);
  });

  test("a setOutput value convertible to the declared type compiles (coerced)", () => {
    const result = compileProject({
      "rx.ts": sensorSource("snrx", "rx", `[{ name: "label", type: "string" }]`, `    setOutput(ctx, "label", 42);`),
    });
    const entry = result.results.get("rx.ts");
    assert.ok(entry?.program);
    assert.deepEqual(entry.diagnostics, [], JSON.stringify(entry.diagnostics));
  });

  test("clearing an output with null is allowed", () => {
    const result = compileProject({
      "rx.ts": sensorSource("snrx", "rx", `[{ name: "value", type: "string" }]`, `    setOutput(ctx, "value", null);`),
    });
    const entry = result.results.get("rx.ts");
    assert.ok(entry?.program);
    assert.deepEqual(entry.diagnostics, [], JSON.stringify(entry.diagnostics));
  });
});

describe("derived output tiles", () => {
  before(() => {
    services = __test__createBrainServices();
  });

  test("a sensor with two outputs yields two inline output tiles the sensor gates", () => {
    const result = compileProject({
      "rx.ts": sensorSource(
        "snrx",
        "rx",
        `[{ name: "value", type: "string" }, { name: "rssi", type: "number" }]`,
        `    setOutput(ctx, "value", "hi");\n    setOutput(ctx, "rssi", 7);`
      ),
    });
    const bundle = buildCompiledActionBundle(result, { services });
    assert.ok(bundle);

    const valueTileId = mkOutputTileId(CoreTypeIds.String, scopedOutputName(TEST_PROJECT_NAMESPACE, "value"));
    const rssiTileId = mkOutputTileId(CoreTypeIds.Number, scopedOutputName(TEST_PROJECT_NAMESPACE, "rssi"));
    const valueTile = bundle.tiles.find((t) => t.tileId === valueTileId);
    const rssiTile = bundle.tiles.find((t) => t.tileId === rssiTileId);
    assert.ok(valueTile, "expected a value output tile");
    assert.ok(rssiTile, "expected an rssi output tile");
    assert.equal(valueTile.kind, "output");
    assert.equal(valueTile.metadata?.label, "value", "the tile label stays the bare declared name");

    const sensorTile = bundle.tiles.find((t) => t.tileId === `tile.sensor->${TEST_PROJECT_NAMESPACE}:user.sensor.snrx`);
    assert.ok(sensorTile);

    // The sensor advertises each output's identity key; each output tile reads its own.
    const valueKey = mkOutputVarKey(CoreTypeIds.String, scopedOutputName(TEST_PROJECT_NAMESPACE, "value"));
    const rssiKey = mkOutputVarKey(CoreTypeIds.Number, scopedOutputName(TEST_PROJECT_NAMESPACE, "rssi"));
    assert.notEqual(valueKey, rssiKey, "distinct identities get distinct keys");
    assert.ok(sensorTile.providedOutputs().indexOf(valueKey) >= 0, "the sensor provides the value output key");
    assert.ok(sensorTile.providedOutputs().indexOf(rssiKey) >= 0, "the sensor provides the rssi output key");
    assert.equal(sensorTile.providedOutputs().size(), 2, "the sensor provides exactly its declared outputs");
  });

  test("two sensors declaring the same (type, name) share one output tile and one provided key", () => {
    const result = compileProject({
      "see.ts": sensorSource(
        "snsee",
        "see",
        `[{ name: "value", type: "string" }]`,
        `    setOutput(ctx, "value", "a");`
      ),
      "hear.ts": sensorSource(
        "snhear",
        "hear",
        `[{ name: "value", type: "string" }]`,
        `    setOutput(ctx, "value", "b");`
      ),
    });
    const bundle = buildCompiledActionBundle(result, { services });
    assert.ok(bundle);

    const valueTileId = mkOutputTileId(CoreTypeIds.String, scopedOutputName(TEST_PROJECT_NAMESPACE, "value"));
    const valueTiles = bundle.tiles.filter((t) => t.tileId === valueTileId);
    assert.equal(valueTiles.length, 1, "a shared identity surfaces a single tile");

    const sharedKey = mkOutputVarKey(CoreTypeIds.String, scopedOutputName(TEST_PROJECT_NAMESPACE, "value"));
    const see = bundle.tiles.find((t) => t.tileId === `tile.sensor->${TEST_PROJECT_NAMESPACE}:user.sensor.snsee`);
    const hear = bundle.tiles.find((t) => t.tileId === `tile.sensor->${TEST_PROJECT_NAMESPACE}:user.sensor.snhear`);
    assert.ok(see && hear);
    assert.ok(see.providedOutputs().indexOf(sharedKey) >= 0, "see provides the shared output key");
    assert.ok(hear.providedOutputs().indexOf(sharedKey) >= 0, "hear provides the shared output key");
  });

  test("the same name with different types is non-colliding: two distinct tiles", () => {
    const result = compileProject({
      "s.ts": sensorSource("sns", "s", `[{ name: "value", type: "string" }]`, `    setOutput(ctx, "value", "a");`),
      "n.ts": sensorSource("snn", "n", `[{ name: "value", type: "number" }]`, `    setOutput(ctx, "value", 1);`),
    });
    const bundle = buildCompiledActionBundle(result, { services });
    assert.ok(bundle);

    const scopedValue = scopedOutputName(TEST_PROJECT_NAMESPACE, "value");
    assert.ok(bundle.tiles.some((t) => t.tileId === mkOutputTileId(CoreTypeIds.String, scopedValue)));
    assert.ok(bundle.tiles.some((t) => t.tileId === mkOutputTileId(CoreTypeIds.Number, scopedValue)));
    assert.notEqual(mkOutputVarKey(CoreTypeIds.String, scopedValue), mkOutputVarKey(CoreTypeIds.Number, scopedValue));
  });
});

/** A user-declared struct type the writable-output sensor writes. */
const SPOT_SOURCE = `import { NumberType, StructType, type StructOf } from "wendoo";

export const Spot = StructType({
  name: "spot",
  fields: { x: NumberType, y: NumberType },
  accessors: true,
});
export type Spot = StructOf<typeof Spot>;
`;

/** A sensor writing a fresh `Spot` to two outputs: `found`, declared writableResult, and `seen`, not. */
const LOCATE_SOURCE = `import { Sensor, setOutput, type Context } from "wendoo";
import { Spot } from "./spot";

export default Sensor({
  id: "snlocate",
  name: "locate",
  outputs: [
    { name: "found", type: Spot, writableResult: true },
    { name: "seen", type: Spot },
  ],
  onExecute(ctx: Context): boolean {
    setOutput(ctx, "found", Spot({ x: 3, y: 4 }));
    setOutput(ctx, "seen", Spot({ x: 3, y: 4 }));
    return true;
  },
});
`;

describe("writableResult outputs", () => {
  before(() => {
    services = __test__createBrainServices();
  });

  test("an output's writableResult is carried onto the compiled program; an absent flag stays absent", () => {
    const result = compileProject({
      "rx.ts": sensorSource(
        "snrx",
        "rx",
        `[{ name: "live", type: "number", writableResult: true }, { name: "off", type: "number", writableResult: false }, { name: "plain", type: "number" }]`,
        ``
      ),
    });
    const entry = result.results.get("rx.ts");
    assert.ok(entry?.program, `expected a compiled program: ${JSON.stringify(entry?.diagnostics)}`);
    const outputs = entry.program.outputs ?? [];
    assert.equal(outputs[0].writableResult, true);
    assert.equal(outputs[1].writableResult, false);
    assert.ok(!("writableResult" in outputs[2]), "an output declaring no flag carries none");
  });

  test("a non-boolean output writableResult is diagnosed", () => {
    const result = compileProject({
      "bad.ts": sensorSource("snbad", "bad", `[{ name: "value", type: "number", writableResult: 1 as any }]`, ``),
    });
    const entry = result.results.get("bad.ts");
    assert.ok(entry);
    assert.ok(entry.diagnostics.some((d) => d.code === DescriptorDiagCode.OutputWritableResultMustBeBoolean));
  });

  test("the derived output tile carries the declared writableResult", () => {
    const result = compileProject({
      "rx.ts": sensorSource(
        "snrx",
        "rx",
        `[{ name: "live", type: "number", writableResult: true }, { name: "plain", type: "number" }]`,
        ``
      ),
    });
    const bundle = buildCompiledActionBundle(result, { services });
    assert.ok(bundle);
    const tileFor = (name: string) =>
      bundle.tiles.find(
        (t) => t.tileId === mkOutputTileId(CoreTypeIds.Number, scopedOutputName(TEST_PROJECT_NAMESPACE, name))
      ) as BrainTileOutputDef | undefined;
    assert.equal(tileFor("live")?.writableResult, true);
    assert.equal(tileFor("plain")?.writableResult, false);
  });

  /**
   * Compiles the `locate` sensor, registers it, and runs one think of a brain
   * whose rule writes `x` through the named output and whose child rule reads
   * `x` back through the same output into a number variable. Returns the
   * variable's value.
   */
  function writeThroughOutputAndReadBack(outputName: string): number | undefined {
    const brainServices = __test__createBrainServices();
    const ambientSource = buildAmbientDeclarations(brainServices.runtime.types);
    const project = new UserTileProject({
      projectNamespace: TEST_PROJECT_NAMESPACE,
      ambientFiles: [{ path: "ambient.d.ts", content: ambientSource }],
      services: brainServices,
    });
    project.setFiles(new Map(Object.entries({ "spot.ts": SPOT_SOURCE, "locate.ts": LOCATE_SOURCE })));
    const result = project.compileAll();
    assert.equal(result.tsErrors.size, 0, `TS errors: ${JSON.stringify([...result.tsErrors])}`);
    const entry = result.results.get("locate.ts");
    assert.ok(entry?.program, `expected a compiled program: ${JSON.stringify(entry?.diagnostics)}`);
    assert.deepEqual(entry.diagnostics, []);
    const program = entry.program;
    registerUserTile(program, brainServices);

    const metadata = buildUserTileMetadata(program, (name) => brainServices.runtime.types.resolveByName(name));
    assert.ok(metadata);
    const outputTile = metadata.outputTiles.find((tile) => tile.outputName === outputName);
    assert.ok(outputTile, `expected an output tile named ${outputName}`);
    const xAccessor = brainServices.edit.tiles.get(mkAccessorTileId(outputTile.outputType, "x"));
    assert.ok(xAccessor, "expected the spot's x accessor tile");
    const assign = brainServices.edit.tiles.get(mkOperatorTileId(CoreOpId.Assign));
    assert.ok(assign);
    const readBack = new BrainTileVariableDef(
      mkVariableTileId("read-back"),
      "read-back",
      CoreTypeIds.Number,
      "read-back"
    );

    const brainDef = new BrainDef(brainServices);
    const pageResult = brainDef.appendNewPage();
    assert.ok(pageResult.success);
    const rule = pageResult.value!.page.children().get(0) as BrainRuleDef;
    __test__appendTile(rule.when(), metadata.actionTile as never);
    for (const tile of [
      outputTile,
      xAccessor,
      assign,
      new BrainTileLiteralDef(CoreTypeIds.Number, 9, {}, brainServices),
    ]) {
      __test__appendTile(rule.do(), tile as never);
    }
    const child = rule.appendNewRule();
    for (const tile of [readBack, assign, outputTile, xAccessor]) {
      __test__appendTile(child.do(), tile as never);
    }

    const brain = brainDef.compile();
    brain.initialize();
    brain.startup();
    brain.think(16);
    const value = brain.getVariable("read-back");
    return value === undefined ? undefined : extractNumberValue(value);
  }

  test("a compiled user sensor's writableResult output is a writable base end to end", () => {
    assert.equal(writeThroughOutputAndReadBack("found"), 9, "the child rule reads the field the parent wrote");
  });

  test("a compiled user sensor's plain output stays read-only: the write is refused and the field keeps its value", () => {
    assert.equal(writeThroughOutputAndReadBack("seen"), 3, "the child rule reads the value the sensor wrote");
  });
});
