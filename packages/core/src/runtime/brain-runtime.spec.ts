/**
 * Self-test for {@link BrainRuntime}: demonstrates the constrained-target
 * construction path -- building a runtime from a hand-assembled {@link Program}
 * and a test-only {@link PlatformServices} aggregate, with no import path
 * through `brain/`.
 *
 * This file's import set is intentionally rooted at `runtime/` and
 * `platform/` only; the firewall test (`__firewall__.spec.ts`) enforces the
 * same constraint on the production `brain-runtime.ts` source.
 */

import assert from "node:assert/strict";
import { before, describe, test } from "node:test";

import { List } from "@wendoo/core";
import {
  BrainRuntime,
  BYTECODE_VERSION,
  ErrorCode,
  mkNumberValue,
  NIL_VALUE,
  Op,
  type PageMetadata,
  type PlatformServices,
  type Program,
  type Value,
} from "@wendoo/core/runtime";
import { __test__createPlatformServices, type __test__PlatformServicesOptions } from "@wendoo/core/runtime/__test__";

function makeProgram(variableNames: List<string> = List.empty<string>()): Program {
  return {
    version: BYTECODE_VERSION,
    functions: List.empty(),
    constantPools: { numbers: List.empty(), strings: List.empty(), values: List.empty() },
    variableNames,
  };
}

function makePageMeta(pageIndex: number, pageId: string, pageName: string): PageMetadata {
  return {
    pageIndex,
    pageId,
    pageName,
    rootRuleFuncIds: List.empty(),
    actionCallSites: List.empty(),
  };
}

function makeHostServices(opts?: __test__PlatformServicesOptions): Omit<PlatformServices, "brain"> {
  const all = __test__createPlatformServices(opts);
  return { runtime: all.runtime, shared: all.shared, app: all.app };
}

describe("BrainRuntime", () => {
  before(() => {
    // Structural assertion: the test factory returns exactly the contracted
    // PlatformServices shape. If the factory ever silently gains authoring-side
    // members, or drops a contracted leaf, this guard fails.
    const services = __test__createPlatformServices();
    assert.notStrictEqual(services.runtime.types, undefined, "services.runtime.types");
    assert.notStrictEqual(services.runtime.functions, undefined, "services.runtime.functions");
    assert.notStrictEqual(services.runtime.operatorTable, undefined, "services.runtime.operatorTable");
    assert.notStrictEqual(services.runtime.actions, undefined, "services.runtime.actions");
    assert.notStrictEqual(services.shared.conversions, undefined, "services.shared.conversions");
    assert.notStrictEqual(services.app.rng, undefined, "services.app.rng");
    assert.notStrictEqual(services.brain.program, undefined, "services.brain.program");
    assert.notStrictEqual(services.brain.brainVars, undefined, "services.brain.brainVars");
    assert.notStrictEqual(services.brain.ruleVars, undefined, "services.brain.ruleVars");
    assert.notStrictEqual(services.brain.pages, undefined, "services.brain.pages");
    assert.notStrictEqual(services.brain.callsite, undefined, "services.brain.callsite");
  });

  test("constructor returns a fully initialized runtime", () => {
    const program = makeProgram();
    const pages = List.from([makePageMeta(0, "page-1-id", "page-1")]);
    const runtime = new BrainRuntime(program, pages, makeHostServices());
    assert.strictEqual(runtime.getProgram(), program);
    assert.strictEqual(runtime.getPages(), pages);
  });

  test("startup -> think -> shutdown runs without throwing", () => {
    const program = makeProgram();
    const pages = List.from([makePageMeta(0, "page-1-id", "page-1")]);
    const runtime = new BrainRuntime(program, pages, makeHostServices());
    runtime.startup();
    runtime.think(1.0);
    runtime.shutdown();
  });

  test("variable storage is sized to variableNames and unwritten slots return NIL_VALUE", () => {
    const program = makeProgram(List.from(["x", "y"]));
    const runtime = new BrainRuntime(program, List.from([makePageMeta(0, "p0", "page-1")]), makeHostServices());
    assert.strictEqual(program.variableNames.size(), 2);
    assert.deepEqual(runtime.getVariableBySlot(0), NIL_VALUE);
    assert.deepEqual(runtime.getVariableBySlot(1), NIL_VALUE);
    assert.strictEqual(runtime.getVariable("x"), undefined);
    assert.strictEqual(runtime.getVariable("y"), undefined);
  });

  test("requestPageChangeByName advances the FSM to the named page", () => {
    const page1Id = "page-1-id";
    const page2Id = "page-2-id";
    const pages = List.from([makePageMeta(0, page1Id, "page-1"), makePageMeta(1, page2Id, "page-2")]);
    const runtime = new BrainRuntime(makeProgram(), pages, makeHostServices());
    runtime.startup();
    assert.strictEqual(runtime.getCurrentPageId(), page1Id);
    runtime.requestPageChangeByName("page-2");
    runtime.think(1.0);
    assert.strictEqual(runtime.getCurrentPageId(), page2Id);
  });

  test("a page change request naming no page is a no-op on every route", () => {
    const page1Id = "page-1-id";
    const pages = List.from([makePageMeta(0, page1Id, "page-1"), makePageMeta(1, "page-2-id", "page-2")]);
    const runtime = new BrainRuntime(makeProgram(), pages, makeHostServices());
    runtime.startup();

    for (const request of [
      () => runtime.requestPageChange(-1),
      () => runtime.requestPageChange(pages.size()),
      () => runtime.requestPageChangeByName("no-such-page"),
      () => runtime.requestPageChangeByPageId("no-such-page-id"),
    ]) {
      request();
      runtime.think(1.0);
      assert.strictEqual(runtime.getCurrentPageId(), page1Id);
    }
  });

  test("hot-reload carry-forward preserves variable values by name", () => {
    const pages = List.from([makePageMeta(0, "p0", "page-1")]);

    const program1 = makeProgram(List.from(["score"]));
    const runtime1 = new BrainRuntime(program1, pages, makeHostServices());
    runtime1.setVariable("score", mkNumberValue(42));
    const snapshot = runtime1.snapshotVariables();

    const program2 = makeProgram(List.from(["score", "count"]));
    const runtime2 = new BrainRuntime(program2, pages, makeHostServices(), undefined, snapshot);
    assert.deepEqual(runtime2.getVariable("score"), mkNumberValue(42));
    assert.strictEqual(runtime2.getVariable("count"), undefined);
  });

  test("host-supplied app.rng seam is injectable", () => {
    let callCount = 0;
    const deterministicRng = {
      next(): number {
        callCount++;
        return 0.5;
      },
    };
    const customServices = makeHostServices({ app: { rng: deterministicRng } });
    const defaultServices = makeHostServices();
    assert.strictEqual(customServices.app.rng, deterministicRng);
    assert.notStrictEqual(defaultServices.app.rng, deterministicRng);
    customServices.app.rng.next();
    assert.strictEqual(callCount, 1);
  });

  test("forwards VM fault callbacks to runtime callers", () => {
    const errValue: Value = {
      t: "err",
      e: { code: ErrorCode.ScriptError, message: "runtime fault" },
    };
    const program: Program = {
      version: BYTECODE_VERSION,
      functions: List.from([
        {
          code: List.from([{ op: Op.PUSH_CONST_VAL, a: 0 }, { op: Op.THROW }]),
          numParams: 0,
        },
      ]),
      constantPools: {
        numbers: List.empty(),
        strings: List.empty(),
        values: List.from([errValue]),
      },
      variableNames: List.empty(),
    };
    const page: PageMetadata = {
      pageIndex: 0,
      pageId: "page-1-id",
      pageName: "page-1",
      rootRuleFuncIds: List.from([0]),
      actionCallSites: List.empty(),
    };
    const pages = List.from([page]);

    let faultMessage: string | undefined;
    const runtime = new BrainRuntime(program, pages, makeHostServices(), undefined, undefined, {
      onFiberFault: ({ err }) => {
        faultMessage = err.message;
      },
    });

    runtime.startup();
    runtime.think(1);

    assert.equal(faultMessage, "runtime fault");
  });
});
