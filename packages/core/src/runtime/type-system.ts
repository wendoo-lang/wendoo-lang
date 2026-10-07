import type { BrainServices } from "../brain/services";
import { Dict } from "../platform/dict";
import { Error } from "../platform/error";
import { List } from "../platform/list";
import { MathOps } from "../platform/math";
import { StringUtils as SU } from "../platform/string";
import { TypeUtils } from "../platform/types";
import { UniqueSet } from "../platform/uniqueset";
import { CoreFuncId, CoreTypeAtomId, type StableIdOwner, TARGET_TYPE_ATOM_BASE } from "./abi-ids";
import { registerEnumConversions } from "./conversions";
import {
  CoreTypeIds,
  CoreTypeNames,
  mkConstructedTypeName,
  mkFunctionTypeName,
  mkNullableTypeName,
  mkTypeId,
  mkUnionTypeName,
} from "./core-types";
import { CoreOpId } from "./operator-defs";
import {
  type EnumPrimitiveValue,
  type EnumSymbolDef,
  type EnumTypeDef,
  type EnumTypeShape,
  type FunctionTypeDef,
  type FunctionTypeShape,
  type ITypeRegistry,
  type ListTypeDef,
  type ListTypeShape,
  type MapTypeDef,
  type MapTypeShape,
  NativeType,
  type NullableTypeDef,
  type StructFieldDef,
  type StructFieldInput,
  type StructMethodDecl,
  type StructTypeDef,
  type StructTypeShape,
  type TypeCodec,
  type TypeConstructor,
  type TypeDef,
  type TypeId,
  type UnionTypeDef,
} from "./type-defs";
import { type BufferValue, bufferToHex, FALSE_VALUE, isBufferValue, type Value } from "./value";
import type { StructFieldGetterFn } from "./vm-types";

/**
 * Validate author-assigned field ids and return them as `StructFieldDef`s.
 * Each field's `fieldIndex` must be a non-negative integer that is unique
 * within `inputs` and against `existing` (the struct's already-registered
 * fields, empty for a fresh struct). The id is the field's durable storage
 * slot; the registry does not assign ids, it only validates them.
 */
function toStructFieldDefs(
  typeId: TypeId,
  inputs: List<StructFieldInput>,
  existing: List<StructFieldDef>
): List<StructFieldDef> {
  const usedById = new Dict<number, string>();
  existing.forEach((field) => {
    usedById.set(field.fieldIndex, field.name);
  });
  return inputs.map((field): StructFieldDef => {
    const id = field.fieldIndex;
    if (id < 0 || MathOps.floor(id) !== id) {
      throw new Error(
        `Struct type ${typeId} field ${field.name} has invalid field id ${id}: must be a non-negative integer`
      );
    }
    const prior = usedById.get(id);
    if (prior !== undefined) {
      throw new Error(
        `Struct type ${typeId} field ${field.name} reuses field id ${id} already assigned to field ${prior}`
      );
    }
    usedById.set(id, field.name);
    return {
      name: field.name,
      typeId: field.typeId,
      readOnly: field.readOnly,
      optional: field.optional,
      fieldIndex: id,
    };
  });
}

function buildFieldIndexByName(fields: List<StructFieldDef>): Dict<string, number> {
  const fieldIndexByName = new Dict<string, number>();
  fields.forEach((field) => {
    fieldIndexByName.set(field.name, field.fieldIndex);
  });
  return fieldIndexByName;
}

/** Concrete {@link ITypeRegistry}: in-memory type table with constructor-based parameterized types and structural-compatibility caching. */
export class TypeRegistry implements ITypeRegistry {
  private defs = new Dict<TypeId, TypeDef>();
  private nameToId = new Dict<string, TypeId>();
  private aliasToId = new Dict<string, TypeId>();
  private atomToId = new Dict<number, TypeId>();
  private constructors = new Dict<string, TypeConstructor>();
  private compatCache = new Dict<string, boolean>();
  private services_?: BrainServices;
  private owner: StableIdOwner = "target";

  setServices(services: BrainServices): void {
    this.services_ = services;
  }

  withOwner<T>(owner: StableIdOwner, body: () => T): T {
    const previous = this.owner;
    this.owner = owner;
    try {
      return body();
    } finally {
      this.owner = previous;
    }
  }

  private add(def: TypeDef) {
    if (this.defs.has(def.typeId)) {
      throw new Error(`Type with id ${def.typeId} is already registered`);
    }
    this.defs.set(def.typeId, def);
    this.nameToId.set(def.name, def.typeId);
    if (def.atomId !== undefined) {
      this.atomToId.set(def.atomId, def.typeId);
    }
  }

  /**
   * Validate an atom id for a named registration against the active owner
   * scope: `core` and `target` owners must supply one inside their partition
   * of the atom space, `dynamic` owners must not supply one. Also rejects
   * non-integer, negative, and already-assigned atom ids.
   */
  private validateAtomId(atomId: number | undefined, name: string): void {
    if (this.owner === "dynamic") {
      if (atomId !== undefined) {
        throw new Error(`Dynamic type '${name}' must not declare an atomId (got ${atomId})`);
      }
      return;
    }
    if (atomId === undefined) {
      throw new Error(`${this.owner === "core" ? "Core" : "Target"} type '${name}' requires an atomId`);
    }
    if (atomId < 0 || MathOps.floor(atomId) !== atomId) {
      throw new Error(`Type '${name}' has invalid atomId ${atomId}: must be a non-negative integer`);
    }
    const existing = this.atomToId.get(atomId);
    if (existing !== undefined) {
      throw new Error(`Type '${name}' reuses atomId ${atomId} already assigned to type ${existing}`);
    }
    if (this.owner === "core" && atomId >= TARGET_TYPE_ATOM_BASE) {
      throw new Error(`Core type '${name}' has atomId ${atomId} outside the core range [0, ${TARGET_TYPE_ATOM_BASE})`);
    }
    if (this.owner === "target" && atomId < TARGET_TYPE_ATOM_BASE) {
      throw new Error(
        `Target type '${name}' has atomId ${atomId} below the target range base ${TARGET_TYPE_ATOM_BASE}`
      );
    }
  }

  private validateTypeName(name: string) {
    if (!name || SU.length(SU.trim(name)) === 0) {
      throw new Error(`Type name must be a non-empty string`);
    }
  }

  private validateTypeNotRegistered(typeId: TypeId) {
    if (this.defs.has(typeId)) {
      throw new Error(`Type with id ${typeId} is already registered`);
    }
  }

  getEnumSymbol(typeId: TypeId, key: string): EnumSymbolDef | undefined {
    const def = this.defs.get(typeId);
    if (!def || def.coreType !== NativeType.Enum) {
      return undefined;
    }
    return (def as EnumTypeDef).symbols.find((symbol) => symbol.key === key);
  }

  addVoidType(name: string, atomId?: number): TypeId {
    this.validateTypeName(name);
    this.validateAtomId(atomId, name);
    const typeId = mkTypeId(NativeType.Void, name);
    this.validateTypeNotRegistered(typeId);
    this.add({
      coreType: NativeType.Void,
      typeId,
      codec: new VoidCodec(),
      name,
      atomId,
    });
    return typeId;
  }

  addNilType(name: string, atomId?: number): TypeId {
    this.validateTypeName(name);
    this.validateAtomId(atomId, name);
    const typeId = mkTypeId(NativeType.Nil, name);
    this.validateTypeNotRegistered(typeId);
    this.add({
      coreType: NativeType.Nil,
      typeId,
      codec: new NilCodec(),
      name,
      atomId,
    });
    return typeId;
  }

  addBooleanType(name: string, atomId?: number): TypeId {
    this.validateTypeName(name);
    this.validateAtomId(atomId, name);
    const typeId = mkTypeId(NativeType.Boolean, name);
    this.validateTypeNotRegistered(typeId);
    this.add({
      coreType: NativeType.Boolean,
      typeId,
      codec: new BooleanCodec(),
      name,
      atomId,
      zero: FALSE_VALUE,
    });
    return typeId;
  }

  addNumberType(name: string, atomId?: number): TypeId {
    this.validateTypeName(name);
    this.validateAtomId(atomId, name);
    const typeId = mkTypeId(NativeType.Number, name);
    this.validateTypeNotRegistered(typeId);
    this.add({
      coreType: NativeType.Number,
      typeId,
      codec: new NumberCodec(),
      name,
      atomId,
      zero: { t: NativeType.Number, v: 0 },
    });
    return typeId;
  }

  addStringType(name: string, atomId?: number): TypeId {
    this.validateTypeName(name);
    this.validateAtomId(atomId, name);
    const typeId = mkTypeId(NativeType.String, name);
    this.validateTypeNotRegistered(typeId);
    this.add({
      coreType: NativeType.String,
      typeId,
      codec: new StringCodec(),
      name,
      atomId,
      zero: { t: NativeType.String, v: "" },
    });
    return typeId;
  }

  addBufferType(name: string, atomId?: number): TypeId {
    this.validateTypeName(name);
    this.validateAtomId(atomId, name);
    const typeId = mkTypeId(NativeType.Buffer, name);
    this.validateTypeNotRegistered(typeId);
    this.add({
      coreType: NativeType.Buffer,
      typeId,
      codec: new BufferCodec(),
      name,
      atomId,
    });
    return typeId;
  }

  addEnumType(name: string, shape: EnumTypeShape): TypeId {
    this.validateTypeName(name);
    this.validateAtomId(shape.atomId, name);
    const typeId = mkTypeId(NativeType.Enum, name);
    this.validateTypeNotRegistered(typeId);
    const symbols = normalizeEnumSymbols(typeId, shape.symbols);
    const defaultKey = resolveEnumDefaultKey(typeId, symbols, shape.defaultKey);
    // Register
    const enumTypeDef: EnumTypeDef = {
      coreType: NativeType.Enum,
      typeId,
      codec: new EnumCodec(symbols),
      name,
      symbols,
      defaultKey,
      atomId: shape.atomId,
    };
    this.add(enumTypeDef);
    if (symbols.size() > 0) {
      this.registerEnumConversions(typeId);
      this.registerEnumOperators(typeId);
    }
    return typeId;
  }

  private registerEnumConversions(typeId: TypeId): void {
    if (!this.services_) return;
    registerEnumConversions(typeId, this.services_);
  }

  /**
   * Adds the `==` / `!=` overload entries for an enum type. Both entries
   * reference the shared core enum-equality host functions
   * (`CoreFuncId.OpEqualToEnum` / `CoreFuncId.OpNotEqualToEnum`).
   */
  private registerEnumOperators(typeId: TypeId): void {
    if (!this.services_) return;
    const def = this.get(typeId);
    if (!def || def.coreType !== NativeType.Enum) {
      return;
    }
    if ((def as EnumTypeDef).symbols.size() === 0) {
      return;
    }
    const functions = this.services_.runtime.functions;
    const eqEntry = functions.getSyncById(CoreFuncId.OpEqualToEnum);
    const neEntry = functions.getSyncById(CoreFuncId.OpNotEqualToEnum);
    if (!eqEntry || !neEntry) {
      throw new Error(`Enum type ${typeId} requires the shared enum equality host functions to be registered`);
    }
    const opTable = this.services_.edit.operatorOverloads.table();
    opTable
      .get(CoreOpId.EqualTo)
      ?.add({ argTypes: [typeId, typeId], resultType: CoreTypeIds.Boolean, fnEntry: eqEntry });
    opTable
      .get(CoreOpId.NotEqualTo)
      ?.add({ argTypes: [typeId, typeId], resultType: CoreTypeIds.Boolean, fnEntry: neEntry });
  }

  // The operator and conversion entries reference shared core host
  // functions; removing an enum type must leave those functions registered.
  private unregisterEnumArtifacts(typeId: TypeId): void {
    if (!this.services_) return;
    this.services_.shared.conversions.remove(typeId, CoreTypeIds.String);
    this.services_.shared.conversions.remove(typeId, CoreTypeIds.Number);
    const opTable = this.services_.edit.operatorOverloads.table();
    opTable.get(CoreOpId.EqualTo)?.remove([typeId, typeId]);
    opTable.get(CoreOpId.NotEqualTo)?.remove([typeId, typeId]);
  }

  addListType(name: string, shape: ListTypeShape): TypeId {
    this.validateTypeName(name);
    this.validateAtomId(shape.atomId, name);
    const typeId = mkTypeId(NativeType.List, name);
    this.validateTypeNotRegistered(typeId);
    const { elementTypeId } = shape;
    // Ensure element type exists
    if (!this.defs.has(elementTypeId)) {
      throw new Error(`${elementTypeId} is not a registered type`);
    }
    const elementTypeDef = this.get(elementTypeId);
    if (!elementTypeDef) {
      throw new Error(`${elementTypeId} is not a registered type`);
    }
    const listTypeDef: ListTypeDef = {
      coreType: NativeType.List,
      typeId,
      codec: new ListCodec(elementTypeDef.codec),
      name,
      ...shape,
    };
    this.add(listTypeDef);
    return typeId;
  }

  addMapType(name: string, shape: MapTypeShape): TypeId {
    this.validateTypeName(name);
    this.validateAtomId(shape.atomId, name);
    const typeId = mkTypeId(NativeType.Map, name);
    this.validateTypeNotRegistered(typeId);
    const { keyTypeId, valueTypeId } = shape;
    const keyTypeDef = this.get(keyTypeId);
    if (!keyTypeDef) {
      throw new Error(`${keyTypeId} is not a registered type`);
    }
    const valueTypeDef = this.get(valueTypeId);
    if (!valueTypeDef) {
      throw new Error(`${valueTypeId} is not a registered type`);
    }
    const mapTypeDef: MapTypeDef = {
      coreType: NativeType.Map,
      typeId,
      codec: new MapCodec(valueTypeDef.codec),
      name,
      ...shape,
    };
    this.add(mapTypeDef);
    return typeId;
  }

  addStructType(name: string, shape: StructTypeShape): TypeId {
    this.validateTypeName(name);
    this.validateAtomId(shape.atomId, name);
    const typeId = mkTypeId(NativeType.Struct, name);
    this.validateTypeNotRegistered(typeId);
    const fieldNames = new UniqueSet<string>();
    shape.fields.forEach((field) => {
      if (fieldNames.has(field.name)) {
        throw new Error(`Struct type ${typeId} has duplicate field name: ${field.name}`);
      }
      fieldNames.add(field.name);
    });
    const fieldCodecs = new Dict<string, TypeCodec>();
    shape.fields.forEach((field) => {
      const fieldTypeDef = this.get(field.typeId);
      if (!fieldTypeDef) {
        throw new Error(`Struct type ${typeId} has field ${field.name} with unknown type: ${field.typeId}`);
      }
      fieldCodecs.set(field.name, fieldTypeDef.codec);
    });

    const indexedFields = toStructFieldDefs(typeId, shape.fields, List.empty<StructFieldDef>());
    const structTypeDef: StructTypeDef = {
      coreType: NativeType.Struct,
      typeId,
      codec: new StructCodec(fieldCodecs),
      name,
      fields: indexedFields,
      fieldIndexByName: buildFieldIndexByName(indexedFields),
      nominal: shape.nominal,
      fieldGetter: shape.fieldGetter,
      fieldSetter: shape.fieldSetter,
      snapshotNative: shape.snapshotNative,
      exists: shape.exists,
      methods: shape.methods,
      atomId: shape.atomId,
    };
    this.add(structTypeDef);
    return typeId;
  }

  /**
   * Register a placeholder for a program-local struct, to be completed with
   * {@link finalizeStructType}. Program-local types carry no atom id.
   */
  reserveStructType(name: string): TypeId {
    this.validateTypeName(name);
    const typeId = mkTypeId(NativeType.Struct, name);
    this.validateTypeNotRegistered(typeId);
    const placeholder: StructTypeDef = {
      coreType: NativeType.Struct,
      typeId,
      codec: new StructCodec(new Dict<string, TypeCodec>()),
      name,
      fields: List.empty<StructFieldDef>(),
      fieldIndexByName: new Dict<string, number>(),
    };
    this.add(placeholder);
    return typeId;
  }

  finalizeStructType(typeId: TypeId, shape: StructTypeShape): void {
    const existing = this.get(typeId);
    if (!existing) {
      throw new Error(`Cannot finalize unknown type: ${typeId}`);
    }
    if (existing.coreType !== NativeType.Struct) {
      throw new Error(`Cannot finalize non-struct type: ${typeId}`);
    }
    if (shape.atomId !== undefined) {
      throw new Error(`Program-local struct type ${typeId} must not declare an atomId (got ${shape.atomId})`);
    }
    const fieldNames = new UniqueSet<string>();
    shape.fields.forEach((field) => {
      if (fieldNames.has(field.name)) {
        throw new Error(`Struct type ${typeId} has duplicate field name: ${field.name}`);
      }
      fieldNames.add(field.name);
    });
    const fieldCodecs = new Dict<string, TypeCodec>();
    shape.fields.forEach((field) => {
      const fieldTypeDef = this.get(field.typeId);
      if (!fieldTypeDef) {
        throw new Error(`Struct type ${typeId} has field ${field.name} with unknown type: ${field.typeId}`);
      }
      fieldCodecs.set(field.name, fieldTypeDef.codec);
    });
    const structDef = existing as StructTypeDef;
    const indexedFields = toStructFieldDefs(typeId, shape.fields, List.empty<StructFieldDef>());
    structDef.fields = indexedFields;
    structDef.fieldIndexByName = buildFieldIndexByName(indexedFields);
    structDef.codec = new StructCodec(fieldCodecs);
    if (shape.nominal !== undefined) structDef.nominal = shape.nominal;
    if (shape.fieldGetter) structDef.fieldGetter = shape.fieldGetter;
    if (shape.fieldSetter) structDef.fieldSetter = shape.fieldSetter;
    if (shape.snapshotNative) structDef.snapshotNative = shape.snapshotNative;
    if (shape.exists) structDef.exists = shape.exists;
    if (shape.methods) structDef.methods = shape.methods;
  }

  addStructMethods(typeId: TypeId, methods: List<StructMethodDecl>): void {
    const typeDef = this.get(typeId);
    if (!typeDef) {
      throw new Error(`Type ${typeId} not found`);
    }
    if (typeDef.coreType !== NativeType.Struct) {
      throw new Error(`Type ${typeId} is not a struct type`);
    }
    const structDef = typeDef as StructTypeDef;
    const existing = structDef.methods ?? List.empty<StructMethodDecl>();
    structDef.methods = existing.concat(methods);
  }

  addStructFields(typeId: TypeId, fields: List<StructFieldInput>, fieldGetter?: StructFieldGetterFn): void {
    const typeDef = this.get(typeId);
    if (!typeDef) {
      throw new Error(`Type ${typeId} not found`);
    }
    if (typeDef.coreType !== NativeType.Struct) {
      throw new Error(`Type ${typeId} is not a struct type`);
    }
    const structDef = typeDef as StructTypeDef;

    const existingNames = new UniqueSet<string>();
    structDef.fields.forEach((f) => {
      existingNames.add(f.name);
    });

    const fieldCodecs = new Dict<string, TypeCodec>();
    structDef.fields.forEach((f) => {
      const ft = this.get(f.typeId);
      if (ft) fieldCodecs.set(f.name, ft.codec);
    });

    fields.forEach((field) => {
      if (existingNames.has(field.name)) {
        throw new Error(`Struct type ${typeId} already has field: ${field.name}`);
      }
      const fieldTypeDef = this.get(field.typeId);
      if (!fieldTypeDef) {
        throw new Error(`Struct type ${typeId} field ${field.name} has unknown type: ${field.typeId}`);
      }
      existingNames.add(field.name);
      fieldCodecs.set(field.name, fieldTypeDef.codec);
    });

    structDef.fields = structDef.fields.concat(toStructFieldDefs(typeId, fields, structDef.fields));
    structDef.fieldIndexByName = buildFieldIndexByName(structDef.fields);
    structDef.codec = new StructCodec(fieldCodecs);

    if (fieldGetter) {
      const existing = structDef.fieldGetter;
      structDef.fieldGetter = existing
        ? (source, fieldId, ctx) => fieldGetter(source, fieldId, ctx) ?? existing(source, fieldId, ctx)
        : fieldGetter;
    }
  }

  addAnyType(name: string, atomId?: number): TypeId {
    this.validateTypeName(name);
    this.validateAtomId(atomId, name);
    const typeId = mkTypeId(NativeType.Any, name);
    this.validateTypeNotRegistered(typeId);
    this.add({
      coreType: NativeType.Any,
      typeId,
      codec: new AnyCodec(),
      name,
      atomId,
    });
    return typeId;
  }

  addFunctionType(name: string, atomId?: number): TypeId {
    this.validateTypeName(name);
    this.validateAtomId(atomId, name);
    const typeId = mkTypeId(NativeType.Function, name);
    this.validateTypeNotRegistered(typeId);
    this.add({
      coreType: NativeType.Function,
      typeId,
      codec: new FunctionCodec(),
      name,
      atomId,
    });
    return typeId;
  }

  addNullableType(baseTypeId: TypeId): TypeId {
    const baseDef = this.get(baseTypeId);
    if (!baseDef) {
      throw new Error(`${baseTypeId} is not a registered type`);
    }
    if (baseDef.nullable) {
      return baseTypeId;
    }
    const nullableName = mkNullableTypeName(baseDef.name);
    const typeId = mkTypeId(baseDef.coreType, nullableName);
    if (this.defs.has(typeId)) {
      return typeId;
    }
    const nullableDef: NullableTypeDef = {
      coreType: baseDef.coreType,
      typeId,
      codec: new NullableCodec(baseDef.codec),
      name: nullableName,
      nullable: true,
      baseTypeId,
      autoInstantiated: baseDef.autoInstantiated,
    };
    this.add(nullableDef);
    return typeId;
  }

  registerConstructor(ctor: TypeConstructor): void {
    if (this.constructors.has(ctor.name)) {
      throw new Error(`Type constructor '${ctor.name}' is already registered`);
    }
    this.constructors.set(ctor.name, ctor);
  }

  instantiate(constructorName: string, args: List<TypeId>): TypeId {
    const ctor = this.constructors.get(constructorName);
    if (!ctor) {
      throw new Error(`Unknown type constructor: ${constructorName}`);
    }
    if (args.size() !== ctor.arity) {
      throw new Error(
        `Type constructor '${constructorName}' expects ${SU.toString(ctor.arity)} argument(s), got ${SU.toString(args.size())}`
      );
    }
    const constructedName = mkConstructedTypeName(constructorName, args);
    const typeId = mkTypeId(ctor.coreType, constructedName);
    if (this.defs.has(typeId)) {
      return typeId;
    }
    const def = ctor.construct(this, args);
    def.typeId = typeId;
    def.name = constructedName;
    def.autoInstantiated = true;
    this.add(def);
    return typeId;
  }

  getOrCreateFunctionType(shape: FunctionTypeShape): TypeId {
    const canonicalName = mkFunctionTypeName(shape.paramTypeIds, shape.returnTypeId);
    const typeId = mkTypeId(NativeType.Function, canonicalName);
    if (this.defs.has(typeId)) {
      return typeId;
    }
    const fnDef: FunctionTypeDef = {
      coreType: NativeType.Function,
      typeId,
      codec: new FunctionCodec(),
      name: canonicalName,
      autoInstantiated: true,
      paramTypeIds: shape.paramTypeIds,
      returnTypeId: shape.returnTypeId,
    };
    this.add(fnDef);
    return typeId;
  }

  getOrCreateUnionType(memberTypeIds: List<TypeId>): TypeId {
    const expanded = new List<string>();
    memberTypeIds.forEach((mid) => {
      const def = this.get(mid);
      if (!def) {
        throw new Error(`${mid} is not a registered type`);
      }
      if (def.coreType === NativeType.Union) {
        (def as UnionTypeDef).memberTypeIds.forEach((inner) => {
          expanded.push(inner);
        });
      } else if (def.nullable) {
        expanded.push((def as NullableTypeDef).baseTypeId);
        expanded.push(CoreTypeIds.Nil);
      } else {
        expanded.push(mid);
      }
    });

    const deduped = new UniqueSet<string>();
    expanded.forEach((id) => {
      deduped.add(id);
    });
    const sorted = List.from(deduped.toArray().sort());

    if (sorted.size() === 0) {
      throw new Error("Cannot create union type with zero members");
    }
    if (sorted.size() === 1) {
      return sorted.get(0)! as TypeId;
    }

    let hasNil = false;
    sorted.forEach((id) => {
      if (id === CoreTypeIds.Nil) {
        hasNil = true;
      }
    });
    // A two-member union where one member is Nil is canonicalized as a nullable
    // type (T?) rather than a full Union.
    if (sorted.size() === 2 && hasNil) {
      const first = sorted.get(0)!;
      const second = sorted.get(1)!;
      const otherTypeId = first === CoreTypeIds.Nil ? second : first;
      return this.addNullableType(otherTypeId as TypeId);
    }

    const name = mkUnionTypeName(sorted);
    const typeId = mkTypeId(NativeType.Union, name);
    if (this.defs.has(typeId)) {
      return typeId;
    }

    const memberDefsList = new List<TypeDef>();
    const memberCodecsList = new List<TypeCodec>();
    const sortedTypeIds = new List<TypeId>();
    sorted.forEach((id) => {
      const def = this.get(id as TypeId);
      if (!def) {
        throw new Error(`${id} is not a registered type`);
      }
      memberDefsList.push(def);
      memberCodecsList.push(def.codec);
      sortedTypeIds.push(id as TypeId);
    });

    const unionDef: UnionTypeDef = {
      coreType: NativeType.Union,
      typeId,
      codec: new UnionCodec(sortedTypeIds, memberDefsList, memberCodecsList),
      name,
      autoInstantiated: true,
      memberTypeIds: sortedTypeIds,
    };
    this.add(unionDef);
    return typeId;
  }

  get(id: TypeId): TypeDef | undefined {
    return this.defs.get(id);
  }

  resolveByName(name: string): TypeId | undefined {
    const direct = this.nameToId.get(name);
    if (direct !== undefined) return direct;
    return this.aliasToId.get(name);
  }

  addTypeNameAlias(alias: string, typeId: TypeId): void {
    this.validateTypeName(alias);
    this.aliasToId.set(alias, typeId);
  }

  resolveByAtomId(atomId: number): TypeId | undefined {
    return this.atomToId.get(atomId);
  }

  entries(): Iterable<[TypeId, TypeDef]> {
    return this.defs.entries().toArray();
  }

  removeUserTypes(projectNamespace?: string): void {
    // A namespaced user-type name carries `<namespace>:/` -- either as its own
    // binding-keyed prefix or embedded in a derived structural name that
    // references the namespace's types.
    const namespaceMarker = projectNamespace === undefined ? undefined : `${projectNamespace}:/`;
    const toRemove = new List<TypeId>();
    this.defs.forEach((def) => {
      if (def.coreType !== NativeType.Struct && def.coreType !== NativeType.Enum) return;
      if (SU.indexOf(def.name, "::") < 0) return;
      if (namespaceMarker !== undefined && SU.indexOf(def.name, namespaceMarker) < 0) return;
      toRemove.push(def.typeId);
    });
    toRemove.forEach((typeId) => {
      const def = this.defs.get(typeId);
      if (def?.coreType === NativeType.Enum) {
        this.unregisterEnumArtifacts(typeId);
      }
      if (def) {
        this.nameToId.delete(def.name);
      }
      this.defs.delete(typeId);
    });
    if (toRemove.size() > 0) {
      // Aliases follow their aliased type: an alias whose target was removed
      // resolves to nothing and is dropped.
      const deadAliases = new List<string>();
      this.aliasToId.forEach((typeId, alias) => {
        if (!this.defs.has(typeId)) {
          deadAliases.push(alias);
        }
      });
      deadAliases.forEach((alias) => {
        this.aliasToId.delete(alias);
      });
      this.compatCache = new Dict<string, boolean>();
    }
  }

  isStructurallyCompatible(sourceTypeId: TypeId, targetTypeId: TypeId): boolean {
    if (sourceTypeId === targetTypeId) return true;

    const cacheKey = `${sourceTypeId}|${targetTypeId}`;
    const cached = this.compatCache.get(cacheKey);
    if (cached !== undefined) return cached;

    const result = this.checkStructurallyCompatible(sourceTypeId, targetTypeId);
    this.compatCache.set(cacheKey, result);
    return result;
  }

  private checkStructurallyCompatible(sourceTypeId: TypeId, targetTypeId: TypeId): boolean {
    let sourceDef = this.get(sourceTypeId);
    let targetDef = this.get(targetTypeId);
    if (!sourceDef || !targetDef) return false;
    if (sourceDef.coreType !== NativeType.Struct || targetDef.coreType !== NativeType.Struct) return false;

    if (sourceDef.nullable) {
      sourceDef = this.get((sourceDef as NullableTypeDef).baseTypeId);
      if (!sourceDef) return false;
    }
    if (targetDef.nullable) {
      targetDef = this.get((targetDef as NullableTypeDef).baseTypeId);
      if (!targetDef) return false;
    }

    const sourceStruct = sourceDef as StructTypeDef;
    const targetStruct = targetDef as StructTypeDef;

    if (sourceStruct.nominal || targetStruct.nominal) return false;

    // Target-subset rule: every field the target declares must exist in the source
    // with a compatible type. The source may have additional fields; that is allowed.
    let compatible = true;
    targetStruct.fields.forEach((targetField) => {
      if (!compatible) return;
      const sourceFieldIndex = sourceStruct.fieldIndexByName.get(targetField.name);
      if (sourceFieldIndex === undefined) {
        compatible = false;
        return;
      }
      const sourceField = sourceStruct.fields.at(sourceFieldIndex);
      if (!sourceField) {
        compatible = false;
        return;
      }
      if (sourceField.typeId !== targetField.typeId) {
        if (!this.isStructurallyCompatible(sourceField.typeId, targetField.typeId)) {
          compatible = false;
        }
      }
    });

    return compatible;
  }
}

// ----------------------------------------------------
// Register core types

/** Register the built-in core types (`Void`, `Nil`, `Boolean`, `Number`, `String`, `Buffer`, `Any`, `Function`, list/map constructors) on `services.runtime.types`. */
export function registerCoreTypes(services: BrainServices) {
  const typeRegistry = services.runtime.types;
  typeRegistry.addVoidType(CoreTypeNames.Void, CoreTypeAtomId.Void);
  typeRegistry.addNilType(CoreTypeNames.Nil, CoreTypeAtomId.Nil);
  typeRegistry.addBooleanType(CoreTypeNames.Boolean, CoreTypeAtomId.Boolean);
  typeRegistry.addNumberType(CoreTypeNames.Number, CoreTypeAtomId.Number);
  typeRegistry.addStringType(CoreTypeNames.String, CoreTypeAtomId.String);
  typeRegistry.addBufferType(CoreTypeNames.Buffer, CoreTypeAtomId.Buffer);
  typeRegistry.addAnyType(CoreTypeNames.Any, CoreTypeAtomId.Any);
  typeRegistry.addFunctionType(CoreTypeNames.Function, CoreTypeAtomId.Function);
  typeRegistry.addListType("AnyList", {
    elementTypeId: mkTypeId(NativeType.Any, CoreTypeNames.Any),
    atomId: CoreTypeAtomId.AnyList,
  });
  typeRegistry.registerConstructor(new ListConstructor());
  typeRegistry.registerConstructor(new MapConstructor());
}

// ----------------------------------------------------
// Codecs

class VoidCodec implements TypeCodec {
  stringify(value: undefined): string {
    return "void";
  }
}

class NilCodec implements TypeCodec {
  stringify(value: undefined): string {
    return "nil";
  }
}

class BooleanCodec implements TypeCodec {
  stringify(value: boolean): string {
    return SU.toString(value);
  }
}

class NumberCodec implements TypeCodec {
  stringify(value: number): string {
    return SU.toString(value);
  }
}

class StringCodec implements TypeCodec {
  stringify(value: string): string {
    return value;
  }
}

class BufferCodec implements TypeCodec {
  stringify(value: unknown): string {
    return isBufferValue(value as Value) ? bufferToHex(value as BufferValue) : "buffer";
  }
}

class AnyCodec implements TypeCodec {
  stringify(value: unknown): string {
    if (value === undefined) {
      return "nil";
    }
    if (TypeUtils.isBoolean(value)) {
      return SU.toString(value);
    }
    if (TypeUtils.isNumber(value)) {
      return SU.toString(value);
    }
    if (TypeUtils.isString(value)) {
      return value;
    }
    return "unknown";
  }
}

class FunctionCodec implements TypeCodec {
  stringify(value: unknown): string {
    if (value !== undefined) {
      const v = value as { funcId?: number };
      if (v.funcId !== undefined) {
        return `<function:${SU.toString(v.funcId)}>`;
      }
    }
    return "<function>";
  }
}

class EnumCodec implements TypeCodec {
  constructor(private readonly symbols: List<EnumSymbolDef>) {}
  stringify(value: string): string {
    const symbol = findEnumSymbol(this.symbols, value);
    if (!symbol) {
      return value;
    }
    return stringifyEnumPrimitiveValue(symbol.value);
  }
}

function normalizeEnumSymbols(typeId: TypeId, rawSymbols: List<EnumSymbolDef>): List<EnumSymbolDef> {
  const keySet = new UniqueSet<string>();
  const symbols = new List<EnumSymbolDef>();
  let expectedValueType: NativeType.String | NativeType.Number | undefined;

  rawSymbols.forEach((rawSymbol) => {
    if (keySet.has(rawSymbol.key)) {
      throw new Error(`Enum type ${typeId} has duplicate key: ${rawSymbol.key}`);
    }
    keySet.add(rawSymbol.key);

    const valueType = enumPrimitiveType(typeId, rawSymbol.key, rawSymbol.value);
    if (expectedValueType === undefined) {
      expectedValueType = valueType;
    } else if (expectedValueType !== valueType) {
      throw new Error(`Enum type ${typeId} mixes string and number values`);
    }

    symbols.push({
      key: rawSymbol.key,
      label: rawSymbol.label,
      value: rawSymbol.value,
      deprecated: rawSymbol.deprecated,
    });
  });

  return symbols;
}

function resolveEnumDefaultKey(
  typeId: TypeId,
  symbols: List<EnumSymbolDef>,
  defaultKey: string | undefined
): string | undefined {
  if (symbols.size() === 0) {
    if (defaultKey !== undefined) {
      throw new Error(`Enum type ${typeId} cannot specify defaultKey without symbols`);
    }
    return undefined;
  }

  if (defaultKey === undefined) {
    throw new Error(`Enum type ${typeId} requires defaultKey`);
  }

  if (!symbols.find((symbol) => symbol.key === defaultKey)) {
    throw new Error(`Enum type ${typeId} has invalid defaultKey: ${defaultKey}`);
  }

  return defaultKey;
}

function enumPrimitiveType(typeId: TypeId, key: string, value: unknown): NativeType.String | NativeType.Number {
  if (TypeUtils.isString(value)) {
    return NativeType.String;
  }
  if (TypeUtils.isNumber(value)) {
    return NativeType.Number;
  }
  throw new Error(`Enum type ${typeId} has unsupported value for key ${key}`);
}

function findEnumSymbol(symbols: List<EnumSymbolDef>, key: string): EnumSymbolDef | undefined {
  return symbols.find((symbol) => symbol.key === key);
}

function stringifyEnumPrimitiveValue(value: EnumPrimitiveValue): string {
  if (TypeUtils.isString(value)) {
    return value;
  }
  return SU.toString(value);
}

class ListCodec implements TypeCodec {
  constructor(private elementCodec: TypeCodec) {}
  stringify(value: List<unknown>): string {
    const elementCodec = this.elementCodec;
    const items: string[] = [];
    value.forEach((item) => {
      items.push(elementCodec.stringify(item));
    });
    return `[${items.join(", ")}]`;
  }
}

class MapCodec implements TypeCodec {
  constructor(private valueCodec: TypeCodec) {}
  stringify(value: Dict<string, unknown>): string {
    const valueCodec = this.valueCodec;
    const items: string[] = [];
    const keys = value.keys().sort();
    keys.forEach((key) => {
      const v = value.get(key);
      items.push(`{"${key}": "${valueCodec.stringify(v)}"}`);
    });
    return `{${items.join(", ")}}`;
  }
}

class StructCodec implements TypeCodec {
  constructor(private fieldCodecs: Dict<string, TypeCodec>) {}
  stringify(value: Dict<string, unknown>): string {
    const fieldCodecs = this.fieldCodecs;
    const items: string[] = [];
    const fieldNames = fieldCodecs.keys().sort();
    fieldNames.forEach((fieldName) => {
      const codec = fieldCodecs.get(fieldName)!;
      const v = value.get(fieldName);
      items.push(`{"${fieldName}": "${codec.stringify(v)}"}`);
    });
    return `{${items.join(", ")}}`;
  }
}

class NullableCodec implements TypeCodec {
  constructor(private baseCodec: TypeCodec) {}
  stringify(value: unknown): string {
    if (value === undefined) {
      return "nil";
    }
    return this.baseCodec.stringify(value);
  }
}

class UnionCodec implements TypeCodec {
  private memberDefs: List<TypeDef>;
  private memberCodecs: List<TypeCodec>;

  constructor(_memberTypeIds: List<TypeId>, memberDefs: List<TypeDef>, memberCodecs: List<TypeCodec>) {
    this.memberDefs = memberDefs;
    this.memberCodecs = memberCodecs;
  }

  private findMemberIndex(value: unknown): number {
    if (value === undefined) {
      for (let i = 0; i < this.memberDefs.size(); i++) {
        if (this.memberDefs.get(i)!.coreType === NativeType.Nil) {
          return i;
        }
      }
      return -1;
    }
    if (TypeUtils.isBoolean(value)) {
      for (let i = 0; i < this.memberDefs.size(); i++) {
        if (this.memberDefs.get(i)!.coreType === NativeType.Boolean) {
          return i;
        }
      }
      return -1;
    }
    if (TypeUtils.isNumber(value)) {
      for (let i = 0; i < this.memberDefs.size(); i++) {
        if (this.memberDefs.get(i)!.coreType === NativeType.Number) {
          return i;
        }
      }
      return -1;
    }
    if (TypeUtils.isString(value)) {
      for (let i = 0; i < this.memberDefs.size(); i++) {
        if (this.memberDefs.get(i)!.coreType === NativeType.String) {
          return i;
        }
      }
      return -1;
    }
    return -1;
  }

  stringify(value: unknown): string {
    const idx = this.findMemberIndex(value);
    if (idx < 0) {
      return "unknown";
    }
    return this.memberCodecs.get(idx)!.stringify(value);
  }
}

// ----------------------------------------------------
// Type constructors

class ListConstructor implements TypeConstructor {
  name = "List";
  arity = 1;
  coreType = NativeType.List;
  construct(registry: ITypeRegistry, args: List<TypeId>): TypeDef {
    const elementTypeId = args.get(0)!;
    const elementDef = registry.get(elementTypeId);
    if (!elementDef) {
      throw new Error(`${elementTypeId} is not a registered type`);
    }
    const def: ListTypeDef = {
      coreType: NativeType.List,
      typeId: "" as TypeId,
      codec: new ListCodec(elementDef.codec),
      name: "",
      elementTypeId,
    };
    return def;
  }
}

class MapConstructor implements TypeConstructor {
  name = "Map";
  arity = 2;
  coreType = NativeType.Map;
  construct(registry: ITypeRegistry, args: List<TypeId>): TypeDef {
    const keyTypeId = args.get(0)!;
    const valueTypeId = args.get(1)!;
    const keyDef = registry.get(keyTypeId);
    if (!keyDef) {
      throw new Error(`${keyTypeId} is not a registered type`);
    }
    const valueDef = registry.get(valueTypeId);
    if (!valueDef) {
      throw new Error(`${valueTypeId} is not a registered type`);
    }
    const def: MapTypeDef = {
      coreType: NativeType.Map,
      typeId: "" as TypeId,
      codec: new MapCodec(valueDef.codec),
      name: "",
      keyTypeId,
      valueTypeId,
    };
    return def;
  }
}
