import type { IByteArray, IReadStream, IWriteStream } from "./stream-types";

export { DataType, type IByteArray, type IReadStream, type IWriteStream } from "./stream-types";

/** Largest UTF-8 byte length a variable-length string written by {@link MemoryStream.writeVarString} may have. */
export declare const kMaxLongStringLength: number;

/** In-memory tagged binary stream implementing both {@link IReadStream} and {@link IWriteStream}. */
export declare class MemoryStream implements IReadStream, IWriteStream {
  constructor(initial?: IByteArray, initialCapacity?: number);

  // IReadStream
  peekTag(): number;
  readTag(tag: number): void;
  readU8(): number;
  readBytes(): IByteArray;
  readU32(): number;
  readF64(): number;
  readBool(): boolean;
  readString(): string;
  readTaggedU8(tag: number): number;
  readTaggedBytes(tag: number): IByteArray;
  readTaggedU32(tag: number): number;
  readTaggedF64(tag: number): number;
  readTaggedBool(tag: number): boolean;
  readTaggedString(tag: number): string;
  skip(bytes: number): void;
  eof(): boolean;
  pushReadPos(): void;
  popReadPos(): void;

  // IWriteStream
  writeTag(tag: number): void;
  writeU8(v: number): void;
  writeBytes(bytes: IByteArray): void;
  writeU32(v: number): void;
  writeF64(v: number): void;
  writeBool(v: boolean): void;
  writeString(v: string): void;
  writeTaggedU8(tag: number, v: number): void;
  writeTaggedBytes(tag: number, bytes: IByteArray): void;
  writeTaggedU32(tag: number, v: number): void;
  writeTaggedF64(tag: number, v: number): void;
  writeTaggedBool(tag: number, v: boolean): void;
  writeTaggedString(tag: number, v: string): void;
  toBytes(): IByteArray;

  // Additional methods
  resetRead(): void;
  tellRead(): number;
  tellWrite(): number;
  remaining(): number;

  // Chunk methods
  pushChunk(tag: number, version: number): void;
  popChunk(): void;
  enterChunk(tag: number): number;
  leaveChunk(): void;
  skipChunk(tag: number): void;

  /** Writes a single raw byte (0..255), no `DataType` tag. */
  writeRawU8(v: number): void;
  /** Reads a single raw byte (0..255), no `DataType` tag. */
  readRawU8(): number;
  /** Writes a raw little-endian IEEE-754 binary32, no `DataType` tag. */
  writeRawF32(v: number): void;
  /** Reads a raw little-endian IEEE-754 binary32, no `DataType` tag. */
  readRawF32(): number;
  /** Writes a raw little-endian IEEE-754 binary64, no `DataType` tag. */
  writeRawF64(v: number): void;
  /** Reads a raw little-endian IEEE-754 binary64, no `DataType` tag. */
  readRawF64(): number;
  /** Writes an unsigned 32-bit integer as ULEB128 (1..5 bytes). */
  writeVarUint(v: number): void;
  /** Reads a ULEB128 unsigned 32-bit integer. Throws on a >32-bit value. */
  readVarUint(): number;
  /** Writes a signed 32-bit integer as zigzag + ULEB128 (1..5 bytes). */
  writeVarInt(v: number): void;
  /** Reads a zigzag + ULEB128 signed 32-bit integer. Throws on a >32-bit value. */
  readVarInt(): number;
  /** Writes a string as `byteLen` (var-uint) + that many raw UTF-8 bytes, no `DataType` tag. */
  writeVarString(v: string): void;
  /** Reads a `byteLen` (var-uint) + UTF-8 string written by {@link writeVarString}. */
  readVarString(): string;
}

// Utility functions for IByteArray conversion
// These are implemented in platform-specific files (stream.node.ts, stream.rbx.ts)
// and will be available at runtime after the build process.

/**
 * Creates an IByteArray from platform-native binary data (makes a copy).
 * Implementation provided by platform-specific module.
 */
export declare function byteArrayFromUint8Array(src: unknown): IByteArray;

/**
 * Extracts platform-native binary data from an IByteArray.
 * Implementation provided by platform-specific module.
 */
export declare function byteArrayToUint8Array(bytes: IByteArray): unknown;

/**
 * Creates an IByteArray from a latin1 string, mapping each character's low 8
 * bits to one byte (1 char => 1 byte). Implementation provided by the
 * platform-specific module.
 */
export declare function byteArrayFromStringLatin1(s: string): IByteArray;
