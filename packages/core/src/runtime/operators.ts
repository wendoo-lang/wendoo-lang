import type { BrainServices } from "../brain/services";
import { Dict } from "../platform/dict";
import { Error } from "../platform/error";
import { List, type ReadonlyList } from "../platform/list";
import { MathOps } from "../platform/math";
import { CoreFuncId } from "./abi-ids";
import type { ExecutionContext } from "./context";
import { CoreTypeIds } from "./core-types";
import { BrainFunctionEntry, type IFunctionRegistry, mkCallDef } from "./function-defs";
import {
  CoreOpId,
  type IOperatorOverloads,
  type IOperatorTable,
  type IRegisteredOperator,
  type OpId,
  type OpOverload,
  type OpParse,
  type OpSpec,
} from "./operator-defs";
import { NativeType, type TypeId } from "./type-defs";
import {
  type BooleanValue,
  FALSE_VALUE,
  isEnumValue,
  mkBooleanValue,
  mkNumberValue,
  NIL_VALUE,
  type NumberValue,
  type StringValue,
  type Value,
} from "./value";
import { HostAsyncFn, type HostFn } from "./vm-types";

/**
 * Operator precedence and parsing information for core operators.
 * Maps operator IDs to their fixity (prefix/infix), precedence level, and associativity.
 * Higher precedence values bind more tightly.
 */
const Precedence: { [key: string]: OpParse } = {
  // ---------------------------------------------------------------------------
  // Precedence (higher binds tighter), matching JS operator precedence.
  //
  // 150: prefix unary (not, neg, bitnot)
  // 140: **
  // 130: * / %
  // 120: + -
  // 110: << >>
  // 100: < <= > >=
  //  90: == !=
  //  80: &
  //  70: ^
  //  60: |
  //  50: &&
  //  40: ||
  //  10: assign
  // ---------------------------------------------------------------------------
  [CoreOpId.Not]: { fixity: "prefix", precedence: 150 },
  [CoreOpId.Negate]: { fixity: "prefix", precedence: 150 },
  [CoreOpId.BitwiseNot]: { fixity: "prefix", precedence: 150 },
  [CoreOpId.Power]: { fixity: "infix", precedence: 140, assoc: "right" },
  [CoreOpId.Multiply]: { fixity: "infix", precedence: 130, assoc: "left" },
  [CoreOpId.Divide]: { fixity: "infix", precedence: 130, assoc: "left" },
  [CoreOpId.Modulo]: { fixity: "infix", precedence: 130, assoc: "left" },
  [CoreOpId.Add]: { fixity: "infix", precedence: 120, assoc: "left" },
  [CoreOpId.Subtract]: { fixity: "infix", precedence: 120, assoc: "left" },
  [CoreOpId.LeftShift]: { fixity: "infix", precedence: 110, assoc: "left" },
  [CoreOpId.RightShift]: { fixity: "infix", precedence: 110, assoc: "left" },
  [CoreOpId.LessThan]: { fixity: "infix", precedence: 100, assoc: "none" },
  [CoreOpId.LessThanOrEqualTo]: { fixity: "infix", precedence: 100, assoc: "none" },
  [CoreOpId.GreaterThan]: { fixity: "infix", precedence: 100, assoc: "none" },
  [CoreOpId.GreaterThanOrEqualTo]: { fixity: "infix", precedence: 100, assoc: "none" },
  [CoreOpId.EqualTo]: { fixity: "infix", precedence: 90, assoc: "none" },
  [CoreOpId.NotEqualTo]: { fixity: "infix", precedence: 90, assoc: "none" },
  [CoreOpId.BitwiseAnd]: { fixity: "infix", precedence: 80, assoc: "left" },
  [CoreOpId.BitwiseXor]: { fixity: "infix", precedence: 70, assoc: "left" },
  [CoreOpId.BitwiseOr]: { fixity: "infix", precedence: 60, assoc: "left" },
  [CoreOpId.And]: { fixity: "infix", precedence: 50, assoc: "left" },
  [CoreOpId.Or]: { fixity: "infix", precedence: 40, assoc: "left" },
  [CoreOpId.Assign]: { fixity: "infix", precedence: 10, assoc: "right" },
} as const;

function argsKey(argTypes: TypeId[]): string {
  return argTypes.join("|");
}

/** Stable error codes thrown when an operator overload cannot be registered. */
export const OperatorOverloadErrorCode = {
  /** The overload names an operator id the operator table does not hold. */
  UnknownOperator: "OPERATOR_OVERLOAD_UNKNOWN_OPERATOR",
  /** The operator already holds an overload for the same operand types; that earlier overload stands. */
  Duplicate: "OPERATOR_OVERLOAD_DUPLICATE",
} as const;

/** Union of all {@link OperatorOverloadErrorCode} values. */
export type OperatorOverloadErrorCode = (typeof OperatorOverloadErrorCode)[keyof typeof OperatorOverloadErrorCode];

/**
 * Represents a registered operator with multiple type-specific overloads.
 * Manages the collection of overloads for a single operator based on argument types.
 */
export class RegisteredOperator implements IRegisteredOperator {
  readonly id: OpId;
  readonly parse: OpParse;
  private readonly overload: Dict<string, OpOverload>;

  constructor(op: OpSpec) {
    this.id = op.id;
    this.parse = op.parse;
    this.overload = new Dict<string, OpOverload>();
  }
  /**
   * Adds an operator overload for a specific set of argument types.
   * @param overload - The overload definition including argument types and result type
   * @throws {Error} If an overload with the same argument types already exists
   */
  add(overload: OpOverload): void {
    const key = argsKey(overload.argTypes);
    if (this.overload.has(key)) {
      throw new Error(`Duplicate overload for op ${this.id} with args (${key})`);
    }
    this.overload.set(key, overload);
  }

  remove(argTypes: TypeId[]): boolean {
    return this.overload.delete(argsKey(argTypes));
  }

  /**
   * Retrieves the operator overload for a specific set of argument types.
   * @param argTypes - The array of type IDs for the arguments
   * @returns The matching overload, or undefined if not found
   */
  get(argTypes: TypeId[]): OpOverload | undefined {
    const key = argsKey(argTypes);
    return this.overload.get(key);
  }

  /**
   * Returns all registered overloads for this operator.
   */
  overloads(): ReadonlyList<OpOverload> {
    return this.overload.values();
  }
}

/**
 * Central registry table for all operators and their overloads.
 * Manages operator registration and resolution based on operator ID and argument types.
 */
export class OperatorTable implements IOperatorTable {
  private table = new Dict<string, RegisteredOperator>();

  /**
   * Adds or retrieves an operator specification.
   * If the operator already exists, validates that the parsing information matches.
   * @param op - The operator specification including ID and parsing information
   * @returns The registered operator instance
   * @throws {Error} If an operator with conflicting parsing information already exists
   */
  add(op: OpSpec): IRegisteredOperator {
    let reg = this.table.get(op.id);
    if (reg) {
      if (
        reg.parse.fixity !== op.parse.fixity ||
        reg.parse.precedence !== op.parse.precedence ||
        reg.parse.assoc !== op.parse.assoc
      ) {
        throw new Error(`Conflicting op registration for ${op.id}`);
      }
    } else {
      reg = new RegisteredOperator(op);
      this.table.set(op.id, reg);
    }
    return reg;
  }

  /**
   * Retrieves a registered operator by its ID.
   * @param id - The operator identifier
   * @returns The registered operator, or undefined if not found
   */
  get(id: OpId): RegisteredOperator | undefined {
    return this.table.get(id);
  }
}

const binaryCallDef = mkCallDef({
  type: "seq",
  items: [
    { type: "arg", tileId: "", name: "lhs", required: true },
    { type: "arg", tileId: "", name: "rhs", required: true },
  ],
});

const unaryCallDef = mkCallDef({
  type: "seq",
  items: [{ type: "arg", tileId: "", name: "arg", required: true }],
});

/**
 * High-level registry for managing operator definitions and overloads.
 * Provides convenience methods for registering unary and binary operators.
 */
export class OperatorOverloads implements IOperatorOverloads {
  constructor(
    private readonly table_: IOperatorTable,
    private readonly functions: IFunctionRegistry
  ) {}

  public table(): IOperatorTable {
    return this.table_;
  }

  /**
   * The registered operator `op`, checked to hold no overload for
   * `argTypes` yet, before anything is registered for a new overload.
   * Throws an error whose message starts with
   * {@link OperatorOverloadErrorCode.UnknownOperator} when the table holds
   * no operator `op`, or with {@link OperatorOverloadErrorCode.Duplicate}
   * when it already holds an overload for `argTypes`.
   */
  private operatorOpenTo(op: OpId, argTypes: TypeId[]): IRegisteredOperator {
    const reg = this.table_.get(op);
    if (!reg) {
      throw new Error(`${OperatorOverloadErrorCode.UnknownOperator}: no operator '${op}'`);
    }
    if (reg.get(argTypes)) {
      throw new Error(
        `${OperatorOverloadErrorCode.Duplicate}: operator '${op}' already has an overload for (${argsKey(argTypes)})`
      );
    }
    return reg;
  }

  /**
   * Registers a binary operator overload with specific left-hand, right-hand, and result types.
   * @param op - The operator identifier
   * @param lhs - The type ID of the left operand
   * @param rhs - The type ID of the right operand
   * @param resultType - The type ID of the operation result
   * @param fnId - Author-assigned stable funcId for the implementing host function
   * @returns The registered operator instance
   * @throws {Error} Coded {@link OperatorOverloadErrorCode.UnknownOperator} if the operator is not found in
   *   the table, or {@link OperatorOverloadErrorCode.Duplicate} if it already has an overload for `lhs` and
   *   `rhs`; either way nothing is registered
   */
  binary(
    op: OpId,
    lhs: TypeId,
    rhs: TypeId,
    resultType: TypeId,
    fnId: number,
    fn: HostFn,
    isAsync = false
  ): IRegisteredOperator {
    const reg = this.operatorOpenTo(op, [lhs, rhs]);
    const fnName = `$$op_${op}_${lhs}_${rhs}_to_${resultType}`;
    const fnEntry = this.functions.register(fnId, fnName, isAsync, fn, binaryCallDef);
    reg.add({
      argTypes: [lhs, rhs],
      resultType,
      fnEntry,
    });
    return reg;
  }

  /**
   * Registers a unary operator overload with specific argument and result types.
   * @param op - The operator identifier
   * @param arg - The type ID of the operand
   * @param resultType - The type ID of the operation result
   * @param fnId - Author-assigned stable funcId for the implementing host function
   * @returns The registered operator instance
   * @throws {Error} Coded {@link OperatorOverloadErrorCode.UnknownOperator} if the operator is not found in
   *   the table, or {@link OperatorOverloadErrorCode.Duplicate} if it already has an overload for `arg`;
   *   either way nothing is registered
   */
  unary(op: OpId, arg: TypeId, resultType: TypeId, fnId: number, fn: HostFn, isAsync = false): IRegisteredOperator {
    const reg = this.operatorOpenTo(op, [arg]);
    const fnName = `$$op_${op}_${arg}_to_${resultType}`;
    const fnEntry = this.functions.register(fnId, fnName, isAsync, fn, unaryCallDef);
    reg.add({
      argTypes: [arg],
      resultType,
      fnEntry,
    });
    return reg;
  }

  remove(op: OpId, argTypes: TypeId[]): boolean {
    const reg = this.table_.get(op);
    if (!reg) {
      return false;
    }

    const overload = reg.get(argTypes);
    if (!overload) {
      return false;
    }

    reg.remove(argTypes);
    if (overload.fnEntry) {
      this.functions.unregister(overload.fnEntry.name);
    }
    return true;
  }

  /**
   * Resolves an operator to its specific overload and parsing information.
   * @param id - The operator identifier
   * @param argTypes - The array of argument type IDs
   * @returns An object containing the matching overload and parsing info, or undefined if not found
   */
  resolve(id: OpId, argTypes: TypeId[]): { overload: OpOverload; parse: OpParse } | undefined {
    const reg = this.table_.get(id);
    if (!reg) {
      return undefined;
    }
    const overload = reg.get(argTypes);
    return overload ? { overload: overload, parse: reg.parse } : undefined;
  }
}

// Operand validation helpers ensure that math operators reject nil and NaN
// operands. The compiler resolves overloads by static type, but at runtime an
// operand may turn out to be nil (e.g. an unassigned variable) or NaN (e.g. a
// poisoned earlier computation). We return NIL_VALUE for arithmetic and
// FALSE_VALUE for comparisons so a faulty subexpression makes the surrounding
// rule evaluate false rather than faulting the VM or producing NaN-poisoned
// downstream values.

/** Coerce `v` to a finite number, or undefined if `v` is not a non-NaN {@link NumberValue}. */
export function asValidNumber(v: Value | undefined): number | undefined {
  if (v === undefined || v.t !== NativeType.Number) {
    return undefined;
  }
  if (MathOps.isNaN(v.v)) {
    return undefined;
  }
  return v.v;
}

/** Coerce `v` to a string, or undefined if `v` is not a {@link StringValue}. */
export function asValidString(v: Value | undefined): string | undefined {
  if (v === undefined || v.t !== NativeType.String) {
    return undefined;
  }
  return v.v;
}

/** Apply a binary numeric op to slot 0 and slot 1 of `args`. Returns nil on bad operands or NaN result. */
export function safeNumBinary(args: ReadonlyList<Value>, op: (a: number, b: number) => number): Value {
  const a = asValidNumber(args.get(0));
  const b = asValidNumber(args.get(1));
  if (a === undefined || b === undefined) {
    return NIL_VALUE;
  }
  const result = op(a, b);
  if (MathOps.isNaN(result)) {
    return NIL_VALUE;
  }
  return mkNumberValue(result);
}

/** Apply a unary numeric op to slot 0 of `args`. Returns nil on bad operand or NaN result. */
export function safeNumUnary(args: ReadonlyList<Value>, op: (a: number) => number): Value {
  const a = asValidNumber(args.get(0));
  if (a === undefined) {
    return NIL_VALUE;
  }
  const result = op(a);
  if (MathOps.isNaN(result)) {
    return NIL_VALUE;
  }
  return mkNumberValue(result);
}

/** Apply a numeric comparison to slots 0 and 1 of `args`. Returns false on bad operands. */
export function safeNumCompare(args: ReadonlyList<Value>, cmp: (a: number, b: number) => boolean): Value {
  const a = asValidNumber(args.get(0));
  const b = asValidNumber(args.get(1));
  if (a === undefined || b === undefined) {
    return FALSE_VALUE;
  }
  return mkBooleanValue(cmp(a, b));
}

/** Concatenate slot 0 and slot 1 of `args` as strings. Returns nil on bad operands. */
export function safeStrConcat(args: ReadonlyList<Value>): Value {
  const a = asValidString(args.get(0));
  const b = asValidString(args.get(1));
  if (a === undefined || b === undefined) {
    return NIL_VALUE;
  }
  return { t: NativeType.String, v: `${a}${b}` };
}

/** Apply a string comparison to slots 0 and 1 of `args`. Returns false on bad operands. */
export function safeStrCompare(args: ReadonlyList<Value>, cmp: (a: string, b: string) => boolean): Value {
  const a = asValidString(args.get(0));
  const b = asValidString(args.get(1));
  if (a === undefined || b === undefined) {
    return FALSE_VALUE;
  }
  return mkBooleanValue(cmp(a, b));
}

/**
 * Registers all core operators with their type-specific overloads.
 * This includes logical (and, or, not), arithmetic (+, -, *, /, negate),
 * comparison (<, <=, >, >=, ==, !=), and assignment operators.
 * Numeric exec bodies capture `services.app.numerics` and compute results
 * at the profile's precision.
 * Note: Assignment registers only its parse entry, no overloads; the compiler
 * lowers it to store instructions for any type.
 */
export function registerCoreOperators(services: BrainServices) {
  const operatorTable = services.runtime.operatorTable;
  const operatorOverloads = services.edit.operatorOverloads;
  const numerics = services.app.numerics;

  operatorTable.add({ id: CoreOpId.And, parse: Precedence[CoreOpId.And] });
  operatorTable.add({ id: CoreOpId.Or, parse: Precedence[CoreOpId.Or] });
  operatorTable.add({ id: CoreOpId.Not, parse: Precedence[CoreOpId.Not] });

  operatorTable.add({ id: CoreOpId.Add, parse: Precedence[CoreOpId.Add] });
  operatorTable.add({ id: CoreOpId.Subtract, parse: Precedence[CoreOpId.Subtract] });
  operatorTable.add({ id: CoreOpId.Multiply, parse: Precedence[CoreOpId.Multiply] });
  operatorTable.add({ id: CoreOpId.Divide, parse: Precedence[CoreOpId.Divide] });
  operatorTable.add({ id: CoreOpId.Modulo, parse: Precedence[CoreOpId.Modulo] });
  operatorTable.add({ id: CoreOpId.Power, parse: Precedence[CoreOpId.Power] });
  operatorTable.add({ id: CoreOpId.Negate, parse: Precedence[CoreOpId.Negate] });

  operatorTable.add({ id: CoreOpId.BitwiseAnd, parse: Precedence[CoreOpId.BitwiseAnd] });
  operatorTable.add({ id: CoreOpId.BitwiseOr, parse: Precedence[CoreOpId.BitwiseOr] });
  operatorTable.add({ id: CoreOpId.BitwiseXor, parse: Precedence[CoreOpId.BitwiseXor] });
  operatorTable.add({ id: CoreOpId.BitwiseNot, parse: Precedence[CoreOpId.BitwiseNot] });
  operatorTable.add({ id: CoreOpId.LeftShift, parse: Precedence[CoreOpId.LeftShift] });
  operatorTable.add({ id: CoreOpId.RightShift, parse: Precedence[CoreOpId.RightShift] });

  operatorTable.add({ id: CoreOpId.EqualTo, parse: Precedence[CoreOpId.EqualTo] });
  operatorTable.add({ id: CoreOpId.NotEqualTo, parse: Precedence[CoreOpId.NotEqualTo] });
  operatorTable.add({ id: CoreOpId.LessThan, parse: Precedence[CoreOpId.LessThan] });
  operatorTable.add({
    id: CoreOpId.LessThanOrEqualTo,
    parse: Precedence[CoreOpId.LessThanOrEqualTo],
  });
  operatorTable.add({ id: CoreOpId.GreaterThan, parse: Precedence[CoreOpId.GreaterThan] });
  operatorTable.add({
    id: CoreOpId.GreaterThanOrEqualTo,
    parse: Precedence[CoreOpId.GreaterThanOrEqualTo],
  });
  operatorTable.add({ id: CoreOpId.Assign, parse: Precedence[CoreOpId.Assign] });

  operatorOverloads.binary(
    CoreOpId.And,
    CoreTypeIds.Boolean,
    CoreTypeIds.Boolean,
    CoreTypeIds.Boolean,
    CoreFuncId.OpAndBoolean,
    {
      exec: (_ctx: ExecutionContext, args: ReadonlyList<Value>) => {
        const a = args.get(0) as BooleanValue;
        const b = args.get(1) as BooleanValue;
        return mkBooleanValue(a.v && b.v);
      },
    },
    false
  );
  operatorOverloads.binary(
    CoreOpId.Or,
    CoreTypeIds.Boolean,
    CoreTypeIds.Boolean,
    CoreTypeIds.Boolean,
    CoreFuncId.OpOrBoolean,
    {
      exec: (_ctx: ExecutionContext, args: ReadonlyList<Value>) => {
        const a = args.get(0) as BooleanValue;
        const b = args.get(1) as BooleanValue;
        return mkBooleanValue(a.v || b.v);
      },
    },
    false
  );
  operatorOverloads.unary(
    CoreOpId.Not,
    CoreTypeIds.Boolean,
    CoreTypeIds.Boolean,
    CoreFuncId.OpNotBoolean,
    {
      exec: (_ctx: ExecutionContext, args: ReadonlyList<Value>) => {
        const a = args.get(0) as BooleanValue;
        return mkBooleanValue(!a.v);
      },
    },
    false
  );

  operatorOverloads.binary(
    CoreOpId.Add,
    CoreTypeIds.Number,
    CoreTypeIds.Number,
    CoreTypeIds.Number,
    CoreFuncId.OpAddNumber,
    {
      exec: (_ctx: ExecutionContext, args: ReadonlyList<Value>) => safeNumBinary(args, (a, b) => numerics.round(a + b)),
    },
    false
  );
  operatorOverloads.binary(
    CoreOpId.Subtract,
    CoreTypeIds.Number,
    CoreTypeIds.Number,
    CoreTypeIds.Number,
    CoreFuncId.OpSubtractNumber,
    {
      exec: (_ctx: ExecutionContext, args: ReadonlyList<Value>) => safeNumBinary(args, (a, b) => numerics.round(a - b)),
    },
    false
  );
  operatorOverloads.binary(
    CoreOpId.Multiply,
    CoreTypeIds.Number,
    CoreTypeIds.Number,
    CoreTypeIds.Number,
    CoreFuncId.OpMultiplyNumber,
    {
      exec: (_ctx: ExecutionContext, args: ReadonlyList<Value>) => safeNumBinary(args, (a, b) => numerics.round(a * b)),
    },
    false
  );
  operatorOverloads.binary(
    CoreOpId.Divide,
    CoreTypeIds.Number,
    CoreTypeIds.Number,
    CoreTypeIds.Number,
    CoreFuncId.OpDivideNumber,
    {
      exec: (_ctx: ExecutionContext, args: ReadonlyList<Value>) =>
        safeNumBinary(args, (a, b) => {
          // Division by zero yields NIL_VALUE rather than faulting; safeNumBinary
          // catches both 0/0 (NaN result) and finite/0 (Infinity result is rejected by NaN check on subsequent ops).
          if (b === 0) {
            return 0 / 0;
          }
          return numerics.round(a / b);
        }),
    },
    false
  );
  operatorOverloads.binary(
    CoreOpId.Modulo,
    CoreTypeIds.Number,
    CoreTypeIds.Number,
    CoreTypeIds.Number,
    CoreFuncId.OpModuloNumber,
    {
      exec: (_ctx: ExecutionContext, args: ReadonlyList<Value>) =>
        safeNumBinary(args, (a, b) => {
          if (b === 0) {
            return 0 / 0;
          }
          return numerics.round(a % b);
        }),
    },
    false
  );
  operatorOverloads.binary(
    CoreOpId.Power,
    CoreTypeIds.Number,
    CoreTypeIds.Number,
    CoreTypeIds.Number,
    CoreFuncId.OpPowerNumber,
    { exec: (_ctx: ExecutionContext, args: ReadonlyList<Value>) => safeNumBinary(args, (a, b) => numerics.pow(a, b)) },
    false
  );
  operatorOverloads.unary(
    CoreOpId.Negate,
    CoreTypeIds.Number,
    CoreTypeIds.Number,
    CoreFuncId.OpNegateNumber,
    { exec: (_ctx: ExecutionContext, args: ReadonlyList<Value>) => safeNumUnary(args, (a) => numerics.round(-a)) },
    false
  );

  operatorOverloads.binary(
    CoreOpId.BitwiseAnd,
    CoreTypeIds.Number,
    CoreTypeIds.Number,
    CoreTypeIds.Number,
    CoreFuncId.OpBitwiseAndNumber,
    {
      exec: (_ctx: ExecutionContext, args: ReadonlyList<Value>) =>
        safeNumBinary(args, (a, b) => numerics.round(MathOps.bitAnd(a, b))),
    },
    false
  );
  operatorOverloads.binary(
    CoreOpId.BitwiseOr,
    CoreTypeIds.Number,
    CoreTypeIds.Number,
    CoreTypeIds.Number,
    CoreFuncId.OpBitwiseOrNumber,
    {
      exec: (_ctx: ExecutionContext, args: ReadonlyList<Value>) =>
        safeNumBinary(args, (a, b) => numerics.round(MathOps.bitOr(a, b))),
    },
    false
  );
  operatorOverloads.binary(
    CoreOpId.BitwiseXor,
    CoreTypeIds.Number,
    CoreTypeIds.Number,
    CoreTypeIds.Number,
    CoreFuncId.OpBitwiseXorNumber,
    {
      exec: (_ctx: ExecutionContext, args: ReadonlyList<Value>) =>
        safeNumBinary(args, (a, b) => numerics.round(MathOps.bitXor(a, b))),
    },
    false
  );
  operatorOverloads.unary(
    CoreOpId.BitwiseNot,
    CoreTypeIds.Number,
    CoreTypeIds.Number,
    CoreFuncId.OpBitwiseNotNumber,
    {
      exec: (_ctx: ExecutionContext, args: ReadonlyList<Value>) =>
        safeNumUnary(args, (a) => numerics.round(MathOps.bitNot(a))),
    },
    false
  );
  operatorOverloads.binary(
    CoreOpId.LeftShift,
    CoreTypeIds.Number,
    CoreTypeIds.Number,
    CoreTypeIds.Number,
    CoreFuncId.OpLeftShiftNumber,
    {
      exec: (_ctx: ExecutionContext, args: ReadonlyList<Value>) =>
        safeNumBinary(args, (a, b) => numerics.round(MathOps.leftShift(a, b))),
    },
    false
  );
  operatorOverloads.binary(
    CoreOpId.RightShift,
    CoreTypeIds.Number,
    CoreTypeIds.Number,
    CoreTypeIds.Number,
    CoreFuncId.OpRightShiftNumber,
    {
      exec: (_ctx: ExecutionContext, args: ReadonlyList<Value>) =>
        safeNumBinary(args, (a, b) => numerics.round(MathOps.rightShift(a, b))),
    },
    false
  );

  operatorOverloads.binary(
    CoreOpId.EqualTo,
    CoreTypeIds.Boolean,
    CoreTypeIds.Boolean,
    CoreTypeIds.Boolean,
    CoreFuncId.OpEqualToBoolean,
    {
      exec: (_ctx: ExecutionContext, args: ReadonlyList<Value>) => {
        const a = args.get(0) as BooleanValue;
        const b = args.get(1) as BooleanValue;
        return mkBooleanValue(a.v === b.v);
      },
    },
    false
  );
  operatorOverloads.binary(
    CoreOpId.NotEqualTo,
    CoreTypeIds.Boolean,
    CoreTypeIds.Boolean,
    CoreTypeIds.Boolean,
    CoreFuncId.OpNotEqualToBoolean,
    {
      exec: (_ctx: ExecutionContext, args: ReadonlyList<Value>) => {
        const a = args.get(0) as BooleanValue;
        const b = args.get(1) as BooleanValue;
        return mkBooleanValue(a.v !== b.v);
      },
    },
    false
  );
  operatorOverloads.binary(
    CoreOpId.EqualTo,
    CoreTypeIds.Number,
    CoreTypeIds.Number,
    CoreTypeIds.Boolean,
    CoreFuncId.OpEqualToNumber,
    { exec: (_ctx: ExecutionContext, args: ReadonlyList<Value>) => safeNumCompare(args, (a, b) => a === b) },
    false
  );
  operatorOverloads.binary(
    CoreOpId.NotEqualTo,
    CoreTypeIds.Number,
    CoreTypeIds.Number,
    CoreTypeIds.Boolean,
    CoreFuncId.OpNotEqualToNumber,
    { exec: (_ctx: ExecutionContext, args: ReadonlyList<Value>) => safeNumCompare(args, (a, b) => a !== b) },
    false
  );
  operatorOverloads.binary(
    CoreOpId.LessThan,
    CoreTypeIds.Number,
    CoreTypeIds.Number,
    CoreTypeIds.Boolean,
    CoreFuncId.OpLessThanNumber,
    { exec: (_ctx: ExecutionContext, args: ReadonlyList<Value>) => safeNumCompare(args, (a, b) => a < b) },
    false
  );
  operatorOverloads.binary(
    CoreOpId.LessThanOrEqualTo,
    CoreTypeIds.Number,
    CoreTypeIds.Number,
    CoreTypeIds.Boolean,
    CoreFuncId.OpLessThanOrEqualToNumber,
    { exec: (_ctx: ExecutionContext, args: ReadonlyList<Value>) => safeNumCompare(args, (a, b) => a <= b) },
    false
  );
  operatorOverloads.binary(
    CoreOpId.GreaterThan,
    CoreTypeIds.Number,
    CoreTypeIds.Number,
    CoreTypeIds.Boolean,
    CoreFuncId.OpGreaterThanNumber,
    { exec: (_ctx: ExecutionContext, args: ReadonlyList<Value>) => safeNumCompare(args, (a, b) => a > b) },
    false
  );
  operatorOverloads.binary(
    CoreOpId.GreaterThanOrEqualTo,
    CoreTypeIds.Number,
    CoreTypeIds.Number,
    CoreTypeIds.Boolean,
    CoreFuncId.OpGreaterThanOrEqualToNumber,
    { exec: (_ctx: ExecutionContext, args: ReadonlyList<Value>) => safeNumCompare(args, (a, b) => a >= b) },
    false
  );
  operatorOverloads.binary(
    CoreOpId.Add,
    CoreTypeIds.String,
    CoreTypeIds.String,
    CoreTypeIds.String,
    CoreFuncId.OpAddString,
    { exec: (_ctx: ExecutionContext, args: ReadonlyList<Value>) => safeStrConcat(args) },
    false
  );
  operatorOverloads.binary(
    CoreOpId.EqualTo,
    CoreTypeIds.String,
    CoreTypeIds.String,
    CoreTypeIds.Boolean,
    CoreFuncId.OpEqualToString,
    { exec: (_ctx: ExecutionContext, args: ReadonlyList<Value>) => safeStrCompare(args, (a, b) => a === b) },
    false
  );
  operatorOverloads.binary(
    CoreOpId.NotEqualTo,
    CoreTypeIds.String,
    CoreTypeIds.String,
    CoreTypeIds.Boolean,
    CoreFuncId.OpNotEqualToString,
    { exec: (_ctx: ExecutionContext, args: ReadonlyList<Value>) => safeStrCompare(args, (a, b) => a !== b) },
    false
  );
  // -- Nil overloads ----------------------------------------------------------

  operatorOverloads.binary(
    CoreOpId.EqualTo,
    CoreTypeIds.Nil,
    CoreTypeIds.Nil,
    CoreTypeIds.Boolean,
    CoreFuncId.OpEqualToNil,
    { exec: () => mkBooleanValue(true) },
    false
  );
  operatorOverloads.binary(
    CoreOpId.NotEqualTo,
    CoreTypeIds.Nil,
    CoreTypeIds.Nil,
    CoreTypeIds.Boolean,
    CoreFuncId.OpNotEqualToNil,
    { exec: () => mkBooleanValue(false) },
    false
  );
  operatorOverloads.unary(
    CoreOpId.Not,
    CoreTypeIds.Nil,
    CoreTypeIds.Boolean,
    CoreFuncId.OpNotNil,
    { exec: () => mkBooleanValue(true) },
    false
  );

  const nilComparableTypes: ReadonlyArray<{
    typeId: TypeId;
    eqTypeNil: number;
    eqNilType: number;
    neTypeNil: number;
    neNilType: number;
  }> = [
    {
      typeId: CoreTypeIds.Number,
      eqTypeNil: CoreFuncId.OpEqualToNumberNil,
      eqNilType: CoreFuncId.OpEqualToNilNumber,
      neTypeNil: CoreFuncId.OpNotEqualToNumberNil,
      neNilType: CoreFuncId.OpNotEqualToNilNumber,
    },
    {
      typeId: CoreTypeIds.Boolean,
      eqTypeNil: CoreFuncId.OpEqualToBooleanNil,
      eqNilType: CoreFuncId.OpEqualToNilBoolean,
      neTypeNil: CoreFuncId.OpNotEqualToBooleanNil,
      neNilType: CoreFuncId.OpNotEqualToNilBoolean,
    },
    {
      typeId: CoreTypeIds.String,
      eqTypeNil: CoreFuncId.OpEqualToStringNil,
      eqNilType: CoreFuncId.OpEqualToNilString,
      neTypeNil: CoreFuncId.OpNotEqualToStringNil,
      neNilType: CoreFuncId.OpNotEqualToNilString,
    },
  ];
  for (const entry of nilComparableTypes) {
    operatorOverloads.binary(
      CoreOpId.EqualTo,
      entry.typeId,
      CoreTypeIds.Nil,
      CoreTypeIds.Boolean,
      entry.eqTypeNil,
      {
        exec: (_ctx: ExecutionContext, args: ReadonlyList<Value>) => {
          const a = args.get(0) as Value;
          return mkBooleanValue(a.t === NativeType.Nil);
        },
      },
      false
    );
    operatorOverloads.binary(
      CoreOpId.EqualTo,
      CoreTypeIds.Nil,
      entry.typeId,
      CoreTypeIds.Boolean,
      entry.eqNilType,
      {
        exec: (_ctx: ExecutionContext, args: ReadonlyList<Value>) => {
          const b = args.get(1) as Value;
          return mkBooleanValue(b.t === NativeType.Nil);
        },
      },
      false
    );
    operatorOverloads.binary(
      CoreOpId.NotEqualTo,
      entry.typeId,
      CoreTypeIds.Nil,
      CoreTypeIds.Boolean,
      entry.neTypeNil,
      {
        exec: (_ctx: ExecutionContext, args: ReadonlyList<Value>) => {
          const a = args.get(0) as Value;
          return mkBooleanValue(a.t !== NativeType.Nil);
        },
      },
      false
    );
    operatorOverloads.binary(
      CoreOpId.NotEqualTo,
      CoreTypeIds.Nil,
      entry.typeId,
      CoreTypeIds.Boolean,
      entry.neNilType,
      {
        exec: (_ctx: ExecutionContext, args: ReadonlyList<Value>) => {
          const b = args.get(1) as Value;
          return mkBooleanValue(b.t !== NativeType.Nil);
        },
      },
      false
    );
  }

  // -- Enum overloads ---------------------------------------------------------

  // Shared host functions for enum `==` / `!=`: every enum type's overload
  // entries point at these two ids. Equality is symbol identity within one
  // enum type (same typeId, same symbol key); bad operands compare false.
  services.runtime.functions.register(
    CoreFuncId.OpEqualToEnum,
    "$$op_eq_enum",
    false,
    {
      exec: (_ctx: ExecutionContext, args: ReadonlyList<Value>) => {
        const a = args.get(0);
        const b = args.get(1);
        if (!isEnumValue(a) || !isEnumValue(b) || a.typeId !== b.typeId) {
          return FALSE_VALUE;
        }
        return mkBooleanValue(a.v === b.v);
      },
    },
    binaryCallDef
  );
  services.runtime.functions.register(
    CoreFuncId.OpNotEqualToEnum,
    "$$op_ne_enum",
    false,
    {
      exec: (_ctx: ExecutionContext, args: ReadonlyList<Value>) => {
        const a = args.get(0);
        const b = args.get(1);
        if (!isEnumValue(a) || !isEnumValue(b) || a.typeId !== b.typeId) {
          return FALSE_VALUE;
        }
        return mkBooleanValue(a.v !== b.v);
      },
    },
    binaryCallDef
  );
}
