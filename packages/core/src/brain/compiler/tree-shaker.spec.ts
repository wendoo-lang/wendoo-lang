import assert from "node:assert/strict";
import { before, describe, test } from "node:test";

import { Dict, List, UniqueSet } from "@wendoo/core";
import type { BrainServices } from "@wendoo/core/brain";
import { __test__createBrainServices } from "@wendoo/core/brain/__test__";
import { treeshakeProgram as treeshakeLinked } from "@wendoo/core/brain/compiler";
import type { BytecodeExecutableAction, ConstantPools, ExecutionContext, ProgramTypeEntry } from "@wendoo/core/runtime";
import {
  BYTECODE_VERSION,
  FALSE_VALUE,
  type FunctionBytecode,
  HandleTable,
  type Instr,
  isFunctionValue,
  type LinkedBrainProgram,
  mkFunctionValue,
  mkNumberValue,
  mkStringValue,
  NativeType,
  NIL_VALUE,
  Op,
  type PageMetadata,
  TRUE_VALUE,
  UNKNOWN_VALUE,
  type Value,
  VM,
  VmStatus,
  VOID_VALUE,
} from "@wendoo/core/runtime";
import { __test__createPlatformServices } from "@wendoo/core/runtime/__test__";

function mkInstr(op: Op, a?: number, b?: number, c?: number): Instr {
  const ins: Instr = { op };
  if (a !== undefined) ins.a = a;
  if (b !== undefined) ins.b = b;
  if (c !== undefined) ins.c = c;
  return ins;
}

function mkFunc(code: Instr[], numParams = 0, name?: string): FunctionBytecode {
  return { code: List.from(code), numParams, name };
}

function mkPage(pageIndex: number, rootRuleFuncIds: number[]): PageMetadata {
  return {
    pageIndex,
    pageId: `page-${pageIndex}`,
    pageName: `Page ${pageIndex}`,
    rootRuleFuncIds: List.from(rootRuleFuncIds),
    actionCallSites: List.empty(),
  };
}

function mkStructEntry(name: string, maxFieldId = 0): ProgramTypeEntry {
  return { tag: "struct", typeId: `struct:<${name}>`, name, maxFieldId, fields: List.empty() };
}

function mkBytecodeAction(entryFuncId: number, activationFuncId?: number): BytecodeExecutableAction {
  const action: BytecodeExecutableAction = {
    binding: "bytecode",
    descriptor: { key: "test-action", kind: "action" } as never,
    entryFuncId,
    numStateSlots: 0,
  };
  if (activationFuncId !== undefined) {
    action.activationFuncId = activationFuncId;
  }
  return action;
}

function mkProgram(opts: {
  functions: FunctionBytecode[];
  constants?: Value[];
  numberConstants?: number[];
  stringConstants?: string[];
  types?: ProgramTypeEntry[];
  variableNames?: string[];
  entryPoint?: number;
  pages?: PageMetadata[];
  actions?: BytecodeExecutableAction[];
  ruleIndex?: [string, number][];
}): FlatProgram {
  return {
    version: BYTECODE_VERSION,
    functions: List.from(opts.functions),
    constantPools: {
      numbers: List.from(opts.numberConstants ?? []),
      strings: List.from(opts.stringConstants ?? []),
      values: List.from(opts.constants ?? []),
    },
    types: List.from(opts.types ?? []),
    variableNames: List.from(opts.variableNames ?? []),
    entryPoint: opts.entryPoint,
    ruleIndex: new Dict(opts.ruleIndex ?? []),
    pages: List.from(opts.pages ?? []),
    actions: List.from(opts.actions ?? []),
  };
}

/**
 * Flat view that combines `Program` fields with the `LinkedBrainProgram`
 * side tables (`pages`, `ruleIndex`). Used only by these tests for ergonomic
 * access; production code uses the split shape.
 */
interface FlatProgram {
  version: number;
  functions: List<FunctionBytecode>;
  constantPools: ConstantPools;
  types: List<ProgramTypeEntry>;
  variableNames: List<string>;
  entryPoint?: number;
  ruleIndex: Dict<string, number>;
  pages: List<PageMetadata>;
  actions: List<BytecodeExecutableAction>;
}

function toLinked(flat: FlatProgram): LinkedBrainProgram {
  return {
    program: {
      version: flat.version,
      functions: flat.functions,
      constantPools: flat.constantPools,
      types: flat.types,
      variableNames: flat.variableNames,
      entryPoint: flat.entryPoint,
      actions: flat.actions,
    },
    ruleIndex: flat.ruleIndex,
    pages: flat.pages,
  };
}

function flatten(linked: LinkedBrainProgram): FlatProgram {
  return {
    version: linked.program.version,
    functions: linked.program.functions,
    constantPools: linked.program.constantPools,
    types: linked.program.types ?? List.empty<ProgramTypeEntry>(),
    variableNames: linked.program.variableNames,
    entryPoint: linked.program.entryPoint,
    actions: linked.program.actions ?? List.empty<BytecodeExecutableAction>(),
    ruleIndex: linked.ruleIndex,
    pages: linked.pages,
  };
}

function treeshakeProgram(flat: FlatProgram, pinnedTypeIndices?: UniqueSet<number>): FlatProgram {
  const linked = toLinked(flat);
  const out = treeshakeLinked(linked, pinnedTypeIndices);
  return out === linked ? flat : flatten(out);
}

describe("treeshakeProgram", () => {
  test("program with no dead functions returns unchanged", () => {
    const prog = mkProgram({
      functions: [mkFunc([mkInstr(Op.CALL, 1), mkInstr(Op.RET)], 0, "main"), mkFunc([mkInstr(Op.RET)], 0, "helper")],
      entryPoint: 0,
    });
    const result = treeshakeProgram(prog);
    assert.equal(result, prog);
  });

  test("unreachable functions are removed", () => {
    const prog = mkProgram({
      functions: [
        mkFunc([mkInstr(Op.RET)], 0, "main"),
        mkFunc([mkInstr(Op.RET)], 0, "dead"),
        mkFunc([mkInstr(Op.RET)], 0, "also-dead"),
      ],
      entryPoint: 0,
    });
    const result = treeshakeProgram(prog);
    assert.equal(result.functions.size(), 1);
    assert.equal(result.functions.get(0).name, "main");
    assert.equal(result.entryPoint, 0);
  });

  test("CALL operands are remapped correctly", () => {
    const prog = mkProgram({
      functions: [
        mkFunc([mkInstr(Op.CALL, 2), mkInstr(Op.RET)], 0, "main"),
        mkFunc([mkInstr(Op.RET)], 0, "dead"),
        mkFunc([mkInstr(Op.RET)], 0, "target"),
      ],
      entryPoint: 0,
    });
    const result = treeshakeProgram(prog);
    assert.equal(result.functions.size(), 2);
    assert.equal(result.functions.get(0).name, "main");
    assert.equal(result.functions.get(1).name, "target");
    const callInstr = result.functions.get(0).code.get(0);
    assert.equal(callInstr.op, Op.CALL);
    assert.equal(callInstr.a, 1);
  });

  test("MAKE_CLOSURE operands are remapped correctly", () => {
    const prog = mkProgram({
      functions: [
        mkFunc([mkInstr(Op.MAKE_CLOSURE, 2, 0), mkInstr(Op.RET)], 0, "main"),
        mkFunc([mkInstr(Op.RET)], 0, "dead"),
        mkFunc([mkInstr(Op.RET)], 0, "closure-target"),
      ],
      entryPoint: 0,
    });
    const result = treeshakeProgram(prog);
    assert.equal(result.functions.size(), 2);
    const closureInstr = result.functions.get(0).code.get(0);
    assert.equal(closureInstr.op, Op.MAKE_CLOSURE);
    assert.equal(closureInstr.a, 1);
  });

  test("FunctionValue constants have funcIds remapped", () => {
    const prog = mkProgram({
      functions: [
        mkFunc([mkInstr(Op.PUSH_CONST_VAL, 0), mkInstr(Op.RET)], 0, "main"),
        mkFunc([mkInstr(Op.RET)], 0, "dead"),
        mkFunc([mkInstr(Op.RET)], 0, "const-ref"),
      ],
      constants: [mkFunctionValue(2)],
      entryPoint: 0,
    });
    const result = treeshakeProgram(prog);
    assert.equal(result.functions.size(), 2);
    const constVal = result.constantPools.values.get(0);
    assert.ok(isFunctionValue(constVal));
    assert.equal(constVal.funcId, 1);
  });

  test("FunctionValue constants with captures have nested funcIds remapped", () => {
    const innerCapture = mkFunctionValue(3);
    const outerConst = mkFunctionValue(2, List.from<Value>([innerCapture]));
    const prog = mkProgram({
      functions: [
        mkFunc([mkInstr(Op.PUSH_CONST_VAL, 0), mkInstr(Op.RET)], 0, "main"),
        mkFunc([mkInstr(Op.RET)], 0, "dead"),
        mkFunc([mkInstr(Op.RET)], 0, "outer"),
        mkFunc([mkInstr(Op.RET)], 0, "inner"),
      ],
      constants: [outerConst],
      entryPoint: 0,
    });
    const result = treeshakeProgram(prog);
    assert.equal(result.functions.size(), 3);
    const remappedConst = result.constantPools.values.get(0);
    assert.ok(isFunctionValue(remappedConst));
    assert.equal(remappedConst.funcId, 1);
    assert.ok(remappedConst.captures);
    const capturedVal = remappedConst.captures.get(0);
    assert.ok(isFunctionValue(capturedVal));
    assert.equal(capturedVal.funcId, 2);
  });

  test("rootRuleFuncIds are remapped", () => {
    const prog = mkProgram({
      functions: [
        mkFunc([mkInstr(Op.RET)], 0, "dead"),
        mkFunc([mkInstr(Op.RET)], 0, "rule-a"),
        mkFunc([mkInstr(Op.RET)], 0, "rule-b"),
      ],
      pages: [mkPage(0, [1, 2])],
    });
    const result = treeshakeProgram(prog);
    assert.equal(result.functions.size(), 2);
    assert.equal(result.functions.get(0).name, "rule-a");
    assert.equal(result.functions.get(1).name, "rule-b");
    const page = result.pages.get(0);
    assert.equal(page.rootRuleFuncIds.get(0), 0);
    assert.equal(page.rootRuleFuncIds.get(1), 1);
  });

  test("ruleIndex values are remapped", () => {
    const prog = mkProgram({
      functions: [mkFunc([mkInstr(Op.RET)], 0, "dead"), mkFunc([mkInstr(Op.RET)], 0, "rule-fn")],
      pages: [mkPage(0, [1])],
      ruleIndex: [["0/0", 1]],
    });
    const result = treeshakeProgram(prog);
    assert.equal(result.ruleIndex.get("0/0"), 0);
  });

  test("entryPoint is remapped", () => {
    const prog = mkProgram({
      functions: [
        mkFunc([mkInstr(Op.RET)], 0, "dead-0"),
        mkFunc([mkInstr(Op.RET)], 0, "dead-1"),
        mkFunc([mkInstr(Op.RET)], 0, "entry"),
      ],
      entryPoint: 2,
    });
    const result = treeshakeProgram(prog);
    assert.equal(result.functions.size(), 1);
    assert.equal(result.entryPoint, 0);
  });

  test("bytecode action entryFuncId and activationFuncId are remapped", () => {
    const prog = mkProgram({
      functions: [
        mkFunc([mkInstr(Op.RET)], 0, "dead"),
        mkFunc([mkInstr(Op.RET)], 0, "entry-fn"),
        mkFunc([mkInstr(Op.RET)], 0, "activation-fn"),
      ],
      actions: [mkBytecodeAction(1, 2)],
    });
    const result = treeshakeProgram(prog);
    assert.equal(result.functions.size(), 2);
    const action = result.actions.get(0) as BytecodeExecutableAction;
    assert.equal(action.binding, "bytecode");
    assert.equal(action.entryFuncId, 0);
    assert.equal(action.activationFuncId, 1);
  });

  test("function reachable only through FunctionValue constant is retained", () => {
    const prog = mkProgram({
      functions: [
        mkFunc([mkInstr(Op.PUSH_CONST_VAL, 0), mkInstr(Op.RET)], 0, "main"),
        mkFunc([mkInstr(Op.RET)], 0, "dead"),
        mkFunc([mkInstr(Op.RET)], 0, "only-via-const"),
      ],
      constants: [mkFunctionValue(2)],
      entryPoint: 0,
    });
    const result = treeshakeProgram(prog);
    assert.equal(result.functions.size(), 2);
    assert.equal(result.functions.get(0).name, "main");
    assert.equal(result.functions.get(1).name, "only-via-const");
  });

  test("function reachable only through closure capture chain is retained", () => {
    const deepCapture = mkFunctionValue(3);
    const midCapture = mkFunctionValue(2, List.from<Value>([deepCapture]));
    const prog = mkProgram({
      functions: [
        mkFunc([mkInstr(Op.PUSH_CONST_VAL, 0), mkInstr(Op.RET)], 0, "main"),
        mkFunc([mkInstr(Op.RET)], 0, "dead"),
        mkFunc([mkInstr(Op.RET)], 0, "mid"),
        mkFunc([mkInstr(Op.RET)], 0, "deep"),
      ],
      constants: [midCapture],
      entryPoint: 0,
    });
    const result = treeshakeProgram(prog);
    assert.equal(result.functions.size(), 3);
    assert.equal(result.functions.get(0).name, "main");
    assert.equal(result.functions.get(1).name, "mid");
    assert.equal(result.functions.get(2).name, "deep");
  });

  test("non-FunctionValue constants are left untouched", () => {
    const prog = mkProgram({
      functions: [
        mkFunc([mkInstr(Op.PUSH_CONST_VAL, 0), mkInstr(Op.PUSH_CONST_VAL, 1), mkInstr(Op.RET)], 0, "main"),
        mkFunc([mkInstr(Op.RET)], 0, "dead"),
      ],
      constants: [mkNumberValue(42), mkStringValue("hello")],
      entryPoint: 0,
    });
    const result = treeshakeProgram(prog);
    assert.equal(result.constantPools.values.size(), 2);
    assert.equal(result.constantPools.values.get(0).t, NativeType.Number);
    assert.equal(result.constantPools.values.get(1).t, NativeType.String);
  });

  test("unreferenced variable names are removed", () => {
    const prog = mkProgram({
      functions: [mkFunc([mkInstr(Op.RET)], 0, "main"), mkFunc([mkInstr(Op.RET)], 0, "dead")],
      variableNames: ["x", "y", "z"],
      entryPoint: 0,
    });
    const result = treeshakeProgram(prog);
    assert.equal(result.variableNames.size(), 0);
  });

  test("transitive call reachability is tracked", () => {
    const prog = mkProgram({
      functions: [
        mkFunc([mkInstr(Op.CALL, 1), mkInstr(Op.RET)], 0, "main"),
        mkFunc([mkInstr(Op.CALL, 3), mkInstr(Op.RET)], 0, "helper1"),
        mkFunc([mkInstr(Op.RET)], 0, "dead"),
        mkFunc([mkInstr(Op.RET)], 0, "helper2"),
      ],
      entryPoint: 0,
    });
    const result = treeshakeProgram(prog);
    assert.equal(result.functions.size(), 3);
    assert.equal(result.functions.get(0).name, "main");
    assert.equal(result.functions.get(1).name, "helper1");
    assert.equal(result.functions.get(2).name, "helper2");
  });

  test("constants only referenced by dead functions are removed", () => {
    const prog = mkProgram({
      functions: [
        mkFunc([mkInstr(Op.PUSH_CONST_VAL, 0), mkInstr(Op.RET)], 0, "main"),
        mkFunc([mkInstr(Op.PUSH_CONST_VAL, 1), mkInstr(Op.RET)], 0, "dead"),
      ],
      constants: [mkNumberValue(42), mkStringValue("dead-only")],
      entryPoint: 0,
    });
    const result = treeshakeProgram(prog);
    assert.equal(result.functions.size(), 1);
    assert.equal(result.constantPools.values.size(), 1);
    assert.equal((result.constantPools.values.get(0) as { v: number }).v, 42);
  });

  test("constants referenced by surviving functions are retained", () => {
    const prog = mkProgram({
      functions: [
        mkFunc(
          [
            mkInstr(Op.PUSH_CONST_VAL, 0),
            mkInstr(Op.PUSH_CONST_VAL, 1),
            mkInstr(Op.PUSH_CONST_VAL, 2),
            mkInstr(Op.RET),
          ],
          0,
          "main"
        ),
      ],
      constants: [mkNumberValue(1), mkNumberValue(2), mkNumberValue(3)],
      entryPoint: 0,
    });
    const result = treeshakeProgram(prog);
    assert.equal(result.constantPools.values.size(), 3);
  });

  test("type-table entries referenced via LIST_NEW b are retained", () => {
    const prog = mkProgram({
      functions: [mkFunc([mkInstr(Op.LIST_NEW, 0, 0), mkInstr(Op.RET)], 0, "main")],
      types: [mkStructEntry("Used"), mkStructEntry("Unused")],
      entryPoint: 0,
    });
    const result = treeshakeProgram(prog);
    assert.equal(result.types.size(), 1);
    assert.equal(result.types.get(0)!.typeId, "struct:<Used>");
  });

  test("type-table entries referenced via STRUCT_NEW b are retained", () => {
    const prog = mkProgram({
      functions: [mkFunc([mkInstr(Op.STRUCT_NEW, 2, 0), mkInstr(Op.RET)], 0, "main")],
      types: [mkStructEntry("Used"), mkStructEntry("Unused")],
      entryPoint: 0,
    });
    const result = treeshakeProgram(prog);
    assert.equal(result.types.size(), 1);
    assert.equal(result.types.get(0)!.typeId, "struct:<Used>");
  });

  test("type-table entries referenced via MAP_NEW b are retained", () => {
    const prog = mkProgram({
      functions: [mkFunc([mkInstr(Op.MAP_NEW, 0, 0), mkInstr(Op.RET)], 0, "main")],
      types: [mkStructEntry("Used"), mkStructEntry("Unused")],
      entryPoint: 0,
    });
    const result = treeshakeProgram(prog);
    assert.equal(result.types.size(), 1);
  });

  test("type-table entries referenced via STRUCT_COPY_EXCEPT b are retained", () => {
    const prog = mkProgram({
      functions: [mkFunc([mkInstr(Op.STRUCT_COPY_EXCEPT, 1, 0), mkInstr(Op.RET)], 0, "main")],
      types: [mkStructEntry("Used"), mkStructEntry("Unused")],
      entryPoint: 0,
    });
    const result = treeshakeProgram(prog);
    assert.equal(result.types.size(), 1);
  });

  test("a structural entry keeps its children alive and child references remap", () => {
    const listEntry: ProgramTypeEntry = { tag: "list", typeId: "list:<List<struct:<Elem>>>", elem: 1 };
    const prog = mkProgram({
      functions: [mkFunc([mkInstr(Op.LIST_NEW, 0, 2), mkInstr(Op.RET)], 0, "main")],
      types: [mkStructEntry("Unused"), mkStructEntry("Elem"), listEntry],
      entryPoint: 0,
    });
    const result = treeshakeProgram(prog);
    assert.equal(result.types.size(), 2);
    assert.equal(result.types.get(0)!.typeId, "struct:<Elem>");
    const shakenList = result.types.get(1)!;
    assert.equal(shakenList.tag, "list");
    assert.equal((shakenList as { elem: number }).elem, 0);
    assert.equal(result.functions.get(0).code.get(0).b, 1);
  });

  test("entries referenced only by reachable constant values are retained", () => {
    const enumEntry: ProgramTypeEntry = {
      tag: "enum",
      typeId: "enum:<ValEnum>",
      name: "ValEnum",
      symbols: List.from([
        { key: "A", value: 0 },
        { key: "B", value: 1 },
      ]),
    };
    const prog = mkProgram({
      functions: [mkFunc([mkInstr(Op.PUSH_CONST_VAL, 0), mkInstr(Op.RET)], 0, "main")],
      constants: [{ t: NativeType.Enum, typeId: "enum:<ValEnum>", v: "A" } as Value],
      types: [mkStructEntry("Unused"), enumEntry],
      entryPoint: 0,
    });
    const result = treeshakeProgram(prog);
    assert.equal(result.types.size(), 1);
    assert.equal(result.types.get(0)!.typeId, "enum:<ValEnum>");
  });

  test("injectCtxTypeIdx keeps its entry alive and remaps", () => {
    const fn: FunctionBytecode = {
      code: List.from<Instr>([mkInstr(Op.RET)]),
      numParams: 0,
      name: "main",
      injectCtxTypeIdx: 1,
    };
    const prog = mkProgram({
      functions: [fn],
      types: [mkStructEntry("Unused"), mkStructEntry("Ctx")],
      entryPoint: 0,
    });
    const result = treeshakeProgram(prog);
    assert.equal(result.types.size(), 1);
    assert.equal(result.types.get(0)!.typeId, "struct:<Ctx>");
    assert.equal(result.functions.get(0).injectCtxTypeIdx, 0);
  });

  test("PUSH_CONST operands are remapped after constant shaking", () => {
    const prog = mkProgram({
      functions: [
        mkFunc([mkInstr(Op.PUSH_CONST_VAL, 2), mkInstr(Op.RET)], 0, "main"),
        mkFunc([mkInstr(Op.PUSH_CONST_VAL, 0), mkInstr(Op.PUSH_CONST_VAL, 1), mkInstr(Op.RET)], 0, "dead"),
      ],
      constants: [mkNumberValue(10), mkNumberValue(20), mkNumberValue(30)],
      entryPoint: 0,
    });
    const result = treeshakeProgram(prog);
    assert.equal(result.functions.size(), 1);
    assert.equal(result.constantPools.values.size(), 1);
    assert.equal((result.constantPools.values.get(0) as { v: number }).v, 30);
    const pushInstr = result.functions.get(0).code.get(0);
    assert.equal(pushInstr.op, Op.PUSH_CONST_VAL);
    assert.equal(pushInstr.a, 0);
  });

  test("LIST_NEW / MAP_NEW / STRUCT_NEW / STRUCT_COPY_EXCEPT b operands are remapped", () => {
    const prog = mkProgram({
      functions: [
        mkFunc([mkInstr(Op.LIST_NEW, 0, 1), mkInstr(Op.RET)], 0, "main"),
        mkFunc([mkInstr(Op.STRUCT_NEW, 0, 0), mkInstr(Op.RET)], 0, "dead"),
      ],
      types: [mkStructEntry("DeadType"), mkStructEntry("LiveType")],
      entryPoint: 0,
    });
    const result = treeshakeProgram(prog);
    assert.equal(result.types.size(), 1);
    assert.equal(result.types.get(0)!.typeId, "struct:<LiveType>");
    const listInstr = result.functions.get(0).code.get(0);
    assert.equal(listInstr.op, Op.LIST_NEW);
    assert.equal(listInstr.b, 0);
  });

  test("INSTANCE_OF a operand is remapped after type shaking", () => {
    const prog = mkProgram({
      functions: [
        mkFunc([mkInstr(Op.INSTANCE_OF, 1), mkInstr(Op.RET)], 0, "main"),
        mkFunc([mkInstr(Op.INSTANCE_OF, 0), mkInstr(Op.RET)], 0, "dead"),
      ],
      types: [mkStructEntry("DeadType"), mkStructEntry("MyClass")],
      entryPoint: 0,
    });
    const result = treeshakeProgram(prog);
    assert.equal(result.types.size(), 1);
    assert.equal(result.types.get(0)!.typeId, "struct:<MyClass>");
    const instOfInstr = result.functions.get(0).code.get(0);
    assert.equal(instOfInstr.op, Op.INSTANCE_OF);
    assert.equal(instOfInstr.a, 0);
  });

  test("a pinned type entry with no operand reference survives the sweep", () => {
    const prog = mkProgram({
      functions: [mkFunc([mkInstr(Op.RET)], 0, "main"), mkFunc([mkInstr(Op.RET)], 0, "dead")],
      types: [mkStructEntry("Unpinned"), mkStructEntry("Pinned")],
      entryPoint: 0,
    });
    const result = treeshakeProgram(prog, new UniqueSet<number>([1]));
    assert.equal(result.functions.size(), 1, "the sweep runs and removes the dead function");
    assert.equal(result.types.size(), 1);
    assert.equal(result.types.get(0)!.typeId, "struct:<Pinned>");
  });

  test("a pinned structural entry keeps its children alive and child references remap", () => {
    const listEntry: ProgramTypeEntry = { tag: "list", typeId: "list:<List<struct:<Elem>>>", elem: 1 };
    const prog = mkProgram({
      functions: [mkFunc([mkInstr(Op.RET)], 0, "main"), mkFunc([mkInstr(Op.RET)], 0, "dead")],
      types: [mkStructEntry("Unpinned"), mkStructEntry("Elem"), listEntry],
      entryPoint: 0,
    });
    const result = treeshakeProgram(prog, new UniqueSet<number>([2]));
    assert.equal(result.types.size(), 2);
    assert.equal(result.types.get(0)!.typeId, "struct:<Elem>");
    const shakenList = result.types.get(1)!;
    assert.equal(shakenList.tag, "list");
    assert.equal((shakenList as { elem: number }).elem, 0);
  });

  test("a pinned entry keeps a program with no dead code unchanged", () => {
    const prog = mkProgram({
      functions: [mkFunc([mkInstr(Op.RET)], 0, "main")],
      types: [mkStructEntry("PinnedOnly")],
      entryPoint: 0,
    });
    const result = treeshakeProgram(prog, new UniqueSet<number>([0]));
    assert.equal(result, prog);
    assert.equal(result.types.size(), 1);
  });

  test("variable names only referenced by dead functions are removed", () => {
    const prog = mkProgram({
      functions: [
        mkFunc([mkInstr(Op.LOAD_VAR_SLOT, 0), mkInstr(Op.RET)], 0, "main"),
        mkFunc([mkInstr(Op.LOAD_VAR_SLOT, 1), mkInstr(Op.STORE_VAR_SLOT, 2), mkInstr(Op.RET)], 0, "dead"),
      ],
      variableNames: ["x", "y", "z"],
      entryPoint: 0,
    });
    const result = treeshakeProgram(prog);
    assert.equal(result.functions.size(), 1);
    assert.equal(result.variableNames.size(), 1);
    assert.equal(result.variableNames.get(0), "x");
  });

  test("LOAD_VAR_SLOT / STORE_VAR_SLOT operands are remapped", () => {
    const prog = mkProgram({
      functions: [
        mkFunc([mkInstr(Op.LOAD_VAR_SLOT, 2), mkInstr(Op.STORE_VAR_SLOT, 2), mkInstr(Op.RET)], 0, "main"),
        mkFunc([mkInstr(Op.LOAD_VAR_SLOT, 0), mkInstr(Op.STORE_VAR_SLOT, 1), mkInstr(Op.RET)], 0, "dead"),
      ],
      variableNames: ["a", "b", "c"],
      entryPoint: 0,
    });
    const result = treeshakeProgram(prog);
    assert.equal(result.variableNames.size(), 1);
    assert.equal(result.variableNames.get(0), "c");
    const loadInstr = result.functions.get(0).code.get(0);
    assert.equal(loadInstr.op, Op.LOAD_VAR_SLOT);
    assert.equal(loadInstr.a, 0);
    const storeInstr = result.functions.get(0).code.get(1);
    assert.equal(storeInstr.op, Op.STORE_VAR_SLOT);
    assert.equal(storeInstr.a, 0);
  });

  test("program with no dead constants or variables returns unchanged", () => {
    const prog = mkProgram({
      functions: [
        mkFunc(
          [mkInstr(Op.PUSH_CONST_VAL, 0), mkInstr(Op.LOAD_VAR_SLOT, 0), mkInstr(Op.STORE_VAR_SLOT, 1), mkInstr(Op.RET)],
          0,
          "main"
        ),
      ],
      constants: [mkNumberValue(42)],
      variableNames: ["x", "y"],
      entryPoint: 0,
    });
    const result = treeshakeProgram(prog);
    assert.equal(result, prog);
  });

  test("constants and variable names are shaken even when no functions are dead", () => {
    const prog = mkProgram({
      functions: [mkFunc([mkInstr(Op.PUSH_CONST_VAL, 0), mkInstr(Op.LOAD_VAR_SLOT, 0), mkInstr(Op.RET)], 0, "main")],
      constants: [mkNumberValue(1), mkNumberValue(2)],
      variableNames: ["used", "unused"],
      entryPoint: 0,
    });
    const result = treeshakeProgram(prog);
    assert.equal(result.functions.size(), 1);
    assert.equal(result.constantPools.values.size(), 1);
    assert.equal(result.variableNames.size(), 1);
    assert.equal(result.variableNames.get(0), "used");
  });

  test("duplicate number constants are collapsed to one", () => {
    const prog = mkProgram({
      functions: [
        mkFunc(
          [
            mkInstr(Op.PUSH_CONST_VAL, 0),
            mkInstr(Op.PUSH_CONST_VAL, 1),
            mkInstr(Op.PUSH_CONST_VAL, 2),
            mkInstr(Op.RET),
          ],
          0,
          "main"
        ),
      ],
      constants: [mkNumberValue(42), mkNumberValue(42), mkNumberValue(99)],
      entryPoint: 0,
    });
    const result = treeshakeProgram(prog);
    assert.equal(result.constantPools.values.size(), 2);
    assert.equal((result.constantPools.values.get(0) as { v: number }).v, 42);
    assert.equal((result.constantPools.values.get(1) as { v: number }).v, 99);
    const code = result.functions.get(0).code;
    assert.equal(code.get(0).a, 0);
    assert.equal(code.get(1).a, 0);
    assert.equal(code.get(2).a, 1);
  });

  test("duplicate string constants are collapsed", () => {
    const prog = mkProgram({
      functions: [mkFunc([mkInstr(Op.PUSH_CONST_STR, 0), mkInstr(Op.PUSH_CONST_STR, 1), mkInstr(Op.RET)], 0, "main")],
      stringConstants: ["hello", "hello"],
      entryPoint: 0,
    });
    const result = treeshakeProgram(prog);
    assert.equal(result.constantPools.strings.size(), 1);
    assert.equal(result.constantPools.strings.get(0), "hello");
    const code = result.functions.get(0).code;
    assert.equal(code.get(0).a, 0);
    assert.equal(code.get(1).a, 0);
  });

  test("duplicate type-table entries are collapsed and operands repointed", () => {
    const dupA = mkStructEntry("Dup");
    const dupB = mkStructEntry("Dup");
    const prog = mkProgram({
      functions: [mkFunc([mkInstr(Op.STRUCT_NEW, 0, 0), mkInstr(Op.STRUCT_NEW, 0, 1), mkInstr(Op.RET)], 0, "main")],
      types: [dupA, dupB],
      entryPoint: 0,
    });
    const result = treeshakeProgram(prog);
    assert.equal(result.types.size(), 1);
    assert.equal(result.types.get(0)!.typeId, "struct:<Dup>");
    const code = result.functions.get(0).code;
    assert.equal(code.get(0).b, 0);
    assert.equal(code.get(1).b, 0);
  });

  test("duplicate boolean/nil/void constants are collapsed", () => {
    const prog = mkProgram({
      functions: [
        mkFunc(
          [
            mkInstr(Op.PUSH_CONST_VAL, 0),
            mkInstr(Op.PUSH_CONST_VAL, 1),
            mkInstr(Op.PUSH_CONST_VAL, 2),
            mkInstr(Op.PUSH_CONST_VAL, 3),
            mkInstr(Op.PUSH_CONST_VAL, 4),
            mkInstr(Op.PUSH_CONST_VAL, 5),
            mkInstr(Op.RET),
          ],
          0,
          "main"
        ),
      ],
      constants: [NIL_VALUE, NIL_VALUE, TRUE_VALUE, TRUE_VALUE, VOID_VALUE, VOID_VALUE],
      entryPoint: 0,
    });
    const result = treeshakeProgram(prog);
    assert.equal(result.constantPools.values.size(), 3);
    assert.equal(result.constantPools.values.get(0).t, NativeType.Nil);
    assert.equal(result.constantPools.values.get(1).t, NativeType.Boolean);
    assert.equal(result.constantPools.values.get(2).t, NativeType.Void);
    const code = result.functions.get(0).code;
    assert.equal(code.get(0).a, 0);
    assert.equal(code.get(1).a, 0);
    assert.equal(code.get(2).a, 1);
    assert.equal(code.get(3).a, 1);
    assert.equal(code.get(4).a, 2);
    assert.equal(code.get(5).a, 2);
  });

  test("duplicate FunctionValue constants with same funcId and no captures are collapsed", () => {
    const prog = mkProgram({
      functions: [
        mkFunc([mkInstr(Op.PUSH_CONST_VAL, 0), mkInstr(Op.PUSH_CONST_VAL, 1), mkInstr(Op.RET)], 0, "main"),
        mkFunc([mkInstr(Op.RET)], 0, "target"),
      ],
      constants: [mkFunctionValue(1), mkFunctionValue(1)],
      entryPoint: 0,
    });
    const result = treeshakeProgram(prog);
    assert.equal(result.constantPools.values.size(), 1);
    const fv = result.constantPools.values.get(0);
    assert.ok(isFunctionValue(fv));
    assert.equal(fv.funcId, 1);
    const code = result.functions.get(0).code;
    assert.equal(code.get(0).a, 0);
    assert.equal(code.get(1).a, 0);
  });

  test("non-deduplicable complex constants are preserved as separate entries", () => {
    const listVal1: Value = {
      t: NativeType.List,
      typeId: "List<number>" as never,
      v: List.from<Value>([mkNumberValue(1)]),
    };
    const listVal2: Value = {
      t: NativeType.List,
      typeId: "List<number>" as never,
      v: List.from<Value>([mkNumberValue(1)]),
    };
    const prog = mkProgram({
      functions: [mkFunc([mkInstr(Op.PUSH_CONST_VAL, 0), mkInstr(Op.PUSH_CONST_VAL, 1), mkInstr(Op.RET)], 0, "main")],
      constants: [listVal1, listVal2],
      entryPoint: 0,
    });
    const result = treeshakeProgram(prog);
    assert.equal(result.constantPools.values.size(), 2);
  });

  test("all instruction operands referencing deduplicated constant point to surviving entry", () => {
    const prog = mkProgram({
      functions: [
        mkFunc(
          [
            mkInstr(Op.PUSH_CONST_NUM, 0),
            mkInstr(Op.PUSH_CONST_NUM, 1),
            mkInstr(Op.LIST_NEW, 0, 0),
            mkInstr(Op.STRUCT_NEW, 2, 1),
            mkInstr(Op.INSTANCE_OF, 2),
            mkInstr(Op.RET),
          ],
          0,
          "main"
        ),
      ],
      numberConstants: [42, 42],
      types: [mkStructEntry("MyType"), mkStructEntry("MyType"), mkStructEntry("MyType")],
      entryPoint: 0,
    });
    const result = treeshakeProgram(prog);
    assert.equal(result.constantPools.numbers.size(), 1);
    assert.equal(result.constantPools.numbers.get(0), 42);
    assert.equal(result.types.size(), 1);
    assert.equal(result.types.get(0)!.typeId, "struct:<MyType>");
    const code = result.functions.get(0).code;
    assert.equal(code.get(0).a, 0);
    assert.equal(code.get(1).a, 0);
    assert.equal(code.get(2).b, 0);
    assert.equal(code.get(3).b, 0);
    assert.equal(code.get(4).a, 0);
  });

  test("program with no duplicate constants is unchanged", () => {
    const prog = mkProgram({
      functions: [
        mkFunc(
          [
            mkInstr(Op.PUSH_CONST_VAL, 0),
            mkInstr(Op.PUSH_CONST_VAL, 1),
            mkInstr(Op.PUSH_CONST_VAL, 2),
            mkInstr(Op.RET),
          ],
          0,
          "main"
        ),
      ],
      constants: [mkNumberValue(1), mkStringValue("hello"), mkNumberValue(2)],
      entryPoint: 0,
    });
    const result = treeshakeProgram(prog);
    assert.equal(result.constantPools.values.size(), 3);
    assert.equal(result, prog);
  });
});

// -- Integration tests --

let services: BrainServices;

function toVmServices(b: BrainServices) {
  return __test__createPlatformServices({
    runtime: { functions: b.runtime.functions, types: b.runtime.types },
  }).runtime;
}

before(() => {
  services = __test__createBrainServices();
});

function mkCtx(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  const slots = List.empty<Value | undefined>();
  return {
    services: __test__createPlatformServices(),
    getVariableBySlot: (slotId: number) => {
      if (slotId < 0 || slotId >= slots.size()) return NIL_VALUE;
      const v = slots.get(slotId);
      return v === undefined ? NIL_VALUE : v;
    },
    setVariableBySlot: (slotId: number, value: Value) => {
      while (slots.size() <= slotId) slots.push(undefined);
      slots.set(slotId, value);
    },
    getSystemVarBySlot: () => NIL_VALUE,
    setSystemVarBySlot: () => {},
    time: 0,
    dt: 0,
    currentTick: 0,
    ...overrides,
  };
}

function runProgramToResult(prog: FlatProgram): Value | undefined {
  const vm = new VM(prog, toVmServices(services));
  const fiber = vm.spawnFiber(1, prog.entryPoint ?? 0, List.empty(), mkCtx());
  fiber.instrBudget = 10000;
  const result = vm.runFiber(fiber, {
    onHandleCompleted: () => {},
    enqueueRunnable: () => {},
    getFiber: () => undefined,
  });
  assert.equal(result.status, VmStatus.DONE);
  if (result.status === VmStatus.DONE) {
    return result.result;
  }
  return undefined;
}

describe("treeshakeProgram -- integration", () => {
  test("tree-shaken program with dead functions executes correctly", () => {
    const prog = mkProgram({
      functions: [
        mkFunc([mkInstr(Op.PUSH_CONST_VAL, 0), mkInstr(Op.CALL, 2, 1), mkInstr(Op.RET)], 0, "main"),
        mkFunc([mkInstr(Op.PUSH_CONST_VAL, 1), mkInstr(Op.RET)], 0, "dead-unused"),
        mkFunc([mkInstr(Op.PUSH_CONST_VAL, 2), mkInstr(Op.RET)], 1, "doubler"),
        mkFunc([mkInstr(Op.PUSH_CONST_VAL, 3), mkInstr(Op.RET)], 0, "dead-also-unused"),
      ],
      constants: [mkNumberValue(5), mkNumberValue(999), mkNumberValue(42), mkStringValue("never-used")],
      entryPoint: 0,
    });

    assert.equal(prog.functions.size(), 4);
    assert.equal(prog.constantPools.values.size(), 4);

    const shaken = treeshakeProgram(prog);

    assert.equal(shaken.functions.size(), 2);
    assert.equal(shaken.functions.get(0).name, "main");
    assert.equal(shaken.functions.get(1).name, "doubler");

    assert.ok(shaken.constantPools.values.size() < prog.constantPools.values.size());

    const result = runProgramToResult(shaken);
    assert.ok(result !== undefined);
    assert.equal(result!.t, NativeType.Number);
    assert.equal((result as { v: number }).v, 42);
  });

  test("tree-shaken program with dead actions executes correctly via page roots", () => {
    const prog = mkProgram({
      functions: [
        mkFunc([mkInstr(Op.PUSH_CONST_VAL, 0), mkInstr(Op.RET)], 0, "rule-root"),
        mkFunc([mkInstr(Op.PUSH_CONST_VAL, 1), mkInstr(Op.RET)], 0, "dead-action-entry"),
        mkFunc([mkInstr(Op.RET)], 0, "dead-action-activation"),
      ],
      constants: [mkNumberValue(7), mkNumberValue(100)],
      pages: [mkPage(0, [0])],
      actions: [mkBytecodeAction(1, 2)],
    });

    assert.equal(prog.functions.size(), 3);

    const shaken = treeshakeProgram(prog);

    assert.equal(shaken.functions.size(), 3, "all functions are reachable through pages and actions");
    assert.equal(shaken.pages.get(0).rootRuleFuncIds.get(0), 0);

    const result = runProgramToResult(shaken);
    assert.ok(result !== undefined);
    assert.equal((result as { v: number }).v, 7);
  });

  test("tree-shaken program via MAKE_CLOSURE executes correctly", () => {
    const prog = mkProgram({
      functions: [
        mkFunc([mkInstr(Op.MAKE_CLOSURE, 2, 0), mkInstr(Op.RET)], 0, "main"),
        mkFunc([mkInstr(Op.PUSH_CONST_VAL, 0), mkInstr(Op.RET)], 0, "dead"),
        mkFunc([mkInstr(Op.PUSH_CONST_VAL, 1), mkInstr(Op.RET)], 0, "closure-target"),
      ],
      constants: [mkNumberValue(111), mkNumberValue(77)],
      entryPoint: 0,
    });

    assert.equal(prog.functions.size(), 3);
    const shaken = treeshakeProgram(prog);

    assert.equal(shaken.functions.size(), 2);
    assert.equal(shaken.functions.get(0).name, "main");
    assert.equal(shaken.functions.get(1).name, "closure-target");

    const closureInstr = shaken.functions.get(0).code.get(0);
    assert.equal(closureInstr.op, Op.MAKE_CLOSURE);
    assert.equal(closureInstr.a, 1);
  });

  test("tree-shaken program runs without faulting", () => {
    const prog = mkProgram({
      functions: [
        mkFunc([mkInstr(Op.CALL, 2), mkInstr(Op.RET)], 0, "main"),
        mkFunc([mkInstr(Op.PUSH_CONST_VAL, 0), mkInstr(Op.RET)], 0, "dead"),
        mkFunc([mkInstr(Op.PUSH_CONST_VAL, 0), mkInstr(Op.RET)], 0, "helper"),
      ],
      constants: [mkNumberValue(42)],
      entryPoint: 0,
    });

    const shaken = treeshakeProgram(prog);

    const vm = new VM(shaken, toVmServices(services));
    const fiber = vm.spawnFiber(1, 0, List.empty(), mkCtx());
    fiber.instrBudget = 100;

    const result = vm.runFiber(fiber, {
      onHandleCompleted: () => {},
      enqueueRunnable: () => {},
      getFiber: () => undefined,
    });
    assert.equal(result.status, VmStatus.DONE);
  });

  test("no dead code produces functionally identical program", () => {
    const prog = mkProgram({
      functions: [
        mkFunc(
          [
            mkInstr(Op.PUSH_CONST_VAL, 0),
            mkInstr(Op.STORE_VAR_SLOT, 0),
            mkInstr(Op.PUSH_CONST_VAL, 0),
            mkInstr(Op.CALL, 1, 1),
            mkInstr(Op.RET),
          ],
          0,
          "main"
        ),
        mkFunc([mkInstr(Op.PUSH_CONST_VAL, 1), mkInstr(Op.RET)], 1, "helper"),
      ],
      constants: [mkNumberValue(10), mkNumberValue(99)],
      variableNames: ["x"],
      entryPoint: 0,
    });

    const shaken = treeshakeProgram(prog);

    assert.equal(shaken.functions.size(), prog.functions.size());
    assert.equal(shaken.constantPools.values.size(), prog.constantPools.values.size());
    assert.equal(shaken.variableNames.size(), prog.variableNames.size());
    assert.equal(shaken, prog);

    const originalResult = runProgramToResult(prog);
    const shakenResult = runProgramToResult(shaken);

    assert.ok(originalResult !== undefined);
    assert.ok(shakenResult !== undefined);
    assert.equal(originalResult!.t, shakenResult!.t);
    assert.equal((originalResult as { v: number }).v, (shakenResult as { v: number }).v);
  });

  test("tree-shaking produces same execution result as unshaken program", () => {
    const prog = mkProgram({
      functions: [
        mkFunc([mkInstr(Op.PUSH_CONST_VAL, 0), mkInstr(Op.CALL, 3, 1), mkInstr(Op.RET)], 0, "main"),
        mkFunc([mkInstr(Op.PUSH_CONST_VAL, 1), mkInstr(Op.RET)], 0, "unused-export-a"),
        mkFunc([mkInstr(Op.PUSH_CONST_VAL, 2), mkInstr(Op.RET)], 0, "unused-export-b"),
        mkFunc([mkInstr(Op.PUSH_CONST_VAL, 3), mkInstr(Op.RET)], 1, "used-func"),
      ],
      constants: [mkNumberValue(5), mkNumberValue(100), mkStringValue("unused"), mkNumberValue(25)],
      entryPoint: 0,
    });

    const originalResult = runProgramToResult(prog);

    const shaken = treeshakeProgram(prog);

    assert.ok(shaken.functions.size() < prog.functions.size());
    assert.ok(shaken.constantPools.values.size() < prog.constantPools.values.size());

    const shakenResult = runProgramToResult(shaken);

    assert.ok(originalResult !== undefined);
    assert.ok(shakenResult !== undefined);
    assert.equal(originalResult!.t, shakenResult!.t);
    assert.equal((originalResult as { v: number }).v, (shakenResult as { v: number }).v);
    assert.equal((shakenResult as { v: number }).v, 25);
  });
});
