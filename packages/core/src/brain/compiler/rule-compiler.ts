import { Dict } from "../../platform/dict";
import { Error } from "../../platform/error";
import { List, type ReadonlyList } from "../../platform/list";
import { logger } from "../../platform/logger";
import { StringUtils as SU } from "../../platform/string";
import { TypeUtils } from "../../platform/types";
import type { UniqueSet } from "../../platform/uniqueset";
import type {
  ActionDescriptor,
  ActionRef,
  BrainActionResolver,
  ITypeRegistry,
  NullableTypeDef,
  TypeId,
} from "../../runtime";
import {
  type BrainActionArgSlot,
  CoreFuncId,
  CoreOpId,
  CoreTypeIds,
  isBytecodeConversion,
  NativeType,
  NO_VARIABLE_INIT,
} from "../../runtime";
import { NIL_VALUE, type Value } from "../../runtime/value";
import type { IBrainTileDef, ITileCatalog } from "../interfaces";
import { RuleSide } from "../interfaces";
import type { IBytecodeEmitter } from "../interfaces/emitter";
import type { BrainTileParameterDef } from "../tiles";
import type { ConstantPool } from "./constant-pool";
import {
  CompilationDiagCode,
  type DiagCode,
  type DiagnosticSeverity,
  type DiagParams,
  diagnosticSeverity,
  LinkDiagCode,
} from "./diagnostics";
import type {
  ActuatorExpr,
  AssignmentExpr,
  BinaryOpExpr,
  EmptyExpr,
  ErrorExpr,
  Expr,
  ExprVisitor,
  FieldAccessExpr,
  LiteralExpr,
  ModifierExpr,
  OutputExpr,
  ParameterExpr,
  SensorExpr,
  SlotExpr,
  TypeEnv,
  TypeInfo,
  UnaryOpExpr,
  VariableExpr,
} from "./types";
import { acceptExprVisitor } from "./types";

/**
 * Compilation context for the bytecode emitter. Manages variable scope,
 * constant pool, and other state needed during compilation.
 */
interface CompilationContext {
  /** Maps variable names to their index in the variableNames list */
  variableIndices: Dict<string, number>;
  /** List of variable names, in order of first occurrence */
  variableNames: List<string>;
  /** Data type each variable slot was minted at, keyed by variable name */
  variableTypes: Dict<string, TypeId>;
  /**
   * Per-slot starting-value index into the value constant pool, or
   * {@link NO_VARIABLE_INIT}. Parallel to {@link variableNames}.
   */
  variableInitValues: List<number>;
  /**
   * Names already reported by a {@link CompilationDiagCode.VariableTypeConflict},
   * keyed `<varName>|<conflicting typeId>`, so each conflicting pair reports once.
   */
  reportedVariableConflicts: Dict<string, boolean>;
  /** Maps action keys to their program-local action slot */
  actionIndices: Dict<string, number>;
  /** Program-local action refs (bytecode actions only), populated on first use */
  actionRefs: List<ActionRef>;
  /** Resolves an action descriptor to its binding (host vs bytecode) at compile time */
  actionResolver: BrainActionResolver;
  /** Type information for each node */
  typeEnv: TypeEnv;
  /** Constant pool for managing literal values */
  constantPool: ConstantPool;
  /**
   * Type-table indices interned for struct values host actions construct at
   * runtime; the tree shaker takes them as explicit type-reachability roots.
   */
  pinnedTypeIndices: UniqueSet<number>;
  /** Type registry, used to instantiate the `List<T>` type of a repeated arg slot. */
  typeRegistry: ITypeRegistry;
  /** Tile catalogs, used to resolve a repeated slot's parameter element type. */
  catalogs: ReadonlyList<ITileCatalog>;
  /** Counter for assigning unique call-site IDs to host and action call instructions */
  nextCallSiteId: { value: number };
  /** Rule path of the rule being compiled, in `page/rule[/child]` form. */
  rulePath: string;
  /** Rule side being compiled. */
  ruleSide: RuleSide;
  /** Tiles of the rule side being compiled, indexed by expression span position. */
  sideTiles: ReadonlyList<IBrainTileDef>;
  /** Diagnostics collected during compilation */
  diags: List<CompilationDiag>;
}

/**
 * Compilation diagnostic with node reference. An "error" blocks producing a
 * program; a "warning" reports degraded output that still compiles.
 */
export interface CompilationDiag {
  code: DiagCode;
  severity: DiagnosticSeverity;
  message: string;
  nodeId: number;
  /** Machine-readable values `message` interpolates; absent when it interpolates none. */
  params?: DiagParams;
}

/**
 * Bytecode emitter that walks an expression AST and generates VM instructions.
 *
 * Lowering a value-producing node leaves exactly one value on the operand
 * stack, recovery paths included: a node the emitter cannot lower stands a NIL
 * in its place. Modifier and empty nodes produce no value; their enclosing call
 * lowers them without visiting.
 */
export class ExprCompiler implements ExprVisitor<void> {
  constructor(
    private readonly emitter: IBytecodeEmitter,
    private readonly context: CompilationContext
  ) {}

  /**
   * Get the next unique call-site ID for a host-backed call.
   * This ID is used by host functions to persist per-call-site state.
   */
  private nextCallSiteId(): number {
    return this.context.nextCallSiteId.value++;
  }

  private getOrCreateActionSlot(actionKey: string): number {
    const existingSlot = this.context.actionIndices.get(actionKey);
    if (existingSlot !== undefined) {
      return existingSlot;
    }

    const actionSlot = this.context.actionRefs.size();
    this.context.actionIndices.set(actionKey, actionSlot);
    this.context.actionRefs.push({ slot: actionSlot, key: actionKey });
    return actionSlot;
  }

  // ==========================================
  // Binary Operators
  // ==========================================

  visitBinaryOp(expr: BinaryOpExpr): void {
    const typeInfo = this.context.typeEnv.get(expr.nodeId);
    if (!typeInfo) {
      this.context.diags.push({
        code: CompilationDiagCode.MissingTypeInfo,
        severity: diagnosticSeverity(CompilationDiagCode.MissingTypeInfo),
        message: `Missing type information for binary operator`,
        nodeId: expr.nodeId,
      });
      // Emit nil placeholder to maintain stack consistency
      this.pushNilPlaceholder();
      return;
    }

    const opId = expr.operator.op.id;
    if (opId === CoreOpId.And) {
      // Special case: logical AND uses short-circuit evaluation with conditional jumps
      this.emitShortCircuitAnd(expr);
      return;
    }

    if (opId === CoreOpId.Or) {
      // Special case: logical OR uses short-circuit evaluation with conditional jumps
      this.emitShortCircuitOr(expr);
      return;
    }

    // Open the binary host-call buffer (slot 0 = lhs, slot 1 = rhs):
    // push two NIL fillers, lower each operand into its slot via
    // STACK_SET_REL, then HOST_CALL.
    this.pushNil();
    this.pushNil();
    acceptExprVisitor(expr.left, this);
    this.emitConversionIfNeeded(expr.left.nodeId);
    this.emitter.stackSetRel(1);
    acceptExprVisitor(expr.right, this);
    this.emitConversionIfNeeded(expr.right.nodeId);
    this.emitter.stackSetRel(0);
    this.emitBinaryOp(typeInfo);
  }

  /**
   * Emit a type-conversion call if the node's TypeInfo has a conversion.
   * The value to convert must already be on top of the stack: that single
   * value is the conversion's slot-0 buffer. A host-function conversion
   * emits `HOST_CALL convFnId, 1, csId`; a bytecode conversion emits
   * `ACTION_CALL actionSlot, 1, csId` against the program-local action slot
   * keyed by the conversion's action key, bound to the compiled convert
   * function at link. Stack effect: `[value] -> [converted_value]`.
   */
  private emitConversionIfNeeded(nodeId: number): void {
    const typeInfo = this.context.typeEnv.get(nodeId);
    if (!typeInfo || !typeInfo.conversion) {
      return;
    }

    const conversion = typeInfo.conversion;
    if (isBytecodeConversion(conversion)) {
      const actionSlot = this.getOrCreateActionSlot(conversion.descriptor.key);
      this.emitter.actionCall(actionSlot, 1, this.nextCallSiteId());
      return;
    }
    this.emitter.hostCall(conversion.id, 1, this.nextCallSiteId());
  }

  /** Push a `NIL_VALUE` constant -- used as filler in host-call arg buffers. */
  private pushNil(): void {
    const idx = this.context.constantPool.addOther(NIL_VALUE);
    this.emitter.pushConst(idx);
  }

  private emitShortCircuitAnd(expr: BinaryOpExpr): void {
    // Short-circuit AND: if left is false, skip right and return left's value
    // Semantics: left && right returns left if falsy, otherwise right Note: No
    // type conversions applied - boolean operators work on any truthy/falsy
    // value
    acceptExprVisitor(expr.left, this);
    this.emitter.dup(); // Keep a copy for the result

    const endLabel = this.emitter.label();
    this.emitter.jmpIfFalse(endLabel); // If left is false, skip right

    // Left was true, evaluate right
    this.emitter.pop(); // Pop the duplicate
    acceptExprVisitor(expr.right, this);

    this.emitter.mark(endLabel);
    // Stack now contains the result (either false from left, or right's value)
  }

  private emitShortCircuitOr(expr: BinaryOpExpr): void {
    // Short-circuit OR: if left is true, skip right and return left's value
    // Semantics: left || right returns left if truthy, otherwise right Note: No
    // type conversions applied - boolean operators work on any truthy/falsy
    // value
    acceptExprVisitor(expr.left, this);
    this.emitter.dup(); // Keep a copy for the result

    const endLabel = this.emitter.label();
    this.emitter.jmpIfTrue(endLabel); // If left is true, skip right

    // Left was false, evaluate right
    this.emitter.pop(); // Pop the duplicate
    acceptExprVisitor(expr.right, this);

    this.emitter.mark(endLabel);
    // Stack now contains the result (either true from left, or right's value)
  }

  private emitBinaryOp(typeInfo: TypeInfo): void {
    // The 2-slot arg buffer is already in place on the stack. Emit
    // HOST_CALL (or HOST_CALL_ASYNC + AWAIT) to consume it. Assignment never
    // reaches here: it lowers through visitAssignment.
    const fnEntry = typeInfo.overload?.fnEntry;
    if (fnEntry) {
      if (fnEntry.isAsync) {
        this.emitter.hostCallAsync(fnEntry.id, 2, this.nextCallSiteId());
        // Automatically await async operators so their result can be used by
        // subsequent operations This makes async operators work correctly in
        // multi-step operator chains
        this.emitter.await();
        return;
      }
      this.emitter.hostCall(fnEntry.id, 2, this.nextCallSiteId());
    } else {
      // This should have been caught during type inference, but handle
      // gracefully The diagnostic is tracked against the operator's nodeId,
      // which we don't have here. The caller already pushed two NIL
      // fillers as the buffer; pop them and push a NIL placeholder to
      // restore stack balance.
      this.emitter.pop();
      this.emitter.pop();
      this.pushNilPlaceholder();
    }
  }

  // ==========================================
  // Unary Operators
  // ==========================================

  visitUnaryOp(expr: UnaryOpExpr): void {
    const typeInfo = this.context.typeEnv.get(expr.nodeId);
    if (!typeInfo) {
      this.context.diags.push({
        code: CompilationDiagCode.MissingTypeInfo,
        severity: diagnosticSeverity(CompilationDiagCode.MissingTypeInfo),
        message: `Missing type information for unary operator`,
        nodeId: expr.nodeId,
      });
      // Emit nil placeholder to maintain stack consistency
      this.pushNilPlaceholder();
      return;
    }

    // Open the unary host-call buffer (slot 0 = operand): push one NIL
    // filler, lower the operand, STACK_SET_REL 0 to overwrite the filler.
    this.pushNil();
    acceptExprVisitor(expr.operand, this);
    this.emitConversionIfNeeded(expr.operand.nodeId);
    this.emitter.stackSetRel(0);
    this.emitUnaryOp(typeInfo);
  }

  private emitUnaryOp(typeInfo: TypeInfo): void {
    const fnEntry = typeInfo.overload?.fnEntry;
    if (fnEntry) {
      if (fnEntry.isAsync) {
        this.emitter.hostCallAsync(fnEntry.id, 1, this.nextCallSiteId());
        // Automatically await async operators so their result can be used by
        // subsequent operations This makes async operators work correctly in
        // multi-step operator chains
        this.emitter.await();
        return;
      }
      this.emitter.hostCall(fnEntry.id, 1, this.nextCallSiteId());
    } else {
      // This should have been caught during type inference, but handle
      // gracefully The diagnostic is tracked against the operator's nodeId,
      // which we don't have here. Pop the 1-slot buffer and push a NIL
      // placeholder to maintain stack balance.
      this.emitter.pop();
      this.pushNilPlaceholder();
    }
  }

  // ==========================================
  // Literals
  // ==========================================

  visitLiteral(expr: LiteralExpr): void {
    // Convert literal value to a VM Value object and route to the appropriate
    // typed sub-pool of the constant pool.
    this.pushLiteralValue(expr.tileDef.value);
  }

  /**
   * Add `value` to the appropriate typed sub-pool and emit the matching
   * `PUSH_CONST*` opcode. Plain numbers go to the number pool, plain strings
   * to the string pool, everything else to the residual pool.
   */
  private pushLiteralValue(value: unknown): void {
    const valueObj: Value = this.valueFromLiteral(value);
    this.pushValueConstant(valueObj);
  }

  /** Add a pre-built `Value` to the appropriate typed sub-pool and emit the matching push opcode. */
  private pushValueConstant(value: Value): void {
    const ref = this.context.constantPool.addValue(value);
    if (ref.kind === "number") {
      this.emitter.pushConstNum(ref.idx);
    } else if (ref.kind === "string") {
      this.emitter.pushConstStr(ref.idx);
    } else {
      this.emitter.pushConst(ref.idx);
    }
  }

  /** Push a `NIL` placeholder used for stack-balance recovery on compilation errors. */
  private pushNilPlaceholder(): void {
    const idx = this.context.constantPool.addOther(NIL_VALUE);
    this.emitter.pushConst(idx);
  }

  /** Add a string to the string sub-pool and emit `PUSH_CONST_STR`. */
  private pushStringConstant(value: string): void {
    const idx = this.context.constantPool.addString(value);
    this.emitter.pushConstStr(idx);
  }

  /** Add a number to the number sub-pool and emit `PUSH_CONST_NUM`. */
  private pushNumberConstant(value: number): void {
    const idx = this.context.constantPool.addNumber(value);
    this.emitter.pushConstNum(idx);
  }

  private valueFromLiteral(value: unknown): Value {
    // Helper to convert a literal value to a VM Value
    if (value === undefined) {
      return { t: NativeType.Nil };
    }
    if (TypeUtils.isBoolean(value)) {
      return { t: NativeType.Boolean, v: value };
    }
    if (TypeUtils.isNumber(value)) {
      return { t: NativeType.Number, v: value };
    }
    if (TypeUtils.isString(value)) {
      return { t: NativeType.String, v: value };
    }
    // If the value is already a Value object (e.g. a StructValue from a native-struct literal),
    // pass it through directly. Value objects always have a `.t` discriminant.
    if (TypeUtils.isObject(value) && (value as Value).t !== undefined) {
      return value as Value;
    }
    // Unknown type
    return { t: NativeType.Unknown };
  }

  // ==========================================
  // Variables
  // ==========================================

  visitVariable(expr: VariableExpr): void {
    // Variables are always r-values in this context (loads)
    // For l-values, see visitAssignment which handles stores
    const varNameIdx = this.getOrCreateVariableIndex(expr.tileDef.varName, expr.tileDef.varType, expr.nodeId);
    this.emitter.loadVarSlot(varNameIdx);
  }

  visitOutput(expr: OutputExpr): void {
    this.pinStructType(expr.tileDef.outputType);
    // Read the sensor output's backing rule variable. RuleContextGetVariable
    // takes the name in arg slot 1 and ignores slot 0 (the method receiver), so
    // slot 0 is a nil filler and slot 1 is the constant output key.
    this.pushNil();
    this.pushStringConstant(expr.tileDef.outputKey);
    this.emitter.hostCall(CoreFuncId.RuleContextGetVariable, 2, this.nextCallSiteId());
  }

  /**
   * Slot id for `varName`, minting one on first occurrence. A minted slot
   * records `varType` and resolves that type's starting value into the value
   * constant pool. A later occurrence of the same name at a different type
   * shares the slot and reports a
   * {@link CompilationDiagCode.VariableTypeConflict}.
   *
   * @param varName - Variable name carried by the variable tile.
   * @param varType - Data type the tile declares the variable at.
   * @param nodeId - Node id the conflict diagnostic points at.
   */
  private getOrCreateVariableIndex(varName: string, varType: TypeId, nodeId: number): number {
    const existingIdx = this.context.variableIndices.get(varName);
    if (existingIdx !== undefined) {
      this.reportVariableTypeConflictIfAny(varName, varType, nodeId);
      return existingIdx;
    }

    // Variable not yet seen - add to variable names list
    const newIdx = this.context.variableNames.size();
    this.context.variableIndices.set(varName, newIdx);
    this.context.variableNames.push(varName);
    this.context.variableTypes.set(varName, varType);
    this.context.variableInitValues.push(this.resolveVariableInit(varType));
    return newIdx;
  }

  /**
   * Value-pool index of `varType`'s starting value, or
   * {@link NO_VARIABLE_INIT} when the type declares none.
   */
  private resolveVariableInit(varType: TypeId): number {
    const zero = this.context.typeRegistry.get(varType)?.zero;
    if (zero === undefined) {
      return NO_VARIABLE_INIT;
    }
    return this.context.constantPool.addOther(zero);
  }

  /** Report a slot whose name is reused at a second data type, once per name/type pair. */
  private reportVariableTypeConflictIfAny(varName: string, varType: TypeId, nodeId: number): void {
    const boundType = this.context.variableTypes.get(varName);
    if (boundType === undefined || boundType === varType) {
      return;
    }
    const reportKey = `${varName}|${varType}`;
    if (this.context.reportedVariableConflicts.get(reportKey) !== undefined) {
      return;
    }
    this.context.reportedVariableConflicts.set(reportKey, true);
    const message =
      `Variable '${varName}' is used as both '${boundType}' and '${varType}'; ` +
      `both share one slot, which holds '${boundType}' values.`;
    logger.warn(message);
    this.context.diags.push({
      code: CompilationDiagCode.VariableTypeConflict,
      severity: diagnosticSeverity(CompilationDiagCode.VariableTypeConflict),
      message,
      nodeId,
      params: {
        varName,
        expectedTypeIds: List.from([boundType]),
        actualTypeIds: List.from([varType]),
      },
    });
  }

  // ==========================================
  // Assignment
  // ==========================================

  visitAssignment(expr: AssignmentExpr): void {
    // Assignment: target = value
    // Strategy depends on whether target is a variable or field access.

    if (expr.target.kind === "fieldAccess") {
      // Field assignment: object.field = value
      const fieldId = this.context.typeEnv.get(expr.target.nodeId)?.fieldId;
      if (fieldId !== undefined) {
        // Id-based store. Convert the value into the field's type if inference
        // annotated a conversion, deep-copy it to preserve the brain's struct
        // value-semantics (STRUCT_DEEP_COPY is a runtime no-op for non-structs),
        // then store by numeric id. STRUCT_SET_FIELD pops [struct, value].
        acceptExprVisitor(expr.target.object, this);
        acceptExprVisitor(expr.value, this);
        this.emitConversionIfNeeded(expr.value.nodeId);
        this.emitter.structDeepCopy();
        this.emitter.structSetField(fieldId);
      } else {
        // Fallback: name-keyed store. SET_FIELD deep-copies the value internally, so
        // no explicit STRUCT_DEEP_COPY here.
        acceptExprVisitor(expr.target.object, this);
        this.pushStringConstant(expr.target.accessor.fieldName);
        acceptExprVisitor(expr.value, this);
        this.emitConversionIfNeeded(expr.value.nodeId);
        this.emitter.setField();
      }
    } else {
      // Variable assignment: var = value
      // 1. Emit the value expression (pushes result to stack)
      // 2. Duplicate it (so assignment can also return a value)
      // 3. Store to the target variable
      // Result: value remains on stack (assignment is an expression)
      const varNameIdx = this.getOrCreateVariableIndex(
        expr.target.tileDef.varName,
        expr.target.tileDef.varType,
        expr.target.nodeId
      );

      // Emit value expression (pushes result onto stack), converting it into
      // the variable's type if inference annotated a conversion
      acceptExprVisitor(expr.value, this);
      this.emitConversionIfNeeded(expr.value.nodeId);

      // Duplicate the value so assignment returns it
      this.emitter.dup();

      // Store the top value to the variable in execution context
      this.emitter.storeVarSlot(varNameIdx);

      // Stack now contains the assigned value (assignment as expression)
    }
  }

  // ==========================================
  // Parameters
  // ==========================================

  visitParameter(expr: ParameterExpr): void {
    // Parameters wrap a value expression
    // The value should be emitted to the stack
    acceptExprVisitor(expr.value, this);
  }

  // ==========================================
  // Modifiers
  // ==========================================

  visitModifier(expr: ModifierExpr): void {
    // Do nothing - modifiers are emitted as boolean flags in visitActuator and visitSensor
  }

  // ==========================================
  // Actuators
  // ==========================================

  visitActuator(expr: ActuatorExpr): void {
    const action = expr.tileDef.action;
    const argSlots = action.callDef.argSlots;

    this.emitActionArguments(argSlots, expr.anons, expr.parameters, expr.modifiers);
    const callSiteId = this.nextCallSiteId();
    this.emitActionDispatch(action, argSlots.size(), callSiteId, expr.nodeId);

    // Actuator return value is now on the stack, but it is ignored, currently.
  }

  // ==========================================
  // Sensors (Queries/Readings)
  // ==========================================

  visitSensor(expr: SensorExpr): void {
    const action = expr.tileDef.action;
    const argSlots = action.callDef.argSlots;

    this.emitActionArguments(argSlots, expr.anons, expr.parameters, expr.modifiers);
    const callSiteId = this.nextCallSiteId();
    this.emitActionDispatch(action, argSlots.size(), callSiteId, expr.nodeId);

    // Result is now on the stack
  }

  /**
   * Resolve an action's binding and emit the matching call. A host action
   * dispatches by its stable registry id (`HOST_ACTION_CALL` /
   * `HOST_ACTION_CALL_ASYNC`); a bytecode action dispatches by a program-local
   * slot (`ACTION_CALL` / `ACTION_CALL_ASYNC`). An unresolvable action records a
   * {@link LinkDiagCode.MissingActionBinding} diagnostic and falls back to the
   * slot path so the operand stack stays balanced for error recovery.
   */
  private emitActionDispatch(action: ActionDescriptor, argc: number, callSiteId: number, nodeId: number): void {
    this.pinStructType(action.outputType);
    if (action.outputs !== undefined) {
      for (const output of action.outputs) {
        this.pinStructType(output.type);
      }
    }
    const resolved = this.context.actionResolver.resolveAction(action);

    if (resolved && resolved.binding === "host") {
      const actionId = resolved.id ?? 0;
      if (action.isAsync) {
        this.emitter.hostActionCallAsync(actionId, argc, callSiteId);
        this.emitter.await();
      } else {
        this.emitter.hostActionCall(actionId, argc, callSiteId);
      }
      return;
    }

    if (!resolved) {
      this.context.diags.push({
        code: LinkDiagCode.MissingActionBinding,
        severity: diagnosticSeverity(LinkDiagCode.MissingActionBinding),
        message: `Action '${action.key}' could not be resolved in this environment.`,
        nodeId,
        params: { actionKey: action.key },
      });
    }

    const actionSlot = this.getOrCreateActionSlot(action.key);
    if (action.isAsync) {
      this.emitter.actionCallAsync(actionSlot, argc, callSiteId);
      this.emitter.await();
    } else {
      this.emitter.actionCall(actionSlot, argc, callSiteId);
    }
  }

  /**
   * Intern a struct type a host action produces at runtime into the program
   * type table, and record the table index in the pin set so the tree shaker
   * keeps the entry. A nullable `typeId` interns its base type. A `typeId`
   * that is absent, unregistered, or not struct-typed interns nothing.
   */
  private pinStructType(typeId: TypeId | undefined): void {
    if (typeId === undefined) {
      return;
    }
    let def = this.context.typeRegistry.get(typeId);
    if (def?.nullable) {
      def = this.context.typeRegistry.get((def as NullableTypeDef).baseTypeId);
    }
    if (def === undefined || def.coreType !== NativeType.Struct) {
      return;
    }
    this.context.pinnedTypeIndices.add(this.context.constantPool.addType(def.typeId));
  }

  /**
   * Emit action arguments as a fixed-width positional arg buffer.
   *
   * Stack effect: [] -> [slot0, slot1, ..., slotN]
   */
  private emitActionArguments(
    argSlots: ReadonlyList<BrainActionArgSlot>,
    anons: ReadonlyList<SlotExpr>,
    parameters: ReadonlyList<SlotExpr>,
    modifiers: ReadonlyList<SlotExpr>
  ): number {
    const argc = argSlots.size();
    for (let i = 0; i < argc; i++) {
      this.pushNil();
    }

    const emitSlotEntry = (slotId: number, emitValue: () => void) => {
      emitValue();
      this.emitter.stackSetRel(argc - 1 - slotId);
    };

    // Emit anonymous arguments, then named parameters. Both accept repeated
    // slots, whose same-slot values are gathered into one `List<T>`.
    this.emitSlotExprs(anons, argSlots, emitSlotEntry);
    this.emitSlotExprs(parameters, argSlots, emitSlotEntry);

    // Emit modifiers -- count occurrences per slotId so repeated modifiers
    // produce a numeric count value instead of a boolean flag.
    // Single-occurrence modifiers emit 1, which is truthy for positional
    // presence checks against NIL.
    const modCounts = new Dict<number, number>();
    for (let i = 0; i < modifiers.size(); i++) {
      const sid = modifiers.get(i).slotId;
      modCounts.set(sid, (modCounts.get(sid) ?? 0) + 1);
    }
    modCounts.forEach((count, slotId) => {
      emitSlotEntry(slotId, () => {
        this.pushNumberConstant(count);
      });
    });

    return argc;
  }

  /**
   * Emit a list of slot expressions (the anonymous args or the named
   * parameters) into their positional slots. A non-repeated slot takes the
   * single value of its entry. A repeated slot (one from a `repeat` call-spec)
   * gathers every entry that shares its slotId, in source order, into one
   * `List<T>` value built with `LIST_NEW` + a `LIST_PUSH` per element; the list
   * is emitted once, at the first entry of that slot, and the slot's remaining
   * entries are folded into it. Per-element type conversions are applied to each
   * element before its `LIST_PUSH`, exactly as a non-repeated slot converts its
   * single value.
   */
  private emitSlotExprs(
    slotExprs: ReadonlyList<SlotExpr>,
    argSlots: ReadonlyList<BrainActionArgSlot>,
    emitSlotEntry: (slotId: number, emitValue: () => void) => void
  ): void {
    const gathered = new Dict<number, boolean>();
    for (let i = 0; i < slotExprs.size(); i++) {
      const slot = slotExprs.get(i);
      const argSlot = argSlots.at(slot.slotId);
      if (argSlot?.repeated) {
        if (gathered.get(slot.slotId)) {
          continue;
        }
        gathered.set(slot.slotId, true);
        emitSlotEntry(slot.slotId, () => {
          this.emitter.listNew(this.repeatedSlotListTypeIdx(argSlot, slotExprs));
          for (let j = 0; j < slotExprs.size(); j++) {
            const entry = slotExprs.get(j);
            if (entry.slotId !== slot.slotId) {
              continue;
            }
            acceptExprVisitor(entry.expr, this);
            this.emitConversionIfNeeded(entry.expr.nodeId);
            this.emitter.listPush();
          }
        });
      } else {
        emitSlotEntry(slot.slotId, () => {
          acceptExprVisitor(slot.expr, this);
          // The conversion is stored on the entry's node (the ParameterExpr for
          // a named parameter, the value node for an anonymous arg) -- the same
          // node validateActionCallSlot annotates.
          this.emitConversionIfNeeded(slot.expr.nodeId);
        });
      }
    }
  }

  /**
   * Resolve the constant-pool type-table index for a repeated slot's gathered
   * `List<T>`. The element type `T` is the slot parameter tile's `dataType`;
   * when the tile cannot be resolved it falls back to the first gathered
   * entry's inferred type, then to `Any`.
   */
  private repeatedSlotListTypeIdx(argSlot: BrainActionArgSlot, slotExprs: ReadonlyList<SlotExpr>): number {
    let elementTypeId: TypeId | undefined = this.resolveParameterDataType(argSlot.argSpec.tileId);
    if (elementTypeId === undefined) {
      for (let i = 0; i < slotExprs.size(); i++) {
        const entry = slotExprs.get(i);
        if (entry.slotId === argSlot.slotId) {
          elementTypeId = this.context.typeEnv.get(entry.expr.nodeId)?.inferred;
          break;
        }
      }
    }
    const listTypeId = this.context.typeRegistry.instantiate("List", List.from([elementTypeId ?? CoreTypeIds.Any]));
    return this.context.constantPool.addType(listTypeId);
  }

  /** The `dataType` of the parameter tile with `tileId`, or undefined when not a parameter tile. */
  private resolveParameterDataType(tileId: string): TypeId | undefined {
    for (let i = 0; i < this.context.catalogs.size(); i++) {
      const tileDef = this.context.catalogs.get(i).get(tileId);
      if (tileDef?.kind === "parameter") {
        return (tileDef as BrainTileParameterDef).dataType;
      }
    }
    return undefined;
  }

  // ==========================================
  // Field Access
  // ==========================================

  visitFieldAccess(expr: FieldAccessExpr): void {
    acceptExprVisitor(expr.object, this);
    const fieldId = this.context.typeEnv.get(expr.nodeId)?.fieldId;
    if (fieldId !== undefined) {
      // Object's static type is a concrete struct: read the field by its numeric id.
      this.emitter.structGetField(fieldId);
    } else {
      // Object's static type is not a concrete struct with this field: resolve the
      // field name to its id at runtime via the name-keyed opcode.
      this.pushStringConstant(expr.accessor.fieldName);
      this.emitter.getField();
    }
  }

  // ==========================================
  // Empty Expression
  // ==========================================

  visitEmpty(expr: EmptyExpr): void {
    // Do nothing - empty expressions produce no value and have no effect
  }

  // ==========================================
  // Error Expression
  // ==========================================

  /** Lowers an unparseable expression: reports it as a dropped expression and leaves NIL on the operand stack. */
  visitError(expr: ErrorExpr): void {
    this.reportDroppedExpr(expr.nodeId, expr.span?.from, expr.message);
    this.pushNilPlaceholder();
  }

  /**
   * Record that code generation emitted nothing for an expression, so the build
   * result carries the drop. Call for every expression the compiler discards.
   *
   * @param nodeId - Node id of the discarded expression.
   * @param tileIndex - Index of the expression's first tile in the rule side, when known.
   * @param reason - Parser text describing why the expression is uncompilable.
   */
  reportDroppedExpr(nodeId: number, tileIndex: number | undefined, reason: string): void {
    const tileId = this.tileIdAt(tileIndex);
    const sideName = this.context.ruleSide === RuleSide.When ? "WHEN" : "DO";
    const where = `rule '${this.context.rulePath}' ${sideName}`;
    const at = tileId === undefined ? where : `${where} at tile '${tileId}'`;
    const message = `Dropped uncompilable expression in ${at}: ${reason}`;
    logger.warn(message);
    this.context.diags.push({
      code: CompilationDiagCode.UncompilableExpressionDropped,
      severity: diagnosticSeverity(CompilationDiagCode.UncompilableExpressionDropped),
      message,
      nodeId,
      params: { rulePath: this.context.rulePath, side: this.context.ruleSide, tileId },
    });
  }

  /** Tile id of the rule side's tile at `index`, or undefined when out of range. */
  private tileIdAt(index: number | undefined): string | undefined {
    if (index === undefined || index < 0 || index >= this.context.sideTiles.size()) {
      return undefined;
    }
    return this.context.sideTiles.get(index).tileId;
  }
}
