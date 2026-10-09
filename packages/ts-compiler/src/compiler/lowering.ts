import { assertUnreachable, List } from "@wendoo/core";
import type { BrainServices } from "@wendoo/core/brain";
import {
  ContextTypeIds,
  CoreOpId,
  CoreTypeIds,
  conversionFnName,
  type EnumTypeDef,
  isBytecodeConversion,
  isSharedHostFnConversion,
  mkNumberValue,
  mkOutputVarKey,
  mkStringValue,
  NativeType,
  NIL_VALUE,
  type NullableTypeDef,
  type StructFieldDef,
  type StructTypeDef,
  type TypeId,
  type UnionTypeDef,
  type Value,
} from "@wendoo/core/runtime";
import ts from "typescript";
import { type ArgSlot, collectArgSlots } from "./arg-spec-utils.js";
import { CompileDiagCode, LoweringDiagCode } from "./diag-codes.js";
import { qualifiedDeclarationName } from "./extension-mounts.js";
import type { IrNode, IrSourceSpan } from "./ir.js";
import { type LocalMetadata, type ScopeMetadata, ScopeStack } from "./scope.js";
import { scopedOutputName } from "./symbol-keys.js";
import {
  ambientTypeTokenName,
  isWendooModuleDeclaration,
  resolveTypeNameExpression,
  shorthandValueExpression,
  structTypeCallExpression,
  structTypeConfigObject,
} from "./type-ref.js";
import type { ArtifactStructTypeInfo, CompileDiagnostic, ExtractedDescriptor } from "./types.js";

const TRUE_VALUE: Value = { t: 2, v: true };
const FALSE_VALUE: Value = { t: 2, v: false };

/** A lowered function: IR body plus the slot/scope metadata needed by the emitter. */
export interface FunctionEntry {
  ir: IrNode[];
  numParams: number;
  numLocals: number;
  name: string;
  injectCtxTypeId?: TypeId;
  scopeMetadata?: ScopeMetadata[];
  localMetadata?: LocalMetadata[];
  isGenerated?: boolean;
  parentName?: string;
  sourceFileName?: string;
  functionSpan?: IrSourceSpan;
}

/** A function imported from another user-tile source file by the lowering phase. */
export interface ImportedFunction {
  localName: string;
  node: ts.FunctionDeclaration;
}

/** A top-level `const` variable imported from another user-tile source file. */
export interface ImportedVariable {
  name: string;
  initializer: ts.Expression | undefined;
  sourceModule: string;
}

/** A class declaration imported from another user-tile source file. */
export interface ImportedClass {
  node: ts.ClassDeclaration;
  name: string;
  sourceFile: ts.SourceFile;
}

/** An enum declaration imported from another user-tile source file. */
export interface ImportedEnum {
  node: ts.EnumDeclaration;
  name: string;
  sourceFile: ts.SourceFile;
}

/** An interface declaration imported from another user-tile source file. */
export interface ImportedInterface {
  node: ts.InterfaceDeclaration;
  name: string;
  sourceFile: ts.SourceFile;
}

/** A type alias imported from another user-tile source file. */
export interface ImportedTypeAlias {
  node: ts.TypeAliasDeclaration;
  name: string;
  sourceFile: ts.SourceFile;
}

interface ClassInfo {
  node: ts.ClassDeclaration;
  name: string;
  sourceFile: ts.SourceFile;
  constructorFuncId: number;
  methodFuncIds: Map<string, number>;
  staticFieldSlots: Map<string, number>;
  staticMethodFuncIds: Map<string, number>;
  getterFuncIds: Map<string, number>;
  setterFuncIds: Map<string, number>;
  staticGetterFuncIds: Map<string, number>;
  staticSetterFuncIds: Map<string, number>;
}

/** A function-like config member of a `System({...})` (method shorthand, function, or arrow). */
type SystemFnNode = ts.MethodDeclaration | ts.FunctionExpression | ts.ArrowFunction;

/**
 * A `const X = System({...})` binding collected during lowering. Holds the
 * program-local store slot, the registered state struct type, and the func ids
 * for the user `init` / `think` bodies, the generated wrappers the runtime
 * calls, and each method (a struct-receiver function over the state).
 */
interface SystemBinding {
  /** Stable cross-module identity (`<declaring-file>::<binding-name>`); the store key. */
  identity: string;
  /** Display / debug name from `config.name`. */
  name: string;
  /** Program-local System store slot. */
  localSlot: number;
  /** Registered state struct type id, or `undefined` when the state shape did not resolve. */
  stateTypeId: TypeId | undefined;
  /** The `state` initializer expression, lowered into the store by the init wrapper. */
  stateNode: ts.Expression;
  /** Generated ctx-injected init wrapper func id (builds state, then calls the user `init`). */
  initWrapperFuncId: number;
  /** Generated ctx-injected think wrapper func id, when a `think` is declared. */
  thinkWrapperFuncId?: number;
  /** User `init` body func id (struct-receiver + ctx), when declared. */
  userInitFuncId?: number;
  /** User `init` body node, when declared. */
  initNode?: SystemFnNode;
  /** User `think` body func id (struct-receiver + ctx), when declared. */
  userThinkFuncId?: number;
  /** User `think` body node, when declared. */
  thinkNode?: SystemFnNode;
  /** Method name -> struct-receiver func id. */
  methodFuncIds: Map<string, number>;
  /** Method name -> body node. */
  methodNodes: Map<string, SystemFnNode>;
}

interface InterfaceInfo {
  node: ts.InterfaceDeclaration;
  name: string;
  sourceFile: ts.SourceFile;
}

interface TypeAliasInfo {
  node: ts.TypeAliasDeclaration;
  name: string;
  sourceFile: ts.SourceFile;
}

export { qualifiedClassName } from "./symbol-keys.js";

function resolveAliasedSymbol(symbol: ts.Symbol | undefined, checker?: ts.TypeChecker): ts.Symbol | undefined {
  if (!symbol || !checker || !(symbol.flags & ts.SymbolFlags.Alias)) {
    return symbol;
  }
  return checker.getAliasedSymbol(symbol);
}

function isUserSourceDecl(decl: ts.Declaration): boolean {
  const sf = decl.getSourceFile();
  return !sf.fileName.endsWith(".d.ts");
}

/** Result of lowering a TS source file to IR functions ready for emission. */
export interface ProgramLoweringResult {
  functions: FunctionEntry[];
  entryFuncId: number;
  /**
   * Func id of the module-scope initializer body. Runs once per
   * `(brainInstance, callSiteId)`, on the first allocation of the action's
   * callsite, before any activation hook. Set when the action contains
   * top-level `let`/`const` initializers, imported initializers, or static
   * class fields.
   */
  initializerFuncId?: number;
  /**
   * Func id of the per-page-activation entry hook. Runs every time the
   * owning page is activated. Set when the action declares an
   * `onPageEntered` handler.
   */
  activationFuncId?: number;
  /**
   * Func id of the per-page-deactivation hook. Runs every time the owning
   * page is deactivated, before fiber cancellation. Set when the action
   * declares an `onPageExited` handler.
   */
  deactivationFuncId?: number;
  numStateSlots: number;
  functionTable: Map<string, number>;
  diagnostics: CompileDiagnostic[];
  /**
   * Systems (user-code shared singletons) referenced by this program, each with
   * its program-local store slot and generated init/think wrapper func ids. The
   * linker resolves `identity` to a brain-global store slot and registers each
   * System once across all artifacts.
   */
  systems: LoweredSystem[];
  /** Struct types this program declared or imported, in collection order. */
  structTypes: ArtifactStructTypeInfo[];
}

/** A System referenced by a lowered program, carrying program-local ids for the linker to remap. */
export interface LoweredSystem {
  /** Stable cross-module identity (`<declaring-file>::<binding-name>`); the store key. */
  identity: string;
  /** Display / debug name from the `System({ name })` config. */
  name: string;
  /** Program-local System store slot (operand of `LOAD_SYSTEM_VAR` / `STORE_SYSTEM_VAR`). */
  localSlot: number;
  /** Program-local func id of the generated ctx-injected init wrapper. */
  initFuncId: number;
  /** Program-local func id of the generated ctx-injected think wrapper, if a `think` is declared. */
  thinkFuncId?: number;
}

interface LoopContext {
  continueLabel: number;
  breakLabel: number;
}

interface LowerContext {
  services: BrainServices;
  /** Namespace of the project being compiled; prefixes every symbol key minted from its content. */
  projectNamespace: string;
  checker: ts.TypeChecker;
  paramsSymbol: ts.Symbol | undefined;
  paramLocals: Map<string, number>;
  /**
   * Action arg property name -> its positional local slot (locals `1..N`), set
   * for a sensor/actuator `onExecute` that declares args. Consulted only by the
   * `args.<prop>` access path. Bare identifiers and assignment targets resolve
   * against {@link scopeStack}; a local with the same name as an arg shadows it.
   * Absent outside `onExecute`.
   */
  argLocals?: Map<string, number>;
  scopeStack: ScopeStack;
  ir: IrNode[];
  diagnostics: CompileDiagnostic[];
  loopStack: LoopContext[];
  breakStack: number[];
  nextLabelId: number;
  callsiteVars: Map<string, number>;
  functionTable: Map<string, number>;
  capturedVars?: Map<string, number>;
  funcIdCounter: { value: number };
  closureFunctions: Map<number, FunctionEntry>;
  thisLocalIndex?: number;
  /**
   * Registered struct type id of `this` inside a System method body. Set only
   * when lowering a System `init` / `think` / method, whose `this` is the
   * anonymous state struct the TS type resolver does not map to a registry name.
   */
  thisStructTypeId?: TypeId;
  /**
   * The enclosing System's method name -> func id map, used to dispatch a
   * `this.method(...)` sibling call. Set alongside {@link thisStructTypeId} when
   * lowering a System `init` / `think` / method body.
   */
  thisSystemMethodFuncIds?: Map<string, number>;
  staticClassInfo?: ClassInfo;
  currentFunctionName: string;
  currentReturnTypeId?: TypeId;
  optionalChainSubstitution?: { targetExpr: ts.Expression; localIndex: number };
  classInfos: ClassInfo[];
  /**
   * System bindings in scope, keyed by the resolved declaration symbol of the
   * `const X = System({...})` variable. A reference to such a symbol lowers to
   * `LOAD_SYSTEM_VAR`; a `X.method(...)` call lowers to a struct-receiver call
   * over the System's state. Absent in contexts that cannot reach a System.
   */
  systemBindings?: Map<ts.Symbol, SystemBinding>;
  /**
   * Declared outputs of the enclosing sensor, mapping each output name to its
   * resolved value {@link TypeId}. A `setOutput(ctx, name, value)` call resolves
   * `name` here to form the backing rule-variable key. Set only when lowering a
   * sensor `onExecute` that declares `outputs`; absent elsewhere, so `setOutput`
   * outside a sensor body is diagnosed.
   */
  sensorOutputs?: Map<string, TypeId>;
  /**
   * Every output name the enclosing sensor declares, including any whose declared
   * type did not resolve. Set alongside {@link sensorOutputs}.
   */
  sensorOutputNames?: Set<string>;
  hoistedFunctionNodes?: Set<ts.Node>;
  /**
   * Defining-module `const` bindings an imported System body references, keyed by
   * declaration symbol. A reference resolving to such a symbol re-lowers the
   * const's initializer inline; the per-callsite slot backing a module-level
   * const is not bound in the fiber that runs a System's `init` / `think` /
   * methods. Set on System `init` / `think` / method bodies, a System's `init`
   * state wrapper, and the helper functions they call.
   */
  inlineConsts?: Map<ts.Symbol, ts.Expression>;
  /**
   * Const symbols currently being inlined, guarding the re-lowering recursion in
   * {@link lowerIdentifier} against a cyclic `const` reference. Created alongside
   * {@link inlineConsts}.
   */
  inliningConsts?: Set<ts.Symbol>;
  /**
   * Carried non-exported functions in scope, keyed by declaration symbol to their
   * function-table identity key. A call or reference whose callee resolves to such
   * a symbol looks up the identity key, keeping same-named private helpers from
   * different modules distinct. Set on the same bodies as {@link inlineConsts}.
   */
  carriedFunctionKeys?: Map<ts.Symbol, string>;
  /**
   * When the body being lowered cannot suspend, the clause naming it for an
   * async-host-call diagnostic (e.g. "a synchronous `onExecute`"). Absent for a
   * suspendable body (an `async onExecute`) and for plain helper and closure
   * bodies.
   */
  nonSuspendableContext?: string;
}

function allocLabel(ctx: LowerContext): number {
  return ctx.nextLabelId++;
}

function pushLoopContext(continueLabel: number, breakLabel: number, ctx: LowerContext): void {
  ctx.loopStack.push({ continueLabel, breakLabel });
  ctx.breakStack.push(breakLabel);
}

function popLoopContext(ctx: LowerContext): void {
  ctx.loopStack.pop();
  ctx.breakStack.pop();
}

function emitNilGuard(ctx: LowerContext): { endLabel: number } {
  const keepLabel = allocLabel(ctx);
  const endLabel = allocLabel(ctx);
  ctx.ir.push({ kind: "Dup" });
  ctx.ir.push({ kind: "TypeCheck", nativeType: NativeType.Nil });
  ctx.ir.push({ kind: "JumpIfFalse", labelId: keepLabel });
  ctx.ir.push({ kind: "Pop" });
  ctx.ir.push({ kind: "PushConst", value: NIL_VALUE });
  ctx.ir.push({ kind: "Jump", labelId: endLabel });
  ctx.ir.push({ kind: "Label", labelId: keepLabel });
  return { endLabel };
}

function findOptionalChainRoot(
  expr: ts.Expression
): ts.PropertyAccessExpression | ts.ElementAccessExpression | ts.CallExpression | undefined {
  let current: ts.Expression = expr;
  while (true) {
    if (
      (ts.isPropertyAccessExpression(current) ||
        ts.isElementAccessExpression(current) ||
        ts.isCallExpression(current)) &&
      ts.isOptionalChain(current)
    ) {
      if (current.questionDotToken) return current;
      current = current.expression;
    } else {
      return undefined;
    }
  }
}

function resolveOperator(opId: string, argTypes: string[], services: BrainServices): string | undefined {
  return services.edit.operatorOverloads.resolve(opId, argTypes)?.overload.fnEntry?.name;
}

// Operator resolution with type expansion: if a direct overload lookup fails,
// expand union/struct types into their constituent members and check whether
// ALL members map to the same operator function. This allows e.g. (A | B) + Number
// to resolve when both A + Number and B + Number use the same underlying function.
function resolveOperatorWithExpansion(opId: string, argTypes: string[], services: BrainServices): string | undefined {
  const direct = resolveOperator(opId, argTypes, services);
  if (direct) return direct;

  if (argTypes.length === 1) {
    const members = expandTypeIdMembers(argTypes[0], services);
    if (members.length === 1 && members[0] === argTypes[0]) return undefined;
    let resolved: string | undefined;
    for (const m of members) {
      const fn = resolveOperator(opId, [m], services);
      if (!fn) return undefined;
      if (resolved === undefined) {
        resolved = fn;
      } else if (resolved !== fn) {
        return undefined;
      }
    }
    return resolved;
  }

  if (argTypes.length === 2) {
    const lhsMembers = expandTypeIdMembers(argTypes[0], services);
    const rhsMembers = expandTypeIdMembers(argTypes[1], services);
    if (
      lhsMembers.length === 1 &&
      lhsMembers[0] === argTypes[0] &&
      rhsMembers.length === 1 &&
      rhsMembers[0] === argTypes[1]
    ) {
      return undefined;
    }
    let resolved: string | undefined;
    for (const l of lhsMembers) {
      for (const r of rhsMembers) {
        const fn = resolveOperator(opId, [l, r], services);
        if (!fn) return undefined;
        if (resolved === undefined) {
          resolved = fn;
        } else if (resolved !== fn) {
          return undefined;
        }
      }
    }
    return resolved;
  }

  return undefined;
}

interface SingleStepConversionResolution {
  fromTypeId: string;
  toTypeId: string;
  fnName: string;
}

interface BinaryOperatorResolution {
  operatorFnName: string;
  conversion?: SingleStepConversionResolution & { operand: "left" | "right" };
}

type TargetTypedConversionResolution =
  | { kind: "none" }
  | { kind: "convert"; conversion: SingleStepConversionResolution }
  | { kind: "missing" }
  | { kind: "ambiguous" };

function resolveRegisteredEnumTypeIdFromSymbol(
  sym: ts.Symbol,
  services: BrainServices,
  projectNamespace: string,
  checker?: ts.TypeChecker
): string | undefined {
  const resolvedSym = resolveAliasedSymbol(sym, checker);
  if (!resolvedSym) return undefined;

  const registry = services.runtime.types;
  const typeId = registry.resolveByName(resolveRegistryName(resolvedSym, services, projectNamespace, checker));
  if (!typeId) return undefined;

  const typeDef = registry.get(typeId);
  if (!typeDef || typeDef.coreType !== NativeType.Enum) {
    return undefined;
  }

  return typeId;
}

function resolveRegisteredEnumTypeId(
  type: ts.Type,
  services: BrainServices,
  projectNamespace: string,
  checker?: ts.TypeChecker
): string | undefined {
  const sym = type.getSymbol() ?? type.aliasSymbol;
  if (!sym) return undefined;
  return resolveRegisteredEnumTypeIdFromSymbol(sym, services, projectNamespace, checker);
}

/**
 * Resolve an enum-literal type (a single member type, the enum type itself,
 * or a union of member literals of one enum) to the registered enum's typeId.
 * Returns undefined for any other type, including a union that mixes members
 * of different enums or non-enum constituents.
 */
function resolveEnumLiteralTypeId(
  type: ts.Type,
  services: BrainServices,
  projectNamespace: string,
  checker?: ts.TypeChecker
): string | undefined {
  if (type.isUnion()) {
    let resolved: string | undefined;
    for (const member of type.types) {
      const memberId = resolveEnumMemberOwnerTypeId(member, services, projectNamespace, checker);
      if (!memberId || (resolved !== undefined && resolved !== memberId)) {
        return undefined;
      }
      resolved = memberId;
    }
    return resolved;
  }
  return resolveEnumMemberOwnerTypeId(type, services, projectNamespace, checker);
}

function resolveEnumMemberOwnerTypeId(
  type: ts.Type,
  services: BrainServices,
  projectNamespace: string,
  checker?: ts.TypeChecker
): string | undefined {
  if (!(type.flags & ts.TypeFlags.EnumLiteral)) {
    return undefined;
  }
  const sym = resolveAliasedSymbol(type.getSymbol() ?? type.aliasSymbol, checker);
  if (!sym) return undefined;
  const memberDecl = sym.getDeclarations()?.find(ts.isEnumMember);
  if (memberDecl && checker) {
    const enumSym = checker.getSymbolAtLocation(memberDecl.parent.name);
    if (!enumSym) return undefined;
    return resolveRegisteredEnumTypeIdFromSymbol(enumSym, services, projectNamespace, checker);
  }
  return resolveRegisteredEnumTypeIdFromSymbol(sym, services, projectNamespace, checker);
}

/**
 * Strips the parentheses, `as` casts, and non-null assertions around `expr`,
 * each of which evaluates to the value of the expression it wraps, and returns
 * the expression they wrap; `expr` itself when it has none.
 */
function unwrapTransparentExpression(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isNonNullExpression(current)) {
    current = current.expression;
  }
  return current;
}

function resolveDeclaredEnumTypeId(exprNode: ts.Expression, ctx: LowerContext): string | undefined {
  const targetExpr = unwrapTransparentExpression(exprNode);
  if (!ts.isIdentifier(targetExpr)) {
    return undefined;
  }

  const symbol = ctx.checker.getSymbolAtLocation(targetExpr);
  const declaration = symbol?.valueDeclaration;
  if (!symbol || !declaration) {
    return undefined;
  }

  const declaredType = ctx.checker.getTypeOfSymbolAtLocation(symbol, declaration);
  return resolveRegisteredEnumTypeId(declaredType, ctx.services, ctx.projectNamespace, ctx.checker);
}

function resolveExpressionTypeId(exprNode: ts.Expression, ctx: LowerContext): string | undefined {
  if (ts.isStringLiteral(exprNode)) {
    const enumValue = tryResolveEnumValue(exprNode, ctx);
    if (enumValue && enumValue.t === NativeType.Enum) {
      return enumValue.typeId;
    }
  }

  // A struct factory call produces the declared struct type.
  if (ts.isCallExpression(exprNode) && ts.isIdentifier(exprNode.expression)) {
    const structDef = resolveStructTypeFactory(exprNode.expression, ctx);
    if (structDef) {
      return structDef.typeId;
    }
  }

  if (ts.isPropertyAccessExpression(exprNode)) {
    const enumAccess = resolveEnumPropertyAccess(exprNode, ctx);
    if (enumAccess?.kind === "member" && enumAccess.value.t === NativeType.Enum) {
      return enumAccess.value.typeId;
    }
  }

  const declaredEnumTypeId = resolveDeclaredEnumTypeId(exprNode, ctx);
  if (declaredEnumTypeId) {
    return declaredEnumTypeId;
  }

  const exprType = ctx.checker.getTypeAtLocation(exprNode);
  return tsTypeToTypeId(exprType, ctx.checker, ctx.services, ctx.projectNamespace);
}

function resolveSingleStepConversion(
  fromTypeId: string,
  toTypeId: string,
  services: BrainServices
): SingleStepConversionResolution | undefined {
  if (fromTypeId === toTypeId) {
    return undefined;
  }

  const conversionPath = services.shared.conversions.findBestPath(fromTypeId, toTypeId, 1);
  const conversion = conversionPath?.at(0);
  if (!conversion) {
    return undefined;
  }

  // A bytecode conversion lives in another artifact; user-code expressions can
  // only reach host-function conversions, so it does not apply here.
  if (isBytecodeConversion(conversion)) {
    return undefined;
  }

  // A shared-host-function conversion dispatches to a function registered
  // independently of the (from, to) pair; resolve its name by funcId.
  if (isSharedHostFnConversion(conversion)) {
    const entry = services.runtime.functions.getSyncById(conversion.id);
    if (!entry) {
      return undefined;
    }
    return {
      fromTypeId: conversion.fromType,
      toTypeId: conversion.toType,
      fnName: entry.name,
    };
  }

  return {
    fromTypeId: conversion.fromType,
    toTypeId: conversion.toType,
    fnName: conversionFnName(conversion.fromType, conversion.toType),
  };
}

function emitSingleStepConversion(fnName: string, ctx: LowerContext): void {
  ctx.ir.push({ kind: "HostCall", fnName, argc: 1 });
}

function resolveExpandedTargetTypeIds(expectedTypeId: TypeId, services: BrainServices): TypeId[] {
  const registry = services.runtime.types;
  const typeDef = registry.get(expectedTypeId);
  if (!typeDef) {
    return [expectedTypeId];
  }

  if (typeDef.nullable) {
    return [(typeDef as NullableTypeDef).baseTypeId, CoreTypeIds.Nil];
  }

  if (typeDef.coreType === NativeType.Union) {
    const memberTypeIds: TypeId[] = [];
    (typeDef as UnionTypeDef).memberTypeIds.forEach((memberTypeId) => {
      memberTypeIds.push(memberTypeId);
    });
    return memberTypeIds;
  }

  return [expectedTypeId];
}

function isSatisfiedWithoutTargetTypeConversion(
  sourceTypeId: TypeId,
  expectedTypeId: TypeId,
  services: BrainServices
): boolean {
  if (sourceTypeId === expectedTypeId || expectedTypeId === CoreTypeIds.Any || sourceTypeId === CoreTypeIds.Any) {
    return true;
  }

  const registry = services.runtime.types;
  const sourceDef = registry.get(sourceTypeId);
  const expectedDef = registry.get(expectedTypeId);
  if (!sourceDef || !expectedDef) {
    return false;
  }

  if (sourceDef.coreType === NativeType.Struct && expectedDef.coreType === NativeType.Struct) {
    return registry.isStructurallyCompatible(sourceTypeId, expectedTypeId);
  }

  if (sourceDef.coreType === NativeType.List && expectedDef.coreType === NativeType.List) {
    return true;
  }

  if (sourceDef.coreType === NativeType.Map && expectedDef.coreType === NativeType.Map) {
    return true;
  }

  if (sourceDef.coreType === NativeType.Function && expectedDef.coreType === NativeType.Function) {
    return true;
  }

  return false;
}

function resolveTargetTypedConversion(
  sourceTypeId: TypeId,
  expectedTypeId: TypeId,
  services: BrainServices
): TargetTypedConversionResolution {
  if (isSatisfiedWithoutTargetTypeConversion(sourceTypeId, expectedTypeId, services)) {
    return { kind: "none" };
  }

  const candidateTypeIds = resolveExpandedTargetTypeIds(expectedTypeId, services);
  for (const candidateTypeId of candidateTypeIds) {
    if (isSatisfiedWithoutTargetTypeConversion(sourceTypeId, candidateTypeId, services)) {
      return { kind: "none" };
    }
  }

  const candidateConversions: SingleStepConversionResolution[] = [];
  for (const candidateTypeId of candidateTypeIds) {
    const conversion = resolveSingleStepConversion(sourceTypeId, candidateTypeId, services);
    if (conversion) {
      candidateConversions.push(conversion);
    }
  }

  if (candidateConversions.length === 1) {
    return { kind: "convert", conversion: candidateConversions[0] };
  }

  if (candidateConversions.length > 1) {
    return { kind: "ambiguous" };
  }

  return { kind: "missing" };
}

function emitTargetTypeConversionDiagnostic(
  sourceTypeId: TypeId,
  expectedTypeId: TypeId,
  siteDescription: string,
  isAmbiguous: boolean,
  diagNode: ts.Node,
  ctx: LowerContext
): void {
  const message = isAmbiguous
    ? `No unique conversion from ${sourceTypeId} to expected type ${expectedTypeId} for ${siteDescription}`
    : `No conversion from ${sourceTypeId} to expected type ${expectedTypeId} for ${siteDescription}`;
  ctx.diagnostics.push(makeDiag(LoweringDiagCode.NoConversionToTargetType, message, diagNode));
}

function lowerExpressionWithExpectedType(
  exprNode: ts.Expression,
  expectedTypeId: TypeId | undefined,
  siteDescription: string,
  diagNode: ts.Node,
  ctx: LowerContext
): void {
  lowerExpression(exprNode, ctx);

  if (!expectedTypeId) {
    return;
  }

  const sourceTypeId = resolveExpressionTypeId(exprNode, ctx);
  if (!sourceTypeId) {
    return;
  }

  const resolution = resolveTargetTypedConversion(sourceTypeId, expectedTypeId, ctx.services);
  if (resolution.kind === "none") {
    return;
  }

  if (resolution.kind === "convert") {
    emitSingleStepConversion(resolution.conversion.fnName, ctx);
    return;
  }

  emitTargetTypeConversionDiagnostic(
    sourceTypeId,
    expectedTypeId,
    siteDescription,
    resolution.kind === "ambiguous",
    diagNode,
    ctx
  );
}

function resolveSignatureReturnTypeId(
  signatureDecl: ts.SignatureDeclarationBase,
  checker: ts.TypeChecker,
  services: BrainServices,
  projectNamespace: string
): TypeId | undefined {
  const signature = checker.getSignatureFromDeclaration(signatureDecl as ts.SignatureDeclaration);
  if (!signature) {
    return undefined;
  }

  return tsTypeToTypeId(checker.getReturnTypeOfSignature(signature), checker, services, projectNamespace);
}

function resolveVariableDeclarationTargetTypeId(decl: ts.VariableDeclaration, ctx: LowerContext): TypeId | undefined {
  const targetType = ctx.checker.getTypeAtLocation(decl.name);
  return tsTypeToTypeId(targetType, ctx.checker, ctx.services, ctx.projectNamespace);
}

function resolveCallArgumentTargetTypeId(
  callExpr: ts.CallExpression,
  argIndex: number,
  ctx: LowerContext
): TypeId | undefined {
  const signature = ctx.checker.getResolvedSignature(callExpr);
  if (!signature) {
    return undefined;
  }

  const parameters = signature.getParameters();
  if (parameters.length === 0) {
    return undefined;
  }

  let parameterIndex = argIndex;
  if (parameterIndex >= parameters.length) {
    const lastParam = parameters[parameters.length - 1];
    const lastDeclaration = lastParam.valueDeclaration ?? lastParam.declarations?.[0];
    if (!lastDeclaration || !ts.isParameter(lastDeclaration) || !lastDeclaration.dotDotDotToken) {
      return undefined;
    }
    parameterIndex = parameters.length - 1;
  }

  const parameter = parameters[parameterIndex];
  const parameterLocation = parameter.valueDeclaration ?? parameter.declarations?.[0] ?? callExpr.expression;
  const parameterType = ctx.checker.getTypeOfSymbolAtLocation(parameter, parameterLocation);
  return tsTypeToTypeId(parameterType, ctx.checker, ctx.services, ctx.projectNamespace);
}

interface RestParamInfo {
  restIndex: number;
  listTypeId: string;
}

function resolveRestParamInfo(callExpr: ts.CallExpression, ctx: LowerContext): RestParamInfo | undefined {
  const signature = ctx.checker.getResolvedSignature(callExpr);
  if (!signature) return undefined;

  const parameters = signature.getParameters();
  if (parameters.length === 0) return undefined;

  const lastParam = parameters[parameters.length - 1];
  const lastDeclaration = lastParam.valueDeclaration ?? lastParam.declarations?.[0];
  if (!lastDeclaration || !ts.isParameter(lastDeclaration) || !lastDeclaration.dotDotDotToken) {
    return undefined;
  }

  const paramType = ctx.checker.getTypeOfSymbolAtLocation(lastParam, lastDeclaration);
  const listTypeId = resolveListTypeId(paramType, ctx);
  if (!listTypeId) {
    ctx.diagnostics.push(
      makeDiag(LoweringDiagCode.CannotResolveRestParamListType, "Cannot resolve list type for rest parameter", callExpr)
    );
    return undefined;
  }

  return { restIndex: parameters.length - 1, listTypeId };
}

function lowerCallArgumentsWithTargetTypes(callExpr: ts.CallExpression, ctx: LowerContext): number {
  const restInfo = resolveRestParamInfo(callExpr, ctx);

  const spreadIndex = callExpr.arguments.findIndex((arg) => ts.isSpreadElement(arg));

  if (spreadIndex >= 0) {
    if (spreadIndex < callExpr.arguments.length - 1) {
      ctx.diagnostics.push(
        makeDiag(
          LoweringDiagCode.SpreadMustBeLastArgument,
          "Spread argument must be the last argument",
          callExpr.arguments[spreadIndex]
        )
      );
      return callExpr.arguments.length;
    }

    if (!restInfo) {
      ctx.diagnostics.push(
        makeDiag(
          LoweringDiagCode.SpreadRequiresRestTarget,
          "Spread in function call requires target to have a rest parameter",
          callExpr.arguments[spreadIndex]
        )
      );
      return callExpr.arguments.length;
    }

    const spreadElement = callExpr.arguments[spreadIndex] as ts.SpreadElement;

    for (let argIndex = 0; argIndex < Math.min(restInfo.restIndex, spreadIndex); argIndex++) {
      const argument = callExpr.arguments[argIndex];
      const expectedTypeId = resolveCallArgumentTargetTypeId(callExpr, argIndex, ctx);
      lowerExpressionWithExpectedType(argument, expectedTypeId, `function argument ${argIndex + 1}`, argument, ctx);
    }

    if (spreadIndex === restInfo.restIndex) {
      lowerExpression(spreadElement.expression, ctx);
    } else {
      const restListLocal = ctx.scopeStack.allocLocal();
      ctx.ir.push({ kind: "ListNew", typeId: restInfo.listTypeId });
      ctx.ir.push({ kind: "StoreLocal", index: restListLocal });

      for (let argIndex = restInfo.restIndex; argIndex < spreadIndex; argIndex++) {
        ctx.ir.push({ kind: "LoadLocal", index: restListLocal });
        lowerExpression(callExpr.arguments[argIndex], ctx);
        ctx.ir.push({ kind: "ListPush" });
        ctx.ir.push({ kind: "StoreLocal", index: restListLocal });
      }

      emitPushAllFromList(spreadElement.expression, restListLocal, ctx, callExpr);
      ctx.ir.push({ kind: "LoadLocal", index: restListLocal });
    }

    return restInfo.restIndex + 1;
  }

  if (!restInfo || callExpr.arguments.length <= restInfo.restIndex) {
    for (let argIndex = 0; argIndex < callExpr.arguments.length; argIndex++) {
      const argument = callExpr.arguments[argIndex];
      const expectedTypeId = resolveCallArgumentTargetTypeId(callExpr, argIndex, ctx);
      lowerExpressionWithExpectedType(argument, expectedTypeId, `function argument ${argIndex + 1}`, argument, ctx);
    }
    if (restInfo && callExpr.arguments.length === restInfo.restIndex) {
      ctx.ir.push({ kind: "ListNew", typeId: restInfo.listTypeId });
      return restInfo.restIndex + 1;
    }
    return callExpr.arguments.length;
  }

  for (let argIndex = 0; argIndex < restInfo.restIndex; argIndex++) {
    const argument = callExpr.arguments[argIndex];
    const expectedTypeId = resolveCallArgumentTargetTypeId(callExpr, argIndex, ctx);
    lowerExpressionWithExpectedType(argument, expectedTypeId, `function argument ${argIndex + 1}`, argument, ctx);
  }

  ctx.ir.push({ kind: "ListNew", typeId: restInfo.listTypeId });
  for (let argIndex = restInfo.restIndex; argIndex < callExpr.arguments.length; argIndex++) {
    const argument = callExpr.arguments[argIndex];
    lowerExpression(argument, ctx);
    ctx.ir.push({ kind: "ListPush" });
  }

  return restInfo.restIndex + 1;
}

function emitOperandConversion(
  conversion: SingleStepConversionResolution & { operand: "left" | "right" },
  ctx: LowerContext
): void {
  if (conversion.operand === "left") {
    ctx.ir.push({ kind: "Swap" });
    emitSingleStepConversion(conversion.fnName, ctx);
    ctx.ir.push({ kind: "Swap" });
    return;
  }

  emitSingleStepConversion(conversion.fnName, ctx);
}

function resolveBinaryOperatorCandidate(
  opId: string,
  leftTypeId: string,
  rightTypeId: string,
  operand: "left" | "right",
  services: BrainServices
): BinaryOperatorResolution | undefined {
  const sourceTypeId = operand === "left" ? leftTypeId : rightTypeId;
  const targetTypeId = operand === "left" ? rightTypeId : leftTypeId;
  const conversion = resolveSingleStepConversion(sourceTypeId, targetTypeId, services);
  if (!conversion) {
    return undefined;
  }

  const operatorFnName = resolveOperatorWithExpansion(opId, [targetTypeId, targetTypeId], services);
  if (!operatorFnName) {
    return undefined;
  }

  return {
    operatorFnName,
    conversion: {
      ...conversion,
      operand,
    },
  };
}

function describeBinaryOperatorCandidate(candidate: BinaryOperatorResolution): string {
  if (!candidate.conversion) {
    return "direct overload";
  }

  return `${candidate.conversion.operand} operand ${candidate.conversion.fromTypeId} -> ${candidate.conversion.toTypeId}`;
}

function emitBinaryOperatorForNodes(
  opId: string,
  leftNode: ts.Expression,
  rightNode: ts.Expression,
  diagNode: ts.Node,
  ctx: LowerContext
): boolean {
  const lhsTypeId = resolveExpressionTypeId(leftNode, ctx);
  const rhsTypeId = resolveExpressionTypeId(rightNode, ctx);

  if (!lhsTypeId || !rhsTypeId) {
    ctx.diagnostics.push(
      makeDiag(LoweringDiagCode.CannotDetermineTypesForBinaryOp, "Cannot determine types for binary operator", diagNode)
    );
    return false;
  }

  const directResolution = resolveOperatorWithExpansion(opId, [lhsTypeId, rhsTypeId], ctx.services);
  if (directResolution) {
    ctx.ir.push({ kind: "HostCall", fnName: directResolution, argc: 2 });
    return true;
  }

  const rightCandidate = resolveBinaryOperatorCandidate(opId, lhsTypeId, rhsTypeId, "right", ctx.services);
  const leftCandidate = resolveBinaryOperatorCandidate(opId, lhsTypeId, rhsTypeId, "left", ctx.services);

  if (rightCandidate && leftCandidate) {
    ctx.diagnostics.push(
      makeDiag(
        LoweringDiagCode.AmbiguousImplicitBinaryConversion,
        `Ambiguous implicit conversion for ${opId}(${lhsTypeId}, ${rhsTypeId}): ${describeBinaryOperatorCandidate(rightCandidate)} or ${describeBinaryOperatorCandidate(leftCandidate)}`,
        diagNode
      )
    );
    return false;
  }

  const resolved = rightCandidate ?? leftCandidate;
  if (!resolved) {
    ctx.diagnostics.push(
      makeDiag(
        LoweringDiagCode.NoOperatorOverload,
        `No operator overload for ${opId}(${lhsTypeId}, ${rhsTypeId})`,
        diagNode
      )
    );
    return false;
  }

  if (resolved.conversion) {
    emitOperandConversion(resolved.conversion, ctx);
  }

  ctx.ir.push({ kind: "HostCall", fnName: resolved.operatorFnName, argc: 2 });
  return true;
}

/** Lower a validated descriptor's TS source to IR functions, producing a {@link ProgramLoweringResult}. */
export function lowerProgram(
  sourceFile: ts.SourceFile,
  descriptor: ExtractedDescriptor,
  checker: ts.TypeChecker,
  services: BrainServices,
  projectNamespace: string,
  importedFunctions?: ImportedFunction[],
  importedVariables?: ImportedVariable[],
  moduleInitOrder?: string[],
  importedClasses?: ImportedClass[],
  importedEnums?: ImportedEnum[],
  importedInterfaces?: ImportedInterface[],
  importedTypeAliases?: ImportedTypeAlias[],
  inlinedSystemConsts?: InlinedSystemConst[],
  carriedPrivateFunctions?: CarriedPrivateFunction[],
  importedStructTypeDecls?: ImportedStructTypeDecl[]
): ProgramLoweringResult {
  const diagnostics: CompileDiagnostic[] = [];
  const callsiteVars = new Map<string, number>();
  const functionTable = new Map<string, number>();
  // Module-level function-table contributors (helpers and classes) in func-id
  // reservation order. Body lowering walks this list in the same order, so each
  // lowered entry's index in the function array equals its reserved func id.
  const moduleFunctionDecls: ({ kind: "helper"; node: ts.FunctionDeclaration } | { kind: "class"; info: ClassInfo })[] =
    [];
  const classInfos: ClassInfo[] = [];
  const interfaceInfos: InterfaceInfo[] = [];
  const typeAliasInfos: TypeAliasInfo[] = [];
  const localEnumNodes: ts.EnumDeclaration[] = [];
  const funcIdCounter = { value: 0 };
  const closureFunctions = new Map<number, FunctionEntry>();

  // Module-level variables (outside the descriptor's default export) are stored
  // as "callsite variables" -- a separate namespace from function-local variables.
  // Callsite vars are distinct per user tile instance, persist across invocations.
  let nextCallsiteVar = 0;

  // Defining-module `const` bindings an imported System body references, keyed by
  // declaration symbol; re-lowered inline wherever the System body or a helper it
  // calls references them.
  const inlineConsts = new Map<ts.Symbol, ts.Expression>();
  for (const ic of inlinedSystemConsts ?? []) {
    inlineConsts.set(ic.symbol, ic.initializer);
  }

  // Carried non-exported functions, keyed by declaration symbol -> function-table
  // identity key, so a call inside a re-lowered body resolves to the right helper
  // even when two modules define same-named private helpers. Populated below.
  const carriedFunctionKeys = new Map<ts.Symbol, string>();

  // `const X = System({...})` bindings: a brain-global store separate from
  // callsite vars. Collected here (local and imported), then registered below.
  const systemBindings = new Map<ts.Symbol, SystemBinding>();
  const systemDecls: { symbol: ts.Symbol; declName: string; config: ts.ObjectLiteralExpression }[] = [];
  let nextSystemSlot = 0;
  const collectSystemDecl = (nameNode: ts.Identifier, initializer: ts.Expression | undefined): boolean => {
    const config = systemConfigObject(initializer);
    if (!config) return false;
    const symbol = checker.getSymbolAtLocation(nameNode);
    if (!symbol) {
      diagnostics.push(
        makeDiag(
          LoweringDiagCode.SystemBindingUnresolvable,
          `Cannot resolve the declaration of System '${nameNode.text}'.`,
          nameNode
        )
      );
      return true;
    }
    if (!systemBindings.has(symbol) && !systemDecls.some((d) => d.symbol === symbol)) {
      systemDecls.push({ symbol, declName: nameNode.text, config });
    }
    return true;
  };

  // `const X = StructType({...})` bindings: gathered here across the entry
  // module and every imported module, then resolved and registered as one set
  // (register-if-absent, keyed by `<namespace>:<file>::<binding>` identity). Field
  // resolution never depends on declaration or import-visit order.
  const structTypes: ArtifactStructTypeInfo[] = [];
  const pendingStructTypeDecls: PendingStructTypeDecl[] = [];
  const collectedStructIdentities = new Set<string>();
  const collectStructTypeDecl = (nameNode: ts.Identifier, initializer: ts.Expression | undefined): boolean => {
    const call = structTypeCallExpression(initializer);
    if (!call) return false;
    const config = structTypeConfigObject(initializer);
    if (!config) {
      diagnostics.push(
        makeDiag(
          LoweringDiagCode.StructTypeConfigNotObjectLiteral,
          `\`StructType\` for '${nameNode.text}' requires a single inline object-literal config.`,
          call
        )
      );
      return true;
    }
    const identity = qualifiedDeclarationName(projectNamespace, config.getSourceFile().fileName, nameNode.text);
    if (collectedStructIdentities.has(identity)) return true;
    collectedStructIdentities.add(identity);
    pendingStructTypeDecls.push({ identity, declName: nameNode.text, config });
    return true;
  };

  const entryFuncId = funcIdCounter.value++;

  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      functionTable.set(stmt.name.text, funcIdCounter.value++);
      moduleFunctionDecls.push({ kind: "helper", node: stmt });
    } else if (ts.isEnumDeclaration(stmt)) {
      localEnumNodes.push(stmt);
    } else if (ts.isClassDeclaration(stmt) && stmt.name) {
      const className = stmt.name.text;
      const constructorFuncId = funcIdCounter.value++;
      functionTable.set(`${className}$new`, constructorFuncId);
      const methodFuncIds = new Map<string, number>();
      for (const member of stmt.members) {
        if (ts.isMethodDeclaration(member) && ts.isIdentifier(member.name) && !hasStaticModifier(member)) {
          const methodName = member.name.text;
          const methodFuncId = funcIdCounter.value++;
          functionTable.set(`${className}.${methodName}`, methodFuncId);
          methodFuncIds.set(methodName, methodFuncId);
        }
      }
      const staticFieldSlots = new Map<string, number>();
      for (const member of stmt.members) {
        if (ts.isPropertyDeclaration(member) && hasStaticModifier(member) && ts.isIdentifier(member.name)) {
          const qualifiedName = `${className}.${member.name.text}`;
          callsiteVars.set(qualifiedName, nextCallsiteVar);
          staticFieldSlots.set(member.name.text, nextCallsiteVar++);
        }
      }
      const staticMethodFuncIds = new Map<string, number>();
      for (const member of stmt.members) {
        if (ts.isMethodDeclaration(member) && ts.isIdentifier(member.name) && hasStaticModifier(member)) {
          const methodName = member.name.text;
          const methodFuncId = funcIdCounter.value++;
          functionTable.set(`${className}$${methodName}`, methodFuncId);
          staticMethodFuncIds.set(methodName, methodFuncId);
        }
      }
      const getterFuncIds = new Map<string, number>();
      const setterFuncIds = new Map<string, number>();
      const staticGetterFuncIds = new Map<string, number>();
      const staticSetterFuncIds = new Map<string, number>();
      for (const member of stmt.members) {
        if (ts.isGetAccessorDeclaration(member) && ts.isIdentifier(member.name)) {
          const propName = member.name.text;
          const funcId = funcIdCounter.value++;
          if (hasStaticModifier(member)) {
            functionTable.set(`${className}$get_${propName}`, funcId);
            staticGetterFuncIds.set(propName, funcId);
          } else {
            functionTable.set(`${className}$get_${propName}`, funcId);
            getterFuncIds.set(propName, funcId);
          }
        } else if (ts.isSetAccessorDeclaration(member) && ts.isIdentifier(member.name)) {
          const propName = member.name.text;
          const funcId = funcIdCounter.value++;
          if (hasStaticModifier(member)) {
            functionTable.set(`${className}$set_${propName}`, funcId);
            staticSetterFuncIds.set(propName, funcId);
          } else {
            functionTable.set(`${className}$set_${propName}`, funcId);
            setterFuncIds.set(propName, funcId);
          }
        }
      }
      const info: ClassInfo = {
        node: stmt,
        name: className,
        sourceFile,
        constructorFuncId,
        methodFuncIds,
        staticFieldSlots,
        staticMethodFuncIds,
        getterFuncIds,
        setterFuncIds,
        staticGetterFuncIds,
        staticSetterFuncIds,
      };
      classInfos.push(info);
      moduleFunctionDecls.push({ kind: "class", info });
    } else if (ts.isInterfaceDeclaration(stmt) && stmt.name) {
      interfaceInfos.push({ node: stmt, name: stmt.name.text, sourceFile });
    } else if (ts.isTypeAliasDeclaration(stmt) && stmt.name) {
      typeAliasInfos.push({ node: stmt, name: stmt.name.text, sourceFile });
    } else if (ts.isVariableStatement(stmt) && !isInsideDescriptor(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          if (collectSystemDecl(decl.name, decl.initializer)) continue;
          if (collectStructTypeDecl(decl.name, decl.initializer)) continue;
          callsiteVars.set(decl.name.text, nextCallsiteVar++);
        }
      }
    }
  }

  if (importedVariables) {
    for (const iv of importedVariables) {
      const declNode = iv.initializer?.parent;
      const importedDeclName =
        iv.initializer && declNode && ts.isVariableDeclaration(declNode) && ts.isIdentifier(declNode.name)
          ? declNode.name
          : undefined;
      if (importedDeclName && collectSystemDecl(importedDeclName, iv.initializer)) {
        continue;
      }
      if (importedDeclName && collectStructTypeDecl(importedDeclName, iv.initializer)) {
        continue;
      }
      if (!callsiteVars.has(iv.name)) {
        callsiteVars.set(iv.name, nextCallsiteVar++);
      }
    }
  }

  if (importedStructTypeDecls) {
    for (const decl of importedStructTypeDecls) {
      collectStructTypeDecl(decl.nameNode, decl.initializer);
    }
  }

  structTypes.push(
    ...registerCollectedStructTypes(pendingStructTypeDecls, checker, services, projectNamespace, diagnostics)
  );

  if (importedFunctions) {
    for (const imp of importedFunctions) {
      const declaredName = imp.node.name?.text;
      if (!declaredName) continue;
      if (!functionTable.has(declaredName)) {
        functionTable.set(declaredName, funcIdCounter.value++);
        moduleFunctionDecls.push({ kind: "helper", node: imp.node });
      }
      if (imp.localName !== declaredName && !functionTable.has(imp.localName)) {
        functionTable.set(imp.localName, functionTable.get(declaredName)!);
      }
    }
  }

  if (carriedPrivateFunctions) {
    for (const cpf of carriedPrivateFunctions) {
      const name = cpf.node.name?.text;
      if (!name) continue;
      const key = carriedFunctionKey(cpf.node.getSourceFile().fileName, name);
      if (!functionTable.has(key)) {
        functionTable.set(key, funcIdCounter.value++);
        moduleFunctionDecls.push({ kind: "helper", node: cpf.node });
      }
      carriedFunctionKeys.set(cpf.symbol, key);
    }
  }

  if (importedClasses) {
    for (const ic of importedClasses) {
      const className = ic.name;
      if (functionTable.has(`${className}$new`)) continue;

      const constructorFuncId = funcIdCounter.value++;
      functionTable.set(`${className}$new`, constructorFuncId);
      const methodFuncIds = new Map<string, number>();
      for (const member of ic.node.members) {
        if (ts.isMethodDeclaration(member) && ts.isIdentifier(member.name) && !hasStaticModifier(member)) {
          const methodName = member.name.text;
          const methodFuncId = funcIdCounter.value++;
          functionTable.set(`${className}.${methodName}`, methodFuncId);
          methodFuncIds.set(methodName, methodFuncId);
        }
      }
      const staticFieldSlots = new Map<string, number>();
      for (const member of ic.node.members) {
        if (ts.isPropertyDeclaration(member) && hasStaticModifier(member) && ts.isIdentifier(member.name)) {
          const qualifiedName = `${className}.${member.name.text}`;
          callsiteVars.set(qualifiedName, nextCallsiteVar);
          staticFieldSlots.set(member.name.text, nextCallsiteVar++);
        }
      }
      const staticMethodFuncIds = new Map<string, number>();
      for (const member of ic.node.members) {
        if (ts.isMethodDeclaration(member) && ts.isIdentifier(member.name) && hasStaticModifier(member)) {
          const methodName = member.name.text;
          const methodFuncId = funcIdCounter.value++;
          functionTable.set(`${className}$${methodName}`, methodFuncId);
          staticMethodFuncIds.set(methodName, methodFuncId);
        }
      }
      const getterFuncIds = new Map<string, number>();
      const setterFuncIds = new Map<string, number>();
      const staticGetterFuncIds = new Map<string, number>();
      const staticSetterFuncIds = new Map<string, number>();
      for (const member of ic.node.members) {
        if (ts.isGetAccessorDeclaration(member) && ts.isIdentifier(member.name)) {
          const propName = member.name.text;
          const funcId = funcIdCounter.value++;
          if (hasStaticModifier(member)) {
            functionTable.set(`${className}$get_${propName}`, funcId);
            staticGetterFuncIds.set(propName, funcId);
          } else {
            functionTable.set(`${className}$get_${propName}`, funcId);
            getterFuncIds.set(propName, funcId);
          }
        } else if (ts.isSetAccessorDeclaration(member) && ts.isIdentifier(member.name)) {
          const propName = member.name.text;
          const funcId = funcIdCounter.value++;
          if (hasStaticModifier(member)) {
            functionTable.set(`${className}$set_${propName}`, funcId);
            staticSetterFuncIds.set(propName, funcId);
          } else {
            functionTable.set(`${className}$set_${propName}`, funcId);
            setterFuncIds.set(propName, funcId);
          }
        }
      }
      const info: ClassInfo = {
        node: ic.node,
        name: className,
        sourceFile: ic.sourceFile,
        constructorFuncId,
        methodFuncIds,
        staticFieldSlots,
        staticMethodFuncIds,
        getterFuncIds,
        setterFuncIds,
        staticGetterFuncIds,
        staticSetterFuncIds,
      };
      classInfos.push(info);
      moduleFunctionDecls.push({ kind: "class", info });
    }
  }

  if (importedInterfaces) {
    for (const ii of importedInterfaces) {
      if (!interfaceInfos.some((existing) => existing.name === ii.name)) {
        interfaceInfos.push({ node: ii.node, name: ii.name, sourceFile: ii.sourceFile });
      }
    }
  }

  if (importedTypeAliases) {
    for (const ita of importedTypeAliases) {
      if (!typeAliasInfos.some((existing) => existing.name === ita.name)) {
        typeAliasInfos.push({ node: ita.node, name: ita.name, sourceFile: ita.sourceFile });
      }
    }
  }

  let userOnPageEnteredFuncId: number | undefined;
  if (descriptor.onPageEnteredNode) {
    userOnPageEnteredFuncId = funcIdCounter.value++;
  }

  const hasInitializers = hasTopLevelInitializers(sourceFile);
  const hasImportedInitializers = importedVariables?.some((iv) => iv.initializer) ?? false;
  const hasStaticFields = classInfos.some((ci) => ci.staticFieldSlots.size > 0);
  let initializerFuncId: number | undefined;
  if (hasInitializers || hasImportedInitializers || hasStaticFields) {
    initializerFuncId = funcIdCounter.value++;
  }

  let activationFuncId: number | undefined;
  if (userOnPageEnteredFuncId !== undefined) {
    activationFuncId = funcIdCounter.value++;
  }

  let deactivationFuncId: number | undefined;
  if (descriptor.onPageExitedNode) {
    deactivationFuncId = funcIdCounter.value++;
  }

  const functions: FunctionEntry[] = [];

  registerUserEnumTypes(localEnumNodes, importedEnums ?? [], checker, diagnostics, services, projectNamespace);

  // Reserve all user-declared named types before finalizing any: a field
  // naming another user class, interface, or type alias resolves to its
  // qualified reservation regardless of declaration or import-visit order.
  const reservedClasses: { info: ClassInfo; typeId: string }[] = [];
  for (const ci of classInfos) {
    const typeId = reserveClassStructType(ci, services, projectNamespace);
    if (typeId) reservedClasses.push({ info: ci, typeId });
  }

  const reservedInterfaces: { info: InterfaceInfo; typeId: string }[] = [];
  for (const ii of interfaceInfos) {
    const typeId = reserveInterfaceStructType(ii, checker, diagnostics, services, projectNamespace);
    if (typeId) reservedInterfaces.push({ info: ii, typeId });
  }

  const reservedTypeAliases: { info: TypeAliasInfo; typeId: string }[] = [];
  for (const tai of typeAliasInfos) {
    const typeId = reserveTypeAliasStructType(tai, checker, diagnostics, services, projectNamespace);
    if (typeId) reservedTypeAliases.push({ info: tai, typeId });
  }

  for (const { info, typeId } of reservedClasses) {
    finalizeClassStructType(info, typeId, checker, diagnostics, services, projectNamespace);
  }

  for (const { info, typeId } of reservedInterfaces) {
    finalizeInterfaceStructType(info, typeId, checker, diagnostics, services, projectNamespace);
  }

  for (const { info, typeId } of reservedTypeAliases) {
    finalizeTypeAliasStructType(info, typeId, checker, diagnostics, services, projectNamespace);
  }

  // Register each System's state struct type and reserve its func ids (methods,
  // user init/think bodies, and the generated wrappers) before any body is
  // lowered, so references resolve and func ids stay contiguous. State field
  // types resolve against the completed registry: every user-declared named
  // type (StructType, enum, class, interface, type alias) registers above.
  // Reservation order here must match the push order in the System
  // body-lowering pass below.
  const orderedSystemBindings: SystemBinding[] = [];
  for (const decl of systemDecls) {
    const parts = extractSystemConfig(decl.config, diagnostics);
    if (!parts) continue;
    const stateDef = autoRegisterAnonymousStruct(
      checker.getTypeAtLocation(parts.stateNode),
      checker,
      services,
      projectNamespace
    );
    if (!stateDef) {
      diagnostics.push(
        makeDiag(
          LoweringDiagCode.SystemStateUnresolvable,
          "`System` `state` must be a non-empty object of VM-representable fields (numbers, strings, booleans, enums, or struct values such as class, interface, type alias, or StructType instances).",
          parts.stateNode
        )
      );
      continue;
    }
    const localSlot = nextSystemSlot++;
    const methodFuncIds = new Map<string, number>();
    parts.methodNodes.forEach((_node, methodName) => {
      methodFuncIds.set(methodName, funcIdCounter.value++);
    });
    const userInitFuncId = parts.initNode ? funcIdCounter.value++ : undefined;
    const userThinkFuncId = parts.thinkNode ? funcIdCounter.value++ : undefined;
    const initWrapperFuncId = funcIdCounter.value++;
    const thinkWrapperFuncId = parts.thinkNode ? funcIdCounter.value++ : undefined;
    const binding: SystemBinding = {
      identity: qualifiedDeclarationName(projectNamespace, decl.config.getSourceFile().fileName, decl.declName),
      name: parts.name,
      localSlot,
      stateTypeId: stateDef.typeId,
      stateNode: parts.stateNode,
      initWrapperFuncId,
      thinkWrapperFuncId,
      userInitFuncId,
      initNode: parts.initNode,
      userThinkFuncId,
      thinkNode: parts.thinkNode,
      methodFuncIds,
      methodNodes: parts.methodNodes,
    };
    systemBindings.set(decl.symbol, binding);
    orderedSystemBindings.push(binding);
  }

  // Co-located Systems (defined in this module) reference module-level `const`s
  // whose per-callsite backing store is not bound in the System fiber; add them
  // to the inline map.
  const coLocatedSystemConfigs = systemDecls
    .filter((decl) => decl.config.getSourceFile() === sourceFile)
    .map((decl) => decl.config);
  for (const ic of collectCoLocatedSystemConsts(coLocatedSystemConfigs, sourceFile, checker, diagnostics)) {
    inlineConsts.set(ic.symbol, ic.initializer);
  }

  const onExecEntry = lowerOnExecuteBody(
    descriptor,
    checker,
    callsiteVars,
    functionTable,
    diagnostics,
    funcIdCounter,
    closureFunctions,
    services,
    projectNamespace,
    classInfos,
    systemBindings
  );
  functions.push(onExecEntry);

  for (const decl of moduleFunctionDecls) {
    if (decl.kind === "helper") {
      functions.push(
        lowerHelperFunction(
          decl.node,
          checker,
          callsiteVars,
          functionTable,
          diagnostics,
          funcIdCounter,
          closureFunctions,
          services,
          projectNamespace,
          classInfos,
          systemBindings,
          inlineConsts,
          carriedFunctionKeys
        )
      );
    } else {
      functions.push(
        ...lowerClassDeclaration(
          decl.info,
          checker,
          callsiteVars,
          functionTable,
          diagnostics,
          funcIdCounter,
          closureFunctions,
          services,
          projectNamespace,
          classInfos
        )
      );
    }
  }

  if (descriptor.onPageEnteredNode) {
    const entry = lowerOnPageEnteredBody(
      descriptor,
      checker,
      callsiteVars,
      functionTable,
      diagnostics,
      funcIdCounter,
      closureFunctions,
      services,
      projectNamespace,
      classInfos,
      systemBindings
    );
    functions.push(entry);
  }

  if (initializerFuncId !== undefined) {
    const initEntry = generateModuleInitWithImports(
      sourceFile,
      checker,
      callsiteVars,
      functionTable,
      diagnostics,
      funcIdCounter,
      closureFunctions,
      importedVariables ?? [],
      moduleInitOrder ?? [],
      classInfos,
      services,
      projectNamespace,
      systemBindings
    );
    functions.push(initEntry);
  }

  if (activationFuncId !== undefined) {
    const activationEntry = generateActivationFunction(descriptor.name, userOnPageEnteredFuncId);
    functions.push(activationEntry);
  }

  if (deactivationFuncId !== undefined) {
    const exitEntry = lowerOnPageExitedBody(
      descriptor,
      checker,
      callsiteVars,
      functionTable,
      diagnostics,
      funcIdCounter,
      closureFunctions,
      services,
      projectNamespace,
      classInfos,
      systemBindings
    );
    functions.push(exitEntry);
  }

  // System bodies and generated wrappers. Pushed after the page hooks and
  // before closures so each entry's array index equals its reserved func id.
  const systems: LoweredSystem[] = [];
  for (const binding of orderedSystemBindings) {
    binding.methodNodes.forEach((node, methodName) => {
      functions.push(
        lowerSystemFnEntry(
          node,
          `${binding.name}.${methodName}`,
          checker,
          callsiteVars,
          functionTable,
          diagnostics,
          funcIdCounter,
          closureFunctions,
          services,
          projectNamespace,
          classInfos,
          systemBindings,
          binding.stateTypeId,
          binding.methodFuncIds,
          inlineConsts,
          carriedFunctionKeys
        )
      );
    });
    if (binding.initNode) {
      functions.push(
        lowerSystemFnEntry(
          binding.initNode,
          `${binding.name}.init`,
          checker,
          callsiteVars,
          functionTable,
          diagnostics,
          funcIdCounter,
          closureFunctions,
          services,
          projectNamespace,
          classInfos,
          systemBindings,
          binding.stateTypeId,
          binding.methodFuncIds,
          inlineConsts,
          carriedFunctionKeys
        )
      );
    }
    if (binding.thinkNode) {
      functions.push(
        lowerSystemFnEntry(
          binding.thinkNode,
          `${binding.name}.think`,
          checker,
          callsiteVars,
          functionTable,
          diagnostics,
          funcIdCounter,
          closureFunctions,
          services,
          projectNamespace,
          classInfos,
          systemBindings,
          binding.stateTypeId,
          binding.methodFuncIds,
          inlineConsts,
          carriedFunctionKeys
        )
      );
    }
    functions.push(
      generateSystemInitWrapper(
        binding,
        checker,
        callsiteVars,
        functionTable,
        diagnostics,
        funcIdCounter,
        closureFunctions,
        services,
        projectNamespace,
        classInfos,
        systemBindings,
        inlineConsts,
        carriedFunctionKeys
      )
    );
    if (binding.thinkNode && binding.thinkWrapperFuncId !== undefined && binding.userThinkFuncId !== undefined) {
      functions.push(
        generateSystemThinkWrapper(
          binding.name,
          binding.localSlot,
          binding.userThinkFuncId,
          binding.thinkNode.parameters.length > 0
        )
      );
    }
    systems.push({
      identity: binding.identity,
      name: binding.name,
      localSlot: binding.localSlot,
      initFuncId: binding.initWrapperFuncId,
      thinkFuncId: binding.thinkWrapperFuncId,
    });
  }

  const closureEntries = Array.from(closureFunctions.entries())
    .sort(([a], [b]) => a - b)
    .map(([, entry]) => entry);
  functions.push(...closureEntries);

  return {
    functions,
    entryFuncId,
    initializerFuncId,
    activationFuncId,
    deactivationFuncId,
    numStateSlots: nextCallsiteVar,
    functionTable,
    diagnostics,
    systems,
    structTypes,
  };
}

function lowerOnPageEnteredBody(
  descriptor: ExtractedDescriptor,
  checker: ts.TypeChecker,
  callsiteVars: Map<string, number>,
  functionTable: Map<string, number>,
  sharedDiagnostics: CompileDiagnostic[],
  funcIdCounter: { value: number },
  closureFunctions: Map<number, FunctionEntry>,
  services: BrainServices,
  projectNamespace: string,
  classInfos: ClassInfo[],
  systemBindings: Map<ts.Symbol, SystemBinding>
): FunctionEntry {
  const ir: IrNode[] = [];
  const funcNode = descriptor.onPageEnteredNode!;

  const paramLocals = new Map<string, number>();
  const ctxParam = funcNode.parameters[0];
  if (ctxParam && ts.isIdentifier(ctxParam.name)) {
    paramLocals.set(ctxParam.name.text, 0);
  }

  const scopeStack = new ScopeStack(1);
  const funcScopeId = scopeStack.initFunctionScope(0, `${descriptor.name}.onPageEntered`);

  if (ctxParam && ts.isIdentifier(ctxParam.name)) {
    scopeStack.addParameterMetadata(ctxParam.name.text, 0, funcScopeId);
  }

  const ctx: LowerContext = {
    services,
    projectNamespace,
    checker,
    paramsSymbol: undefined,
    paramLocals,
    scopeStack,
    ir,
    diagnostics: sharedDiagnostics,
    loopStack: [],
    breakStack: [],
    nextLabelId: 0,
    callsiteVars,
    functionTable,
    funcIdCounter,
    closureFunctions,
    currentFunctionName: `${descriptor.name}.onPageEntered`,
    currentReturnTypeId: resolveSignatureReturnTypeId(funcNode, checker, services, projectNamespace),
    classInfos,
    systemBindings,
    nonSuspendableContext: "`onPageEntered` (page handlers cannot suspend)",
  };

  const body = funcNode.body;
  if (!body || !ts.isBlock(body)) {
    sharedDiagnostics.push({
      code: LoweringDiagCode.OnPageEnteredHasNoBody,
      message: "onPageEntered function has no body",
      severity: "error",
    });
    scopeStack.finalizeFunctionScope(ir.length);
    return {
      ir,
      numParams: 1,
      numLocals: scopeStack.nextLocal,
      name: `${descriptor.name}.onPageEntered`,
      scopeMetadata: [...scopeStack.scopeMetadata],
      localMetadata: [...scopeStack.localMetadata],
      isGenerated: false,
      sourceFileName: funcNode.getSourceFile()?.fileName,
      functionSpan: spanFromNode(funcNode),
    };
  }

  lowerStatements(body.statements, ctx);

  ir.push({ kind: "PushConst", value: NIL_VALUE });
  ir.push({ kind: "Return" });

  scopeStack.finalizeFunctionScope(ir.length);
  return {
    ir,
    numParams: 1,
    numLocals: scopeStack.nextLocal,
    name: `${descriptor.name}.onPageEntered`,
    scopeMetadata: [...scopeStack.scopeMetadata],
    localMetadata: [...scopeStack.localMetadata],
    isGenerated: false,
    sourceFileName: funcNode.getSourceFile()?.fileName,
    functionSpan: spanFromNode(funcNode),
  };
}

function lowerOnPageExitedBody(
  descriptor: ExtractedDescriptor,
  checker: ts.TypeChecker,
  callsiteVars: Map<string, number>,
  functionTable: Map<string, number>,
  sharedDiagnostics: CompileDiagnostic[],
  funcIdCounter: { value: number },
  closureFunctions: Map<number, FunctionEntry>,
  services: BrainServices,
  projectNamespace: string,
  classInfos: ClassInfo[],
  systemBindings: Map<ts.Symbol, SystemBinding>
): FunctionEntry {
  const ir: IrNode[] = [];
  const funcNode = descriptor.onPageExitedNode!;

  const paramLocals = new Map<string, number>();
  const ctxParam = funcNode.parameters[0];
  if (ctxParam && ts.isIdentifier(ctxParam.name)) {
    paramLocals.set(ctxParam.name.text, 0);
  }

  const scopeStack = new ScopeStack(1);
  const funcScopeId = scopeStack.initFunctionScope(0, `${descriptor.name}.onPageExited`);

  if (ctxParam && ts.isIdentifier(ctxParam.name)) {
    scopeStack.addParameterMetadata(ctxParam.name.text, 0, funcScopeId);
  }

  const ctx: LowerContext = {
    services,
    projectNamespace,
    checker,
    paramsSymbol: undefined,
    paramLocals,
    scopeStack,
    ir,
    diagnostics: sharedDiagnostics,
    loopStack: [],
    breakStack: [],
    nextLabelId: 0,
    callsiteVars,
    functionTable,
    funcIdCounter,
    closureFunctions,
    currentFunctionName: `${descriptor.name}.onPageExited`,
    currentReturnTypeId: resolveSignatureReturnTypeId(funcNode, checker, services, projectNamespace),
    classInfos,
    systemBindings,
    nonSuspendableContext: "`onPageExited` (page handlers cannot suspend)",
  };

  const body = funcNode.body;
  if (!body || !ts.isBlock(body)) {
    sharedDiagnostics.push({
      code: LoweringDiagCode.OnPageExitedHasNoBody,
      message: "onPageExited function has no body",
      severity: "error",
    });
    scopeStack.finalizeFunctionScope(ir.length);
    return {
      ir,
      numParams: 1,
      numLocals: scopeStack.nextLocal,
      name: `${descriptor.name}.onPageExited`,
      injectCtxTypeId: ContextTypeIds.Context,
      scopeMetadata: [...scopeStack.scopeMetadata],
      localMetadata: [...scopeStack.localMetadata],
      isGenerated: false,
      sourceFileName: funcNode.getSourceFile()?.fileName,
      functionSpan: spanFromNode(funcNode),
    };
  }

  lowerStatements(body.statements, ctx);

  ir.push({ kind: "PushConst", value: NIL_VALUE });
  ir.push({ kind: "Return" });

  scopeStack.finalizeFunctionScope(ir.length);
  return {
    ir,
    numParams: 1,
    numLocals: scopeStack.nextLocal,
    name: `${descriptor.name}.onPageExited`,
    injectCtxTypeId: ContextTypeIds.Context,
    scopeMetadata: [...scopeStack.scopeMetadata],
    localMetadata: [...scopeStack.localMetadata],
    isGenerated: false,
    sourceFileName: funcNode.getSourceFile()?.fileName,
    functionSpan: spanFromNode(funcNode),
  };
}

function generateActivationFunction(name: string, userOnPageEnteredFuncId: number | undefined): FunctionEntry {
  const ir: IrNode[] = [];

  if (userOnPageEnteredFuncId !== undefined) {
    ir.push({ kind: "LoadLocal", index: 0 });
    ir.push({ kind: "Call", funcIndex: userOnPageEnteredFuncId, argc: 1 });
    ir.push({ kind: "Pop" });
  }

  ir.push({ kind: "PushConst", value: NIL_VALUE });
  ir.push({ kind: "Return" });

  return {
    ir,
    numParams: 1,
    numLocals: 1,
    name: `${name}.<activation>`,
    injectCtxTypeId: ContextTypeIds.Context,
    isGenerated: true,
  };
}

/** Returns the `System({...})` config object literal when `expr` is a `System(...)` call, else undefined. */
export function systemConfigObject(expr: ts.Expression | undefined): ts.ObjectLiteralExpression | undefined {
  if (!expr || !ts.isCallExpression(expr)) return undefined;
  if (!ts.isIdentifier(expr.expression) || expr.expression.text !== "System") return undefined;
  const arg = expr.arguments[0];
  return arg && ts.isObjectLiteralExpression(arg) ? arg : undefined;
}

function propertyNameText(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return undefined;
}

/** A System's config members split into state, lifecycle, and methods. */
interface SystemConfigParts {
  name: string;
  stateNode: ts.Expression;
  initNode?: SystemFnNode;
  thinkNode?: SystemFnNode;
  methodNodes: Map<string, SystemFnNode>;
}

/** Pull a function-like config member out of a method shorthand or a property whose value is a function/arrow. */
function systemMemberFn(member: ts.ObjectLiteralElementLike): SystemFnNode | undefined {
  if (ts.isMethodDeclaration(member)) return member;
  if (ts.isPropertyAssignment(member)) {
    const init = member.initializer;
    if (ts.isFunctionExpression(init) || ts.isArrowFunction(init)) return init;
  }
  return undefined;
}

/**
 * Parse a `System({...})` config object literal into its parts. Every member is
 * validated: a malformed or unrecognized member (spread, computed key, getter,
 * a non-string `name`, a non-object `state`, a non-function `init`/`think`/
 * method) reports a diagnostic. Returns `undefined` when `name` or `state` is
 * missing or invalid (the System cannot be built); otherwise returns the parts,
 * with any individually-invalid `init`/`think`/method omitted.
 */
function extractSystemConfig(
  config: ts.ObjectLiteralExpression,
  diagnostics: CompileDiagnostic[]
): SystemConfigParts | undefined {
  let name: string | undefined;
  let stateNode: ts.Expression | undefined;
  let initNode: SystemFnNode | undefined;
  let thinkNode: SystemFnNode | undefined;
  const methodNodes = new Map<string, SystemFnNode>();
  let sawName = false;
  let sawState = false;

  for (const member of config.properties) {
    if (!member.name) {
      diagnostics.push(
        makeDiag(
          LoweringDiagCode.SystemMemberNotMethod,
          "Spread members are not supported in a `System` config.",
          member
        )
      );
      continue;
    }
    const key = propertyNameText(member.name);
    if (key === undefined) {
      diagnostics.push(
        makeDiag(
          LoweringDiagCode.SystemMemberNotMethod,
          "Computed member names are not supported in a `System` config.",
          member.name
        )
      );
      continue;
    }

    if (key === "name") {
      sawName = true;
      if (ts.isPropertyAssignment(member) && ts.isStringLiteralLike(member.initializer)) {
        name = member.initializer.text;
      } else {
        diagnostics.push(
          makeDiag(
            LoweringDiagCode.SystemNameNotStringLiteral,
            "`System` config `name` must be a string literal.",
            member
          )
        );
      }
      continue;
    }
    if (key === "state") {
      sawState = true;
      if (ts.isPropertyAssignment(member)) {
        stateNode = member.initializer;
      } else {
        diagnostics.push(
          makeDiag(LoweringDiagCode.SystemStateNotObject, "`System` config `state` must be an object.", member)
        );
      }
      continue;
    }
    if (key === "init" || key === "think") {
      const fn = systemMemberFn(member);
      if (fn) {
        if (key === "init") initNode = fn;
        else thinkNode = fn;
      } else {
        diagnostics.push(
          makeDiag(
            LoweringDiagCode.SystemLifecycleNotFunction,
            `\`System\` config \`${key}\` must be a method or inline function.`,
            member
          )
        );
      }
      continue;
    }
    const fn = systemMemberFn(member);
    if (fn) {
      methodNodes.set(key, fn);
    } else {
      diagnostics.push(
        makeDiag(
          LoweringDiagCode.SystemMemberNotMethod,
          `\`System\` member '${key}' must be a method (use a method or inline function).`,
          member
        )
      );
    }
  }

  if (name === undefined) {
    if (!sawName) {
      diagnostics.push(
        makeDiag(LoweringDiagCode.SystemNameNotStringLiteral, "`System` config requires a string `name`.", config)
      );
    }
    return undefined;
  }
  if (stateNode === undefined) {
    if (!sawState) {
      diagnostics.push(
        makeDiag(LoweringDiagCode.SystemStateNotObject, "`System` config requires a `state` object.", config)
      );
    }
    return undefined;
  }
  return { name, stateNode, initNode, thinkNode, methodNodes };
}

/**
 * A `const X = StructType(...)` declaration collected from an imported module
 * (exported or not); the entry compile registers its type so references in
 * re-lowered bodies resolve.
 */
export interface ImportedStructTypeDecl {
  nameNode: ts.Identifier;
  initializer: ts.Expression;
}

/** Validated members of a `StructType({...})` config. Field types are canonical registry names, not yet resolved against the registry. */
interface StructTypeConfigParts {
  name: string;
  accessors: boolean;
  variables: boolean;
  fields: { name: string; typeName: string; typeExpr: ts.Expression }[];
}

/**
 * Extract and validate a `StructType({...})` config: a string `name`, a
 * non-empty `fields` object of `name: type` entries (types normalized to
 * canonical registry names through the type-name expression forms), and
 * optional boolean-literal `accessors` and `variables`. Each malformed member
 * pushes its own diagnostic; returns undefined when any member fails.
 */
export function extractStructTypeConfig(
  config: ts.ObjectLiteralExpression,
  checker: ts.TypeChecker,
  projectNamespace: string,
  diagnostics: CompileDiagnostic[]
): StructTypeConfigParts | undefined {
  let name: string | undefined;
  let accessors = false;
  let variables = false;
  let fieldsNode: ts.ObjectLiteralExpression | undefined;
  let sawFields = false;
  let failed = false;

  const readBooleanMember = (memberName: string, value: ts.Expression): boolean => {
    if (value.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (value.kind === ts.SyntaxKind.FalseKeyword) return false;
    diagnostics.push(
      makeDiag(
        LoweringDiagCode.StructTypeMemberInvalid,
        `\`StructType\` \`${memberName}\` must be a boolean literal.`,
        value
      )
    );
    failed = true;
    return false;
  };

  for (const prop of config.properties) {
    if (ts.isSpreadAssignment(prop)) {
      diagnostics.push(
        makeDiag(
          LoweringDiagCode.StructTypeMemberInvalid,
          "`StructType` config members must be written inline; spread is not supported.",
          prop
        )
      );
      failed = true;
      continue;
    }

    let memberName: string | undefined;
    let value: ts.Expression | undefined;
    if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
      memberName = prop.name.text;
      value = prop.initializer;
    } else if (ts.isShorthandPropertyAssignment(prop)) {
      memberName = prop.name.text;
      if (memberName === "fields") {
        sawFields = true;
      }
      value = shorthandValueExpression(prop, checker);
      if (!value) {
        diagnostics.push(
          makeDiag(
            LoweringDiagCode.StructTypeMemberInvalid,
            `\`StructType\` \`${memberName}\` does not resolve to a declared value.`,
            prop
          )
        );
        failed = true;
        continue;
      }
    } else {
      continue;
    }

    switch (memberName) {
      case "name":
        if (ts.isStringLiteral(value)) {
          name = value.text;
        } else {
          diagnostics.push(
            makeDiag(
              LoweringDiagCode.StructTypeNameNotStringLiteral,
              "`StructType` `name` must be a string literal.",
              value
            )
          );
          failed = true;
        }
        break;
      case "fields":
        sawFields = true;
        if (ts.isObjectLiteralExpression(value)) {
          fieldsNode = value;
        } else {
          diagnostics.push(
            makeDiag(
              LoweringDiagCode.StructTypeMemberInvalid,
              "`StructType` `fields` must be an object literal of `name: type` entries.",
              value
            )
          );
          failed = true;
        }
        break;
      case "accessors":
        accessors = readBooleanMember("accessors", value);
        break;
      case "variables":
        variables = readBooleanMember("variables", value);
        break;
    }
  }

  if (name === undefined && !failed) {
    diagnostics.push(
      makeDiag(LoweringDiagCode.StructTypeNameNotStringLiteral, "`StructType` config requires a string `name`.", config)
    );
    failed = true;
  }
  if (fieldsNode === undefined && !sawFields) {
    diagnostics.push(
      makeDiag(LoweringDiagCode.StructTypeMemberInvalid, "`StructType` config requires a `fields` object.", config)
    );
    failed = true;
  }

  const fields: { name: string; typeName: string; typeExpr: ts.Expression }[] = [];
  if (fieldsNode) {
    for (const prop of fieldsNode.properties) {
      let fieldName: string | undefined;
      let typeExpr: ts.Expression | undefined;
      if (ts.isPropertyAssignment(prop) && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))) {
        fieldName = prop.name.text;
        typeExpr = prop.initializer;
      } else if (ts.isShorthandPropertyAssignment(prop)) {
        fieldName = prop.name.text;
        typeExpr = shorthandValueExpression(prop, checker);
      }
      if (fieldName === undefined) {
        diagnostics.push(
          makeDiag(
            LoweringDiagCode.StructTypeMemberInvalid,
            "Each `StructType` field must be a `name: type` entry.",
            prop
          )
        );
        failed = true;
        continue;
      }
      if (typeExpr === undefined) {
        diagnostics.push(
          makeDiag(
            LoweringDiagCode.StructTypeFieldTypeUnresolvable,
            `\`StructType\` field '${fieldName}' does not resolve to a declared type value.`,
            prop
          )
        );
        failed = true;
        continue;
      }
      if (fields.some((field) => field.name === fieldName)) {
        diagnostics.push(
          makeDiag(
            LoweringDiagCode.StructTypeDuplicateField,
            `\`StructType\` field '${fieldName}' is declared more than once.`,
            prop
          )
        );
        failed = true;
        continue;
      }
      const resolved = resolveTypeNameExpression(typeExpr, checker, projectNamespace);
      if ("error" in resolved) {
        diagnostics.push(
          makeDiag(
            LoweringDiagCode.StructTypeFieldTypeUnresolvable,
            `\`StructType\` field '${fieldName}' type ${resolved.error}.`,
            typeExpr
          )
        );
        failed = true;
        continue;
      }
      fields.push({ name: fieldName, typeName: resolved.name, typeExpr });
    }

    if (fields.length === 0 && !failed) {
      diagnostics.push(
        makeDiag(
          LoweringDiagCode.StructTypeMemberInvalid,
          "`StructType` `fields` must declare at least one field.",
          fieldsNode
        )
      );
      failed = true;
    }
  }

  if (failed || name === undefined) {
    return undefined;
  }
  return { name, accessors, variables, fields };
}

/** A `const X = StructType({...})` declaration gathered during collection, awaiting resolution and registration. */
interface PendingStructTypeDecl {
  /** Cross-module identity: `<declaring-file>::<binding-name>`. */
  identity: string;
  /** The declared binding name, used in diagnostics. */
  declName: string;
  config: ts.ObjectLiteralExpression;
}

/**
 * Resolve and register every gathered `StructType({...})` declaration against
 * the completed set, in dependency order; a struct-typed field resolves no
 * matter where its declaration sits. A field naming a declaration on the
 * current visit path closes a containment cycle and fails with
 * {@link LoweringDiagCode.StructTypeRecursiveField}; a field naming a
 * declaration that failed for its own reasons fails without a second
 * diagnostic. Returns artifact metadata for every registered declaration in
 * collection order.
 */
function registerCollectedStructTypes(
  pending: PendingStructTypeDecl[],
  checker: ts.TypeChecker,
  services: BrainServices,
  projectNamespace: string,
  diagnostics: CompileDiagnostic[]
): ArtifactStructTypeInfo[] {
  const registry = services.runtime.types;
  const extracted = new Map<string, { decl: PendingStructTypeDecl; parts: StructTypeConfigParts }>();
  const failed = new Set<string>();
  for (const decl of pending) {
    const parts = extractStructTypeConfig(decl.config, checker, projectNamespace, diagnostics);
    if (parts) {
      extracted.set(decl.identity, { decl, parts });
    } else {
      failed.add(decl.identity);
    }
  }

  const registered = new Map<string, ArtifactStructTypeInfo>();
  const VISITING = 1;
  const DONE = 2;
  const visitState = new Map<string, number>();
  const visitPath: string[] = [];

  const declNameOf = (identity: string): string => extracted.get(identity)?.decl.declName ?? identity;

  const finalize = (identity: string): void => {
    if (failed.has(identity)) return;
    const entry = extracted.get(identity)!;
    const fields: { name: string; typeId: TypeId }[] = [];
    for (const field of entry.parts.fields) {
      const fieldTypeId = registry.resolveByName(field.typeName);
      if (fieldTypeId === undefined) {
        // A field naming a declaration that already failed carries no second
        // diagnostic; that declaration's own diagnostic names the root cause.
        if (!failed.has(field.typeName)) {
          diagnostics.push(
            makeDiag(
              LoweringDiagCode.StructTypeFieldTypeUnresolvable,
              `\`StructType\` field '${field.name}' names unknown type "${field.typeName}".`,
              field.typeExpr
            )
          );
        }
        failed.add(identity);
        continue;
      }
      fields.push({ name: field.name, typeId: fieldTypeId });
    }
    if (failed.has(identity)) return;
    let typeId = registry.resolveByName(identity);
    if (typeId === undefined) {
      typeId = registry.withOwner("dynamic", () =>
        registry.addStructType(identity, {
          fields: List.from(
            fields.map((field, index) => ({ name: field.name, typeId: field.typeId, fieldIndex: index }))
          ),
        })
      );
    }
    registered.set(identity, {
      identity,
      name: entry.parts.name,
      typeId,
      accessors: entry.parts.accessors,
      variables: entry.parts.variables,
      fields,
    });
  };

  const visit = (identity: string): void => {
    if (visitState.get(identity) === DONE) return;
    visitState.set(identity, VISITING);
    visitPath.push(identity);
    const entry = extracted.get(identity)!;
    for (const field of entry.parts.fields) {
      const dep = extracted.get(field.typeName);
      if (!dep) continue;
      if (visitState.get(field.typeName) === VISITING) {
        const cycle = visitPath.slice(visitPath.indexOf(field.typeName));
        const pathNames = [identity, ...cycle.slice(0, -1), identity].map(declNameOf);
        diagnostics.push(
          makeDiag(
            LoweringDiagCode.StructTypeRecursiveField,
            `\`StructType\` '${declNameOf(identity)}' field '${field.name}' creates a containment cycle: ${pathNames.join(" -> ")}. A struct value cannot contain its own type.`,
            field.typeExpr
          )
        );
        for (const member of cycle) {
          failed.add(member);
        }
        continue;
      }
      visit(field.typeName);
    }
    visitPath.pop();
    visitState.set(identity, DONE);
    finalize(identity);
  };

  for (const decl of pending) {
    if (extracted.has(decl.identity)) {
      visit(decl.identity);
    }
  }

  const infos: ArtifactStructTypeInfo[] = [];
  for (const decl of pending) {
    const info = registered.get(decl.identity);
    if (info) infos.push(info);
  }
  return infos;
}

/** Name-keyed declarations gathered from a set of a project's modules. */
export interface GatheredNamedDeclarations {
  structTypes: ImportedStructTypeDecl[];
  enums: ImportedEnum[];
  classes: ImportedClass[];
  interfaces: ImportedInterface[];
  typeAliases: ImportedTypeAlias[];
  /** `const X = System({...})` config objects; each System's state struct registers. */
  systemConfigs: ts.ObjectLiteralExpression[];
}

/** Registry facts produced by {@link registerGatheredNamedDeclarations}. */
export interface GatheredRegistrationResult {
  /** Each gathered System config's registered state struct type. */
  systemStateTypes: Map<ts.ObjectLiteralExpression, TypeId>;
}

/**
 * Register every gathered name-keyed declaration into the live registry with
 * the sequence a tile compile uses: `StructType` declarations
 * (gather-then-register in dependency order), enums, then reserve-all /
 * finalize-all classes, interfaces, and type aliases, then System state
 * structs. Registration is register-if-absent throughout, so a declaration a
 * tile compile already registered resolves to its existing id.
 */
export function registerGatheredNamedDeclarations(
  gathered: GatheredNamedDeclarations,
  checker: ts.TypeChecker,
  services: BrainServices,
  projectNamespace: string,
  diagnostics: CompileDiagnostic[]
): GatheredRegistrationResult {
  const pending: PendingStructTypeDecl[] = [];
  const seenIdentities = new Set<string>();
  for (const decl of gathered.structTypes) {
    const config = structTypeConfigObject(decl.initializer);
    if (!config) {
      diagnostics.push(
        makeDiag(
          LoweringDiagCode.StructTypeConfigNotObjectLiteral,
          `\`StructType\` for '${decl.nameNode.text}' requires a single inline object-literal config.`,
          decl.initializer
        )
      );
      continue;
    }
    const identity = qualifiedDeclarationName(projectNamespace, config.getSourceFile().fileName, decl.nameNode.text);
    if (seenIdentities.has(identity)) continue;
    seenIdentities.add(identity);
    pending.push({ identity, declName: decl.nameNode.text, config });
  }
  registerCollectedStructTypes(pending, checker, services, projectNamespace, diagnostics);

  registerUserEnumTypes([], gathered.enums, checker, diagnostics, services, projectNamespace);

  const reservedClasses: { info: ImportedClass; typeId: string }[] = [];
  for (const ci of gathered.classes) {
    const typeId = reserveClassStructType(ci, services, projectNamespace);
    if (typeId) reservedClasses.push({ info: ci, typeId });
  }
  const reservedInterfaces: { info: InterfaceInfo; typeId: string }[] = [];
  for (const ii of gathered.interfaces) {
    const typeId = reserveInterfaceStructType(ii, checker, diagnostics, services, projectNamespace);
    if (typeId) reservedInterfaces.push({ info: ii, typeId });
  }
  const reservedTypeAliases: { info: TypeAliasInfo; typeId: string }[] = [];
  for (const tai of gathered.typeAliases) {
    const typeId = reserveTypeAliasStructType(tai, checker, diagnostics, services, projectNamespace);
    if (typeId) reservedTypeAliases.push({ info: tai, typeId });
  }
  for (const { info, typeId } of reservedClasses) {
    finalizeClassStructType(info, typeId, checker, diagnostics, services, projectNamespace);
  }
  for (const { info, typeId } of reservedInterfaces) {
    finalizeInterfaceStructType(info, typeId, checker, diagnostics, services, projectNamespace);
  }
  for (const { info, typeId } of reservedTypeAliases) {
    finalizeTypeAliasStructType(info, typeId, checker, diagnostics, services, projectNamespace);
  }

  const systemStateTypes = new Map<ts.ObjectLiteralExpression, TypeId>();
  for (const config of gathered.systemConfigs) {
    const parts = extractSystemConfig(config, diagnostics);
    if (!parts) continue;
    const stateDef = autoRegisterAnonymousStruct(
      checker.getTypeAtLocation(parts.stateNode),
      checker,
      services,
      projectNamespace
    );
    if (stateDef) {
      systemStateTypes.set(config, stateDef.typeId);
    }
  }
  return { systemStateTypes };
}

/** True when `node` carries an `export` modifier. */
function hasExportModifierNode(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  const mods = ts.getModifiers(node);
  return mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

/** True when `id` sits inside a type node (a type-position reference). */
function isInTypeContext(id: ts.Identifier): boolean {
  let n: ts.Node | undefined = id.parent;
  while (n) {
    if (ts.isTypeNode(n)) return true;
    if (ts.isSourceFile(n) || ts.isBlock(n) || ts.isStatement(n)) return false;
    n = n.parent;
  }
  return false;
}

/** True when `id` is a value-reference position (not a declaration name, member name, or property key). */
function isValueReferenceIdentifier(id: ts.Identifier): boolean {
  const parent = id.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === id) return false;
  if (ts.isQualifiedName(parent) && parent.right === id) return false;
  if (ts.isPropertyAssignment(parent) && parent.name === id) return false;
  if (
    (ts.isMethodDeclaration(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent)) &&
    parent.name === id
  ) {
    return false;
  }
  if (ts.isParameter(parent) && parent.name === id) return false;
  if (ts.isBindingElement(parent) && (parent.name === id || parent.propertyName === id)) return false;
  if (ts.isVariableDeclaration(parent) && parent.name === id) return false;
  if (ts.isFunctionDeclaration(parent) && parent.name === id) return false;
  if (isInTypeContext(id)) return false;
  return true;
}

/**
 * True when `decl`'s initializer has a primitive value type (number, string,
 * boolean, or an enum member). A primitive-valued `const` can be re-lowered
 * inline at each reference; a `const` holding a struct, array, or object cannot
 * (each site would build a distinct instance).
 */
function isPrimitiveValuedConst(decl: ts.VariableDeclaration, checker: ts.TypeChecker): boolean {
  if (!decl.initializer) return false;
  const flags = checker.getTypeAtLocation(decl.initializer).flags;
  const primitive =
    ts.TypeFlags.NumberLike | ts.TypeFlags.StringLike | ts.TypeFlags.BooleanLike | ts.TypeFlags.EnumLike;
  return (flags & primitive) !== 0;
}

/**
 * Classify a value-reference `id` against its defining `moduleFile`. When `id`
 * resolves to a top-level `function` declaration, `onFunction` is invoked (the
 * caller carries a non-exported one and traverses an exported one); when it
 * resolves to a primitive-valued `const`, `onConst` is invoked. A reference to
 * a `StructType({...})` binding is left alone: it resolves through the
 * registered struct type in any fiber. A class or enum declared in `localFile`
 * (the module whose compile lowers the System body) is left alone: it resolves
 * through that compile's own class and enum registration. When `diagnostics` is
 * provided, a reference to a top-level binding that cannot be used from a
 * System fiber -- a module-level `let`/`var`, a co-located System, a
 * non-primitive `const`, or a non-exported class/enum in another module --
 * pushes a {@link LoweringDiagCode.SystemModuleReferenceNotCarryable}
 * diagnostic; passing `undefined` leaves those references alone (they resolve
 * normally in an ordinary fiber). Any reference resolving outside `moduleFile`,
 * to a nested local, or to a member is left alone.
 */
function classifySystemModuleReference(
  id: ts.Identifier,
  checker: ts.TypeChecker,
  diagnostics: CompileDiagnostic[] | undefined,
  localFile: ts.SourceFile | undefined,
  onFunction: (decl: ts.FunctionDeclaration, symbol: ts.Symbol) => void,
  onConst: (decl: ts.VariableDeclaration, symbol: ts.Symbol) => void
): void {
  const symbol = resolveAliasedSymbol(checker.getSymbolAtLocation(id), checker);
  if (!symbol) return;
  const decls = symbol.getDeclarations();
  if (!decls || decls.length === 0) return;
  for (const decl of decls) {
    // Ambient (.d.ts) bindings are host-provided and resolve through their own
    // machinery; only user-module top-level bindings are inlined / carried.
    if (!isUserSourceDecl(decl)) continue;
    const declFile = decl.getSourceFile();

    if (ts.isFunctionDeclaration(decl) && decl.parent === declFile) {
      onFunction(decl, symbol);
      return;
    }

    if (ts.isVariableDeclaration(decl)) {
      const list = decl.parent;
      if (
        ts.isVariableDeclarationList(list) &&
        ts.isVariableStatement(list.parent) &&
        list.parent.parent === declFile
      ) {
        const isConst = (list.flags & ts.NodeFlags.Const) !== 0;
        if (isConst && structTypeCallExpression(decl.initializer)) {
          return;
        }
        if (isConst && !systemConfigObject(decl.initializer)) {
          if (isPrimitiveValuedConst(decl, checker)) {
            onConst(decl, symbol);
          } else {
            diagnostics?.push(
              makeDiag(
                LoweringDiagCode.SystemModuleReferenceNotCarryable,
                `A System body references '${id.text}', a module-level \`const\` holding a non-primitive value (a struct, array, or object); reference it through a \`function\` or store it in System state.`,
                id
              )
            );
          }
          return;
        }
        const kind = !isConst ? "a mutable ('let'/'var') binding" : "a co-located System";
        diagnostics?.push(
          makeDiag(
            LoweringDiagCode.SystemModuleReferenceNotCarryable,
            `A System body references '${id.text}', ${kind} in its defining module; only module-level \`const\` values and \`function\` declarations can be used from a System body.`,
            id
          )
        );
        return;
      }
      return;
    }

    if (decl.parent === declFile && !hasExportModifierNode(decl) && declFile !== localFile) {
      diagnostics?.push(
        makeDiag(
          LoweringDiagCode.SystemModuleReferenceNotCarryable,
          `A System body references '${id.text}', a non-exported binding in its defining module; export it (or use a \`const\` value or \`function\`) so importing modules can resolve it.`,
          id
        )
      );
    }
    return;
  }
}

/**
 * A defining-module `const` an imported System body references, re-lowered inline
 * at each reference site in the importing module. The store where module-level
 * consts live (per-callsite state) is not bound in the fiber that runs a System's
 * `init` / `think` / methods.
 */
export interface InlinedSystemConst {
  /** Declaration symbol of the `const` (resolved against the shared checker); the reference key. */
  symbol: ts.Symbol;
  /** The `const`'s initializer expression, re-lowered inline at each reference. */
  initializer: ts.Expression;
}

/**
 * A non-exported `function` an imported System body (or a helper it calls)
 * references, re-lowered into the importer. It is registered in the function
 * table under its {@link carriedFunctionKey} identity key and its call sites
 * resolve by declaration symbol, so same-named private helpers from different
 * modules do not collide.
 */
export interface CarriedPrivateFunction {
  /** Declaration symbol of the function (resolved against the shared checker); the call-site key. */
  symbol: ts.Symbol;
  /** The function declaration, re-lowered into the importer. */
  node: ts.FunctionDeclaration;
}

/** The function-table key for a carried private function declared in `fileName` with name `name`. */
function carriedFunctionKey(fileName: string, name: string): string {
  return `${fileName}::${name}`;
}

/**
 * BFS the closure of defining-module bindings that `seedNodes` (System config
 * literals or function bodies) reference, transitively following function bodies
 * and const initializers. Each referenced top-level `function` invokes
 * `onFunction` and each carryable `const` invokes `onConst`, both given an
 * `enqueue` to push a body / initializer node for further traversal. References
 * resolve whole-program (a binding is classified against its own defining file).
 * When `diagnoseNonCarryable` is true, a reference to a binding that cannot be
 * used from a System fiber (a `let`, a non-primitive `const`, a class/enum) is
 * diagnosed; when false those references are left alone (they resolve normally in
 * an ordinary fiber).
 */
function walkSystemBindingClosure(
  seedNodes: ts.Node[],
  checker: ts.TypeChecker,
  diagnostics: CompileDiagnostic[],
  diagnoseNonCarryable: boolean,
  localFile: ts.SourceFile | undefined,
  onFunction: (decl: ts.FunctionDeclaration, symbol: ts.Symbol, enqueue: (node: ts.Node) => void) => void,
  onConst: (decl: ts.VariableDeclaration, symbol: ts.Symbol, enqueue: (node: ts.Node) => void) => void
): void {
  const visited = new Set<ts.Node>();
  const worklist: ts.Node[] = [...seedNodes];
  const enqueue = (node: ts.Node): void => {
    worklist.push(node);
  };
  while (worklist.length > 0) {
    const node = worklist.pop();
    if (!node || visited.has(node)) continue;
    visited.add(node);
    const visitNode = (n: ts.Node): void => {
      if (ts.isIdentifier(n)) {
        if (isValueReferenceIdentifier(n)) {
          classifySystemModuleReference(
            n,
            checker,
            diagnoseNonCarryable ? diagnostics : undefined,
            localFile,
            (fnDecl, symbol) => onFunction(fnDecl, symbol, enqueue),
            (constDecl, symbol) => onConst(constDecl, symbol, enqueue)
          );
        }
        return;
      }
      ts.forEachChild(n, visitNode);
    };
    visitNode(node);
  }
}

/**
 * Collect the module-level `const` bindings that co-located Systems (Systems
 * defined in the same module as their consuming tile, `entryFile`) reference,
 * transitively through the functions they call, for the inline map. Their
 * per-callsite backing store is not bound in a System fiber. Non-carryable
 * references are diagnosed.
 */
function collectCoLocatedSystemConsts(
  systemConfigs: ts.ObjectLiteralExpression[],
  entryFile: ts.SourceFile,
  checker: ts.TypeChecker,
  diagnostics: CompileDiagnostic[]
): InlinedSystemConst[] {
  if (systemConfigs.length === 0) return [];
  const constsToInline = new Set<ts.VariableDeclaration>();
  const inlinedConsts: InlinedSystemConst[] = [];
  walkSystemBindingClosure(
    systemConfigs,
    checker,
    diagnostics,
    true,
    entryFile,
    (fnDecl, _symbol, enqueue) => {
      if (fnDecl.body) enqueue(fnDecl.body);
    },
    (constDecl, symbol, enqueue) => {
      if (!constsToInline.has(constDecl) && constDecl.initializer) {
        constsToInline.add(constDecl);
        inlinedConsts.push({ symbol, initializer: constDecl.initializer });
        enqueue(constDecl.initializer);
      }
    }
  );
  return inlinedConsts;
}

/**
 * Collect the defining-module top-level bindings that exported Systems in
 * `visitedModuleFiles` reference, so an importing module re-lowering a System
 * body can resolve them. The compiler re-lowers a System's `state` / `init` /
 * `think` / method bodies in every importing module; those bodies may reference
 * top-level `const` values and `function` declarations declared beside the
 * System, which a plain named import does not pull in. Walks each module's
 * exported System configs (transitively, following functions into consts and
 * back) and returns:
 * - `privateFunctions`: referenced non-exported `function` declarations, carried
 *   into the importer under an identity key that keeps same-named helpers from
 *   different modules distinct;
 * - `inlinedConsts`: referenced `const` bindings, re-lowered inline at each
 *   reference site; their per-callsite backing store is not bound in a System fiber.
 * A reference to a top-level binding that is neither a carryable `const` nor a
 * `function` yields a diagnostic.
 */
export function collectSystemModuleBindings(
  visitedModuleFiles: ts.SourceFile[],
  checker: ts.TypeChecker
): {
  privateFunctions: CarriedPrivateFunction[];
  inlinedConsts: InlinedSystemConst[];
  diagnostics: CompileDiagnostic[];
} {
  const privateFunctions: CarriedPrivateFunction[] = [];
  const inlinedConsts: InlinedSystemConst[] = [];
  const diagnostics: CompileDiagnostic[] = [];

  for (const moduleFile of visitedModuleFiles) {
    const systemConfigs: ts.ObjectLiteralExpression[] = [];
    const exportedFunctionBodies: ts.Node[] = [];
    for (const stmt of moduleFile.statements) {
      if (ts.isVariableStatement(stmt) && hasExportModifierNode(stmt)) {
        for (const decl of stmt.declarationList.declarations) {
          const config = systemConfigObject(decl.initializer);
          if (config) systemConfigs.push(config);
        }
      } else if (ts.isFunctionDeclaration(stmt) && hasExportModifierNode(stmt) && stmt.body) {
        exportedFunctionBodies.push(stmt.body);
      }
    }
    if (systemConfigs.length === 0 && exportedFunctionBodies.length === 0) continue;

    const fnsToCarry = new Set<ts.FunctionDeclaration>();
    const constsToCarry = new Set<ts.VariableDeclaration>();
    const carryFunction = (
      fnDecl: ts.FunctionDeclaration,
      symbol: ts.Symbol,
      enqueue: (node: ts.Node) => void
    ): void => {
      // An exported function is already collected by the import walker; traverse
      // its body so consts it reaches still resolve, without re-carrying it.
      if (hasExportModifierNode(fnDecl)) {
        if (fnDecl.body) enqueue(fnDecl.body);
        return;
      }
      if (!fnsToCarry.has(fnDecl) && fnDecl.body) {
        fnsToCarry.add(fnDecl);
        privateFunctions.push({ symbol, node: fnDecl });
        enqueue(fnDecl.body);
      }
    };
    const carryConst = (
      constDecl: ts.VariableDeclaration,
      symbol: ts.Symbol,
      enqueue: (node: ts.Node) => void
    ): void => {
      if (!constsToCarry.has(constDecl) && constDecl.initializer) {
        constsToCarry.add(constDecl);
        inlinedConsts.push({ symbol, initializer: constDecl.initializer });
        enqueue(constDecl.initializer);
      }
    };
    // System roots: strict -- consts reached from a System fiber (exported or not)
    // must inline, and non-carryable references are diagnosed.
    walkSystemBindingClosure(systemConfigs, checker, diagnostics, true, undefined, carryFunction, carryConst);
    // Exported-function roots: lenient -- carry only the non-exported bindings a
    // re-lowered function needs; exported consts keep their callsite-var backing.
    walkSystemBindingClosure(
      exportedFunctionBodies,
      checker,
      diagnostics,
      false,
      undefined,
      carryFunction,
      (constDecl, symbol, enqueue) => {
        const stmt = constDecl.parent.parent;
        if (ts.isVariableStatement(stmt) && hasExportModifierNode(stmt)) return;
        carryConst(constDecl, symbol, enqueue);
      }
    );
  }

  return { privateFunctions, inlinedConsts, diagnostics };
}

/**
 * Lower a System function-like member (method, `init`, or `think`) as a
 * struct-receiver function: `this` (the state struct) at local 0, the source
 * parameters at locals 1..N. Mirrors class-method lowering.
 */
function lowerSystemFnEntry(
  fnNode: SystemFnNode,
  name: string,
  checker: ts.TypeChecker,
  callsiteVars: Map<string, number>,
  functionTable: Map<string, number>,
  diagnostics: CompileDiagnostic[],
  funcIdCounter: { value: number },
  closureFunctions: Map<number, FunctionEntry>,
  services: BrainServices,
  projectNamespace: string,
  classInfos: ClassInfo[],
  systemBindings: Map<ts.Symbol, SystemBinding>,
  thisStructTypeId: TypeId | undefined,
  thisSystemMethodFuncIds: Map<string, number>,
  inlineConsts: Map<ts.Symbol, ts.Expression>,
  carriedFunctionKeys: Map<ts.Symbol, string>
): FunctionEntry {
  const ir: IrNode[] = [];
  const params = fnNode.parameters;
  const userParamCount = params.length;
  const totalParamCount = userParamCount + 1;

  const paramLocals = new Map<string, number>();
  for (let i = 0; i < userParamCount; i++) {
    const p = params[i];
    if (ts.isIdentifier(p.name)) paramLocals.set(p.name.text, i + 1);
  }

  const scopeStack = new ScopeStack(totalParamCount);
  const funcScopeId = scopeStack.initFunctionScope(0, name);
  scopeStack.addParameterMetadata("this", 0, funcScopeId);
  for (let i = 0; i < userParamCount; i++) {
    const p = params[i];
    if (ts.isIdentifier(p.name)) scopeStack.addParameterMetadata(p.name.text, i + 1, funcScopeId);
  }

  const ctx: LowerContext = {
    services,
    projectNamespace,
    checker,
    paramsSymbol: undefined,
    paramLocals,
    scopeStack,
    ir,
    diagnostics,
    loopStack: [],
    breakStack: [],
    nextLabelId: 0,
    callsiteVars,
    functionTable,
    funcIdCounter,
    closureFunctions,
    thisLocalIndex: 0,
    thisStructTypeId,
    thisSystemMethodFuncIds,
    currentFunctionName: name,
    currentReturnTypeId: resolveSignatureReturnTypeId(fnNode, checker, services, projectNamespace),
    classInfos,
    systemBindings,
    inlineConsts,
    inliningConsts: new Set<ts.Symbol>(),
    carriedFunctionKeys,
    nonSuspendableContext: "a System method (System `init`, `think`, and methods cannot suspend)",
  };

  for (let i = 0; i < userParamCount; i++) {
    const p = params[i];
    if (ts.isObjectBindingPattern(p.name)) {
      lowerObjectBindingPattern(p.name, i + 1, ctx);
    } else if (ts.isArrayBindingPattern(p.name)) {
      lowerArrayBindingPattern(p.name, i + 1, ctx);
    }
  }

  const body = fnNode.body;
  if (body && ts.isBlock(body)) {
    lowerStatements(body.statements, ctx);
    ir.push({ kind: "PushConst", value: NIL_VALUE });
    ir.push({ kind: "Return" });
  } else if (body) {
    lowerExpressionWithExpectedType(body, ctx.currentReturnTypeId, "return statement", body, ctx);
    ir.push({ kind: "Return" });
  } else {
    ir.push({ kind: "PushConst", value: NIL_VALUE });
    ir.push({ kind: "Return" });
  }

  scopeStack.finalizeFunctionScope(ir.length);
  return {
    ir,
    numParams: totalParamCount,
    numLocals: scopeStack.nextLocal,
    name,
    scopeMetadata: [...scopeStack.scopeMetadata],
    localMetadata: [...scopeStack.localMetadata],
    isGenerated: false,
    sourceFileName: fnNode.getSourceFile()?.fileName,
    functionSpan: spanFromNode(fnNode),
  };
}

/**
 * Generate the ctx-injected init wrapper the runtime calls once at startup: it
 * builds the initial state struct from the `state` literal, stores it into the
 * System slot, then calls the user `init` (if any) with `(state, ctx)`.
 */
function generateSystemInitWrapper(
  binding: SystemBinding,
  checker: ts.TypeChecker,
  callsiteVars: Map<string, number>,
  functionTable: Map<string, number>,
  diagnostics: CompileDiagnostic[],
  funcIdCounter: { value: number },
  closureFunctions: Map<number, FunctionEntry>,
  services: BrainServices,
  projectNamespace: string,
  classInfos: ClassInfo[],
  systemBindings: Map<ts.Symbol, SystemBinding>,
  inlineConsts: Map<ts.Symbol, ts.Expression>,
  carriedFunctionKeys: Map<ts.Symbol, string>
): FunctionEntry {
  const ir: IrNode[] = [];
  const scopeStack = new ScopeStack(1);
  scopeStack.initFunctionScope(0, `${binding.name}.<init>`);

  const ctx: LowerContext = {
    services,
    projectNamespace,
    checker,
    paramsSymbol: undefined,
    paramLocals: new Map<string, number>(),
    scopeStack,
    ir,
    diagnostics,
    loopStack: [],
    breakStack: [],
    nextLabelId: 0,
    callsiteVars,
    functionTable,
    funcIdCounter,
    closureFunctions,
    currentFunctionName: `${binding.name}.<init>`,
    classInfos,
    systemBindings,
    inlineConsts,
    inliningConsts: new Set<ts.Symbol>(),
    carriedFunctionKeys,
    nonSuspendableContext: "a System `init` (cannot suspend)",
  };

  // Build the initial state struct from the `state` literal against the
  // registered state struct def when known, else lower the expression directly.
  const stateDef =
    binding.stateTypeId !== undefined
      ? (services.runtime.types.get(binding.stateTypeId) as StructTypeDef | undefined)
      : undefined;
  if (stateDef && ts.isObjectLiteralExpression(binding.stateNode)) {
    lowerObjectLiteralAsStruct(binding.stateNode, stateDef, ctx);
  } else {
    lowerExpression(binding.stateNode, ctx);
  }
  ir.push({ kind: "StoreSystemVar", index: binding.localSlot });

  if (binding.userInitFuncId !== undefined) {
    const hasCtx = (binding.initNode?.parameters.length ?? 0) > 0;
    ir.push({ kind: "LoadSystemVar", index: binding.localSlot });
    if (hasCtx) ir.push({ kind: "LoadLocal", index: 0 });
    ir.push({ kind: "Call", funcIndex: binding.userInitFuncId, argc: hasCtx ? 2 : 1 });
    ir.push({ kind: "Pop" });
  }

  ir.push({ kind: "PushConst", value: NIL_VALUE });
  ir.push({ kind: "Return" });

  scopeStack.finalizeFunctionScope(ir.length);
  return {
    ir,
    numParams: 1,
    numLocals: scopeStack.nextLocal,
    name: `${binding.name}.<init>`,
    injectCtxTypeId: ContextTypeIds.Context,
    scopeMetadata: [...scopeStack.scopeMetadata],
    localMetadata: [...scopeStack.localMetadata],
    isGenerated: true,
  };
}

/**
 * Generate the ctx-injected think wrapper the runtime calls every think: it
 * loads the System's state and calls the user `think` with `(state, ctx)`.
 */
function generateSystemThinkWrapper(
  name: string,
  localSlot: number,
  userThinkFuncId: number,
  hasCtx: boolean
): FunctionEntry {
  const ir: IrNode[] = [];
  ir.push({ kind: "LoadSystemVar", index: localSlot });
  if (hasCtx) ir.push({ kind: "LoadLocal", index: 0 });
  ir.push({ kind: "Call", funcIndex: userThinkFuncId, argc: hasCtx ? 2 : 1 });
  ir.push({ kind: "Pop" });
  ir.push({ kind: "PushConst", value: NIL_VALUE });
  ir.push({ kind: "Return" });
  return {
    ir,
    numParams: 1,
    numLocals: 1,
    name: `${name}.<think>`,
    injectCtxTypeId: ContextTypeIds.Context,
    isGenerated: true,
  };
}

function isInsideDescriptor(stmt: ts.VariableStatement): boolean {
  return stmt.parent !== undefined && !ts.isSourceFile(stmt.parent);
}

function hasTopLevelInitializers(sourceFile: ts.SourceFile): boolean {
  for (const stmt of sourceFile.statements) {
    if (ts.isVariableStatement(stmt) && ts.isSourceFile(stmt.parent)) {
      for (const decl of stmt.declarationList.declarations) {
        // System bindings have no callsite-var slot; their state is built by the
        // System init wrapper, not the module-scope initializer.
        if (decl.initializer && ts.isIdentifier(decl.name) && !systemConfigObject(decl.initializer)) {
          return true;
        }
      }
    }
  }
  return false;
}

function argSlotPropertyName(slot: ArgSlot): string {
  if (slot.spec.kind === "param") return slot.spec.name;
  const id = slot.spec.id;
  const lastDot = id.lastIndexOf(".");
  return lastDot >= 0 ? id.substring(lastDot + 1) : id;
}

/**
 * Lower a conversion's `convert` function as the artifact entry. The single
 * declared parameter is the positional argument of the conversion's
 * `ACTION_CALL` site (local 0); no execution context is injected.
 */
function lowerConvertBody(
  descriptor: ExtractedDescriptor,
  checker: ts.TypeChecker,
  callsiteVars: Map<string, number>,
  functionTable: Map<string, number>,
  sharedDiagnostics: CompileDiagnostic[],
  funcIdCounter: { value: number },
  closureFunctions: Map<number, FunctionEntry>,
  services: BrainServices,
  projectNamespace: string,
  classInfos: ClassInfo[],
  systemBindings: Map<ts.Symbol, SystemBinding>
): FunctionEntry {
  const ir: IrNode[] = [];
  const funcNode = descriptor.onExecuteNode;
  const funcName = `${descriptor.name}.convert`;

  const paramLocals = new Map<string, number>();
  const valueParam = funcNode.parameters[0];
  if (valueParam && ts.isIdentifier(valueParam.name)) {
    paramLocals.set(valueParam.name.text, 0);
  } else if (valueParam) {
    sharedDiagnostics.push(
      makeDiag(
        LoweringDiagCode.DestructuringInOnExecuteNotSupported,
        "Destructuring in convert parameters is not supported",
        valueParam
      )
    );
  }

  const scopeStack = new ScopeStack(1);
  const funcScopeId = scopeStack.initFunctionScope(0, funcName);
  if (valueParam && ts.isIdentifier(valueParam.name)) {
    scopeStack.addParameterMetadata(valueParam.name.text, 0, funcScopeId);
  }

  const ctx: LowerContext = {
    services,
    projectNamespace,
    checker,
    paramsSymbol: undefined,
    paramLocals,
    scopeStack,
    ir,
    diagnostics: sharedDiagnostics,
    loopStack: [],
    breakStack: [],
    nextLabelId: 0,
    callsiteVars,
    functionTable,
    funcIdCounter,
    closureFunctions,
    currentFunctionName: funcName,
    currentReturnTypeId: resolveSignatureReturnTypeId(funcNode, checker, services, projectNamespace),
    classInfos,
    systemBindings,
    nonSuspendableContext: "a conversion `convert` (conversions are synchronous)",
  };

  const body = funcNode.body;
  if (!body || !ts.isBlock(body)) {
    sharedDiagnostics.push({
      code: LoweringDiagCode.OnExecuteHasNoBody,
      message: "convert function has no body",
      severity: "error",
    });
  } else {
    lowerStatements(body.statements, ctx);
    ir.push({ kind: "PushConst", value: NIL_VALUE });
    ir.push({ kind: "Return" });
  }

  scopeStack.finalizeFunctionScope(ir.length);
  return {
    ir,
    numParams: 1,
    numLocals: scopeStack.nextLocal,
    name: funcName,
    scopeMetadata: [...scopeStack.scopeMetadata],
    localMetadata: [...scopeStack.localMetadata],
    isGenerated: false,
    sourceFileName: funcNode.getSourceFile()?.fileName,
    functionSpan: spanFromNode(funcNode),
  };
}

function lowerOnExecuteBody(
  descriptor: ExtractedDescriptor,
  checker: ts.TypeChecker,
  callsiteVars: Map<string, number>,
  functionTable: Map<string, number>,
  sharedDiagnostics: CompileDiagnostic[],
  funcIdCounter: { value: number },
  closureFunctions: Map<number, FunctionEntry>,
  services: BrainServices,
  projectNamespace: string,
  classInfos: ClassInfo[],
  systemBindings: Map<ts.Symbol, SystemBinding>
): FunctionEntry {
  switch (descriptor.kind) {
    case "conversion":
      return lowerConvertBody(
        descriptor,
        checker,
        callsiteVars,
        functionTable,
        sharedDiagnostics,
        funcIdCounter,
        closureFunctions,
        services,
        projectNamespace,
        classInfos,
        systemBindings
      );
    case "sensor":
    case "actuator":
      break;
    default:
      assertUnreachable(descriptor.kind);
  }

  const ir: IrNode[] = [];
  const argSlots = collectArgSlots(descriptor.args);
  const hasArgs = argSlots.length > 0;
  const funcNode = descriptor.onExecuteNode;

  const paramLocals = new Map<string, number>();

  for (const param of funcNode.parameters) {
    if (!ts.isIdentifier(param.name)) {
      sharedDiagnostics.push(
        makeDiag(
          LoweringDiagCode.DestructuringInOnExecuteNotSupported,
          "Destructuring in onExecute parameters is not supported",
          param
        )
      );
    }
  }

  // Local 0 is always the injected context struct. When the tile has args,
  // locals 1..N hold the positional action arguments.
  const nextLocal = 1 + argSlots.length;

  const ctxParam = funcNode.parameters[0];
  if (ctxParam && ts.isIdentifier(ctxParam.name)) {
    paramLocals.set(ctxParam.name.text, 0);
  }

  const argLocals = new Map<string, number>();
  let paramsSymbol: ts.Symbol | undefined;
  const nextLabelId = 0;
  if (hasArgs) {
    const paramsParam = funcNode.parameters.length >= 2 ? funcNode.parameters[1] : undefined;
    if (paramsParam) {
      paramsSymbol = checker.getSymbolAtLocation(paramsParam.name);
    }

    for (const slot of argSlots) {
      const name = argSlotPropertyName(slot);
      const localIdx = 1 + slot.slotId;
      argLocals.set(name, localIdx);
    }
  }

  let sensorOutputs: Map<string, TypeId> | undefined;
  let sensorOutputNames: Set<string> | undefined;
  if (descriptor.kind === "sensor" && descriptor.outputs && descriptor.outputs.length > 0) {
    sensorOutputs = new Map<string, TypeId>();
    sensorOutputNames = new Set<string>();
    for (const output of descriptor.outputs) {
      sensorOutputNames.add(output.name);
      const typeId = resolveOutputTypeId(output.type, services);
      if (typeId === undefined) {
        sharedDiagnostics.push(
          makeDiag(
            LoweringDiagCode.OutputTypeUnresolvable,
            `Sensor output \`${output.name}\` declares type \`${output.type}\`, which does not resolve to a registered type.`,
            funcNode
          )
        );
        continue;
      }
      sensorOutputs.set(output.name, typeId);
    }
  }

  const scopeStack = new ScopeStack(nextLocal);
  const funcScopeId = scopeStack.initFunctionScope(0, `${descriptor.name}.onExecute`);

  if (ctxParam && ts.isIdentifier(ctxParam.name)) {
    scopeStack.addParameterMetadata(ctxParam.name.text, 0, funcScopeId);
  }
  if (hasArgs) {
    for (const slot of argSlots) {
      const name = argSlotPropertyName(slot);
      const idx = argLocals.get(name);
      if (idx !== undefined) {
        scopeStack.addParameterMetadata(name, idx, funcScopeId);
      }
    }
  }

  const ctx: LowerContext = {
    services,
    projectNamespace,
    checker,
    paramsSymbol,
    paramLocals,
    argLocals,
    scopeStack,
    ir,
    diagnostics: sharedDiagnostics,
    loopStack: [],
    breakStack: [],
    nextLabelId,
    callsiteVars,
    functionTable,
    funcIdCounter,
    closureFunctions,
    currentFunctionName: `${descriptor.name}.onExecute`,
    currentReturnTypeId: resolveSignatureReturnTypeId(funcNode, checker, services, projectNamespace),
    classInfos,
    systemBindings,
    sensorOutputs,
    sensorOutputNames,
    nonSuspendableContext: descriptor.execIsAsync
      ? undefined
      : "a synchronous `onExecute`. Declare `onExecute` as `async` and `await` the call",
  };

  const body = funcNode.body;
  if (!body || !ts.isBlock(body)) {
    sharedDiagnostics.push({
      code: LoweringDiagCode.OnExecuteHasNoBody,
      message: "onExecute function has no body",
      severity: "error",
    });
    scopeStack.finalizeFunctionScope(ir.length);
    return {
      ir,
      numParams: 1 + argSlots.length,
      numLocals: scopeStack.nextLocal,
      name: `${descriptor.name}.onExecute`,
      injectCtxTypeId: ContextTypeIds.Context,
      scopeMetadata: [...scopeStack.scopeMetadata],
      localMetadata: [...scopeStack.localMetadata],
      isGenerated: false,
      sourceFileName: funcNode.getSourceFile()?.fileName,
      functionSpan: spanFromNode(funcNode),
    };
  }

  lowerStatements(body.statements, ctx);

  ir.push({ kind: "PushConst", value: NIL_VALUE });
  ir.push({ kind: "Return" });

  scopeStack.finalizeFunctionScope(ir.length);
  return {
    ir,
    numParams: 1 + argSlots.length,
    numLocals: scopeStack.nextLocal,
    name: `${descriptor.name}.onExecute`,
    injectCtxTypeId: ContextTypeIds.Context,
    scopeMetadata: [...scopeStack.scopeMetadata],
    localMetadata: [...scopeStack.localMetadata],
    isGenerated: false,
    sourceFileName: funcNode.getSourceFile()?.fileName,
    functionSpan: spanFromNode(funcNode),
  };
}

function lowerHelperFunction(
  funcNode: ts.FunctionDeclaration,
  checker: ts.TypeChecker,
  callsiteVars: Map<string, number>,
  functionTable: Map<string, number>,
  sharedDiagnostics: CompileDiagnostic[],
  funcIdCounter: { value: number },
  closureFunctions: Map<number, FunctionEntry>,
  services: BrainServices,
  projectNamespace: string,
  classInfos: ClassInfo[],
  systemBindings: Map<ts.Symbol, SystemBinding>,
  inlineConsts: Map<ts.Symbol, ts.Expression>,
  carriedFunctionKeys: Map<ts.Symbol, string>
): FunctionEntry {
  const ir: IrNode[] = [];
  const paramLocals = new Map<string, number>();
  const numParams = funcNode.parameters.length;

  for (let i = 0; i < numParams; i++) {
    const p = funcNode.parameters[i];
    if (ts.isIdentifier(p.name)) {
      paramLocals.set(p.name.text, i);
    }
  }

  const funcName = funcNode.name?.text ?? "<anonymous>";
  const scopeStack = new ScopeStack(numParams);
  const funcScopeId = scopeStack.initFunctionScope(0, funcName);

  for (let i = 0; i < numParams; i++) {
    const p = funcNode.parameters[i];
    if (ts.isIdentifier(p.name)) {
      scopeStack.addParameterMetadata(p.name.text, i, funcScopeId);
    }
  }

  const ctx: LowerContext = {
    services,
    projectNamespace,
    checker,
    paramsSymbol: undefined,
    paramLocals,
    scopeStack,
    ir,
    diagnostics: sharedDiagnostics,
    loopStack: [],
    breakStack: [],
    nextLabelId: 0,
    callsiteVars,
    functionTable,
    funcIdCounter,
    closureFunctions,
    currentFunctionName: funcName,
    currentReturnTypeId: resolveSignatureReturnTypeId(funcNode, checker, services, projectNamespace),
    classInfos,
    systemBindings,
    inlineConsts,
    inliningConsts: new Set<ts.Symbol>(),
    carriedFunctionKeys,
  };

  for (let i = 0; i < numParams; i++) {
    const p = funcNode.parameters[i];
    if (ts.isObjectBindingPattern(p.name)) {
      lowerObjectBindingPattern(p.name, i, ctx);
    } else if (ts.isArrayBindingPattern(p.name)) {
      lowerArrayBindingPattern(p.name, i, ctx);
    }
  }

  const body = funcNode.body;
  if (!body) {
    sharedDiagnostics.push(makeDiag(LoweringDiagCode.FunctionHasNoBody, "Function has no body", funcNode));
    scopeStack.finalizeFunctionScope(ir.length);
    return {
      ir,
      numParams,
      numLocals: scopeStack.nextLocal,
      name: funcName,
      scopeMetadata: [...scopeStack.scopeMetadata],
      localMetadata: [...scopeStack.localMetadata],
      isGenerated: false,
      sourceFileName: funcNode.getSourceFile()?.fileName,
      functionSpan: spanFromNode(funcNode),
    };
  }

  lowerStatements(body.statements, ctx);

  ir.push({ kind: "PushConst", value: NIL_VALUE });
  ir.push({ kind: "Return" });

  scopeStack.finalizeFunctionScope(ir.length);
  return {
    ir,
    numParams,
    numLocals: scopeStack.nextLocal,
    name: funcName,
    scopeMetadata: [...scopeStack.scopeMetadata],
    localMetadata: [...scopeStack.localMetadata],
    isGenerated: false,
    sourceFileName: funcNode.getSourceFile()?.fileName,
    functionSpan: spanFromNode(funcNode),
  };
}

function generateModuleInitWithImports(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  callsiteVars: Map<string, number>,
  functionTable: Map<string, number>,
  sharedDiagnostics: CompileDiagnostic[],
  funcIdCounter: { value: number },
  closureFunctions: Map<number, FunctionEntry>,
  importedVariables: ImportedVariable[],
  moduleInitOrder: string[],
  classInfos: ClassInfo[],
  services: BrainServices,
  projectNamespace: string,
  systemBindings: Map<ts.Symbol, SystemBinding>
): FunctionEntry {
  const ir: IrNode[] = [];
  const scopeStack = new ScopeStack(0);
  scopeStack.initFunctionScope(0, "<module-init>");

  const ctx: LowerContext = {
    services,
    projectNamespace,
    checker,
    paramsSymbol: undefined,
    paramLocals: new Map(),
    scopeStack,
    ir,
    diagnostics: sharedDiagnostics,
    loopStack: [],
    breakStack: [],
    nextLabelId: 0,
    callsiteVars,
    functionTable,
    funcIdCounter,
    closureFunctions,
    currentFunctionName: "<module-init>",
    classInfos,
    systemBindings,
    nonSuspendableContext: "a module-level initializer",
  };

  for (const moduleName of moduleInitOrder) {
    for (const iv of importedVariables) {
      if (iv.sourceModule === moduleName && iv.initializer) {
        const varIdx = callsiteVars.get(iv.name);
        if (varIdx !== undefined) {
          const decl = ts.isVariableDeclaration(iv.initializer.parent) ? iv.initializer.parent : undefined;
          const expectedTypeId = decl ? resolveVariableDeclarationTargetTypeId(decl, ctx) : undefined;
          lowerExpressionWithExpectedType(
            iv.initializer,
            expectedTypeId,
            `variable initializer for '${iv.name}'`,
            iv.initializer,
            ctx
          );
          ir.push({ kind: "StoreCallsiteVar", index: varIdx });
        }
      }
    }
  }

  for (const stmt of sourceFile.statements) {
    if (ts.isVariableStatement(stmt) && ts.isSourceFile(stmt.parent)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.initializer) {
          const varIdx = callsiteVars.get(decl.name.text);
          if (varIdx !== undefined) {
            lowerExpressionWithExpectedType(
              decl.initializer,
              resolveVariableDeclarationTargetTypeId(decl, ctx),
              `variable initializer for '${decl.name.text}'`,
              decl.initializer,
              ctx
            );
            ir.push({ kind: "StoreCallsiteVar", index: varIdx });
          }
        }
      }
    }
  }

  for (const ci of classInfos) {
    for (const member of ci.node.members) {
      if (!ts.isPropertyDeclaration(member)) continue;
      if (!hasStaticModifier(member)) continue;
      if (!ts.isIdentifier(member.name)) {
        ctx.diagnostics.push(
          makeDiag(
            LoweringDiagCode.ComputedClassMemberNameNotSupported,
            "Computed property names are not supported in class declarations",
            member.name
          )
        );
        continue;
      }
      const fieldName = member.name.text;
      const slot = ci.staticFieldSlots.get(fieldName);
      if (slot === undefined) continue;

      if (member.initializer) {
        const memberType = checker.getTypeAtLocation(member);
        const fieldTypeId = tsTypeToTypeId(memberType, checker, services, projectNamespace);
        lowerExpressionWithExpectedType(
          member.initializer,
          fieldTypeId,
          `static field initializer for '${ci.name}.${fieldName}'`,
          member.initializer,
          ctx
        );
      } else {
        const memberType = checker.getTypeAtLocation(member);
        const fieldTypeId = tsTypeToTypeId(memberType, checker, services, projectNamespace);
        if (!fieldTypeId) {
          ctx.diagnostics.push(
            makeDiag(
              LoweringDiagCode.UnresolvableClassFieldType,
              `Cannot resolve type of static field '${ci.name}.${fieldName}'`,
              member
            )
          );
          continue;
        }
        if (fieldTypeId === CoreTypeIds.Number) {
          ir.push({ kind: "PushConst", value: mkNumberValue(0) });
        } else if (fieldTypeId === CoreTypeIds.Boolean) {
          ir.push({ kind: "PushConst", value: FALSE_VALUE });
        } else if (fieldTypeId === CoreTypeIds.String) {
          ir.push({ kind: "PushConst", value: mkStringValue("") });
        } else {
          ir.push({ kind: "PushConst", value: NIL_VALUE });
        }
      }
      ir.push({ kind: "StoreCallsiteVar", index: slot });
    }
  }

  ir.push({ kind: "PushConst", value: NIL_VALUE });
  ir.push({ kind: "Return" });

  scopeStack.finalizeFunctionScope(ir.length);
  return {
    ir,
    numParams: 0,
    numLocals: scopeStack.nextLocal,
    name: "<module-init>",
    scopeMetadata: [...scopeStack.scopeMetadata],
    localMetadata: [...scopeStack.localMetadata],
    isGenerated: true,
    sourceFileName: sourceFile.fileName,
  };
}

function lowerStatements(stmts: ts.NodeArray<ts.Statement>, ctx: LowerContext): void {
  hoistNestedFunctionDeclarations(stmts, ctx);
  for (const stmt of stmts) {
    lowerStatement(stmt, ctx);
  }
}

function nestedFuncNeedsCaptures(
  func: ts.FunctionDeclaration,
  siblingFuncNames: Set<string>,
  ctx: LowerContext
): boolean {
  const ownParamNames = new Set<string>();
  for (const p of func.parameters) {
    if (ts.isIdentifier(p.name)) {
      ownParamNames.add(p.name.text);
    } else if (ts.isObjectBindingPattern(p.name) || ts.isArrayBindingPattern(p.name)) {
      for (const name of collectBindingNames(p.name)) {
        ownParamNames.add(name);
      }
    }
  }

  let result = false;

  function visit(node: ts.Node): void {
    if (result) return;
    if (ts.isIdentifier(node) && isIdentifierReference(node)) {
      const name = node.text;
      if (name === "undefined" || ownParamNames.has(name) || siblingFuncNames.has(name)) return;
      if (ctx.functionTable.has(name) || ctx.callsiteVars.has(name)) return;

      const sym = ctx.checker.getSymbolAtLocation(node);
      if (!sym) return;
      const decls = sym.getDeclarations();
      if (!decls || decls.length === 0) return;
      const decl0 = decls[0];
      if (isDescendantOf(decl0, func)) return;
      const parentBody = func.parent;
      if (parentBody && isDescendantOf(decl0, parentBody)) {
        result = true;
      }
    }
    if (!result) ts.forEachChild(node, visit);
  }

  if (func.body) ts.forEachChild(func.body, visit);
  return result;
}

function hoistNestedFunctionDeclarations(stmts: ts.NodeArray<ts.Statement>, ctx: LowerContext): void {
  const nestedFuncs: ts.FunctionDeclaration[] = [];
  for (const stmt of stmts) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body) {
      nestedFuncs.push(stmt);
    }
  }
  if (nestedFuncs.length === 0) return;

  const siblingNames = new Set<string>();
  for (const func of nestedFuncs) {
    siblingNames.add(func.name!.text);
  }

  const hoistable: ts.FunctionDeclaration[] = [];
  const capturing: ts.FunctionDeclaration[] = [];
  for (const func of nestedFuncs) {
    if (nestedFuncNeedsCaptures(func, siblingNames, ctx)) {
      capturing.push(func);
    } else {
      hoistable.push(func);
    }
  }

  for (const func of hoistable) {
    const name = func.name!.text;
    ctx.functionTable.set(name, ctx.funcIdCounter.value++);
  }

  for (const func of hoistable) {
    const name = func.name!.text;
    const funcId = ctx.functionTable.get(name)!;
    const localIdx = ctx.scopeStack.declareLocal(name);
    const entry = lowerHelperFunction(
      func,
      ctx.checker,
      ctx.callsiteVars,
      ctx.functionTable,
      ctx.diagnostics,
      ctx.funcIdCounter,
      ctx.closureFunctions,
      ctx.services,
      ctx.projectNamespace,
      ctx.classInfos,
      ctx.systemBindings ?? new Map<ts.Symbol, SystemBinding>(),
      ctx.inlineConsts ?? new Map<ts.Symbol, ts.Expression>(),
      ctx.carriedFunctionKeys ?? new Map<ts.Symbol, string>()
    );
    ctx.closureFunctions.set(funcId, entry);
    ctx.ir.push({ kind: "PushFunctionRef", funcName: name });
    ctx.ir.push({ kind: "StoreLocal", index: localIdx });
    ctx.scopeStack.setLocalIrStart(localIdx, ctx.ir.length);
    if (!ctx.hoistedFunctionNodes) ctx.hoistedFunctionNodes = new Set();
    ctx.hoistedFunctionNodes.add(func);
  }

  for (const func of capturing) {
    ctx.scopeStack.declareLocal(func.name!.text);
  }
}

function lowerStatement(stmt: ts.Statement, ctx: LowerContext): void {
  const irStart = ctx.ir.length;

  if (ts.isReturnStatement(stmt)) {
    if (stmt.expression) {
      lowerExpressionWithExpectedType(
        stmt.expression,
        ctx.currentReturnTypeId,
        "return statement",
        stmt.expression,
        ctx
      );
    }
    ctx.ir.push({ kind: "Return" });
  } else if (ts.isExpressionStatement(stmt)) {
    lowerExpression(stmt.expression, ctx);
    const lastNode = ctx.ir[ctx.ir.length - 1];
    if (lastNode?.kind === "HostCallAsync" && ctx.nonSuspendableContext === undefined) {
      ctx.diagnostics.push(
        makeDiag(
          LoweringDiagCode.UnawaitedAsyncCall,
          `The result of async action \`${lastNode.fnName}\` is discarded. Add \`await\` to wait for it to complete.`,
          stmt.expression,
          "warning"
        )
      );
    }
    ctx.ir.push({ kind: "Pop" });
  } else if (ts.isVariableStatement(stmt)) {
    lowerVariableDeclarationList(stmt.declarationList, ctx);
  } else if (ts.isIfStatement(stmt)) {
    lowerIfStatement(stmt, ctx);
  } else if (ts.isWhileStatement(stmt)) {
    lowerWhileStatement(stmt, ctx);
  } else if (ts.isDoStatement(stmt)) {
    lowerDoWhileStatement(stmt, ctx);
  } else if (ts.isForStatement(stmt)) {
    lowerForStatement(stmt, ctx);
  } else if (ts.isForInStatement(stmt)) {
    lowerForInStatement(stmt, ctx);
  } else if (ts.isForOfStatement(stmt)) {
    lowerForOfStatement(stmt, ctx);
  } else if (ts.isSwitchStatement(stmt)) {
    lowerSwitchStatement(stmt, ctx);
  } else if (ts.isBlock(stmt)) {
    ctx.scopeStack.pushScope(ctx.ir.length);
    lowerStatements(stmt.statements, ctx);
    ctx.scopeStack.popScope(ctx.ir.length);
  } else if (ts.isBreakStatement(stmt)) {
    lowerBreakStatement(stmt, ctx);
  } else if (ts.isContinueStatement(stmt)) {
    lowerContinueStatement(stmt, ctx);
  } else if (stmt.kind === ts.SyntaxKind.EmptyStatement) {
    // no-op
  } else if (ts.isClassDeclaration(stmt)) {
    // no-op: class declarations are pre-processed in lowerProgram
  } else if (ts.isInterfaceDeclaration(stmt)) {
    // no-op: interface declarations are pre-processed in lowerProgram
  } else if (ts.isTypeAliasDeclaration(stmt)) {
    // no-op: type alias declarations are pre-processed in lowerProgram
  } else if (ts.isFunctionDeclaration(stmt)) {
    if (stmt.name && stmt.body && !ctx.hoistedFunctionNodes?.has(stmt)) {
      let localIdx = ctx.scopeStack.resolveLocal(stmt.name.text);
      if (localIdx === undefined) {
        localIdx = ctx.scopeStack.declareLocal(stmt.name.text);
      }
      lowerClosureExpression(stmt, ctx);
      ctx.ir.push({ kind: "StoreLocal", index: localIdx });
      ctx.scopeStack.setLocalIrStart(localIdx, ctx.ir.length);
    }
  } else {
    ctx.diagnostics.push(
      makeDiag(LoweringDiagCode.UnsupportedStatement, `Unsupported statement: ${ts.SyntaxKind[stmt.kind]}`, stmt)
    );
  }

  if (
    !ts.isBlock(stmt) &&
    stmt.kind !== ts.SyntaxKind.EmptyStatement &&
    !ts.isClassDeclaration(stmt) &&
    !ts.isInterfaceDeclaration(stmt) &&
    !ts.isTypeAliasDeclaration(stmt) &&
    !ts.isFunctionDeclaration(stmt)
  ) {
    annotateFirstNode(ctx.ir, irStart, stmt, true);
  }
}

function lowerVariableDeclarationList(declList: ts.VariableDeclarationList, ctx: LowerContext): void {
  for (const decl of declList.declarations) {
    if (ts.isIdentifier(decl.name)) {
      const localIdx = ctx.scopeStack.declareLocal(decl.name.text);
      if (decl.initializer) {
        lowerExpressionWithExpectedType(
          decl.initializer,
          resolveVariableDeclarationTargetTypeId(decl, ctx),
          `variable initializer for '${decl.name.text}'`,
          decl.initializer,
          ctx
        );
        checkStructAssignmentCompat(decl.name, decl.initializer, decl, ctx);
        ctx.ir.push({ kind: "StoreLocal", index: localIdx });
        ctx.scopeStack.setLocalIrStart(localIdx, ctx.ir.length);
      } else {
        ctx.scopeStack.setLocalIrStart(localIdx, ctx.ir.length);
      }
    } else if (ts.isObjectBindingPattern(decl.name)) {
      lowerObjectDestructuring(decl.name, decl, ctx);
    } else if (ts.isArrayBindingPattern(decl.name)) {
      lowerArrayDestructuring(decl.name, decl, ctx);
    } else {
      ctx.diagnostics.push(makeDiag(LoweringDiagCode.UnsupportedBindingPattern, "Unsupported binding pattern", decl));
    }
  }
}

function collectBindingNames(pattern: ts.BindingPattern): string[] {
  const names: string[] = [];
  for (const element of pattern.elements) {
    if (ts.isOmittedExpression(element)) continue;
    if (ts.isIdentifier(element.name)) {
      names.push(element.name.text);
    } else if (ts.isObjectBindingPattern(element.name) || ts.isArrayBindingPattern(element.name)) {
      names.push(...collectBindingNames(element.name));
    }
  }
  return names;
}

function lowerDestructuringDefault(element: ts.BindingElement, localIdx: number, ctx: LowerContext): void {
  if (!element.initializer) return;
  const keepLabel = allocLabel(ctx);
  const endLabel = allocLabel(ctx);
  ctx.ir.push({ kind: "LoadLocal", index: localIdx });
  // TypeCheck(Nil) matches only nil/undefined -- not false or 0 -- matching JS
  // semantics where defaults only apply when the value is absent, not just falsy.
  ctx.ir.push({ kind: "TypeCheck", nativeType: NativeType.Nil });
  // If value is NOT nil, jump past the default. Both labels land at the same
  // instruction: keepLabel skips the default-assignment, endLabel jumps past it
  // after assigning. They coincide because there is no extra code after the store.
  ctx.ir.push({ kind: "JumpIfFalse", labelId: keepLabel });
  lowerExpression(element.initializer, ctx);
  ctx.ir.push({ kind: "StoreLocal", index: localIdx });
  ctx.ir.push({ kind: "Jump", labelId: endLabel });
  ctx.ir.push({ kind: "Label", labelId: keepLabel });
  ctx.ir.push({ kind: "Label", labelId: endLabel });
}

function lowerObjectDestructuring(
  pattern: ts.ObjectBindingPattern,
  decl: ts.VariableDeclaration,
  ctx: LowerContext
): void {
  if (!decl.initializer) {
    ctx.diagnostics.push(
      makeDiag(
        LoweringDiagCode.DestructuringMissingInitializer,
        "Destructuring declaration must have an initializer",
        decl
      )
    );
    return;
  }
  const srcLocal = ctx.scopeStack.allocLocal();
  lowerExpression(decl.initializer, ctx);
  ctx.ir.push({ kind: "StoreLocal", index: srcLocal });
  lowerObjectBindingPattern(pattern, srcLocal, ctx);
}

function lowerObjectBindingPattern(pattern: ts.ObjectBindingPattern, srcLocal: number, ctx: LowerContext): void {
  const hasRest = pattern.elements.some((e) => e.dotDotDotToken);
  const computedKeyLocals = new Map<ts.BindingElement, number>();
  for (const element of pattern.elements) {
    if (element.dotDotDotToken) {
      if (element !== pattern.elements[pattern.elements.length - 1]) {
        ctx.diagnostics.push(
          makeDiag(LoweringDiagCode.RestElementMustBeLast, "Rest element must be last in object destructuring", element)
        );
        continue;
      }
      lowerObjectRestElement(element, pattern, srcLocal, computedKeyLocals, ctx);
      continue;
    }

    const isComputed = element.propertyName && ts.isComputedPropertyName(element.propertyName);

    if (isComputed) {
      let keyLocal: number | undefined;
      if (hasRest) {
        keyLocal = ctx.scopeStack.allocLocal();
        lowerExpression(element.propertyName!.expression, ctx);
        ctx.ir.push({ kind: "StoreLocal", index: keyLocal });
        computedKeyLocals.set(element, keyLocal);
      }

      if (ts.isIdentifier(element.name)) {
        const localIdx = ctx.scopeStack.declareLocal(element.name.text);
        ctx.ir.push({ kind: "LoadLocal", index: srcLocal });
        if (keyLocal !== undefined) {
          ctx.ir.push({ kind: "LoadLocal", index: keyLocal });
        } else {
          lowerExpression(element.propertyName!.expression, ctx);
        }
        ctx.ir.push({ kind: "GetFieldDynamic" });
        ctx.ir.push({ kind: "StoreLocal", index: localIdx });
        lowerDestructuringDefault(element, localIdx, ctx);
      } else if (ts.isObjectBindingPattern(element.name) || ts.isArrayBindingPattern(element.name)) {
        const tempLocal = ctx.scopeStack.allocLocal();
        ctx.ir.push({ kind: "LoadLocal", index: srcLocal });
        if (keyLocal !== undefined) {
          ctx.ir.push({ kind: "LoadLocal", index: keyLocal });
        } else {
          lowerExpression(element.propertyName!.expression, ctx);
        }
        ctx.ir.push({ kind: "GetFieldDynamic" });
        ctx.ir.push({ kind: "StoreLocal", index: tempLocal });
        lowerDestructuringDefault(element, tempLocal, ctx);
        if (ts.isObjectBindingPattern(element.name)) {
          lowerObjectBindingPattern(element.name, tempLocal, ctx);
        } else {
          lowerArrayBindingPattern(element.name, tempLocal, ctx);
        }
      }
      continue;
    }

    let propertyName: string;
    if (element.propertyName) {
      if (!ts.isIdentifier(element.propertyName)) {
        ctx.diagnostics.push(
          makeDiag(LoweringDiagCode.UnsupportedBindingPattern, "Unsupported binding pattern", element)
        );
        continue;
      }
      propertyName = element.propertyName.text;
    } else if (ts.isIdentifier(element.name)) {
      propertyName = element.name.text;
    } else {
      ctx.diagnostics.push(
        makeDiag(LoweringDiagCode.UnsupportedBindingPattern, "Unsupported binding pattern", element)
      );
      continue;
    }

    if (ts.isIdentifier(element.name)) {
      const localIdx = ctx.scopeStack.declareLocal(element.name.text);
      ctx.ir.push({ kind: "LoadLocal", index: srcLocal });
      ctx.ir.push({ kind: "GetField", fieldName: propertyName });
      ctx.ir.push({ kind: "StoreLocal", index: localIdx });
      lowerDestructuringDefault(element, localIdx, ctx);
    } else if (ts.isObjectBindingPattern(element.name) || ts.isArrayBindingPattern(element.name)) {
      const tempLocal = ctx.scopeStack.allocLocal();
      ctx.ir.push({ kind: "LoadLocal", index: srcLocal });
      ctx.ir.push({ kind: "GetField", fieldName: propertyName });
      ctx.ir.push({ kind: "StoreLocal", index: tempLocal });
      lowerDestructuringDefault(element, tempLocal, ctx);
      if (ts.isObjectBindingPattern(element.name)) {
        lowerObjectBindingPattern(element.name, tempLocal, ctx);
      } else {
        lowerArrayBindingPattern(element.name, tempLocal, ctx);
      }
    }
  }
}

function lowerObjectRestElement(
  element: ts.BindingElement,
  pattern: ts.ObjectBindingPattern,
  srcLocal: number,
  computedKeyLocals: Map<ts.BindingElement, number>,
  ctx: LowerContext
): void {
  const restType = ctx.checker.getTypeAtLocation(element.name);
  const typeId = tsTypeToTypeId(restType, ctx.checker, ctx.services, ctx.projectNamespace);

  let hasComputedKeys = false;
  for (const other of pattern.elements) {
    if (other !== element && computedKeyLocals.has(other)) {
      hasComputedKeys = true;
    }
  }
  const restDef = typeId === undefined ? undefined : ctx.services.runtime.types.get(typeId);
  const restStruct =
    restDef !== undefined && restDef.coreType === NativeType.Struct ? (restDef as StructTypeDef) : undefined;
  const sourceTypeId = tsTypeToTypeId(
    ctx.checker.getTypeAtLocation(pattern),
    ctx.checker,
    ctx.services,
    ctx.projectNamespace
  );
  const sourceDef = sourceTypeId === undefined ? undefined : ctx.services.runtime.types.get(sourceTypeId);
  const sourceStruct =
    sourceDef !== undefined && sourceDef.coreType === NativeType.Struct ? (sourceDef as StructTypeDef) : undefined;

  if (!hasComputedKeys && (restStruct !== undefined || sourceStruct !== undefined)) {
    lowerStaticRestCopy(restStruct, sourceStruct, element, pattern, srcLocal, ctx);
  } else {
    // Dynamic fallback: the excluded keys (or the rest type itself) are only
    // known at runtime, so the copy stays name-keyed via STRUCT_COPY_EXCEPT.
    ctx.ir.push({ kind: "LoadLocal", index: srcLocal });

    let numExclude = 0;
    for (const other of pattern.elements) {
      if (other === element) continue;
      const computedKeyLocal = computedKeyLocals.get(other);
      if (computedKeyLocal !== undefined) {
        ctx.ir.push({ kind: "LoadLocal", index: computedKeyLocal });
        numExclude++;
      } else if (other.propertyName && ts.isIdentifier(other.propertyName)) {
        ctx.ir.push({ kind: "PushConst", value: mkStringValue(other.propertyName.text) });
        numExclude++;
      } else if (ts.isIdentifier(other.name)) {
        ctx.ir.push({ kind: "PushConst", value: mkStringValue(other.name.text) });
        numExclude++;
      }
    }
    ctx.ir.push({ kind: "StructCopyExcept", numExclude, typeId });
  }

  if (ts.isIdentifier(element.name)) {
    const localIdx = ctx.scopeStack.declareLocal(element.name.text);
    ctx.ir.push({ kind: "StoreLocal", index: localIdx });
  } else if (ts.isObjectBindingPattern(element.name)) {
    const tempLocal = ctx.scopeStack.allocLocal();
    ctx.ir.push({ kind: "StoreLocal", index: tempLocal });
    lowerObjectBindingPattern(element.name, tempLocal, ctx);
  } else if (ts.isArrayBindingPattern(element.name)) {
    const tempLocal = ctx.scopeStack.allocLocal();
    ctx.ir.push({ kind: "StoreLocal", index: tempLocal });
    lowerArrayBindingPattern(element.name, tempLocal, ctx);
  }
}

/**
 * Build a statically-keyed rest struct by field id: construct the result
 * type, then copy each kept field from the source by id. The result type is
 * the resolved rest type when the checker produced one, else the source type
 * (matching the dynamic fallback's typing, with excluded fields left unset).
 * Leaves the rest struct on the stack.
 */
function lowerStaticRestCopy(
  restStruct: StructTypeDef | undefined,
  sourceStruct: StructTypeDef | undefined,
  element: ts.BindingElement,
  pattern: ts.ObjectBindingPattern,
  srcLocal: number,
  ctx: LowerContext
): void {
  const excluded = new Set<string>();
  for (const other of pattern.elements) {
    if (other === element) continue;
    if (other.propertyName && ts.isIdentifier(other.propertyName)) {
      excluded.add(other.propertyName.text);
    } else if (ts.isIdentifier(other.name)) {
      excluded.add(other.name.text);
    }
  }

  const resultStruct = restStruct ?? (sourceStruct as StructTypeDef);
  const copied = (restStruct ?? sourceStruct ?? resultStruct).fields;

  ctx.ir.push({ kind: "StructNew", typeId: resultStruct.typeId });
  copied.forEach((field) => {
    if (restStruct === undefined && excluded.has(field.name)) return;
    const dstFieldIndex = resultStruct.fieldIndexByName.get(field.name);
    if (dstFieldIndex === undefined) return;
    const srcFieldIndex = sourceStruct?.fieldIndexByName.get(field.name);
    ctx.ir.push({ kind: "LoadLocal", index: srcLocal });
    if (srcFieldIndex !== undefined) {
      ctx.ir.push({ kind: "GetField", fieldName: field.name, fieldIndex: srcFieldIndex });
    } else {
      ctx.ir.push({ kind: "GetField", fieldName: field.name });
    }
    ctx.ir.push({ kind: "StructSet", fieldIndex: dstFieldIndex });
  });
}

function lowerArrayDestructuring(
  pattern: ts.ArrayBindingPattern,
  decl: ts.VariableDeclaration,
  ctx: LowerContext
): void {
  if (!decl.initializer) {
    ctx.diagnostics.push(
      makeDiag(
        LoweringDiagCode.DestructuringMissingInitializer,
        "Destructuring declaration must have an initializer",
        decl
      )
    );
    return;
  }
  const srcLocal = ctx.scopeStack.allocLocal();
  lowerExpression(decl.initializer, ctx);
  ctx.ir.push({ kind: "StoreLocal", index: srcLocal });
  lowerArrayBindingPattern(pattern, srcLocal, ctx);
}

function lowerArrayBindingPattern(pattern: ts.ArrayBindingPattern, srcLocal: number, ctx: LowerContext): void {
  for (let i = 0; i < pattern.elements.length; i++) {
    const element = pattern.elements[i];
    if (ts.isOmittedExpression(element)) continue;
    if (element.dotDotDotToken) {
      if (i !== pattern.elements.length - 1) {
        ctx.diagnostics.push(
          makeDiag(LoweringDiagCode.RestElementMustBeLast, "Rest element must be last in array destructuring", element)
        );
        continue;
      }
      lowerArrayRestElement(element, i, srcLocal, ctx);
      continue;
    }

    if (ts.isIdentifier(element.name)) {
      const localIdx = ctx.scopeStack.declareLocal(element.name.text);
      ctx.ir.push({ kind: "LoadLocal", index: srcLocal });
      ctx.ir.push({ kind: "PushConst", value: mkNumberValue(i) });
      ctx.ir.push({ kind: "ListGet" });
      ctx.ir.push({ kind: "StoreLocal", index: localIdx });
      lowerDestructuringDefault(element, localIdx, ctx);
    } else if (ts.isObjectBindingPattern(element.name) || ts.isArrayBindingPattern(element.name)) {
      const tempLocal = ctx.scopeStack.allocLocal();
      ctx.ir.push({ kind: "LoadLocal", index: srcLocal });
      ctx.ir.push({ kind: "PushConst", value: mkNumberValue(i) });
      ctx.ir.push({ kind: "ListGet" });
      ctx.ir.push({ kind: "StoreLocal", index: tempLocal });
      lowerDestructuringDefault(element, tempLocal, ctx);
      if (ts.isObjectBindingPattern(element.name)) {
        lowerObjectBindingPattern(element.name, tempLocal, ctx);
      } else {
        lowerArrayBindingPattern(element.name, tempLocal, ctx);
      }
    }
  }
}

function lowerArrayRestElement(
  element: ts.BindingElement,
  restIndex: number,
  srcLocal: number,
  ctx: LowerContext
): void {
  const restType = ctx.checker.getTypeAtLocation(element.name);
  let listTypeId = tsTypeToTypeId(restType, ctx.checker, ctx.services, ctx.projectNamespace);
  if (!listTypeId) {
    const srcType = ctx.checker.getTypeAtLocation(element.parent);
    listTypeId = tsTypeToTypeId(srcType, ctx.checker, ctx.services, ctx.projectNamespace) ?? "list:any";
  }

  const ltFn = resolveOperator(CoreOpId.LessThan, [CoreTypeIds.Number, CoreTypeIds.Number], ctx.services);
  if (!ltFn) {
    ctx.diagnostics.push(
      makeDiag(LoweringDiagCode.ForOfCannotResolveOperator, "Cannot resolve < operator for rest pattern", element)
    );
    return;
  }
  const addFn = resolveOperator(CoreOpId.Add, [CoreTypeIds.Number, CoreTypeIds.Number], ctx.services);
  if (!addFn) {
    ctx.diagnostics.push(
      makeDiag(LoweringDiagCode.ForOfCannotResolveOperator, "Cannot resolve + operator for rest pattern", element)
    );
    return;
  }

  const resultLocal = ctx.scopeStack.allocLocal();
  const idxLocal = ctx.scopeStack.allocLocal();
  const endLocal = ctx.scopeStack.allocLocal();
  const loopStart = allocLabel(ctx);
  const loopEnd = allocLabel(ctx);

  ctx.ir.push({ kind: "ListNew", typeId: listTypeId });
  ctx.ir.push({ kind: "StoreLocal", index: resultLocal });

  ctx.ir.push({ kind: "PushConst", value: mkNumberValue(restIndex) });
  ctx.ir.push({ kind: "StoreLocal", index: idxLocal });

  ctx.ir.push({ kind: "LoadLocal", index: srcLocal });
  ctx.ir.push({ kind: "ListLen" });
  ctx.ir.push({ kind: "StoreLocal", index: endLocal });

  ctx.ir.push({ kind: "Label", labelId: loopStart });

  ctx.ir.push({ kind: "LoadLocal", index: idxLocal });
  ctx.ir.push({ kind: "LoadLocal", index: endLocal });
  ctx.ir.push({ kind: "HostCall", fnName: ltFn, argc: 2 });
  ctx.ir.push({ kind: "JumpIfFalse", labelId: loopEnd });

  ctx.ir.push({ kind: "LoadLocal", index: resultLocal });
  ctx.ir.push({ kind: "LoadLocal", index: srcLocal });
  ctx.ir.push({ kind: "LoadLocal", index: idxLocal });
  ctx.ir.push({ kind: "ListGet" });
  ctx.ir.push({ kind: "ListPush" });
  ctx.ir.push({ kind: "StoreLocal", index: resultLocal });

  ctx.ir.push({ kind: "LoadLocal", index: idxLocal });
  ctx.ir.push({ kind: "PushConst", value: mkNumberValue(1) });
  ctx.ir.push({ kind: "HostCall", fnName: addFn, argc: 2 });
  ctx.ir.push({ kind: "StoreLocal", index: idxLocal });
  ctx.ir.push({ kind: "Jump", labelId: loopStart });

  ctx.ir.push({ kind: "Label", labelId: loopEnd });

  if (ts.isIdentifier(element.name)) {
    const localIdx = ctx.scopeStack.declareLocal(element.name.text);
    ctx.ir.push({ kind: "LoadLocal", index: resultLocal });
    ctx.ir.push({ kind: "StoreLocal", index: localIdx });
  } else if (ts.isObjectBindingPattern(element.name) || ts.isArrayBindingPattern(element.name)) {
    if (ts.isObjectBindingPattern(element.name)) {
      lowerObjectBindingPattern(element.name, resultLocal, ctx);
    } else {
      lowerArrayBindingPattern(element.name, resultLocal, ctx);
    }
  }
}

function lowerIfStatement(stmt: ts.IfStatement, ctx: LowerContext): void {
  lowerCondition(stmt.expression, ctx);

  if (stmt.elseStatement) {
    const elseLabel = allocLabel(ctx);
    const endLabel = allocLabel(ctx);

    ctx.ir.push({ kind: "JumpIfFalse", labelId: elseLabel });
    lowerStatement(stmt.thenStatement, ctx);
    ctx.ir.push({ kind: "Jump", labelId: endLabel });
    ctx.ir.push({ kind: "Label", labelId: elseLabel });
    lowerStatement(stmt.elseStatement, ctx);
    ctx.ir.push({ kind: "Label", labelId: endLabel });
  } else {
    const endLabel = allocLabel(ctx);

    ctx.ir.push({ kind: "JumpIfFalse", labelId: endLabel });
    lowerStatement(stmt.thenStatement, ctx);
    ctx.ir.push({ kind: "Label", labelId: endLabel });
  }
}

function lowerWhileStatement(stmt: ts.WhileStatement, ctx: LowerContext): void {
  const loopStart = allocLabel(ctx);
  const loopEnd = allocLabel(ctx);

  pushLoopContext(loopStart, loopEnd, ctx);

  ctx.ir.push({ kind: "Label", labelId: loopStart });
  const condStart = ctx.ir.length;
  lowerCondition(stmt.expression, ctx);
  annotateFirstNode(ctx.ir, condStart, stmt.expression, true);
  ctx.ir.push({ kind: "JumpIfFalse", labelId: loopEnd });
  lowerStatement(stmt.statement, ctx);
  ctx.ir.push({ kind: "Jump", labelId: loopStart });
  ctx.ir.push({ kind: "Label", labelId: loopEnd });

  popLoopContext(ctx);
}

function lowerDoWhileStatement(stmt: ts.DoStatement, ctx: LowerContext): void {
  const loopStart = allocLabel(ctx);
  const continueTarget = allocLabel(ctx);
  const loopEnd = allocLabel(ctx);

  pushLoopContext(continueTarget, loopEnd, ctx);

  ctx.ir.push({ kind: "Label", labelId: loopStart });
  lowerStatement(stmt.statement, ctx);
  ctx.ir.push({ kind: "Label", labelId: continueTarget });
  const condStart = ctx.ir.length;
  lowerCondition(stmt.expression, ctx);
  annotateFirstNode(ctx.ir, condStart, stmt.expression, true);
  ctx.ir.push({ kind: "JumpIfTrue", labelId: loopStart });
  ctx.ir.push({ kind: "Label", labelId: loopEnd });

  popLoopContext(ctx);
}

function lowerForStatement(stmt: ts.ForStatement, ctx: LowerContext): void {
  ctx.scopeStack.pushScope(ctx.ir.length);

  if (stmt.initializer) {
    if (ts.isVariableDeclarationList(stmt.initializer)) {
      lowerVariableDeclarationList(stmt.initializer, ctx);
    } else {
      lowerExpression(stmt.initializer, ctx);
      ctx.ir.push({ kind: "Pop" });
    }
  }

  const loopStart = allocLabel(ctx);
  const continueTarget = allocLabel(ctx);
  const loopEnd = allocLabel(ctx);

  pushLoopContext(continueTarget, loopEnd, ctx);

  ctx.ir.push({ kind: "Label", labelId: loopStart });

  if (stmt.condition) {
    const condStart = ctx.ir.length;
    lowerCondition(stmt.condition, ctx);
    annotateFirstNode(ctx.ir, condStart, stmt.condition, true);
    ctx.ir.push({ kind: "JumpIfFalse", labelId: loopEnd });
  }

  lowerStatement(stmt.statement, ctx);

  ctx.ir.push({ kind: "Label", labelId: continueTarget });

  if (stmt.incrementor) {
    lowerExpression(stmt.incrementor, ctx);
    ctx.ir.push({ kind: "Pop" });
  }

  ctx.ir.push({ kind: "Jump", labelId: loopStart });
  ctx.ir.push({ kind: "Label", labelId: loopEnd });

  popLoopContext(ctx);
  ctx.scopeStack.popScope(ctx.ir.length);
}

function lowerForInStatement(stmt: ts.ForInStatement, ctx: LowerContext): void {
  ctx.scopeStack.pushScope(ctx.ir.length);

  if (!ts.isVariableDeclarationList(stmt.initializer)) {
    ctx.diagnostics.push(
      makeDiag(
        LoweringDiagCode.ForInRequiresVariableDeclaration,
        "`for...in` requires a variable declaration (e.g. `const key in obj`)",
        stmt
      )
    );
    ctx.scopeStack.popScope(ctx.ir.length);
    return;
  }

  const decls = stmt.initializer.declarations;
  if (decls.length !== 1 || !ts.isIdentifier(decls[0].name)) {
    ctx.diagnostics.push(
      makeDiag(LoweringDiagCode.ForInRequiresSingleIdentifier, "`for...in` requires a single identifier binding", stmt)
    );
    ctx.scopeStack.popScope(ctx.ir.length);
    return;
  }

  const bindingName = decls[0].name.text;
  const iteratedType = ctx.checker.getTypeAtLocation(stmt.expression);

  if (resolveListTypeId(iteratedType, ctx)) {
    lowerForInOverList(stmt, bindingName, ctx);
    ctx.scopeStack.popScope(ctx.ir.length);
    return;
  }

  const mapTypeId = resolveMapTypeId(iteratedType, ctx);
  if (mapTypeId) {
    lowerForInOverKeyList(
      stmt,
      bindingName,
      () => {
        lowerExpression(stmt.expression, ctx);
        ctx.ir.push({ kind: "HostCall", fnName: "$$map_keys", argc: 1 });
      },
      ctx
    );
    ctx.scopeStack.popScope(ctx.ir.length);
    return;
  }

  const structDef = resolveStructType(iteratedType, ctx.services, ctx.projectNamespace, ctx.checker);
  if (structDef) {
    lowerForInOverKeyList(
      stmt,
      bindingName,
      () => {
        const keyListTypeId = ctx.services.runtime.types.instantiate("List", List.from([CoreTypeIds.String]));
        ctx.ir.push({ kind: "ListNew", typeId: keyListTypeId });
        for (const field of structDef.fields.toArray()) {
          ctx.ir.push({ kind: "PushConst", value: mkStringValue(field.name) });
          ctx.ir.push({ kind: "ListPush" });
        }
      },
      ctx
    );
    ctx.scopeStack.popScope(ctx.ir.length);
    return;
  }

  ctx.diagnostics.push(
    makeDiag(
      LoweringDiagCode.ForInOnUnsupportedType,
      "`for...in` is only supported on list, map, and registered struct values",
      stmt.expression
    )
  );
  ctx.scopeStack.popScope(ctx.ir.length);
}

function lowerForInOverList(stmt: ts.ForInStatement, bindingName: string, ctx: LowerContext): void {
  const listLocal = ctx.scopeStack.allocLocal();
  const indexLocal = ctx.scopeStack.allocLocal();
  const bindingLocal = ctx.scopeStack.declareLocal(bindingName);

  lowerExpression(stmt.expression, ctx);
  ctx.ir.push({ kind: "StoreLocal", index: listLocal });

  ctx.ir.push({ kind: "PushConst", value: mkNumberValue(0) });
  ctx.ir.push({ kind: "StoreLocal", index: indexLocal });

  const loopStart = allocLabel(ctx);
  const continueTarget = allocLabel(ctx);
  const loopEnd = allocLabel(ctx);

  pushLoopContext(continueTarget, loopEnd, ctx);

  ctx.ir.push({ kind: "Label", labelId: loopStart });

  ctx.ir.push({ kind: "LoadLocal", index: indexLocal });
  ctx.ir.push({ kind: "LoadLocal", index: listLocal });
  ctx.ir.push({ kind: "ListLen" });
  const ltFn = resolveOperator(CoreOpId.LessThan, [CoreTypeIds.Number, CoreTypeIds.Number], ctx.services);
  if (!ltFn) {
    ctx.diagnostics.push(
      makeDiag(LoweringDiagCode.ForInCannotResolveOperator, "Cannot resolve < operator for `for...in`", stmt)
    );
    popLoopContext(ctx);
    return;
  }
  ctx.ir.push({ kind: "HostCall", fnName: ltFn, argc: 2 });
  ctx.ir.push({ kind: "JumpIfFalse", labelId: loopEnd });

  ctx.ir.push({ kind: "LoadLocal", index: indexLocal });
  ctx.ir.push({
    kind: "HostCall",
    fnName: conversionFnName(CoreTypeIds.Number, CoreTypeIds.String),
    argc: 1,
  });
  ctx.ir.push({ kind: "StoreLocal", index: bindingLocal });
  ctx.scopeStack.setLocalIrStart(bindingLocal, ctx.ir.length);

  lowerStatement(stmt.statement, ctx);

  ctx.ir.push({ kind: "Label", labelId: continueTarget });

  ctx.ir.push({ kind: "LoadLocal", index: indexLocal });
  ctx.ir.push({ kind: "PushConst", value: mkNumberValue(1) });
  const addFn = resolveOperator(CoreOpId.Add, [CoreTypeIds.Number, CoreTypeIds.Number], ctx.services);
  if (!addFn) {
    ctx.diagnostics.push(
      makeDiag(LoweringDiagCode.ForInCannotResolveOperator, "Cannot resolve + operator for `for...in`", stmt)
    );
    popLoopContext(ctx);
    return;
  }
  ctx.ir.push({ kind: "HostCall", fnName: addFn, argc: 2 });
  ctx.ir.push({ kind: "StoreLocal", index: indexLocal });

  ctx.ir.push({ kind: "Jump", labelId: loopStart });
  ctx.ir.push({ kind: "Label", labelId: loopEnd });

  popLoopContext(ctx);
}

function lowerForInOverKeyList(
  stmt: ts.ForInStatement,
  bindingName: string,
  emitKeyList: () => void,
  ctx: LowerContext
): void {
  const keyListLocal = ctx.scopeStack.allocLocal();
  const indexLocal = ctx.scopeStack.allocLocal();
  const bindingLocal = ctx.scopeStack.declareLocal(bindingName);

  emitKeyList();
  ctx.ir.push({ kind: "StoreLocal", index: keyListLocal });

  ctx.ir.push({ kind: "PushConst", value: mkNumberValue(0) });
  ctx.ir.push({ kind: "StoreLocal", index: indexLocal });

  const loopStart = allocLabel(ctx);
  const continueTarget = allocLabel(ctx);
  const loopEnd = allocLabel(ctx);

  pushLoopContext(continueTarget, loopEnd, ctx);

  ctx.ir.push({ kind: "Label", labelId: loopStart });

  ctx.ir.push({ kind: "LoadLocal", index: indexLocal });
  ctx.ir.push({ kind: "LoadLocal", index: keyListLocal });
  ctx.ir.push({ kind: "ListLen" });
  const ltFn = resolveOperator(CoreOpId.LessThan, [CoreTypeIds.Number, CoreTypeIds.Number], ctx.services);
  if (!ltFn) {
    ctx.diagnostics.push(
      makeDiag(LoweringDiagCode.ForInCannotResolveOperator, "Cannot resolve < operator for `for...in`", stmt)
    );
    popLoopContext(ctx);
    return;
  }
  ctx.ir.push({ kind: "HostCall", fnName: ltFn, argc: 2 });
  ctx.ir.push({ kind: "JumpIfFalse", labelId: loopEnd });

  ctx.ir.push({ kind: "LoadLocal", index: keyListLocal });
  ctx.ir.push({ kind: "LoadLocal", index: indexLocal });
  ctx.ir.push({ kind: "ListGet" });
  ctx.ir.push({ kind: "StoreLocal", index: bindingLocal });
  ctx.scopeStack.setLocalIrStart(bindingLocal, ctx.ir.length);

  lowerStatement(stmt.statement, ctx);

  ctx.ir.push({ kind: "Label", labelId: continueTarget });

  ctx.ir.push({ kind: "LoadLocal", index: indexLocal });
  ctx.ir.push({ kind: "PushConst", value: mkNumberValue(1) });
  const addFn = resolveOperator(CoreOpId.Add, [CoreTypeIds.Number, CoreTypeIds.Number], ctx.services);
  if (!addFn) {
    ctx.diagnostics.push(
      makeDiag(LoweringDiagCode.ForInCannotResolveOperator, "Cannot resolve + operator for `for...in`", stmt)
    );
    popLoopContext(ctx);
    return;
  }
  ctx.ir.push({ kind: "HostCall", fnName: addFn, argc: 2 });
  ctx.ir.push({ kind: "StoreLocal", index: indexLocal });

  ctx.ir.push({ kind: "Jump", labelId: loopStart });
  ctx.ir.push({ kind: "Label", labelId: loopEnd });

  popLoopContext(ctx);
}

function lowerForOfStatement(stmt: ts.ForOfStatement, ctx: LowerContext): void {
  ctx.scopeStack.pushScope(ctx.ir.length);

  const iterableType = ctx.checker.getTypeAtLocation(stmt.expression);
  const listTypeId = resolveListTypeId(iterableType, ctx);
  if (!listTypeId) {
    ctx.diagnostics.push(
      makeDiag(
        LoweringDiagCode.ForOfOnNonListType,
        "`for...of` is only supported on list-typed values",
        stmt.expression
      )
    );
    ctx.scopeStack.popScope(ctx.ir.length);
    return;
  }

  if (!ts.isVariableDeclarationList(stmt.initializer)) {
    ctx.diagnostics.push(
      makeDiag(
        LoweringDiagCode.ForOfRequiresVariableDeclaration,
        "`for...of` requires a variable declaration (e.g. `const x of list`)",
        stmt
      )
    );
    ctx.scopeStack.popScope(ctx.ir.length);
    return;
  }

  const decls = stmt.initializer.declarations;
  if (decls.length !== 1 || !ts.isIdentifier(decls[0].name)) {
    ctx.diagnostics.push(
      makeDiag(LoweringDiagCode.ForOfRequiresSingleIdentifier, "`for...of` requires a single identifier binding", stmt)
    );
    ctx.scopeStack.popScope(ctx.ir.length);
    return;
  }

  const listLocal = ctx.scopeStack.allocLocal();
  const indexLocal = ctx.scopeStack.allocLocal();

  lowerExpression(stmt.expression, ctx);
  ctx.ir.push({ kind: "StoreLocal", index: listLocal });

  ctx.ir.push({ kind: "PushConst", value: mkNumberValue(0) });
  ctx.ir.push({ kind: "StoreLocal", index: indexLocal });

  const loopStart = allocLabel(ctx);
  const continueTarget = allocLabel(ctx);
  const loopEnd = allocLabel(ctx);

  pushLoopContext(continueTarget, loopEnd, ctx);

  ctx.ir.push({ kind: "Label", labelId: loopStart });

  ctx.ir.push({ kind: "LoadLocal", index: indexLocal });
  ctx.ir.push({ kind: "LoadLocal", index: listLocal });
  ctx.ir.push({ kind: "ListLen" });
  const ltFn = resolveOperator(CoreOpId.LessThan, [CoreTypeIds.Number, CoreTypeIds.Number], ctx.services);
  if (!ltFn) {
    ctx.diagnostics.push(
      makeDiag(LoweringDiagCode.ForOfCannotResolveOperator, "Cannot resolve < operator for `for...of`", stmt)
    );
    popLoopContext(ctx);
    ctx.scopeStack.popScope(ctx.ir.length);
    return;
  }
  ctx.ir.push({ kind: "HostCall", fnName: ltFn, argc: 2 });
  ctx.ir.push({ kind: "JumpIfFalse", labelId: loopEnd });

  ctx.ir.push({ kind: "LoadLocal", index: listLocal });
  ctx.ir.push({ kind: "LoadLocal", index: indexLocal });
  ctx.ir.push({ kind: "ListGet" });
  const itemLocal = ctx.scopeStack.declareLocal(decls[0].name.text);
  ctx.ir.push({ kind: "StoreLocal", index: itemLocal });
  ctx.scopeStack.setLocalIrStart(itemLocal, ctx.ir.length);

  lowerStatement(stmt.statement, ctx);

  ctx.ir.push({ kind: "Label", labelId: continueTarget });

  ctx.ir.push({ kind: "LoadLocal", index: indexLocal });
  ctx.ir.push({ kind: "PushConst", value: mkNumberValue(1) });
  const addFn = resolveOperator(CoreOpId.Add, [CoreTypeIds.Number, CoreTypeIds.Number], ctx.services);
  if (!addFn) {
    ctx.diagnostics.push(
      makeDiag(LoweringDiagCode.ForOfCannotResolveOperator, "Cannot resolve + operator for `for...of`", stmt)
    );
    popLoopContext(ctx);
    ctx.scopeStack.popScope(ctx.ir.length);
    return;
  }
  ctx.ir.push({ kind: "HostCall", fnName: addFn, argc: 2 });
  ctx.ir.push({ kind: "StoreLocal", index: indexLocal });

  ctx.ir.push({ kind: "Jump", labelId: loopStart });
  ctx.ir.push({ kind: "Label", labelId: loopEnd });

  popLoopContext(ctx);
  ctx.scopeStack.popScope(ctx.ir.length);
}

function lowerSwitchStatement(stmt: ts.SwitchStatement, ctx: LowerContext): void {
  ctx.scopeStack.pushScope(ctx.ir.length);

  const discriminantLocal = ctx.scopeStack.allocLocal();
  const endLabel = allocLabel(ctx);
  const clauseLabels = stmt.caseBlock.clauses.map(() => allocLabel(ctx));
  let defaultClauseIndex = -1;

  const discriminantStart = ctx.ir.length;
  lowerExpression(stmt.expression, ctx);
  ctx.ir.push({ kind: "StoreLocal", index: discriminantLocal });
  annotateFirstNode(ctx.ir, discriminantStart, stmt.expression, true);

  ctx.breakStack.push(endLabel);

  for (let i = 0; i < stmt.caseBlock.clauses.length; i++) {
    const clause = stmt.caseBlock.clauses[i];
    if (ts.isDefaultClause(clause)) {
      defaultClauseIndex = i;
      continue;
    }

    ctx.ir.push({ kind: "LoadLocal", index: discriminantLocal });
    lowerExpression(clause.expression, ctx);

    if (!emitBinaryOperatorForNodes(CoreOpId.EqualTo, stmt.expression, clause.expression, clause.expression, ctx)) {
      ctx.breakStack.pop();
      ctx.scopeStack.popScope(ctx.ir.length);
      return;
    }

    ctx.ir.push({ kind: "JumpIfTrue", labelId: clauseLabels[i] });
  }

  if (defaultClauseIndex >= 0) {
    ctx.ir.push({ kind: "Jump", labelId: clauseLabels[defaultClauseIndex] });
  } else {
    ctx.ir.push({ kind: "Jump", labelId: endLabel });
  }

  for (let i = 0; i < stmt.caseBlock.clauses.length; i++) {
    const clause = stmt.caseBlock.clauses[i];
    ctx.ir.push({ kind: "Label", labelId: clauseLabels[i] });
    lowerStatements(clause.statements, ctx);
  }

  ctx.ir.push({ kind: "Label", labelId: endLabel });

  ctx.breakStack.pop();
  ctx.scopeStack.popScope(ctx.ir.length);
}

function lowerBreakStatement(stmt: ts.BreakStatement, ctx: LowerContext): void {
  if (ctx.breakStack.length === 0) {
    ctx.diagnostics.push(makeDiag(LoweringDiagCode.BreakOutsideLoop, "`break` outside of loop or switch", stmt));
    return;
  }
  const breakLabel = ctx.breakStack[ctx.breakStack.length - 1];
  ctx.ir.push({ kind: "Jump", labelId: breakLabel });
}

function lowerContinueStatement(stmt: ts.ContinueStatement, ctx: LowerContext): void {
  if (ctx.loopStack.length === 0) {
    ctx.diagnostics.push(makeDiag(LoweringDiagCode.ContinueOutsideLoop, "`continue` outside of loop", stmt));
    return;
  }
  const loop = ctx.loopStack[ctx.loopStack.length - 1];
  ctx.ir.push({ kind: "Jump", labelId: loop.continueLabel });
}

function lowerExpression(expr: ts.Expression, ctx: LowerContext): void {
  const irStart = ctx.ir.length;

  if (ctx.optionalChainSubstitution?.targetExpr === expr) {
    ctx.ir.push({ kind: "LoadLocal", index: ctx.optionalChainSubstitution.localIndex });
    annotateFirstNode(ctx.ir, irStart, expr, false);
    return;
  }

  if (ts.isNumericLiteral(expr)) {
    ctx.ir.push({ kind: "PushConst", value: mkNumberValue(Number(expr.text)) });
  } else if (expr.kind === ts.SyntaxKind.TrueKeyword) {
    ctx.ir.push({ kind: "PushConst", value: TRUE_VALUE });
  } else if (expr.kind === ts.SyntaxKind.FalseKeyword) {
    ctx.ir.push({ kind: "PushConst", value: FALSE_VALUE });
  } else if (expr.kind === ts.SyntaxKind.NullKeyword) {
    ctx.ir.push({ kind: "PushConst", value: NIL_VALUE });
  } else if (ts.isStringLiteral(expr)) {
    const enumValue = tryResolveEnumValue(expr, ctx);
    ctx.ir.push({ kind: "PushConst", value: enumValue ?? mkStringValue(expr.text) });
  } else if (ts.isNoSubstitutionTemplateLiteral(expr)) {
    ctx.ir.push({ kind: "PushConst", value: mkStringValue(expr.text) });
  } else if (ts.isTemplateExpression(expr)) {
    lowerTemplateLiteral(expr, ctx);
  } else if (ts.isBinaryExpression(expr)) {
    if (isAssignmentOperator(expr.operatorToken.kind)) {
      lowerAssignment(expr, ctx);
    } else {
      lowerBinaryExpression(expr, ctx);
    }
  } else if (ts.isPropertyAccessExpression(expr)) {
    lowerPropertyAccess(expr, ctx);
  } else if (ts.isParenthesizedExpression(expr)) {
    lowerExpression(expr.expression, ctx);
  } else if (ts.isPrefixUnaryExpression(expr)) {
    lowerPrefixUnary(expr, ctx);
  } else if (ts.isPostfixUnaryExpression(expr)) {
    lowerPostfixIncDec(expr, ctx);
  } else if (ts.isCallExpression(expr)) {
    lowerCallExpression(expr, ctx);
  } else if (ts.isIdentifier(expr)) {
    lowerIdentifier(expr, ctx);
  } else if (ts.isObjectLiteralExpression(expr)) {
    lowerObjectLiteral(expr, ctx);
  } else if (ts.isArrayLiteralExpression(expr)) {
    lowerArrayLiteral(expr, ctx);
  } else if (ts.isElementAccessExpression(expr)) {
    lowerElementAccess(expr, ctx);
  } else if (ts.isArrowFunction(expr)) {
    lowerClosureExpression(expr, ctx);
  } else if (ts.isFunctionExpression(expr)) {
    lowerClosureExpression(expr, ctx);
  } else if (ts.isConditionalExpression(expr)) {
    lowerConditionalExpression(expr, ctx);
  } else if (ts.isNonNullExpression(expr)) {
    lowerExpression(expr.expression, ctx);
  } else if (ts.isAsExpression(expr)) {
    lowerExpression(expr.expression, ctx);
  } else if (ts.isAwaitExpression(expr)) {
    lowerAwaitExpression(expr, ctx);
  } else if (expr.kind === ts.SyntaxKind.ThisKeyword) {
    if (ctx.staticClassInfo) {
      ctx.diagnostics.push(
        makeDiag(
          LoweringDiagCode.ClassObjectUsageNotSupported,
          "Bare 'this' in a static method is not supported; use 'this.field' or 'this.method()' to access static members",
          expr
        )
      );
      return;
    }
    if (ctx.thisLocalIndex === undefined) {
      ctx.diagnostics.push(
        makeDiag(
          LoweringDiagCode.ThisOutsideClassContext,
          "'this' can only be used inside a class constructor or method",
          expr
        )
      );
      return;
    }
    ctx.ir.push({ kind: "LoadLocal", index: ctx.thisLocalIndex });
  } else if (ts.isNewExpression(expr)) {
    lowerNewExpression(expr, ctx);
  } else {
    ctx.diagnostics.push(
      makeDiag(LoweringDiagCode.UnsupportedExpression, `Unsupported expression: ${ts.SyntaxKind[expr.kind]}`, expr)
    );
  }

  annotateFirstNode(ctx.ir, irStart, expr, false);
}

function lowerIdentifier(expr: ts.Identifier, ctx: LowerContext): void {
  if (expr.text === "undefined") {
    ctx.ir.push({ kind: "PushConst", value: NIL_VALUE });
    return;
  }

  if (expr.text === "Infinity") {
    ctx.ir.push({ kind: "PushConst", value: mkNumberValue(Number.POSITIVE_INFINITY) });
    return;
  }

  const paramLocal = ctx.paramLocals.get(expr.text);
  if (paramLocal !== undefined) {
    ctx.ir.push({ kind: "LoadLocal", index: paramLocal });
    return;
  }

  if (ctx.paramsSymbol && ctx.checker.getSymbolAtLocation(expr) === ctx.paramsSymbol) {
    ctx.diagnostics.push(
      makeDiag(LoweringDiagCode.UnsupportedPropertyAccess, "Action args must be accessed by field", expr)
    );
    ctx.ir.push({ kind: "PushConst", value: NIL_VALUE });
    return;
  }

  const localIdx = ctx.scopeStack.resolveLocal(expr.text);
  if (localIdx !== undefined) {
    ctx.ir.push({ kind: "LoadLocal", index: localIdx });
    return;
  }

  if (ctx.capturedVars) {
    const captureIdx = ctx.capturedVars.get(expr.text);
    if (captureIdx !== undefined) {
      ctx.ir.push({ kind: "LoadCapture", index: captureIdx });
      return;
    }
  }

  const systemBinding = resolveSystemBinding(expr, ctx);
  if (systemBinding) {
    ctx.ir.push({ kind: "LoadSystemVar", index: systemBinding.localSlot });
    return;
  }

  if (ctx.inlineConsts && lowerInlinedConstReference(expr, ctx)) {
    return;
  }

  const csvIdx = ctx.callsiteVars.get(expr.text);
  if (csvIdx !== undefined) {
    ctx.ir.push({ kind: "LoadCallsiteVar", index: csvIdx });
    return;
  }

  const carriedKey = resolveCarriedFunctionKey(expr, ctx);
  if (carriedKey !== undefined) {
    ctx.ir.push({ kind: "PushFunctionRef", funcName: carriedKey });
    return;
  }

  if (ctx.functionTable.has(expr.text)) {
    ctx.ir.push({ kind: "PushFunctionRef", funcName: expr.text });
    return;
  }

  const enumSymbol = resolveAliasedSymbol(ctx.checker.getSymbolAtLocation(expr), ctx.checker);
  if (enumSymbol && resolveEnumDeclaration(enumSymbol, ctx.checker)) {
    const typeId = resolveRegisteredEnumTypeIdFromSymbol(enumSymbol, ctx.services, ctx.projectNamespace, ctx.checker);
    if (typeId) {
      ctx.diagnostics.push(
        makeDiag(
          LoweringDiagCode.EnumObjectUsageNotSupported,
          "Enum objects are not supported at runtime; use direct member access like Direction.Up",
          expr
        )
      );
      return;
    }
  }

  const classSymbol = resolveAliasedSymbol(ctx.checker.getSymbolAtLocation(expr), ctx.checker);
  if (classSymbol) {
    const classDecl = resolveClassDeclaration(classSymbol, ctx.checker);
    if (classDecl && ctx.classInfos.some((c) => c.node === classDecl)) {
      ctx.diagnostics.push(
        makeDiag(
          LoweringDiagCode.ClassObjectUsageNotSupported,
          "Class objects are not supported as runtime values; use property access like Counter.count or new Counter()",
          expr
        )
      );
      return;
    }
  }

  // An ambient TypeRef token has no runtime binding; as a value it evaluates
  // to its canonical type name, so module consts carrying tokens lower inertly.
  const tokenName = ambientTypeTokenName(expr, ctx.checker);
  if (tokenName !== undefined) {
    ctx.ir.push({ kind: "PushConst", value: mkStringValue(tokenName) });
    return;
  }

  ctx.diagnostics.push(makeDiag(LoweringDiagCode.UndefinedVariable, `Undefined variable: ${expr.text}`, expr));
}

function lowerAwaitExpression(expr: ts.AwaitExpression, ctx: LowerContext): void {
  const irLenBefore = ctx.ir.length;
  lowerExpression(expr.expression, ctx);
  const lastNode = ctx.ir.length > irLenBefore ? ctx.ir[ctx.ir.length - 1] : undefined;
  if (!lastNode || lastNode.kind !== "HostCallAsync") {
    ctx.diagnostics.push(
      makeDiag(LoweringDiagCode.AwaitOnNonAsyncHostCall, "`await` is only supported on async host function calls", expr)
    );
    return;
  }
  ctx.ir.push({ kind: "Await", span: spanFromNode(expr), isStatementBoundary: true });
}

function lowerNewMapExpression(expr: ts.NewExpression, ctx: LowerContext): void {
  const exprType = ctx.checker.getTypeAtLocation(expr);
  const mapTypeId = resolveMapTypeId(exprType, ctx);
  if (!mapTypeId) {
    ctx.diagnostics.push(
      makeDiag(
        LoweringDiagCode.MapConstructorUnresolvableType,
        "Cannot determine map type for `new Map()` expression",
        expr
      )
    );
    return;
  }

  const args = expr.arguments ?? [];

  if (args.length === 0) {
    ctx.ir.push({ kind: "MapNew", typeId: mapTypeId });
    return;
  }

  if (args.length > 1) {
    ctx.diagnostics.push(
      makeDiag(LoweringDiagCode.MapConstructorTooManyArgs, "`new Map()` accepts at most 1 argument", expr)
    );
    return;
  }

  const arg = args[0];
  if (!ts.isArrayLiteralExpression(arg)) {
    ctx.diagnostics.push(
      makeDiag(
        LoweringDiagCode.MapConstructorBadArgument,
        "`new Map()` argument must be an array literal of [key, value] tuples",
        arg
      )
    );
    return;
  }

  ctx.ir.push({ kind: "MapNew", typeId: mapTypeId });

  for (const element of arg.elements) {
    if (!ts.isArrayLiteralExpression(element) || element.elements.length !== 2) {
      ctx.diagnostics.push(
        makeDiag(
          LoweringDiagCode.MapConstructorBadArgument,
          "Each entry in `new Map(...)` must be a [key, value] tuple",
          element
        )
      );
      return;
    }
    lowerExpression(element.elements[0], ctx);
    lowerExpression(element.elements[1], ctx);
    ctx.ir.push({ kind: "MapSet" });
  }
}

function lowerNewExpression(expr: ts.NewExpression, ctx: LowerContext): void {
  if (!ts.isIdentifier(expr.expression)) {
    ctx.diagnostics.push(
      makeDiag(
        LoweringDiagCode.NewExpressionNotIdentifier,
        "new expression target must be an identifier",
        expr.expression
      )
    );
    return;
  }

  const className = expr.expression.text;

  if (className === "Map") {
    lowerNewMapExpression(expr, ctx);
    return;
  }

  const ctorKey = `${className}$new`;
  const funcId = ctx.functionTable.get(ctorKey);
  if (funcId === undefined) {
    ctx.diagnostics.push(
      makeDiag(LoweringDiagCode.NewExpressionUnknownClass, `Unknown class '${className}'`, expr.expression)
    );
    return;
  }

  const args = expr.arguments ?? [];
  for (const arg of args) {
    lowerExpression(arg, ctx);
  }
  ctx.ir.push({ kind: "Call", funcIndex: funcId, argc: args.length });
}

function lowerCallExpression(expr: ts.CallExpression, ctx: LowerContext): void {
  if (ts.isOptionalChain(expr)) {
    lowerOptionalChainCall(expr, ctx);
    return;
  }
  lowerCallExpressionCore(expr, ctx);
}

function lowerOptionalChainCall(expr: ts.CallExpression, ctx: LowerContext): void {
  if (expr.questionDotToken) {
    lowerExpression(expr.expression, ctx);
    const { endLabel } = emitNilGuard(ctx);
    const argc = lowerCallArgumentsWithTargetTypes(expr, ctx);
    ctx.ir.push({ kind: "CallIndirect", argc });
    ctx.ir.push({ kind: "Label", labelId: endLabel });
    return;
  }

  const root = findOptionalChainRoot(expr.expression);
  if (!root) {
    lowerCallExpressionCore(expr, ctx);
    return;
  }

  const guardExpr = root.expression;
  const tempLocal = ctx.scopeStack.allocLocal();
  const keepLabel = allocLabel(ctx);
  const endLabel = allocLabel(ctx);

  lowerExpression(guardExpr, ctx);
  ctx.ir.push({ kind: "StoreLocal", index: tempLocal });
  ctx.ir.push({ kind: "LoadLocal", index: tempLocal });
  ctx.ir.push({ kind: "TypeCheck", nativeType: NativeType.Nil });
  ctx.ir.push({ kind: "JumpIfFalse", labelId: keepLabel });
  ctx.ir.push({ kind: "PushConst", value: NIL_VALUE });
  ctx.ir.push({ kind: "Jump", labelId: endLabel });
  ctx.ir.push({ kind: "Label", labelId: keepLabel });

  const savedSub = ctx.optionalChainSubstitution;
  ctx.optionalChainSubstitution = { targetExpr: guardExpr, localIndex: tempLocal };
  lowerCallExpressionCore(expr, ctx);
  ctx.optionalChainSubstitution = savedSub;

  ctx.ir.push({ kind: "Label", labelId: endLabel });
}

/** Resolve a declared output type name to a registry {@link TypeId}, matching the registration-side resolution. */
function resolveOutputTypeId(typeName: string, services: BrainServices): TypeId | undefined {
  const types = services.runtime.types;
  if (types.get(typeName)) return typeName;
  return types.resolveByName(typeName);
}

/**
 * Lower a `setOutput(ctx, name, value)` intrinsic call. Resolves `name` against
 * the enclosing sensor's declared outputs to form the backing rule-variable key
 * (see {@link mkOutputVarKey}), then emits a RuleContextSetVariable host call:
 * arg slot 0 is the ignored receiver, slot 1 the constant key, slot 2 the value.
 * Leaves the call's nil result on the stack (the expression statement pops it).
 */
function lowerSetOutputCall(expr: ts.CallExpression, ctx: LowerContext): void {
  if (expr.arguments.length !== 3) {
    ctx.diagnostics.push(
      makeDiag(
        LoweringDiagCode.SetOutputWrongArgCount,
        "`setOutput` requires exactly three arguments: (ctx, name, value).",
        expr
      )
    );
    ctx.ir.push({ kind: "PushConst", value: NIL_VALUE });
    return;
  }

  const nameArg = expr.arguments[1];
  if (!ts.isStringLiteral(nameArg)) {
    ctx.diagnostics.push(
      makeDiag(LoweringDiagCode.SetOutputNameNotStringLiteral, "`setOutput` name must be a string literal.", nameArg)
    );
    ctx.ir.push({ kind: "PushConst", value: NIL_VALUE });
    return;
  }

  const outputName = nameArg.text;
  if (ctx.sensorOutputs === undefined) {
    ctx.diagnostics.push(
      makeDiag(
        LoweringDiagCode.SetOutputOutsideSensor,
        "`setOutput` is only valid inside a sensor `onExecute` that declares `outputs`.",
        expr
      )
    );
    ctx.ir.push({ kind: "PushConst", value: NIL_VALUE });
    return;
  }

  const typeId = ctx.sensorOutputs.get(outputName);
  if (typeId === undefined) {
    // A declared output whose type did not resolve is already reported at its
    // declaration; only a genuinely undeclared name is flagged here.
    if (!ctx.sensorOutputNames?.has(outputName)) {
      ctx.diagnostics.push(
        makeDiag(
          LoweringDiagCode.SetOutputUnknownOutput,
          `\`setOutput\` names output \`${outputName}\`, which is not declared in this sensor's \`outputs\`.`,
          nameArg
        )
      );
    }
    ctx.ir.push({ kind: "PushConst", value: NIL_VALUE });
    return;
  }

  ctx.ir.push({ kind: "PushConst", value: NIL_VALUE });
  ctx.ir.push({
    kind: "PushConst",
    value: mkStringValue(mkOutputVarKey(typeId, scopedOutputName(ctx.projectNamespace, outputName))),
  });
  const valueExpr = expr.arguments[2];
  lowerExpression(valueExpr, ctx);
  coerceSetOutputValue(valueExpr, typeId, outputName, ctx);
  ctx.ir.push({ kind: "HostCall", fnName: "RuleContext.setVariable", argc: 3 });
}

/**
 * Coerce the just-lowered `setOutput` value (on top of the operand stack) to the
 * output's declared type. A value already of the declared type, or `nil` (clearing
 * an output), passes through unchanged; a single-step-convertible value is
 * converted; any other type is diagnosed and the value left as lowered.
 */
function coerceSetOutputValue(
  valueExpr: ts.Expression,
  declaredTypeId: TypeId,
  outputName: string,
  ctx: LowerContext
): void {
  const valueTypeId = resolveExpressionTypeId(valueExpr, ctx);
  if (valueTypeId === undefined || valueTypeId === declaredTypeId || valueTypeId === CoreTypeIds.Nil) {
    return;
  }
  const conversion = resolveSingleStepConversion(valueTypeId, declaredTypeId, ctx.services);
  if (conversion) {
    emitSingleStepConversion(conversion.fnName, ctx);
    return;
  }
  ctx.diagnostics.push(
    makeDiag(
      LoweringDiagCode.SetOutputValueTypeMismatch,
      `\`setOutput\` value of type \`${valueTypeId}\` does not match output \`${outputName}\`'s declared type \`${declaredTypeId}\`.`,
      valueExpr
    )
  );
}

function lowerCallExpressionCore(expr: ts.CallExpression, ctx: LowerContext): void {
  if (ts.isIdentifier(expr.expression) && expr.expression.text === "setOutput") {
    lowerSetOutputCall(expr, ctx);
    return;
  }

  if (ts.isIdentifier(expr.expression)) {
    const structDef = resolveStructTypeFactory(expr.expression, ctx);
    if (structDef) {
      lowerStructFactoryCall(expr, structDef, ctx);
      return;
    }
  }

  if (ts.isIdentifier(expr.expression)) {
    const carriedKey = resolveCarriedFunctionKey(expr.expression, ctx);
    const funcId = ctx.functionTable.get(carriedKey ?? expr.expression.text);
    if (funcId !== undefined) {
      const argc = lowerCallArgumentsWithTargetTypes(expr, ctx);
      ctx.ir.push({ kind: "Call", funcIndex: funcId, argc });
      return;
    }
  }

  if (ts.isPropertyAccessExpression(expr.expression)) {
    if (lowerPromiseMethodCall(expr, expr.expression, ctx)) {
      return;
    }
    if (lowerArrayFromCall(expr, expr.expression, ctx)) {
      return;
    }
    if (lowerArrayIsArrayCall(expr, expr.expression, ctx)) {
      return;
    }
    if (lowerBufferIsBufferCall(expr, expr.expression, ctx)) {
      return;
    }
    if (lowerBufferConstructorCall(expr, expr.expression, ctx)) {
      return;
    }
    if (lowerMathCall(expr, expr.expression, ctx)) {
      return;
    }
    if (lowerStringMethodCall(expr, expr.expression, ctx)) {
      return;
    }
    if (lowerBufferMethodCall(expr, expr.expression, ctx)) {
      return;
    }
    if (lowerThisStaticMethodCall(expr, expr.expression, ctx)) {
      return;
    }
    if (lowerStaticMethodCall(expr, expr.expression, ctx)) {
      return;
    }
    if (lowerSystemMethodCall(expr, expr.expression, ctx)) {
      return;
    }
    if (lowerStructMethodCall(expr, expr.expression, ctx)) {
      return;
    }
    if (lowerListMethodCall(expr, expr.expression, ctx)) {
      return;
    }
    if (lowerMapMethodCall(expr, expr.expression, ctx)) {
      return;
    }
  }

  const calleeSym = ctx.checker.getSymbolAtLocation(expr.expression);
  const calleeType = ctx.checker.getTypeAtLocation(expr.expression);
  if (calleeType.getCallSignatures().length > 0 || (calleeSym && calleeSym.flags & ts.SymbolFlags.Function)) {
    const irLenBefore = ctx.ir.length;
    lowerExpression(expr.expression, ctx);
    if (ctx.ir.length === irLenBefore) {
      return;
    }
    const argc = lowerCallArgumentsWithTargetTypes(expr, ctx);
    ctx.ir.push({ kind: "CallIndirect", argc });
    return;
  }

  ctx.diagnostics.push(makeDiag(LoweringDiagCode.UnsupportedFunctionCall, "Unsupported function call", expr));
}

function bareClassName(qualOrBareName: string): string {
  const sep = qualOrBareName.indexOf("::");
  if (sep >= 0) return qualOrBareName.slice(sep + 2);
  return qualOrBareName;
}

function lowerThisStaticMethodCall(
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
  ctx: LowerContext
): boolean {
  const thisStatic = resolveThisStaticAccess(propAccess, ctx);
  if (!thisStatic) return false;

  if (thisStatic.kind === "method") {
    const funcId = ctx.functionTable.get(thisStatic.funcName);
    if (funcId !== undefined) {
      const argc = lowerCallArgumentsWithTargetTypes(expr, ctx);
      ctx.ir.push({ kind: "Call", funcIndex: funcId, argc });
      return true;
    }
    ctx.diagnostics.push(
      makeDiag(
        LoweringDiagCode.UnsupportedFunctionCall,
        `Static method '${thisStatic.funcName}' is not in the function table`,
        expr
      )
    );
    return true;
  }

  if (thisStatic.kind === "field") {
    ctx.diagnostics.push(
      makeDiag(
        LoweringDiagCode.UnsupportedFunctionCall,
        `'this.${propAccess.name.text}' is a static field, not a method`,
        expr
      )
    );
    return true;
  }

  if (thisStatic.kind === "no-such-member") {
    ctx.diagnostics.push(
      makeDiag(
        LoweringDiagCode.NoSuchStaticMember,
        `No static member '${propAccess.name.text}' exists on class '${ctx.staticClassInfo!.name}'`,
        expr
      )
    );
    return true;
  }

  return false;
}

function lowerStaticMethodCall(
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
  ctx: LowerContext
): boolean {
  const staticAccess = resolveStaticMemberAccess(propAccess, ctx);
  if (!staticAccess) return false;

  if (staticAccess.kind === "method") {
    const funcId = ctx.functionTable.get(staticAccess.funcName);
    if (funcId !== undefined) {
      const argc = lowerCallArgumentsWithTargetTypes(expr, ctx);
      ctx.ir.push({ kind: "Call", funcIndex: funcId, argc });
      return true;
    }
    ctx.diagnostics.push(
      makeDiag(
        LoweringDiagCode.UnsupportedFunctionCall,
        `Static method '${staticAccess.funcName}' is not in the function table`,
        expr
      )
    );
    return true;
  }

  if (staticAccess.kind === "field") {
    ctx.diagnostics.push(
      makeDiag(
        LoweringDiagCode.UnsupportedFunctionCall,
        `'${(propAccess.expression as ts.Identifier).text}.${propAccess.name.text}' is a static field, not a method`,
        expr
      )
    );
    return true;
  }

  if (staticAccess.kind === "no-such-member") {
    ctx.diagnostics.push(
      makeDiag(
        LoweringDiagCode.NoSuchStaticMember,
        `No static member '${propAccess.name.text}' exists on class '${(propAccess.expression as ts.Identifier).text}'`,
        expr
      )
    );
    return true;
  }

  return false;
}

/**
 * Rejects a method call whose receiver is an async result (a `Promise` or
 * `PromiseLike`), reporting `UnsupportedAsyncResultMethod` at `expr`. Returns
 * true and pushes a nil placeholder when it handles the call; false when the
 * receiver is not an async result.
 */
function lowerPromiseMethodCall(
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
  ctx: LowerContext
): boolean {
  const receiverType = ctx.checker.getTypeAtLocation(propAccess.expression);
  const sym = receiverType.aliasSymbol ?? receiverType.getSymbol();
  const typeName = sym?.getName();
  if (typeName !== "Promise" && typeName !== "PromiseLike") return false;

  ctx.diagnostics.push(
    makeDiag(
      LoweringDiagCode.UnsupportedAsyncResultMethod,
      `\`.${propAccess.name.text}()\` is not supported on an async result. Use \`await\` to obtain the resolved value.`,
      expr
    )
  );
  ctx.ir.push({ kind: "PushConst", value: NIL_VALUE });
  return true;
}

/**
 * Resolve an identifier to the registered struct type of its `StructType({...})`
 * declaration (following import aliases), or undefined when the identifier is
 * not a StructType binding or its type is not registered.
 */
function resolveStructTypeFactory(idNode: ts.Identifier, ctx: LowerContext): StructTypeDef | undefined {
  let sym = ctx.checker.getSymbolAtLocation(idNode);
  if (!sym) return undefined;
  if (sym.flags & ts.SymbolFlags.Alias) {
    sym = ctx.checker.getAliasedSymbol(sym);
  }
  const decls = sym.getDeclarations();
  const decl = decls && decls.length > 0 ? decls[0] : undefined;
  if (!decl || !ts.isVariableDeclaration(decl) || !ts.isIdentifier(decl.name)) return undefined;
  if (!structTypeConfigObject(decl.initializer)) return undefined;

  const identity = qualifiedDeclarationName(ctx.projectNamespace, decl.getSourceFile().fileName, decl.name.text);
  const typeId = ctx.services.runtime.types.resolveByName(identity);
  if (typeId === undefined) return undefined;
  const typeDef = ctx.services.runtime.types.get(typeId);
  if (!typeDef || typeDef.coreType !== NativeType.Struct) return undefined;
  return typeDef as StructTypeDef;
}

/**
 * Lower a struct factory call `Position({...})`: an object-literal argument
 * constructs the instance directly; any other struct-typed argument passes
 * through.
 */
function lowerStructFactoryCall(expr: ts.CallExpression, structDef: StructTypeDef, ctx: LowerContext): void {
  const arg = expr.arguments.length === 1 ? expr.arguments[0] : undefined;
  if (!arg) {
    ctx.diagnostics.push(
      makeDiag(
        LoweringDiagCode.UnsupportedFunctionCall,
        `\`${structDef.name}\` construction takes exactly one argument (the field values).`,
        expr
      )
    );
    ctx.ir.push({ kind: "PushConst", value: NIL_VALUE });
    return;
  }
  if (ts.isObjectLiteralExpression(arg)) {
    lowerObjectLiteralAsStruct(arg, structDef, ctx);
    return;
  }
  lowerExpression(arg, ctx);
}

/** Resolve an identifier to its System binding (following import aliases), or undefined. */
function resolveSystemBinding(idNode: ts.Identifier, ctx: LowerContext): SystemBinding | undefined {
  if (!ctx.systemBindings) return undefined;
  let sym = ctx.checker.getSymbolAtLocation(idNode);
  if (!sym) return undefined;
  if (sym.flags & ts.SymbolFlags.Alias) {
    sym = ctx.checker.getAliasedSymbol(sym);
  }
  return ctx.systemBindings.get(sym);
}

/**
 * The function-table identity key for `idNode` when it resolves to a carried
 * non-exported function (see {@link LowerContext.carriedFunctionKeys}), else
 * undefined. A call site inside a re-lowered body resolves to the right helper by
 * declaration symbol, keeping same-named private helpers from different modules
 * distinct.
 */
function resolveCarriedFunctionKey(idNode: ts.Identifier, ctx: LowerContext): string | undefined {
  const keys = ctx.carriedFunctionKeys;
  if (!keys || keys.size === 0) return undefined;
  let sym = ctx.checker.getSymbolAtLocation(idNode);
  if (!sym) return undefined;
  if (sym.flags & ts.SymbolFlags.Alias) {
    sym = ctx.checker.getAliasedSymbol(sym);
  }
  return keys.get(sym);
}

/**
 * When `id` resolves to a defining-module `const` carried for inlining (see
 * {@link LowerContext.inlineConsts}), re-lower the const's initializer inline and
 * return true. A cyclic `const` reference reached through this re-lowering pushes
 * {@link LoweringDiagCode.SystemModuleReferenceNotCarryable} and emits a nil.
 * Returns false when `id` is not a carried inline const.
 */
function lowerInlinedConstReference(id: ts.Identifier, ctx: LowerContext): boolean {
  const inlineConsts = ctx.inlineConsts;
  if (!inlineConsts || inlineConsts.size === 0) return false;
  let sym = ctx.checker.getSymbolAtLocation(id);
  if (!sym) return false;
  if (sym.flags & ts.SymbolFlags.Alias) {
    sym = ctx.checker.getAliasedSymbol(sym);
  }
  const initializer = inlineConsts.get(sym);
  if (!initializer) return false;

  const inlining = ctx.inliningConsts ?? new Set<ts.Symbol>();
  if (inlining.has(sym)) {
    ctx.diagnostics.push(
      makeDiag(
        LoweringDiagCode.SystemModuleReferenceNotCarryable,
        `A System body references '${id.text}', a module-level \`const\` whose initializer refers back to itself; a cyclic \`const\` cannot be inlined into a System body.`,
        id
      )
    );
    ctx.ir.push({ kind: "PushConst", value: NIL_VALUE });
    return true;
  }
  inlining.add(sym);
  const prevInlining = ctx.inliningConsts;
  ctx.inliningConsts = inlining;
  lowerExpression(initializer, ctx);
  ctx.inliningConsts = prevInlining;
  inlining.delete(sym);
  return true;
}

/**
 * Lower a System method call -- either `Movement.method(...)` (external, the
 * receiver loaded from the System store) or `this.method(...)` (a sibling call
 * inside a System body, the receiver loaded from the `this` local) -- to a call
 * of the method's struct-receiver function with the state plus the arguments.
 */
function lowerSystemMethodCall(expr: ts.CallExpression, callee: ts.LeftHandSideExpression, ctx: LowerContext): boolean {
  if (!ts.isPropertyAccessExpression(callee)) return false;
  const methodName = callee.name.text;

  if (
    callee.expression.kind === ts.SyntaxKind.ThisKeyword &&
    ctx.thisSystemMethodFuncIds !== undefined &&
    ctx.thisLocalIndex !== undefined
  ) {
    const funcId = ctx.thisSystemMethodFuncIds.get(methodName);
    if (funcId === undefined) {
      ctx.diagnostics.push(
        makeDiag(LoweringDiagCode.UnsupportedFunctionCall, `System has no method '${methodName}'`, expr)
      );
      ctx.ir.push({ kind: "PushConst", value: NIL_VALUE });
      return true;
    }
    ctx.ir.push({ kind: "LoadLocal", index: ctx.thisLocalIndex });
    const argc = lowerCallArgumentsWithTargetTypes(expr, ctx) + 1;
    ctx.ir.push({ kind: "Call", funcIndex: funcId, argc });
    return true;
  }

  if (!ts.isIdentifier(callee.expression)) return false;
  const binding = resolveSystemBinding(callee.expression, ctx);
  if (!binding) return false;

  const funcId = binding.methodFuncIds.get(methodName);
  if (funcId === undefined) {
    ctx.diagnostics.push(
      makeDiag(LoweringDiagCode.UnsupportedFunctionCall, `System '${binding.name}' has no method '${methodName}'`, expr)
    );
    ctx.ir.push({ kind: "PushConst", value: NIL_VALUE });
    return true;
  }

  ctx.ir.push({ kind: "LoadSystemVar", index: binding.localSlot });
  const argc = lowerCallArgumentsWithTargetTypes(expr, ctx) + 1;
  ctx.ir.push({ kind: "Call", funcIndex: funcId, argc });
  return true;
}

function lowerStructMethodCall(
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
  ctx: LowerContext
): boolean {
  const receiverType = ctx.checker.getTypeAtLocation(propAccess.expression);
  const structDef = resolveStructType(receiverType, ctx.services, ctx.projectNamespace, ctx.checker);
  if (!structDef) return false;

  const methodName = propAccess.name.text;
  let found = false;
  structDef.methods?.forEach((m) => {
    if (m.name === methodName) found = true;
  });
  if (!found) return false;

  const bareName = bareClassName(structDef.name);
  const fnName = `${bareName}.${methodName}`;

  const userFuncId = ctx.functionTable.get(fnName);
  if (userFuncId !== undefined) {
    lowerExpression(propAccess.expression, ctx);
    const argc = lowerCallArgumentsWithTargetTypes(expr, ctx) + 1;
    ctx.ir.push({ kind: "Call", funcIndex: userFuncId, argc });
    return true;
  }

  const fnEntry = ctx.services.runtime.functions.get(fnName);
  if (!fnEntry) {
    ctx.diagnostics.push(
      makeDiag(LoweringDiagCode.UnknownStructMethod, `Unknown struct method: '${bareName}.${methodName}'`, propAccess)
    );
    return true;
  }

  lowerExpression(propAccess.expression, ctx);
  const argc = lowerCallArgumentsWithTargetTypes(expr, ctx) + 1;
  if (fnEntry.isAsync) {
    emitHostCallAsync(ctx, expr, fnName, argc);
  } else {
    ctx.ir.push({ kind: "HostCall", fnName, argc });
  }
  return true;
}

/**
 * Emits a `HostCallAsync` for an async host function. When the enclosing body
 * cannot suspend, also reports an error at `node`.
 */
function emitHostCallAsync(ctx: LowerContext, node: ts.Node, fnName: string, argc: number): void {
  const context = ctx.nonSuspendableContext;
  if (context !== undefined) {
    const message = `\`${fnName}\` is an async action and cannot be called from ${context}.`;
    ctx.diagnostics.push(makeDiag(LoweringDiagCode.AsyncHostCallInNonSuspendableContext, message, node));
  }
  ctx.ir.push({ kind: "HostCallAsync", fnName, argc });
}

interface CaptureInfo {
  name: string;
  source: "paramLocal" | "local" | "capture";
  index: number;
}

function isIdentifierReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
  if (ts.isParameter(parent) && parent.name === node) return false;
  if (ts.isVariableDeclaration(parent) && parent.name === node) return false;
  if (ts.isFunctionDeclaration(parent) && parent.name === node) return false;
  if (ts.isFunctionExpression(parent) && parent.name === node) return false;
  return true;
}

function isDescendantOf(node: ts.Node, ancestor: ts.Node): boolean {
  let current: ts.Node | undefined = node;
  while (current) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}

function findCapturedVariables(
  closureNode: ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration | ts.MethodDeclaration,
  closureParamNames: Set<string>,
  ctx: LowerContext
): CaptureInfo[] {
  const captures: CaptureInfo[] = [];
  const seen = new Set<string>();

  function visit(node: ts.Node): void {
    if (ts.isIdentifier(node) && isIdentifierReference(node)) {
      const name = node.text;
      if (seen.has(name) || closureParamNames.has(name) || name === "undefined") return;

      const sym = ctx.checker.getSymbolAtLocation(node);
      if (sym) {
        const decls = sym.getDeclarations();
        if (decls && decls.length > 0) {
          if (isDescendantOf(decls[0], closureNode)) return;
        }
      }

      const paramIdx = ctx.paramLocals.get(name);
      if (paramIdx !== undefined) {
        seen.add(name);
        captures.push({ name, source: "paramLocal", index: paramIdx });
        return;
      }

      const localIdx = ctx.scopeStack.resolveLocal(name);
      if (localIdx !== undefined) {
        seen.add(name);
        captures.push({ name, source: "local", index: localIdx });
        return;
      }

      if (ctx.capturedVars) {
        const captureIdx = ctx.capturedVars.get(name);
        if (captureIdx !== undefined) {
          seen.add(name);
          captures.push({ name, source: "capture", index: captureIdx });
          return;
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  if (closureNode.body) {
    visit(closureNode.body);
  }
  return captures;
}

function lowerClosureExpression(
  expr: ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration | ts.MethodDeclaration,
  ctx: LowerContext
): void {
  const numParams = expr.parameters.length;
  const closureParamNames = new Set<string>();
  const closureParamLocals = new Map<string, number>();

  for (let i = 0; i < numParams; i++) {
    const p = expr.parameters[i];
    if (ts.isIdentifier(p.name)) {
      closureParamNames.add(p.name.text);
      closureParamLocals.set(p.name.text, i);
    } else if (ts.isObjectBindingPattern(p.name) || ts.isArrayBindingPattern(p.name)) {
      for (const name of collectBindingNames(p.name)) {
        closureParamNames.add(name);
      }
    }
  }

  const captureInfos = findCapturedVariables(expr, closureParamNames, ctx);

  const capturedVars = new Map<string, number>();
  for (let i = 0; i < captureInfos.length; i++) {
    capturedVars.set(captureInfos[i].name, i);
  }

  for (const info of captureInfos) {
    switch (info.source) {
      case "paramLocal":
      case "local":
        ctx.ir.push({ kind: "LoadLocal", index: info.index });
        break;
      case "capture":
        ctx.ir.push({ kind: "LoadCapture", index: info.index });
        break;
    }
  }

  const closureFuncId = ctx.funcIdCounter.value++;
  const declaredName = ts.isFunctionDeclaration(expr) && expr.name ? expr.name.text : undefined;
  const closureName = declaredName ? `<local-fn:${declaredName}#${closureFuncId}>` : `<closure#${closureFuncId}>`;
  ctx.functionTable.set(closureName, closureFuncId);

  if (captureInfos.length > 0) {
    ctx.ir.push({ kind: "MakeClosure", funcName: closureName, captureCount: captureInfos.length });
  } else {
    ctx.ir.push({ kind: "PushFunctionRef", funcName: closureName });
  }

  const closureIr: IrNode[] = [];
  const closureScopeStack = new ScopeStack(numParams);
  const closureFuncScopeId = closureScopeStack.initFunctionScope(0, closureName);

  for (let i = 0; i < numParams; i++) {
    const p = expr.parameters[i];
    if (ts.isIdentifier(p.name)) {
      closureScopeStack.addParameterMetadata(p.name.text, i, closureFuncScopeId);
    }
  }
  for (const info of captureInfos) {
    closureScopeStack.addCaptureMetadata(info.name, capturedVars.get(info.name)!, closureFuncScopeId);
  }

  const closureCtx: LowerContext = {
    services: ctx.services,
    projectNamespace: ctx.projectNamespace,
    checker: ctx.checker,
    paramsSymbol: undefined,
    paramLocals: closureParamLocals,
    scopeStack: closureScopeStack,
    ir: closureIr,
    diagnostics: ctx.diagnostics,
    loopStack: [],
    breakStack: [],
    nextLabelId: 0,
    callsiteVars: ctx.callsiteVars,
    functionTable: ctx.functionTable,
    capturedVars: capturedVars.size > 0 ? capturedVars : undefined,
    funcIdCounter: ctx.funcIdCounter,
    closureFunctions: ctx.closureFunctions,
    currentFunctionName: closureName,
    currentReturnTypeId: resolveSignatureReturnTypeId(expr, ctx.checker, ctx.services, ctx.projectNamespace),
    classInfos: ctx.classInfos,
    systemBindings: ctx.systemBindings,
  };

  for (let i = 0; i < numParams; i++) {
    const p = expr.parameters[i];
    if (ts.isObjectBindingPattern(p.name)) {
      lowerObjectBindingPattern(p.name, i, closureCtx);
    } else if (ts.isArrayBindingPattern(p.name)) {
      lowerArrayBindingPattern(p.name, i, closureCtx);
    }
  }

  const body = expr.body;
  if (!body) {
    closureIr.push({ kind: "PushConst", value: NIL_VALUE });
    closureIr.push({ kind: "Return" });
  } else if (ts.isBlock(body)) {
    lowerStatements(body.statements, closureCtx);
    closureIr.push({ kind: "PushConst", value: NIL_VALUE });
    closureIr.push({ kind: "Return" });
  } else {
    lowerExpressionWithExpectedType(body, closureCtx.currentReturnTypeId, "return statement", body, closureCtx);
    closureIr.push({ kind: "Return" });
  }

  closureScopeStack.finalizeFunctionScope(closureIr.length);
  ctx.closureFunctions.set(closureFuncId, {
    ir: closureIr,
    numParams,
    numLocals: closureScopeStack.nextLocal,
    name: closureName,
    scopeMetadata: [...closureScopeStack.scopeMetadata],
    localMetadata: [...closureScopeStack.localMetadata],
    isGenerated: false,
    parentName: ctx.currentFunctionName,
    sourceFileName: expr.getSourceFile()?.fileName,
    functionSpan: spanFromNode(expr),
  });
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  switch (kind) {
    case ts.SyntaxKind.EqualsToken:
    case ts.SyntaxKind.PlusEqualsToken:
    case ts.SyntaxKind.MinusEqualsToken:
    case ts.SyntaxKind.AsteriskEqualsToken:
    case ts.SyntaxKind.SlashEqualsToken:
    case ts.SyntaxKind.AsteriskAsteriskEqualsToken:
    case ts.SyntaxKind.AmpersandEqualsToken:
    case ts.SyntaxKind.BarEqualsToken:
    case ts.SyntaxKind.CaretEqualsToken:
    case ts.SyntaxKind.LessThanLessThanEqualsToken:
    case ts.SyntaxKind.GreaterThanGreaterThanEqualsToken:
    case ts.SyntaxKind.PercentEqualsToken:
    case ts.SyntaxKind.QuestionQuestionEqualsToken:
    case ts.SyntaxKind.BarBarEqualsToken:
    case ts.SyntaxKind.AmpersandAmpersandEqualsToken:
      return true;
    default:
      return false;
  }
}

function resolveVarTarget(
  name: string,
  ctx: LowerContext
): { kind: "local"; index: number } | { kind: "callsiteVar"; index: number } | undefined {
  const paramLocal = ctx.paramLocals.get(name);
  if (paramLocal !== undefined) return { kind: "local", index: paramLocal };

  const localIdx = ctx.scopeStack.resolveLocal(name);
  if (localIdx !== undefined) return { kind: "local", index: localIdx };

  const csvIdx = ctx.callsiteVars.get(name);
  if (csvIdx !== undefined) return { kind: "callsiteVar", index: csvIdx };

  return undefined;
}

function emitLoad(
  target: { kind: "local"; index: number } | { kind: "callsiteVar"; index: number },
  ctx: LowerContext
): void {
  if (target.kind === "local") {
    ctx.ir.push({ kind: "LoadLocal", index: target.index });
  } else {
    ctx.ir.push({ kind: "LoadCallsiteVar", index: target.index });
  }
}

function emitStore(
  target: { kind: "local"; index: number } | { kind: "callsiteVar"; index: number },
  ctx: LowerContext
): void {
  if (target.kind === "local") {
    ctx.ir.push({ kind: "StoreLocal", index: target.index });
  } else {
    ctx.ir.push({ kind: "StoreCallsiteVar", index: target.index });
  }
}

function checkStructAssignmentCompat(lhsNode: ts.Node, rhsNode: ts.Node, diagNode: ts.Node, ctx: LowerContext): void {
  const registry = ctx.services.runtime.types;
  const lhsType = ctx.checker.getTypeAtLocation(lhsNode);
  const rhsType = ctx.checker.getTypeAtLocation(rhsNode);
  const lhsTypeId = tsTypeToTypeId(lhsType, ctx.checker, ctx.services, ctx.projectNamespace);
  const rhsTypeId = tsTypeToTypeId(rhsType, ctx.checker, ctx.services, ctx.projectNamespace);
  if (!lhsTypeId || !rhsTypeId || lhsTypeId === rhsTypeId) return;

  const lhsDef = registry.get(lhsTypeId);
  const rhsDef = registry.get(rhsTypeId);
  if (!lhsDef || !rhsDef) return;
  if (lhsDef.coreType !== NativeType.Struct || rhsDef.coreType !== NativeType.Struct) return;

  if (!registry.isStructurallyCompatible(rhsTypeId, lhsTypeId)) {
    ctx.diagnostics.push(
      makeDiag(
        LoweringDiagCode.StructurallyIncompatibleTypes,
        `Type '${rhsDef.name}' is not structurally compatible with '${lhsDef.name}'`,
        diagNode
      )
    );
  }
}

function lowerLogicalAssignment(
  expr: ts.BinaryExpression,
  target: { kind: "local"; index: number } | { kind: "callsiteVar"; index: number },
  ctx: LowerContext
): void {
  const endLabel = allocLabel(ctx);

  if (expr.operatorToken.kind === ts.SyntaxKind.QuestionQuestionEqualsToken) {
    emitLoad(target, ctx);
    ctx.ir.push({ kind: "Dup" });
    ctx.ir.push({ kind: "TypeCheck", nativeType: NativeType.Nil });
    ctx.ir.push({ kind: "JumpIfFalse", labelId: endLabel });
    ctx.ir.push({ kind: "Pop" });
    lowerExpression(expr.right, ctx);
    ctx.ir.push({ kind: "Dup" });
    emitStore(target, ctx);
    ctx.ir.push({ kind: "Label", labelId: endLabel });
  } else if (expr.operatorToken.kind === ts.SyntaxKind.BarBarEqualsToken) {
    emitLoad(target, ctx);
    ctx.ir.push({ kind: "Dup" });
    ctx.ir.push({ kind: "JumpIfTrue", labelId: endLabel });
    ctx.ir.push({ kind: "Pop" });
    lowerExpression(expr.right, ctx);
    ctx.ir.push({ kind: "Dup" });
    emitStore(target, ctx);
    ctx.ir.push({ kind: "Label", labelId: endLabel });
  } else {
    emitLoad(target, ctx);
    ctx.ir.push({ kind: "Dup" });
    ctx.ir.push({ kind: "JumpIfFalse", labelId: endLabel });
    ctx.ir.push({ kind: "Pop" });
    lowerExpression(expr.right, ctx);
    ctx.ir.push({ kind: "Dup" });
    emitStore(target, ctx);
    ctx.ir.push({ kind: "Label", labelId: endLabel });
  }
}

/** One link of a member chain a field store writes back through: the struct field it reads. */
interface FieldWriteBackLink {
  /** Name of the field the link reads. */
  readonly fieldName: string;
  /** Storage slot of the field the link reads. */
  readonly fieldIndex: number;
}

/**
 * The struct field `link` reads, when lowering it reads one by numeric id from
 * the struct its object evaluates to: not a parameter read, a static member,
 * or a class accessor. Undefined otherwise.
 */
function structFieldOfLink(
  link: ts.PropertyAccessExpression,
  ctx: LowerContext
): { readonly structDef: StructTypeDef; readonly field: StructFieldDef } | undefined {
  if (
    ctx.paramsSymbol !== undefined &&
    ts.isIdentifier(link.expression) &&
    ctx.checker.getSymbolAtLocation(link.expression) === ctx.paramsSymbol
  ) {
    return undefined;
  }
  if (resolveStaticMemberAccess(link, ctx) || resolveThisStaticAccess(link, ctx)) return undefined;
  const structDef = resolveThisReceiverStructDef(link.expression, ctx);
  if (!structDef || !isIndexedStruct(structDef)) return undefined;
  const fieldName = link.name.text;
  const ci = ctx.classInfos.find((c) => c.name === bareClassName(structDef.name));
  if (ci?.getterFuncIds.has(fieldName)) return undefined;
  const field = findStructField(structDef, fieldName);
  return field ? { structDef, field } : undefined;
}

/**
 * Lowers `object`, the object a field store writes into, as a chain of
 * struct field reads that keeps every intermediate on the stack: a nil result
 * slot is pushed, the chain's root -- the first expression down `object` that
 * is not a struct field read by numeric id -- evaluates, then each link reads
 * its field from the intermediate below it, outermost first. The walk down
 * `object` passes through parentheses, `as` casts, and non-null assertions
 * around any link, and a link written as an optional access inside one of
 * those reads its field like any other link. Returns the links
 * innermost first, the order {@link emitFieldStore} writes them back in; an
 * object that is no such read returns no links and lowers as itself.
 *
 * A link through a read-only field of a struct type with field hooks refuses
 * the store: it reports {@link LoweringDiagCode.ReadOnlyFieldAssignment} and
 * returns undefined with nothing lowered.
 *
 * Stack effect: `[] -> [result, root, i1, ..., iN]`, `result` being the slot
 * {@link emitFieldStore} fills with the stored value and `iN` being
 * `object`'s value.
 */
function lowerFieldStoreObject(object: ts.Expression, ctx: LowerContext): FieldWriteBackLink[] | undefined {
  const links: FieldWriteBackLink[] = [];
  let root = unwrapTransparentExpression(object);
  while (ts.isPropertyAccessExpression(root)) {
    const resolved = structFieldOfLink(root, ctx);
    if (!resolved) break;
    const { structDef, field } = resolved;
    if (field.readOnly && (structDef.fieldGetter !== undefined || structDef.fieldSetter !== undefined)) {
      ctx.diagnostics.push(
        makeDiag(
          LoweringDiagCode.ReadOnlyFieldAssignment,
          `Cannot assign through read-only field '${field.name}': its value is a copy that cannot be written back`,
          root
        )
      );
      return undefined;
    }
    links.push({ fieldName: field.name, fieldIndex: field.fieldIndex });
    root = unwrapTransparentExpression(root.expression);
  }
  ctx.ir.push({ kind: "PushConst", value: NIL_VALUE });
  lowerExpression(root, ctx);
  for (let i = links.length - 1; i >= 0; i--) {
    ctx.ir.push({ kind: "Dup" });
    ctx.ir.push({ kind: "GetField", fieldName: links[i].fieldName, fieldIndex: links[i].fieldIndex });
  }
  return links;
}

/**
 * Stores the value on top of the stack into the innermost intermediate
 * {@link lowerFieldStoreObject} left on the stack, then writes each
 * intermediate back into the field of its parent it was read from, innermost
 * first, leaving the stored value as the assignment's result. Every
 * write-back runs: a field of a struct type with a field setter routes the
 * updated intermediate to the host state behind the parent, and a plain field
 * re-stores the reference it read, which changes nothing.
 *
 * `fieldIndex` is the stored field's slot in an indexed struct type; undefined
 * stores by name, with the field-name string beneath the value.
 *
 * Stack effect: `[result, root, i1, ..., iN, value] -> [value]`, or
 * `[result, root, i1, ..., iN, name, value] -> [value]` when storing by name.
 */
function emitFieldStore(links: readonly FieldWriteBackLink[], fieldIndex: number | undefined, ctx: LowerContext): void {
  const storeOperands = fieldIndex === undefined ? 2 : 1;
  ctx.ir.push({ kind: "Dup" });
  ctx.ir.push({ kind: "StackSetRel", d: links.length + 1 + storeOperands });
  ctx.ir.push(fieldIndex === undefined ? { kind: "SetField" } : { kind: "SetField", fieldIndex });
  for (const link of links) {
    ctx.ir.push({ kind: "SetField", fieldIndex: link.fieldIndex });
  }
  ctx.ir.push({ kind: "Pop" });
}

function lowerAssignment(expr: ts.BinaryExpression, ctx: LowerContext): void {
  if (ts.isElementAccessExpression(expr.left)) {
    lowerElementAccessAssignment(expr, ctx);
    return;
  }

  if (ts.isPropertyAccessExpression(expr.left) && expr.left.expression.kind === ts.SyntaxKind.ThisKeyword) {
    const thisStatic = resolveThisStaticAccess(expr.left, ctx);
    if (thisStatic) {
      lowerStaticFieldAssignment(expr, expr.left, thisStatic, ctx);
      return;
    }
    lowerThisFieldAssignment(expr, ctx);
    return;
  }

  if (ts.isPropertyAccessExpression(expr.left)) {
    const staticAccess = resolveStaticMemberAccess(expr.left, ctx);
    if (staticAccess) {
      lowerStaticFieldAssignment(expr, expr.left, staticAccess, ctx);
      return;
    }

    const lhsObjType = ctx.checker.getTypeAtLocation(expr.left.expression);
    const lhsStruct = resolveStructType(lhsObjType, ctx.services, ctx.projectNamespace, ctx.checker);
    if (lhsStruct) {
      const fName = expr.left.name.text;
      const clsName = bareClassName(lhsStruct.name);
      const ci = ctx.classInfos.find((c) => c.name === clsName);
      if (ci?.setterFuncIds.has(fName)) {
        if (expr.operatorToken.kind !== ts.SyntaxKind.EqualsToken) {
          const getterFuncName = `${clsName}$get_${fName}`;
          const getterFuncId = ctx.functionTable.get(getterFuncName);
          if (!ci.getterFuncIds.has(fName) || getterFuncId === undefined) {
            ctx.diagnostics.push(
              makeDiag(
                LoweringDiagCode.CompoundAssignRequiresGetterAndSetter,
                `Compound assignment on '${fName}' requires both a getter and a setter`,
                expr.operatorToken
              )
            );
            return;
          }
          const opId = compoundAssignmentToOpId(expr.operatorToken.kind);
          if (!opId) {
            ctx.diagnostics.push(
              makeDiag(
                LoweringDiagCode.UnsupportedCompoundAssignOperator,
                "Unsupported compound assignment operator",
                expr.operatorToken
              )
            );
            return;
          }
          const lhsType = ctx.checker.getTypeAtLocation(expr.left);
          const rhsType = ctx.checker.getTypeAtLocation(expr.right);
          const lhsTypeId = tsTypeToTypeId(lhsType, ctx.checker, ctx.services, ctx.projectNamespace);
          const rhsTypeId = tsTypeToTypeId(rhsType, ctx.checker, ctx.services, ctx.projectNamespace);
          if (!lhsTypeId || !rhsTypeId) {
            ctx.diagnostics.push(
              makeDiag(
                LoweringDiagCode.CannotDetermineTypesForCompoundAssign,
                "Cannot determine types for compound assignment",
                expr
              )
            );
            return;
          }
          const opFnName = resolveOperatorWithExpansion(opId, [lhsTypeId, rhsTypeId], ctx.services);
          if (!opFnName) {
            ctx.diagnostics.push(
              makeDiag(
                LoweringDiagCode.NoOperatorOverload,
                `No operator overload for ${opId}(${lhsTypeId}, ${rhsTypeId})`,
                expr
              )
            );
            return;
          }
          const setterFuncName = `${clsName}$set_${fName}`;
          const setterFuncId = ctx.functionTable.get(setterFuncName);
          if (setterFuncId !== undefined) {
            const tempLocal = ctx.scopeStack.allocLocal();
            lowerExpression(expr.left.expression, ctx);
            ctx.ir.push({ kind: "StoreLocal", index: tempLocal });
            ctx.ir.push({ kind: "LoadLocal", index: tempLocal });
            ctx.ir.push({ kind: "Call", funcIndex: getterFuncId, argc: 1 });
            lowerExpression(expr.right, ctx);
            ctx.ir.push({ kind: "HostCall", fnName: opFnName, argc: 2 });
            ctx.ir.push({ kind: "Dup" });
            ctx.ir.push({ kind: "LoadLocal", index: tempLocal });
            ctx.ir.push({ kind: "Swap" });
            ctx.ir.push({ kind: "Call", funcIndex: setterFuncId, argc: 2 });
            ctx.ir.push({ kind: "Pop" });
            return;
          }
        }
        const setterFuncName = `${clsName}$set_${fName}`;
        const funcId = ctx.functionTable.get(setterFuncName);
        if (funcId !== undefined) {
          lowerExpression(expr.right, ctx);
          ctx.ir.push({ kind: "Dup" });
          lowerExpression(expr.left.expression, ctx);
          ctx.ir.push({ kind: "Swap" });
          ctx.ir.push({ kind: "Call", funcIndex: funcId, argc: 2 });
          ctx.ir.push({ kind: "Pop" });
          return;
        }
      }

      const field = findStructField(lhsStruct, fName);
      if (field?.readOnly) {
        ctx.diagnostics.push(
          makeDiag(LoweringDiagCode.ReadOnlyFieldAssignment, `Cannot assign to read-only field '${fName}'`, expr.left)
        );
        return;
      }
      if (field) {
        if (expr.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
          const writeBacks = lowerFieldStoreObject(expr.left.expression, ctx);
          if (writeBacks === undefined) {
            return;
          }
          if (!isIndexedStruct(lhsStruct)) {
            ctx.ir.push({ kind: "PushConst", value: mkStringValue(fName) });
          }
          lowerExpression(expr.right, ctx);
          emitFieldStore(writeBacks, isIndexedStruct(lhsStruct) ? field.fieldIndex : undefined, ctx);
          return;
        }

        const opId = compoundAssignmentToOpId(expr.operatorToken.kind);
        if (!opId) {
          ctx.diagnostics.push(
            makeDiag(
              LoweringDiagCode.UnsupportedCompoundAssignOperator,
              "Unsupported compound assignment operator",
              expr.operatorToken
            )
          );
          return;
        }

        const lhsType = ctx.checker.getTypeAtLocation(expr.left);
        const rhsType = ctx.checker.getTypeAtLocation(expr.right);
        const lhsTypeId = tsTypeToTypeId(lhsType, ctx.checker, ctx.services, ctx.projectNamespace);
        const rhsTypeId = tsTypeToTypeId(rhsType, ctx.checker, ctx.services, ctx.projectNamespace);
        if (!lhsTypeId || !rhsTypeId) {
          ctx.diagnostics.push(
            makeDiag(
              LoweringDiagCode.CannotDetermineTypesForCompoundAssign,
              "Cannot determine types for compound assignment",
              expr
            )
          );
          return;
        }

        const opFnName = resolveOperatorWithExpansion(opId, [lhsTypeId, rhsTypeId], ctx.services);
        if (!opFnName) {
          ctx.diagnostics.push(
            makeDiag(
              LoweringDiagCode.NoOperatorOverload,
              `No operator overload for ${opId}(${lhsTypeId}, ${rhsTypeId})`,
              expr
            )
          );
          return;
        }

        const writeBacks = lowerFieldStoreObject(expr.left.expression, ctx);
        if (writeBacks === undefined) {
          return;
        }
        const tempObj = ctx.scopeStack.allocLocal();
        ctx.ir.push({ kind: "StoreLocal", index: tempObj });
        ctx.ir.push({ kind: "LoadLocal", index: tempObj });
        if (!isIndexedStruct(lhsStruct)) {
          ctx.ir.push({ kind: "PushConst", value: mkStringValue(fName) });
        }
        ctx.ir.push({ kind: "LoadLocal", index: tempObj });
        ctx.ir.push(
          isIndexedStruct(lhsStruct)
            ? { kind: "GetField", fieldName: fName, fieldIndex: field.fieldIndex }
            : { kind: "GetField", fieldName: fName }
        );
        lowerExpression(expr.right, ctx);
        ctx.ir.push({ kind: "HostCall", fnName: opFnName, argc: 2 });
        emitFieldStore(writeBacks, isIndexedStruct(lhsStruct) ? field.fieldIndex : undefined, ctx);
        return;
      }

      ctx.diagnostics.push(
        makeDiag(
          LoweringDiagCode.PropertyNotOnStruct,
          `Property '${fName}' is not an assignable field on '${lhsStruct.name}'`,
          expr.left
        )
      );
      return;
    }
  }

  if (ts.isPropertyAccessExpression(expr.left)) {
    const lhsObjType2 = ctx.checker.getTypeAtLocation(expr.left.expression);
    const fName2 = expr.left.name.text;
    const tsProps = lhsObjType2.getProperties();
    if (tsProps.length > 0 && tsProps.some((p) => p.getName() === fName2)) {
      if (expr.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        lowerExpression(expr.left.expression, ctx);
        ctx.ir.push({ kind: "PushConst", value: mkStringValue(fName2) });
        lowerExpression(expr.right, ctx);
        ctx.ir.push({ kind: "SetField" });
        return;
      }

      const opId = compoundAssignmentToOpId(expr.operatorToken.kind);
      if (!opId) {
        ctx.diagnostics.push(
          makeDiag(
            LoweringDiagCode.UnsupportedCompoundAssignOperator,
            "Unsupported compound assignment operator",
            expr.operatorToken
          )
        );
        return;
      }

      const lhsType = ctx.checker.getTypeAtLocation(expr.left);
      const rhsType = ctx.checker.getTypeAtLocation(expr.right);
      const lhsTypeId = tsTypeToTypeId(lhsType, ctx.checker, ctx.services, ctx.projectNamespace);
      const rhsTypeId = tsTypeToTypeId(rhsType, ctx.checker, ctx.services, ctx.projectNamespace);
      if (!lhsTypeId || !rhsTypeId) {
        ctx.diagnostics.push(
          makeDiag(
            LoweringDiagCode.CannotDetermineTypesForCompoundAssign,
            "Cannot determine types for compound assignment",
            expr
          )
        );
        return;
      }

      const opFnName = resolveOperatorWithExpansion(opId, [lhsTypeId, rhsTypeId], ctx.services);
      if (!opFnName) {
        ctx.diagnostics.push(
          makeDiag(
            LoweringDiagCode.NoOperatorOverload,
            `No operator overload for ${opId}(${lhsTypeId}, ${rhsTypeId})`,
            expr
          )
        );
        return;
      }

      const tempObj = ctx.scopeStack.allocLocal();
      lowerExpression(expr.left.expression, ctx);
      ctx.ir.push({ kind: "StoreLocal", index: tempObj });
      ctx.ir.push({ kind: "LoadLocal", index: tempObj });
      ctx.ir.push({ kind: "PushConst", value: mkStringValue(fName2) });
      ctx.ir.push({ kind: "LoadLocal", index: tempObj });
      ctx.ir.push({ kind: "GetField", fieldName: fName2 });
      lowerExpression(expr.right, ctx);
      ctx.ir.push({ kind: "HostCall", fnName: opFnName, argc: 2 });
      ctx.ir.push({ kind: "SetField" });
      return;
    }

    ctx.diagnostics.push(
      makeDiag(LoweringDiagCode.AssignmentTargetNotVariable, "Assignment target must be a variable", expr.left)
    );
    return;
  }

  if (!ts.isIdentifier(expr.left)) {
    ctx.diagnostics.push(
      makeDiag(LoweringDiagCode.AssignmentTargetNotVariable, "Assignment target must be a variable", expr.left)
    );
    return;
  }

  const target = resolveVarTarget(expr.left.text, ctx);
  if (!target) {
    ctx.diagnostics.push(
      makeDiag(LoweringDiagCode.UndefinedVariable, `Undefined variable: ${expr.left.text}`, expr.left)
    );
    return;
  }

  if (
    expr.operatorToken.kind === ts.SyntaxKind.QuestionQuestionEqualsToken ||
    expr.operatorToken.kind === ts.SyntaxKind.BarBarEqualsToken ||
    expr.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandEqualsToken
  ) {
    lowerLogicalAssignment(expr, target, ctx);
    return;
  }

  if (expr.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    lowerExpressionWithExpectedType(
      expr.right,
      resolveExpressionTypeId(expr.left, ctx),
      `assignment to '${expr.left.text}'`,
      expr.right,
      ctx
    );
    checkStructAssignmentCompat(expr.left, expr.right, expr, ctx);
  } else {
    emitLoad(target, ctx);
    lowerExpression(expr.right, ctx);

    const opId = compoundAssignmentToOpId(expr.operatorToken.kind);
    if (!opId) {
      ctx.diagnostics.push(
        makeDiag(
          LoweringDiagCode.UnsupportedCompoundAssignOperator,
          "Unsupported compound assignment operator",
          expr.operatorToken
        )
      );
      return;
    }

    const lhsType = ctx.checker.getTypeAtLocation(expr.left);
    const rhsType = ctx.checker.getTypeAtLocation(expr.right);
    const lhsTypeId = tsTypeToTypeId(lhsType, ctx.checker, ctx.services, ctx.projectNamespace);
    const rhsTypeId = tsTypeToTypeId(rhsType, ctx.checker, ctx.services, ctx.projectNamespace);

    if (!lhsTypeId || !rhsTypeId) {
      ctx.diagnostics.push(
        makeDiag(
          LoweringDiagCode.CannotDetermineTypesForCompoundAssign,
          "Cannot determine types for compound assignment",
          expr
        )
      );
      return;
    }

    const fnName = resolveOperatorWithExpansion(opId, [lhsTypeId, rhsTypeId], ctx.services);
    if (!fnName) {
      ctx.diagnostics.push(
        makeDiag(
          LoweringDiagCode.NoOperatorOverload,
          `No operator overload for ${opId}(${lhsTypeId}, ${rhsTypeId})`,
          expr
        )
      );
      return;
    }
    ctx.ir.push({ kind: "HostCall", fnName, argc: 2 });
  }

  ctx.ir.push({ kind: "Dup" });
  emitStore(target, ctx);
}

function lowerThisFieldAssignment(expr: ts.BinaryExpression, ctx: LowerContext): void {
  const propAccess = expr.left as ts.PropertyAccessExpression;
  const fieldName = propAccess.name.text;

  if (ctx.thisLocalIndex === undefined) {
    ctx.diagnostics.push(
      makeDiag(
        LoweringDiagCode.ThisOutsideClassContext,
        "'this' can only be used inside a class constructor or method",
        propAccess.expression
      )
    );
    return;
  }

  const structDef = resolveThisReceiverStructDef(propAccess.expression, ctx);
  if (structDef) {
    const className = bareClassName(structDef.name);
    const ci = ctx.classInfos.find((c) => c.name === className);
    if (ci?.setterFuncIds.has(fieldName)) {
      if (expr.operatorToken.kind !== ts.SyntaxKind.EqualsToken) {
        const getterFuncName = `${className}$get_${fieldName}`;
        const getterFuncId = ctx.functionTable.get(getterFuncName);
        if (!ci.getterFuncIds.has(fieldName) || getterFuncId === undefined) {
          ctx.diagnostics.push(
            makeDiag(
              LoweringDiagCode.CompoundAssignRequiresGetterAndSetter,
              `Compound assignment on '${fieldName}' requires both a getter and a setter`,
              expr.operatorToken
            )
          );
          return;
        }
        const opId = compoundAssignmentToOpId(expr.operatorToken.kind);
        if (!opId) {
          ctx.diagnostics.push(
            makeDiag(
              LoweringDiagCode.UnsupportedCompoundAssignOperator,
              "Unsupported compound assignment operator",
              expr.operatorToken
            )
          );
          return;
        }
        const lhsType = ctx.checker.getTypeAtLocation(expr.left);
        const rhsType = ctx.checker.getTypeAtLocation(expr.right);
        const lhsTypeId = tsTypeToTypeId(lhsType, ctx.checker, ctx.services, ctx.projectNamespace);
        const rhsTypeId = tsTypeToTypeId(rhsType, ctx.checker, ctx.services, ctx.projectNamespace);
        if (!lhsTypeId || !rhsTypeId) {
          ctx.diagnostics.push(
            makeDiag(
              LoweringDiagCode.CannotDetermineTypesForCompoundAssign,
              "Cannot determine types for compound assignment",
              expr
            )
          );
          return;
        }
        const fnName = resolveOperatorWithExpansion(opId, [lhsTypeId, rhsTypeId], ctx.services);
        if (!fnName) {
          ctx.diagnostics.push(
            makeDiag(
              LoweringDiagCode.NoOperatorOverload,
              `No operator overload for ${opId}(${lhsTypeId}, ${rhsTypeId})`,
              expr
            )
          );
          return;
        }
        const setterFuncName = `${className}$set_${fieldName}`;
        const setterFuncId = ctx.functionTable.get(setterFuncName);
        if (setterFuncId !== undefined) {
          ctx.ir.push({ kind: "LoadLocal", index: ctx.thisLocalIndex });
          ctx.ir.push({ kind: "Call", funcIndex: getterFuncId, argc: 1 });
          lowerExpression(expr.right, ctx);
          ctx.ir.push({ kind: "HostCall", fnName, argc: 2 });
          ctx.ir.push({ kind: "Dup" });
          ctx.ir.push({ kind: "LoadLocal", index: ctx.thisLocalIndex });
          ctx.ir.push({ kind: "Swap" });
          ctx.ir.push({ kind: "Call", funcIndex: setterFuncId, argc: 2 });
          ctx.ir.push({ kind: "Pop" });
          return;
        }
      }
      const funcName = `${className}$set_${fieldName}`;
      const funcId = ctx.functionTable.get(funcName);
      if (funcId !== undefined) {
        lowerExpression(expr.right, ctx);
        ctx.ir.push({ kind: "Dup" });
        ctx.ir.push({ kind: "LoadLocal", index: ctx.thisLocalIndex });
        ctx.ir.push({ kind: "Swap" });
        ctx.ir.push({ kind: "Call", funcIndex: funcId, argc: 2 });
        ctx.ir.push({ kind: "Pop" });
        return;
      }
    }
  }

  const field = structDef ? findStructField(structDef, fieldName) : undefined;
  if (!field) {
    ctx.diagnostics.push(
      makeDiag(LoweringDiagCode.PropertyNotOnStruct, `Cannot resolve field id for '${fieldName}'`, expr.left)
    );
    return;
  }
  const fieldIndex = field.fieldIndex;

  if (expr.operatorToken.kind !== ts.SyntaxKind.EqualsToken) {
    const opId = compoundAssignmentToOpId(expr.operatorToken.kind);
    if (!opId) {
      ctx.diagnostics.push(
        makeDiag(
          LoweringDiagCode.UnsupportedCompoundAssignOperator,
          "Unsupported compound assignment operator",
          expr.operatorToken
        )
      );
      return;
    }

    const lhsType = ctx.checker.getTypeAtLocation(expr.left);
    const rhsType = ctx.checker.getTypeAtLocation(expr.right);
    const lhsTypeId = tsTypeToTypeId(lhsType, ctx.checker, ctx.services, ctx.projectNamespace);
    const rhsTypeId = tsTypeToTypeId(rhsType, ctx.checker, ctx.services, ctx.projectNamespace);

    if (!lhsTypeId || !rhsTypeId) {
      ctx.diagnostics.push(
        makeDiag(
          LoweringDiagCode.CannotDetermineTypesForCompoundAssign,
          "Cannot determine types for compound assignment",
          expr
        )
      );
      return;
    }

    const fnName = resolveOperatorWithExpansion(opId, [lhsTypeId, rhsTypeId], ctx.services);
    if (!fnName) {
      ctx.diagnostics.push(
        makeDiag(
          LoweringDiagCode.NoOperatorOverload,
          `No operator overload for ${opId}(${lhsTypeId}, ${rhsTypeId})`,
          expr
        )
      );
      return;
    }

    ctx.ir.push({ kind: "LoadLocal", index: ctx.thisLocalIndex });
    ctx.ir.push({ kind: "GetField", fieldName, fieldIndex });
    lowerExpression(expr.right, ctx);
    ctx.ir.push({ kind: "HostCall", fnName, argc: 2 });
    ctx.ir.push({ kind: "Dup" });
    ctx.ir.push({ kind: "LoadLocal", index: ctx.thisLocalIndex });
    ctx.ir.push({ kind: "Swap" });
    ctx.ir.push({ kind: "StructSet", fieldIndex });
    ctx.ir.push({ kind: "StoreLocal", index: ctx.thisLocalIndex });
    return;
  }

  lowerExpression(expr.right, ctx);
  ctx.ir.push({ kind: "Dup" });
  ctx.ir.push({ kind: "LoadLocal", index: ctx.thisLocalIndex });
  ctx.ir.push({ kind: "Swap" });
  ctx.ir.push({ kind: "StructSet", fieldIndex });
  ctx.ir.push({ kind: "StoreLocal", index: ctx.thisLocalIndex });
}

function lowerStaticFieldAssignment(
  expr: ts.BinaryExpression,
  propAccess: ts.PropertyAccessExpression,
  staticAccess: NonNullable<StaticMemberAccessResolution>,
  ctx: LowerContext
): void {
  if (staticAccess.kind === "method") {
    const lhsText = ts.isIdentifier(propAccess.expression) ? propAccess.expression.text : "this";
    ctx.diagnostics.push(
      makeDiag(
        LoweringDiagCode.AssignmentTargetNotVariable,
        `'${lhsText}.${propAccess.name.text}' is a static method, not an assignable field`,
        propAccess
      )
    );
    return;
  }
  if (staticAccess.kind === "getter") {
    const memberName = propAccess.name.text;
    let setterFuncName: string | undefined;
    if (propAccess.expression.kind === ts.SyntaxKind.ThisKeyword) {
      const ci = ctx.staticClassInfo;
      if (ci?.staticSetterFuncIds.has(memberName)) {
        setterFuncName = `${ci.name}$set_${memberName}`;
      }
    } else if (ts.isIdentifier(propAccess.expression)) {
      const sym = resolveAliasedSymbol(ctx.checker.getSymbolAtLocation(propAccess.expression), ctx.checker);
      const classDecl = sym ? resolveClassDeclaration(sym, ctx.checker) : undefined;
      const className = classDecl?.name?.text;
      if (className) {
        const ci = ctx.classInfos.find((c) => c.name === className && c.node === classDecl);
        if (ci?.staticSetterFuncIds.has(memberName)) {
          setterFuncName = `${className}$set_${memberName}`;
        }
      }
    }
    if (setterFuncName) {
      if (expr.operatorToken.kind !== ts.SyntaxKind.EqualsToken) {
        const opId = compoundAssignmentToOpId(expr.operatorToken.kind);
        if (!opId) {
          ctx.diagnostics.push(
            makeDiag(
              LoweringDiagCode.UnsupportedCompoundAssignOperator,
              "Unsupported compound assignment operator",
              expr.operatorToken
            )
          );
          return;
        }
        const lhsType = ctx.checker.getTypeAtLocation(expr.left);
        const rhsType = ctx.checker.getTypeAtLocation(expr.right);
        const lhsTypeId = tsTypeToTypeId(lhsType, ctx.checker, ctx.services, ctx.projectNamespace);
        const rhsTypeId = tsTypeToTypeId(rhsType, ctx.checker, ctx.services, ctx.projectNamespace);
        if (!lhsTypeId || !rhsTypeId) {
          ctx.diagnostics.push(
            makeDiag(
              LoweringDiagCode.CannotDetermineTypesForCompoundAssign,
              "Cannot determine types for compound assignment",
              expr
            )
          );
          return;
        }
        const opFnName = resolveOperatorWithExpansion(opId, [lhsTypeId, rhsTypeId], ctx.services);
        if (!opFnName) {
          ctx.diagnostics.push(
            makeDiag(
              LoweringDiagCode.NoOperatorOverload,
              `No operator overload for ${opId}(${lhsTypeId}, ${rhsTypeId})`,
              expr
            )
          );
          return;
        }
        const getterFuncId = ctx.functionTable.get(staticAccess.funcName);
        const setterFuncId = ctx.functionTable.get(setterFuncName);
        if (getterFuncId !== undefined && setterFuncId !== undefined) {
          ctx.ir.push({ kind: "Call", funcIndex: getterFuncId, argc: 0 });
          lowerExpression(expr.right, ctx);
          ctx.ir.push({ kind: "HostCall", fnName: opFnName, argc: 2 });
          ctx.ir.push({ kind: "Dup" });
          ctx.ir.push({ kind: "Call", funcIndex: setterFuncId, argc: 1 });
          ctx.ir.push({ kind: "Pop" });
          return;
        }
      }
      const funcId = ctx.functionTable.get(setterFuncName);
      if (funcId !== undefined) {
        lowerExpression(expr.right, ctx);
        ctx.ir.push({ kind: "Dup" });
        ctx.ir.push({ kind: "Call", funcIndex: funcId, argc: 1 });
        ctx.ir.push({ kind: "Pop" });
        return;
      }
    }
    const lhsText = ts.isIdentifier(propAccess.expression) ? propAccess.expression.text : "this";
    ctx.diagnostics.push(
      makeDiag(
        LoweringDiagCode.AssignmentTargetNotVariable,
        `'${lhsText}.${propAccess.name.text}' is a getter, not an assignable field`,
        propAccess
      )
    );
    return;
  }
  if (staticAccess.kind === "setter") {
    if (expr.operatorToken.kind !== ts.SyntaxKind.EqualsToken) {
      ctx.diagnostics.push(
        makeDiag(
          LoweringDiagCode.CompoundAssignRequiresGetterAndSetter,
          `Compound assignment on '${propAccess.name.text}' requires both a getter and a setter`,
          expr.operatorToken
        )
      );
      return;
    }
    const funcId = ctx.functionTable.get(staticAccess.funcName);
    if (funcId !== undefined) {
      lowerExpression(expr.right, ctx);
      ctx.ir.push({ kind: "Dup" });
      ctx.ir.push({ kind: "Call", funcIndex: funcId, argc: 1 });
      ctx.ir.push({ kind: "Pop" });
      return;
    }
    ctx.diagnostics.push(
      makeDiag(
        LoweringDiagCode.NoSuchStaticMember,
        `No static member '${propAccess.name.text}' exists on class '${ts.isIdentifier(propAccess.expression) ? propAccess.expression.text : "this"}'`,
        propAccess
      )
    );
    return;
  }
  if (staticAccess.kind === "no-such-member") {
    const lhsText = ts.isIdentifier(propAccess.expression) ? propAccess.expression.text : "this";
    ctx.diagnostics.push(
      makeDiag(
        LoweringDiagCode.NoSuchStaticMember,
        `No static member '${propAccess.name.text}' exists on class '${lhsText}'`,
        propAccess
      )
    );
    return;
  }

  const slot = staticAccess.callsiteVarIndex;

  if (expr.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    const lhsText = ts.isIdentifier(propAccess.expression) ? propAccess.expression.text : "this";
    lowerExpressionWithExpectedType(
      expr.right,
      resolveExpressionTypeId(propAccess, ctx),
      `assignment to '${lhsText}.${propAccess.name.text}'`,
      expr.right,
      ctx
    );
  } else {
    const opId = compoundAssignmentToOpId(expr.operatorToken.kind);
    if (!opId) {
      ctx.diagnostics.push(
        makeDiag(
          LoweringDiagCode.UnsupportedCompoundAssignOperator,
          "Unsupported compound assignment operator",
          expr.operatorToken
        )
      );
      return;
    }

    const lhsType = ctx.checker.getTypeAtLocation(expr.left);
    const rhsType = ctx.checker.getTypeAtLocation(expr.right);
    const lhsTypeId = tsTypeToTypeId(lhsType, ctx.checker, ctx.services, ctx.projectNamespace);
    const rhsTypeId = tsTypeToTypeId(rhsType, ctx.checker, ctx.services, ctx.projectNamespace);

    if (!lhsTypeId || !rhsTypeId) {
      ctx.diagnostics.push(
        makeDiag(
          LoweringDiagCode.CannotDetermineTypesForCompoundAssign,
          "Cannot determine types for compound assignment",
          expr
        )
      );
      return;
    }

    const fnName = resolveOperatorWithExpansion(opId, [lhsTypeId, rhsTypeId], ctx.services);
    if (!fnName) {
      ctx.diagnostics.push(
        makeDiag(
          LoweringDiagCode.NoOperatorOverload,
          `No operator overload for ${opId}(${lhsTypeId}, ${rhsTypeId})`,
          expr
        )
      );
      return;
    }

    ctx.ir.push({ kind: "LoadCallsiteVar", index: slot });
    lowerExpression(expr.right, ctx);
    ctx.ir.push({ kind: "HostCall", fnName, argc: 2 });
  }

  ctx.ir.push({ kind: "Dup" });
  ctx.ir.push({ kind: "StoreCallsiteVar", index: slot });
}

function compoundAssignmentToOpId(kind: ts.SyntaxKind): string | undefined {
  switch (kind) {
    case ts.SyntaxKind.PlusEqualsToken:
      return CoreOpId.Add;
    case ts.SyntaxKind.MinusEqualsToken:
      return CoreOpId.Subtract;
    case ts.SyntaxKind.AsteriskEqualsToken:
      return CoreOpId.Multiply;
    case ts.SyntaxKind.SlashEqualsToken:
      return CoreOpId.Divide;
    case ts.SyntaxKind.PercentEqualsToken:
      return CoreOpId.Modulo;
    case ts.SyntaxKind.AsteriskAsteriskEqualsToken:
      return CoreOpId.Power;
    case ts.SyntaxKind.AmpersandEqualsToken:
      return CoreOpId.BitwiseAnd;
    case ts.SyntaxKind.BarEqualsToken:
      return CoreOpId.BitwiseOr;
    case ts.SyntaxKind.CaretEqualsToken:
      return CoreOpId.BitwiseXor;
    case ts.SyntaxKind.LessThanLessThanEqualsToken:
      return CoreOpId.LeftShift;
    case ts.SyntaxKind.GreaterThanGreaterThanEqualsToken:
      return CoreOpId.RightShift;
    default:
      return undefined;
  }
}

function lowerPrefixUnary(expr: ts.PrefixUnaryExpression, ctx: LowerContext): void {
  if (expr.operator === ts.SyntaxKind.MinusToken) {
    if (ts.isNumericLiteral(expr.operand)) {
      ctx.ir.push({ kind: "PushConst", value: mkNumberValue(-Number(expr.operand.text)) });
    } else {
      lowerExpression(expr.operand, ctx);
      const fnName = resolveOperator(CoreOpId.Negate, [CoreTypeIds.Number], ctx.services);
      if (!fnName) {
        ctx.diagnostics.push(makeDiag(LoweringDiagCode.NoOperatorOverload, "No operator overload for negation", expr));
        return;
      }
      ctx.ir.push({ kind: "HostCall", fnName, argc: 1 });
    }
  } else if (expr.operator === ts.SyntaxKind.ExclamationToken) {
    lowerExpression(expr.operand, ctx);
    const operandType = ctx.checker.getTypeAtLocation(expr.operand);
    const operandTypeId = tsTypeToTypeId(operandType, ctx.checker, ctx.services, ctx.projectNamespace);
    if (!operandTypeId) {
      ctx.diagnostics.push(
        makeDiag(LoweringDiagCode.CannotDetermineTypeForNotOperand, "Cannot determine type for `!` operand", expr)
      );
      return;
    }
    const nullableBase = nullableCoreType(operandTypeId, ctx.services);
    if (nullableBase !== undefined && ALWAYS_TRUTHY_CORE_TYPES.includes(nullableBase)) {
      // A present value of these types is always truthy, so `!x` is exactly
      // the nil test.
      ctx.ir.push({ kind: "TypeCheck", nativeType: NativeType.Nil });
      return;
    }
    if (
      nullableBase === NativeType.Boolean ||
      nullableBase === NativeType.Number ||
      nullableBase === NativeType.String
    ) {
      ctx.diagnostics.push(
        makeDiag(
          LoweringDiagCode.NotOnNullablePrimitive,
          '`!` on a maybe-absent number, string, or boolean conflates absence with 0, "", or false; compare `=== undefined` to test absence',
          expr
        )
      );
      return;
    }
    const fnName = resolveOperatorWithExpansion(CoreOpId.Not, [operandTypeId], ctx.services);
    if (!fnName) {
      ctx.diagnostics.push(
        makeDiag(LoweringDiagCode.NoOperatorOverload, `No operator overload for !(${operandTypeId})`, expr)
      );
      return;
    }
    ctx.ir.push({ kind: "HostCall", fnName, argc: 1 });
  } else if (expr.operator === ts.SyntaxKind.PlusPlusToken || expr.operator === ts.SyntaxKind.MinusMinusToken) {
    lowerPrefixIncDec(expr, ctx);
  } else if (expr.operator === ts.SyntaxKind.TildeToken) {
    lowerExpression(expr.operand, ctx);
    const fnName = resolveOperator(CoreOpId.BitwiseNot, [CoreTypeIds.Number], ctx.services);
    if (!fnName) {
      ctx.diagnostics.push(makeDiag(LoweringDiagCode.NoOperatorOverload, "No operator overload for bitwise NOT", expr));
      return;
    }
    ctx.ir.push({ kind: "HostCall", fnName, argc: 1 });
  } else {
    ctx.diagnostics.push(
      makeDiag(
        LoweringDiagCode.UnsupportedPrefixOperator,
        `Unsupported prefix operator: ${ts.SyntaxKind[expr.operator]}`,
        expr
      )
    );
  }
}

function resolveStaticGetterSetterPair(
  propAccess: ts.PropertyAccessExpression,
  staticAccess: { kind: "getter"; funcName: string },
  ctx: LowerContext
): { getterFuncId: number; setterFuncId: number } | undefined {
  const memberName = propAccess.name.text;
  let setterFuncName: string | undefined;
  if (propAccess.expression.kind === ts.SyntaxKind.ThisKeyword) {
    const ci = ctx.staticClassInfo;
    if (ci?.staticSetterFuncIds.has(memberName)) {
      setterFuncName = `${ci.name}$set_${memberName}`;
    }
  } else if (ts.isIdentifier(propAccess.expression)) {
    const sym = resolveAliasedSymbol(ctx.checker.getSymbolAtLocation(propAccess.expression), ctx.checker);
    const classDecl = sym ? resolveClassDeclaration(sym, ctx.checker) : undefined;
    const className = classDecl?.name?.text;
    if (className) {
      const ci = ctx.classInfos.find((c) => c.name === className && c.node === classDecl);
      if (ci?.staticSetterFuncIds.has(memberName)) {
        setterFuncName = `${className}$set_${memberName}`;
      }
    }
  }
  if (!setterFuncName) return undefined;
  const getterFuncId = ctx.functionTable.get(staticAccess.funcName);
  const setterFuncId = ctx.functionTable.get(setterFuncName);
  if (getterFuncId === undefined || setterFuncId === undefined) return undefined;
  return { getterFuncId, setterFuncId };
}

function lowerPrefixIncDecStaticGetterSetter(
  expr: ts.PrefixUnaryExpression,
  operand: ts.PropertyAccessExpression,
  staticAccess: { kind: "getter"; funcName: string },
  ctx: LowerContext
): void {
  const pair = resolveStaticGetterSetterPair(operand, staticAccess, ctx);
  if (!pair) {
    ctx.diagnostics.push(
      makeDiag(
        LoweringDiagCode.CompoundAssignRequiresGetterAndSetter,
        `Increment/decrement on '${operand.name.text}' requires both a getter and a setter`,
        operand
      )
    );
    return;
  }
  const opId = expr.operator === ts.SyntaxKind.PlusPlusToken ? CoreOpId.Add : CoreOpId.Subtract;
  const typeId = CoreTypeIds.Number;
  const fnName = resolveOperator(opId, [typeId, typeId], ctx.services);
  if (!fnName) {
    ctx.diagnostics.push(
      makeDiag(LoweringDiagCode.NoOperatorOverload, `No operator overload for ${opId}(${typeId}, ${typeId})`, expr)
    );
    return;
  }
  ctx.ir.push({ kind: "Call", funcIndex: pair.getterFuncId, argc: 0 });
  ctx.ir.push({ kind: "PushConst", value: mkNumberValue(1) });
  ctx.ir.push({ kind: "HostCall", fnName, argc: 2 });
  ctx.ir.push({ kind: "Dup" });
  ctx.ir.push({ kind: "Call", funcIndex: pair.setterFuncId, argc: 1 });
  ctx.ir.push({ kind: "Pop" });
}

function lowerPostfixIncDecStaticGetterSetter(
  expr: ts.PostfixUnaryExpression,
  operand: ts.PropertyAccessExpression,
  staticAccess: { kind: "getter"; funcName: string },
  ctx: LowerContext
): void {
  const pair = resolveStaticGetterSetterPair(operand, staticAccess, ctx);
  if (!pair) {
    ctx.diagnostics.push(
      makeDiag(
        LoweringDiagCode.CompoundAssignRequiresGetterAndSetter,
        `Increment/decrement on '${operand.name.text}' requires both a getter and a setter`,
        operand
      )
    );
    return;
  }
  const opId = expr.operator === ts.SyntaxKind.PlusPlusToken ? CoreOpId.Add : CoreOpId.Subtract;
  const typeId = CoreTypeIds.Number;
  const fnName = resolveOperator(opId, [typeId, typeId], ctx.services);
  if (!fnName) {
    ctx.diagnostics.push(
      makeDiag(LoweringDiagCode.NoOperatorOverload, `No operator overload for ${opId}(${typeId}, ${typeId})`, expr)
    );
    return;
  }
  ctx.ir.push({ kind: "Call", funcIndex: pair.getterFuncId, argc: 0 });
  ctx.ir.push({ kind: "Dup" });
  ctx.ir.push({ kind: "PushConst", value: mkNumberValue(1) });
  ctx.ir.push({ kind: "HostCall", fnName, argc: 2 });
  ctx.ir.push({ kind: "Call", funcIndex: pair.setterFuncId, argc: 1 });
  ctx.ir.push({ kind: "Pop" });
}

/**
 * Resolve a `this.field` operand to its System state-struct field id when
 * lowering inside a System body. Returns `undefined` outside a System body or
 * when the field is not on the state struct.
 */
function resolveSystemThisField(
  operand: ts.PropertyAccessExpression,
  ctx: LowerContext
): { fieldName: string; fieldIndex: number } | undefined {
  if (operand.expression.kind !== ts.SyntaxKind.ThisKeyword) return undefined;
  if (ctx.thisStructTypeId === undefined || ctx.thisLocalIndex === undefined) return undefined;
  const structDef = resolveThisReceiverStructDef(operand.expression, ctx);
  if (!structDef) return undefined;
  const field = findStructField(structDef, operand.name.text);
  if (!field) return undefined;
  return { fieldName: operand.name.text, fieldIndex: field.fieldIndex };
}

function resolveInstanceGetterSetterPair(
  operand: ts.PropertyAccessExpression,
  ctx: LowerContext
): { getterFuncId: number; setterFuncId: number; isThis: boolean } | undefined {
  const fieldName = operand.name.text;
  const objType = ctx.checker.getTypeAtLocation(operand.expression);
  const structDef = resolveStructType(objType, ctx.services, ctx.projectNamespace, ctx.checker);
  if (!structDef) return undefined;
  const className = bareClassName(structDef.name);
  const ci = ctx.classInfos.find((c) => c.name === className);
  if (!ci?.getterFuncIds.has(fieldName) || !ci.setterFuncIds.has(fieldName)) return undefined;
  const getterFuncName = `${className}$get_${fieldName}`;
  const setterFuncName = `${className}$set_${fieldName}`;
  const getterFuncId = ctx.functionTable.get(getterFuncName);
  const setterFuncId = ctx.functionTable.get(setterFuncName);
  if (getterFuncId === undefined || setterFuncId === undefined) return undefined;
  const isThis = operand.expression.kind === ts.SyntaxKind.ThisKeyword;
  return { getterFuncId, setterFuncId, isThis };
}

function lowerPrefixIncDecInstanceGetterSetter(
  expr: ts.PrefixUnaryExpression,
  operand: ts.PropertyAccessExpression,
  ctx: LowerContext
): true | undefined {
  const pair = resolveInstanceGetterSetterPair(operand, ctx);
  if (!pair) return undefined;
  const opId = expr.operator === ts.SyntaxKind.PlusPlusToken ? CoreOpId.Add : CoreOpId.Subtract;
  const typeId = CoreTypeIds.Number;
  const fnName = resolveOperator(opId, [typeId, typeId], ctx.services);
  if (!fnName) {
    ctx.diagnostics.push(
      makeDiag(LoweringDiagCode.NoOperatorOverload, `No operator overload for ${opId}(${typeId}, ${typeId})`, expr)
    );
    return true;
  }
  if (pair.isThis) {
    if (ctx.thisLocalIndex === undefined) {
      ctx.diagnostics.push(
        makeDiag(
          LoweringDiagCode.ThisOutsideClassContext,
          "'this' can only be used inside a class constructor or method",
          operand.expression
        )
      );
      return true;
    }
    ctx.ir.push({ kind: "LoadLocal", index: ctx.thisLocalIndex });
    ctx.ir.push({ kind: "Call", funcIndex: pair.getterFuncId, argc: 1 });
    ctx.ir.push({ kind: "PushConst", value: mkNumberValue(1) });
    ctx.ir.push({ kind: "HostCall", fnName, argc: 2 });
    ctx.ir.push({ kind: "Dup" });
    ctx.ir.push({ kind: "LoadLocal", index: ctx.thisLocalIndex });
    ctx.ir.push({ kind: "Swap" });
    ctx.ir.push({ kind: "Call", funcIndex: pair.setterFuncId, argc: 2 });
    ctx.ir.push({ kind: "Pop" });
  } else {
    const tempLocal = ctx.scopeStack.allocLocal();
    lowerExpression(operand.expression, ctx);
    ctx.ir.push({ kind: "StoreLocal", index: tempLocal });
    ctx.ir.push({ kind: "LoadLocal", index: tempLocal });
    ctx.ir.push({ kind: "Call", funcIndex: pair.getterFuncId, argc: 1 });
    ctx.ir.push({ kind: "PushConst", value: mkNumberValue(1) });
    ctx.ir.push({ kind: "HostCall", fnName, argc: 2 });
    ctx.ir.push({ kind: "Dup" });
    ctx.ir.push({ kind: "LoadLocal", index: tempLocal });
    ctx.ir.push({ kind: "Swap" });
    ctx.ir.push({ kind: "Call", funcIndex: pair.setterFuncId, argc: 2 });
    ctx.ir.push({ kind: "Pop" });
  }
  return true;
}

function lowerPostfixIncDecInstanceGetterSetter(
  expr: ts.PostfixUnaryExpression,
  operand: ts.PropertyAccessExpression,
  ctx: LowerContext
): true | undefined {
  const pair = resolveInstanceGetterSetterPair(operand, ctx);
  if (!pair) return undefined;
  const opId = expr.operator === ts.SyntaxKind.PlusPlusToken ? CoreOpId.Add : CoreOpId.Subtract;
  const typeId = CoreTypeIds.Number;
  const fnName = resolveOperator(opId, [typeId, typeId], ctx.services);
  if (!fnName) {
    ctx.diagnostics.push(
      makeDiag(LoweringDiagCode.NoOperatorOverload, `No operator overload for ${opId}(${typeId}, ${typeId})`, expr)
    );
    return true;
  }
  if (pair.isThis) {
    if (ctx.thisLocalIndex === undefined) {
      ctx.diagnostics.push(
        makeDiag(
          LoweringDiagCode.ThisOutsideClassContext,
          "'this' can only be used inside a class constructor or method",
          operand.expression
        )
      );
      return true;
    }
    ctx.ir.push({ kind: "LoadLocal", index: ctx.thisLocalIndex });
    ctx.ir.push({ kind: "Call", funcIndex: pair.getterFuncId, argc: 1 });
    ctx.ir.push({ kind: "Dup" });
    ctx.ir.push({ kind: "PushConst", value: mkNumberValue(1) });
    ctx.ir.push({ kind: "HostCall", fnName, argc: 2 });
    ctx.ir.push({ kind: "LoadLocal", index: ctx.thisLocalIndex });
    ctx.ir.push({ kind: "Swap" });
    ctx.ir.push({ kind: "Call", funcIndex: pair.setterFuncId, argc: 2 });
    ctx.ir.push({ kind: "Pop" });
  } else {
    const tempLocal = ctx.scopeStack.allocLocal();
    lowerExpression(operand.expression, ctx);
    ctx.ir.push({ kind: "StoreLocal", index: tempLocal });
    ctx.ir.push({ kind: "LoadLocal", index: tempLocal });
    ctx.ir.push({ kind: "Call", funcIndex: pair.getterFuncId, argc: 1 });
    ctx.ir.push({ kind: "Dup" });
    ctx.ir.push({ kind: "PushConst", value: mkNumberValue(1) });
    ctx.ir.push({ kind: "HostCall", fnName, argc: 2 });
    ctx.ir.push({ kind: "LoadLocal", index: tempLocal });
    ctx.ir.push({ kind: "Swap" });
    ctx.ir.push({ kind: "Call", funcIndex: pair.setterFuncId, argc: 2 });
    ctx.ir.push({ kind: "Pop" });
  }
  return true;
}

function lowerPrefixIncDec(expr: ts.PrefixUnaryExpression, ctx: LowerContext): void {
  let loadEmit: () => void;
  let storeEmit: () => void;

  if (ts.isPropertyAccessExpression(expr.operand)) {
    const staticAccess = resolveStaticMemberAccess(expr.operand, ctx) ?? resolveThisStaticAccess(expr.operand, ctx);
    if (staticAccess) {
      if (staticAccess.kind === "getter") {
        lowerPrefixIncDecStaticGetterSetter(expr, expr.operand, staticAccess, ctx);
        return;
      }
      if (staticAccess.kind === "method" || staticAccess.kind === "setter") {
        ctx.diagnostics.push(
          makeDiag(
            LoweringDiagCode.IncrDecrTargetNotVariable,
            "Increment/decrement target must be a variable",
            expr.operand
          )
        );
        return;
      }
      if (staticAccess.kind === "no-such-member") {
        ctx.diagnostics.push(
          makeDiag(
            LoweringDiagCode.NoSuchStaticMember,
            `No static member '${expr.operand.name.text}' on class '${expr.operand.expression.getText()}'`,
            expr.operand
          )
        );
        return;
      }
      const index = staticAccess.callsiteVarIndex;
      loadEmit = () => ctx.ir.push({ kind: "LoadCallsiteVar", index });
      storeEmit = () => ctx.ir.push({ kind: "StoreCallsiteVar", index });
    } else {
      const sysField = resolveSystemThisField(expr.operand, ctx);
      if (sysField) {
        const thisLocal = ctx.thisLocalIndex!;
        loadEmit = () => {
          ctx.ir.push({ kind: "LoadLocal", index: thisLocal });
          ctx.ir.push({ kind: "GetField", fieldName: sysField.fieldName, fieldIndex: sysField.fieldIndex });
        };
        storeEmit = () => {
          ctx.ir.push({ kind: "LoadLocal", index: thisLocal });
          ctx.ir.push({ kind: "Swap" });
          ctx.ir.push({ kind: "StructSet", fieldIndex: sysField.fieldIndex });
          ctx.ir.push({ kind: "Pop" });
        };
      } else {
        const incDecResult = lowerPrefixIncDecInstanceGetterSetter(expr, expr.operand, ctx);
        if (incDecResult !== undefined) return;
        ctx.diagnostics.push(
          makeDiag(
            LoweringDiagCode.IncrDecrTargetNotVariable,
            "Increment/decrement target must be a variable",
            expr.operand
          )
        );
        return;
      }
    }
  } else if (ts.isIdentifier(expr.operand)) {
    const target = resolveVarTarget(expr.operand.text, ctx);
    if (!target) {
      ctx.diagnostics.push(
        makeDiag(LoweringDiagCode.UndefinedVariable, `Undefined variable: ${expr.operand.text}`, expr.operand)
      );
      return;
    }
    loadEmit = () => emitLoad(target, ctx);
    storeEmit = () => emitStore(target, ctx);
  } else {
    ctx.diagnostics.push(
      makeDiag(
        LoweringDiagCode.IncrDecrTargetNotVariable,
        "Increment/decrement target must be a variable",
        expr.operand
      )
    );
    return;
  }

  const opId = expr.operator === ts.SyntaxKind.PlusPlusToken ? CoreOpId.Add : CoreOpId.Subtract;
  const typeId = CoreTypeIds.Number;
  const fnName = resolveOperator(opId, [typeId, typeId], ctx.services);
  if (!fnName) {
    ctx.diagnostics.push(
      makeDiag(LoweringDiagCode.NoOperatorOverload, `No operator overload for ${opId}(${typeId}, ${typeId})`, expr)
    );
    return;
  }

  loadEmit();
  ctx.ir.push({ kind: "PushConst", value: mkNumberValue(1) });
  ctx.ir.push({ kind: "HostCall", fnName, argc: 2 });
  // Dup after arithmetic: leaves the new value on the stack as the expression result.
  ctx.ir.push({ kind: "Dup" });
  storeEmit();
}

function lowerPostfixIncDec(expr: ts.PostfixUnaryExpression, ctx: LowerContext): void {
  let loadEmit: () => void;
  let storeEmit: () => void;

  if (ts.isPropertyAccessExpression(expr.operand)) {
    const staticAccess = resolveStaticMemberAccess(expr.operand, ctx) ?? resolveThisStaticAccess(expr.operand, ctx);
    if (staticAccess) {
      if (staticAccess.kind === "getter") {
        lowerPostfixIncDecStaticGetterSetter(expr, expr.operand, staticAccess, ctx);
        return;
      }
      if (staticAccess.kind === "method" || staticAccess.kind === "setter") {
        ctx.diagnostics.push(
          makeDiag(
            LoweringDiagCode.IncrDecrTargetNotVariable,
            "Increment/decrement target must be a variable",
            expr.operand
          )
        );
        return;
      }
      if (staticAccess.kind === "no-such-member") {
        ctx.diagnostics.push(
          makeDiag(
            LoweringDiagCode.NoSuchStaticMember,
            `No static member '${expr.operand.name.text}' on class '${expr.operand.expression.getText()}'`,
            expr.operand
          )
        );
        return;
      }
      const index = staticAccess.callsiteVarIndex;
      loadEmit = () => ctx.ir.push({ kind: "LoadCallsiteVar", index });
      storeEmit = () => ctx.ir.push({ kind: "StoreCallsiteVar", index });
    } else {
      const sysField = resolveSystemThisField(expr.operand, ctx);
      if (sysField) {
        const thisLocal = ctx.thisLocalIndex!;
        loadEmit = () => {
          ctx.ir.push({ kind: "LoadLocal", index: thisLocal });
          ctx.ir.push({ kind: "GetField", fieldName: sysField.fieldName, fieldIndex: sysField.fieldIndex });
        };
        storeEmit = () => {
          ctx.ir.push({ kind: "LoadLocal", index: thisLocal });
          ctx.ir.push({ kind: "Swap" });
          ctx.ir.push({ kind: "StructSet", fieldIndex: sysField.fieldIndex });
          ctx.ir.push({ kind: "Pop" });
        };
      } else {
        const incDecResult = lowerPostfixIncDecInstanceGetterSetter(expr, expr.operand, ctx);
        if (incDecResult !== undefined) return;
        ctx.diagnostics.push(
          makeDiag(
            LoweringDiagCode.IncrDecrTargetNotVariable,
            "Increment/decrement target must be a variable",
            expr.operand
          )
        );
        return;
      }
    }
  } else if (ts.isIdentifier(expr.operand)) {
    const target = resolveVarTarget(expr.operand.text, ctx);
    if (!target) {
      ctx.diagnostics.push(
        makeDiag(LoweringDiagCode.UndefinedVariable, `Undefined variable: ${expr.operand.text}`, expr.operand)
      );
      return;
    }
    loadEmit = () => emitLoad(target, ctx);
    storeEmit = () => emitStore(target, ctx);
  } else {
    ctx.diagnostics.push(
      makeDiag(
        LoweringDiagCode.IncrDecrTargetNotVariable,
        "Increment/decrement target must be a variable",
        expr.operand
      )
    );
    return;
  }

  const opId = expr.operator === ts.SyntaxKind.PlusPlusToken ? CoreOpId.Add : CoreOpId.Subtract;
  const typeId = CoreTypeIds.Number;
  const fnName = resolveOperator(opId, [typeId, typeId], ctx.services);
  if (!fnName) {
    ctx.diagnostics.push(
      makeDiag(LoweringDiagCode.NoOperatorOverload, `No operator overload for ${opId}(${typeId}, ${typeId})`, expr)
    );
    return;
  }

  loadEmit();
  // Dup before arithmetic: the old value copy stays on the stack as the expression
  // result while the new value is computed and stored over it.
  ctx.ir.push({ kind: "Dup" });
  ctx.ir.push({ kind: "PushConst", value: mkNumberValue(1) });
  ctx.ir.push({ kind: "HostCall", fnName, argc: 2 });
  storeEmit();
}

/**
 * The core type behind a nullable type id, or undefined when the id does not
 * name a registered nullable type.
 */
function nullableCoreType(typeId: TypeId | undefined, services: BrainServices): NativeType | undefined {
  if (!typeId) return undefined;
  const def = services.runtime.types.get(typeId);
  return def?.nullable ? def.coreType : undefined;
}

/** Core types whose present values are always truthy in TypeScript. */
const ALWAYS_TRUTHY_CORE_TYPES: readonly NativeType[] = [
  NativeType.Struct,
  NativeType.List,
  NativeType.Map,
  NativeType.Buffer,
  NativeType.Enum,
  NativeType.Function,
];

/**
 * True when a truthiness test on the expression is a presence test: the
 * expression's type is nullable and any present value of its base type is
 * truthy in TypeScript, so the test can only distinguish present from absent.
 */
function isPresenceConditionExpression(expr: ts.Expression, ctx: LowerContext): boolean {
  const coreType = nullableCoreType(resolveExpressionTypeId(expr, ctx), ctx.services);
  return coreType !== undefined && ALWAYS_TRUTHY_CORE_TYPES.includes(coreType);
}

/**
 * Lowers a condition expression, leaving a value whose VM truthiness matches
 * TypeScript truthiness. A presence-test condition (see
 * {@link isPresenceConditionExpression}) lowers to an explicit nil test, since
 * VM truthiness of a present empty list, map, or buffer would otherwise
 * diverge from TypeScript.
 */
function lowerCondition(expr: ts.Expression, ctx: LowerContext): void {
  lowerExpression(expr, ctx);
  if (!isPresenceConditionExpression(expr, ctx)) {
    return;
  }
  ctx.ir.push({ kind: "TypeCheck", nativeType: NativeType.Nil });
  const notFn = resolveOperator(CoreOpId.Not, [CoreTypeIds.Boolean], ctx.services);
  if (!notFn) {
    ctx.diagnostics.push(
      makeDiag(LoweringDiagCode.UnsupportedOperator, "Missing not() operator for presence condition", expr)
    );
    return;
  }
  ctx.ir.push({ kind: "HostCall", fnName: notFn, argc: 1 });
}

function lowerShortCircuit(expr: ts.BinaryExpression, ctx: LowerContext): void {
  const endLabel = allocLabel(ctx);
  const isAnd = expr.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken;
  lowerExpression(expr.left, ctx);
  // Dup before the branch test because the test consumes the value it examines.
  // The duplicate is what remains on the stack as the result when the
  // short-circuit branch is taken (the left-hand value is the overall result).
  ctx.ir.push({ kind: "Dup" });
  if (isPresenceConditionExpression(expr.left, ctx)) {
    // Presence-typed left operand: short-circuit on nil-ness, matching
    // TypeScript truthiness where any present object value is truthy.
    ctx.ir.push({ kind: "TypeCheck", nativeType: NativeType.Nil });
    ctx.ir.push(isAnd ? { kind: "JumpIfTrue", labelId: endLabel } : { kind: "JumpIfFalse", labelId: endLabel });
  } else if (isAnd) {
    ctx.ir.push({ kind: "JumpIfFalse", labelId: endLabel });
  } else {
    ctx.ir.push({ kind: "JumpIfTrue", labelId: endLabel });
  }
  ctx.ir.push({ kind: "Pop" });
  lowerExpression(expr.right, ctx);
  ctx.ir.push({ kind: "Label", labelId: endLabel });
}

function lowerConditionalExpression(expr: ts.ConditionalExpression, ctx: LowerContext): void {
  const elseLabel = allocLabel(ctx);
  const endLabel = allocLabel(ctx);
  lowerCondition(expr.condition, ctx);
  ctx.ir.push({ kind: "JumpIfFalse", labelId: elseLabel });
  lowerExpression(expr.whenTrue, ctx);
  ctx.ir.push({ kind: "Jump", labelId: endLabel });
  ctx.ir.push({ kind: "Label", labelId: elseLabel });
  lowerExpression(expr.whenFalse, ctx);
  ctx.ir.push({ kind: "Label", labelId: endLabel });
}

function lowerNullishCoalescing(expr: ts.BinaryExpression, ctx: LowerContext): void {
  const keepLabel = allocLabel(ctx);
  const endLabel = allocLabel(ctx);

  lowerExpression(expr.left, ctx);
  // Dup the left value before testing so the original stays on the stack if it
  // is non-nil (TypeCheck consumes its operand).
  ctx.ir.push({ kind: "Dup" });
  // TypeCheck(Nil) is nil-only -- not a general falsy check -- matching ?? semantics
  // where false, 0, and "" are NOT replaced by the right operand.
  ctx.ir.push({ kind: "TypeCheck", nativeType: NativeType.Nil });
  // keepLabel and endLabel occupy the same instruction position: keepLabel is the
  // target when the jump is NOT taken (value was non-nil, keep it); endLabel is
  // the target of the unconditional jump after assigning the right-hand value.
  ctx.ir.push({ kind: "JumpIfFalse", labelId: keepLabel });
  ctx.ir.push({ kind: "Pop" });
  lowerExpression(expr.right, ctx);
  ctx.ir.push({ kind: "Jump", labelId: endLabel });
  ctx.ir.push({ kind: "Label", labelId: keepLabel });
  ctx.ir.push({ kind: "Label", labelId: endLabel });
}

function emitToStringIfNeeded(exprNode: ts.Expression, ctx: LowerContext): void {
  const typeId = resolveExpressionTypeId(exprNode, ctx);
  if (!typeId) {
    ctx.diagnostics.push(
      makeDiag(
        LoweringDiagCode.CannotConvertToString,
        "Cannot convert expression to string: unable to determine type",
        exprNode
      )
    );
    return;
  }
  if (typeId !== CoreTypeIds.String) {
    const conversion = resolveSingleStepConversion(typeId, CoreTypeIds.String, ctx.services);
    if (!conversion) {
      ctx.diagnostics.push(
        makeDiag(LoweringDiagCode.NoConversionToString, `No conversion from ${typeId} to string`, exprNode)
      );
      return;
    }
    emitSingleStepConversion(conversion.fnName, ctx);
  }
}

function lowerTemplateLiteral(expr: ts.TemplateExpression, ctx: LowerContext): void {
  const addFnName = resolveOperator(CoreOpId.Add, [CoreTypeIds.String, CoreTypeIds.String], ctx.services);
  if (!addFnName) {
    ctx.diagnostics.push(
      makeDiag(LoweringDiagCode.NoOverloadForStringConcat, "No operator overload for string concatenation", expr)
    );
    return;
  }

  let hasAccumulator = false;
  const headText = expr.head.text;

  if (headText !== "") {
    ctx.ir.push({ kind: "PushConst", value: mkStringValue(headText) });
    hasAccumulator = true;
  }

  for (const span of expr.templateSpans) {
    lowerExpression(span.expression, ctx);
    emitToStringIfNeeded(span.expression, ctx);

    if (hasAccumulator) {
      ctx.ir.push({ kind: "HostCall", fnName: addFnName, argc: 2 });
    }
    hasAccumulator = true;

    const literalText = span.literal.text;
    if (literalText !== "") {
      ctx.ir.push({ kind: "PushConst", value: mkStringValue(literalText) });
      ctx.ir.push({ kind: "HostCall", fnName: addFnName, argc: 2 });
    }
  }

  if (!hasAccumulator) {
    ctx.ir.push({ kind: "PushConst", value: mkStringValue("") });
  }
}

function typeofStringToNativeType(s: string): number | undefined {
  switch (s) {
    case "number":
      return NativeType.Number;
    case "string":
      return NativeType.String;
    case "boolean":
      return NativeType.Boolean;
    case "undefined":
      return NativeType.Nil;
    case "function":
      return NativeType.Function;
    default:
      return undefined;
  }
}

function lowerTypeofComparison(expr: ts.BinaryExpression, ctx: LowerContext): boolean {
  const op = expr.operatorToken.kind;
  if (
    op !== ts.SyntaxKind.EqualsEqualsEqualsToken &&
    op !== ts.SyntaxKind.ExclamationEqualsEqualsToken &&
    op !== ts.SyntaxKind.EqualsEqualsToken &&
    op !== ts.SyntaxKind.ExclamationEqualsToken
  ) {
    return false;
  }

  let typeofExpr: ts.TypeOfExpression | undefined;
  let literalValue: string | undefined;

  if (ts.isTypeOfExpression(expr.left) && ts.isStringLiteral(expr.right)) {
    typeofExpr = expr.left;
    literalValue = expr.right.text;
  } else if (ts.isStringLiteral(expr.left) && ts.isTypeOfExpression(expr.right)) {
    typeofExpr = expr.right;
    literalValue = expr.left.text;
  }

  if (!typeofExpr || literalValue === undefined) {
    return false;
  }

  const nativeType = typeofStringToNativeType(literalValue);
  if (nativeType === undefined) {
    ctx.diagnostics.push(
      makeDiag(
        LoweringDiagCode.UnsupportedTypeofComparison,
        `Unsupported typeof comparison: "${literalValue}" (supported: "number", "string", "boolean", "undefined")`,
        expr
      )
    );
    return true;
  }

  lowerExpression(typeofExpr.expression, ctx);
  // The VM has no general typeof instruction. `typeof x === "T"` is recognized
  // as a pattern at lowering time and compiled directly to a TypeCheck opcode.
  // Unsupported type strings (e.g. "object", "function") produce a diagnostic
  // above rather than falling through to the generic binary-op path.
  ctx.ir.push({ kind: "TypeCheck", nativeType });

  if (op === ts.SyntaxKind.ExclamationEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken) {
    const operandTypeId = CoreTypeIds.Boolean;
    const fnName = resolveOperator(CoreOpId.Not, [operandTypeId], ctx.services);
    if (!fnName) {
      ctx.diagnostics.push(makeDiag(LoweringDiagCode.NoOperatorOverload, "No operator overload for !(boolean)", expr));
      return true;
    }
    ctx.ir.push({ kind: "HostCall", fnName, argc: 1 });
  }

  return true;
}

function lowerInstanceOf(expr: ts.BinaryExpression, ctx: LowerContext): void {
  const rhsSym = ctx.checker.getSymbolAtLocation(expr.right);
  if (!rhsSym) {
    ctx.diagnostics.push(
      makeDiag(
        LoweringDiagCode.InstanceofRhsNotClass,
        "instanceof requires a class name on the right-hand side",
        expr.right
      )
    );
    return;
  }

  const resolvedSym = rhsSym.flags & ts.SymbolFlags.Alias ? ctx.checker.getAliasedSymbol(rhsSym) : rhsSym;
  const classDecl = resolvedSym.getDeclarations()?.find(ts.isClassDeclaration);
  if (!classDecl) {
    ctx.diagnostics.push(
      makeDiag(
        LoweringDiagCode.InstanceofRhsNotClass,
        "instanceof requires a class name on the right-hand side",
        expr.right
      )
    );
    return;
  }

  const instanceType = ctx.checker.getDeclaredTypeOfSymbol(resolvedSym);
  const typeId = tsTypeToTypeId(instanceType, ctx.checker, ctx.services, ctx.projectNamespace);
  if (!typeId) {
    ctx.diagnostics.push(
      makeDiag(LoweringDiagCode.InstanceofRhsNotClass, "Cannot resolve type for instanceof check", expr.right)
    );
    return;
  }

  lowerExpression(expr.left, ctx);
  ctx.ir.push({ kind: "InstanceOf", typeId });
}

function lowerElementAccess(expr: ts.ElementAccessExpression, ctx: LowerContext): void {
  const isOptChain = ts.isOptionalChain(expr);
  const rawObjType = ctx.checker.getTypeAtLocation(expr.expression);
  const objType = isOptChain ? ctx.checker.getNonNullableType(rawObjType) : rawObjType;
  if (isStringType(objType)) {
    lowerExpression(expr.expression, ctx);
    const guard = isOptChain ? emitNilGuard(ctx) : undefined;
    lowerExpression(expr.argumentExpression, ctx);
    ctx.ir.push({ kind: "HostCall", fnName: "$$str_get_js", argc: 2 });
    if (guard) ctx.ir.push({ kind: "Label", labelId: guard.endLabel });
    return;
  }
  if (resolveMapTypeId(objType, ctx)) {
    lowerExpression(expr.expression, ctx);
    const guard = isOptChain ? emitNilGuard(ctx) : undefined;
    lowerExpression(expr.argumentExpression, ctx);
    ctx.ir.push({ kind: "MapGet" });
    if (guard) ctx.ir.push({ kind: "Label", labelId: guard.endLabel });
    return;
  }
  if (resolveStructType(objType, ctx.services, ctx.projectNamespace, ctx.checker)) {
    lowerExpression(expr.expression, ctx);
    const guard = isOptChain ? emitNilGuard(ctx) : undefined;
    lowerExpression(expr.argumentExpression, ctx);
    emitToStringIfNeeded(expr.argumentExpression, ctx);
    ctx.ir.push({ kind: "GetFieldDynamic" });
    if (guard) ctx.ir.push({ kind: "Label", labelId: guard.endLabel });
    return;
  }
  if (!resolveListTypeId(objType, ctx)) {
    ctx.diagnostics.push(
      makeDiag(
        LoweringDiagCode.ElementAccessOnNonListType,
        "Element access is only supported on list, map, struct, and string types",
        expr
      )
    );
    return;
  }
  lowerExpression(expr.expression, ctx);
  const guard = isOptChain ? emitNilGuard(ctx) : undefined;
  lowerExpression(expr.argumentExpression, ctx);
  ctx.ir.push({ kind: "HostCall", fnName: "$$list_get_js", argc: 2 });
  if (guard) ctx.ir.push({ kind: "Label", labelId: guard.endLabel });
}

function lowerElementAccessAssignment(expr: ts.BinaryExpression, ctx: LowerContext): void {
  const elemAccess = expr.left as ts.ElementAccessExpression;
  const objType = ctx.checker.getTypeAtLocation(elemAccess.expression);

  const mapTypeId = resolveMapTypeId(objType, ctx);
  if (mapTypeId) {
    lowerElementAccessAssignmentForMap(expr, elemAccess, ctx);
    return;
  }

  const listTypeId = resolveListTypeId(objType, ctx);
  if (!listTypeId) {
    ctx.diagnostics.push(
      makeDiag(
        LoweringDiagCode.ElementAccessAssignOnNonListType,
        "Element access assignment is only supported on list and map types",
        expr.left
      )
    );
    return;
  }
  lowerElementAccessAssignmentForList(expr, elemAccess, ctx);
}

/**
 * Stores the value on top of the stack into the list element or map entry
 * beneath it with `setKind`, leaving the stored value as the assignment's
 * result in the nil slot pushed before the container.
 *
 * Stack effect: `[result, container, key, value] -> [value]`.
 */
function emitElementStore(setKind: "ListSet" | "MapSet", ctx: LowerContext): void {
  ctx.ir.push({ kind: "Dup" });
  ctx.ir.push({ kind: "StackSetRel", d: 3 });
  ctx.ir.push({ kind: setKind });
  ctx.ir.push({ kind: "Pop" });
}

function lowerElementAccessAssignmentForList(
  expr: ts.BinaryExpression,
  elemAccess: ts.ElementAccessExpression,
  ctx: LowerContext
): void {
  if (expr.operatorToken.kind !== ts.SyntaxKind.EqualsToken) {
    lowerCompoundElementAccessAssignment(expr, elemAccess, "ListGet", "ListSet", ctx);
    return;
  }
  ctx.ir.push({ kind: "PushConst", value: NIL_VALUE });
  lowerExpression(elemAccess.expression, ctx);
  lowerExpression(elemAccess.argumentExpression, ctx);
  lowerExpression(expr.right, ctx);
  emitElementStore("ListSet", ctx);
}

function lowerElementAccessAssignmentForMap(
  expr: ts.BinaryExpression,
  elemAccess: ts.ElementAccessExpression,
  ctx: LowerContext
): void {
  if (expr.operatorToken.kind !== ts.SyntaxKind.EqualsToken) {
    lowerCompoundElementAccessAssignment(expr, elemAccess, "MapGet", "MapSet", ctx);
    return;
  }
  ctx.ir.push({ kind: "PushConst", value: NIL_VALUE });
  lowerExpression(elemAccess.expression, ctx);
  lowerExpression(elemAccess.argumentExpression, ctx);
  lowerExpression(expr.right, ctx);
  emitElementStore("MapSet", ctx);
}

function lowerCompoundElementAccessAssignment(
  expr: ts.BinaryExpression,
  elemAccess: ts.ElementAccessExpression,
  getKind: "ListGet" | "MapGet",
  setKind: "ListSet" | "MapSet",
  ctx: LowerContext
): void {
  const opId = compoundAssignmentToOpId(expr.operatorToken.kind);
  if (!opId) {
    ctx.diagnostics.push(
      makeDiag(
        LoweringDiagCode.UnsupportedCompoundAssignOperator,
        "Unsupported compound assignment operator",
        expr.operatorToken
      )
    );
    return;
  }

  const lhsType = ctx.checker.getTypeAtLocation(elemAccess);
  const rhsType = ctx.checker.getTypeAtLocation(expr.right);
  const lhsTypeId = tsTypeToTypeId(lhsType, ctx.checker, ctx.services, ctx.projectNamespace);
  const rhsTypeId = tsTypeToTypeId(rhsType, ctx.checker, ctx.services, ctx.projectNamespace);
  if (!lhsTypeId || !rhsTypeId) {
    ctx.diagnostics.push(
      makeDiag(
        LoweringDiagCode.CannotDetermineTypesForCompoundAssign,
        "Cannot determine types for compound assignment",
        expr
      )
    );
    return;
  }

  const fnName = resolveOperatorWithExpansion(opId, [lhsTypeId, rhsTypeId], ctx.services);
  if (!fnName) {
    ctx.diagnostics.push(
      makeDiag(
        LoweringDiagCode.NoOperatorOverload,
        `No operator overload for ${opId}(${lhsTypeId}, ${rhsTypeId})`,
        expr
      )
    );
    return;
  }

  const containerLocal = ctx.scopeStack.allocLocal();
  const keyLocal = ctx.scopeStack.allocLocal();

  ctx.ir.push({ kind: "PushConst", value: NIL_VALUE });
  lowerExpression(elemAccess.expression, ctx);
  ctx.ir.push({ kind: "StoreLocal", index: containerLocal });

  lowerExpression(elemAccess.argumentExpression, ctx);
  ctx.ir.push({ kind: "StoreLocal", index: keyLocal });

  ctx.ir.push({ kind: "LoadLocal", index: containerLocal });
  ctx.ir.push({ kind: "LoadLocal", index: keyLocal });
  ctx.ir.push({ kind: getKind });

  lowerExpression(expr.right, ctx);
  ctx.ir.push({ kind: "HostCall", fnName, argc: 2 });

  ctx.ir.push({ kind: "LoadLocal", index: containerLocal });
  ctx.ir.push({ kind: "Swap" });
  ctx.ir.push({ kind: "LoadLocal", index: keyLocal });
  ctx.ir.push({ kind: "Swap" });
  emitElementStore(setKind, ctx);
}

function isStringType(type: ts.Type): boolean {
  if ((type.flags & ts.TypeFlags.StringLike) !== 0) return true;
  if (type.isUnion()) {
    const nonNullish = type.types.filter((t) => !(t.flags & ts.TypeFlags.Null) && !(t.flags & ts.TypeFlags.Undefined));
    return nonNullish.length === 1 && (nonNullish[0].flags & ts.TypeFlags.StringLike) !== 0;
  }
  return false;
}

function lowerStringMethodCall(
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
  ctx: LowerContext
): boolean {
  const objType = ctx.checker.getTypeAtLocation(propAccess.expression);
  if (!isStringType(objType)) return false;

  const methodName = propAccess.name.text;

  switch (methodName) {
    case "charAt": {
      if (expr.arguments.length !== 1) {
        ctx.diagnostics.push(
          makeDiag(LoweringDiagCode.StringMethodWrongArgCount, ".charAt() requires exactly 1 argument", expr)
        );
        return true;
      }
      lowerExpression(propAccess.expression, ctx);
      lowerExpression(expr.arguments[0], ctx);
      ctx.ir.push({ kind: "HostCall", fnName: "$$str_charAt", argc: 2 });
      return true;
    }
    case "charCodeAt": {
      if (expr.arguments.length !== 1) {
        ctx.diagnostics.push(
          makeDiag(LoweringDiagCode.StringMethodWrongArgCount, ".charCodeAt() requires exactly 1 argument", expr)
        );
        return true;
      }
      lowerExpression(propAccess.expression, ctx);
      lowerExpression(expr.arguments[0], ctx);
      ctx.ir.push({ kind: "HostCall", fnName: "$$str_charCodeAt", argc: 2 });
      return true;
    }
    case "indexOf": {
      if (expr.arguments.length < 1 || expr.arguments.length > 2) {
        ctx.diagnostics.push(
          makeDiag(LoweringDiagCode.StringMethodWrongArgCount, ".indexOf() requires 1 or 2 arguments", expr)
        );
        return true;
      }
      lowerExpression(propAccess.expression, ctx);
      lowerExpression(expr.arguments[0], ctx);
      if (expr.arguments.length === 2) {
        lowerExpression(expr.arguments[1], ctx);
      } else {
        ctx.ir.push({ kind: "PushConst", value: NIL_VALUE });
      }
      ctx.ir.push({ kind: "HostCall", fnName: "$$str_indexOf", argc: 3 });
      return true;
    }
    case "lastIndexOf": {
      if (expr.arguments.length < 1 || expr.arguments.length > 2) {
        ctx.diagnostics.push(
          makeDiag(LoweringDiagCode.StringMethodWrongArgCount, ".lastIndexOf() requires 1 or 2 arguments", expr)
        );
        return true;
      }
      lowerExpression(propAccess.expression, ctx);
      lowerExpression(expr.arguments[0], ctx);
      if (expr.arguments.length === 2) {
        lowerExpression(expr.arguments[1], ctx);
      } else {
        ctx.ir.push({ kind: "PushConst", value: NIL_VALUE });
      }
      ctx.ir.push({ kind: "HostCall", fnName: "$$str_lastIndexOf", argc: 3 });
      return true;
    }
    case "slice": {
      if (expr.arguments.length > 2) {
        ctx.diagnostics.push(
          makeDiag(LoweringDiagCode.StringMethodWrongArgCount, ".slice() takes at most 2 arguments", expr)
        );
        return true;
      }
      lowerExpression(propAccess.expression, ctx);
      if (expr.arguments.length >= 1) {
        lowerExpression(expr.arguments[0], ctx);
      } else {
        ctx.ir.push({ kind: "PushConst", value: NIL_VALUE });
      }
      if (expr.arguments.length >= 2) {
        lowerExpression(expr.arguments[1], ctx);
      } else {
        ctx.ir.push({ kind: "PushConst", value: NIL_VALUE });
      }
      ctx.ir.push({ kind: "HostCall", fnName: "$$str_slice", argc: 3 });
      return true;
    }
    case "substring": {
      if (expr.arguments.length < 1 || expr.arguments.length > 2) {
        ctx.diagnostics.push(
          makeDiag(LoweringDiagCode.StringMethodWrongArgCount, ".substring() requires 1 or 2 arguments", expr)
        );
        return true;
      }
      lowerExpression(propAccess.expression, ctx);
      lowerExpression(expr.arguments[0], ctx);
      if (expr.arguments.length === 2) {
        lowerExpression(expr.arguments[1], ctx);
      } else {
        ctx.ir.push({ kind: "PushConst", value: NIL_VALUE });
      }
      ctx.ir.push({ kind: "HostCall", fnName: "$$str_substring", argc: 3 });
      return true;
    }
    case "toLowerCase": {
      if (expr.arguments.length !== 0) {
        ctx.diagnostics.push(
          makeDiag(LoweringDiagCode.StringMethodWrongArgCount, ".toLowerCase() takes no arguments", expr)
        );
        return true;
      }
      lowerExpression(propAccess.expression, ctx);
      ctx.ir.push({ kind: "HostCall", fnName: "$$str_toLowerCase", argc: 1 });
      return true;
    }
    case "toUpperCase": {
      if (expr.arguments.length !== 0) {
        ctx.diagnostics.push(
          makeDiag(LoweringDiagCode.StringMethodWrongArgCount, ".toUpperCase() takes no arguments", expr)
        );
        return true;
      }
      lowerExpression(propAccess.expression, ctx);
      ctx.ir.push({ kind: "HostCall", fnName: "$$str_toUpperCase", argc: 1 });
      return true;
    }
    case "trim": {
      if (expr.arguments.length !== 0) {
        ctx.diagnostics.push(makeDiag(LoweringDiagCode.StringMethodWrongArgCount, ".trim() takes no arguments", expr));
        return true;
      }
      lowerExpression(propAccess.expression, ctx);
      ctx.ir.push({ kind: "HostCall", fnName: "$$str_trim", argc: 1 });
      return true;
    }
    case "split": {
      if (expr.arguments.length < 1 || expr.arguments.length > 2) {
        ctx.diagnostics.push(
          makeDiag(LoweringDiagCode.StringMethodWrongArgCount, ".split() requires 1 or 2 arguments", expr)
        );
        return true;
      }
      lowerExpression(propAccess.expression, ctx);
      lowerExpression(expr.arguments[0], ctx);
      if (expr.arguments.length === 2) {
        lowerExpression(expr.arguments[1], ctx);
      } else {
        ctx.ir.push({ kind: "PushConst", value: NIL_VALUE });
      }
      ctx.ir.push({ kind: "HostCall", fnName: "$$str_split", argc: 3 });
      return true;
    }
    case "concat": {
      if (expr.arguments.length === 0) {
        lowerExpression(propAccess.expression, ctx);
        return true;
      }
      lowerExpression(propAccess.expression, ctx);
      for (const arg of expr.arguments) {
        lowerExpression(arg, ctx);
      }
      ctx.ir.push({ kind: "HostCall", fnName: "$$str_concat", argc: expr.arguments.length + 1 });
      return true;
    }
    case "toString":
    case "valueOf": {
      if (expr.arguments.length !== 0) {
        ctx.diagnostics.push(
          makeDiag(LoweringDiagCode.StringMethodWrongArgCount, `.${methodName}() takes no arguments`, expr)
        );
        return true;
      }
      lowerExpression(propAccess.expression, ctx);
      return true;
    }
    default:
      ctx.diagnostics.push(
        makeDiag(LoweringDiagCode.UnsupportedStringMethod, `Unsupported string method: .${methodName}()`, expr)
      );
      return true;
  }
}

function lowerMapMethodCall(
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
  ctx: LowerContext
): boolean {
  const objType = ctx.checker.getTypeAtLocation(propAccess.expression);
  if (!resolveMapTypeId(objType, ctx)) return false;

  const methodName = propAccess.name.text;

  switch (methodName) {
    case "get": {
      if (expr.arguments.length !== 1) {
        ctx.diagnostics.push(
          makeDiag(LoweringDiagCode.MapMethodWrongArgCount, ".get() requires exactly 1 argument", expr)
        );
        return true;
      }
      lowerExpression(propAccess.expression, ctx);
      lowerExpression(expr.arguments[0], ctx);
      ctx.ir.push({ kind: "MapGet" });
      return true;
    }
    case "has": {
      if (expr.arguments.length !== 1) {
        ctx.diagnostics.push(
          makeDiag(LoweringDiagCode.MapMethodWrongArgCount, ".has() requires exactly 1 argument", expr)
        );
        return true;
      }
      lowerExpression(propAccess.expression, ctx);
      lowerExpression(expr.arguments[0], ctx);
      ctx.ir.push({ kind: "MapHas" });
      return true;
    }
    case "delete": {
      if (expr.arguments.length !== 1) {
        ctx.diagnostics.push(
          makeDiag(LoweringDiagCode.MapMethodWrongArgCount, ".delete() requires exactly 1 argument", expr)
        );
        return true;
      }
      lowerExpression(propAccess.expression, ctx);
      lowerExpression(expr.arguments[0], ctx);
      ctx.ir.push({ kind: "MapDelete" });
      return true;
    }
    case "set": {
      if (expr.arguments.length !== 2) {
        ctx.diagnostics.push(
          makeDiag(LoweringDiagCode.MapMethodWrongArgCount, ".set() requires exactly 2 arguments", expr)
        );
        return true;
      }
      lowerExpression(propAccess.expression, ctx);
      lowerExpression(expr.arguments[0], ctx);
      lowerExpression(expr.arguments[1], ctx);
      ctx.ir.push({ kind: "MapSet" });
      return true;
    }
    case "keys": {
      if (expr.arguments.length !== 0) {
        ctx.diagnostics.push(makeDiag(LoweringDiagCode.MapMethodWrongArgCount, ".keys() takes no arguments", expr));
        return true;
      }
      lowerExpression(propAccess.expression, ctx);
      ctx.ir.push({ kind: "HostCall", fnName: "$$map_keys", argc: 1 });
      return true;
    }
    case "values": {
      if (expr.arguments.length !== 0) {
        ctx.diagnostics.push(makeDiag(LoweringDiagCode.MapMethodWrongArgCount, ".values() takes no arguments", expr));
        return true;
      }
      lowerExpression(propAccess.expression, ctx);
      ctx.ir.push({ kind: "HostCall", fnName: "$$map_values", argc: 1 });
      return true;
    }
    case "clear": {
      if (expr.arguments.length !== 0) {
        ctx.diagnostics.push(makeDiag(LoweringDiagCode.MapMethodWrongArgCount, ".clear() takes no arguments", expr));
        return true;
      }
      lowerExpression(propAccess.expression, ctx);
      ctx.ir.push({ kind: "HostCall", fnName: "$$map_clear", argc: 1 });
      return true;
    }
    case "forEach": {
      if (expr.arguments.length !== 1) {
        ctx.diagnostics.push(
          makeDiag(LoweringDiagCode.MapMethodWrongArgCount, ".forEach() requires exactly 1 argument", expr)
        );
        return true;
      }
      lowerMapForEach(expr, propAccess, ctx);
      return true;
    }
    default:
      ctx.diagnostics.push(
        makeDiag(LoweringDiagCode.UnsupportedMapMethod, `Unsupported map method: .${methodName}()`, expr)
      );
      return true;
  }
}

function lowerMapForEach(expr: ts.CallExpression, propAccess: ts.PropertyAccessExpression, ctx: LowerContext): void {
  const loopStart = allocLabel(ctx);
  const loopEnd = allocLabel(ctx);

  const keysLocal = ctx.scopeStack.allocLocal();
  const idxLocal = ctx.scopeStack.allocLocal();
  const lenLocal = ctx.scopeStack.allocLocal();
  const callbackLocal = ctx.scopeStack.allocLocal();
  const mapLocal = ctx.scopeStack.allocLocal();

  lowerExpression(propAccess.expression, ctx);
  ctx.ir.push({ kind: "StoreLocal", index: mapLocal });

  ctx.ir.push({ kind: "LoadLocal", index: mapLocal });
  ctx.ir.push({ kind: "HostCall", fnName: "$$map_keys", argc: 1 });
  ctx.ir.push({ kind: "StoreLocal", index: keysLocal });

  lowerExpression(expr.arguments[0], ctx);
  ctx.ir.push({ kind: "StoreLocal", index: callbackLocal });

  ctx.ir.push({ kind: "PushConst", value: mkNumberValue(0) });
  ctx.ir.push({ kind: "StoreLocal", index: idxLocal });

  ctx.ir.push({ kind: "LoadLocal", index: keysLocal });
  ctx.ir.push({ kind: "ListLen" });
  ctx.ir.push({ kind: "StoreLocal", index: lenLocal });

  ctx.ir.push({ kind: "Label", labelId: loopStart });

  ctx.ir.push({ kind: "LoadLocal", index: idxLocal });
  ctx.ir.push({ kind: "LoadLocal", index: lenLocal });
  const ltFn = resolveOperator(CoreOpId.LessThan, [CoreTypeIds.Number, CoreTypeIds.Number], ctx.services);
  if (!ltFn) {
    ctx.diagnostics.push(
      makeDiag(
        LoweringDiagCode.CannotResolveOperatorForArrayMethod,
        "Cannot resolve < operator for map .forEach()",
        expr
      )
    );
    return;
  }
  ctx.ir.push({ kind: "HostCall", fnName: ltFn, argc: 2 });
  ctx.ir.push({ kind: "JumpIfFalse", labelId: loopEnd });

  ctx.ir.push({ kind: "LoadLocal", index: callbackLocal });

  ctx.ir.push({ kind: "LoadLocal", index: mapLocal });
  ctx.ir.push({ kind: "LoadLocal", index: keysLocal });
  ctx.ir.push({ kind: "LoadLocal", index: idxLocal });
  ctx.ir.push({ kind: "ListGet" });
  ctx.ir.push({ kind: "MapGet" });

  ctx.ir.push({ kind: "LoadLocal", index: keysLocal });
  ctx.ir.push({ kind: "LoadLocal", index: idxLocal });
  ctx.ir.push({ kind: "ListGet" });

  ctx.ir.push({ kind: "CallIndirectArgs", argc: 2 });
  ctx.ir.push({ kind: "Pop" });

  ctx.ir.push({ kind: "LoadLocal", index: idxLocal });
  ctx.ir.push({ kind: "PushConst", value: mkNumberValue(1) });
  const addFn = resolveOperator(CoreOpId.Add, [CoreTypeIds.Number, CoreTypeIds.Number], ctx.services);
  if (!addFn) {
    ctx.diagnostics.push(
      makeDiag(
        LoweringDiagCode.CannotResolveOperatorForArrayMethod,
        "Cannot resolve + operator for map .forEach()",
        expr
      )
    );
    return;
  }
  ctx.ir.push({ kind: "HostCall", fnName: addFn, argc: 2 });
  ctx.ir.push({ kind: "StoreLocal", index: idxLocal });
  ctx.ir.push({ kind: "Jump", labelId: loopStart });

  ctx.ir.push({ kind: "Label", labelId: loopEnd });
  ctx.ir.push({ kind: "PushConst", value: NIL_VALUE });
}

function lowerListMethodCall(
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
  ctx: LowerContext
): boolean {
  const objType = ctx.checker.getTypeAtLocation(propAccess.expression);
  const listTypeId = resolveListTypeId(objType, ctx);
  if (!listTypeId) return false;

  const methodName = propAccess.name.text;

  switch (methodName) {
    case "push":
      lowerListPush(expr, propAccess, ctx);
      return true;
    case "indexOf":
      lowerListIndexOf(expr, propAccess, ctx);
      return true;
    case "includes":
      lowerListIncludes(expr, propAccess, ctx);
      return true;
    case "filter":
      lowerListFilter(expr, propAccess, listTypeId, ctx);
      return true;
    case "map":
      lowerListMap(expr, propAccess, ctx);
      return true;
    case "forEach":
      lowerListForEach(expr, propAccess, ctx);
      return true;
    case "some":
      lowerListSome(expr, propAccess, ctx);
      return true;
    case "every":
      lowerListEvery(expr, propAccess, ctx);
      return true;
    case "find":
      lowerListFind(expr, propAccess, ctx);
      return true;
    case "concat":
      lowerListConcat(expr, propAccess, listTypeId, ctx);
      return true;
    case "join":
      lowerListJoin(expr, propAccess, ctx);
      return true;
    case "reverse":
      lowerListReverse(expr, propAccess, listTypeId, ctx);
      return true;
    case "slice":
      lowerListSlice(expr, propAccess, listTypeId, ctx);
      return true;
    case "pop":
      lowerListPop(expr, propAccess, ctx);
      return true;
    case "shift":
      lowerListShift(expr, propAccess, ctx);
      return true;
    case "unshift":
      lowerListUnshift(expr, propAccess, ctx);
      return true;
    case "splice":
      lowerListSplice(expr, propAccess, listTypeId, ctx);
      return true;
    case "sort":
      lowerListSort(expr, propAccess, ctx);
      return true;
    case "lastIndexOf":
      lowerListLastIndexOf(expr, propAccess, ctx);
      return true;
    case "findIndex":
      lowerListFindIndex(expr, propAccess, ctx);
      return true;
    case "reduce":
      lowerListReduce(expr, propAccess, ctx);
      return true;
    case "toString":
      lowerListToString(expr, propAccess, ctx);
      return true;
    case "fill":
    case "copyWithin":
      ctx.diagnostics.push(
        makeDiag(
          LoweringDiagCode.ArrayMethodNotSupported,
          `Array.${methodName}() is not supported (requires VM-level list mutation ops)`,
          expr
        )
      );
      return true;
    default:
      ctx.diagnostics.push(
        makeDiag(LoweringDiagCode.UnsupportedArrayMethod, `Unsupported array method: .${methodName}()`, expr)
      );
      return true;
  }
}

function lowerListPush(expr: ts.CallExpression, propAccess: ts.PropertyAccessExpression, ctx: LowerContext): void {
  if (expr.arguments.length !== 1) {
    ctx.diagnostics.push(makeDiag(LoweringDiagCode.PushRequiresOneArg, ".push() requires exactly 1 argument", expr));
    return;
  }
  lowerExpression(propAccess.expression, ctx);
  lowerExpression(expr.arguments[0], ctx);
  ctx.ir.push({ kind: "ListPush" });
}

function lowerListPop(expr: ts.CallExpression, propAccess: ts.PropertyAccessExpression, ctx: LowerContext): void {
  if (expr.arguments.length !== 0) {
    ctx.diagnostics.push(makeDiag(LoweringDiagCode.PopTakesNoArgs, ".pop() takes no arguments", expr));
    return;
  }
  lowerExpression(propAccess.expression, ctx);
  ctx.ir.push({ kind: "ListPop" });
}

function lowerListShift(expr: ts.CallExpression, propAccess: ts.PropertyAccessExpression, ctx: LowerContext): void {
  if (expr.arguments.length !== 0) {
    ctx.diagnostics.push(makeDiag(LoweringDiagCode.ShiftTakesNoArgs, ".shift() takes no arguments", expr));
    return;
  }
  lowerExpression(propAccess.expression, ctx);
  ctx.ir.push({ kind: "ListShift" });
}

function lowerListUnshift(expr: ts.CallExpression, propAccess: ts.PropertyAccessExpression, ctx: LowerContext): void {
  if (expr.arguments.length !== 1) {
    ctx.diagnostics.push(
      makeDiag(LoweringDiagCode.UnshiftRequiresOneArg, ".unshift() requires exactly 1 argument", expr)
    );
    return;
  }
  lowerExpression(propAccess.expression, ctx);
  ctx.ir.push({ kind: "PushConst", value: mkNumberValue(0) });
  lowerExpression(expr.arguments[0], ctx);
  ctx.ir.push({ kind: "ListInsert" });
  lowerExpression(propAccess.expression, ctx);
  ctx.ir.push({ kind: "ListLen" });
}

function lowerListSplice(
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
  listTypeId: string,
  ctx: LowerContext
): void {
  /**
   * Equivalent TS:
   * @example
   *   const removed: T[] = [];
   *   for (let i = 0; i < deleteCount; i++) {
   *     removed.push(arr.splice(start, 1)[0]);
   *   }
   *   for (const item of insertItems) {
   *     arr.splice(start, 0, item); start++;
   *   }
   *   return removed;
   */

  if (expr.arguments.length < 1) {
    ctx.diagnostics.push(
      makeDiag(LoweringDiagCode.SpliceRequiresAtLeastOneArg, ".splice() requires at least 1 argument (start)", expr)
    );
    return;
  }

  const loopStart = allocLabel(ctx);
  const loopEnd = allocLabel(ctx);

  const startLocal = ctx.scopeStack.allocLocal();
  const countLocal = ctx.scopeStack.allocLocal();
  const resultLocal = ctx.scopeStack.allocLocal();
  const iLocal = ctx.scopeStack.allocLocal();

  lowerExpression(expr.arguments[0], ctx);
  ctx.ir.push({ kind: "StoreLocal", index: startLocal });

  if (expr.arguments.length >= 2) {
    lowerExpression(expr.arguments[1], ctx);
  } else {
    lowerExpression(propAccess.expression, ctx);
    ctx.ir.push({ kind: "ListLen" });
    ctx.ir.push({ kind: "LoadLocal", index: startLocal });
    const subFn = resolveOperator(CoreOpId.Subtract, [CoreTypeIds.Number, CoreTypeIds.Number], ctx.services);
    if (!subFn) {
      ctx.diagnostics.push(
        makeDiag(LoweringDiagCode.CannotResolveOperatorForArrayMethod, "Cannot resolve - operator for .splice()", expr)
      );
      return;
    }
    ctx.ir.push({ kind: "HostCall", fnName: subFn, argc: 2 });
  }
  ctx.ir.push({ kind: "StoreLocal", index: countLocal });

  ctx.ir.push({ kind: "ListNew", typeId: listTypeId });
  ctx.ir.push({ kind: "StoreLocal", index: resultLocal });

  ctx.ir.push({ kind: "PushConst", value: mkNumberValue(0) });
  ctx.ir.push({ kind: "StoreLocal", index: iLocal });

  const ltFn = resolveOperator(CoreOpId.LessThan, [CoreTypeIds.Number, CoreTypeIds.Number], ctx.services);
  if (!ltFn) {
    ctx.diagnostics.push(
      makeDiag(LoweringDiagCode.CannotResolveOperatorForArrayMethod, "Cannot resolve < operator for .splice()", expr)
    );
    return;
  }

  ctx.ir.push({ kind: "Label", labelId: loopStart });

  ctx.ir.push({ kind: "LoadLocal", index: iLocal });
  ctx.ir.push({ kind: "LoadLocal", index: countLocal });
  ctx.ir.push({ kind: "HostCall", fnName: ltFn, argc: 2 });
  ctx.ir.push({ kind: "JumpIfFalse", labelId: loopEnd });

  ctx.ir.push({ kind: "LoadLocal", index: resultLocal });
  lowerExpression(propAccess.expression, ctx);
  ctx.ir.push({ kind: "LoadLocal", index: startLocal });
  ctx.ir.push({ kind: "ListRemove" });
  ctx.ir.push({ kind: "ListPush" });
  ctx.ir.push({ kind: "StoreLocal", index: resultLocal });

  ctx.ir.push({ kind: "LoadLocal", index: iLocal });
  ctx.ir.push({ kind: "PushConst", value: mkNumberValue(1) });
  const addFn = resolveOperator(CoreOpId.Add, [CoreTypeIds.Number, CoreTypeIds.Number], ctx.services);
  if (!addFn) {
    ctx.diagnostics.push(
      makeDiag(LoweringDiagCode.CannotResolveOperatorForArrayMethod, "Cannot resolve + operator for .splice()", expr)
    );
    return;
  }
  ctx.ir.push({ kind: "HostCall", fnName: addFn, argc: 2 });
  ctx.ir.push({ kind: "StoreLocal", index: iLocal });

  ctx.ir.push({ kind: "Jump", labelId: loopStart });
  ctx.ir.push({ kind: "Label", labelId: loopEnd });

  for (let argIdx = 2; argIdx < expr.arguments.length; argIdx++) {
    lowerExpression(propAccess.expression, ctx);
    ctx.ir.push({ kind: "LoadLocal", index: startLocal });
    lowerExpression(expr.arguments[argIdx], ctx);
    ctx.ir.push({ kind: "ListInsert" });

    ctx.ir.push({ kind: "LoadLocal", index: startLocal });
    ctx.ir.push({ kind: "PushConst", value: mkNumberValue(1) });
    ctx.ir.push({ kind: "HostCall", fnName: addFn, argc: 2 });
    ctx.ir.push({ kind: "StoreLocal", index: startLocal });
  }

  ctx.ir.push({ kind: "LoadLocal", index: resultLocal });
}

function lowerListSort(expr: ts.CallExpression, propAccess: ts.PropertyAccessExpression, ctx: LowerContext): void {
  /**
   * Equivalent TS:
   * @example
   *   for (let i = 1; i < arr.length; i++) {
   *     let j = i;
   *     while (j > 0 && compareFn(arr[j - 1], arr[j]) > 0) {
   *       [arr[j - 1], arr[j]] = [arr[j], arr[j - 1]];
   *       j--;
   *     }
   *   }
   *   return arr;
   */

  if (expr.arguments.length !== 1) {
    ctx.diagnostics.push(
      makeDiag(LoweringDiagCode.SortRequiresComparatorFn, ".sort() requires a comparator function", expr)
    );
    return;
  }

  const loopOuter = allocLabel(ctx);
  const loopOuterEnd = allocLabel(ctx);
  const loopInner = allocLabel(ctx);
  const loopInnerEnd = allocLabel(ctx);

  const srcListLocal = ctx.scopeStack.allocLocal();
  const callbackLocal = ctx.scopeStack.allocLocal();
  const lenLocal = ctx.scopeStack.allocLocal();
  const iLocal = ctx.scopeStack.allocLocal();
  const jLocal = ctx.scopeStack.allocLocal();

  lowerExpression(propAccess.expression, ctx);
  ctx.ir.push({ kind: "StoreLocal", index: srcListLocal });

  lowerExpression(expr.arguments[0], ctx);
  ctx.ir.push({ kind: "StoreLocal", index: callbackLocal });

  ctx.ir.push({ kind: "LoadLocal", index: srcListLocal });
  ctx.ir.push({ kind: "ListLen" });
  ctx.ir.push({ kind: "StoreLocal", index: lenLocal });

  const ltFn = resolveOperator(CoreOpId.LessThan, [CoreTypeIds.Number, CoreTypeIds.Number], ctx.services);
  if (!ltFn) {
    ctx.diagnostics.push(
      makeDiag(LoweringDiagCode.CannotResolveOperatorForArrayMethod, "Cannot resolve < operator for .sort()", expr)
    );
    return;
  }
  const addFn = resolveOperator(CoreOpId.Add, [CoreTypeIds.Number, CoreTypeIds.Number], ctx.services);
  if (!addFn) {
    ctx.diagnostics.push(
      makeDiag(LoweringDiagCode.CannotResolveOperatorForArrayMethod, "Cannot resolve + operator for .sort()", expr)
    );
    return;
  }
  const subFn = resolveOperator(CoreOpId.Subtract, [CoreTypeIds.Number, CoreTypeIds.Number], ctx.services);
  if (!subFn) {
    ctx.diagnostics.push(
      makeDiag(LoweringDiagCode.CannotResolveOperatorForArrayMethod, "Cannot resolve - operator for .sort()", expr)
    );
    return;
  }
  const leFn = resolveOperator(CoreOpId.LessThanOrEqualTo, [CoreTypeIds.Number, CoreTypeIds.Number], ctx.services);
  if (!leFn) {
    ctx.diagnostics.push(
      makeDiag(LoweringDiagCode.CannotResolveOperatorForArrayMethod, "Cannot resolve <= operator for .sort()", expr)
    );
    return;
  }

  // i = 1
  ctx.ir.push({ kind: "PushConst", value: mkNumberValue(1) });
  ctx.ir.push({ kind: "StoreLocal", index: iLocal });

  // LOOP_OUTER:
  ctx.ir.push({ kind: "Label", labelId: loopOuter });

  // if (!(i < len)) goto END
  ctx.ir.push({ kind: "LoadLocal", index: iLocal });
  ctx.ir.push({ kind: "LoadLocal", index: lenLocal });
  ctx.ir.push({ kind: "HostCall", fnName: ltFn, argc: 2 });
  ctx.ir.push({ kind: "JumpIfFalse", labelId: loopOuterEnd });

  // j = i
  ctx.ir.push({ kind: "LoadLocal", index: iLocal });
  ctx.ir.push({ kind: "StoreLocal", index: jLocal });

  // LOOP_INNER:
  ctx.ir.push({ kind: "Label", labelId: loopInner });

  // if (j <= 0) goto INNER_END
  ctx.ir.push({ kind: "LoadLocal", index: jLocal });
  ctx.ir.push({ kind: "PushConst", value: mkNumberValue(0) });
  ctx.ir.push({ kind: "HostCall", fnName: leFn, argc: 2 });
  ctx.ir.push({ kind: "JumpIfTrue", labelId: loopInnerEnd });

  // cmp = callback(arr[j-1], arr[j])
  // CallIndirect expects stack bottom-to-top: [callback, arg0, arg1]
  ctx.ir.push({ kind: "LoadLocal", index: callbackLocal });

  // arg0: arr[j - 1]
  ctx.ir.push({ kind: "LoadLocal", index: srcListLocal });
  ctx.ir.push({ kind: "LoadLocal", index: jLocal });
  ctx.ir.push({ kind: "PushConst", value: mkNumberValue(1) });
  ctx.ir.push({ kind: "HostCall", fnName: subFn, argc: 2 });
  ctx.ir.push({ kind: "ListGet" });

  // arg1: arr[j]
  ctx.ir.push({ kind: "LoadLocal", index: srcListLocal });
  ctx.ir.push({ kind: "LoadLocal", index: jLocal });
  ctx.ir.push({ kind: "ListGet" });

  ctx.ir.push({ kind: "CallIndirect", argc: 2 });

  // if (cmp <= 0) goto INNER_END
  ctx.ir.push({ kind: "PushConst", value: mkNumberValue(0) });
  ctx.ir.push({ kind: "HostCall", fnName: leFn, argc: 2 });
  ctx.ir.push({ kind: "JumpIfTrue", labelId: loopInnerEnd });

  // LIST_SWAP(arr, j - 1, j)
  ctx.ir.push({ kind: "LoadLocal", index: srcListLocal });
  ctx.ir.push({ kind: "LoadLocal", index: jLocal });
  ctx.ir.push({ kind: "PushConst", value: mkNumberValue(1) });
  ctx.ir.push({ kind: "HostCall", fnName: subFn, argc: 2 });
  ctx.ir.push({ kind: "LoadLocal", index: jLocal });
  ctx.ir.push({ kind: "ListSwap" });

  // j = j - 1
  ctx.ir.push({ kind: "LoadLocal", index: jLocal });
  ctx.ir.push({ kind: "PushConst", value: mkNumberValue(1) });
  ctx.ir.push({ kind: "HostCall", fnName: subFn, argc: 2 });
  ctx.ir.push({ kind: "StoreLocal", index: jLocal });

  ctx.ir.push({ kind: "Jump", labelId: loopInner });

  // INNER_END:
  ctx.ir.push({ kind: "Label", labelId: loopInnerEnd });

  // i = i + 1
  ctx.ir.push({ kind: "LoadLocal", index: iLocal });
  ctx.ir.push({ kind: "PushConst", value: mkNumberValue(1) });
  ctx.ir.push({ kind: "HostCall", fnName: addFn, argc: 2 });
  ctx.ir.push({ kind: "StoreLocal", index: iLocal });

  ctx.ir.push({ kind: "Jump", labelId: loopOuter });

  // END:
  ctx.ir.push({ kind: "Label", labelId: loopOuterEnd });

  // sort returns the same array
  ctx.ir.push({ kind: "LoadLocal", index: srcListLocal });
}

function lowerListIndexOf(expr: ts.CallExpression, propAccess: ts.PropertyAccessExpression, ctx: LowerContext): void {
  /**
   * Equivalent TS:
   * @example
   *   let idx = 0;
   *   while (idx < arr.length) {
   *     if (arr[idx] === search) return idx; idx++;
   *   }
   *   return -1;
   */
  if (expr.arguments.length !== 1) {
    ctx.diagnostics.push(
      makeDiag(LoweringDiagCode.IndexOfRequiresOneArg, ".indexOf() requires exactly 1 argument", expr)
    );
    return;
  }

  const loopStart = allocLabel(ctx);
  const loopEnd = allocLabel(ctx);
  const foundLabel = allocLabel(ctx);

  const listLocal = ctx.scopeStack.allocLocal();
  const searchLocal = ctx.scopeStack.allocLocal();
  const idxLocal = ctx.scopeStack.allocLocal();
  const lenLocal = ctx.scopeStack.allocLocal();

  lowerExpression(propAccess.expression, ctx);
  ctx.ir.push({ kind: "StoreLocal", index: listLocal });
  lowerExpression(expr.arguments[0], ctx);
  ctx.ir.push({ kind: "StoreLocal", index: searchLocal });

  ctx.ir.push({ kind: "PushConst", value: mkNumberValue(0) });
  ctx.ir.push({ kind: "StoreLocal", index: idxLocal });

  ctx.ir.push({ kind: "LoadLocal", index: listLocal });
  ctx.ir.push({ kind: "ListLen" });
  ctx.ir.push({ kind: "StoreLocal", index: lenLocal });

  ctx.ir.push({ kind: "Label", labelId: loopStart });

  ctx.ir.push({ kind: "LoadLocal", index: idxLocal });
  ctx.ir.push({ kind: "LoadLocal", index: lenLocal });
  const ltFn = resolveOperator(CoreOpId.LessThan, [CoreTypeIds.Number, CoreTypeIds.Number], ctx.services);
  if (!ltFn) {
    ctx.diagnostics.push(
      makeDiag(LoweringDiagCode.CannotResolveOperatorForArrayMethod, "Cannot resolve < operator for .indexOf()", expr)
    );
    return;
  }
  ctx.ir.push({ kind: "HostCall", fnName: ltFn, argc: 2 });
  ctx.ir.push({ kind: "JumpIfFalse", labelId: loopEnd });

  ctx.ir.push({ kind: "LoadLocal", index: listLocal });
  ctx.ir.push({ kind: "LoadLocal", index: idxLocal });
  ctx.ir.push({ kind: "ListGet" });
  ctx.ir.push({ kind: "LoadLocal", index: searchLocal });

  const searchType = ctx.checker.getTypeAtLocation(expr.arguments[0]);
  const searchTypeId = tsTypeToTypeId(searchType, ctx.checker, ctx.services, ctx.projectNamespace);
  const eqFn = searchTypeId ? resolveOperator(CoreOpId.EqualTo, [searchTypeId, searchTypeId], ctx.services) : undefined;
  if (!eqFn) {
    ctx.diagnostics.push(
      makeDiag(LoweringDiagCode.CannotResolveOperatorForArrayMethod, "Cannot resolve === operator for .indexOf()", expr)
    );
    return;
  }
  ctx.ir.push({ kind: "HostCall", fnName: eqFn, argc: 2 });
  ctx.ir.push({ kind: "JumpIfTrue", labelId: foundLabel });

  ctx.ir.push({ kind: "LoadLocal", index: idxLocal });
  ctx.ir.push({ kind: "PushConst", value: mkNumberValue(1) });
  const addFn = resolveOperator(CoreOpId.Add, [CoreTypeIds.Number, CoreTypeIds.Number], ctx.services);
  if (!addFn) {
    ctx.diagnostics.push(
      makeDiag(LoweringDiagCode.CannotResolveOperatorForArrayMethod, "Cannot resolve + operator for .indexOf()", expr)
    );
    return;
  }
  ctx.ir.push({ kind: "HostCall", fnName: addFn, argc: 2 });
  ctx.ir.push({ kind: "StoreLocal", index: idxLocal });
  ctx.ir.push({ kind: "Jump", labelId: loopStart });

  ctx.ir.push({ kind: "Label", labelId: foundLabel });
  ctx.ir.push({ kind: "LoadLocal", index: idxLocal });
  ctx.ir.push({ kind: "Jump", labelId: allocLabel(ctx) });
  const doneLabel = ctx.nextLabelId - 1;

  ctx.ir.push({ kind: "Label", labelId: loopEnd });
  ctx.ir.push({ kind: "PushConst", value: mkNumberValue(-1) });

  ctx.ir.push({ kind: "Label", labelId: doneLabel });
}

function lowerListFilter(
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
  listTypeId: string,
  ctx: LowerContext
): void {
  /**
   * Equivalent TS:
   * @example
   *   const result: T[] = [];
   *   for (let i = 0; i < arr.length; i++) {
   *     const elem = arr[i]; if (callback(elem)) result.push(elem);
   *   }
   *   return result;
   */
  if (expr.arguments.length !== 1) {
    ctx.diagnostics.push(
      makeDiag(LoweringDiagCode.FilterRequiresOneArg, ".filter() requires exactly 1 argument", expr)
    );
    return;
  }

  const loopStart = allocLabel(ctx);
  const loopEnd = allocLabel(ctx);
  const skipLabel = allocLabel(ctx);

  const srcListLocal = ctx.scopeStack.allocLocal();
  const resultListLocal = ctx.scopeStack.allocLocal();
  const idxLocal = ctx.scopeStack.allocLocal();
  const lenLocal = ctx.scopeStack.allocLocal();
  const callbackLocal = ctx.scopeStack.allocLocal();

  lowerExpression(propAccess.expression, ctx);
  ctx.ir.push({ kind: "StoreLocal", index: srcListLocal });

  ctx.ir.push({ kind: "ListNew", typeId: listTypeId });
  ctx.ir.push({ kind: "StoreLocal", index: resultListLocal });

  lowerExpression(expr.arguments[0], ctx);
  ctx.ir.push({ kind: "StoreLocal", index: callbackLocal });

  ctx.ir.push({ kind: "PushConst", value: mkNumberValue(0) });
  ctx.ir.push({ kind: "StoreLocal", index: idxLocal });

  ctx.ir.push({ kind: "LoadLocal", index: srcListLocal });
  ctx.ir.push({ kind: "ListLen" });
  ctx.ir.push({ kind: "StoreLocal", index: lenLocal });

  ctx.ir.push({ kind: "Label", labelId: loopStart });

  ctx.ir.push({ kind: "LoadLocal", index: idxLocal });
  ctx.ir.push({ kind: "LoadLocal", index: lenLocal });
  const ltFn = resolveOperator(CoreOpId.LessThan, [CoreTypeIds.Number, CoreTypeIds.Number], ctx.services);
  if (!ltFn) {
    ctx.diagnostics.push(
      makeDiag(LoweringDiagCode.CannotResolveOperatorForArrayMethod, "Cannot resolve < operator for .filter()", expr)
    );
    return;
  }
  ctx.ir.push({ kind: "HostCall", fnName: ltFn, argc: 2 });
  ctx.ir.push({ kind: "JumpIfFalse", labelId: loopEnd });

  ctx.ir.push({ kind: "LoadLocal", index: srcListLocal });
  ctx.ir.push({ kind: "LoadLocal", index: idxLocal });
  ctx.ir.push({ kind: "ListGet" });

  ctx.ir.push({ kind: "Dup" });

  ctx.ir.push({ kind: "LoadLocal", index: callbackLocal });
  ctx.ir.push({ kind: "Swap" });
  ctx.ir.push({ kind: "LoadLocal", index: idxLocal });
  ctx.ir.push({ kind: "CallIndirectArgs", argc: 2 });

  ctx.ir.push({ kind: "JumpIfFalse", labelId: skipLabel });

  ctx.ir.push({ kind: "LoadLocal", index: resultListLocal });
  ctx.ir.push({ kind: "Swap" });
  ctx.ir.push({ kind: "ListPush" });
  ctx.ir.push({ kind: "StoreLocal", index: resultListLocal });
  const afterPushLabel = allocLabel(ctx);
  ctx.ir.push({ kind: "Jump", labelId: afterPushLabel });

  ctx.ir.push({ kind: "Label", labelId: skipLabel });
  ctx.ir.push({ kind: "Pop" });

  ctx.ir.push({ kind: "Label", labelId: afterPushLabel });

  ctx.ir.push({ kind: "LoadLocal", index: idxLocal });
  ctx.ir.push({ kind: "PushConst", value: mkNumberValue(1) });
  const addFn = resolveOperator(CoreOpId.Add, [CoreTypeIds.Number, CoreTypeIds.Number], ctx.services);
  if (!addFn) {
    ctx.diagnostics.push(
      makeDiag(LoweringDiagCode.CannotResolveOperatorForArrayMethod, "Cannot resolve + operator for .filter()", expr)
    );
    return;
  }
  ctx.ir.push({ kind: "HostCall", fnName: addFn, argc: 2 });
  ctx.ir.push({ kind: "StoreLocal", index: idxLocal });
  ctx.ir.push({ kind: "Jump", labelId: loopStart });

  ctx.ir.push({ kind: "Label", labelId: loopEnd });
  ctx.ir.push({ kind: "LoadLocal", index: resultListLocal });
}

function lowerListMap(expr: ts.CallExpression, propAccess: ts.PropertyAccessExpression, ctx: LowerContext): void {
  /**
   * Equivalent TS:
   * @example
   *   const result: U[] = [];
   *   for (let i = 0; i < arr.length; i++) result.push(callback(arr[i]));
   *   return result;
   */
  if (expr.arguments.length !== 1) {
    ctx.diagnostics.push(makeDiag(LoweringDiagCode.MapRequiresOneArg, ".map() requires exactly 1 argument", expr));
    return;
  }

  const returnType = ctx.checker.getTypeAtLocation(expr);
  const resultListTypeId = resolveListTypeId(returnType, ctx);
  if (!resultListTypeId) {
    ctx.diagnostics.push(
      makeDiag(
        LoweringDiagCode.CannotDetermineMapResultListType,
        "Cannot determine result list type for .map() (add a type annotation)",
        expr
      )
    );
    return;
  }

  const loopStart = allocLabel(ctx);
  const loopEnd = allocLabel(ctx);

  const srcListLocal = ctx.scopeStack.allocLocal();
  const resultListLocal = ctx.scopeStack.allocLocal();
  const idxLocal = ctx.scopeStack.allocLocal();
  const lenLocal = ctx.scopeStack.allocLocal();
  const callbackLocal = ctx.scopeStack.allocLocal();

  lowerExpression(propAccess.expression, ctx);
  ctx.ir.push({ kind: "StoreLocal", index: srcListLocal });

  ctx.ir.push({ kind: "ListNew", typeId: resultListTypeId });
  ctx.ir.push({ kind: "StoreLocal", index: resultListLocal });

  lowerExpression(expr.arguments[0], ctx);
  ctx.ir.push({ kind: "StoreLocal", index: callbackLocal });

  ctx.ir.push({ kind: "PushConst", value: mkNumberValue(0) });
  ctx.ir.push({ kind: "StoreLocal", index: idxLocal });

  ctx.ir.push({ kind: "LoadLocal", index: srcListLocal });
  ctx.ir.push({ kind: "ListLen" });
  ctx.ir.push({ kind: "StoreLocal", index: lenLocal });

  ctx.ir.push({ kind: "Label", labelId: loopStart });

  ctx.ir.push({ kind: "LoadLocal", index: idxLocal });
  ctx.ir.push({ kind: "LoadLocal", index: lenLocal });
  const ltFn = resolveOperator(CoreOpId.LessThan, [CoreTypeIds.Number, CoreTypeIds.Number], ctx.services);
  if (!ltFn) {
    ctx.diagnostics.push(
      makeDiag(LoweringDiagCode.CannotResolveOperatorForArrayMethod, "Cannot resolve < operator for .map()", expr)
    );
    return;
  }
  ctx.ir.push({ kind: "HostCall", fnName: ltFn, argc: 2 });
  ctx.ir.push({ kind: "JumpIfFalse", labelId: loopEnd });

  ctx.ir.push({ kind: "LoadLocal", index: callbackLocal });
  ctx.ir.push({ kind: "LoadLocal", index: srcListLocal });
  ctx.ir.push({ kind: "LoadLocal", index: idxLocal });
  ctx.ir.push({ kind: "ListGet" });
  ctx.ir.push({ kind: "LoadLocal", index: idxLocal });
  ctx.ir.push({ kind: "CallIndirectArgs", argc: 2 });

  ctx.ir.push({ kind: "LoadLocal", index: resultListLocal });
  ctx.ir.push({ kind: "Swap" });
  ctx.ir.push({ kind: "ListPush" });
  ctx.ir.push({ kind: "StoreLocal", index: resultListLocal });

  ctx.ir.push({ kind: "LoadLocal", index: idxLocal });
  ctx.ir.push({ kind: "PushConst", value: mkNumberValue(1) });
  const addFn = resolveOperator(CoreOpId.Add, [CoreTypeIds.Number, CoreTypeIds.Number], ctx.services);
  if (!addFn) {
    ctx.diagnostics.push(
      makeDiag(LoweringDiagCode.CannotResolveOperatorForArrayMethod, "Cannot resolve + operator for .map()", expr)
    );
    return;
  }
  ctx.ir.push({ kind: "HostCall", fnName: addFn, argc: 2 });
  ctx.ir.push({ kind: "StoreLocal", index: idxLocal });
  ctx.ir.push({ kind: "Jump", labelId: loopStart });

  ctx.ir.push({ kind: "Label", labelId: loopEnd });
  ctx.ir.push({ kind: "LoadLocal", index: resultListLocal });
}

function lowerListForEach(expr: ts.CallExpression, propAccess: ts.PropertyAccessExpression, ctx: LowerContext): void {
  /**
   * Equivalent TS:
   * @example
   *   for (let i = 0; i < arr.length; i++) callback(arr[i]);
   */
  if (expr.arguments.length !== 1) {
    ctx.diagnostics.push(
      makeDiag(LoweringDiagCode.ForEachRequiresOneArg, ".forEach() requires exactly 1 argument", expr)
    );
    return;
  }

  const loopStart = allocLabel(ctx);
  const loopEnd = allocLabel(ctx);

  const srcListLocal = ctx.scopeStack.allocLocal();
  const idxLocal = ctx.scopeStack.allocLocal();
  const lenLocal = ctx.scopeStack.allocLocal();
  const callbackLocal = ctx.scopeStack.allocLocal();

  lowerExpression(propAccess.expression, ctx);
  ctx.ir.push({ kind: "StoreLocal", index: srcListLocal });

  lowerExpression(expr.arguments[0], ctx);
  ctx.ir.push({ kind: "StoreLocal", index: callbackLocal });

  ctx.ir.push({ kind: "PushConst", value: mkNumberValue(0) });
  ctx.ir.push({ kind: "StoreLocal", index: idxLocal });

  ctx.ir.push({ kind: "LoadLocal", index: srcListLocal });
  ctx.ir.push({ kind: "ListLen" });
  ctx.ir.push({ kind: "StoreLocal", index: lenLocal });

  ctx.ir.push({ kind: "Label", labelId: loopStart });

  ctx.ir.push({ kind: "LoadLocal", index: idxLocal });
  ctx.ir.push({ kind: "LoadLocal", index: lenLocal });
  const ltFn = resolveOperator(CoreOpId.LessThan, [CoreTypeIds.Number, CoreTypeIds.Number], ctx.services);
  if (!ltFn) {
    ctx.diagnostics.push(
      makeDiag(LoweringDiagCode.CannotResolveOperatorForArrayMethod, "Cannot resolve < operator for .forEach()", expr)
    );
    return;
  }
  ctx.ir.push({ kind: "HostCall", fnName: ltFn, argc: 2 });
  ctx.ir.push({ kind: "JumpIfFalse", labelId: loopEnd });

  ctx.ir.push({ kind: "LoadLocal", index: callbackLocal });
  ctx.ir.push({ kind: "LoadLocal", index: srcListLocal });
  ctx.ir.push({ kind: "LoadLocal", index: idxLocal });
  ctx.ir.push({ kind: "ListGet" });
  ctx.ir.push({ kind: "LoadLocal", index: idxLocal });
  ctx.ir.push({ kind: "CallIndirectArgs", argc: 2 });
  ctx.ir.push({ kind: "Pop" });

  ctx.ir.push({ kind: "LoadLocal", index: idxLocal });
  ctx.ir.push({ kind: "PushConst", value: mkNumberValue(1) });
  const addFn = resolveOperator(CoreOpId.Add, [CoreTypeIds.Number, CoreTypeIds.Number], ctx.services);
  if (!addFn) {
    ctx.diagnostics.push(
      makeDiag(LoweringDiagCode.CannotResolveOperatorForArrayMethod, "Cannot resolve + operator for .forEach()", expr)
    );
    return;
  }
  ctx.ir.push({ kind: "HostCall", fnName: addFn, argc: 2 });
  ctx.ir.push({ kind: "StoreLocal", index: idxLocal });
  ctx.ir.push({ kind: "Jump", labelId: loopStart });

  ctx.ir.push({ kind: "Label", labelId: loopEnd });
  ctx.ir.push({ kind: "PushConst", value: NIL_VALUE });
}

function lowerListIncludes(expr: ts.CallExpression, propAccess: ts.PropertyAccessExpression, ctx: LowerContext): void {
  /**
   * Equivalent TS:
   * @example
   *   for (let i = 0; i < arr.length; i++) { if (arr[i] === search) return true; }
   *   return false;
   */
  if (expr.arguments.length !== 1) {
    ctx.diagnostics.push(
      makeDiag(LoweringDiagCode.IncludesRequiresOneArg, ".includes() requires exactly 1 argument", expr)
    );
    return;
  }

  const loopStart = allocLabel(ctx);
  const loopEnd = allocLabel(ctx);
  const foundLabel = allocLabel(ctx);
  const doneLabel = allocLabel(ctx);

  const listLocal = ctx.scopeStack.allocLocal();
  const searchLocal = ctx.scopeStack.allocLocal();
  const idxLocal = ctx.scopeStack.allocLocal();
  const lenLocal = ctx.scopeStack.allocLocal();

  lowerExpression(propAccess.expression, ctx);
  ctx.ir.push({ kind: "StoreLocal", index: listLocal });
  lowerExpression(expr.arguments[0], ctx);
  ctx.ir.push({ kind: "StoreLocal", index: searchLocal });

  ctx.ir.push({ kind: "PushConst", value: mkNumberValue(0) });
  ctx.ir.push({ kind: "StoreLocal", index: idxLocal });

  ctx.ir.push({ kind: "LoadLocal", index: listLocal });
  ctx.ir.push({ kind: "ListLen" });
  ctx.ir.push({ kind: "StoreLocal", index: lenLocal });

  ctx.ir.push({ kind: "Label", labelId: loopStart });

  ctx.ir.push({ kind: "LoadLocal", index: idxLocal });
  ctx.ir.push({ kind: "LoadLocal", index: lenLocal });
  const ltFn = resolveOperator(CoreOpId.LessThan, [CoreTypeIds.Number, CoreTypeIds.Number], ctx.services);
  if (!ltFn) {
    ctx.diagnostics.push(
      makeDiag(LoweringDiagCode.CannotResolveOperatorForArrayMethod, "Cannot resolve < operator for .includes()", expr)
    );
    return;
  }
  ctx.ir.push({ kind: "HostCall", fnName: ltFn, argc: 2 });
  ctx.ir.push({ kind: "JumpIfFalse", labelId: loopEnd });

  ctx.ir.push({ kind: "LoadLocal", index: listLocal });
  ctx.ir.push({ kind: "LoadLocal", index: idxLocal });
  ctx.ir.push({ kind: "ListGet" });
  ctx.ir.push({ kind: "LoadLocal", index: searchLocal });

  const searchType = ctx.checker.getTypeAtLocation(expr.arguments[0]);
  const searchTypeId = tsTypeToTypeId(searchType, ctx.checker, ctx.services, ctx.projectNamespace);
  const eqFn = searchTypeId ? resolveOperator(CoreOpId.EqualTo, [searchTypeId, searchTypeId], ctx.services) : undefined;
  if (!eqFn) {
    ctx.diagnostics.push(
      makeDiag(
        LoweringDiagCode.CannotResolveOperatorForArrayMethod,
        "Cannot resolve === operator for .includes()",
        expr
      )
    );
    return;
  }
  ctx.ir.push({ kind: "HostCall", fnName: eqFn, argc: 2 });
  ctx.ir.push({ kind: "JumpIfTrue", labelId: foundLabel });

  ctx.ir.push({ kind: "LoadLocal", index: idxLocal });
  ctx.ir.push({ kind: "PushConst", value: mkNumberValue(1) });
  const addFn = resolveOperator(CoreOpId.Add, [CoreTypeIds.Number, CoreTypeIds.Number], ctx.services);
  if (!addFn) {
    ctx.diagnostics.push(
      makeDiag(LoweringDiagCode.CannotResolveOperatorForArrayMethod, "Cannot resolve + operator for .includes()", expr)
    );
    return;
  }
  ctx.ir.push({ kind: "HostCall", fnName: addFn, argc: 2 });
  ctx.ir.push({ kind: "StoreLocal", index: idxLocal });
  ctx.ir.push({ kind: "Jump", labelId: loopStart });

  ctx.ir.push({ kind: "Label", labelId: foundLabel });
  ctx.ir.push({ kind: "PushConst", value: TRUE_VALUE });
  ctx.ir.push({ kind: "Jump", labelId: doneLabel });

  ctx.ir.push({ kind: "Label", labelId: loopEnd });
  ctx.ir.push({ kind: "PushConst", value: FALSE_VALUE });

  ctx.ir.push({ kind: "Label", labelId: doneLabel });
}

function lowerListSome(expr: ts.CallExpression, propAccess: ts.PropertyAccessExpression, ctx: LowerContext): void {
  /**
   * Equivalent TS:
   * @example
   *   for (let i = 0; i < arr.length; i++) { if (callback(arr[i])) return true; }
   *   return false;
   */
  if (expr.arguments.length !== 1) {
    ctx.diagnostics.push(makeDiag(LoweringDiagCode.SomeRequiresOneArg, ".some() requires exactly 1 argument", expr));
    return;
  }

  const loopStart = allocLabel(ctx);
  const loopEnd = allocLabel(ctx);
  const foundLabel = allocLabel(ctx);
  const doneLabel = allocLabel(ctx);

  const srcListLocal = ctx.scopeStack.allocLocal();
  const idxLocal = ctx.scopeStack.allocLocal();
  const lenLocal = ctx.scopeStack.allocLocal();
  const callbackLocal = ctx.scopeStack.allocLocal();

  lowerExpression(propAccess.expression, ctx);
  ctx.ir.push({ kind: "StoreLocal", index: srcListLocal });

  lowerExpression(expr.arguments[0], ctx);
  ctx.ir.push({ kind: "StoreLocal", index: callbackLocal });

  ctx.ir.push({ kind: "PushConst", value: mkNumberValue(0) });
  ctx.ir.push({ kind: "StoreLocal", index: idxLocal });

  ctx.ir.push({ kind: "LoadLocal", index: srcListLocal });
  ctx.ir.push({ kind: "ListLen" });
  ctx.ir.push({ kind: "StoreLocal", index: lenLocal });

  ctx.ir.push({ kind: "Label", labelId: loopStart });

  ctx.ir.push({ kind: "LoadLocal", index: idxLocal });
  ctx.ir.push({ kind: "LoadLocal", index: lenLocal });
  const ltFn = resolveOperator(CoreOpId.LessThan, [CoreTypeIds.Number, CoreTypeIds.Number], ctx.services);
  if (!ltFn) {
    ctx.diagnostics.push(
      makeDiag(LoweringDiagCode.CannotResolveOperatorForArrayMethod, "Cannot resolve < operator for .some()", expr)
    );
    return;
  }
  ctx.ir.push({ kind: "HostCall", fnName: ltFn, argc: 2 });
  ctx.ir.push({ kind: "JumpIfFalse", labelId: loopEnd });

  ctx.ir.push({ kind: "LoadLocal", index: callbackLocal });
  ctx.ir.push({ kind: "LoadLocal", index: srcListLocal });
  ctx.ir.push({ kind: "LoadLocal", index: idxLocal });
  ctx.ir.push({ kind: "ListGet" });
  ctx.ir.push({ kind: "LoadLocal", index: idxLocal });
  ctx.ir.push({ kind: "CallIndirectArgs", argc: 2 });
  ctx.ir.push({ kind: "JumpIfTrue", labelId: foundLabel });

  ctx.ir.push({ kind: "LoadLocal", index: idxLocal });
  ctx.ir.push({ kind: "PushConst", value: mkNumberValue(1) });
  const addFn = resolveOperator(CoreOpId.Add, [CoreTypeIds.Number, CoreTypeIds.Number], ctx.services);
  if (!addFn) {
    ctx.diagnostics.push(
      makeDiag(LoweringDiagCode.CannotResolveOperatorForArrayMethod, "Cannot resolve + operator for .some()", expr)
    );
    return;
  }
  ctx.ir.push({ kind: "HostCall", fnName: addFn, argc: 2 });
  ctx.ir.push({ kind: "StoreLocal", index: idxLocal });
  ctx.ir.push({ kind: "Jump", labelId: loopStart });

  ctx.ir.push({ kind: "Label", labelId: foundLabel });
  ctx.ir.push({ kind: "PushConst", value: TRUE_VALUE });
  ctx.ir.push({ kind: "Jump", labelId: doneLabel });

  ctx.ir.push({ kind: "Label", labelId: loopEnd });
  ctx.ir.push({ kind: "PushConst", value: FALSE_VALUE });

  ctx.ir.push({ kind: "Label", labelId: doneLabel });
}

function lowerListEvery(expr: ts.CallExpression, propAccess: ts.PropertyAccessExpression, ctx: LowerContext): void {
  /**
   * Equivalent TS:
   * @example
   *   for (let i = 0; i < arr.length; i++) { if (!callback(arr[i])) return false; }
   *   return true;
   */
  if (expr.arguments.length !== 1) {
    ctx.diagnostics.push(makeDiag(LoweringDiagCode.EveryRequiresOneArg, ".every() requires exactly 1 argument", expr));
    return;
  }

  const loopStart = allocLabel(ctx);
  const loopEnd = allocLabel(ctx);
  const failLabel = allocLabel(ctx);
  const doneLabel = allocLabel(ctx);

  const srcListLocal = ctx.scopeStack.allocLocal();
  const idxLocal = ctx.scopeStack.allocLocal();
  const lenLocal = ctx.scopeStack.allocLocal();
  const callbackLocal = ctx.scopeStack.allocLocal();

  lowerExpression(propAccess.expression, ctx);
  ctx.ir.push({ kind: "StoreLocal", index: srcListLocal });

  lowerExpression(expr.arguments[0], ctx);
  ctx.ir.push({ kind: "StoreLocal", index: callbackLocal });

  ctx.ir.push({ kind: "PushConst", value: mkNumberValue(0) });
  ctx.ir.push({ kind: "StoreLocal", index: idxLocal });

  ctx.ir.push({ kind: "LoadLocal", index: srcListLocal });
  ctx.ir.push({ kind: "ListLen" });
  ctx.ir.push({ kind: "StoreLocal", index: lenLocal });

  ctx.ir.push({ kind: "Label", labelId: loopStart });

  ctx.ir.push({ kind: "LoadLocal", index: idxLocal });
  ctx.ir.push({ kind: "LoadLocal", index: lenLocal });
  const ltFn = resolveOperator(CoreOpId.LessThan, [CoreTypeIds.Number, CoreTypeIds.Number], ctx.services);
  if (!ltFn) {
    ctx.diagnostics.push(
      makeDiag(LoweringDiagCode.CannotResolveOperatorForArrayMethod, "Cannot resolve < operator for .every()", expr)
    );
    return;
  }
  ctx.ir.push({ kind: "HostCall", fnName: ltFn, argc: 2 });
  ctx.ir.push({ kind: "JumpIfFalse", labelId: loopEnd });

  ctx.ir.push({ kind: "LoadLocal", index: callbackLocal });
  ctx.ir.push({ kind: "LoadLocal", index: srcListLocal });
  ctx.ir.push({ kind: "LoadLocal", index: idxLocal });
  ctx.ir.push({ kind: "ListGet" });
  ctx.ir.push({ kind: "LoadLocal", index: idxLocal });
  ctx.ir.push({ kind: "CallIndirectArgs", argc: 2 });
  ctx.ir.push({ kind: "JumpIfFalse", labelId: failLabel });

  ctx.ir.push({ kind: "LoadLocal", index: idxLocal });
  ctx.ir.push({ kind: "PushConst", value: mkNumberValue(1) });
  const addFn = resolveOperator(CoreOpId.Add, [CoreTypeIds.Number, CoreTypeIds.Number], ctx.services);
  if (!addFn) {
    ctx.diagnostics.push(
      makeDiag(LoweringDiagCode.CannotResolveOperatorForArrayMethod, "Cannot resolve + operator for .every()", expr)
    );
    return;
  }
  ctx.ir.push({ kind: "HostCall", fnName: addFn, argc: 2 });
  ctx.ir.push({ kind: "StoreLocal", index: idxLocal });
  ctx.ir.push({ kind: "Jump", labelId: loopStart });

  ctx.ir.push({ kind: "Label", labelId: loopEnd });
  ctx.ir.push({ kind: "PushConst", value: TRUE_VALUE });
  ctx.ir.push({ kind: "Jump", labelId: doneLabel });

  ctx.ir.push({ kind: "Label", labelId: failLabel });
  ctx.ir.push({ kind: "PushConst", value: FALSE_VALUE });

  ctx.ir.push({ kind: "Label", labelId: doneLabel });
}

function lowerListFind(expr: ts.CallExpression, propAccess: ts.PropertyAccessExpression, ctx: LowerContext): void {
  /**
   * Equivalent TS:
   * @example
   *   for (let i = 0; i < arr.length; i++) {
   *     const elem = arr[i]; if (callback(elem)) return elem;
   *   }
   *   return undefined;
   */
  if (expr.arguments.length !== 1) {
    ctx.diagnostics.push(makeDiag(LoweringDiagCode.FindRequiresOneArg, ".find() requires exactly 1 argument", expr));
    return;
  }

  const loopStart = allocLabel(ctx);
  const loopEnd = allocLabel(ctx);
  const foundLabel = allocLabel(ctx);
  const doneLabel = allocLabel(ctx);

  const srcListLocal = ctx.scopeStack.allocLocal();
  const idxLocal = ctx.scopeStack.allocLocal();
  const lenLocal = ctx.scopeStack.allocLocal();
  const callbackLocal = ctx.scopeStack.allocLocal();
  const elemLocal = ctx.scopeStack.allocLocal();

  lowerExpression(propAccess.expression, ctx);
  ctx.ir.push({ kind: "StoreLocal", index: srcListLocal });

  lowerExpression(expr.arguments[0], ctx);
  ctx.ir.push({ kind: "StoreLocal", index: callbackLocal });

  ctx.ir.push({ kind: "PushConst", value: mkNumberValue(0) });
  ctx.ir.push({ kind: "StoreLocal", index: idxLocal });

  ctx.ir.push({ kind: "LoadLocal", index: srcListLocal });
  ctx.ir.push({ kind: "ListLen" });
  ctx.ir.push({ kind: "StoreLocal", index: lenLocal });

  ctx.ir.push({ kind: "Label", labelId: loopStart });

  ctx.ir.push({ kind: "LoadLocal", index: idxLocal });
  ctx.ir.push({ kind: "LoadLocal", index: lenLocal });
  const ltFn = resolveOperator(CoreOpId.LessThan, [CoreTypeIds.Number, CoreTypeIds.Number], ctx.services);
  if (!ltFn) {
    ctx.diagnostics.push(
      makeDiag(LoweringDiagCode.CannotResolveOperatorForArrayMethod, "Cannot resolve < operator for .find()", expr)
    );
    return;
  }
  ctx.ir.push({ kind: "HostCall", fnName: ltFn, argc: 2 });
  ctx.ir.push({ kind: "JumpIfFalse", labelId: loopEnd });

  ctx.ir.push({ kind: "LoadLocal", index: srcListLocal });
  ctx.ir.push({ kind: "LoadLocal", index: idxLocal });
  ctx.ir.push({ kind: "ListGet" });
  ctx.ir.push({ kind: "StoreLocal", index: elemLocal });

  ctx.ir.push({ kind: "LoadLocal", index: callbackLocal });
  ctx.ir.push({ kind: "LoadLocal", index: elemLocal });
  ctx.ir.push({ kind: "LoadLocal", index: idxLocal });
  ctx.ir.push({ kind: "CallIndirectArgs", argc: 2 });
  ctx.ir.push({ kind: "JumpIfTrue", labelId: foundLabel });

  ctx.ir.push({ kind: "LoadLocal", index: idxLocal });
  ctx.ir.push({ kind: "PushConst", value: mkNumberValue(1) });
  const addFn = resolveOperator(CoreOpId.Add, [CoreTypeIds.Number, CoreTypeIds.Number], ctx.services);
  if (!addFn) {
    ctx.diagnostics.push(
      makeDiag(LoweringDiagCode.CannotResolveOperatorForArrayMethod, "Cannot resolve + operator for .find()", expr)
    );
    return;
  }
  ctx.ir.push({ kind: "HostCall", fnName: addFn, argc: 2 });
  ctx.ir.push({ kind: "StoreLocal", index: idxLocal });
  ctx.ir.push({ kind: "Jump", labelId: loopStart });

  ctx.ir.push({ kind: "Label", labelId: foundLabel });
  ctx.ir.push({ kind: "LoadLocal", index: elemLocal });
  ctx.ir.push({ kind: "Jump", labelId: doneLabel });

  ctx.ir.push({ kind: "Label", labelId: loopEnd });
  ctx.ir.push({ kind: "PushConst", value: NIL_VALUE });

  ctx.ir.push({ kind: "Label", labelId: doneLabel });
}

function lowerListConcat(
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
  listTypeId: string,
  ctx: LowerContext
): void {
  /**
   * Equivalent TS:
   * @example
   *   const result: T[] = [...arr, ...args[0], ...args[1], ...];
   *   return result;
   */
  const resultLocal = ctx.scopeStack.allocLocal();

  ctx.ir.push({ kind: "ListNew", typeId: listTypeId });
  ctx.ir.push({ kind: "StoreLocal", index: resultLocal });

  emitPushAllFromList(propAccess.expression, resultLocal, ctx, expr);

  for (const arg of expr.arguments) {
    emitPushAllFromList(arg, resultLocal, ctx, expr);
  }

  ctx.ir.push({ kind: "LoadLocal", index: resultLocal });
}

function emitPushAllFromList(srcExpr: ts.Expression, resultLocal: number, ctx: LowerContext, diagNode: ts.Node): void {
  const loopStart = allocLabel(ctx);
  const loopEnd = allocLabel(ctx);

  const srcLocal = ctx.scopeStack.allocLocal();
  const idxLocal = ctx.scopeStack.allocLocal();
  const lenLocal = ctx.scopeStack.allocLocal();

  lowerExpression(srcExpr, ctx);
  ctx.ir.push({ kind: "StoreLocal", index: srcLocal });

  ctx.ir.push({ kind: "PushConst", value: mkNumberValue(0) });
  ctx.ir.push({ kind: "StoreLocal", index: idxLocal });

  ctx.ir.push({ kind: "LoadLocal", index: srcLocal });
  ctx.ir.push({ kind: "ListLen" });
  ctx.ir.push({ kind: "StoreLocal", index: lenLocal });

  ctx.ir.push({ kind: "Label", labelId: loopStart });

  ctx.ir.push({ kind: "LoadLocal", index: idxLocal });
  ctx.ir.push({ kind: "LoadLocal", index: lenLocal });
  const ltFn = resolveOperator(CoreOpId.LessThan, [CoreTypeIds.Number, CoreTypeIds.Number], ctx.services);
  if (!ltFn) {
    ctx.diagnostics.push(
      makeDiag(
        LoweringDiagCode.CannotResolveOperatorForArrayMethod,
        "Cannot resolve < operator for .concat()",
        diagNode
      )
    );
    return;
  }
  ctx.ir.push({ kind: "HostCall", fnName: ltFn, argc: 2 });
  ctx.ir.push({ kind: "JumpIfFalse", labelId: loopEnd });

  ctx.ir.push({ kind: "LoadLocal", index: resultLocal });
  ctx.ir.push({ kind: "LoadLocal", index: srcLocal });
  ctx.ir.push({ kind: "LoadLocal", index: idxLocal });
  ctx.ir.push({ kind: "ListGet" });
  ctx.ir.push({ kind: "ListPush" });
  ctx.ir.push({ kind: "StoreLocal", index: resultLocal });

  ctx.ir.push({ kind: "LoadLocal", index: idxLocal });
  ctx.ir.push({ kind: "PushConst", value: mkNumberValue(1) });
  const addFn = resolveOperator(CoreOpId.Add, [CoreTypeIds.Number, CoreTypeIds.Number], ctx.services);
  if (!addFn) {
    ctx.diagnostics.push(
      makeDiag(
        LoweringDiagCode.CannotResolveOperatorForArrayMethod,
        "Cannot resolve + operator for .concat()",
        diagNode
      )
    );
    return;
  }
  ctx.ir.push({ kind: "HostCall", fnName: addFn, argc: 2 });
  ctx.ir.push({ kind: "StoreLocal", index: idxLocal });
  ctx.ir.push({ kind: "Jump", labelId: loopStart });

  ctx.ir.push({ kind: "Label", labelId: loopEnd });
}

function lowerListJoin(expr: ts.CallExpression, propAccess: ts.PropertyAccessExpression, ctx: LowerContext): void {
  if (expr.arguments.length > 1) {
    ctx.diagnostics.push(makeDiag(LoweringDiagCode.JoinTakesAtMostOneArg, ".join() takes at most 1 argument", expr));
    return;
  }

  const sepExpr = expr.arguments.length === 1 ? expr.arguments[0] : undefined;
  lowerListJoinWithSeparator(propAccess.expression, sepExpr, ctx, expr);
}

function lowerListJoinWithSeparator(
  listExpr: ts.Expression,
  sepExpr: ts.Expression | undefined,
  ctx: LowerContext,
  diagNode: ts.Node
): void {
  const addFnName = resolveOperator(CoreOpId.Add, [CoreTypeIds.String, CoreTypeIds.String], ctx.services);
  if (!addFnName) {
    ctx.diagnostics.push(
      makeDiag(LoweringDiagCode.NoOverloadForStringConcat, "Cannot resolve string concatenation for .join()", diagNode)
    );
    return;
  }

  const loopStart = allocLabel(ctx);
  const loopEnd = allocLabel(ctx);
  const skipSepLabel = allocLabel(ctx);

  const srcListLocal = ctx.scopeStack.allocLocal();
  const sepLocal = ctx.scopeStack.allocLocal();
  const resultLocal = ctx.scopeStack.allocLocal();
  const idxLocal = ctx.scopeStack.allocLocal();
  const lenLocal = ctx.scopeStack.allocLocal();

  lowerExpression(listExpr, ctx);
  ctx.ir.push({ kind: "StoreLocal", index: srcListLocal });

  if (sepExpr) {
    lowerExpression(sepExpr, ctx);
  } else {
    ctx.ir.push({ kind: "PushConst", value: mkStringValue(",") });
  }
  ctx.ir.push({ kind: "StoreLocal", index: sepLocal });

  ctx.ir.push({ kind: "PushConst", value: mkStringValue("") });
  ctx.ir.push({ kind: "StoreLocal", index: resultLocal });

  ctx.ir.push({ kind: "PushConst", value: mkNumberValue(0) });
  ctx.ir.push({ kind: "StoreLocal", index: idxLocal });

  ctx.ir.push({ kind: "LoadLocal", index: srcListLocal });
  ctx.ir.push({ kind: "ListLen" });
  ctx.ir.push({ kind: "StoreLocal", index: lenLocal });

  const ltFn = resolveOperator(CoreOpId.LessThan, [CoreTypeIds.Number, CoreTypeIds.Number], ctx.services);
  if (!ltFn) {
    ctx.diagnostics.push(
      makeDiag(LoweringDiagCode.CannotResolveOperatorForArrayMethod, "Cannot resolve < operator for .join()", diagNode)
    );
    return;
  }

  const eqFn = resolveOperator(CoreOpId.EqualTo, [CoreTypeIds.Number, CoreTypeIds.Number], ctx.services);
  if (!eqFn) {
    ctx.diagnostics.push(
      makeDiag(
        LoweringDiagCode.CannotResolveOperatorForArrayMethod,
        "Cannot resolve === operator for .join()",
        diagNode
      )
    );
    return;
  }

  const addNumFn = resolveOperator(CoreOpId.Add, [CoreTypeIds.Number, CoreTypeIds.Number], ctx.services);
  if (!addNumFn) {
    ctx.diagnostics.push(
      makeDiag(LoweringDiagCode.CannotResolveOperatorForArrayMethod, "Cannot resolve + operator for .join()", diagNode)
    );
    return;
  }

  ctx.ir.push({ kind: "Label", labelId: loopStart });

  ctx.ir.push({ kind: "LoadLocal", index: idxLocal });
  ctx.ir.push({ kind: "LoadLocal", index: lenLocal });
  ctx.ir.push({ kind: "HostCall", fnName: ltFn, argc: 2 });
  ctx.ir.push({ kind: "JumpIfFalse", labelId: loopEnd });

  ctx.ir.push({ kind: "LoadLocal", index: idxLocal });
  ctx.ir.push({ kind: "PushConst", value: mkNumberValue(0) });
  ctx.ir.push({ kind: "HostCall", fnName: eqFn, argc: 2 });
  ctx.ir.push({ kind: "JumpIfTrue", labelId: skipSepLabel });

  ctx.ir.push({ kind: "LoadLocal", index: resultLocal });
  ctx.ir.push({ kind: "LoadLocal", index: sepLocal });
  ctx.ir.push({ kind: "HostCall", fnName: addFnName, argc: 2 });
  ctx.ir.push({ kind: "StoreLocal", index: resultLocal });

  ctx.ir.push({ kind: "Label", labelId: skipSepLabel });

  ctx.ir.push({ kind: "LoadLocal", index: srcListLocal });
  ctx.ir.push({ kind: "LoadLocal", index: idxLocal });
  ctx.ir.push({ kind: "ListGet" });

  emitToStringForJoinElement(ctx, diagNode);

  ctx.ir.push({ kind: "LoadLocal", index: resultLocal });
  ctx.ir.push({ kind: "Swap" });
  ctx.ir.push({ kind: "HostCall", fnName: addFnName, argc: 2 });
  ctx.ir.push({ kind: "StoreLocal", index: resultLocal });

  ctx.ir.push({ kind: "LoadLocal", index: idxLocal });
  ctx.ir.push({ kind: "PushConst", value: mkNumberValue(1) });
  ctx.ir.push({ kind: "HostCall", fnName: addNumFn, argc: 2 });
  ctx.ir.push({ kind: "StoreLocal", index: idxLocal });
  ctx.ir.push({ kind: "Jump", labelId: loopStart });

  ctx.ir.push({ kind: "Label", labelId: loopEnd });
  ctx.ir.push({ kind: "LoadLocal", index: resultLocal });
}

function emitToStringForJoinElement(ctx: LowerContext, diagNode: ts.Node): void {
  const conversion = resolveSingleStepConversion(CoreTypeIds.Number, CoreTypeIds.String, ctx.services);
  if (!conversion) {
    ctx.diagnostics.push(
      makeDiag(
        LoweringDiagCode.CannotConvertListElementToString,
        "Cannot convert list element to string for .join()",
        diagNode
      )
    );
    return;
  }
  emitSingleStepConversion(conversion.fnName, ctx);
}

function lowerListReverse(
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
  listTypeId: string,
  ctx: LowerContext
): void {
  /**
   * Equivalent TS:
   * @example
   *   const result: T[] = [];
   *   for (let i = arr.length - 1; i >= 0; i--) result.push(arr[i]);
   *   return result;
   */
  if (expr.arguments.length !== 0) {
    ctx.diagnostics.push(makeDiag(LoweringDiagCode.ReverseTakesNoArgs, ".reverse() takes no arguments", expr));
    return;
  }

  const loopStart = allocLabel(ctx);
  const loopEnd = allocLabel(ctx);

  const srcListLocal = ctx.scopeStack.allocLocal();
  const resultLocal = ctx.scopeStack.allocLocal();
  const idxLocal = ctx.scopeStack.allocLocal();

  lowerExpression(propAccess.expression, ctx);
  ctx.ir.push({ kind: "StoreLocal", index: srcListLocal });

  ctx.ir.push({ kind: "ListNew", typeId: listTypeId });
  ctx.ir.push({ kind: "StoreLocal", index: resultLocal });

  ctx.ir.push({ kind: "LoadLocal", index: srcListLocal });
  ctx.ir.push({ kind: "ListLen" });
  ctx.ir.push({ kind: "PushConst", value: mkNumberValue(1) });
  const subFn = resolveOperator(CoreOpId.Subtract, [CoreTypeIds.Number, CoreTypeIds.Number], ctx.services);
  if (!subFn) {
    ctx.diagnostics.push(
      makeDiag(LoweringDiagCode.CannotResolveOperatorForArrayMethod, "Cannot resolve - operator for .reverse()", expr)
    );
    return;
  }
  ctx.ir.push({ kind: "HostCall", fnName: subFn, argc: 2 });
  ctx.ir.push({ kind: "StoreLocal", index: idxLocal });

  const geqFn = resolveOperator(CoreOpId.GreaterThanOrEqualTo, [CoreTypeIds.Number, CoreTypeIds.Number], ctx.services);
  if (!geqFn) {
    ctx.diagnostics.push(
      makeDiag(LoweringDiagCode.CannotResolveOperatorForArrayMethod, "Cannot resolve >= operator for .reverse()", expr)
    );
    return;
  }

  ctx.ir.push({ kind: "Label", labelId: loopStart });

  ctx.ir.push({ kind: "LoadLocal", index: idxLocal });
  ctx.ir.push({ kind: "PushConst", value: mkNumberValue(0) });
  ctx.ir.push({ kind: "HostCall", fnName: geqFn, argc: 2 });
  ctx.ir.push({ kind: "JumpIfFalse", labelId: loopEnd });

  ctx.ir.push({ kind: "LoadLocal", index: resultLocal });
  ctx.ir.push({ kind: "LoadLocal", index: srcListLocal });
  ctx.ir.push({ kind: "LoadLocal", index: idxLocal });
  ctx.ir.push({ kind: "ListGet" });
  ctx.ir.push({ kind: "ListPush" });
  ctx.ir.push({ kind: "StoreLocal", index: resultLocal });

  ctx.ir.push({ kind: "LoadLocal", index: idxLocal });
  ctx.ir.push({ kind: "PushConst", value: mkNumberValue(1) });
  ctx.ir.push({ kind: "HostCall", fnName: subFn, argc: 2 });
  ctx.ir.push({ kind: "StoreLocal", index: idxLocal });
  ctx.ir.push({ kind: "Jump", labelId: loopStart });

  ctx.ir.push({ kind: "Label", labelId: loopEnd });
  ctx.ir.push({ kind: "LoadLocal", index: resultLocal });
}

function lowerListSlice(
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
  listTypeId: string,
  ctx: LowerContext
): void {
  /**
   * Equivalent TS:
   * @example
   *   const result: T[] = [];
   *   for (let i = start ?? 0; i < (end ?? arr.length); i++) result.push(arr[i]);
   *   return result;
   */
  if (expr.arguments.length > 2) {
    ctx.diagnostics.push(
      makeDiag(LoweringDiagCode.SliceTakesAtMostTwoArgs, ".slice() takes at most 2 arguments", expr)
    );
    return;
  }

  const loopStart = allocLabel(ctx);
  const loopEnd = allocLabel(ctx);

  const srcListLocal = ctx.scopeStack.allocLocal();
  const resultLocal = ctx.scopeStack.allocLocal();
  const idxLocal = ctx.scopeStack.allocLocal();
  const endLocal = ctx.scopeStack.allocLocal();

  lowerExpression(propAccess.expression, ctx);
  ctx.ir.push({ kind: "StoreLocal", index: srcListLocal });

  ctx.ir.push({ kind: "ListNew", typeId: listTypeId });
  ctx.ir.push({ kind: "StoreLocal", index: resultLocal });

  if (expr.arguments.length >= 1) {
    lowerExpression(expr.arguments[0], ctx);
  } else {
    ctx.ir.push({ kind: "PushConst", value: mkNumberValue(0) });
  }
  ctx.ir.push({ kind: "StoreLocal", index: idxLocal });

  if (expr.arguments.length >= 2) {
    lowerExpression(expr.arguments[1], ctx);
  } else {
    ctx.ir.push({ kind: "LoadLocal", index: srcListLocal });
    ctx.ir.push({ kind: "ListLen" });
  }
  ctx.ir.push({ kind: "StoreLocal", index: endLocal });

  const ltFn = resolveOperator(CoreOpId.LessThan, [CoreTypeIds.Number, CoreTypeIds.Number], ctx.services);
  if (!ltFn) {
    ctx.diagnostics.push(
      makeDiag(LoweringDiagCode.CannotResolveOperatorForArrayMethod, "Cannot resolve < operator for .slice()", expr)
    );
    return;
  }

  const addFn = resolveOperator(CoreOpId.Add, [CoreTypeIds.Number, CoreTypeIds.Number], ctx.services);
  if (!addFn) {
    ctx.diagnostics.push(
      makeDiag(LoweringDiagCode.CannotResolveOperatorForArrayMethod, "Cannot resolve + operator for .slice()", expr)
    );
    return;
  }

  ctx.ir.push({ kind: "Label", labelId: loopStart });

  ctx.ir.push({ kind: "LoadLocal", index: idxLocal });
  ctx.ir.push({ kind: "LoadLocal", index: endLocal });
  ctx.ir.push({ kind: "HostCall", fnName: ltFn, argc: 2 });
  ctx.ir.push({ kind: "JumpIfFalse", labelId: loopEnd });

  ctx.ir.push({ kind: "LoadLocal", index: resultLocal });
  ctx.ir.push({ kind: "LoadLocal", index: srcListLocal });
  ctx.ir.push({ kind: "LoadLocal", index: idxLocal });
  ctx.ir.push({ kind: "ListGet" });
  ctx.ir.push({ kind: "ListPush" });
  ctx.ir.push({ kind: "StoreLocal", index: resultLocal });

  ctx.ir.push({ kind: "LoadLocal", index: idxLocal });
  ctx.ir.push({ kind: "PushConst", value: mkNumberValue(1) });
  ctx.ir.push({ kind: "HostCall", fnName: addFn, argc: 2 });
  ctx.ir.push({ kind: "StoreLocal", index: idxLocal });
  ctx.ir.push({ kind: "Jump", labelId: loopStart });

  ctx.ir.push({ kind: "Label", labelId: loopEnd });
  ctx.ir.push({ kind: "LoadLocal", index: resultLocal });
}

function lowerListLastIndexOf(
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
  ctx: LowerContext
): void {
  if (expr.arguments.length !== 1) {
    ctx.diagnostics.push(
      makeDiag(LoweringDiagCode.LastIndexOfRequiresOneArg, ".lastIndexOf() requires exactly 1 argument", expr)
    );
    return;
  }

  const loopStart = allocLabel(ctx);
  const loopEnd = allocLabel(ctx);
  const foundLabel = allocLabel(ctx);
  const doneLabel = allocLabel(ctx);

  const listLocal = ctx.scopeStack.allocLocal();
  const searchLocal = ctx.scopeStack.allocLocal();
  const idxLocal = ctx.scopeStack.allocLocal();

  lowerExpression(propAccess.expression, ctx);
  ctx.ir.push({ kind: "StoreLocal", index: listLocal });
  lowerExpression(expr.arguments[0], ctx);
  ctx.ir.push({ kind: "StoreLocal", index: searchLocal });

  ctx.ir.push({ kind: "LoadLocal", index: listLocal });
  ctx.ir.push({ kind: "ListLen" });
  ctx.ir.push({ kind: "PushConst", value: mkNumberValue(1) });
  const subFn = resolveOperator(CoreOpId.Subtract, [CoreTypeIds.Number, CoreTypeIds.Number], ctx.services);
  if (!subFn) {
    ctx.diagnostics.push(
      makeDiag(
        LoweringDiagCode.CannotResolveOperatorForArrayMethod,
        "Cannot resolve - operator for .lastIndexOf()",
        expr
      )
    );
    return;
  }
  ctx.ir.push({ kind: "HostCall", fnName: subFn, argc: 2 });
  ctx.ir.push({ kind: "StoreLocal", index: idxLocal });

  const geFn = resolveOperator(CoreOpId.GreaterThanOrEqualTo, [CoreTypeIds.Number, CoreTypeIds.Number], ctx.services);
  if (!geFn) {
    ctx.diagnostics.push(
      makeDiag(
        LoweringDiagCode.CannotResolveOperatorForArrayMethod,
        "Cannot resolve >= operator for .lastIndexOf()",
        expr
      )
    );
    return;
  }

  ctx.ir.push({ kind: "Label", labelId: loopStart });

  ctx.ir.push({ kind: "LoadLocal", index: idxLocal });
  ctx.ir.push({ kind: "PushConst", value: mkNumberValue(0) });
  ctx.ir.push({ kind: "HostCall", fnName: geFn, argc: 2 });
  ctx.ir.push({ kind: "JumpIfFalse", labelId: loopEnd });

  ctx.ir.push({ kind: "LoadLocal", index: listLocal });
  ctx.ir.push({ kind: "LoadLocal", index: idxLocal });
  ctx.ir.push({ kind: "ListGet" });
  ctx.ir.push({ kind: "LoadLocal", index: searchLocal });

  const searchType = ctx.checker.getTypeAtLocation(expr.arguments[0]);
  const searchTypeId = tsTypeToTypeId(searchType, ctx.checker, ctx.services, ctx.projectNamespace);
  const eqFn = searchTypeId ? resolveOperator(CoreOpId.EqualTo, [searchTypeId, searchTypeId], ctx.services) : undefined;
  if (!eqFn) {
    ctx.diagnostics.push(
      makeDiag(
        LoweringDiagCode.CannotResolveOperatorForArrayMethod,
        "Cannot resolve === operator for .lastIndexOf()",
        expr
      )
    );
    return;
  }
  ctx.ir.push({ kind: "HostCall", fnName: eqFn, argc: 2 });
  ctx.ir.push({ kind: "JumpIfTrue", labelId: foundLabel });

  ctx.ir.push({ kind: "LoadLocal", index: idxLocal });
  ctx.ir.push({ kind: "PushConst", value: mkNumberValue(1) });
  ctx.ir.push({ kind: "HostCall", fnName: subFn, argc: 2 });
  ctx.ir.push({ kind: "StoreLocal", index: idxLocal });
  ctx.ir.push({ kind: "Jump", labelId: loopStart });

  ctx.ir.push({ kind: "Label", labelId: foundLabel });
  ctx.ir.push({ kind: "LoadLocal", index: idxLocal });
  ctx.ir.push({ kind: "Jump", labelId: doneLabel });

  ctx.ir.push({ kind: "Label", labelId: loopEnd });
  ctx.ir.push({ kind: "PushConst", value: mkNumberValue(-1) });

  ctx.ir.push({ kind: "Label", labelId: doneLabel });
}

function lowerListFindIndex(expr: ts.CallExpression, propAccess: ts.PropertyAccessExpression, ctx: LowerContext): void {
  if (expr.arguments.length !== 1) {
    ctx.diagnostics.push(
      makeDiag(LoweringDiagCode.FindIndexRequiresOneArg, ".findIndex() requires exactly 1 argument", expr)
    );
    return;
  }

  const loopStart = allocLabel(ctx);
  const loopEnd = allocLabel(ctx);
  const foundLabel = allocLabel(ctx);
  const doneLabel = allocLabel(ctx);

  const srcListLocal = ctx.scopeStack.allocLocal();
  const idxLocal = ctx.scopeStack.allocLocal();
  const lenLocal = ctx.scopeStack.allocLocal();
  const callbackLocal = ctx.scopeStack.allocLocal();

  lowerExpression(propAccess.expression, ctx);
  ctx.ir.push({ kind: "StoreLocal", index: srcListLocal });

  lowerExpression(expr.arguments[0], ctx);
  ctx.ir.push({ kind: "StoreLocal", index: callbackLocal });

  ctx.ir.push({ kind: "PushConst", value: mkNumberValue(0) });
  ctx.ir.push({ kind: "StoreLocal", index: idxLocal });

  ctx.ir.push({ kind: "LoadLocal", index: srcListLocal });
  ctx.ir.push({ kind: "ListLen" });
  ctx.ir.push({ kind: "StoreLocal", index: lenLocal });

  ctx.ir.push({ kind: "Label", labelId: loopStart });

  ctx.ir.push({ kind: "LoadLocal", index: idxLocal });
  ctx.ir.push({ kind: "LoadLocal", index: lenLocal });
  const ltFn = resolveOperator(CoreOpId.LessThan, [CoreTypeIds.Number, CoreTypeIds.Number], ctx.services);
  if (!ltFn) {
    ctx.diagnostics.push(
      makeDiag(LoweringDiagCode.CannotResolveOperatorForArrayMethod, "Cannot resolve < operator for .findIndex()", expr)
    );
    return;
  }
  ctx.ir.push({ kind: "HostCall", fnName: ltFn, argc: 2 });
  ctx.ir.push({ kind: "JumpIfFalse", labelId: loopEnd });

  ctx.ir.push({ kind: "LoadLocal", index: callbackLocal });
  ctx.ir.push({ kind: "LoadLocal", index: srcListLocal });
  ctx.ir.push({ kind: "LoadLocal", index: idxLocal });
  ctx.ir.push({ kind: "ListGet" });
  ctx.ir.push({ kind: "LoadLocal", index: idxLocal });
  ctx.ir.push({ kind: "CallIndirectArgs", argc: 2 });
  ctx.ir.push({ kind: "JumpIfTrue", labelId: foundLabel });

  ctx.ir.push({ kind: "LoadLocal", index: idxLocal });
  ctx.ir.push({ kind: "PushConst", value: mkNumberValue(1) });
  const addFn = resolveOperator(CoreOpId.Add, [CoreTypeIds.Number, CoreTypeIds.Number], ctx.services);
  if (!addFn) {
    ctx.diagnostics.push(
      makeDiag(LoweringDiagCode.CannotResolveOperatorForArrayMethod, "Cannot resolve + operator for .findIndex()", expr)
    );
    return;
  }
  ctx.ir.push({ kind: "HostCall", fnName: addFn, argc: 2 });
  ctx.ir.push({ kind: "StoreLocal", index: idxLocal });
  ctx.ir.push({ kind: "Jump", labelId: loopStart });

  ctx.ir.push({ kind: "Label", labelId: foundLabel });
  ctx.ir.push({ kind: "LoadLocal", index: idxLocal });
  ctx.ir.push({ kind: "Jump", labelId: doneLabel });

  ctx.ir.push({ kind: "Label", labelId: loopEnd });
  ctx.ir.push({ kind: "PushConst", value: mkNumberValue(-1) });

  ctx.ir.push({ kind: "Label", labelId: doneLabel });
}

function lowerListReduce(expr: ts.CallExpression, propAccess: ts.PropertyAccessExpression, ctx: LowerContext): void {
  if (expr.arguments.length < 1 || expr.arguments.length > 2) {
    ctx.diagnostics.push(
      makeDiag(LoweringDiagCode.ReduceRequiresOneOrTwoArgs, ".reduce() requires 1 or 2 arguments", expr)
    );
    return;
  }

  const hasInitialValue = expr.arguments.length === 2;

  const loopStart = allocLabel(ctx);
  const loopEnd = allocLabel(ctx);

  const srcListLocal = ctx.scopeStack.allocLocal();
  const idxLocal = ctx.scopeStack.allocLocal();
  const lenLocal = ctx.scopeStack.allocLocal();
  const callbackLocal = ctx.scopeStack.allocLocal();
  const accLocal = ctx.scopeStack.allocLocal();

  lowerExpression(propAccess.expression, ctx);
  ctx.ir.push({ kind: "StoreLocal", index: srcListLocal });

  lowerExpression(expr.arguments[0], ctx);
  ctx.ir.push({ kind: "StoreLocal", index: callbackLocal });

  ctx.ir.push({ kind: "LoadLocal", index: srcListLocal });
  ctx.ir.push({ kind: "ListLen" });
  ctx.ir.push({ kind: "StoreLocal", index: lenLocal });

  if (hasInitialValue) {
    lowerExpression(expr.arguments[1], ctx);
    ctx.ir.push({ kind: "StoreLocal", index: accLocal });
    ctx.ir.push({ kind: "PushConst", value: mkNumberValue(0) });
    ctx.ir.push({ kind: "StoreLocal", index: idxLocal });
  } else {
    ctx.ir.push({ kind: "LoadLocal", index: srcListLocal });
    ctx.ir.push({ kind: "PushConst", value: mkNumberValue(0) });
    ctx.ir.push({ kind: "ListGet" });
    ctx.ir.push({ kind: "StoreLocal", index: accLocal });
    ctx.ir.push({ kind: "PushConst", value: mkNumberValue(1) });
    ctx.ir.push({ kind: "StoreLocal", index: idxLocal });
  }

  const ltFn = resolveOperator(CoreOpId.LessThan, [CoreTypeIds.Number, CoreTypeIds.Number], ctx.services);
  if (!ltFn) {
    ctx.diagnostics.push(
      makeDiag(LoweringDiagCode.CannotResolveOperatorForArrayMethod, "Cannot resolve < operator for .reduce()", expr)
    );
    return;
  }

  const addFn = resolveOperator(CoreOpId.Add, [CoreTypeIds.Number, CoreTypeIds.Number], ctx.services);
  if (!addFn) {
    ctx.diagnostics.push(
      makeDiag(LoweringDiagCode.CannotResolveOperatorForArrayMethod, "Cannot resolve + operator for .reduce()", expr)
    );
    return;
  }

  ctx.ir.push({ kind: "Label", labelId: loopStart });

  ctx.ir.push({ kind: "LoadLocal", index: idxLocal });
  ctx.ir.push({ kind: "LoadLocal", index: lenLocal });
  ctx.ir.push({ kind: "HostCall", fnName: ltFn, argc: 2 });
  ctx.ir.push({ kind: "JumpIfFalse", labelId: loopEnd });

  ctx.ir.push({ kind: "LoadLocal", index: callbackLocal });
  ctx.ir.push({ kind: "LoadLocal", index: accLocal });
  ctx.ir.push({ kind: "LoadLocal", index: srcListLocal });
  ctx.ir.push({ kind: "LoadLocal", index: idxLocal });
  ctx.ir.push({ kind: "ListGet" });
  ctx.ir.push({ kind: "LoadLocal", index: idxLocal });
  ctx.ir.push({ kind: "CallIndirectArgs", argc: 3 });
  ctx.ir.push({ kind: "StoreLocal", index: accLocal });

  ctx.ir.push({ kind: "LoadLocal", index: idxLocal });
  ctx.ir.push({ kind: "PushConst", value: mkNumberValue(1) });
  ctx.ir.push({ kind: "HostCall", fnName: addFn, argc: 2 });
  ctx.ir.push({ kind: "StoreLocal", index: idxLocal });
  ctx.ir.push({ kind: "Jump", labelId: loopStart });

  ctx.ir.push({ kind: "Label", labelId: loopEnd });
  ctx.ir.push({ kind: "LoadLocal", index: accLocal });
}

function lowerListToString(expr: ts.CallExpression, propAccess: ts.PropertyAccessExpression, ctx: LowerContext): void {
  if (expr.arguments.length !== 0) {
    ctx.diagnostics.push(makeDiag(LoweringDiagCode.ArrayToStringTakesNoArgs, ".toString() takes no arguments", expr));
    return;
  }

  lowerListJoinWithSeparator(propAccess.expression, undefined, ctx, expr);
}

function isNullOrUndefinedLiteral(node: ts.Expression): boolean {
  if (node.kind === ts.SyntaxKind.NullKeyword) return true;
  return ts.isIdentifier(node) && node.text === "undefined";
}

function lowerNullableNilComparison(expr: ts.BinaryExpression, opId: string, ctx: LowerContext): boolean {
  const leftIsNil = isNullOrUndefinedLiteral(expr.left);
  const rightIsNil = isNullOrUndefinedLiteral(expr.right);
  if (!leftIsNil && !rightIsNil) return false;
  if (leftIsNil && rightIsNil) return false;

  const valueNode = leftIsNil ? expr.right : expr.left;
  const valueTypeId = resolveExpressionTypeId(valueNode, ctx);
  if (!valueTypeId) return false;

  const valueDef = ctx.services.runtime.types.get(valueTypeId);
  if (!valueDef) return false;

  if (!valueDef.nullable) {
    const baseType = valueDef.coreType;
    if (baseType !== NativeType.Struct && baseType !== NativeType.List && baseType !== NativeType.Map) {
      return false;
    }
  }

  lowerExpression(valueNode, ctx);
  ctx.ir.push({ kind: "TypeCheck", nativeType: NativeType.Nil });
  if (opId === CoreOpId.NotEqualTo) {
    const notFn = resolveOperator(CoreOpId.Not, [CoreTypeIds.Boolean], ctx.services);
    if (notFn) {
      ctx.ir.push({ kind: "HostCall", fnName: notFn, argc: 1 });
    } else {
      ctx.diagnostics.push(
        makeDiag(LoweringDiagCode.UnsupportedOperator, "Missing not() operator for !== nil comparison", expr)
      );
    }
  }
  return true;
}

function lowerBinaryExpression(expr: ts.BinaryExpression, ctx: LowerContext): void {
  if (
    expr.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
    expr.operatorToken.kind === ts.SyntaxKind.BarBarToken
  ) {
    lowerShortCircuit(expr, ctx);
    return;
  }

  if (expr.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
    lowerNullishCoalescing(expr, ctx);
    return;
  }

  if (lowerTypeofComparison(expr, ctx)) {
    return;
  }

  if (expr.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword) {
    lowerInstanceOf(expr, ctx);
    return;
  }

  const opId = tsOperatorToOpId(expr.operatorToken.kind);
  if (!opId) {
    ctx.diagnostics.push(
      makeDiag(
        LoweringDiagCode.UnsupportedOperator,
        `Unsupported operator: ${ts.SyntaxKind[expr.operatorToken.kind]}`,
        expr.operatorToken
      )
    );
    return;
  }

  if (opId === CoreOpId.EqualTo || opId === CoreOpId.NotEqualTo) {
    const nilSide = lowerNullableNilComparison(expr, opId, ctx);
    if (nilSide) return;
  }

  lowerExpression(expr.left, ctx);
  lowerExpression(expr.right, ctx);

  emitBinaryOperatorForNodes(opId, expr.left, expr.right, expr, ctx);
}

const MATH_CONSTANTS = new Map<string, number>([
  // biome-ignore lint/suspicious/noApproximativeNumericConstant: compile-time constant
  ["E", 2.718281828459045],
  // biome-ignore lint/suspicious/noApproximativeNumericConstant: compile-time constant
  ["LN10", 2.302585092994046],
  // biome-ignore lint/suspicious/noApproximativeNumericConstant: compile-time constant
  ["LN2", 0.6931471805599453],
  // biome-ignore lint/suspicious/noApproximativeNumericConstant: compile-time constant
  ["LOG2E", 1.4426950408889634],
  // biome-ignore lint/suspicious/noApproximativeNumericConstant: compile-time constant
  ["LOG10E", 0.4342944819032518],
  // biome-ignore lint/suspicious/noApproximativeNumericConstant: compile-time constant
  ["PI", 3.141592653589793],
  // biome-ignore lint/suspicious/noApproximativeNumericConstant: compile-time constant
  ["SQRT1_2", 0.7071067811865476],
  // biome-ignore lint/suspicious/noApproximativeNumericConstant: compile-time constant
  ["SQRT2", 1.4142135623730951],
]);

const MATH_UNARY_METHODS = new Map<string, string>([
  ["abs", "$$math_abs"],
  ["acos", "$$math_acos"],
  ["asin", "$$math_asin"],
  ["atan", "$$math_atan"],
  ["ceil", "$$math_ceil"],
  ["cos", "$$math_cos"],
  ["exp", "$$math_exp"],
  ["floor", "$$math_floor"],
  ["log", "$$math_log"],
  ["round", "$$math_round"],
  ["sin", "$$math_sin"],
  ["sqrt", "$$math_sqrt"],
  ["tan", "$$math_tan"],
]);

const MATH_BINARY_METHODS = new Map<string, string>([
  ["atan2", "$$math_atan2"],
  ["max", "$$math_max"],
  ["min", "$$math_min"],
  ["pow", "$$math_pow"],
]);

function isMathGlobal(expr: ts.Expression, ctx: LowerContext): boolean {
  if (!ts.isIdentifier(expr) || expr.text !== "Math") return false;
  const sym = ctx.checker.getSymbolAtLocation(expr);
  if (!sym) return false;
  const decls = sym.getDeclarations();
  if (!decls || decls.length === 0) return false;
  for (const d of decls) {
    if (ts.isVariableDeclaration(d) || ts.isInterfaceDeclaration(d)) {
      const sf = d.getSourceFile();
      if (sf.isDeclarationFile || sf.fileName.includes("lib.")) return true;
    }
  }
  return false;
}

function isArrayGlobal(expr: ts.Expression, ctx: LowerContext): boolean {
  if (!ts.isIdentifier(expr) || expr.text !== "Array") return false;
  const sym = ctx.checker.getSymbolAtLocation(expr);
  if (!sym) return false;
  const decls = sym.getDeclarations();
  if (!decls || decls.length === 0) return false;
  for (const d of decls) {
    if (ts.isVariableDeclaration(d) || ts.isInterfaceDeclaration(d)) {
      const sf = d.getSourceFile();
      if (sf.isDeclarationFile || sf.fileName.includes("lib.")) return true;
    }
  }
  return false;
}

function lowerArrayFromCall(
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
  ctx: LowerContext
): boolean {
  if (!isArrayGlobal(propAccess.expression, ctx)) return false;
  if (propAccess.name.text !== "from") return false;

  if (expr.arguments.length < 1 || expr.arguments.length > 2) {
    ctx.diagnostics.push(
      makeDiag(LoweringDiagCode.ArrayFromRequiresOneOrTwoArgs, "Array.from() requires 1 or 2 arguments", expr)
    );
    return true;
  }

  const sourceType = ctx.checker.getTypeAtLocation(expr.arguments[0]);
  const sourceListTypeId = resolveListTypeId(sourceType, ctx);
  if (!sourceListTypeId) {
    ctx.diagnostics.push(
      makeDiag(
        LoweringDiagCode.ArrayFromNonListSource,
        "Array.from() source must be an array/list type",
        expr.arguments[0]
      )
    );
    return true;
  }

  const returnType = ctx.checker.getTypeAtLocation(expr);
  const resultListTypeId = resolveListTypeId(returnType, ctx);
  if (!resultListTypeId) {
    ctx.diagnostics.push(
      makeDiag(
        LoweringDiagCode.CannotDetermineArrayFromResultListType,
        "Cannot determine result list type for Array.from() (add a type annotation)",
        expr
      )
    );
    return true;
  }

  const hasMapFn = expr.arguments.length === 2;

  const loopStart = allocLabel(ctx);
  const loopEnd = allocLabel(ctx);

  const srcListLocal = ctx.scopeStack.allocLocal();
  const resultListLocal = ctx.scopeStack.allocLocal();
  const idxLocal = ctx.scopeStack.allocLocal();
  const lenLocal = ctx.scopeStack.allocLocal();

  lowerExpression(expr.arguments[0], ctx);
  ctx.ir.push({ kind: "StoreLocal", index: srcListLocal });

  ctx.ir.push({ kind: "ListNew", typeId: resultListTypeId });
  ctx.ir.push({ kind: "StoreLocal", index: resultListLocal });

  let callbackLocal: number | undefined;
  if (hasMapFn) {
    callbackLocal = ctx.scopeStack.allocLocal();
    lowerExpression(expr.arguments[1], ctx);
    ctx.ir.push({ kind: "StoreLocal", index: callbackLocal });
  }

  ctx.ir.push({ kind: "PushConst", value: mkNumberValue(0) });
  ctx.ir.push({ kind: "StoreLocal", index: idxLocal });

  ctx.ir.push({ kind: "LoadLocal", index: srcListLocal });
  ctx.ir.push({ kind: "ListLen" });
  ctx.ir.push({ kind: "StoreLocal", index: lenLocal });

  ctx.ir.push({ kind: "Label", labelId: loopStart });

  ctx.ir.push({ kind: "LoadLocal", index: idxLocal });
  ctx.ir.push({ kind: "LoadLocal", index: lenLocal });
  const ltFn = resolveOperator(CoreOpId.LessThan, [CoreTypeIds.Number, CoreTypeIds.Number], ctx.services);
  if (!ltFn) {
    ctx.diagnostics.push(
      makeDiag(LoweringDiagCode.CannotResolveOperatorForArrayMethod, "Cannot resolve < operator for Array.from()", expr)
    );
    return true;
  }
  ctx.ir.push({ kind: "HostCall", fnName: ltFn, argc: 2 });
  ctx.ir.push({ kind: "JumpIfFalse", labelId: loopEnd });

  if (hasMapFn) {
    ctx.ir.push({ kind: "LoadLocal", index: callbackLocal! });
    ctx.ir.push({ kind: "LoadLocal", index: srcListLocal });
    ctx.ir.push({ kind: "LoadLocal", index: idxLocal });
    ctx.ir.push({ kind: "ListGet" });
    ctx.ir.push({ kind: "LoadLocal", index: idxLocal });
    ctx.ir.push({ kind: "CallIndirectArgs", argc: 2 });
  } else {
    ctx.ir.push({ kind: "LoadLocal", index: srcListLocal });
    ctx.ir.push({ kind: "LoadLocal", index: idxLocal });
    ctx.ir.push({ kind: "ListGet" });
  }

  ctx.ir.push({ kind: "LoadLocal", index: resultListLocal });
  ctx.ir.push({ kind: "Swap" });
  ctx.ir.push({ kind: "ListPush" });
  ctx.ir.push({ kind: "StoreLocal", index: resultListLocal });

  ctx.ir.push({ kind: "LoadLocal", index: idxLocal });
  ctx.ir.push({ kind: "PushConst", value: mkNumberValue(1) });
  const addFn = resolveOperator(CoreOpId.Add, [CoreTypeIds.Number, CoreTypeIds.Number], ctx.services);
  if (!addFn) {
    ctx.diagnostics.push(
      makeDiag(LoweringDiagCode.CannotResolveOperatorForArrayMethod, "Cannot resolve + operator for Array.from()", expr)
    );
    return true;
  }
  ctx.ir.push({ kind: "HostCall", fnName: addFn, argc: 2 });
  ctx.ir.push({ kind: "StoreLocal", index: idxLocal });
  ctx.ir.push({ kind: "Jump", labelId: loopStart });

  ctx.ir.push({ kind: "Label", labelId: loopEnd });
  ctx.ir.push({ kind: "LoadLocal", index: resultListLocal });
  return true;
}

function lowerArrayIsArrayCall(
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
  ctx: LowerContext
): boolean {
  if (!isArrayGlobal(propAccess.expression, ctx)) return false;
  if (propAccess.name.text !== "isArray") return false;

  lowerExpression(expr.arguments[0], ctx);
  ctx.ir.push({ kind: "TypeCheck", nativeType: NativeType.List });
  return true;
}

function lowerBufferIsBufferCall(
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
  ctx: LowerContext
): boolean {
  if (!isBufferGlobal(propAccess.expression, ctx)) return false;
  if (propAccess.name.text !== "isBuffer") return false;

  lowerExpression(expr.arguments[0], ctx);
  ctx.ir.push({ kind: "TypeCheck", nativeType: NativeType.Buffer });
  return true;
}

function lowerMathCall(expr: ts.CallExpression, propAccess: ts.PropertyAccessExpression, ctx: LowerContext): boolean {
  if (!isMathGlobal(propAccess.expression, ctx)) return false;

  const methodName = propAccess.name.text;

  if (methodName === "random") {
    if (expr.arguments.length !== 0) {
      ctx.diagnostics.push(
        makeDiag(LoweringDiagCode.MathMethodWrongArgCount, "Math.random() takes no arguments", expr)
      );
      return true;
    }
    ctx.ir.push({ kind: "HostCall", fnName: "$$math_random", argc: 0 });
    return true;
  }

  const unaryFn = MATH_UNARY_METHODS.get(methodName);
  if (unaryFn) {
    if (expr.arguments.length !== 1) {
      ctx.diagnostics.push(
        makeDiag(LoweringDiagCode.MathMethodWrongArgCount, `Math.${methodName}() requires exactly 1 argument`, expr)
      );
      return true;
    }
    lowerExpression(expr.arguments[0], ctx);
    ctx.ir.push({ kind: "HostCall", fnName: unaryFn, argc: 1 });
    return true;
  }

  const binaryFn = MATH_BINARY_METHODS.get(methodName);
  if (binaryFn) {
    if (expr.arguments.length !== 2) {
      ctx.diagnostics.push(
        makeDiag(LoweringDiagCode.MathMinMaxRequiresTwoArgs, `Math.${methodName}() requires exactly 2 arguments`, expr)
      );
      return true;
    }
    lowerExpression(expr.arguments[0], ctx);
    lowerExpression(expr.arguments[1], ctx);
    ctx.ir.push({ kind: "HostCall", fnName: binaryFn, argc: 2 });
    return true;
  }

  ctx.diagnostics.push(makeDiag(LoweringDiagCode.UnsupportedMathMethod, `Math.${methodName}() is not supported`, expr));
  return true;
}

function isBufferGlobal(expr: ts.Expression, ctx: LowerContext): boolean {
  if (!ts.isIdentifier(expr) || expr.text !== "Buffer") return false;
  const sym = ctx.checker.getSymbolAtLocation(expr);
  if (!sym) return false;
  const decls = sym.getDeclarations();
  if (!decls || decls.length === 0) return false;
  for (const d of decls) {
    if (ts.isVariableDeclaration(d) || ts.isInterfaceDeclaration(d)) {
      const sf = d.getSourceFile();
      if (sf.isDeclarationFile || sf.fileName.includes("lib.")) return true;
    }
  }
  return false;
}

function isBufferType(type: ts.Type): boolean {
  const sym = type.getSymbol();
  if (!sym || sym.name !== "Buffer") return false;
  const decls = sym.getDeclarations();
  if (!decls || decls.length === 0) return false;
  for (const d of decls) {
    if (ts.isInterfaceDeclaration(d) && d.getSourceFile().isDeclarationFile) return true;
  }
  return false;
}

function lowerBufferConstructorCall(
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
  ctx: LowerContext
): boolean {
  if (!isBufferGlobal(propAccess.expression, ctx)) return false;

  const methodName = propAccess.name.text;
  const constructors = new Map<string, string>([
    ["from", "$$buf_from"],
    ["fromHex", "$$buf_fromHex"],
    ["fromString", "$$buf_fromString"],
  ]);
  const fnName = constructors.get(methodName);
  if (!fnName) {
    ctx.diagnostics.push(
      makeDiag(LoweringDiagCode.UnsupportedBufferMethod, `Buffer.${methodName}() is not supported`, expr)
    );
    return true;
  }

  if (expr.arguments.length !== 1) {
    ctx.diagnostics.push(
      makeDiag(LoweringDiagCode.BufferMethodWrongArgCount, `Buffer.${methodName}() requires exactly 1 argument`, expr)
    );
    return true;
  }

  lowerExpression(expr.arguments[0], ctx);
  ctx.ir.push({ kind: "HostCall", fnName, argc: 1 });
  return true;
}

function lowerBufferMethodCall(
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
  ctx: LowerContext
): boolean {
  const objType = ctx.checker.getTypeAtLocation(propAccess.expression);
  if (!isBufferType(objType)) return false;

  const methodName = propAccess.name.text;

  if (methodName === "length") {
    if (expr.arguments.length !== 0) {
      ctx.diagnostics.push(makeDiag(LoweringDiagCode.BufferMethodWrongArgCount, ".length() takes no arguments", expr));
      return true;
    }
    lowerExpression(propAccess.expression, ctx);
    ctx.ir.push({ kind: "HostCall", fnName: "$$buf_length", argc: 1 });
    return true;
  }

  if (methodName === "get") {
    if (expr.arguments.length !== 1) {
      ctx.diagnostics.push(
        makeDiag(LoweringDiagCode.BufferMethodWrongArgCount, ".get() requires exactly 1 argument", expr)
      );
      return true;
    }
    lowerExpression(propAccess.expression, ctx);
    lowerExpression(expr.arguments[0], ctx);
    ctx.ir.push({ kind: "HostCall", fnName: "$$buf_get", argc: 2 });
    return true;
  }

  ctx.diagnostics.push(
    makeDiag(LoweringDiagCode.UnsupportedBufferMethod, `Buffer.${methodName}() is not supported`, expr)
  );
  return true;
}

function lowerPropertyAccess(expr: ts.PropertyAccessExpression, ctx: LowerContext): void {
  if (ts.isIdentifier(expr.expression) && ctx.paramsSymbol) {
    const objSymbol = ctx.checker.getSymbolAtLocation(expr.expression);
    if (objSymbol === ctx.paramsSymbol) {
      const paramName = expr.name.text;
      const localIdx = ctx.argLocals?.get(paramName);
      if (localIdx !== undefined) {
        ctx.ir.push({ kind: "LoadLocal", index: localIdx });
        return;
      }
    }
  }

  // A System method name in a non-call position is read as a value; a method has
  // no value representation. A call routes through `lowerSystemMethodCall`.
  if (
    expr.expression.kind === ts.SyntaxKind.ThisKeyword
      ? ctx.thisSystemMethodFuncIds?.has(expr.name.text)
      : ts.isIdentifier(expr.expression) &&
        resolveSystemBinding(expr.expression, ctx)?.methodFuncIds.has(expr.name.text)
  ) {
    ctx.diagnostics.push(
      makeDiag(
        LoweringDiagCode.SystemMethodUsedAsValue,
        `System method '${expr.name.text}' must be called, not read as a value.`,
        expr
      )
    );
    return;
  }

  if (isMathGlobal(expr.expression, ctx)) {
    const constVal = MATH_CONSTANTS.get(expr.name.text);
    if (constVal !== undefined) {
      ctx.ir.push({ kind: "PushConst", value: mkNumberValue(constVal) });
      return;
    }
    ctx.diagnostics.push(
      makeDiag(LoweringDiagCode.UnsupportedPropertyAccess, `Math.${expr.name.text} is not a known constant`, expr)
    );
    return;
  }

  const enumAccess = resolveEnumPropertyAccess(expr, ctx);
  if (enumAccess) {
    if (enumAccess.kind === "member") {
      ctx.ir.push({ kind: "PushConst", value: enumAccess.value });
      return;
    }

    ctx.diagnostics.push(
      makeDiag(
        LoweringDiagCode.EnumObjectUsageNotSupported,
        "Enum objects are not supported at runtime; only direct member access like Direction.Up is supported",
        expr
      )
    );
    return;
  }

  const staticAccess = resolveStaticMemberAccess(expr, ctx);
  if (staticAccess) {
    if (staticAccess.kind === "field") {
      ctx.ir.push({ kind: "LoadCallsiteVar", index: staticAccess.callsiteVarIndex });
      return;
    }
    if (staticAccess.kind === "method") {
      ctx.ir.push({ kind: "PushFunctionRef", funcName: staticAccess.funcName });
      return;
    }
    if (staticAccess.kind === "getter") {
      const funcId = ctx.functionTable.get(staticAccess.funcName);
      if (funcId !== undefined) {
        ctx.ir.push({ kind: "Call", funcIndex: funcId, argc: 0 });
        return;
      }
    }
    ctx.diagnostics.push(
      makeDiag(
        LoweringDiagCode.NoSuchStaticMember,
        `No static member '${expr.name.text}' exists on class '${(expr.expression as ts.Identifier).text}'`,
        expr
      )
    );
    return;
  }

  const thisStatic = resolveThisStaticAccess(expr, ctx);
  if (thisStatic) {
    if (thisStatic.kind === "field") {
      ctx.ir.push({ kind: "LoadCallsiteVar", index: thisStatic.callsiteVarIndex });
      return;
    }
    if (thisStatic.kind === "method") {
      ctx.ir.push({ kind: "PushFunctionRef", funcName: thisStatic.funcName });
      return;
    }
    if (thisStatic.kind === "getter") {
      const funcId = ctx.functionTable.get(thisStatic.funcName);
      if (funcId !== undefined) {
        ctx.ir.push({ kind: "Call", funcIndex: funcId, argc: 0 });
        return;
      }
    }
    ctx.diagnostics.push(
      makeDiag(
        LoweringDiagCode.NoSuchStaticMember,
        `No static member '${expr.name.text}' exists on class '${ctx.staticClassInfo!.name}'`,
        expr
      )
    );
    return;
  }

  const isOptChain = ts.isOptionalChain(expr);
  const rawObjType = ctx.checker.getTypeAtLocation(expr.expression);
  const objType = isOptChain ? ctx.checker.getNonNullableType(rawObjType) : rawObjType;

  if (expr.name.text === "length") {
    if (isStringType(objType)) {
      lowerExpression(expr.expression, ctx);
      const guard = isOptChain ? emitNilGuard(ctx) : undefined;
      ctx.ir.push({ kind: "HostCall", fnName: "$$str_length", argc: 1 });
      if (guard) ctx.ir.push({ kind: "Label", labelId: guard.endLabel });
      return;
    }
    const listTypeId = resolveListTypeId(objType, ctx);
    if (listTypeId) {
      lowerExpression(expr.expression, ctx);
      const guard = isOptChain ? emitNilGuard(ctx) : undefined;
      ctx.ir.push({ kind: "ListLen" });
      if (guard) ctx.ir.push({ kind: "Label", labelId: guard.endLabel });
      return;
    }
  }

  if (expr.name.text === "size") {
    const mapTypeId = resolveMapTypeId(objType, ctx);
    if (mapTypeId) {
      lowerExpression(expr.expression, ctx);
      const guard = isOptChain ? emitNilGuard(ctx) : undefined;
      ctx.ir.push({ kind: "HostCall", fnName: "$$map_size", argc: 1 });
      if (guard) ctx.ir.push({ kind: "Label", labelId: guard.endLabel });
      return;
    }
  }

  const structDef =
    expr.expression.kind === ts.SyntaxKind.ThisKeyword && ctx.thisStructTypeId !== undefined
      ? resolveThisReceiverStructDef(expr.expression, ctx)
      : resolveStructType(objType, ctx.services, ctx.projectNamespace, ctx.checker);
  if (structDef) {
    const fieldName = expr.name.text;
    const className = bareClassName(structDef.name);
    const ci = ctx.classInfos.find((c) => c.name === className);
    if (ci?.getterFuncIds.has(fieldName)) {
      const funcName = `${className}$get_${fieldName}`;
      const funcId = ctx.functionTable.get(funcName);
      if (funcId !== undefined) {
        lowerExpression(expr.expression, ctx);
        const guard = isOptChain ? emitNilGuard(ctx) : undefined;
        ctx.ir.push({ kind: "Call", funcIndex: funcId, argc: 1 });
        if (guard) ctx.ir.push({ kind: "Label", labelId: guard.endLabel });
        return;
      }
    }
    const field = findStructField(structDef, fieldName);
    if (!field) {
      ctx.diagnostics.push(
        makeDiag(
          LoweringDiagCode.PropertyNotOnStruct,
          `Property '${fieldName}' does not exist on struct '${structDef.name}'`,
          expr
        )
      );
      return;
    }
    lowerExpression(expr.expression, ctx);
    const guard = isOptChain ? emitNilGuard(ctx) : undefined;
    ctx.ir.push(
      isIndexedStruct(structDef)
        ? { kind: "GetField", fieldName, fieldIndex: field.fieldIndex }
        : { kind: "GetField", fieldName }
    );
    if (guard) ctx.ir.push({ kind: "Label", labelId: guard.endLabel });
    return;
  }

  const fieldName = expr.name.text;
  const tsProps = objType.getProperties();
  if (tsProps.length > 0 && tsProps.some((p) => p.getName() === fieldName)) {
    lowerExpression(expr.expression, ctx);
    const guard = isOptChain ? emitNilGuard(ctx) : undefined;
    ctx.ir.push({ kind: "GetField", fieldName });
    if (guard) ctx.ir.push({ kind: "Label", labelId: guard.endLabel });
    return;
  }

  ctx.diagnostics.push(makeDiag(LoweringDiagCode.UnsupportedPropertyAccess, "Unsupported property access", expr));
}

function resolveRegistryName(
  sym: ts.Symbol,
  services: BrainServices,
  projectNamespace: string,
  checker?: ts.TypeChecker
): string {
  const resolvedSym = resolveAliasedSymbol(sym, checker) ?? sym;
  const name = resolvedSym.getName();
  const decls = resolvedSym.getDeclarations();
  if (decls && decls.length > 0 && isUserSourceDecl(decls[0])) {
    const qualName = qualifiedDeclarationName(projectNamespace, decls[0].getSourceFile().fileName, name);
    if (services.runtime.types.resolveByName(qualName)) {
      return qualName;
    }
  }
  return name;
}

function resolveStructType(
  type: ts.Type,
  services: BrainServices,
  projectNamespace: string,
  checker?: ts.TypeChecker
): StructTypeDef | undefined {
  const registry = services.runtime.types;
  if (type.isUnion()) {
    const nonNullish = type.types.filter((t) => !(t.flags & ts.TypeFlags.Null) && !(t.flags & ts.TypeFlags.Undefined));
    if (nonNullish.length === 1) {
      return resolveStructType(nonNullish[0], services, projectNamespace, checker);
    }
    return undefined;
  }
  if (type.isIntersection() && checker) {
    const typeId = tsTypeToTypeId(type, checker, services, projectNamespace);
    if (!typeId) return undefined;
    const def = registry.get(typeId);
    if (!def || def.coreType !== NativeType.Struct) return undefined;
    return def as StructTypeDef;
  }
  const sym = type.aliasSymbol ?? type.getSymbol();
  if (!sym) return undefined;
  const resolvedName = resolveRegistryName(sym, services, projectNamespace);
  let typeId = registry.resolveByName(resolvedName);
  if (!typeId && checker) {
    typeId = tsTypeToTypeId(type, checker, services, projectNamespace) ?? undefined;
  }
  if (!typeId) return undefined;
  const def = registry.get(typeId);
  if (!def || def.coreType !== NativeType.Struct) return undefined;
  return def as StructTypeDef;
}

/**
 * Resolve the struct def of a `this.field` receiver. When `this` is a System
 * state struct, uses the state struct id carried on the context
 * (`ctx.thisStructTypeId`); otherwise resolves from the receiver's TS type.
 */
function resolveThisReceiverStructDef(receiver: ts.Expression, ctx: LowerContext): StructTypeDef | undefined {
  if (receiver.kind === ts.SyntaxKind.ThisKeyword && ctx.thisStructTypeId !== undefined) {
    const def = ctx.services.runtime.types.get(ctx.thisStructTypeId);
    if (def && def.coreType === NativeType.Struct) return def as StructTypeDef;
  }
  return resolveStructType(ctx.checker.getTypeAtLocation(receiver), ctx.services, ctx.projectNamespace, ctx.checker);
}

function resolveEnumDeclaration(sym: ts.Symbol, checker?: ts.TypeChecker): ts.EnumDeclaration | undefined {
  const resolvedSym = resolveAliasedSymbol(sym, checker);
  const declarations = resolvedSym?.getDeclarations();
  if (!declarations) {
    return undefined;
  }
  return declarations.find(ts.isEnumDeclaration);
}

function resolveClassDeclaration(sym: ts.Symbol, checker?: ts.TypeChecker): ts.ClassDeclaration | undefined {
  const resolvedSym = resolveAliasedSymbol(sym, checker);
  const declarations = resolvedSym?.getDeclarations();
  if (!declarations) {
    return undefined;
  }
  return declarations.find(ts.isClassDeclaration);
}

function getEnumMemberKey(member: ts.EnumMember): string | undefined {
  if (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name) || ts.isNumericLiteral(member.name)) {
    return member.name.text;
  }
  return undefined;
}

function registerUserEnumTypes(
  localEnumNodes: ts.EnumDeclaration[],
  importedEnums: ImportedEnum[],
  checker: ts.TypeChecker,
  diagnostics: CompileDiagnostic[],
  services: BrainServices,
  projectNamespace: string
): void {
  const seenNames = new Set<string>();

  for (const enumNode of localEnumNodes) {
    const qualifiedName = qualifiedDeclarationName(
      projectNamespace,
      enumNode.getSourceFile().fileName,
      enumNode.name.text
    );
    if (seenNames.has(qualifiedName)) {
      continue;
    }
    seenNames.add(qualifiedName);
    registerUserEnumType(enumNode, checker, diagnostics, services, projectNamespace);
  }

  for (const importedEnum of importedEnums) {
    const qualifiedName = qualifiedDeclarationName(
      projectNamespace,
      importedEnum.sourceFile.fileName,
      importedEnum.name
    );
    if (seenNames.has(qualifiedName)) {
      continue;
    }
    seenNames.add(qualifiedName);
    registerUserEnumType(importedEnum.node, checker, diagnostics, services, projectNamespace);
  }
}

function registerUserEnumType(
  enumNode: ts.EnumDeclaration,
  checker: ts.TypeChecker,
  diagnostics: CompileDiagnostic[],
  services: BrainServices,
  projectNamespace: string
): void {
  const registry = services.runtime.types;
  const qualifiedName = qualifiedDeclarationName(
    projectNamespace,
    enumNode.getSourceFile().fileName,
    enumNode.name.text
  );
  if (registry.resolveByName(qualifiedName)) {
    return;
  }

  const symbols = new List<{ key: string; label: string; value: string | number }>();
  let valueKind: "string" | "number" | undefined;

  for (const member of enumNode.members) {
    const key = getEnumMemberKey(member);
    if (!key) {
      diagnostics.push(
        makeCompileDiag(
          CompileDiagCode.InvalidEnumDeclaration,
          `Enum member '${enumNode.name.text}' must use an identifier or literal name`,
          member
        )
      );
      return;
    }

    const constantValue = checker.getConstantValue(member);
    if (constantValue === undefined || (typeof constantValue !== "string" && typeof constantValue !== "number")) {
      diagnostics.push(
        makeCompileDiag(
          CompileDiagCode.InvalidEnumDeclaration,
          `Enum member '${enumNode.name.text}.${key}' must have a compile-time string or number value`,
          member
        )
      );
      return;
    }

    const currentKind: "string" | "number" = typeof constantValue === "string" ? "string" : "number";
    if (valueKind && valueKind !== currentKind) {
      diagnostics.push(
        makeCompileDiag(
          CompileDiagCode.InvalidEnumDeclaration,
          `Heterogeneous enum '${enumNode.name.text}' is not supported`,
          enumNode
        )
      );
      return;
    }

    valueKind = currentKind;
    symbols.push({ key, label: key, value: constantValue });
  }

  try {
    if (symbols.isEmpty()) {
      registry.withOwner("dynamic", () => {
        registry.addEnumType(qualifiedName, { symbols });
      });
      return;
    }

    registry.withOwner("dynamic", () => {
      registry.addEnumType(qualifiedName, {
        symbols,
        defaultKey: symbols.get(0).key,
      });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : `Invalid enum declaration '${enumNode.name.text}'`;
    diagnostics.push(makeCompileDiag(CompileDiagCode.InvalidEnumDeclaration, message, enumNode));
  }
}

type EnumPropertyAccessResolution = { kind: "member"; value: Value } | { kind: "unsupported" };

function resolveEnumPropertyAccess(
  expr: ts.PropertyAccessExpression,
  ctx: LowerContext
): EnumPropertyAccessResolution | undefined {
  const enumSymbol = resolveAliasedSymbol(ctx.checker.getSymbolAtLocation(expr.expression), ctx.checker);
  if (!enumSymbol) {
    return undefined;
  }

  const enumDecl = resolveEnumDeclaration(enumSymbol, ctx.checker);
  if (!enumDecl) {
    return undefined;
  }

  const typeId = resolveRegisteredEnumTypeIdFromSymbol(enumSymbol, ctx.services, ctx.projectNamespace, ctx.checker);
  if (!typeId) {
    return undefined;
  }

  const memberSymbol = resolveAliasedSymbol(ctx.checker.getSymbolAtLocation(expr.name), ctx.checker);
  const memberDecl = memberSymbol?.getDeclarations()?.find(ts.isEnumMember);
  if (!memberDecl || memberDecl.parent !== enumDecl) {
    return { kind: "unsupported" };
  }

  const key = getEnumMemberKey(memberDecl);
  const symbol = key ? ctx.services.runtime.types.getEnumSymbol(typeId, key) : undefined;
  if (!key || !symbol) {
    return { kind: "unsupported" };
  }

  // Runtime enum equality is symbol identity, so an alias member (a later key
  // sharing an earlier key's value) lowers to the first key with that value,
  // preserving TypeScript's value-equality for aliases.
  const canonicalKey = canonicalEnumKeyForValue(typeId, symbol.value, ctx.services) ?? key;

  return {
    kind: "member",
    value: { t: NativeType.Enum, typeId, v: canonicalKey },
  };
}

function canonicalEnumKeyForValue(typeId: string, value: string | number, services: BrainServices): string | undefined {
  const def = services.runtime.types.get(typeId);
  if (!def || def.coreType !== NativeType.Enum) {
    return undefined;
  }
  const first = (def as EnumTypeDef).symbols.find((symbol) => symbol.value === value);
  return first?.key;
}

type StaticMemberAccessResolution =
  | { kind: "field"; callsiteVarIndex: number }
  | { kind: "method"; funcName: string }
  | { kind: "getter"; funcName: string }
  | { kind: "setter"; funcName: string }
  | { kind: "no-such-member" }
  | undefined;

function resolveStaticMemberAccess(expr: ts.PropertyAccessExpression, ctx: LowerContext): StaticMemberAccessResolution {
  if (!ts.isIdentifier(expr.expression)) return undefined;

  const lhsSymbol = resolveAliasedSymbol(ctx.checker.getSymbolAtLocation(expr.expression), ctx.checker);
  if (!lhsSymbol) return undefined;

  const classDecl = resolveClassDeclaration(lhsSymbol, ctx.checker);
  if (!classDecl) return undefined;

  const className = classDecl.name?.text;
  if (!className) return undefined;

  const ci = ctx.classInfos.find((c) => c.name === className && c.node === classDecl);
  if (!ci) return undefined;

  const memberName = expr.name.text;

  const fieldSlot = ci.staticFieldSlots.get(memberName);
  if (fieldSlot !== undefined) {
    return { kind: "field", callsiteVarIndex: fieldSlot };
  }

  const methodFuncId = ci.staticMethodFuncIds.get(memberName);
  if (methodFuncId !== undefined) {
    return { kind: "method", funcName: `${className}$${memberName}` };
  }

  if (ci.staticGetterFuncIds.has(memberName)) {
    return { kind: "getter", funcName: `${className}$get_${memberName}` };
  }

  if (ci.staticSetterFuncIds.has(memberName)) {
    return { kind: "setter", funcName: `${className}$set_${memberName}` };
  }

  return { kind: "no-such-member" };
}

function resolveThisStaticAccess(expr: ts.PropertyAccessExpression, ctx: LowerContext): StaticMemberAccessResolution {
  if (expr.expression.kind !== ts.SyntaxKind.ThisKeyword) return undefined;
  const ci = ctx.staticClassInfo;
  if (!ci) return undefined;

  const memberName = expr.name.text;

  const fieldSlot = ci.staticFieldSlots.get(memberName);
  if (fieldSlot !== undefined) {
    return { kind: "field", callsiteVarIndex: fieldSlot };
  }

  const methodFuncId = ci.staticMethodFuncIds.get(memberName);
  if (methodFuncId !== undefined) {
    return { kind: "method", funcName: `${ci.name}$${memberName}` };
  }

  if (ci.staticGetterFuncIds.has(memberName)) {
    return { kind: "getter", funcName: `${ci.name}$get_${memberName}` };
  }

  if (ci.staticSetterFuncIds.has(memberName)) {
    return { kind: "setter", funcName: `${ci.name}$set_${memberName}` };
  }

  return { kind: "no-such-member" };
}

function isNativeBackedStruct(def: StructTypeDef): boolean {
  return def.fieldGetter !== undefined || def.fieldSetter !== undefined || def.snapshotNative !== undefined;
}

function findStructField(def: StructTypeDef, fieldName: string) {
  const fieldIndex = def.fieldIndexByName.get(fieldName);
  return fieldIndex !== undefined ? def.fields.at(fieldIndex) : undefined;
}

function isIndexedStruct(_def: StructTypeDef): boolean {
  // Every struct is accessed by numeric field id: closed structs store fields in
  // `struct.v` indexed by id, and native-backed structs resolve the same id through
  // their registered fieldGetter/fieldSetter (so STRUCT_GET_FIELD/STRUCT_SET_FIELD
  // dispatch correctly for both).
  return true;
}

function lowerObjectLiteral(expr: ts.ObjectLiteralExpression, ctx: LowerContext): void {
  const contextualType = ctx.checker.getContextualType(expr);
  const resolvedType = contextualType ?? ctx.checker.getTypeAtLocation(expr);
  if (!resolvedType) {
    ctx.diagnostics.push(
      makeDiag(
        LoweringDiagCode.CannotDetermineTypeForObjectLiteral,
        "Cannot determine type for object literal (add a type annotation)",
        expr
      )
    );
    return;
  }

  const structDef = resolveStructType(resolvedType, ctx.services, ctx.projectNamespace, ctx.checker);
  if (structDef) {
    if (isNativeBackedStruct(structDef)) {
      ctx.diagnostics.push(
        makeDiag(
          LoweringDiagCode.CannotInstantiateNativeBackedStruct,
          `Cannot create instances of native-backed struct type '${structDef.name}'`,
          expr
        )
      );
      return;
    }
    lowerObjectLiteralAsStruct(expr, structDef, ctx);
    return;
  }

  const mapTypeId = resolveMapTypeId(resolvedType, ctx);
  if (mapTypeId) {
    lowerObjectLiteralAsMap(expr, mapTypeId, ctx);
    return;
  }

  if (resolvedType.isUnion()) {
    const nonNullish = resolvedType.types.filter(
      (t) => !(t.flags & ts.TypeFlags.Null) && !(t.flags & ts.TypeFlags.Undefined)
    );
    if (nonNullish.length > 1) {
      let matchedStruct: StructTypeDef | undefined;
      let matchedMapId: string | undefined;
      let matchCount = 0;
      for (const member of nonNullish) {
        const sd = resolveStructType(member, ctx.services, ctx.projectNamespace, ctx.checker);
        if (sd && !isNativeBackedStruct(sd)) {
          matchedStruct = sd;
          matchCount++;
        } else {
          const mid = resolveMapTypeId(member, ctx);
          if (mid) {
            matchedMapId = mid;
            matchCount++;
          }
        }
      }
      if (matchCount === 1 && matchedStruct) {
        lowerObjectLiteralAsStruct(expr, matchedStruct, ctx);
        return;
      }
      if (matchCount === 1 && matchedMapId) {
        lowerObjectLiteralAsMap(expr, matchedMapId, ctx);
        return;
      }
    }
  }

  if (!contextualType) {
    const anonDef = autoRegisterAnonymousStruct(resolvedType, ctx.checker, ctx.services, ctx.projectNamespace);
    if (anonDef) {
      lowerObjectLiteralAsStruct(expr, anonDef, ctx);
      return;
    }
  }

  ctx.diagnostics.push(
    makeDiag(
      LoweringDiagCode.ObjectLiteralTypeUnresolvable,
      "Object literal type does not resolve to a known struct or map type",
      expr
    )
  );
}

function lowerObjectLiteralAsStruct(
  expr: ts.ObjectLiteralExpression,
  structDef: StructTypeDef,
  ctx: LowerContext
): void {
  ctx.ir.push({ kind: "StructNew", typeId: structDef.typeId });

  for (const prop of expr.properties) {
    if (ts.isMethodDeclaration(prop)) {
      let fieldName: string;
      if (ts.isIdentifier(prop.name)) {
        fieldName = prop.name.text;
      } else if (ts.isStringLiteral(prop.name)) {
        fieldName = prop.name.text;
      } else {
        ctx.diagnostics.push(
          makeDiag(
            LoweringDiagCode.UnsupportedPropertyNameInObjectLiteral,
            "Unsupported property name in object literal",
            prop
          )
        );
        return;
      }
      const field = findStructField(structDef, fieldName);
      if (!field) {
        ctx.diagnostics.push(
          makeDiag(
            LoweringDiagCode.PropertyNotOnStruct,
            `Field '${fieldName}' is not a member of struct '${structDef.name}'`,
            prop
          )
        );
        continue;
      }
      lowerClosureExpression(prop, ctx);
      ctx.ir.push({ kind: "StructSet", fieldIndex: field.fieldIndex });
      continue;
    }
    if (ts.isShorthandPropertyAssignment(prop)) {
      const fieldName = prop.name.text;
      const field = findStructField(structDef, fieldName);
      if (!field) {
        ctx.diagnostics.push(
          makeDiag(
            LoweringDiagCode.PropertyNotOnStruct,
            `Field '${fieldName}' is not a member of struct '${structDef.name}'`,
            prop
          )
        );
        continue;
      }
      lowerExpression(prop.name, ctx);
      ctx.ir.push({ kind: "StructSet", fieldIndex: field.fieldIndex });
      continue;
    }
    if (ts.isSpreadAssignment(prop)) {
      const spreadType = ctx.checker.getTypeAtLocation(prop.expression);
      const properties = spreadType.getProperties();
      if (properties.length === 0) {
        ctx.diagnostics.push(
          makeDiag(LoweringDiagCode.SpreadSourceUnresolvable, "Spread source type has no known properties", prop)
        );
        return;
      }
      lowerExpression(prop.expression, ctx);
      const tempLocal = ctx.scopeStack.allocLocal();
      ctx.ir.push({ kind: "StoreLocal", index: tempLocal });
      const sourceStruct = resolveStructType(spreadType, ctx.services, ctx.projectNamespace, ctx.checker);
      for (const sym of properties) {
        const targetField = findStructField(structDef, sym.name);
        // A spread source property that is not a field of the target struct has no
        // storage slot; there is nothing to write.
        if (!targetField) {
          continue;
        }
        ctx.ir.push({ kind: "LoadLocal", index: tempLocal });
        const sourceField = sourceStruct ? findStructField(sourceStruct, sym.name) : undefined;
        ctx.ir.push(
          sourceStruct && sourceField && isIndexedStruct(sourceStruct)
            ? { kind: "GetField", fieldName: sym.name, fieldIndex: sourceField.fieldIndex }
            : { kind: "GetField", fieldName: sym.name }
        );
        ctx.ir.push({ kind: "StructSet", fieldIndex: targetField.fieldIndex });
      }
      continue;
    }
    if (!ts.isPropertyAssignment(prop)) {
      ctx.diagnostics.push(
        makeDiag(
          LoweringDiagCode.UnsupportedPropertyInObjectLiteral,
          "Only simple property assignments are supported in object literals",
          prop
        )
      );
      return;
    }
    let fieldName: string;
    if (ts.isIdentifier(prop.name)) {
      fieldName = prop.name.text;
    } else if (ts.isStringLiteral(prop.name)) {
      fieldName = prop.name.text;
    } else {
      ctx.diagnostics.push(
        makeDiag(
          LoweringDiagCode.UnsupportedPropertyNameInObjectLiteral,
          "Unsupported property name in object literal",
          prop
        )
      );
      return;
    }
    const field = findStructField(structDef, fieldName);
    if (!field) {
      ctx.diagnostics.push(
        makeDiag(
          LoweringDiagCode.PropertyNotOnStruct,
          `Field '${fieldName}' is not a member of struct '${structDef.name}'`,
          prop
        )
      );
      continue;
    }
    lowerExpression(prop.initializer, ctx);
    ctx.ir.push({ kind: "StructSet", fieldIndex: field.fieldIndex });
  }
}

function lowerObjectLiteralAsMap(expr: ts.ObjectLiteralExpression, mapTypeId: string, ctx: LowerContext): void {
  ctx.ir.push({ kind: "MapNew", typeId: mapTypeId });

  for (const prop of expr.properties) {
    if (ts.isShorthandPropertyAssignment(prop)) {
      const keyName = prop.name.text;
      ctx.ir.push({ kind: "PushConst", value: mkStringValue(keyName) });
      lowerExpression(prop.name, ctx);
      ctx.ir.push({ kind: "MapSet" });
      continue;
    }
    if (ts.isSpreadAssignment(prop)) {
      const spreadType = ctx.checker.getTypeAtLocation(prop.expression);
      const properties = spreadType.getProperties();
      if (properties.length === 0) {
        ctx.diagnostics.push(
          makeDiag(LoweringDiagCode.SpreadSourceUnresolvable, "Spread source type has no known properties", prop)
        );
        return;
      }
      lowerExpression(prop.expression, ctx);
      const tempLocal = ctx.scopeStack.allocLocal();
      ctx.ir.push({ kind: "StoreLocal", index: tempLocal });
      const sourceIsStruct = !!resolveStructType(spreadType, ctx.services, ctx.projectNamespace, ctx.checker);
      for (const sym of properties) {
        ctx.ir.push({ kind: "PushConst", value: mkStringValue(sym.name) });
        ctx.ir.push({ kind: "LoadLocal", index: tempLocal });
        if (sourceIsStruct) {
          const sourceStruct = resolveStructType(spreadType, ctx.services, ctx.projectNamespace, ctx.checker);
          const sourceField = sourceStruct ? findStructField(sourceStruct, sym.name) : undefined;
          ctx.ir.push(
            sourceStruct && sourceField && isIndexedStruct(sourceStruct)
              ? { kind: "GetField", fieldName: sym.name, fieldIndex: sourceField.fieldIndex }
              : { kind: "GetField", fieldName: sym.name }
          );
        } else {
          ctx.ir.push({ kind: "PushConst", value: mkStringValue(sym.name) });
          ctx.ir.push({ kind: "MapGet" });
        }
        ctx.ir.push({ kind: "MapSet" });
      }
      continue;
    }
    if (!ts.isPropertyAssignment(prop)) {
      ctx.diagnostics.push(
        makeDiag(
          LoweringDiagCode.UnsupportedPropertyInMapLiteral,
          "Only simple property assignments are supported in map literals",
          prop
        )
      );
      return;
    }
    let keyName: string;
    if (ts.isIdentifier(prop.name)) {
      keyName = prop.name.text;
    } else if (ts.isStringLiteral(prop.name)) {
      keyName = prop.name.text;
    } else {
      ctx.diagnostics.push(
        makeDiag(LoweringDiagCode.UnsupportedPropertyNameInMapLiteral, "Unsupported property name in map literal", prop)
      );
      return;
    }
    ctx.ir.push({ kind: "PushConst", value: mkStringValue(keyName) });
    lowerExpression(prop.initializer, ctx);
    ctx.ir.push({ kind: "MapSet" });
  }
}

function resolveMapTypeId(type: ts.Type, ctx: LowerContext): string | undefined {
  const registry = ctx.services.runtime.types;

  if (type.isUnion()) {
    const nonNullish = type.types.filter((t) => !(t.flags & ts.TypeFlags.Null) && !(t.flags & ts.TypeFlags.Undefined));
    if (nonNullish.length === 1) {
      return resolveMapTypeId(nonNullish[0], ctx);
    }
    return undefined;
  }

  const sym = type.aliasSymbol ?? type.getSymbol();
  if (sym) {
    const name = sym.getName();

    if (name === "Map") {
      const typeArgs =
        (type as ts.TypeReference).typeArguments ?? ctx.checker.getTypeArguments(type as ts.TypeReference);
      if (typeArgs && typeArgs.length >= 2) {
        const keyTypeId =
          tsTypeToTypeId(typeArgs[0], ctx.checker, ctx.services, ctx.projectNamespace) ?? CoreTypeIds.String;
        const valueTypeId = tsTypeToTypeId(typeArgs[1], ctx.checker, ctx.services, ctx.projectNamespace);
        if (valueTypeId) {
          return registry.instantiate("Map", List.from([keyTypeId, valueTypeId]));
        }
      }
    }

    const typeId = registry.resolveByName(name);
    if (typeId) {
      const def = registry.get(typeId);
      if (def && def.coreType === NativeType.Map) return def.typeId;
    }
  }

  const indexType = type.getStringIndexType();
  if (indexType) {
    const valueTypeId = tsTypeToTypeId(indexType, ctx.checker, ctx.services, ctx.projectNamespace);
    if (valueTypeId) {
      return registry.instantiate("Map", List.from([CoreTypeIds.String, valueTypeId]));
    }
  }

  return undefined;
}

function resolveListTypeId(arrayType: ts.Type, ctx: LowerContext): string | undefined {
  const registry = ctx.services.runtime.types;

  if (arrayType.isUnion()) {
    const nonNullish = arrayType.types.filter(
      (t) => !(t.flags & ts.TypeFlags.Null) && !(t.flags & ts.TypeFlags.Undefined)
    );
    if (nonNullish.length === 1) return resolveListTypeId(nonNullish[0], ctx);
    return undefined;
  }

  const sym = arrayType.aliasSymbol ?? arrayType.getSymbol();
  if (sym) {
    const name = sym.getName();
    const typeId = registry.resolveByName(name);
    if (typeId) {
      const def = registry.get(typeId);
      if (def && def.coreType === NativeType.List) return def.typeId;
    }
    if (name !== "Array" && name !== "ReadonlyArray") return undefined;
  }

  const checker = ctx.checker;
  const typeArgs =
    (arrayType as ts.TypeReference).typeArguments ?? checker.getTypeArguments(arrayType as ts.TypeReference);
  if (!typeArgs || typeArgs.length === 0) return undefined;

  const elementType = typeArgs[0];
  const elementTypeId = tsTypeToTypeId(elementType, ctx.checker, ctx.services, ctx.projectNamespace);
  if (!elementTypeId) return undefined;

  return registry.instantiate("List", List.from([elementTypeId]));
}

function lowerArrayLiteral(expr: ts.ArrayLiteralExpression, ctx: LowerContext): void {
  const contextualType = ctx.checker.getContextualType(expr);
  const resolvedType = contextualType ?? ctx.checker.getTypeAtLocation(expr);

  const listTypeId = resolveListTypeId(resolvedType, ctx);
  if (!listTypeId) {
    ctx.diagnostics.push(
      makeDiag(
        LoweringDiagCode.CannotDetermineListType,
        "Cannot determine list type for array literal (add a type annotation or ensure the list type is registered)",
        expr
      )
    );
    return;
  }

  const hasSpread = expr.elements.some(ts.isSpreadElement);

  if (!hasSpread) {
    ctx.ir.push({ kind: "ListNew", typeId: listTypeId });
    for (const element of expr.elements) {
      lowerExpression(element, ctx);
      ctx.ir.push({ kind: "ListPush" });
    }
    return;
  }

  const resultLocal = ctx.scopeStack.allocLocal();
  ctx.ir.push({ kind: "ListNew", typeId: listTypeId });
  ctx.ir.push({ kind: "StoreLocal", index: resultLocal });

  for (const element of expr.elements) {
    if (ts.isSpreadElement(element)) {
      emitPushAllFromList(element.expression, resultLocal, ctx, expr);
    } else {
      ctx.ir.push({ kind: "LoadLocal", index: resultLocal });
      lowerExpression(element, ctx);
      ctx.ir.push({ kind: "ListPush" });
      ctx.ir.push({ kind: "StoreLocal", index: resultLocal });
    }
  }

  ctx.ir.push({ kind: "LoadLocal", index: resultLocal });
}

function tsOperatorToOpId(kind: ts.SyntaxKind): string | undefined {
  switch (kind) {
    case ts.SyntaxKind.LessThanToken:
      return CoreOpId.LessThan;
    case ts.SyntaxKind.GreaterThanToken:
      return CoreOpId.GreaterThan;
    case ts.SyntaxKind.LessThanEqualsToken:
      return CoreOpId.LessThanOrEqualTo;
    case ts.SyntaxKind.GreaterThanEqualsToken:
      return CoreOpId.GreaterThanOrEqualTo;
    case ts.SyntaxKind.EqualsEqualsEqualsToken:
    case ts.SyntaxKind.EqualsEqualsToken:
      return CoreOpId.EqualTo;
    case ts.SyntaxKind.ExclamationEqualsEqualsToken:
    case ts.SyntaxKind.ExclamationEqualsToken:
      return CoreOpId.NotEqualTo;
    case ts.SyntaxKind.PlusToken:
      return CoreOpId.Add;
    case ts.SyntaxKind.MinusToken:
      return CoreOpId.Subtract;
    case ts.SyntaxKind.AsteriskToken:
      return CoreOpId.Multiply;
    case ts.SyntaxKind.SlashToken:
      return CoreOpId.Divide;
    case ts.SyntaxKind.PercentToken:
      return CoreOpId.Modulo;
    case ts.SyntaxKind.AsteriskAsteriskToken:
      return CoreOpId.Power;
    case ts.SyntaxKind.AmpersandToken:
      return CoreOpId.BitwiseAnd;
    case ts.SyntaxKind.BarToken:
      return CoreOpId.BitwiseOr;
    case ts.SyntaxKind.CaretToken:
      return CoreOpId.BitwiseXor;
    case ts.SyntaxKind.LessThanLessThanToken:
      return CoreOpId.LeftShift;
    case ts.SyntaxKind.GreaterThanGreaterThanToken:
      return CoreOpId.RightShift;
    default:
      return undefined;
  }
}

function expandTypeIdMembers(typeId: string, services: BrainServices): string[] {
  const registry = services.runtime.types;
  const def = registry.get(typeId);
  if (!def) return [typeId];
  if (def.coreType === NativeType.Union) {
    const members: string[] = [];
    (def as UnionTypeDef).memberTypeIds.forEach((mid: string) => {
      members.push(mid);
    });
    return members;
  }
  if (def.nullable) {
    return [(def as NullableTypeDef).baseTypeId];
  }
  return [typeId];
}

function tryResolveEnumValue(expr: ts.StringLiteral, ctx: LowerContext): Value | undefined {
  const contextualType = ctx.checker.getContextualType(expr);
  if (!contextualType) return undefined;
  const typeId = resolveRegisteredEnumTypeId(contextualType, ctx.services, ctx.projectNamespace, ctx.checker);
  if (!typeId) return undefined;
  const registry = ctx.services.runtime.types;
  const typeDef = registry.get(typeId);
  if (!typeDef || typeDef.coreType !== NativeType.Enum) return undefined;
  return { t: NativeType.Enum, typeId, v: expr.text };
}

/**
 * Resolve a TS type that is the instance type of a user `StructType({...})`
 * declaration to the declared struct's registered type id. An instance type
 * surfaces as a `StructValueOf<F>` instantiation of the ambient `wendoo`
 * alias; `F`'s declaration site sits inside the declaring
 * `const X = StructType({...})`, which names the registered identity.
 * Returns undefined when the type is not such an instance type or the
 * declaration is not registered.
 */
function resolveDeclaredStructInstanceTypeId(
  type: ts.Type,
  services: BrainServices,
  projectNamespace: string
): TypeId | undefined {
  const alias = type.aliasSymbol;
  if (!alias) return undefined;
  if (alias.getName() !== "StructValueOf") return undefined;
  const aliasDecl = alias.getDeclarations()?.[0];
  if (!aliasDecl || !isWendooModuleDeclaration(aliasDecl)) return undefined;
  const argType =
    type.aliasTypeArguments && type.aliasTypeArguments.length > 0 ? type.aliasTypeArguments[0] : undefined;
  const argDecl = argType?.getSymbol()?.getDeclarations()?.[0];
  if (!argDecl) return undefined;

  let node: ts.Node | undefined = argDecl;
  while (node && !ts.isSourceFile(node)) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && structTypeConfigObject(node.initializer)) {
      const identity = qualifiedDeclarationName(projectNamespace, node.getSourceFile().fileName, node.name.text);
      const typeId = services.runtime.types.resolveByName(identity);
      if (typeId !== undefined) {
        const def = services.runtime.types.get(typeId);
        if (def && def.coreType === NativeType.Struct) return typeId;
      }
      return undefined;
    }
    node = node.parent;
  }
  return undefined;
}

function tsTypeToTypeId(
  type: ts.Type,
  checker: ts.TypeChecker | undefined,
  services: BrainServices,
  projectNamespace: string
): string | undefined {
  // Enum member literals carry the NumberLike/StringLike flags of their
  // underlying values, so enum-literal resolution must precede the primitive
  // checks or an enum-typed expression collapses to number/string.
  const enumLiteralTypeId = resolveEnumLiteralTypeId(type, services, projectNamespace, checker);
  if (enumLiteralTypeId) {
    return enumLiteralTypeId;
  }
  if (type.flags & ts.TypeFlags.NumberLike) {
    return CoreTypeIds.Number;
  }
  if (type.flags & ts.TypeFlags.BooleanLike) {
    return CoreTypeIds.Boolean;
  }
  if (type.flags & ts.TypeFlags.StringLike) {
    return CoreTypeIds.String;
  }
  if (type.flags & ts.TypeFlags.Null || type.flags & ts.TypeFlags.Undefined) {
    return CoreTypeIds.Nil;
  }
  if (type.flags & ts.TypeFlags.Void) {
    return CoreTypeIds.Void;
  }
  if (type.flags & ts.TypeFlags.TypeParameter) {
    if (checker) {
      const constraint = checker.getBaseConstraintOfType(type);
      if (constraint) {
        return tsTypeToTypeId(constraint, checker, services, projectNamespace);
      }
    }
    return CoreTypeIds.Any;
  }
  const enumTypeId = resolveRegisteredEnumTypeId(type, services, projectNamespace, checker);
  if (enumTypeId) {
    return enumTypeId;
  }
  if (isBufferType(type)) {
    return CoreTypeIds.Buffer;
  }
  const callSigs = type.getCallSignatures();
  if (callSigs.length > 0 && checker) {
    const sig = callSigs[0];
    const paramTypeIds = new List<string>();
    let allResolved = true;
    for (const param of sig.parameters) {
      const paramType = checker.getTypeOfSymbol(param);
      const paramTid = tsTypeToTypeId(paramType, checker, services, projectNamespace);
      if (!paramTid) {
        allResolved = false;
        break;
      }
      paramTypeIds.push(paramTid);
    }
    if (allResolved) {
      const retType = sig.getReturnType();
      const retTid = tsTypeToTypeId(retType, checker, services, projectNamespace);
      if (retTid) {
        return services.runtime.types.getOrCreateFunctionType({
          paramTypeIds,
          returnTypeId: retTid,
        });
      }
    }
    return CoreTypeIds.Function;
  }
  if (callSigs.length > 0) {
    return CoreTypeIds.Function;
  }
  if (type.isUnion()) {
    const nonNullish = type.types.filter((t) => !(t.flags & ts.TypeFlags.Null) && !(t.flags & ts.TypeFlags.Undefined));
    const hasNullish = nonNullish.length < type.types.length;
    if (nonNullish.length === 1) {
      const baseTypeId = tsTypeToTypeId(nonNullish[0], checker, services, projectNamespace);
      if (!baseTypeId) return undefined;
      if (hasNullish) {
        return services.runtime.types.addNullableType(baseTypeId);
      }
      return baseTypeId;
    }
    if (nonNullish.length >= 2) {
      const memberIds = new List<string>();
      for (const t of nonNullish) {
        const id = tsTypeToTypeId(t, checker, services, projectNamespace);
        if (!id) return CoreTypeIds.Any;
        memberIds.push(id);
      }
      if (hasNullish) {
        memberIds.push(CoreTypeIds.Nil);
      }
      const deduped = new Set<string>();
      memberIds.forEach((id) => {
        deduped.add(id);
      });
      if (deduped.size >= 2) {
        return services.runtime.types.getOrCreateUnionType(List.from([...deduped]));
      }
      if (deduped.size === 1) {
        return [...deduped][0];
      }
    }
  }
  if (type.isIntersection() && checker) {
    const hasPrimitive = type.types.some(
      (t) =>
        !!(
          t.flags &
          (ts.TypeFlags.NumberLike |
            ts.TypeFlags.StringLike |
            ts.TypeFlags.BooleanLike |
            ts.TypeFlags.Void |
            ts.TypeFlags.Null |
            ts.TypeFlags.Undefined)
        )
    );
    if (!hasPrimitive) {
      return autoRegisterIntersectionType(type, checker, services, projectNamespace);
    }
  }
  const declaredStructId = resolveDeclaredStructInstanceTypeId(type, services, projectNamespace);
  if (declaredStructId) {
    return declaredStructId;
  }
  const sym = type.aliasSymbol ?? type.getSymbol();
  if (sym) {
    const registry = services.runtime.types;
    const symName = sym.getName();

    if (symName === "Array" && checker) {
      const typeArgs = (type as ts.TypeReference).typeArguments ?? checker.getTypeArguments(type as ts.TypeReference);
      if (typeArgs && typeArgs.length > 0) {
        const elementTypeId = tsTypeToTypeId(typeArgs[0], checker, services, projectNamespace);
        if (elementTypeId) {
          return registry.instantiate("List", List.from([elementTypeId]));
        }
      }
    }

    if (symName === "Map" && checker) {
      const typeArgs = (type as ts.TypeReference).typeArguments ?? checker.getTypeArguments(type as ts.TypeReference);
      if (typeArgs && typeArgs.length >= 2) {
        const keyTypeId = tsTypeToTypeId(typeArgs[0], checker, services, projectNamespace) ?? CoreTypeIds.String;
        const valueTypeId = tsTypeToTypeId(typeArgs[1], checker, services, projectNamespace);
        if (valueTypeId) {
          return registry.instantiate("Map", List.from([keyTypeId, valueTypeId]));
        }
      }
    }

    const typeId = registry.resolveByName(resolveRegistryName(sym, services, projectNamespace));
    if (typeId) return typeId;

    if (checker) {
      const autoId = autoRegisterObjectType(type, sym, checker, services, projectNamespace);
      if (autoId) return autoId;
    }
  }

  if (checker) {
    const indexType = type.getStringIndexType();
    if (indexType) {
      const valueTypeId = tsTypeToTypeId(indexType, checker, services, projectNamespace);
      if (valueTypeId) {
        return services.runtime.types.instantiate("Map", List.from([CoreTypeIds.String, valueTypeId]));
      }
    }
  }

  return undefined;
}

function autoRegisterIntersectionType(
  type: ts.IntersectionType,
  checker: ts.TypeChecker,
  services: BrainServices,
  projectNamespace: string
): string | undefined {
  const aliasSym = type.aliasSymbol;
  if (aliasSym) {
    const aliasName = resolveRegistryName(aliasSym, services, projectNamespace);
    const existing = services.runtime.types.resolveByName(aliasName);
    if (existing) return existing;
  }

  const callSigs = type.getCallSignatures();
  if (callSigs.length > 0) return undefined;
  const constructSigs = type.getConstructSignatures();
  if (constructSigs.length > 0) return undefined;
  const props = type.getProperties();
  if (props.length === 0) return undefined;

  const fields = new List<{ name: string; typeId: TypeId; fieldIndex: number; optional?: boolean }>();
  for (const prop of props) {
    const propType = checker.getTypeOfSymbol(prop);
    if (propType.getCallSignatures().length > 0) return undefined;
    let fieldTypeId = tsTypeToTypeId(propType, checker, services, projectNamespace);
    if (!fieldTypeId) return undefined;
    const isOptional = (prop.flags & ts.SymbolFlags.Optional) !== 0;
    if (isOptional && fieldTypeId !== CoreTypeIds.Nil) {
      fieldTypeId = services.runtime.types.addNullableType(fieldTypeId);
    }
    fields.push({
      name: prop.name,
      typeId: fieldTypeId,
      fieldIndex: fields.size(),
      optional: isOptional ? true : undefined,
    });
  }

  let structName: string;
  if (aliasSym) {
    structName = resolveRegistryName(aliasSym, services, projectNamespace);
  } else {
    const constituentNames: string[] = [];
    for (const t of type.types) {
      const id = tsTypeToTypeId(t, checker, services, projectNamespace);
      if (!id) return undefined;
      constituentNames.push(id);
    }
    structName = constituentNames.join("&");
    const existing = services.runtime.types.resolveByName(structName);
    if (existing) return existing;
  }

  const registry = services.runtime.types;
  const typeId = registry.reserveStructType(structName);
  registry.finalizeStructType(typeId, { fields });
  return typeId;
}

function autoRegisterAnonymousStruct(
  type: ts.Type,
  checker: ts.TypeChecker,
  services: BrainServices,
  projectNamespace: string
): StructTypeDef | undefined {
  const callSigs = type.getCallSignatures();
  if (callSigs.length > 0) return undefined;
  const constructSigs = type.getConstructSignatures();
  if (constructSigs.length > 0) return undefined;
  const props = type.getProperties();
  if (props.length === 0) return undefined;

  const fields = new List<{ name: string; typeId: TypeId; fieldIndex: number; optional?: boolean }>();
  const nameParts: string[] = [];
  for (const prop of props) {
    // Literal field types widen to their declared types (an enum member
    // becomes its enum), matching the object type TypeScript itself infers.
    const propType = checker.getBaseTypeOfLiteralType(checker.getTypeOfSymbol(prop));
    if (propType.getCallSignatures().length > 0) return undefined;
    let fieldTypeId = tsTypeToTypeId(propType, checker, services, projectNamespace);
    if (!fieldTypeId) return undefined;
    const isOptional = (prop.flags & ts.SymbolFlags.Optional) !== 0;
    if (isOptional && fieldTypeId !== CoreTypeIds.Nil) {
      fieldTypeId = services.runtime.types.addNullableType(fieldTypeId);
    }
    fields.push({
      name: prop.name,
      typeId: fieldTypeId,
      fieldIndex: fields.size(),
      optional: isOptional ? true : undefined,
    });
    nameParts.push(`${prop.name}:${fieldTypeId}`);
  }

  const structName = `{${nameParts.join(",")}}`;
  const registry = services.runtime.types;
  const existing = registry.resolveByName(structName);
  if (existing) {
    const def = registry.get(existing);
    if (def && def.coreType === NativeType.Struct) return def as StructTypeDef;
    return undefined;
  }

  const typeId = registry.reserveStructType(structName);
  registry.finalizeStructType(typeId, { fields });
  const def = registry.get(typeId);
  if (def && def.coreType === NativeType.Struct) return def as StructTypeDef;
  return undefined;
}

function autoRegisterObjectType(
  type: ts.Type,
  sym: ts.Symbol,
  checker: ts.TypeChecker,
  services: BrainServices,
  projectNamespace: string
): string | undefined {
  const resolvedSym = resolveAliasedSymbol(sym, checker) ?? sym;
  const decls = resolvedSym.getDeclarations();
  if (!decls || decls.length === 0) return undefined;
  const hasNamedDecl = decls.some(
    (d) => ts.isInterfaceDeclaration(d) || ts.isTypeAliasDeclaration(d) || ts.isClassDeclaration(d)
  );
  if (!hasNamedDecl) return undefined;

  if (type.isIntersection()) {
    const hasPrimitive = type.types.some(
      (t) =>
        !!(
          t.flags &
          (ts.TypeFlags.NumberLike |
            ts.TypeFlags.StringLike |
            ts.TypeFlags.BooleanLike |
            ts.TypeFlags.Void |
            ts.TypeFlags.Null |
            ts.TypeFlags.Undefined)
        )
    );
    if (hasPrimitive) return undefined;
  }

  const callSigs = type.getCallSignatures();
  if (callSigs.length > 0) return undefined;
  const constructSigs = type.getConstructSignatures();
  if (constructSigs.length > 0) return undefined;
  const props = type.getProperties();
  if (props.length === 0) return undefined;

  const fields = new List<{ name: string; typeId: TypeId; fieldIndex: number; optional?: boolean }>();
  for (const prop of props) {
    const propType = checker.getTypeOfSymbol(prop);
    if (propType.getCallSignatures().length > 0) return undefined;
    let fieldTypeId = tsTypeToTypeId(propType, checker, services, projectNamespace);
    if (!fieldTypeId) return undefined;
    const isOptional = (prop.flags & ts.SymbolFlags.Optional) !== 0;
    if (isOptional && fieldTypeId !== CoreTypeIds.Nil) {
      fieldTypeId = services.runtime.types.addNullableType(fieldTypeId);
    }
    fields.push({
      name: prop.name,
      typeId: fieldTypeId,
      fieldIndex: fields.size(),
      optional: isOptional ? true : undefined,
    });
  }

  const baseName = resolveRegistryName(sym, services, projectNamespace);
  const typeArgs =
    type.aliasTypeArguments ??
    (type as ts.TypeReference).typeArguments ??
    checker.getTypeArguments(type as ts.TypeReference);
  let structName = baseName;
  if (typeArgs && typeArgs.length > 0) {
    const argIds: string[] = [];
    for (const ta of typeArgs) {
      const argId = tsTypeToTypeId(ta, checker, services, projectNamespace);
      argIds.push(argId ?? "?");
    }
    structName = `${baseName}<${argIds.join(",")}>`;
  }

  const registry = services.runtime.types;
  const existing = registry.resolveByName(structName);
  if (existing) return existing;

  const typeId = registry.reserveStructType(structName);
  registry.finalizeStructType(typeId, { fields });
  return typeId;
}

function hasStaticModifier(node: ts.ClassElement): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  const mods = ts.getModifiers(node);
  return mods?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword) ?? false;
}

function extractClassFields(
  classNode: ts.ClassDeclaration,
  checker: ts.TypeChecker,
  diagnostics: CompileDiagnostic[],
  services: BrainServices,
  projectNamespace: string
): List<{ name: string; typeId: TypeId; fieldIndex: number; optional?: boolean }> | undefined {
  const fields = new List<{ name: string; typeId: TypeId; fieldIndex: number; optional?: boolean }>();
  const seen = new Set<string>();

  for (const member of classNode.members) {
    if (!ts.isPropertyDeclaration(member)) continue;
    if (hasStaticModifier(member)) continue;
    if (!ts.isIdentifier(member.name)) {
      diagnostics.push(
        makeDiag(
          LoweringDiagCode.ComputedClassMemberNameNotSupported,
          "Computed property names are not supported in class declarations",
          member.name
        )
      );
      continue;
    }
    const fieldName = member.name.text;
    if (seen.has(fieldName)) continue;
    seen.add(fieldName);

    const memberType = checker.getTypeAtLocation(member);
    const fieldTypeId = tsTypeToTypeId(memberType, checker, services, projectNamespace);
    if (!fieldTypeId) {
      diagnostics.push(
        makeDiag(
          LoweringDiagCode.UnresolvableClassFieldType,
          `Cannot resolve type of class field '${fieldName}'`,
          member
        )
      );
      return undefined;
    }
    const isOptional = member.questionToken !== undefined;
    fields.push({
      name: fieldName,
      typeId: fieldTypeId,
      fieldIndex: fields.size(),
      optional: isOptional ? true : undefined,
    });
  }

  const ctor = classNode.members.find(ts.isConstructorDeclaration);
  if (ctor?.body) {
    for (const stmt of ctor.body.statements) {
      if (!ts.isExpressionStatement(stmt)) continue;
      const expr = stmt.expression;
      if (!ts.isBinaryExpression(expr)) continue;
      if (expr.operatorToken.kind !== ts.SyntaxKind.EqualsToken) continue;
      if (!ts.isPropertyAccessExpression(expr.left)) continue;
      if (expr.left.expression.kind !== ts.SyntaxKind.ThisKeyword) continue;

      const fieldName = expr.left.name.text;
      if (seen.has(fieldName)) continue;
      seen.add(fieldName);

      const assignType = checker.getTypeAtLocation(expr.left);
      const fieldTypeId = tsTypeToTypeId(assignType, checker, services, projectNamespace);
      if (!fieldTypeId) {
        diagnostics.push(
          makeDiag(
            LoweringDiagCode.UnresolvableClassFieldType,
            `Cannot resolve type of class field '${fieldName}'`,
            expr.left
          )
        );
        return undefined;
      }
      fields.push({ name: fieldName, typeId: fieldTypeId, fieldIndex: fields.size() });
    }
  }

  return fields;
}

function extractClassMethodDecls(
  classNode: ts.ClassDeclaration,
  checker: ts.TypeChecker,
  diagnostics: CompileDiagnostic[],
  services: BrainServices,
  projectNamespace: string
): List<{ name: string; params: List<{ name: string; typeId: TypeId }>; returnTypeId: TypeId }> {
  const methods = new List<{
    name: string;
    params: List<{ name: string; typeId: TypeId }>;
    returnTypeId: TypeId;
  }>();

  for (const member of classNode.members) {
    if (!ts.isMethodDeclaration(member)) continue;
    if (hasStaticModifier(member)) continue;
    if (!ts.isIdentifier(member.name)) {
      diagnostics.push(
        makeDiag(
          LoweringDiagCode.ComputedClassMemberNameNotSupported,
          "Computed property names are not supported in class declarations",
          member.name
        )
      );
      continue;
    }

    const sig = checker.getSignatureFromDeclaration(member);
    if (!sig) continue;

    const params = new List<{ name: string; typeId: TypeId }>();
    for (const param of sig.parameters) {
      const paramType = checker.getTypeOfSymbol(param);
      const paramTypeId = tsTypeToTypeId(paramType, checker, services, projectNamespace) ?? CoreTypeIds.Any;
      params.push({ name: param.getName(), typeId: paramTypeId });
    }

    const retType = sig.getReturnType();
    const returnTypeId = tsTypeToTypeId(retType, checker, services, projectNamespace) ?? CoreTypeIds.Void;

    methods.push({ name: member.name.text, params, returnTypeId });
  }

  return methods;
}

function reserveClassStructType(
  ci: ImportedClass,
  services: BrainServices,
  projectNamespace: string
): string | undefined {
  const registry = services.runtime.types;
  const qualName = qualifiedDeclarationName(projectNamespace, ci.sourceFile.fileName, ci.name);
  const existing = registry.resolveByName(qualName);
  if (existing) return undefined;

  return registry.withOwner("dynamic", () => registry.reserveStructType(qualName));
}

function finalizeClassStructType(
  ci: ImportedClass,
  typeId: string,
  checker: ts.TypeChecker,
  diagnostics: CompileDiagnostic[],
  services: BrainServices,
  projectNamespace: string
): void {
  const fields = extractClassFields(ci.node, checker, diagnostics, services, projectNamespace);
  if (!fields) return;

  const methods = extractClassMethodDecls(ci.node, checker, diagnostics, services, projectNamespace);
  services.runtime.types.finalizeStructType(typeId, { fields, methods });
}

function reserveInterfaceStructType(
  ii: InterfaceInfo,
  checker: ts.TypeChecker,
  diagnostics: CompileDiagnostic[],
  services: BrainServices,
  projectNamespace: string
): string | undefined {
  const registry = services.runtime.types;
  const qualName = qualifiedDeclarationName(projectNamespace, ii.sourceFile.fileName, ii.name);

  if (registry.resolveByName(ii.name)) {
    diagnostics.push(
      makeDiag(
        LoweringDiagCode.InterfaceCollidesWithAmbientType,
        `Interface '${ii.name}' collides with an ambient (runtime-registered) type`,
        ii.node
      )
    );
    return undefined;
  }

  // TS merges multiple interface declarations with the same name. The checker
  // already returns the merged type, so the first declaration we process
  // registers the full field set. Subsequent declarations are safe to skip.
  const existing = registry.resolveByName(qualName);
  if (existing) return undefined;

  if (ii.node.typeParameters && ii.node.typeParameters.length > 0) {
    return undefined;
  }

  return registry.reserveStructType(qualName);
}

function finalizeInterfaceStructType(
  ii: InterfaceInfo,
  typeId: string,
  checker: ts.TypeChecker,
  diagnostics: CompileDiagnostic[],
  services: BrainServices,
  projectNamespace: string
): void {
  const type = checker.getTypeAtLocation(ii.node);
  const fields = extractInterfaceFields(type, ii.node, checker, diagnostics, services, projectNamespace);
  if (!fields) return;

  services.runtime.types.finalizeStructType(typeId, { fields });
}

function reserveTypeAliasStructType(
  tai: TypeAliasInfo,
  checker: ts.TypeChecker,
  diagnostics: CompileDiagnostic[],
  services: BrainServices,
  projectNamespace: string
): string | undefined {
  const registry = services.runtime.types;
  const qualName = qualifiedDeclarationName(projectNamespace, tai.sourceFile.fileName, tai.name);

  if (registry.resolveByName(tai.name)) {
    diagnostics.push(
      makeDiag(
        LoweringDiagCode.TypeAliasCollidesWithAmbientType,
        `Type alias '${tai.name}' collides with an ambient (runtime-registered) type`,
        tai.node
      )
    );
    return undefined;
  }

  const existing = registry.resolveByName(qualName);
  if (existing) return undefined;

  if (tai.node.typeParameters && tai.node.typeParameters.length > 0) {
    return undefined;
  }

  if (!ts.isTypeLiteralNode(tai.node.type)) return undefined;

  return registry.reserveStructType(qualName);
}

function finalizeTypeAliasStructType(
  tai: TypeAliasInfo,
  typeId: string,
  checker: ts.TypeChecker,
  diagnostics: CompileDiagnostic[],
  services: BrainServices,
  projectNamespace: string
): void {
  const type = checker.getTypeAtLocation(tai.node);
  const fields = extractInterfaceFields(type, tai.node, checker, diagnostics, services, projectNamespace);
  if (!fields) return;

  services.runtime.types.finalizeStructType(typeId, { fields });
}

function extractInterfaceFields(
  type: ts.Type,
  node: ts.Node,
  checker: ts.TypeChecker,
  diagnostics: CompileDiagnostic[],
  services: BrainServices,
  projectNamespace: string
): List<{ name: string; typeId: TypeId; fieldIndex: number; optional?: boolean }> | undefined {
  const fields = new List<{ name: string; typeId: TypeId; fieldIndex: number; optional?: boolean }>();

  const indexInfo = checker.getIndexInfosOfType(type);
  if (indexInfo.length > 0) {
    diagnostics.push(
      makeDiag(LoweringDiagCode.UnsupportedInterfaceMember, "Index signatures are not supported in interfaces", node)
    );
    return undefined;
  }

  const callSigs = type.getCallSignatures();
  if (callSigs.length > 0) {
    diagnostics.push(
      makeDiag(LoweringDiagCode.UnsupportedInterfaceMember, "Call signatures are not supported in interfaces", node)
    );
    return undefined;
  }

  const constructSigs = type.getConstructSignatures();
  if (constructSigs.length > 0) {
    diagnostics.push(
      makeDiag(
        LoweringDiagCode.UnsupportedInterfaceMember,
        "Construct signatures are not supported in interfaces",
        node
      )
    );
    return undefined;
  }

  const properties = type.getProperties();
  for (const prop of properties) {
    const propType = checker.getTypeOfSymbol(prop);
    const isOptional = (prop.flags & ts.SymbolFlags.Optional) !== 0;

    let fieldTypeId = tsTypeToTypeId(propType, checker, services, projectNamespace);
    if (!fieldTypeId) {
      diagnostics.push(
        makeDiag(
          LoweringDiagCode.UnresolvableInterfaceFieldType,
          `Cannot resolve type of interface field '${prop.name}'`,
          prop.valueDeclaration ?? node
        )
      );
      return undefined;
    }

    if (isOptional && fieldTypeId !== CoreTypeIds.Nil) {
      fieldTypeId = services.runtime.types.addNullableType(fieldTypeId);
    }

    fields.push({
      name: prop.name,
      typeId: fieldTypeId,
      fieldIndex: fields.size(),
      optional: isOptional ? true : undefined,
    });
  }

  return fields;
}

function lowerClassDeclaration(
  ci: ClassInfo,
  checker: ts.TypeChecker,
  callsiteVars: Map<string, number>,
  functionTable: Map<string, number>,
  diagnostics: CompileDiagnostic[],
  funcIdCounter: { value: number },
  closureFunctions: Map<number, FunctionEntry>,
  services: BrainServices,
  projectNamespace: string,
  classInfos: ClassInfo[]
): FunctionEntry[] {
  const entries: FunctionEntry[] = [];

  const registry = services.runtime.types;
  const qualName = qualifiedDeclarationName(projectNamespace, ci.sourceFile.fileName, ci.name);
  const typeId = registry.resolveByName(qualName);

  const ctor = ci.node.members.find(ts.isConstructorDeclaration);
  const ctorParamCount = ctor ? ctor.parameters.length : 0;

  const ctorIr: IrNode[] = [];
  const ctorParamLocals = new Map<string, number>();

  for (let i = 0; i < ctorParamCount; i++) {
    const p = ctor!.parameters[i];
    if (ts.isIdentifier(p.name)) {
      ctorParamLocals.set(p.name.text, i);
    }
  }

  const ctorScope = new ScopeStack(ctorParamCount);
  const ctorFuncScopeId = ctorScope.initFunctionScope(0, `${ci.name}$new`);
  const thisLocal = ctorScope.allocLocal();

  for (let i = 0; i < ctorParamCount; i++) {
    const p = ctor!.parameters[i];
    if (ts.isIdentifier(p.name)) {
      ctorScope.addParameterMetadata(p.name.text, i, ctorFuncScopeId);
    }
  }

  const ctorCtx: LowerContext = {
    services,
    projectNamespace,
    checker,
    paramsSymbol: undefined,
    paramLocals: ctorParamLocals,
    scopeStack: ctorScope,
    ir: ctorIr,
    diagnostics,
    loopStack: [],
    breakStack: [],
    nextLabelId: 0,
    callsiteVars,
    functionTable,
    funcIdCounter,
    closureFunctions,
    thisLocalIndex: thisLocal,
    currentFunctionName: `${ci.name}$new`,
    currentReturnTypeId: ctor ? resolveSignatureReturnTypeId(ctor, checker, services, projectNamespace) : undefined,
    classInfos,
  };

  if (typeId) {
    ctorIr.push({ kind: "StructNew", typeId });
  } else {
    ctorIr.push({ kind: "PushConst", value: NIL_VALUE });
  }
  ctorIr.push({ kind: "StoreLocal", index: thisLocal });

  for (const member of ci.node.members) {
    if (!ts.isPropertyDeclaration(member)) continue;
    if (hasStaticModifier(member)) continue;
    if (!ts.isIdentifier(member.name)) continue;
    if (!member.initializer) continue;

    const fieldName = member.name.text;
    const structDef = typeId ? (services.runtime.types.get(typeId) as StructTypeDef | undefined) : undefined;
    const field = structDef ? findStructField(structDef, fieldName) : undefined;
    if (!field) {
      ctorCtx.diagnostics.push(
        makeDiag(LoweringDiagCode.PropertyNotOnStruct, `Cannot resolve field id for '${fieldName}'`, member)
      );
      continue;
    }
    ctorIr.push({ kind: "LoadLocal", index: thisLocal });
    lowerExpression(member.initializer, ctorCtx);
    ctorIr.push({ kind: "StructSet", fieldIndex: field.fieldIndex });
    ctorIr.push({ kind: "StoreLocal", index: thisLocal });
  }

  if (ctor?.body) {
    lowerStatements(ctor.body.statements, ctorCtx);
  }

  ctorIr.push({ kind: "LoadLocal", index: thisLocal });
  ctorIr.push({ kind: "Return" });

  ctorScope.finalizeFunctionScope(ctorIr.length);
  entries.push({
    ir: ctorIr,
    numParams: ctorParamCount,
    numLocals: ctorScope.nextLocal,
    name: `${ci.name}$new`,
    scopeMetadata: [...ctorScope.scopeMetadata],
    localMetadata: [...ctorScope.localMetadata],
    isGenerated: false,
    sourceFileName: ci.sourceFile.fileName,
    functionSpan: ctor ? spanFromNode(ctor) : spanFromNode(ci.node),
  });

  for (const member of ci.node.members) {
    if (!ts.isMethodDeclaration(member)) continue;
    if (hasStaticModifier(member)) continue;
    if (!ts.isIdentifier(member.name)) continue;

    const methodName = member.name.text;
    const userParamCount = member.parameters.length;
    const totalParamCount = userParamCount + 1;

    const methodIr: IrNode[] = [];
    const methodParamLocals = new Map<string, number>();

    for (let i = 0; i < userParamCount; i++) {
      const p = member.parameters[i];
      if (ts.isIdentifier(p.name)) {
        methodParamLocals.set(p.name.text, i + 1);
      }
    }

    const methodScope = new ScopeStack(totalParamCount);
    const methodFuncScopeId = methodScope.initFunctionScope(0, `${ci.name}.${methodName}`);

    methodScope.addParameterMetadata("this", 0, methodFuncScopeId);
    for (let i = 0; i < userParamCount; i++) {
      const p = member.parameters[i];
      if (ts.isIdentifier(p.name)) {
        methodScope.addParameterMetadata(p.name.text, i + 1, methodFuncScopeId);
      }
    }

    const methodCtx: LowerContext = {
      services,
      projectNamespace,
      checker,
      paramsSymbol: undefined,
      paramLocals: methodParamLocals,
      scopeStack: methodScope,
      ir: methodIr,
      diagnostics,
      loopStack: [],
      breakStack: [],
      nextLabelId: 0,
      callsiteVars,
      functionTable,
      funcIdCounter,
      closureFunctions,
      thisLocalIndex: 0,
      currentFunctionName: `${ci.name}.${methodName}`,
      currentReturnTypeId: resolveSignatureReturnTypeId(member, checker, services, projectNamespace),
      classInfos,
    };

    for (let i = 0; i < userParamCount; i++) {
      const p = member.parameters[i];
      if (ts.isObjectBindingPattern(p.name)) {
        lowerObjectBindingPattern(p.name, i + 1, methodCtx);
      } else if (ts.isArrayBindingPattern(p.name)) {
        lowerArrayBindingPattern(p.name, i + 1, methodCtx);
      }
    }

    if (member.body) {
      lowerStatements(member.body.statements, methodCtx);
    }

    methodIr.push({ kind: "PushConst", value: NIL_VALUE });
    methodIr.push({ kind: "Return" });

    methodScope.finalizeFunctionScope(methodIr.length);
    entries.push({
      ir: methodIr,
      numParams: totalParamCount,
      numLocals: methodScope.nextLocal,
      name: `${ci.name}.${methodName}`,
      scopeMetadata: [...methodScope.scopeMetadata],
      localMetadata: [...methodScope.localMetadata],
      isGenerated: false,
      sourceFileName: ci.sourceFile.fileName,
      functionSpan: spanFromNode(member),
    });
  }

  for (const member of ci.node.members) {
    if (!ts.isMethodDeclaration(member)) continue;
    if (!hasStaticModifier(member)) continue;
    if (!ts.isIdentifier(member.name)) {
      diagnostics.push(
        makeDiag(
          LoweringDiagCode.ComputedClassMemberNameNotSupported,
          "Computed property names are not supported in class declarations",
          member.name
        )
      );
      continue;
    }

    const methodName = member.name.text;
    const userParamCount = member.parameters.length;

    const methodIr: IrNode[] = [];
    const methodParamLocals = new Map<string, number>();

    for (let i = 0; i < userParamCount; i++) {
      const p = member.parameters[i];
      if (ts.isIdentifier(p.name)) {
        methodParamLocals.set(p.name.text, i);
      }
    }

    const methodScope = new ScopeStack(userParamCount);
    const methodFuncScopeId = methodScope.initFunctionScope(0, `${ci.name}$${methodName}`);

    for (let i = 0; i < userParamCount; i++) {
      const p = member.parameters[i];
      if (ts.isIdentifier(p.name)) {
        methodScope.addParameterMetadata(p.name.text, i, methodFuncScopeId);
      }
    }

    const methodCtx: LowerContext = {
      services,
      projectNamespace,
      checker,
      paramsSymbol: undefined,
      paramLocals: methodParamLocals,
      scopeStack: methodScope,
      ir: methodIr,
      diagnostics,
      loopStack: [],
      breakStack: [],
      nextLabelId: 0,
      callsiteVars,
      functionTable,
      funcIdCounter,
      closureFunctions,
      thisLocalIndex: undefined,
      staticClassInfo: ci,
      currentFunctionName: `${ci.name}$${methodName}`,
      currentReturnTypeId: resolveSignatureReturnTypeId(member, checker, services, projectNamespace),
      classInfos,
    };

    for (let i = 0; i < userParamCount; i++) {
      const p = member.parameters[i];
      if (ts.isObjectBindingPattern(p.name)) {
        lowerObjectBindingPattern(p.name, i, methodCtx);
      } else if (ts.isArrayBindingPattern(p.name)) {
        lowerArrayBindingPattern(p.name, i, methodCtx);
      }
    }

    if (member.body) {
      lowerStatements(member.body.statements, methodCtx);
    }

    methodIr.push({ kind: "PushConst", value: NIL_VALUE });
    methodIr.push({ kind: "Return" });

    methodScope.finalizeFunctionScope(methodIr.length);
    entries.push({
      ir: methodIr,
      numParams: userParamCount,
      numLocals: methodScope.nextLocal,
      name: `${ci.name}$${methodName}`,
      scopeMetadata: [...methodScope.scopeMetadata],
      localMetadata: [...methodScope.localMetadata],
      isGenerated: false,
      sourceFileName: ci.sourceFile.fileName,
      functionSpan: spanFromNode(member),
    });
  }

  const lowerGetterEntry = (member: ts.GetAccessorDeclaration, propName: string): void => {
    const isStatic = hasStaticModifier(member);

    if (isStatic) {
      const funcName = `${ci.name}$get_${propName}`;
      const getterIr: IrNode[] = [];
      const getterScope = new ScopeStack(0);
      getterScope.initFunctionScope(0, funcName);

      const getterCtx: LowerContext = {
        services,
        projectNamespace,
        checker,
        paramsSymbol: undefined,
        paramLocals: new Map(),
        scopeStack: getterScope,
        ir: getterIr,
        diagnostics,
        loopStack: [],
        breakStack: [],
        nextLabelId: 0,
        callsiteVars,
        functionTable,
        funcIdCounter,
        closureFunctions,
        thisLocalIndex: undefined,
        staticClassInfo: ci,
        currentFunctionName: funcName,
        currentReturnTypeId: resolveSignatureReturnTypeId(member, checker, services, projectNamespace),
        classInfos,
      };

      if (member.body) {
        lowerStatements(member.body.statements, getterCtx);
      }

      getterIr.push({ kind: "PushConst", value: NIL_VALUE });
      getterIr.push({ kind: "Return" });

      getterScope.finalizeFunctionScope(getterIr.length);
      entries.push({
        ir: getterIr,
        numParams: 0,
        numLocals: getterScope.nextLocal,
        name: funcName,
        scopeMetadata: [...getterScope.scopeMetadata],
        localMetadata: [...getterScope.localMetadata],
        isGenerated: false,
        sourceFileName: ci.sourceFile.fileName,
        functionSpan: spanFromNode(member),
      });
    } else {
      const funcName = `${ci.name}$get_${propName}`;
      const getterIr: IrNode[] = [];
      const getterScope = new ScopeStack(1);
      const getterFuncScopeId = getterScope.initFunctionScope(0, funcName);
      getterScope.addParameterMetadata("this", 0, getterFuncScopeId);

      const getterCtx: LowerContext = {
        services,
        projectNamespace,
        checker,
        paramsSymbol: undefined,
        paramLocals: new Map(),
        scopeStack: getterScope,
        ir: getterIr,
        diagnostics,
        loopStack: [],
        breakStack: [],
        nextLabelId: 0,
        callsiteVars,
        functionTable,
        funcIdCounter,
        closureFunctions,
        thisLocalIndex: 0,
        currentFunctionName: funcName,
        currentReturnTypeId: resolveSignatureReturnTypeId(member, checker, services, projectNamespace),
        classInfos,
      };

      if (member.body) {
        lowerStatements(member.body.statements, getterCtx);
      }

      getterIr.push({ kind: "PushConst", value: NIL_VALUE });
      getterIr.push({ kind: "Return" });

      getterScope.finalizeFunctionScope(getterIr.length);
      entries.push({
        ir: getterIr,
        numParams: 1,
        numLocals: getterScope.nextLocal,
        name: funcName,
        scopeMetadata: [...getterScope.scopeMetadata],
        localMetadata: [...getterScope.localMetadata],
        isGenerated: false,
        sourceFileName: ci.sourceFile.fileName,
        functionSpan: spanFromNode(member),
      });
    }
  };

  const lowerSetterEntry = (member: ts.SetAccessorDeclaration, propName: string): void => {
    const isStatic = hasStaticModifier(member);

    if (isStatic) {
      const funcName = `${ci.name}$set_${propName}`;
      const userParamCount = member.parameters.length;
      const setterIr: IrNode[] = [];
      const setterParamLocals = new Map<string, number>();

      for (let i = 0; i < userParamCount; i++) {
        const p = member.parameters[i];
        if (ts.isIdentifier(p.name)) {
          setterParamLocals.set(p.name.text, i);
        }
      }

      const setterScope = new ScopeStack(userParamCount);
      const setterFuncScopeId = setterScope.initFunctionScope(0, funcName);

      for (let i = 0; i < userParamCount; i++) {
        const p = member.parameters[i];
        if (ts.isIdentifier(p.name)) {
          setterScope.addParameterMetadata(p.name.text, i, setterFuncScopeId);
        }
      }

      const setterCtx: LowerContext = {
        services,
        projectNamespace,
        checker,
        paramsSymbol: undefined,
        paramLocals: setterParamLocals,
        scopeStack: setterScope,
        ir: setterIr,
        diagnostics,
        loopStack: [],
        breakStack: [],
        nextLabelId: 0,
        callsiteVars,
        functionTable,
        funcIdCounter,
        closureFunctions,
        thisLocalIndex: undefined,
        staticClassInfo: ci,
        currentFunctionName: funcName,
        currentReturnTypeId: undefined,
        classInfos,
      };

      if (member.body) {
        lowerStatements(member.body.statements, setterCtx);
      }

      setterIr.push({ kind: "PushConst", value: NIL_VALUE });
      setterIr.push({ kind: "Return" });

      setterScope.finalizeFunctionScope(setterIr.length);
      entries.push({
        ir: setterIr,
        numParams: userParamCount,
        numLocals: setterScope.nextLocal,
        name: funcName,
        scopeMetadata: [...setterScope.scopeMetadata],
        localMetadata: [...setterScope.localMetadata],
        isGenerated: false,
        sourceFileName: ci.sourceFile.fileName,
        functionSpan: spanFromNode(member),
      });
    } else {
      const funcName = `${ci.name}$set_${propName}`;
      const userParamCount = member.parameters.length;
      const totalParamCount = userParamCount + 1;
      const setterIr: IrNode[] = [];
      const setterParamLocals = new Map<string, number>();

      for (let i = 0; i < userParamCount; i++) {
        const p = member.parameters[i];
        if (ts.isIdentifier(p.name)) {
          setterParamLocals.set(p.name.text, i + 1);
        }
      }

      const setterScope = new ScopeStack(totalParamCount);
      const setterFuncScopeId = setterScope.initFunctionScope(0, funcName);
      setterScope.addParameterMetadata("this", 0, setterFuncScopeId);

      for (let i = 0; i < userParamCount; i++) {
        const p = member.parameters[i];
        if (ts.isIdentifier(p.name)) {
          setterScope.addParameterMetadata(p.name.text, i + 1, setterFuncScopeId);
        }
      }

      const setterCtx: LowerContext = {
        services,
        projectNamespace,
        checker,
        paramsSymbol: undefined,
        paramLocals: setterParamLocals,
        scopeStack: setterScope,
        ir: setterIr,
        diagnostics,
        loopStack: [],
        breakStack: [],
        nextLabelId: 0,
        callsiteVars,
        functionTable,
        funcIdCounter,
        closureFunctions,
        thisLocalIndex: 0,
        currentFunctionName: funcName,
        currentReturnTypeId: undefined,
        classInfos,
      };

      if (member.body) {
        lowerStatements(member.body.statements, setterCtx);
      }

      setterIr.push({ kind: "PushConst", value: NIL_VALUE });
      setterIr.push({ kind: "Return" });

      setterScope.finalizeFunctionScope(setterIr.length);
      entries.push({
        ir: setterIr,
        numParams: totalParamCount,
        numLocals: setterScope.nextLocal,
        name: funcName,
        scopeMetadata: [...setterScope.scopeMetadata],
        localMetadata: [...setterScope.localMetadata],
        isGenerated: false,
        sourceFileName: ci.sourceFile.fileName,
        functionSpan: spanFromNode(member),
      });
    }
  };

  // Accessors lower in member order, matching their func-id reservation order.
  for (const member of ci.node.members) {
    if (!ts.isGetAccessorDeclaration(member) && !ts.isSetAccessorDeclaration(member)) continue;
    if (!ts.isIdentifier(member.name)) {
      diagnostics.push(
        makeDiag(
          LoweringDiagCode.ComputedClassMemberNameNotSupported,
          "Computed property names are not supported in class declarations",
          member.name
        )
      );
      continue;
    }
    const propName = member.name.text;
    if (ts.isGetAccessorDeclaration(member)) {
      lowerGetterEntry(member, propName);
    } else {
      lowerSetterEntry(member, propName);
    }
  }

  return entries;
}

function makeDiag(
  code: LoweringDiagCode,
  message: string,
  node: ts.Node,
  severity: CompileDiagnostic["severity"] = "error"
): CompileDiagnostic {
  const sourceFile = node.getSourceFile();
  const diag: CompileDiagnostic = { code, message, severity };
  if (sourceFile) {
    const start = sourceFile.getLineAndCharacterOfPosition(node.getStart());
    const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
    diag.line = start.line + 1;
    diag.column = start.character + 1;
    diag.endLine = end.line + 1;
    diag.endColumn = end.character + 1;
  }
  return diag;
}

function makeCompileDiag(code: CompileDiagCode, message: string, node: ts.Node): CompileDiagnostic {
  const sourceFile = node.getSourceFile();
  const diag: CompileDiagnostic = { code, message, severity: "error" };
  if (sourceFile) {
    const start = sourceFile.getLineAndCharacterOfPosition(node.getStart());
    const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
    diag.line = start.line + 1;
    diag.column = start.character + 1;
    diag.endLine = end.line + 1;
    diag.endColumn = end.character + 1;
  }
  return diag;
}

function spanFromNode(node: ts.Node): IrSourceSpan | undefined {
  const sf = node.getSourceFile();
  if (!sf) return undefined;
  const start = sf.getLineAndCharacterOfPosition(node.getStart());
  const end = sf.getLineAndCharacterOfPosition(node.getEnd());
  return {
    startLine: start.line + 1,
    startColumn: start.character + 1,
    endLine: end.line + 1,
    endColumn: end.character + 1,
  };
}

function annotateFirstNode(ir: IrNode[], irStart: number, node: ts.Node, isStatementBoundary: boolean): void {
  if (ir.length <= irStart) return;
  const first = ir[irStart];
  if (first.kind === "Label" && ir.length > irStart + 1) {
    const next = ir[irStart + 1];
    if (!next.span) {
      next.span = spanFromNode(node);
      if (isStatementBoundary) next.isStatementBoundary = true;
    } else if (isStatementBoundary) {
      next.isStatementBoundary = true;
    }
    return;
  }
  if (!first.span) {
    first.span = spanFromNode(node);
    if (isStatementBoundary) first.isStatementBoundary = true;
  } else if (isStatementBoundary) {
    first.isStatementBoundary = true;
  }
}
