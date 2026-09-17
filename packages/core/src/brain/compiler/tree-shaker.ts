import { Dict } from "../../platform/dict";
import { Error } from "../../platform/error";
import { List } from "../../platform/list";
import { logger } from "../../platform/logger";
import { UniqueSet } from "../../platform/uniqueset";
import type { ConstantPools, FunctionBytecode, Instr } from "../../runtime/bytecode";
import { Op } from "../../runtime/bytecode";
import type { BytecodeExecutableAction } from "../../runtime/context";
import type { LinkedBrainProgram, PageMetadata } from "../../runtime/host-bindings";
import type { Program, ProgramTypeEntry, SystemRegistration } from "../../runtime/program";
import { anyVariableInit, NO_VARIABLE_INIT, remapProgramTypeEntry, variableInitAt } from "../../runtime/program";
import { NativeType } from "../../runtime/type-defs";
import type { Value } from "../../runtime/value";
import { forEachValueTypeId, isFunctionValue } from "../../runtime/value";

function requireActions(program: Program): List<BytecodeExecutableAction> {
  const actions = program.actions;
  if (!actions) {
    throw new Error("treeshakeProgram: program has no linked actions");
  }
  return actions;
}

function markReachableFunctions(program: Program, pages: List<PageMetadata>): UniqueSet<number> {
  const reachable = new UniqueSet<number>();
  const worklist = List.empty<number>();

  function enqueue(funcId: number): void {
    if (funcId >= 0 && funcId < program.functions.size() && !reachable.has(funcId)) {
      reachable.add(funcId);
      worklist.push(funcId);
    }
  }

  if (program.entryPoint !== undefined) {
    enqueue(program.entryPoint);
  }

  for (let p = 0; p < pages.size(); p++) {
    const page = pages.get(p);
    for (let r = 0; r < page.rootRuleFuncIds.size(); r++) {
      enqueue(page.rootRuleFuncIds.get(r));
    }
  }

  const actions = requireActions(program);
  for (let a = 0; a < actions.size(); a++) {
    const action = actions.get(a);
    enqueue(action.entryFuncId);
    if (action.initializerFuncId !== undefined) {
      enqueue(action.initializerFuncId);
    }
    if (action.activationFuncId !== undefined) {
      enqueue(action.activationFuncId);
    }
    if (action.deactivationFuncId !== undefined) {
      enqueue(action.deactivationFuncId);
    }
  }

  function markFuncIdsInValue(v: Value): void {
    if (!isFunctionValue(v)) return;
    enqueue(v.funcId);
    if (v.captures) {
      for (let i = 0; i < v.captures.size(); i++) {
        markFuncIdsInValue(v.captures.get(i));
      }
    }
  }

  // A reachable LOAD/STORE_SYSTEM_VAR for a System's store slot marks that
  // System's init and think wrappers as reachable.
  const systemBySlot = new Dict<number, SystemRegistration>();
  const systems = program.systems;
  if (systems) {
    for (let i = 0; i < systems.size(); i++) {
      const sys = systems.get(i)!;
      systemBySlot.set(sys.storeSlot, sys);
    }
  }

  while (worklist.size() > 0) {
    const funcId = worklist.pop()!;
    const fn = program.functions.get(funcId);
    const code = fn.code;

    for (let i = 0; i < code.size(); i++) {
      const ins = code.get(i);
      if (ins.op === Op.CALL || ins.op === Op.MAKE_CLOSURE || ins.op === Op.SPAWN_RULE) {
        if (ins.a !== undefined) {
          enqueue(ins.a);
        }
      }
      if (ins.op === Op.PUSH_CONST_VAL && ins.a !== undefined) {
        const constVal = program.constantPools.values.get(ins.a);
        markFuncIdsInValue(constVal);
      }
      if ((ins.op === Op.LOAD_SYSTEM_VAR || ins.op === Op.STORE_SYSTEM_VAR) && ins.a !== undefined) {
        const sys = systemBySlot.get(ins.a);
        if (sys) {
          if (sys.initFuncId !== undefined) enqueue(sys.initFuncId);
          if (sys.thinkFuncId !== undefined) enqueue(sys.thinkFuncId);
        }
      }
    }
  }

  return reachable;
}

interface ReachableConstSets {
  values: UniqueSet<number>;
  numbers: UniqueSet<number>;
  strings: UniqueSet<number>;
  types: UniqueSet<number>;
}

function markReachableConstants(
  program: Program,
  reachableFuncs: UniqueSet<number>,
  reachableVars: UniqueSet<number>,
  pinnedTypeIndices: UniqueSet<number> | undefined
): ReachableConstSets {
  const values = new UniqueSet<number>();
  const numbers = new UniqueSet<number>();
  const strings = new UniqueSet<number>();
  const types = new UniqueSet<number>();

  for (let i = 0; i < program.functions.size(); i++) {
    if (!reachableFuncs.has(i)) continue;
    const fn = program.functions.get(i);
    if (fn.injectCtxTypeIdx !== undefined) {
      types.add(fn.injectCtxTypeIdx);
    }
    for (let j = 0; j < fn.code.size(); j++) {
      const ins = fn.code.get(j);
      if (ins.op === Op.PUSH_CONST_VAL && ins.a !== undefined) {
        values.add(ins.a);
      }
      if (ins.op === Op.PUSH_CONST_NUM && ins.a !== undefined) {
        numbers.add(ins.a);
      }
      if (ins.op === Op.PUSH_CONST_STR && ins.a !== undefined) {
        strings.add(ins.a);
      }
      if (ins.op === Op.INSTANCE_OF && ins.a !== undefined) {
        types.add(ins.a);
      }
      if (
        (ins.op === Op.LIST_NEW ||
          ins.op === Op.MAP_NEW ||
          ins.op === Op.STRUCT_NEW ||
          ins.op === Op.STRUCT_COPY_EXCEPT) &&
        ins.b !== undefined
      ) {
        types.add(ins.b);
      }
    }
  }

  // A surviving variable slot keeps its starting value alive even though no
  // instruction pushes it.
  for (let i = 0; i < program.variableNames.size(); i++) {
    if (!reachableVars.has(i)) continue;
    const init = variableInitAt(program, i);
    if (init !== NO_VARIABLE_INIT) {
      values.add(init);
    }
  }

  // Pinned entries back struct values host actions construct at runtime; no
  // instruction operand references them, so they root type reachability
  // directly.
  if (pinnedTypeIndices !== undefined) {
    pinnedTypeIndices.forEach((idx) => {
      types.add(idx);
    });
  }

  expandReachableTypes(program, values, types);

  return { values, numbers, strings, types };
}

/**
 * Grow `types` to cover the type-table entries referenced by reachable
 * constant values (recursively through nested values) and, transitively, the
 * structural children of every reachable entry. Children precede parents in
 * the table, so one descending pass closes the child relation.
 */
function expandReachableTypes(program: Program, reachableValues: UniqueSet<number>, types: UniqueSet<number>): void {
  const typeTable = program.types ?? List.empty<ProgramTypeEntry>();
  if (typeTable.size() === 0) return;

  const indexByTypeId = Dict.empty<string, number>();
  for (let i = 0; i < typeTable.size(); i++) {
    indexByTypeId.set(typeTable.get(i)!.typeId, i);
  }

  for (let i = 0; i < program.constantPools.values.size(); i++) {
    if (!reachableValues.has(i)) continue;
    forEachValueTypeId(program.constantPools.values.get(i), (typeId) => {
      const idx = indexByTypeId.get(typeId);
      if (idx !== undefined) {
        types.add(idx);
      }
    });
  }

  for (let i = typeTable.size() - 1; i >= 0; i--) {
    if (!types.has(i)) continue;
    remapProgramTypeEntry(typeTable.get(i)!, (child) => {
      types.add(child);
      return child;
    });
  }
}

function markReachableVariableNames(program: Program, reachableFuncs: UniqueSet<number>): UniqueSet<number> {
  const reachable = new UniqueSet<number>();

  for (let i = 0; i < program.functions.size(); i++) {
    if (!reachableFuncs.has(i)) continue;
    const fn = program.functions.get(i);
    for (let j = 0; j < fn.code.size(); j++) {
      const ins = fn.code.get(j);
      if ((ins.op === Op.LOAD_VAR_SLOT || ins.op === Op.STORE_VAR_SLOT) && ins.a !== undefined) {
        reachable.add(ins.a);
      }
    }
  }

  return reachable;
}

function markReachableSystemSlots(program: Program, reachableFuncs: UniqueSet<number>): UniqueSet<number> {
  const reachable = new UniqueSet<number>();

  for (let i = 0; i < program.functions.size(); i++) {
    if (!reachableFuncs.has(i)) continue;
    const fn = program.functions.get(i);
    for (let j = 0; j < fn.code.size(); j++) {
      const ins = fn.code.get(j);
      if ((ins.op === Op.LOAD_SYSTEM_VAR || ins.op === Op.STORE_SYSTEM_VAR) && ins.a !== undefined) {
        reachable.add(ins.a);
      }
    }
  }

  return reachable;
}

function buildRemapTable(totalItems: number, reachable: UniqueSet<number>): Dict<number, number> {
  const remap = Dict.empty<number, number>();
  let nextId = 0;
  for (let i = 0; i < totalItems; i++) {
    if (reachable.has(i)) {
      remap.set(i, nextId++);
    }
  }
  return remap;
}

function remapFuncIdInValue(v: Value, remap: Dict<number, number>): Value {
  if (!isFunctionValue(v)) return v;
  const newFuncId = remap.get(v.funcId);
  if (newFuncId === undefined) return v;
  if (!v.captures) {
    return { ...v, funcId: newFuncId };
  }
  const captures = List.empty<Value>();
  for (let i = 0; i < v.captures.size(); i++) {
    captures.push(remapFuncIdInValue(v.captures.get(i), remap));
  }
  return { ...v, funcId: newFuncId, captures };
}

interface ConstRemaps {
  values: Dict<number, number>;
  numbers: Dict<number, number>;
  strings: Dict<number, number>;
  types: Dict<number, number>;
}

function remapInstruction(
  ins: Instr,
  funcRemap: Dict<number, number>,
  consts: ConstRemaps,
  varRemap: Dict<number, number>,
  systemSlotRemap: Dict<number, number>
): Instr {
  const op = ins.op;

  if (op === Op.LOAD_SYSTEM_VAR || op === Op.STORE_SYSTEM_VAR) {
    if (ins.a !== undefined) {
      const newA = systemSlotRemap.get(ins.a) ?? ins.a;
      if (newA !== ins.a) return { ...ins, a: newA };
    }
    return ins;
  }

  if (op === Op.CALL || op === Op.MAKE_CLOSURE || op === Op.SPAWN_RULE) {
    if (ins.a !== undefined) {
      const newA = funcRemap.get(ins.a) ?? ins.a;
      if (newA !== ins.a) return { ...ins, a: newA };
    }
    return ins;
  }

  if (op === Op.PUSH_CONST_VAL) {
    if (ins.a !== undefined) {
      const newA = consts.values.get(ins.a) ?? ins.a;
      if (newA !== ins.a) return { ...ins, a: newA };
    }
    return ins;
  }

  if (op === Op.PUSH_CONST_NUM) {
    if (ins.a !== undefined) {
      const newA = consts.numbers.get(ins.a) ?? ins.a;
      if (newA !== ins.a) return { ...ins, a: newA };
    }
    return ins;
  }

  if (op === Op.PUSH_CONST_STR) {
    if (ins.a !== undefined) {
      const newA = consts.strings.get(ins.a) ?? ins.a;
      if (newA !== ins.a) return { ...ins, a: newA };
    }
    return ins;
  }

  if (op === Op.INSTANCE_OF) {
    if (ins.a !== undefined) {
      const newA = consts.types.get(ins.a) ?? ins.a;
      if (newA !== ins.a) return { ...ins, a: newA };
    }
    return ins;
  }

  if (op === Op.LIST_NEW || op === Op.MAP_NEW || op === Op.STRUCT_NEW || op === Op.STRUCT_COPY_EXCEPT) {
    if (ins.b !== undefined) {
      const newB = consts.types.get(ins.b) ?? ins.b;
      if (newB !== ins.b) return { ...ins, b: newB };
    }
    return ins;
  }

  if (op === Op.LOAD_VAR_SLOT || op === Op.STORE_VAR_SLOT) {
    if (ins.a !== undefined) {
      const newA = varRemap.get(ins.a) ?? ins.a;
      if (newA !== ins.a) return { ...ins, a: newA };
    }
    return ins;
  }

  return ins;
}

function constantKey(v: Value): string | undefined {
  switch (v.t) {
    case NativeType.Unknown:
      return "U";
    case NativeType.Void:
      return "V";
    case NativeType.Nil:
      return "N";
    case NativeType.Boolean:
      return `B:${v.v}`;
    case NativeType.Number:
      return `D:${v.v}`;
    case NativeType.String:
      return `S:${v.v}`;
    case NativeType.Enum:
      return `E:${v.typeId}:${v.v}`;
    case NativeType.Function: {
      let key = `F:${v.funcId}`;
      if (v.captures) {
        key += "[";
        for (let i = 0; i < v.captures.size(); i++) {
          const capKey = constantKey(v.captures.get(i));
          if (capKey === undefined) return undefined;
          if (i > 0) key += ",";
          key += capKey;
        }
        key += "]";
      }
      return key;
    }
    default:
      return undefined;
  }
}

interface DedupResult {
  functions: List<FunctionBytecode>;
  constantPools: ConstantPools;
  types: List<ProgramTypeEntry>;
  /** Old-to-new value-pool index map, for indices the instructions do not carry. */
  valueRemap: Dict<number, number>;
}

/**
 * Rewrite each starting-value pool index through `valueRemap`. Returns
 * `undefined` when `inits` is absent.
 */
function remapVariableInits(
  inits: List<number> | undefined,
  valueRemap: Dict<number, number>
): List<number> | undefined {
  if (inits === undefined) return undefined;
  const remapped = List.empty<number>();
  for (let i = 0; i < inits.size(); i++) {
    const init = inits.get(i);
    remapped.push(init === NO_VARIABLE_INIT ? NO_VARIABLE_INIT : (valueRemap.get(init) ?? init));
  }
  return remapped;
}

function dedupValues(constants: List<Value>): {
  newConstants: List<Value>;
  remap: Dict<number, number>;
  changed: boolean;
} {
  const seen = Dict.empty<string, number>();
  const remap = Dict.empty<number, number>();
  const newConstants = List.empty<Value>();
  let changed = false;
  for (let i = 0; i < constants.size(); i++) {
    const v = constants.get(i);
    const key = constantKey(v);
    if (key !== undefined) {
      const existing = seen.get(key);
      if (existing !== undefined) {
        remap.set(i, existing);
        changed = true;
        continue;
      }
      seen.set(key, newConstants.size());
    }
    remap.set(i, newConstants.size());
    newConstants.push(v);
  }
  return { newConstants, remap, changed };
}

function dedupNumbers(constants: List<number>): {
  newConstants: List<number>;
  remap: Dict<number, number>;
  changed: boolean;
} {
  const seen = Dict.empty<number, number>();
  const remap = Dict.empty<number, number>();
  const newConstants = List.empty<number>();
  let changed = false;
  for (let i = 0; i < constants.size(); i++) {
    const v = constants.get(i)!;
    const existing = seen.get(v);
    if (existing !== undefined) {
      remap.set(i, existing);
      changed = true;
      continue;
    }
    seen.set(v, newConstants.size());
    remap.set(i, newConstants.size());
    newConstants.push(v);
  }
  return { newConstants, remap, changed };
}

function dedupStrings(constants: List<string>): {
  newConstants: List<string>;
  remap: Dict<number, number>;
  changed: boolean;
} {
  const seen = Dict.empty<string, number>();
  const remap = Dict.empty<number, number>();
  const newConstants = List.empty<string>();
  let changed = false;
  for (let i = 0; i < constants.size(); i++) {
    const v = constants.get(i)!;
    const existing = seen.get(v);
    if (existing !== undefined) {
      remap.set(i, existing);
      changed = true;
      continue;
    }
    seen.set(v, newConstants.size());
    remap.set(i, newConstants.size());
    newConstants.push(v);
  }
  return { newConstants, remap, changed };
}

function dedupTypes(types: List<ProgramTypeEntry>): {
  newTypes: List<ProgramTypeEntry>;
  remap: Dict<number, number>;
  changed: boolean;
} {
  const seen = Dict.empty<string, number>();
  const remap = Dict.empty<number, number>();
  const newTypes = List.empty<ProgramTypeEntry>();
  let changed = false;
  for (let i = 0; i < types.size(); i++) {
    const entry = types.get(i)!;
    const existing = seen.get(entry.typeId);
    if (existing !== undefined) {
      remap.set(i, existing);
      changed = true;
      continue;
    }
    // Children precede their parent, so their final indices are already in
    // the remap when the parent is rewritten.
    const rewritten = remapProgramTypeEntry(entry, (child) => remap.get(child) ?? child);
    if (rewritten !== entry) changed = true;
    seen.set(entry.typeId, newTypes.size());
    remap.set(i, newTypes.size());
    newTypes.push(rewritten);
  }
  return { newTypes, remap, changed };
}

function deduplicateConstants(
  functions: List<FunctionBytecode>,
  pools: ConstantPools,
  types: List<ProgramTypeEntry>
): DedupResult | undefined {
  const r = dedupValues(pools.values);
  const n = dedupNumbers(pools.numbers);
  const s = dedupStrings(pools.strings);
  const t = dedupTypes(types);

  if (!r.changed && !n.changed && !s.changed && !t.changed) return undefined;

  if (r.changed) {
    logger.debug(
      `[tree-shaker] deduplicated ${pools.values.size() - r.newConstants.size()}/${pools.values.size()} constants`
    );
  }
  if (n.changed) {
    logger.debug(
      `[tree-shaker] deduplicated ${pools.numbers.size() - n.newConstants.size()}/${pools.numbers.size()} number constants`
    );
  }
  if (s.changed) {
    logger.debug(
      `[tree-shaker] deduplicated ${pools.strings.size() - s.newConstants.size()}/${pools.strings.size()} string constants`
    );
  }
  if (t.changed) {
    logger.debug(`[tree-shaker] deduplicated ${types.size() - t.newTypes.size()}/${types.size()} type-table entries`);
  }

  const remaps: ConstRemaps = { values: r.remap, numbers: n.remap, strings: s.remap, types: t.remap };

  const newFunctions = List.empty<FunctionBytecode>();
  for (let i = 0; i < functions.size(); i++) {
    const fn = functions.get(i);
    const newCode = List.empty<Instr>();
    let changed = false;
    for (let j = 0; j < fn.code.size(); j++) {
      const ins = fn.code.get(j);
      const remapped = remapInstructionForDedup(ins, remaps);
      if (remapped !== ins) changed = true;
      newCode.push(remapped);
    }
    const newInjectCtxTypeIdx =
      fn.injectCtxTypeIdx !== undefined ? (t.remap.get(fn.injectCtxTypeIdx) ?? fn.injectCtxTypeIdx) : undefined;
    if (newInjectCtxTypeIdx !== fn.injectCtxTypeIdx) changed = true;
    newFunctions.push(
      changed
        ? {
            ...fn,
            code: newCode,
            ...(newInjectCtxTypeIdx === undefined ? {} : { injectCtxTypeIdx: newInjectCtxTypeIdx }),
          }
        : fn
    );
  }

  return {
    functions: newFunctions,
    constantPools: {
      numbers: n.newConstants,
      strings: s.newConstants,
      values: r.newConstants,
    },
    types: t.newTypes,
    valueRemap: r.remap,
  };
}

function remapInstructionForDedup(ins: Instr, consts: ConstRemaps): Instr {
  const op = ins.op;

  if (op === Op.PUSH_CONST_VAL) {
    if (ins.a !== undefined) {
      const newA = consts.values.get(ins.a) ?? ins.a;
      if (newA !== ins.a) return { ...ins, a: newA };
    }
    return ins;
  }

  if (op === Op.PUSH_CONST_NUM) {
    if (ins.a !== undefined) {
      const newA = consts.numbers.get(ins.a) ?? ins.a;
      if (newA !== ins.a) return { ...ins, a: newA };
    }
    return ins;
  }

  if (op === Op.PUSH_CONST_STR) {
    if (ins.a !== undefined) {
      const newA = consts.strings.get(ins.a) ?? ins.a;
      if (newA !== ins.a) return { ...ins, a: newA };
    }
    return ins;
  }

  if (op === Op.INSTANCE_OF) {
    if (ins.a !== undefined) {
      const newA = consts.types.get(ins.a) ?? ins.a;
      if (newA !== ins.a) return { ...ins, a: newA };
    }
    return ins;
  }

  if (op === Op.LIST_NEW || op === Op.MAP_NEW || op === Op.STRUCT_NEW || op === Op.STRUCT_COPY_EXCEPT) {
    if (ins.b !== undefined) {
      const newB = consts.types.get(ins.b) ?? ins.b;
      if (newB !== ins.b) return { ...ins, b: newB };
    }
    return ins;
  }

  return ins;
}

/**
 * Strip unreachable functions, constants, and variable names from `linked` and
 * dedupe constants. `pinnedTypeIndices` are type-table indices kept alive as
 * explicit reachability roots; the pins index the pre-shake table and are
 * consumed here, before any remap.
 */
export function treeshakeProgram(
  linked: LinkedBrainProgram,
  pinnedTypeIndices?: UniqueSet<number>
): LinkedBrainProgram {
  const program = linked.program;
  const programTypes = program.types ?? List.empty<ProgramTypeEntry>();
  const reachableFuncs = markReachableFunctions(program, linked.pages);
  const reachableVars = markReachableVariableNames(program, reachableFuncs);
  const reachableConsts = markReachableConstants(program, reachableFuncs, reachableVars, pinnedTypeIndices);

  const funcsDead = reachableFuncs.size() < program.functions.size();
  const valuesDead = reachableConsts.values.size() < program.constantPools.values.size();
  const numbersDead = reachableConsts.numbers.size() < program.constantPools.numbers.size();
  const stringsDead = reachableConsts.strings.size() < program.constantPools.strings.size();
  const typesDead = reachableConsts.types.size() < programTypes.size();
  const varsDead = reachableVars.size() < program.variableNames.size();

  if (!funcsDead && !valuesDead && !numbersDead && !stringsDead && !typesDead && !varsDead) {
    const dedup = deduplicateConstants(program.functions, program.constantPools, programTypes);
    if (dedup) {
      const dedupedInits = remapVariableInits(program.variableInitValues, dedup.valueRemap);
      return {
        program: {
          ...program,
          functions: dedup.functions,
          constantPools: dedup.constantPools,
          types: dedup.types,
          ...(dedupedInits === undefined ? {} : { variableInitValues: dedupedInits }),
        },
        ruleIndex: linked.ruleIndex,
        pages: linked.pages,
      };
    }
    return linked;
  }

  if (funcsDead) {
    const shakenNames: string[] = [];
    for (let i = 0; i < program.functions.size(); i++) {
      if (!reachableFuncs.has(i)) {
        const fn = program.functions.get(i);
        shakenNames.push(fn.name ?? `<func#${i}>`);
      }
    }
    const removed = program.functions.size() - reachableFuncs.size();
    logger.debug(`[tree-shaker] removed ${removed}/${program.functions.size()} functions: ${shakenNames.join(", ")}`);
  }

  if (valuesDead) {
    const removed = program.constantPools.values.size() - reachableConsts.values.size();
    logger.debug(`[tree-shaker] removed ${removed}/${program.constantPools.values.size()} constants`);
  }
  if (numbersDead) {
    const removed = program.constantPools.numbers.size() - reachableConsts.numbers.size();
    logger.debug(`[tree-shaker] removed ${removed}/${program.constantPools.numbers.size()} number constants`);
  }
  if (stringsDead) {
    const removed = program.constantPools.strings.size() - reachableConsts.strings.size();
    logger.debug(`[tree-shaker] removed ${removed}/${program.constantPools.strings.size()} string constants`);
  }
  if (typesDead) {
    const removed = programTypes.size() - reachableConsts.types.size();
    logger.debug(`[tree-shaker] removed ${removed}/${programTypes.size()} type-table entries`);
  }

  if (varsDead) {
    const shakenVarNames: string[] = [];
    for (let i = 0; i < program.variableNames.size(); i++) {
      if (!reachableVars.has(i)) {
        shakenVarNames.push(program.variableNames.get(i));
      }
    }
    const removed = program.variableNames.size() - reachableVars.size();
    logger.debug(
      `[tree-shaker] removed ${removed}/${program.variableNames.size()} variable names: ${shakenVarNames.join(", ")}`
    );
  }

  const funcRemap = buildRemapTable(program.functions.size(), reachableFuncs);
  const constRemap: ConstRemaps = {
    values: buildRemapTable(program.constantPools.values.size(), reachableConsts.values),
    numbers: buildRemapTable(program.constantPools.numbers.size(), reachableConsts.numbers),
    strings: buildRemapTable(program.constantPools.strings.size(), reachableConsts.strings),
    types: buildRemapTable(programTypes.size(), reachableConsts.types),
  };
  const varRemap = buildRemapTable(program.variableNames.size(), reachableVars);
  const reachableSystemSlots = markReachableSystemSlots(program, reachableFuncs);
  const systemSlotRemap = buildRemapTable(program.systems?.size() ?? 0, reachableSystemSlots);

  const newFunctions = List.empty<FunctionBytecode>();
  for (let i = 0; i < program.functions.size(); i++) {
    if (!reachableFuncs.has(i)) continue;
    const fn = program.functions.get(i);
    const newCode = List.empty<Instr>();
    for (let j = 0; j < fn.code.size(); j++) {
      newCode.push(remapInstruction(fn.code.get(j), funcRemap, constRemap, varRemap, systemSlotRemap));
    }
    newFunctions.push({
      ...fn,
      code: newCode,
      ...(fn.injectCtxTypeIdx === undefined
        ? {}
        : { injectCtxTypeIdx: constRemap.types.get(fn.injectCtxTypeIdx) ?? fn.injectCtxTypeIdx }),
    });
  }

  const newTypes = List.empty<ProgramTypeEntry>();
  for (let i = 0; i < programTypes.size(); i++) {
    if (!reachableConsts.types.has(i)) continue;
    newTypes.push(remapProgramTypeEntry(programTypes.get(i)!, (child) => constRemap.types.get(child) ?? child));
  }

  const newValues = List.empty<Value>();
  for (let i = 0; i < program.constantPools.values.size(); i++) {
    if (!reachableConsts.values.has(i)) continue;
    newValues.push(remapFuncIdInValue(program.constantPools.values.get(i), funcRemap));
  }

  const newNumbers = List.empty<number>();
  for (let i = 0; i < program.constantPools.numbers.size(); i++) {
    if (!reachableConsts.numbers.has(i)) continue;
    newNumbers.push(program.constantPools.numbers.get(i)!);
  }

  const newStrings = List.empty<string>();
  for (let i = 0; i < program.constantPools.strings.size(); i++) {
    if (!reachableConsts.strings.has(i)) continue;
    newStrings.push(program.constantPools.strings.get(i)!);
  }

  const newVariableNames = List.empty<string>();
  const newVariableInitValues = List.empty<number>();
  for (let i = 0; i < program.variableNames.size(); i++) {
    if (!reachableVars.has(i)) continue;
    newVariableNames.push(program.variableNames.get(i));
    const init = variableInitAt(program, i);
    newVariableInitValues.push(init === NO_VARIABLE_INIT ? NO_VARIABLE_INIT : (constRemap.values.get(init) ?? init));
  }

  const newEntryPoint = program.entryPoint !== undefined ? funcRemap.get(program.entryPoint) : undefined;

  const newRuleIndex = Dict.empty<string, number>();
  linked.ruleIndex.forEach((funcId, key) => {
    const newId = funcRemap.get(funcId);
    if (newId !== undefined) {
      newRuleIndex.set(key, newId);
    }
  });

  const newPages = List.empty<PageMetadata>();
  for (let p = 0; p < linked.pages.size(); p++) {
    const page = linked.pages.get(p);
    const newRootRuleFuncIds = List.empty<number>();
    for (let r = 0; r < page.rootRuleFuncIds.size(); r++) {
      const newId = funcRemap.get(page.rootRuleFuncIds.get(r));
      if (newId !== undefined) {
        newRootRuleFuncIds.push(newId);
      }
    }
    newPages.push({ ...page, rootRuleFuncIds: newRootRuleFuncIds });
  }

  const sourceActions = requireActions(program);
  const newActions = List.empty<BytecodeExecutableAction>();
  for (let a = 0; a < sourceActions.size(); a++) {
    const action = sourceActions.get(a);
    const newEntry = funcRemap.get(action.entryFuncId);
    const newInitializer = action.initializerFuncId !== undefined ? funcRemap.get(action.initializerFuncId) : undefined;
    const newActivation = action.activationFuncId !== undefined ? funcRemap.get(action.activationFuncId) : undefined;
    const newDeactivation =
      action.deactivationFuncId !== undefined ? funcRemap.get(action.deactivationFuncId) : undefined;
    const remapped: BytecodeExecutableAction = {
      ...action,
      entryFuncId: newEntry ?? action.entryFuncId,
    };
    if (newInitializer !== undefined) {
      remapped.initializerFuncId = newInitializer;
    }
    if (newActivation !== undefined) {
      remapped.activationFuncId = newActivation;
    }
    if (newDeactivation !== undefined) {
      remapped.deactivationFuncId = newDeactivation;
    }
    newActions.push(remapped);
  }

  let resultFunctions = newFunctions;
  let resultPools: ConstantPools = {
    numbers: newNumbers,
    strings: newStrings,
    values: newValues,
  };
  let resultTypes = newTypes;

  let resultVariableInits = newVariableInitValues;
  const dedup = deduplicateConstants(newFunctions, resultPools, newTypes);
  if (dedup) {
    resultFunctions = dedup.functions;
    resultPools = dedup.constantPools;
    resultTypes = dedup.types;
    resultVariableInits = remapVariableInits(newVariableInitValues, dedup.valueRemap) ?? newVariableInitValues;
  }

  const newRuleFuncIds = new UniqueSet<number>();
  if (program.ruleFuncIds !== undefined) {
    program.ruleFuncIds.forEach((funcId) => {
      const newId = funcRemap.get(funcId);
      if (newId !== undefined) {
        newRuleFuncIds.add(newId);
      }
    });
  }

  const newRuleAncestors = Dict.empty<number, number>();
  if (program.ruleAncestors !== undefined) {
    program.ruleAncestors.forEach((parentFuncId, childFuncId) => {
      const newChild = funcRemap.get(childFuncId);
      const newParent = funcRemap.get(parentFuncId);
      if (newChild !== undefined && newParent !== undefined) {
        newRuleAncestors.set(newChild, newParent);
      }
    });
  }

  // Keep only Systems whose store slot survives, compacting slots and remapping
  // their wrapper func ids. A System whose slot no reachable code references is
  // dropped (its wrappers are already unreachable and pruned above).
  let newSystems: List<SystemRegistration> | undefined;
  if (program.systems !== undefined) {
    const kept = List.empty<SystemRegistration>();
    for (let i = 0; i < program.systems.size(); i++) {
      const sys = program.systems.get(i)!;
      const newSlot = systemSlotRemap.get(sys.storeSlot);
      if (newSlot === undefined) continue;
      kept.push({
        name: sys.name,
        storeSlot: newSlot,
        initFuncId: sys.initFuncId !== undefined ? funcRemap.get(sys.initFuncId) : undefined,
        thinkFuncId: sys.thinkFuncId !== undefined ? funcRemap.get(sys.thinkFuncId) : undefined,
      });
    }
    newSystems = kept.isEmpty() ? undefined : kept;
  }

  return {
    program: {
      version: program.version,
      functions: resultFunctions,
      constantPools: resultPools,
      types: resultTypes,
      variableNames: newVariableNames,
      ...(anyVariableInit(resultVariableInits) ? { variableInitValues: resultVariableInits } : {}),
      entryPoint: newEntryPoint,
      actions: newActions,
      ruleFuncIds: newRuleFuncIds,
      ruleAncestors: newRuleAncestors,
      systems: newSystems,
    },
    ruleIndex: newRuleIndex,
    pages: newPages,
  };
}
