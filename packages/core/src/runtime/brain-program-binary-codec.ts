import { Dict } from "../platform/dict";
import { Error } from "../platform/error";
import { List } from "../platform/list";
import { MathOps } from "../platform/math";
import type { IByteArray } from "../platform/stream";
import { MemoryStream } from "../platform/stream";
import { StringUtils } from "../platform/string";
import { TypeUtils } from "../platform/types";
import type { UniqueSet } from "../platform/uniqueset";
import {
  type BrainProgramConstantPoolsJson,
  type BrainProgramExecutableActionJson,
  type BrainProgramFunctionBytecodeJson,
  type BrainProgramInstructionJson,
  type BrainProgramJson,
  type BrainProgramJsonObject,
  type BrainProgramRuleAncestorJsonEntry,
  type BrainProgramSystemRegistrationJson,
  type BrainProgramTypeEntryJson,
  type LinkedBrainProgramActionCallSiteJsonEntry,
  type LinkedBrainProgramJson,
  type LinkedBrainProgramPageMetadataJson,
  linkedBrainProgramFromJson,
} from "./brain-program-codec";
import { type Instr, instrOperandMismatch, OPERAND_SCHEMA, type OperandSpec } from "./bytecode";
import type { BytecodeExecutableAction } from "./context";
import { CoreTypeNames, mkTypeId } from "./core-types";
import type { ActionCallSiteEntry, LinkedBrainProgram, PageMetadata } from "./host-bindings";
import type { Program, ProgramTypeEntry, SystemRegistration } from "./program";
import { NO_VARIABLE_INIT, variableInitAt } from "./program";
import { WENDOO_BINARY_PROGRAM_IMAGE_MAGIC } from "./program-image";
import { type EnumTypeDef, type ITypeRegistry, NativeType, type TypeId } from "./type-defs";
import type { Value } from "./value";

/**
 * Target numeric precision the binary `.mcprogram` is built for. Constant
 * literals are rounded to this precision before encoding (`f32` via
 * {@link MathOps.fround}; `f64` is identity); an `f32` decoder rejects an `f64`
 * numeric entry.
 */
export type NumberPrecision = "f32" | "f64";

/** Options controlling {@link linkedBrainProgramToBytes}. */
export interface LinkedBrainProgramToBytesOptions {
  /** Numeric device-profile id written verbatim into the binary envelope header. */
  readonly profileId: number;

  /** Target numeric precision; constant numbers are rounded to it before encoding. */
  readonly precision: NumberPrecision;

  /**
   * Type registry used to resolve symbol ordinals for enum constant values of
   * atom (core/target) enum types. Required only when the program carries such
   * a constant; program-local enum ordinals resolve through the type table.
   */
  readonly typeRegistry?: ITypeRegistry;
}

/** Options controlling {@link linkedBrainProgramFromBytes}. */
export interface LinkedBrainProgramFromBytesOptions {
  /**
   * Target numeric precision of the decoding device. An `f32` reader rejects an
   * `f64` numeric entry (CNUM discriminant `2`) with a stable diagnostic.
   */
  readonly precision: NumberPrecision;

  /**
   * Maximum supported envelope/format version. A binary whose format version
   * exceeds this is rejected. Defaults to {@link BINARY_PROGRAM_FORMAT_VERSION}.
   */
  readonly maxFormatVersion?: number;

  /**
   * Type registry of the decoding runtime. Atom entries in the TYPS section
   * resolve their typeId through it, and enum constant values of atom enum
   * types resolve their symbol key through it.
   */
  readonly typeRegistry: ITypeRegistry;
}

/** Decoded binary `.mcprogram` envelope. */
export interface LinkedBrainProgramFromBytesResult {
  /** Numeric device-profile id read from the binary envelope header. */
  readonly profileId: number;

  /** Linked brain program hydrated from the binary payload. */
  readonly program: LinkedBrainProgram;
}

/** Stable machine-readable diagnostic codes for binary `.mcprogram` decode/encode failures. */
export const BrainProgramBinaryCodecErrorCode = {
  /** The leading bytes are not the binary `.mcprogram` magic. */
  INVALID_MAGIC: "WENDOO_BINARY_CODEC_INVALID_MAGIC",
  /** The envelope format version exceeds the reader's maximum. */
  UNSUPPORTED_FORMAT_VERSION: "WENDOO_BINARY_CODEC_UNSUPPORTED_FORMAT_VERSION",
  /** An f64 numeric entry was found while decoding for an f32 target. */
  F64_ON_F32_TARGET: "WENDOO_BINARY_CODEC_F64_ON_F32_TARGET",
  /** A CNUM discriminant byte is not one of `0`/`1`/`2`. */
  INVALID_NUMBER_DISCRIMINANT: "WENDOO_BINARY_CODEC_INVALID_NUMBER_DISCRIMINANT",
  /** A value tag byte is not a serializable {@link NativeType}. */
  INVALID_VALUE_TAG: "WENDOO_BINARY_CODEC_INVALID_VALUE_TAG",
  /** A runtime-only or native-backed value was passed to the encoder. */
  UNENCODABLE_VALUE: "WENDOO_BINARY_CODEC_UNENCODABLE_VALUE",
  /** An opcode byte has no operand-schema entry. */
  UNKNOWN_OPCODE: "WENDOO_BINARY_CODEC_UNKNOWN_OPCODE",
  /** An instruction's operands do not match its opcode's operand schema. */
  INSTRUCTION_SCHEMA_MISMATCH: "WENDOO_BINARY_CODEC_INSTRUCTION_SCHEMA_MISMATCH",
  /** A profile id outside the unsigned 32-bit range was supplied to the encoder. */
  INVALID_PROFILE_ID: "WENDOO_BINARY_CODEC_INVALID_PROFILE_ID",
  /** A TYPS entry tag byte is not a known type-entry tag. */
  INVALID_TYPE_ENTRY_TAG: "WENDOO_BINARY_CODEC_INVALID_TYPE_ENTRY_TAG",
  /** A TYPS entry references a child at or beyond its own index. */
  TYPE_FORWARD_REFERENCE: "WENDOO_BINARY_CODEC_TYPE_FORWARD_REFERENCE",
  /** A type-table index is outside the decoded table. */
  TYPE_INDEX_OUT_OF_RANGE: "WENDOO_BINARY_CODEC_TYPE_INDEX_OUT_OF_RANGE",
  /** An enum constant's symbol ordinal is outside its type's symbol list. */
  ENUM_ORDINAL_OUT_OF_RANGE: "WENDOO_BINARY_CODEC_ENUM_ORDINAL_OUT_OF_RANGE",
  /** A TYPS atom entry's atomId is not registered in the decoding runtime. */
  UNKNOWN_TYPE_ATOM: "WENDOO_BINARY_CODEC_UNKNOWN_TYPE_ATOM",
  /** A TYPS enum entry's value-kind byte is not `0` (number) or `1` (string). */
  INVALID_ENUM_VALUE_KIND: "WENDOO_BINARY_CODEC_INVALID_ENUM_VALUE_KIND",
} as const;

/** Union of all {@link BrainProgramBinaryCodecErrorCode} values. */
export type BrainProgramBinaryCodecErrorCode =
  (typeof BrainProgramBinaryCodecErrorCode)[keyof typeof BrainProgramBinaryCodecErrorCode];

/** Current binary `.mcprogram` envelope/format version. */
export const BINARY_PROGRAM_FORMAT_VERSION = 4;

/** The file magic identifying a binary `.mcprogram`, as a cross-platform list of bytes. */
const MAGIC = List.from(WENDOO_BINARY_PROGRAM_IMAGE_MAGIC as readonly number[]);

const I32_MIN = -2147483648;
const I32_MAX = 2147483647;

const NUMBER_DISCRIMINANT_SMALL_INT = 0;
const NUMBER_DISCRIMINANT_F32 = 1;
const NUMBER_DISCRIMINANT_F64 = 2;

const MAP_KEY_TAG_NUMBER = 0;
const MAP_KEY_TAG_STRING = 1;

const CALL_SITE_BINDING_HOST = 0;
const CALL_SITE_BINDING_BYTECODE = 1;

const TYPE_ENTRY_TAG_ATOM = 0;
const TYPE_ENTRY_TAG_LIST = 1;
const TYPE_ENTRY_TAG_MAP = 2;
const TYPE_ENTRY_TAG_UNION = 3;
const TYPE_ENTRY_TAG_FUNCTION = 4;
const TYPE_ENTRY_TAG_NULLABLE = 5;
const TYPE_ENTRY_TAG_STRUCT = 6;
const TYPE_ENTRY_TAG_ENUM = 7;

// Value-kind byte of a TYPS enum entry: the shared primitive kind of every
// symbol value the entry carries.
const ENUM_VALUE_KIND_NUMBER = 0;
const ENUM_VALUE_KIND_STRING = 1;

const ACTION_FLAG_INITIALIZER = 1;
const ACTION_FLAG_ACTIVATION = 2;
const ACTION_FLAG_DEACTIVATION = 4;

// Per-System presence flags for the optional init/think function ids.
const SYSTEM_FLAG_INIT = 1;
const SYSTEM_FLAG_THINK = 2;

// Presence-bitmask bits for the optional sections. A set bit means the
// corresponding program field is present (possibly empty); a clear bit
// hydrates `undefined`.
const PRESENCE_ACTS = 1;
const PRESENCE_RULF = 2;
const PRESENCE_RANC = 4;
const PRESENCE_SYST = 8;

function codecError(code: BrainProgramBinaryCodecErrorCode, message: string): Error {
  return new Error(`[${code}] ${message}`);
}

///////////////////////////
// String interning
///////////////////////////

/**
 * The single program-wide string table (`CSTR`). The first
 * {@link constStringCount} entries are exactly `constantPools.strings` (opcode
 * string operands index `0..N-1` unchanged); every other string reference
 * (type-table struct/enum names and enum symbol keys, page ids, variable
 * names, `String` values, and map string keys) is interned and deduped into
 * the same table, with new entries appended at `>= N`.
 */
class StringInterner {
  readonly strings = List.empty<string>();
  readonly constStringCount: number;
  private readonly index = new Dict<string, number>();

  constructor(poolStrings: List<string>) {
    for (let i = 0; i < poolStrings.size(); i++) {
      const value = poolStrings.get(i);
      const idx = this.strings.size();
      this.strings.push(value);
      if (!this.index.has(value)) {
        this.index.set(value, idx);
      }
    }
    this.constStringCount = this.strings.size();
  }

  intern(value: string): number {
    const existing = this.index.get(value);
    if (existing !== undefined) {
      return existing;
    }
    const idx = this.strings.size();
    this.strings.push(value);
    this.index.set(value, idx);
    return idx;
  }
}

function buildStringInterner(linked: LinkedBrainProgram): StringInterner {
  const program = linked.program;
  const interner = new StringInterner(program.constantPools.strings);

  const types = program.types;
  if (types !== undefined) {
    for (let i = 0; i < types.size(); i++) {
      const entry = types.get(i)!;
      if (entry.tag === "struct") {
        interner.intern(entry.name);
        for (let j = 0; j < entry.fields.size(); j++) {
          interner.intern(entry.fields.get(j)!.name);
        }
      } else if (entry.tag === "enum") {
        interner.intern(entry.name);
        for (let j = 0; j < entry.symbols.size(); j++) {
          const symbol = entry.symbols.get(j)!;
          interner.intern(symbol.key);
          if (TypeUtils.isString(symbol.value)) {
            interner.intern(symbol.value);
          }
        }
      }
    }
  }

  const values = program.constantPools.values;
  for (let i = 0; i < values.size(); i++) {
    internValueStrings(values.get(i), interner);
  }

  const variableNames = program.variableNames;
  for (let i = 0; i < variableNames.size(); i++) {
    interner.intern(variableNames.get(i));
  }

  const systems = program.systems;
  if (systems !== undefined) {
    for (let i = 0; i < systems.size(); i++) {
      interner.intern(systems.get(i).name);
    }
  }

  const pages = linked.pages;
  for (let i = 0; i < pages.size(); i++) {
    interner.intern(pages.get(i).pageId);
  }

  return interner;
}

function internValueStrings(value: Value, interner: StringInterner): void {
  if (value.t === NativeType.String) {
    interner.intern(value.v);
  } else if (value.t === NativeType.List) {
    for (let i = 0; i < value.v.size(); i++) {
      internValueStrings(value.v.get(i), interner);
    }
  } else if (value.t === NativeType.Map) {
    const entries = value.v.entries();
    for (let i = 0; i < entries.size(); i++) {
      const entry = entries.get(i);
      if (TypeUtils.isString(entry[0])) {
        interner.intern(entry[0]);
      }
      internValueStrings(entry[1], interner);
    }
  } else if (value.t === NativeType.Struct) {
    if (value.v !== undefined) {
      for (let i = 0; i < value.v.size(); i++) {
        internValueStrings(value.v.get(i), interner);
      }
    }
  } else if (value.t === NativeType.Function && value.captures !== undefined) {
    for (let i = 0; i < value.captures.size(); i++) {
      internValueStrings(value.captures.get(i), interner);
    }
  }
}

///////////////////////////
// Encode
///////////////////////////

/**
 * Serializes a linked brain program to the binary `.mcprogram` form: a 4-byte
 * magic, a 1-byte format version, the numeric profile id, a 1-byte presence
 * bitmask, then the positional sections `CSTR`, `TYPS`, `CNUM`, `CVAL`,
 * `FUNC`, `VARS`, the present optional sections (`ACTS`, `RULF`, `RANC`,
 * `SYST`), and `PAGE`. Sections carry no tags or lengths; each is
 * self-delimiting by its leading count.
 *
 * Type identity travels by type-table index: typed instruction operands,
 * `injectCtxTypeIdx`, and constant-value typeIds reference `TYPS` entries, and
 * enum constant values carry symbol ordinals. TypeId strings are never
 * written; the decoder reconstructs them.
 *
 * Drops `name`, `maxStackDepth`, `ruleIndex`, `entryPoint`, and `pageName`.
 * Numbers are rounded to the target profile precision; `handle`, `err`, and
 * native-backed struct values are rejected.
 *
 * @param program - Linked brain program to serialize.
 * @param options - Numeric profile id, target precision, and optional type registry.
 */
export function linkedBrainProgramToBytes(
  program: LinkedBrainProgram,
  options: LinkedBrainProgramToBytesOptions
): IByteArray {
  if (!isU32(options.profileId)) {
    throw codecError(
      BrainProgramBinaryCodecErrorCode.INVALID_PROFILE_ID,
      `profileId must be an unsigned 32-bit integer; got ${options.profileId}`
    );
  }

  const interner = buildStringInterner(program);
  const precision = options.precision;
  const linkedProgram = program.program;
  const types = linkedProgram.types ?? List.empty<ProgramTypeEntry>();
  const encodeTypes = buildProgramTypeIndex(types, options.typeRegistry);

  let presence = 0;
  if (linkedProgram.actions !== undefined) presence |= PRESENCE_ACTS;
  if (linkedProgram.ruleFuncIds !== undefined) presence |= PRESENCE_RULF;
  if (linkedProgram.ruleAncestors !== undefined) presence |= PRESENCE_RANC;
  if (linkedProgram.systems !== undefined) presence |= PRESENCE_SYST;

  const s = new MemoryStream();
  for (let i = 0; i < MAGIC.size(); i++) {
    s.writeRawU8(MAGIC.get(i));
  }
  s.writeRawU8(BINARY_PROGRAM_FORMAT_VERSION);
  s.writeVarUint(options.profileId);
  s.writeRawU8(presence);

  // CSTR is written first; every later section resolves string indices against it.
  writeCstrSection(s, interner);
  writeTypsSection(s, types, interner, precision);
  writeCnumSection(s, linkedProgram.constantPools.numbers, precision);
  writeCvalSection(s, linkedProgram.constantPools.values, interner, encodeTypes, precision);
  writeFuncSection(s, linkedProgram);
  writeVarsSection(s, linkedProgram, interner);
  if (linkedProgram.actions !== undefined) {
    writeActsSection(s, linkedProgram.actions);
  }
  if (linkedProgram.ruleFuncIds !== undefined) {
    writeRulfSection(s, linkedProgram.ruleFuncIds);
  }
  if (linkedProgram.ruleAncestors !== undefined) {
    writeRancSection(s, linkedProgram.ruleAncestors);
  }
  if (linkedProgram.systems !== undefined) {
    writeSystSection(s, linkedProgram.systems, interner);
  }
  writePageSection(s, program.pages, interner);
  return s.toBytes();
}

/**
 * Resolves a value's typeId string to its program type-table index, and an
 * enum value's symbol key to its ordinal. Both lookups throw on a typeId or
 * symbol the type table (or, for atom enum types, the registry) does not
 * carry.
 */
export interface ProgramTypeIndex {
  typeIdxOf(typeId: TypeId): number;
  enumOrdinalOf(typeId: TypeId, key: string): number;
}

/**
 * Builds a {@link ProgramTypeIndex} over a program's type table. The registry
 * is required only to resolve symbol ordinals of atom (core/target) enum
 * types; program-local enum entries resolve through their own symbol lists.
 *
 * @param types - The program's type table.
 * @param registry - Type registry for atom enum symbol resolution.
 */
export function buildProgramTypeIndex(
  types: List<ProgramTypeEntry>,
  registry: ITypeRegistry | undefined
): ProgramTypeIndex {
  const indexByTypeId = new Dict<string, number>();
  for (let i = 0; i < types.size(); i++) {
    indexByTypeId.set(types.get(i)!.typeId, i);
  }
  return {
    typeIdxOf(typeId: TypeId): number {
      const idx = indexByTypeId.get(typeId);
      if (idx === undefined) {
        throw codecError(
          BrainProgramBinaryCodecErrorCode.UNENCODABLE_VALUE,
          `constant value type ${typeId} is not in the program type table`
        );
      }
      return idx;
    },
    enumOrdinalOf(typeId: TypeId, key: string): number {
      const idx = indexByTypeId.get(typeId);
      const entry = idx === undefined ? undefined : types.get(idx);
      if (entry?.tag === "enum") {
        for (let i = 0; i < entry.symbols.size(); i++) {
          if (entry.symbols.get(i)!.key === key) {
            return i;
          }
        }
        throw codecError(
          BrainProgramBinaryCodecErrorCode.UNENCODABLE_VALUE,
          `enum value ${typeId}:${key} has no symbol in its type-table entry`
        );
      }
      if (entry?.tag === "atom") {
        const def = registry?.get(typeId) as EnumTypeDef | undefined;
        if (!def || def.coreType !== NativeType.Enum) {
          throw codecError(
            BrainProgramBinaryCodecErrorCode.UNENCODABLE_VALUE,
            `atom enum ${typeId} requires a type registry to resolve symbol ordinals`
          );
        }
        for (let i = 0; i < def.symbols.size(); i++) {
          if (def.symbols.get(i)!.key === key) {
            return i;
          }
        }
        throw codecError(
          BrainProgramBinaryCodecErrorCode.UNENCODABLE_VALUE,
          `enum value ${typeId}:${key} has no symbol in its registered type`
        );
      }
      throw codecError(
        BrainProgramBinaryCodecErrorCode.UNENCODABLE_VALUE,
        `enum value type ${typeId} is not an enum or atom entry in the program type table`
      );
    },
  };
}

function writeTypsSection(
  s: MemoryStream,
  types: List<ProgramTypeEntry>,
  interner: StringInterner,
  precision: NumberPrecision
): void {
  s.writeVarUint(types.size());
  for (let i = 0; i < types.size(); i++) {
    const entry = types.get(i)!;
    switch (entry.tag) {
      case "atom":
        s.writeRawU8(TYPE_ENTRY_TAG_ATOM);
        s.writeVarUint(entry.atomId);
        break;
      case "list":
        s.writeRawU8(TYPE_ENTRY_TAG_LIST);
        s.writeVarUint(entry.elem);
        break;
      case "map":
        s.writeRawU8(TYPE_ENTRY_TAG_MAP);
        s.writeVarUint(entry.key);
        s.writeVarUint(entry.value);
        break;
      case "union": {
        s.writeRawU8(TYPE_ENTRY_TAG_UNION);
        s.writeVarUint(entry.members.size());
        for (let j = 0; j < entry.members.size(); j++) {
          s.writeVarUint(entry.members.get(j)!);
        }
        break;
      }
      case "function": {
        s.writeRawU8(TYPE_ENTRY_TAG_FUNCTION);
        s.writeVarUint(entry.params.size());
        for (let j = 0; j < entry.params.size(); j++) {
          s.writeVarUint(entry.params.get(j)!);
        }
        s.writeVarUint(entry.result);
        break;
      }
      case "nullable":
        s.writeRawU8(TYPE_ENTRY_TAG_NULLABLE);
        s.writeVarUint(entry.base);
        break;
      case "struct": {
        s.writeRawU8(TYPE_ENTRY_TAG_STRUCT);
        s.writeVarUint(interner.intern(entry.name));
        // Field storage slot count; maxFieldId is -1 for a fieldless struct.
        s.writeVarUint(entry.maxFieldId + 1);
        // Field name -> id map for the dynamic computed-key opcodes.
        s.writeVarUint(entry.fields.size());
        for (let j = 0; j < entry.fields.size(); j++) {
          const field = entry.fields.get(j)!;
          s.writeVarUint(interner.intern(field.name));
          s.writeVarUint(field.fieldIndex);
        }
        break;
      }
      case "enum": {
        s.writeRawU8(TYPE_ENTRY_TAG_ENUM);
        s.writeVarUint(interner.intern(entry.name));
        s.writeVarUint(entry.symbols.size());
        if (entry.symbols.size() > 0) {
          const firstValue = entry.symbols.get(0)!.value;
          const stringValued = TypeUtils.isString(firstValue);
          s.writeRawU8(stringValued ? ENUM_VALUE_KIND_STRING : ENUM_VALUE_KIND_NUMBER);
          for (let j = 0; j < entry.symbols.size(); j++) {
            const symbol = entry.symbols.get(j)!;
            s.writeVarUint(interner.intern(symbol.key));
            if (TypeUtils.isString(symbol.value)) {
              s.writeVarUint(interner.intern(symbol.value));
            } else {
              writeNumberEntry(s, symbol.value, precision);
            }
          }
        }
        break;
      }
    }
  }
}

function writeFuncSection(s: MemoryStream, program: Program): void {
  const functions = program.functions;
  s.writeVarUint(functions.size());
  for (let i = 0; i < functions.size(); i++) {
    const fn = functions.get(i);
    s.writeVarUint(fn.numParams);
    const numLocals = fn.numLocals ?? fn.numParams;
    const extraLocals = numLocals - fn.numParams;
    if (extraLocals < 0) {
      throw codecError(
        BrainProgramBinaryCodecErrorCode.INSTRUCTION_SCHEMA_MISMATCH,
        `numLocals (${numLocals}) < numParams (${fn.numParams})`
      );
    }
    s.writeVarUint(extraLocals);
    s.writeVarUint(fn.injectCtxTypeIdx === undefined ? 0 : fn.injectCtxTypeIdx + 1);
    const code = fn.code;
    s.writeVarUint(code.size());
    for (let j = 0; j < code.size(); j++) {
      writeInstruction(s, code.get(j));
    }
  }
}

function writeInstruction(s: MemoryStream, instr: Instr): void {
  const schema = operandSchemaFor(instr.op);
  const mismatch = instrOperandMismatch(instr);
  if (mismatch !== undefined) {
    throw codecError(BrainProgramBinaryCodecErrorCode.INSTRUCTION_SCHEMA_MISMATCH, mismatch);
  }

  s.writeRawU8(instr.op);
  for (let i = 0; i < schema.size(); i++) {
    const spec = schema.get(i);
    const operand = operandAt(instr, i);
    if (spec.optional) {
      s.writeVarUint(operand === undefined ? 0 : operand + 1);
    } else if (spec.encoding === "svar") {
      s.writeVarInt(operand as number);
    } else {
      s.writeVarUint(operand as number);
    }
  }
}

function writeCnumSection(s: MemoryStream, numbers: List<number>, precision: NumberPrecision): void {
  s.writeVarUint(numbers.size());
  for (let i = 0; i < numbers.size(); i++) {
    writeNumberEntry(s, numbers.get(i), precision);
  }
}

function writeNumberEntry(s: MemoryStream, n: number, precision: NumberPrecision): void {
  const rounded = precision === "f32" ? MathOps.fround(n) : n;
  if (isSmallInt(rounded)) {
    s.writeRawU8(NUMBER_DISCRIMINANT_SMALL_INT);
    s.writeVarInt(rounded);
  } else if (precision === "f32") {
    s.writeRawU8(NUMBER_DISCRIMINANT_F32);
    s.writeRawF32(rounded);
  } else {
    s.writeRawU8(NUMBER_DISCRIMINANT_F64);
    s.writeRawF64(rounded);
  }
}

function writeCstrSection(s: MemoryStream, interner: StringInterner): void {
  s.writeVarUint(interner.strings.size());
  s.writeVarUint(interner.constStringCount);
  for (let i = 0; i < interner.strings.size(); i++) {
    s.writeVarString(interner.strings.get(i));
  }
}

function writeCvalSection(
  s: MemoryStream,
  values: List<Value>,
  interner: StringInterner,
  types: ProgramTypeIndex,
  precision: NumberPrecision
): void {
  s.writeVarUint(values.size());
  for (let i = 0; i < values.size(); i++) {
    writeValue(s, values.get(i), interner, types, precision);
  }
}

function writeValue(
  s: MemoryStream,
  value: Value,
  interner: StringInterner,
  types: ProgramTypeIndex,
  precision: NumberPrecision
): void {
  if (value.t === "handle" || value.t === "err") {
    throw codecError(
      BrainProgramBinaryCodecErrorCode.UNENCODABLE_VALUE,
      `runtime-only value '${value.t}' cannot be serialized`
    );
  }
  writeValueTag(s, value.t);
  switch (value.t) {
    case NativeType.Unknown:
    case NativeType.Void:
    case NativeType.Nil:
      return;
    case NativeType.Boolean:
      s.writeRawU8(value.v ? 1 : 0);
      return;
    case NativeType.Number:
      writeNumberEntry(s, value.v, precision);
      return;
    case NativeType.String:
      s.writeVarUint(interner.intern(value.v));
      return;
    case NativeType.Enum:
      s.writeVarUint(types.typeIdxOf(value.typeId));
      s.writeVarUint(types.enumOrdinalOf(value.typeId, value.v));
      return;
    case NativeType.List: {
      s.writeVarUint(types.typeIdxOf(value.typeId));
      s.writeVarUint(value.v.size());
      for (let i = 0; i < value.v.size(); i++) {
        writeValue(s, value.v.get(i), interner, types, precision);
      }
      return;
    }
    case NativeType.Map: {
      s.writeVarUint(types.typeIdxOf(value.typeId));
      const entries = value.v.entries();
      s.writeVarUint(entries.size());
      for (let i = 0; i < entries.size(); i++) {
        const entry = entries.get(i);
        const key = entry[0];
        if (TypeUtils.isNumber(key)) {
          s.writeRawU8(MAP_KEY_TAG_NUMBER);
          writeNumberEntry(s, key, precision);
        } else {
          s.writeRawU8(MAP_KEY_TAG_STRING);
          s.writeVarUint(interner.intern(key));
        }
        writeValue(s, entry[1], interner, types, precision);
      }
      return;
    }
    case NativeType.Struct: {
      if (value.native !== undefined) {
        throw codecError(
          BrainProgramBinaryCodecErrorCode.UNENCODABLE_VALUE,
          "native-backed struct values cannot be serialized"
        );
      }
      s.writeVarUint(types.typeIdxOf(value.typeId));
      const fields = value.v;
      const fieldCount = fields === undefined ? 0 : fields.size();
      s.writeVarUint(fieldCount);
      if (fields !== undefined) {
        for (let i = 0; i < fields.size(); i++) {
          writeValue(s, fields.get(i), interner, types, precision);
        }
      }
      return;
    }
    case NativeType.Function: {
      s.writeVarUint(value.funcId);
      if (value.captures === undefined) {
        s.writeVarUint(0);
      } else {
        s.writeVarUint(value.captures.size() + 1);
        for (let i = 0; i < value.captures.size(); i++) {
          writeValue(s, value.captures.get(i), interner, types, precision);
        }
      }
      return;
    }
    case NativeType.Buffer: {
      const latin1 = value.v.toStringLatin1();
      const count = value.v.length();
      s.writeVarUint(count);
      for (let i = 0; i < count; i++) {
        s.writeRawU8(StringUtils.charCodeAt(latin1, i) & 0xff);
      }
      return;
    }
    default:
      // Unreachable: Any/Union are type tags, never runtime values.
      throw codecError(BrainProgramBinaryCodecErrorCode.UNENCODABLE_VALUE, "value is not a serializable NativeType");
  }
}

/**
 * Writes the slot count, then per slot the name's string index and the
 * starting value's `CVAL` index biased by one, with `0` for a slot that starts
 * unwritten.
 */
function writeVarsSection(s: MemoryStream, program: Program, interner: StringInterner): void {
  const variableNames = program.variableNames;
  s.writeVarUint(variableNames.size());
  for (let i = 0; i < variableNames.size(); i++) {
    s.writeVarUint(interner.intern(variableNames.get(i)));
    const init = variableInitAt(program, i);
    s.writeVarUint(init === NO_VARIABLE_INIT ? 0 : init + 1);
  }
}

function writeActsSection(s: MemoryStream, actions: List<BytecodeExecutableAction>): void {
  s.writeVarUint(actions.size());
  for (let i = 0; i < actions.size(); i++) {
    const action = actions.get(i);
    let flags = 0;
    if (action.initializerFuncId !== undefined) flags |= ACTION_FLAG_INITIALIZER;
    if (action.activationFuncId !== undefined) flags |= ACTION_FLAG_ACTIVATION;
    if (action.deactivationFuncId !== undefined) flags |= ACTION_FLAG_DEACTIVATION;
    s.writeRawU8(flags);
    s.writeVarUint(action.entryFuncId);
    if (action.initializerFuncId !== undefined) s.writeVarUint(action.initializerFuncId);
    if (action.activationFuncId !== undefined) s.writeVarUint(action.activationFuncId);
    if (action.deactivationFuncId !== undefined) s.writeVarUint(action.deactivationFuncId);
  }
}

function writeRulfSection(s: MemoryStream, ruleFuncIds: UniqueSet<number>): void {
  const ids = ruleFuncIds.toArray();
  s.writeVarUint(ruleFuncIds.size());
  for (let i = 0; i < ruleFuncIds.size(); i++) {
    s.writeVarUint(ids[i]);
  }
}

function writeRancSection(s: MemoryStream, ruleAncestors: Dict<number, number>): void {
  const entries = ruleAncestors.entries();
  s.writeVarUint(entries.size());
  for (let i = 0; i < entries.size(); i++) {
    const entry = entries.get(i);
    s.writeVarUint(entry[0]);
    s.writeVarUint(entry[1]);
  }
}

function writeSystSection(s: MemoryStream, systems: List<SystemRegistration>, interner: StringInterner): void {
  s.writeVarUint(systems.size());
  for (let i = 0; i < systems.size(); i++) {
    const system = systems.get(i);
    let flags = 0;
    if (system.initFuncId !== undefined) flags |= SYSTEM_FLAG_INIT;
    if (system.thinkFuncId !== undefined) flags |= SYSTEM_FLAG_THINK;
    s.writeRawU8(flags);
    s.writeVarUint(interner.intern(system.name));
    s.writeVarUint(system.storeSlot);
    if (system.initFuncId !== undefined) s.writeVarUint(system.initFuncId);
    if (system.thinkFuncId !== undefined) s.writeVarUint(system.thinkFuncId);
  }
}

function writePageSection(s: MemoryStream, pages: List<PageMetadata>, interner: StringInterner): void {
  s.writeVarUint(pages.size());
  for (let i = 0; i < pages.size(); i++) {
    const page = pages.get(i);
    s.writeVarUint(page.pageIndex);
    s.writeVarUint(interner.intern(page.pageId));

    const roots = page.rootRuleFuncIds;
    s.writeVarUint(roots.size());
    for (let r = 0; r < roots.size(); r++) {
      s.writeVarUint(roots.get(r));
    }

    const callSites = page.actionCallSites;
    s.writeVarUint(callSites.size());
    for (let c = 0; c < callSites.size(); c++) {
      writeActionCallSite(s, callSites.get(c));
    }
  }
}

function writeActionCallSite(s: MemoryStream, callSite: ActionCallSiteEntry): void {
  if (callSite.binding === "host") {
    s.writeRawU8(CALL_SITE_BINDING_HOST);
    s.writeVarUint(callSite.callSiteId);
    s.writeVarUint(callSite.actionId);
  } else {
    s.writeRawU8(CALL_SITE_BINDING_BYTECODE);
    s.writeVarUint(callSite.callSiteId);
    s.writeVarUint(callSite.actionSlot);
  }
}

///////////////////////////
// Decode
///////////////////////////

/**
 * Deserializes a binary `.mcprogram` produced by {@link linkedBrainProgramToBytes}
 * back into a linked brain program plus its numeric profile id.
 *
 * @param bytes - Binary `.mcprogram` payload.
 * @param options - Target precision and optional max format version.
 */
export function linkedBrainProgramFromBytes(
  bytes: IByteArray,
  options: LinkedBrainProgramFromBytesOptions
): LinkedBrainProgramFromBytesResult {
  const precision = options.precision;
  const maxFormatVersion = options.maxFormatVersion ?? BINARY_PROGRAM_FORMAT_VERSION;
  const s = new MemoryStream(bytes);

  for (let i = 0; i < MAGIC.size(); i++) {
    if (s.readRawU8() !== MAGIC.get(i)) {
      throw codecError(BrainProgramBinaryCodecErrorCode.INVALID_MAGIC, "not a binary .mcprogram (bad magic)");
    }
  }

  const formatVersion = s.readRawU8();
  if (formatVersion > maxFormatVersion) {
    throw codecError(
      BrainProgramBinaryCodecErrorCode.UNSUPPORTED_FORMAT_VERSION,
      `format version ${formatVersion} exceeds reader max ${maxFormatVersion}`
    );
  }
  if (formatVersion < BINARY_PROGRAM_FORMAT_VERSION) {
    throw codecError(
      BrainProgramBinaryCodecErrorCode.UNSUPPORTED_FORMAT_VERSION,
      `format version ${formatVersion} is older than this reader's format ${BINARY_PROGRAM_FORMAT_VERSION}`
    );
  }
  const profileId = s.readVarUint();
  const presence = s.readRawU8();

  // CSTR is read first; every later section resolves string indices against it.
  const strings = readCstrSection(s);
  const rawTypes = readTypsSectionRaw(s, strings, precision);
  const resolvedTypes = resolveTypsEntries(rawTypes, options.typeRegistry);
  const numbers = readCnumSection(s, precision);
  const values = readCvalSection(s, strings, resolvedTypes.context, precision);
  const functions = readFuncSection(s);
  const vars = readVarsSection(s, strings);
  const actions = (presence & PRESENCE_ACTS) !== 0 ? readActsSection(s) : undefined;
  const ruleFuncIds = (presence & PRESENCE_RULF) !== 0 ? readRulfSection(s) : undefined;
  const ruleAncestors = (presence & PRESENCE_RANC) !== 0 ? readRancSection(s) : undefined;
  const systems = (presence & PRESENCE_SYST) !== 0 ? readSystSection(s, strings) : undefined;
  const pages = readPageSection(s, strings);

  const constantPools: BrainProgramConstantPoolsJson = {
    numbers,
    strings: strings.constStrings(),
    values,
  };
  const programJson: BrainProgramJson = {
    version: 1,
    functions,
    constantPools,
    types: resolvedTypes.entries,
    variableNames: vars.names,
    ...(vars.initValues !== undefined ? { variableInitValues: vars.initValues } : {}),
    ...(actions !== undefined ? { actions } : {}),
    ...(ruleFuncIds !== undefined ? { ruleFuncIds } : {}),
    ...(ruleAncestors !== undefined ? { ruleAncestors } : {}),
    ...(systems !== undefined ? { systems } : {}),
  };
  const linkedJson: LinkedBrainProgramJson = { program: programJson, pages };
  return { profileId, program: linkedBrainProgramFromJson(linkedJson) };
}

/** Full string table plus a `constStrings()` view onto the `constantPools.strings` prefix. */
class StringTable {
  constructor(
    private readonly all: List<string>,
    readonly constStringCount: number
  ) {}

  get(index: number): string {
    if (index < 0 || index >= this.all.size()) {
      throw codecError(
        BrainProgramBinaryCodecErrorCode.INVALID_VALUE_TAG,
        `string index ${index} out of range (size ${this.all.size()})`
      );
    }
    return this.all.get(index);
  }

  /** Returns the `constantPools.strings` prefix as a fresh array. */
  constStrings(): string[] {
    return this.all.slice(0, this.constStringCount).toArray();
  }
}

function readCstrSection(s: MemoryStream): StringTable {
  const total = s.readVarUint();
  const constStringCount = s.readVarUint();
  const all = List.empty<string>();
  for (let i = 0; i < total; i++) {
    all.push(s.readVarString());
  }
  return new StringTable(all, constStringCount);
}

function readFuncSection(s: MemoryStream): BrainProgramFunctionBytecodeJson[] {
  const count = s.readVarUint();
  const functions: BrainProgramFunctionBytecodeJson[] = [];
  for (let i = 0; i < count; i++) {
    const numParams = s.readVarUint();
    const extraLocals = s.readVarUint();
    const injectCtxId = s.readVarUint();
    const instrCount = s.readVarUint();
    const code: BrainProgramInstructionJson[] = [];
    for (let j = 0; j < instrCount; j++) {
      code.push(readInstruction(s));
    }
    functions.push({
      code,
      numParams,
      numLocals: numParams + extraLocals,
      ...(injectCtxId === 0 ? {} : { injectCtxTypeIdx: injectCtxId - 1 }),
    });
  }
  return functions;
}

/** One TYPS entry as read off the wire, before atom/typeId resolution. */
type RawTypeEntry =
  | { readonly tag: typeof TYPE_ENTRY_TAG_ATOM; readonly atomId: number }
  | { readonly tag: typeof TYPE_ENTRY_TAG_LIST; readonly elem: number }
  | { readonly tag: typeof TYPE_ENTRY_TAG_MAP; readonly key: number; readonly value: number }
  | { readonly tag: typeof TYPE_ENTRY_TAG_UNION; readonly members: List<number> }
  | { readonly tag: typeof TYPE_ENTRY_TAG_FUNCTION; readonly params: List<number>; readonly result: number }
  | { readonly tag: typeof TYPE_ENTRY_TAG_NULLABLE; readonly base: number }
  | {
      readonly tag: typeof TYPE_ENTRY_TAG_STRUCT;
      readonly name: string;
      readonly slotCount: number;
      readonly fields: List<{ readonly name: string; readonly fieldIndex: number }>;
    }
  | {
      readonly tag: typeof TYPE_ENTRY_TAG_ENUM;
      readonly name: string;
      readonly symbols: List<{ readonly key: string; readonly value: string | number }>;
    };

function readTypsSectionRaw(s: MemoryStream, strings: StringTable, precision: NumberPrecision): List<RawTypeEntry> {
  const count = s.readVarUint();
  const entries = List.empty<RawTypeEntry>();

  const child = (own: number): number => {
    const idx = s.readVarUint();
    if (idx >= own) {
      throw codecError(
        BrainProgramBinaryCodecErrorCode.TYPE_FORWARD_REFERENCE,
        `TYPS entry ${own} references child ${idx}; children must precede their parent`
      );
    }
    return idx;
  };

  for (let i = 0; i < count; i++) {
    const tag = s.readRawU8();
    switch (tag) {
      case TYPE_ENTRY_TAG_ATOM:
        entries.push({ tag, atomId: s.readVarUint() });
        break;
      case TYPE_ENTRY_TAG_LIST:
        entries.push({ tag, elem: child(i) });
        break;
      case TYPE_ENTRY_TAG_MAP:
        entries.push({ tag, key: child(i), value: child(i) });
        break;
      case TYPE_ENTRY_TAG_UNION: {
        const memberCount = s.readVarUint();
        const members = List.empty<number>();
        for (let j = 0; j < memberCount; j++) {
          members.push(child(i));
        }
        entries.push({ tag, members });
        break;
      }
      case TYPE_ENTRY_TAG_FUNCTION: {
        const paramCount = s.readVarUint();
        const params = List.empty<number>();
        for (let j = 0; j < paramCount; j++) {
          params.push(child(i));
        }
        entries.push({ tag, params, result: child(i) });
        break;
      }
      case TYPE_ENTRY_TAG_NULLABLE:
        entries.push({ tag, base: child(i) });
        break;
      case TYPE_ENTRY_TAG_STRUCT: {
        const name = strings.get(s.readVarUint());
        const slotCount = s.readVarUint();
        const fieldCount = s.readVarUint();
        const fields = List.empty<{ name: string; fieldIndex: number }>();
        for (let j = 0; j < fieldCount; j++) {
          const fieldName = strings.get(s.readVarUint());
          fields.push({ name: fieldName, fieldIndex: s.readVarUint() });
        }
        entries.push({ tag, name, slotCount, fields });
        break;
      }
      case TYPE_ENTRY_TAG_ENUM: {
        const name = strings.get(s.readVarUint());
        const symbolCount = s.readVarUint();
        const symbols = List.empty<{ key: string; value: string | number }>();
        if (symbolCount > 0) {
          const valueKind = s.readRawU8();
          if (valueKind !== ENUM_VALUE_KIND_NUMBER && valueKind !== ENUM_VALUE_KIND_STRING) {
            throw codecError(
              BrainProgramBinaryCodecErrorCode.INVALID_ENUM_VALUE_KIND,
              `invalid enum value kind ${valueKind}`
            );
          }
          for (let j = 0; j < symbolCount; j++) {
            const key = strings.get(s.readVarUint());
            const value =
              valueKind === ENUM_VALUE_KIND_STRING ? strings.get(s.readVarUint()) : readNumberEntry(s, precision);
            symbols.push({ key, value });
          }
        }
        entries.push({ tag, name, symbols });
        break;
      }
      default:
        throw codecError(BrainProgramBinaryCodecErrorCode.INVALID_TYPE_ENTRY_TAG, `invalid TYPS entry tag ${tag}`);
    }
  }
  return entries;
}

/**
 * Type-resolution context for the decoder: maps a type-table index to its
 * reconstructed typeId string, and an enum value's `(typeIdx, ordinal)` pair
 * to its symbol key.
 */
interface DecodeTypeContext {
  typeIdOf(idx: number): string;
  enumSymbolOf(idx: number, ordinal: number): string;
}

interface ResolvedTypsEntries {
  entries: BrainProgramTypeEntryJson[];
  context: DecodeTypeContext;
}

/**
 * Reconstruct each raw TYPS entry's typeId string: atoms through the
 * registry's atom map, structural entries through the deterministic
 * composition rules, and program-local struct/enum entries through their
 * carried names.
 */
function resolveTypsEntries(rawEntries: List<RawTypeEntry>, registry: ITypeRegistry): ResolvedTypsEntries {
  const entries: BrainProgramTypeEntryJson[] = [];
  const typeIds = List.empty<string>();
  const names = List.empty<string>();
  const coreTypes = List.empty<NativeType>();

  for (let i = 0; i < rawEntries.size(); i++) {
    const raw = rawEntries.get(i)!;
    switch (raw.tag) {
      case TYPE_ENTRY_TAG_ATOM: {
        const typeId = registry.resolveByAtomId(raw.atomId);
        const def = typeId === undefined ? undefined : registry.get(typeId);
        if (typeId === undefined || def === undefined) {
          throw codecError(
            BrainProgramBinaryCodecErrorCode.UNKNOWN_TYPE_ATOM,
            `TYPS entry ${i}: type atom ${raw.atomId} is not registered in this runtime`
          );
        }
        entries.push({ tag: "atom", typeId, atomId: raw.atomId });
        typeIds.push(typeId);
        names.push(def.name);
        coreTypes.push(def.coreType);
        break;
      }
      case TYPE_ENTRY_TAG_LIST: {
        const name = `List<${typeIds.get(raw.elem)}>`;
        const typeId = mkTypeId(NativeType.List, name);
        entries.push({ tag: "list", typeId, elem: raw.elem });
        typeIds.push(typeId);
        names.push(name);
        coreTypes.push(NativeType.List);
        break;
      }
      case TYPE_ENTRY_TAG_MAP: {
        const name = `Map<${typeIds.get(raw.key)},${typeIds.get(raw.value)}>`;
        const typeId = mkTypeId(NativeType.Map, name);
        entries.push({ tag: "map", typeId, key: raw.key, value: raw.value });
        typeIds.push(typeId);
        names.push(name);
        coreTypes.push(NativeType.Map);
        break;
      }
      case TYPE_ENTRY_TAG_UNION: {
        const parts: string[] = [];
        for (let j = 0; j < raw.members.size(); j++) {
          parts.push(typeIds.get(raw.members.get(j)!)!);
        }
        const name = parts.join(",");
        const typeId = mkTypeId(NativeType.Union, name);
        entries.push({ tag: "union", typeId, members: raw.members.toArray() });
        typeIds.push(typeId);
        names.push(name);
        coreTypes.push(NativeType.Union);
        break;
      }
      case TYPE_ENTRY_TAG_FUNCTION: {
        const parts: string[] = [];
        for (let j = 0; j < raw.params.size(); j++) {
          parts.push(typeIds.get(raw.params.get(j)!)!);
        }
        const name = `Function<(${parts.join(",")})=>${typeIds.get(raw.result)}>`;
        const typeId = mkTypeId(NativeType.Function, name);
        entries.push({ tag: "function", typeId, params: raw.params.toArray(), result: raw.result });
        typeIds.push(typeId);
        names.push(name);
        coreTypes.push(NativeType.Function);
        break;
      }
      case TYPE_ENTRY_TAG_NULLABLE: {
        const name = `${names.get(raw.base)}?`;
        const coreType = coreTypes.get(raw.base)!;
        const typeId = mkTypeId(coreType, name);
        entries.push({ tag: "nullable", typeId, base: raw.base });
        typeIds.push(typeId);
        names.push(name);
        coreTypes.push(coreType);
        break;
      }
      case TYPE_ENTRY_TAG_STRUCT: {
        const typeId = mkTypeId(NativeType.Struct, raw.name);
        entries.push({
          tag: "struct",
          typeId,
          name: raw.name,
          maxFieldId: raw.slotCount - 1,
          fields: raw.fields.toArray(),
        });
        typeIds.push(typeId);
        names.push(raw.name);
        coreTypes.push(NativeType.Struct);
        break;
      }
      case TYPE_ENTRY_TAG_ENUM: {
        const typeId = mkTypeId(NativeType.Enum, raw.name);
        entries.push({ tag: "enum", typeId, name: raw.name, symbols: raw.symbols.toArray() });
        typeIds.push(typeId);
        names.push(raw.name);
        coreTypes.push(NativeType.Enum);
        break;
      }
    }
  }

  const context: DecodeTypeContext = {
    typeIdOf(idx: number): string {
      if (idx < 0 || idx >= typeIds.size()) {
        throw codecError(
          BrainProgramBinaryCodecErrorCode.TYPE_INDEX_OUT_OF_RANGE,
          `type-table index ${idx} out of range (table size ${typeIds.size()})`
        );
      }
      return typeIds.get(idx)!;
    },
    enumSymbolOf(idx: number, ordinal: number): string {
      const typeId = this.typeIdOf(idx);
      const raw = rawEntries.get(idx)!;
      if (raw.tag === TYPE_ENTRY_TAG_ENUM) {
        if (ordinal < 0 || ordinal >= raw.symbols.size()) {
          throw codecError(
            BrainProgramBinaryCodecErrorCode.ENUM_ORDINAL_OUT_OF_RANGE,
            `enum ${typeId} ordinal ${ordinal} out of range (${raw.symbols.size()} symbols)`
          );
        }
        return raw.symbols.get(ordinal)!.key;
      }
      if (raw.tag === TYPE_ENTRY_TAG_ATOM) {
        const def = registry.get(typeId) as EnumTypeDef | undefined;
        const symbol = def && def.coreType === NativeType.Enum ? def.symbols.get(ordinal) : undefined;
        if (!symbol) {
          throw codecError(
            BrainProgramBinaryCodecErrorCode.ENUM_ORDINAL_OUT_OF_RANGE,
            `enum ${typeId} ordinal ${ordinal} does not resolve to a registered symbol`
          );
        }
        return symbol.key;
      }
      throw codecError(
        BrainProgramBinaryCodecErrorCode.INVALID_VALUE_TAG,
        `enum constant references non-enum type-table entry ${idx} (${typeId})`
      );
    },
  };

  return { entries, context };
}

function readInstruction(s: MemoryStream): BrainProgramInstructionJson {
  const op = s.readRawU8();
  const schema = operandSchemaFor(op);
  const instr: { op: number; a?: number; b?: number; c?: number } = { op };
  for (let i = 0; i < schema.size(); i++) {
    const spec = schema.get(i);
    if (spec.optional) {
      const sentinel = s.readVarUint();
      if (sentinel !== 0) {
        setOperandAt(instr, i, sentinel - 1);
      }
    } else {
      setOperandAt(instr, i, spec.encoding === "svar" ? s.readVarInt() : s.readVarUint());
    }
  }
  return instr;
}

function readCnumSection(s: MemoryStream, precision: NumberPrecision): number[] {
  const count = s.readVarUint();
  const numbers: number[] = [];
  for (let i = 0; i < count; i++) {
    numbers.push(readNumberEntry(s, precision));
  }
  return numbers;
}

function readNumberEntry(s: MemoryStream, precision: NumberPrecision): number {
  const discriminant = s.readRawU8();
  if (discriminant === NUMBER_DISCRIMINANT_SMALL_INT) {
    return s.readVarInt();
  }
  if (discriminant === NUMBER_DISCRIMINANT_F32) {
    return s.readRawF32();
  }
  if (discriminant === NUMBER_DISCRIMINANT_F64) {
    if (precision === "f32") {
      throw codecError(
        BrainProgramBinaryCodecErrorCode.F64_ON_F32_TARGET,
        "f64 numeric entry is not allowed on an f32 target"
      );
    }
    return s.readRawF64();
  }
  throw codecError(
    BrainProgramBinaryCodecErrorCode.INVALID_NUMBER_DISCRIMINANT,
    `invalid CNUM discriminant ${discriminant}`
  );
}

function readCvalSection(
  s: MemoryStream,
  strings: StringTable,
  types: DecodeTypeContext,
  precision: NumberPrecision
): BrainProgramJsonObject[] {
  const count = s.readVarUint();
  const values: BrainProgramJsonObject[] = [];
  for (let i = 0; i < count; i++) {
    values.push(readValue(s, strings, types, precision));
  }
  return values;
}

function readValue(
  s: MemoryStream,
  strings: StringTable,
  types: DecodeTypeContext,
  precision: NumberPrecision
): BrainProgramJsonObject {
  const tag = readValueTag(s);
  switch (tag) {
    case NativeType.Unknown:
      return { t: NativeType.Unknown };
    case NativeType.Void:
      return { t: NativeType.Void };
    case NativeType.Nil:
      return { t: NativeType.Nil };
    case NativeType.Boolean:
      return { t: NativeType.Boolean, v: s.readRawU8() !== 0 };
    case NativeType.Number:
      return { t: NativeType.Number, v: readNumberEntry(s, precision) };
    case NativeType.String:
      return { t: NativeType.String, v: strings.get(s.readVarUint()) };
    case NativeType.Enum: {
      const typeIdx = s.readVarUint();
      const ordinal = s.readVarUint();
      return { t: NativeType.Enum, typeId: types.typeIdOf(typeIdx), v: types.enumSymbolOf(typeIdx, ordinal) };
    }
    case NativeType.List: {
      const typeId = types.typeIdOf(s.readVarUint());
      const count = s.readVarUint();
      const items: BrainProgramJsonObject[] = [];
      for (let i = 0; i < count; i++) {
        items.push(readValue(s, strings, types, precision));
      }
      return { t: NativeType.List, typeId, v: items };
    }
    case NativeType.Map: {
      const typeId = types.typeIdOf(s.readVarUint());
      const count = s.readVarUint();
      const entries: MapEntryJson[] = [];
      for (let i = 0; i < count; i++) {
        const keyTag = s.readRawU8();
        const key = keyTag === MAP_KEY_TAG_NUMBER ? readNumberEntry(s, precision) : strings.get(s.readVarUint());
        entries.push({ key, value: readValue(s, strings, types, precision) });
      }
      return { t: NativeType.Map, typeId, v: entries };
    }
    case NativeType.Struct: {
      const typeId = types.typeIdOf(s.readVarUint());
      const count = s.readVarUint();
      const fields: BrainProgramJsonObject[] = [];
      for (let i = 0; i < count; i++) {
        fields.push(readValue(s, strings, types, precision));
      }
      return { t: NativeType.Struct, typeId, v: fields };
    }
    case NativeType.Function: {
      const funcId = s.readVarUint();
      const biasedCaptures = s.readVarUint();
      if (biasedCaptures === 0) {
        return { t: NativeType.Function, funcId };
      }
      const captures: BrainProgramJsonObject[] = [];
      for (let i = 0; i < biasedCaptures - 1; i++) {
        captures.push(readValue(s, strings, types, precision));
      }
      return { t: NativeType.Function, funcId, captures };
    }
    case NativeType.Buffer: {
      const count = s.readVarUint();
      let hex = "";
      for (let i = 0; i < count; i++) {
        hex += byteToHex(s.readRawU8());
      }
      return { t: NativeType.Buffer, v: hex };
    }
    default:
      throw codecError(BrainProgramBinaryCodecErrorCode.INVALID_VALUE_TAG, `invalid value tag ${tag}`);
  }
}

function readVarsSection(s: MemoryStream, strings: StringTable): VarsSection {
  const count = s.readVarUint();
  const names: string[] = [];
  const initValues: number[] = [];
  let anyInit = false;
  for (let i = 0; i < count; i++) {
    names.push(strings.get(s.readVarUint()));
    const biased = s.readVarUint();
    if (biased !== 0) anyInit = true;
    initValues.push(biased === 0 ? NO_VARIABLE_INIT : biased - 1);
  }
  return { names, initValues: anyInit ? initValues : undefined };
}

/** Decoded `VARS` section: one name per slot, plus the starting values when any slot has one. */
interface VarsSection {
  readonly names: string[];
  readonly initValues?: number[];
}

function readActsSection(s: MemoryStream): BrainProgramExecutableActionJson[] {
  const count = s.readVarUint();
  const actions: BrainProgramExecutableActionJson[] = [];
  for (let i = 0; i < count; i++) {
    const flags = s.readRawU8();
    const entryFuncId = s.readVarUint();
    const action: {
      entryFuncId: number;
      initializerFuncId?: number;
      activationFuncId?: number;
      deactivationFuncId?: number;
    } = { entryFuncId };
    if ((flags & ACTION_FLAG_INITIALIZER) !== 0) action.initializerFuncId = s.readVarUint();
    if ((flags & ACTION_FLAG_ACTIVATION) !== 0) action.activationFuncId = s.readVarUint();
    if ((flags & ACTION_FLAG_DEACTIVATION) !== 0) action.deactivationFuncId = s.readVarUint();
    actions.push(action);
  }
  return actions;
}

function readRulfSection(s: MemoryStream): number[] {
  const count = s.readVarUint();
  const ruleFuncIds: number[] = [];
  for (let i = 0; i < count; i++) {
    ruleFuncIds.push(s.readVarUint());
  }
  return ruleFuncIds;
}

function readRancSection(s: MemoryStream): BrainProgramRuleAncestorJsonEntry[] {
  const count = s.readVarUint();
  const entries: BrainProgramRuleAncestorJsonEntry[] = [];
  for (let i = 0; i < count; i++) {
    const ruleFuncId = s.readVarUint();
    const parentRuleFuncId = s.readVarUint();
    entries.push({ ruleFuncId, parentRuleFuncId });
  }
  return entries;
}

function readSystSection(s: MemoryStream, strings: StringTable): BrainProgramSystemRegistrationJson[] {
  const count = s.readVarUint();
  const systems: BrainProgramSystemRegistrationJson[] = [];
  for (let i = 0; i < count; i++) {
    const flags = s.readRawU8();
    const name = strings.get(s.readVarUint());
    const storeSlot = s.readVarUint();
    const system: { name: string; storeSlot: number; initFuncId?: number; thinkFuncId?: number } = {
      name,
      storeSlot,
    };
    if ((flags & SYSTEM_FLAG_INIT) !== 0) system.initFuncId = s.readVarUint();
    if ((flags & SYSTEM_FLAG_THINK) !== 0) system.thinkFuncId = s.readVarUint();
    systems.push(system);
  }
  return systems;
}

function readPageSection(s: MemoryStream, strings: StringTable): LinkedBrainProgramPageMetadataJson[] {
  const count = s.readVarUint();
  const pages: LinkedBrainProgramPageMetadataJson[] = [];
  for (let i = 0; i < count; i++) {
    const pageIndex = s.readVarUint();
    const pageId = strings.get(s.readVarUint());
    const rootCount = s.readVarUint();
    const rootRuleFuncIds: number[] = [];
    for (let r = 0; r < rootCount; r++) {
      rootRuleFuncIds.push(s.readVarUint());
    }
    const callSiteCount = s.readVarUint();
    const actionCallSites: LinkedBrainProgramActionCallSiteJsonEntry[] = [];
    for (let c = 0; c < callSiteCount; c++) {
      const binding = s.readRawU8();
      const callSiteId = s.readVarUint();
      const id = s.readVarUint();
      actionCallSites.push(
        binding === CALL_SITE_BINDING_HOST
          ? { binding: "host", callSiteId, actionId: id }
          : { binding: "bytecode", callSiteId, actionSlot: id }
      );
    }
    // pageName is dropped on the wire and hydrates empty.
    pages.push({ pageIndex, pageId, pageName: "", rootRuleFuncIds, actionCallSites });
  }
  return pages;
}

///////////////////////////
// Section byte report
///////////////////////////

/** On-wire body byte count of one binary `.mcprogram` section. */
export interface BinaryProgramSectionByteSize {
  /** Section name (e.g. `"FUNC"`). */
  readonly tag: string;

  /** Section body byte count (var-int-packed payload). */
  readonly bodyBytes: number;
}

/** Byte-size breakdown for a binary `.mcprogram`. */
export interface BinaryProgramByteReport {
  /** Total file byte count. */
  readonly totalBytes: number;

  /** File magic byte count. */
  readonly magicBytes: number;

  /** Envelope header byte count: format version + profile id + presence bitmask. */
  readonly headerBytes: number;

  /** Per-section body sizes, in buffer order. */
  readonly sections: readonly BinaryProgramSectionByteSize[];
}

/**
 * Computes the per-section byte breakdown of a binary `.mcprogram` by parsing
 * the payload and measuring each section's span. Intended for size reporting
 * and regression visibility, not for hot paths.
 *
 * @param bytes - Binary `.mcprogram` payload.
 */
export function binaryProgramByteReport(bytes: IByteArray): BinaryProgramByteReport {
  const s = new MemoryStream(bytes);
  for (let i = 0; i < MAGIC.size(); i++) {
    s.readRawU8();
  }
  s.readRawU8(); // format version
  s.readVarUint(); // profileId
  const presence = s.readRawU8();
  const headerBytes = s.tellRead() - MAGIC.size();

  const sections: BinaryProgramSectionByteSize[] = [];
  // f64 precision accepts any number discriminant while measuring.
  const measure = (tag: string, read: () => void): void => {
    const start = s.tellRead();
    read();
    sections.push({ tag, bodyBytes: s.tellRead() - start });
  };

  const cstrStart = s.tellRead();
  const strings = readCstrSection(s);
  sections.push({ tag: "CSTR", bodyBytes: s.tellRead() - cstrStart });
  measure("TYPS", () => {
    readTypsSectionRaw(s, strings, "f64");
  });
  // Measuring needs only byte spans, so type references resolve to placeholders.
  const measureTypes: DecodeTypeContext = {
    typeIdOf(): string {
      return "";
    },
    enumSymbolOf(): string {
      return "";
    },
  };
  measure("CNUM", () => {
    readCnumSection(s, "f64");
  });
  measure("CVAL", () => {
    readCvalSection(s, strings, measureTypes, "f64");
  });
  measure("FUNC", () => {
    readFuncSection(s);
  });
  measure("VARS", () => {
    readVarsSection(s, strings);
  });
  if ((presence & PRESENCE_ACTS) !== 0) {
    measure("ACTS", () => {
      readActsSection(s);
    });
  }
  if ((presence & PRESENCE_RULF) !== 0) {
    measure("RULF", () => {
      readRulfSection(s);
    });
  }
  if ((presence & PRESENCE_RANC) !== 0) {
    measure("RANC", () => {
      readRancSection(s);
    });
  }
  if ((presence & PRESENCE_SYST) !== 0) {
    measure("SYST", () => {
      readSystSection(s, strings);
    });
  }
  measure("PAGE", () => {
    readPageSection(s, strings);
  });

  return { totalBytes: bytes.length(), magicBytes: MAGIC.size(), headerBytes, sections };
}

///////////////////////////
// Shared helpers
///////////////////////////

/** One JSON-encoded map entry (`key` is a string or number; `value` is recursive). */
type MapEntryJson = {
  readonly key: string | number;
  readonly value: BrainProgramJsonObject;
};

function operandSchemaFor(op: number): List<OperandSpec> {
  const raw = OPERAND_SCHEMA[op as keyof typeof OPERAND_SCHEMA] as readonly OperandSpec[] | undefined;
  if (raw === undefined) {
    throw codecError(BrainProgramBinaryCodecErrorCode.UNKNOWN_OPCODE, `no operand schema for opcode ${op}`);
  }
  return List.from(raw);
}

const HEX_DIGITS = "0123456789abcdef";

/** Lowercase two-digit hex of a byte (0-255). */
function byteToHex(byte: number): string {
  const b = byte & 0xff;
  return StringUtils.charAt(HEX_DIGITS, (b >> 4) & 0xf) + StringUtils.charAt(HEX_DIGITS, b & 0xf);
}

function writeValueTag(s: MemoryStream, tag: NativeType): void {
  // NativeType.Unknown is -1; store it as 0xff and map back on read.
  s.writeRawU8(tag < 0 ? tag + 256 : tag);
}

function readValueTag(s: MemoryStream): NativeType {
  const raw = s.readRawU8();
  return (raw === 255 ? NativeType.Unknown : raw) as NativeType;
}

function operandAt(instr: Instr, index: number): number | undefined {
  if (index === 0) return instr.a;
  if (index === 1) return instr.b;
  return instr.c;
}

function setOperandAt(instr: { a?: number; b?: number; c?: number }, index: number, value: number): void {
  if (index === 0) {
    instr.a = value;
  } else if (index === 1) {
    instr.b = value;
  } else {
    instr.c = value;
  }
}

function isU32(x: number): boolean {
  if (MathOps.isNaN(x)) {
    return false;
  }
  if (x < 0 || x > 0xffffffff) {
    return false;
  }
  return MathOps.floor(x) === x;
}

function isSmallInt(x: number): boolean {
  if (MathOps.isNaN(x)) {
    return false;
  }
  if (x > I32_MAX || x < I32_MIN) {
    return false;
  }
  if (MathOps.floor(x) !== x) {
    return false;
  }
  // Reject negative zero: it is not small-int-encodable (lands on the profile float).
  return !(x === 0 && 1 / x < 0);
}
