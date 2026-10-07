import type { Dict } from "../platform/dict";
import type { List } from "../platform/list";
import type { StableIdOwner } from "./abi-ids";
import type { Value } from "./value";
import type { StructExistsFn, StructFieldGetterFn, StructFieldSetterFn, StructSnapshotNativeFn } from "./vm-types";

// ----------------------------------------------------
// Type System
// ----------------------------------------------------

/** Datatype identifier (e.g. `"number:<int>"`). Build with {@link mkTypeId}. */
export type TypeId = string;

/** Native runtime types the brain VM understands. Concrete types are built atop these. */
export enum NativeType {
  Unknown = -1,
  Void = 0,
  Nil = 1,
  Boolean = 2,
  Number = 3,
  String = 4,
  Enum = 5,
  List = 6,
  Map = 7,
  Struct = 8,
  Any = 9,
  Union = 10,
  Function = 11,
  Buffer = 12,
}

/** Stable lower-case name for a {@link NativeType} (e.g. `NativeType.Number` -> `"number"`). */
export function nativeTypeToString(coreType: NativeType): string {
  switch (coreType) {
    case NativeType.Unknown:
      return "unknown";
    case NativeType.Void:
      return "void";
    case NativeType.Nil:
      return "nil";
    case NativeType.Boolean:
      return "boolean";
    case NativeType.Number:
      return "number";
    case NativeType.String:
      return "string";
    case NativeType.Enum:
      return "enum";
    case NativeType.List:
      return "list";
    case NativeType.Map:
      return "map";
    case NativeType.Struct:
      return "struct";
    case NativeType.Any:
      return "any";
    case NativeType.Union:
      return "union";
    case NativeType.Function:
      return "function";
    case NativeType.Buffer:
      return "buffer";
    default:
      return "invalid";
  }
}

/** Inverse of {@link nativeTypeToString}. Returns undefined for unrecognized names. */
export function nativeTypeFromString(name: string): NativeType | undefined {
  switch (name) {
    case "unknown":
      return NativeType.Unknown;
    case "void":
      return NativeType.Void;
    case "nil":
      return NativeType.Nil;
    case "boolean":
      return NativeType.Boolean;
    case "number":
      return NativeType.Number;
    case "string":
      return NativeType.String;
    case "enum":
      return NativeType.Enum;
    case "list":
      return NativeType.List;
    case "map":
      return NativeType.Map;
    case "struct":
      return NativeType.Struct;
    case "any":
      return NativeType.Any;
    case "union":
      return NativeType.Union;
    case "function":
      return NativeType.Function;
    case "buffer":
      return NativeType.Buffer;
    default:
      return undefined;
  }
}

/** String/JSON formatter for runtime values of a registered type. */
export interface TypeCodec {
  stringify(value: unknown): string;
}

/** Common fields shared by every registered type definition. */
export interface TypeDef {
  coreType: NativeType;
  typeId: TypeId;
  codec: TypeCodec;
  name: string;
  nullable?: boolean;
  autoInstantiated?: boolean;
  /**
   * Author-assigned stable type-atom id. Required for every nominal type
   * registered by a `core` or `target` owner (core ids below
   * `TARGET_TYPE_ATOM_BASE`, target ids at or above it); absent on
   * auto-instantiated structural types and on program-local (`dynamic`)
   * types. Once assigned, never changed or reused.
   */
  atomId?: number;
  /**
   * The value a brain variable of this type holds before anything writes to
   * it. Absent when the type has no meaningful empty value, in which case an
   * unwritten variable of the type reads as nil.
   */
  zero?: Value;
}

/** Primitive value backing an {@link EnumSymbolDef}. */
export type EnumPrimitiveValue = string | number;

/** A single symbol within an enum type. */
export interface EnumSymbolDef {
  key: string;
  label: string;
  value: EnumPrimitiveValue;
  deprecated?: boolean;
}

/**
 * Shape fields specific to enum types.
 *
 * For an enum registered with an {@link atomId}, the declared order of
 * `symbols` is ABI: enum values serialize as ordinals into this list. The
 * list is append-only -- never reorder or remove a symbol of a registered
 * core/target enum; add new symbols at the end.
 */
export interface EnumTypeShape {
  symbols: List<EnumSymbolDef>;
  defaultKey?: string;
  /** Stable type-atom id; see {@link TypeDef.atomId} for the assignment rules. */
  atomId?: number;
}

/** A registered enum type. */
export type EnumTypeDef = TypeDef & EnumTypeShape;

/** Shape fields specific to list types. */
export interface ListTypeShape {
  elementTypeId: TypeId;
  /** Stable type-atom id; see {@link TypeDef.atomId} for the assignment rules. */
  atomId?: number;
}

/** A registered list type. */
export type ListTypeDef = TypeDef & ListTypeShape;

/** Shape fields specific to map types. */
export interface MapTypeShape {
  keyTypeId: TypeId;
  valueTypeId: TypeId;
  /** Stable type-atom id; see {@link TypeDef.atomId} for the assignment rules. */
  atomId?: number;
}

/** A registered map type. */
export type MapTypeDef = TypeDef & MapTypeShape;

/** Declaration of a method callable on instances of a struct type. */
export interface StructMethodDecl {
  name: string;
  params: List<{ name: string; typeId: TypeId; optional?: boolean }>;
  returnTypeId: TypeId;
  isAsync?: boolean;
}

/**
 * Field definition supplied at struct registration.
 *
 * The {@link fieldIndex} is the field's author-assigned numeric id, which is
 * also its storage slot in a struct value's field list. It must be a
 * non-negative integer and unique within the struct (including across
 * {@link ITypeRegistry.addStructFields} extensions). Ids are assigned by hand
 * at the field declaration and are intended to be durable: append-only, never
 * renumbered, and never reused after a field is removed (a removed field's id
 * leaves a reserved hole). The registry validates uniqueness and
 * non-negativity; cross-build non-reuse is the author's responsibility.
 */
export interface StructFieldInput {
  readonly name: string;
  readonly typeId: TypeId;
  readonly readOnly?: boolean;
  /**
   * When true, the field may be omitted when constructing a value via object
   * literal, and reads as nil when it was not supplied; the generated ambient
   * declares such a field as `name?: T`. Governs omittability of the key, which
   * is independent of whether the value {@link typeId} admits nil.
   */
  readonly optional?: boolean;
  readonly fieldIndex: number;
}

/**
 * Stored field definition on a registered {@link StructTypeDef}. The
 * {@link fieldIndex} is the validated author-assigned id from
 * {@link StructFieldInput.fieldIndex}; it is the field's storage slot, used as
 * the operand for the `STRUCT_GET_FIELD` / `STRUCT_SET_FIELD` opcodes.
 */
export interface StructFieldDef extends StructFieldInput {
  readonly fieldIndex: number;
}

/** Shape fields specific to struct types. */
export interface StructTypeShape {
  fields: List<StructFieldInput>;
  /** If true, the struct requires exact TypeId match (no structural subtyping). */
  nominal?: boolean;
  /** If provided, GET_FIELD delegates to this instead of indexed field lookup. */
  fieldGetter?: StructFieldGetterFn;
  /** If provided, SET_FIELD delegates to this instead of indexed field mutation. */
  fieldSetter?: StructFieldSetterFn;
  /**
   * If provided, called during deep-copy (assignment) to materialize the `native` handle.
   * Use this for native structs whose `native` is a lazy resolver (e.g., a function)
   * that must be evaluated and captured at assignment time.
   * Returns the resolved native value to store in the copy.
   */
  snapshotNative?: StructSnapshotNativeFn;
  /**
   * If provided, called by every truthiness test of a value of this type; a value it reports
   * gone is falsy. Without it, every value of the type is truthy.
   */
  exists?: StructExistsFn;
  /** If provided, struct methods callable via HOST_CALL on instances of this type. */
  methods?: List<StructMethodDecl>;
  /** Stable type-atom id; see {@link TypeDef.atomId} for the assignment rules. */
  atomId?: number;
}

/**
 * A registered struct type. Differs from {@link StructTypeShape} by storing
 * fields as {@link StructFieldDef} (with assigned {@link StructFieldDef.fieldIndex}).
 */
export interface StructTypeDef extends TypeDef, Omit<StructTypeShape, "fields"> {
  fields: List<StructFieldDef>;
  /** Maps field names to their {@link StructFieldDef.fieldIndex} for name-based access to indexed storage. */
  fieldIndexByName: Dict<string, number>;
}

/** Shape fields specific to nullable types. */
export interface NullableTypeShape {
  baseTypeId: TypeId;
}

/** A registered nullable wrapper around `baseTypeId`. */
export type NullableTypeDef = TypeDef & NullableTypeShape;

/** Shape fields specific to union types. */
export interface UnionTypeShape {
  memberTypeIds: List<TypeId>;
}

/** A registered union of `memberTypeIds`. */
export type UnionTypeDef = TypeDef & UnionTypeShape;

/** Shape fields specific to function types: parameter and return type ids. */
export interface FunctionTypeShape {
  paramTypeIds: List<TypeId>;
  returnTypeId: TypeId;
}

/** A registered function type. */
export type FunctionTypeDef = TypeDef & FunctionTypeShape;

/** Constructor for parameterized type families (e.g. `List<T>`). Registered via {@link ITypeRegistry.registerConstructor}. */
export interface TypeConstructor {
  name: string;
  arity: number;
  coreType: NativeType;
  construct(registry: ITypeRegistry, args: List<TypeId>): TypeDef;
}

/**
 * Mutable registry of {@link TypeDef}s, keyed by {@link TypeId} and resolvable
 * by name or by stable type-atom id.
 *
 * Named registrations (`add*Type`) validate their `atomId` against the active
 * owner scope set by {@link withOwner}: `core` and `target` owners must supply
 * one in their partition of the atom space, `dynamic` owners must not supply
 * one. Auto-instantiated structural types (`instantiate`,
 * `getOrCreateUnionType`, `getOrCreateFunctionType`, `addNullableType`) and
 * program-local structs (`reserveStructType`/`finalizeStructType`) never
 * carry an atom id.
 */
export interface ITypeRegistry {
  withOwner<T>(owner: StableIdOwner, body: () => T): T;
  get(id: TypeId): TypeDef | undefined;
  getEnumSymbol(typeId: TypeId, key: string): EnumSymbolDef | undefined;
  resolveByName(name: string): TypeId | undefined;
  resolveByAtomId(atomId: number): TypeId | undefined;
  entries(): Iterable<[TypeId, TypeDef]>;
  addVoidType(name: string, atomId?: number): TypeId;
  addNilType(name: string, atomId?: number): TypeId;
  addBooleanType(name: string, atomId?: number): TypeId;
  addNumberType(name: string, atomId?: number): TypeId;
  addStringType(name: string, atomId?: number): TypeId;
  addBufferType(name: string, atomId?: number): TypeId;
  addEnumType(name: string, shape: EnumTypeShape): TypeId;
  addListType(name: string, shape: ListTypeShape): TypeId;
  addMapType(name: string, shape: MapTypeShape): TypeId;
  addStructType(name: string, shape: StructTypeShape): TypeId;
  reserveStructType(name: string): TypeId;
  finalizeStructType(typeId: TypeId, shape: StructTypeShape): void;
  addStructMethods(typeId: TypeId, methods: List<StructMethodDecl>): void;
  addStructFields(typeId: TypeId, fields: List<StructFieldInput>, fieldGetter?: StructFieldGetterFn): void;
  addAnyType(name: string, atomId?: number): TypeId;
  addFunctionType(name: string, atomId?: number): TypeId;
  addNullableType(baseTypeId: TypeId): TypeId;
  /**
   * Register `alias` as an additional name resolving to `typeId`. The alias
   * mints no type: {@link resolveByName} returns the aliased type's id, and
   * the alias is dropped when the aliased type is removed.
   */
  addTypeNameAlias(alias: string, typeId: TypeId): void;
  registerConstructor(ctor: TypeConstructor): void;
  instantiate(constructorName: string, args: List<TypeId>): TypeId;
  getOrCreateUnionType(memberTypeIds: List<TypeId>): TypeId;
  getOrCreateFunctionType(shape: FunctionTypeShape): TypeId;
  isStructurallyCompatible(sourceTypeId: TypeId, targetTypeId: TypeId): boolean;
  /**
   * Remove user-registered struct and enum types (module-qualified names
   * containing `::`) and their derived enum artifacts. When
   * `projectNamespace` is given, removes only the types whose name carries
   * that project's namespace; other projects' registrations are untouched.
   */
  removeUserTypes(projectNamespace?: string): void;
}
