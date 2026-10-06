import type {
  EnumTypeDef,
  FunctionTypeDef,
  ITypeRegistry,
  ListTypeDef,
  MapTypeDef,
  NullableTypeDef,
  StructTypeDef,
  TypeDef,
  UnionTypeDef,
} from "@wendoo/core/runtime";
import { NativeType } from "@wendoo/core/runtime";

const AMBIENT_HEADER = `/// <reference no-default-lib="true"/>

declare var NaN: number;
declare var Infinity: number;

declare function parseInt(string: string, radix?: number): number;
declare function parseFloat(string: string): number;
declare function isNaN(number: number): boolean;
declare function isFinite(number: number): boolean;

/** @deprecated Not supported in Wendoo Runtime */
type Object = {};
/** @deprecated Not supported in Wendoo Runtime */
type Function = {};
/** @deprecated Not supported in Wendoo Runtime */
type CallableFunction = {};
/** @deprecated Not supported in Wendoo Runtime */
type NewableFunction = {};
/** @deprecated Not supported in Wendoo Runtime */
type IArguments = {};
/** @deprecated Not supported in Wendoo Runtime */
type RegExp = {};

interface SymbolConstructor {
  readonly iterator: unique symbol;
}
declare var Symbol: SymbolConstructor;

interface IteratorYieldResult<TYield> {
  done?: false;
  value: TYield;
}

interface IteratorReturnResult<TReturn> {
  done: true;
  value: TReturn;
}

type IteratorResult<T, TReturn = any> = IteratorYieldResult<T> | IteratorReturnResult<TReturn>;

interface Iterator<T, TReturn = any, TNext = any> {
  next(...[value]: [] | [TNext]): IteratorResult<T, TReturn>;
  return?(value?: TReturn): IteratorResult<T, TReturn>;
  throw?(e?: any): IteratorResult<T, TReturn>;
}

interface Iterable<T, TReturn = any, TNext = any> {
  [Symbol.iterator](): Iterator<T, TReturn, TNext>;
}

interface IterableIterator<T, TReturn = any, TNext = any> extends Iterator<T, TReturn, TNext> {
  [Symbol.iterator](): IterableIterator<T, TReturn, TNext>;
}

declare type PromiseConstructorLike = new <T>(
  executor: (resolve: (value: T | PromiseLike<T>) => void, reject: (reason?: any) => void) => void
) => PromiseLike<T>;

interface Math {
  readonly E: number;
  readonly LN10: number;
  readonly LN2: number;
  readonly LOG2E: number;
  readonly LOG10E: number;
  readonly PI: number;
  readonly SQRT1_2: number;
  readonly SQRT2: number;
  abs(x: number): number;
  acos(x: number): number;
  asin(x: number): number;
  atan(x: number): number;
  atan2(y: number, x: number): number;
  ceil(x: number): number;
  cos(x: number): number;
  exp(x: number): number;
  floor(x: number): number;
  log(x: number): number;
  max(...values: number[]): number;
  min(...values: number[]): number;
  pow(x: number, y: number): number;
  random(): number;
  round(x: number): number;
  sin(x: number): number;
  sqrt(x: number): number;
  tan(x: number): number;
}
declare var Math: Math;

interface String {
  toString(): string;
  charAt(pos: number): string;
  charCodeAt(index: number): number;
  concat(...strings: string[]): string;
  indexOf(searchString: string, position?: number): number;
  lastIndexOf(searchString: string, position?: number): number;
  slice(start?: number, end?: number): string;
  substring(start: number, end?: number): string;
  toLowerCase(): string;
  toUpperCase(): string;
  trim(): string;
  split(separator: string, limit?: number): string[];
  valueOf(): string;
  readonly length: number;
  [Symbol.iterator](): IterableIterator<string>;
  readonly [index: number]: string;
}

interface StringConstructor {
  (value?: any): string;
  readonly prototype: String;
  fromCharCode(...codes: number[]): string;
}
declare var String: StringConstructor;

interface Buffer {
  length(): number;
  get(index: number): number;
}

interface BufferConstructor {
  from(values: number[]): Buffer;
  fromHex(hex: string): Buffer;
  fromString(value: string): Buffer;
  isBuffer(arg: any): arg is Buffer;
}
declare var Buffer: BufferConstructor;

interface Boolean {
  valueOf(): boolean;
}

interface BooleanConstructor {
  <T>(value?: T): boolean;
  readonly prototype: Boolean;
}
declare var Boolean: BooleanConstructor;

interface Number {
  toString(radix?: number): string;
  toFixed(fractionDigits?: number): string;
  valueOf(): number;
}

interface NumberConstructor {
  (value?: any): number;
  readonly prototype: Number;
  readonly MAX_VALUE: number;
  readonly MIN_VALUE: number;
  readonly NaN: number;
  readonly NEGATIVE_INFINITY: number;
  readonly POSITIVE_INFINITY: number;
}
declare var Number: NumberConstructor;

interface TemplateStringsArray extends ReadonlyArray<string> {
  readonly raw: readonly string[];
}

interface ArrayLike<T> {
  readonly length: number;
  readonly [n: number]: T;
}

interface ConcatArray<T> {
  readonly length: number;
  readonly [n: number]: T;
  join(separator?: string): string;
  slice(start?: number, end?: number): T[];
}

interface ReadonlyArray<T> {
  readonly length: number;
  toString(): string;
  concat(...items: ConcatArray<T>[]): T[];
  concat(...items: (T | ConcatArray<T>)[]): T[];
  join(separator?: string): string;
  slice(start?: number, end?: number): T[];
  indexOf(searchElement: T, fromIndex?: number): number;
  lastIndexOf(searchElement: T, fromIndex?: number): number;
  every<S extends T>(
    predicate: (value: T, index: number, array: readonly T[]) => value is S,
    thisArg?: any
  ): this is readonly S[];
  every(predicate: (value: T, index: number, array: readonly T[]) => unknown, thisArg?: any): boolean;
  some(predicate: (value: T, index: number, array: readonly T[]) => unknown, thisArg?: any): boolean;
  forEach(callbackfn: (value: T, index: number, array: readonly T[]) => void, thisArg?: any): void;
  map<U>(callbackfn: (value: T, index: number, array: readonly T[]) => U, thisArg?: any): U[];
  filter<S extends T>(predicate: (value: T, index: number, array: readonly T[]) => value is S, thisArg?: any): S[];
  filter(predicate: (value: T, index: number, array: readonly T[]) => unknown, thisArg?: any): T[];
  reduce(callbackfn: (previousValue: T, currentValue: T, currentIndex: number, array: readonly T[]) => T): T;
  reduce(
    callbackfn: (previousValue: T, currentValue: T, currentIndex: number, array: readonly T[]) => T,
    initialValue: T
  ): T;
  reduce<U>(
    callbackfn: (previousValue: U, currentValue: T, currentIndex: number, array: readonly T[]) => U,
    initialValue: U
  ): U;
  find(predicate: (value: T, index: number, obj: readonly T[]) => unknown, thisArg?: any): T | undefined;
  findIndex(predicate: (value: T, index: number, obj: readonly T[]) => unknown, thisArg?: any): number;
  includes(searchElement: T, fromIndex?: number): boolean;
  [Symbol.iterator](): IterableIterator<T>;
  readonly [n: number]: T;
}

interface Array<T> {
  length: number;
  toString(): string;
  push(...items: T[]): number;
  pop(): T | undefined;
  shift(): T | undefined;
  unshift(...items: T[]): number;
  concat(...items: ConcatArray<T>[]): T[];
  concat(...items: (T | ConcatArray<T>)[]): T[];
  join(separator?: string): string;
  reverse(): T[];
  slice(start?: number, end?: number): T[];
  sort(compareFn?: (a: T, b: T) => number): this;
  splice(start: number, deleteCount?: number): T[];
  splice(start: number, deleteCount: number, ...items: T[]): T[];
  indexOf(searchElement: T, fromIndex?: number): number;
  lastIndexOf(searchElement: T, fromIndex?: number): number;
  every<S extends T>(predicate: (value: T, index: number, array: T[]) => value is S, thisArg?: any): this is S[];
  every(predicate: (value: T, index: number, array: T[]) => unknown, thisArg?: any): boolean;
  some(predicate: (value: T, index: number, array: T[]) => unknown, thisArg?: any): boolean;
  forEach(callbackfn: (value: T, index: number, array: T[]) => void, thisArg?: any): void;
  map<U>(callbackfn: (value: T, index: number, array: T[]) => U, thisArg?: any): U[];
  filter<S extends T>(predicate: (value: T, index: number, array: T[]) => value is S, thisArg?: any): S[];
  filter(predicate: (value: T, index: number, array: T[]) => unknown, thisArg?: any): T[];
  reduce(callbackfn: (previousValue: T, currentValue: T, currentIndex: number, array: T[]) => T): T;
  reduce(callbackfn: (previousValue: T, currentValue: T, currentIndex: number, array: T[]) => T, initialValue: T): T;
  reduce<U>(callbackfn: (previousValue: U, currentValue: T, currentIndex: number, array: T[]) => U, initialValue: U): U;
  find(predicate: (value: T, index: number, obj: T[]) => unknown, thisArg?: any): T | undefined;
  findIndex(predicate: (value: T, index: number, obj: T[]) => unknown, thisArg?: any): number;
  includes(searchElement: T, fromIndex?: number): boolean;
  [Symbol.iterator](): IterableIterator<T>;
  [n: number]: T;
}

interface ArrayConstructor {
  from<T>(arrayLike: ArrayLike<T>): T[];
  from<T, U>(arrayLike: ArrayLike<T>, mapfn: (v: T, k: number) => U): U[];
  isArray(arg: any): arg is any[];
  readonly prototype: any[];
}
declare var Array: ArrayConstructor;

interface Map<K, V> {
  get(key: K): V | undefined;
  set(key: K, value: V): this;
  has(key: K): boolean;
  delete(key: K): boolean;
  clear(): void;
  keys(): K[];
  values(): V[];
  forEach(callbackfn: (value: V, key: K) => void): void;
  readonly size: number;
}

interface MapConstructor {
  new <K, V>(): Map<K, V>;
  new <K, V>(entries: readonly (readonly [K, V])[]): Map<K, V>;
}
declare var Map: MapConstructor;

interface PromiseLike<T> {
  then<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | undefined | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | undefined | null
  ): PromiseLike<TResult1 | TResult2>;
}

interface Promise<T> {
  then<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | undefined | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | undefined | null
  ): Promise<TResult1 | TResult2>;
  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | undefined | null
  ): Promise<TResult>;
}

declare var Promise: {
  new <T>(
    executor: (resolve: (value: T | PromiseLike<T>) => void, reject: (reason?: unknown) => void) => void
  ): Promise<T>;
};

type Partial<T> = { [P in keyof T]?: T[P] };
type Required<T> = { [P in keyof T]-?: T[P] };
type Readonly<T> = { readonly [P in keyof T]: T[P] };
type Pick<T, K extends keyof T> = { [P in K]: T[P] };
type Record<K extends keyof any, T> = { [P in K]: T };
type Exclude<T, U> = T extends U ? never : T;
type Extract<T, U> = T extends U ? T : never;
type Omit<T, K extends keyof any> = Pick<T, Exclude<keyof T, K>>;
/** Marker that binds \`this\` to \`T\` inside the methods of a contextually-typed object literal. */
interface ThisType<T> {}
type NonNullable<T> = T & {};
type Parameters<T extends (...args: any) => any> = T extends (...args: infer P) => any ? P : never;
type ConstructorParameters<T extends abstract new (...args: any) => any> = T extends abstract new (
  ...args: infer P
) => any
  ? P
  : never;
type ReturnType<T extends (...args: any) => any> = T extends (...args: any) => infer R ? R : any;
type InstanceType<T extends abstract new (...args: any) => any> = T extends abstract new (
  ...args: any
) => infer R
  ? R
  : any;
type Awaited<T> = T extends null | undefined
  ? T
  : T extends object & { then(onfulfilled: infer F, ...args: infer _): any }
    ? F extends (value: infer V, ...args: infer _) => any
      ? Awaited<V>
      : never
    : T;
type Uppercase<S extends string> = intrinsic;
type Lowercase<S extends string> = intrinsic;
type Capitalize<S extends string> = intrinsic;
type Uncapitalize<S extends string> = intrinsic;
type NoInfer<T> = intrinsic;
`;

const AMBIENT_MODULE_START = `
declare module "wendoo" {
  interface WendooTypeMap {
    boolean: boolean;
    number: number;
    string: string;
    buffer: Buffer;
`;

const AMBIENT_MODULE_END = `
  type WendooValue = WendooTypeMap[keyof WendooTypeMap];
  type WendooType = keyof WendooTypeMap | (string & {});
  /** An \`enum\` binding used where a type is named; it names the enum's registered type. */
  type EnumTypeRef = Record<string, string | number>;

  export interface WendooPlatformContext {}

  interface ModifierSpec {
    readonly __brand: "modifier";
  }
  interface ParamSpec {
    readonly __brand: "param";
  }
  interface ChoiceSpec {
    readonly __brand: "choice";
  }
  interface OptionalSpec {
    readonly __brand: "optional";
  }
  interface RepeatedSpec {
    readonly __brand: "repeated";
  }
  interface ConditionalSpec {
    readonly __brand: "conditional";
  }
  interface SeqSpec {
    readonly __brand: "seq";
  }
  type ArgSpec = ModifierSpec | ParamSpec | ChoiceSpec | OptionalSpec | RepeatedSpec | ConditionalSpec | SeqSpec;

  export function modifier(id: string, opts?: { label: string; icon?: string }): ModifierSpec;
  export function param(
    name: string,
    opts: { type: WendooType | TypeRef<unknown> | EnumTypeRef; default?: unknown; anonymous?: boolean }
  ): ParamSpec;
  export function choice(name: string, ...items: ArgSpec[]): ChoiceSpec;
  export function choice(...items: ArgSpec[]): ChoiceSpec;
  export function optional(item: ArgSpec): OptionalSpec;
  export function repeated(item: ModifierSpec, opts?: { min?: number; max?: number }): RepeatedSpec;
  export function conditional(condition: string, thenItem: ArgSpec, elseItem?: ArgSpec): ConditionalSpec;
  export function seq(...items: ArgSpec[]): SeqSpec;

  /**
   * One named, typed output a sensor exposes. The \`(type, name)\` pair is the
   * output identity: it derives a downstream inline value-tile and the backing
   * rule variable that \`setOutput\` writes and the tile reads. Two sensors that
   * declare the same identity share one tile and one variable.
   */
  export interface OutputSpec {
    /** Output name; the second half of the output identity. */
    name: string;
    /** Output value type, named by TypeRef token (preferred) or type name; the first half of the output identity. */
    type: WendooType | TypeRef<unknown> | EnumTypeRef;
    label?: string;
    icon?: string;
    docs?: string;
    tags?: string[];
    /**
     * When true, a brain may write a field through this output's tile, as in
     * assigning to an accessor tile placed after it; the write reaches the
     * value \`setOutput\` stored. Defaults to false.
     */
    writableResult?: boolean;
  }

  /**
   * The words a tile reads with in the sentence the editor shows for a rule.
   * Every field is optional, and a tile that declares none still reads: it uses
   * its label as its word and the default \`"verb"\` frame.
   */
  export interface TileLanguageConfig {
    /**
     * The word this tile reads as. Write the plain word -- the sentence adds
     * the grammar around it. Defaults to the tile's \`label\`, then its \`name\`.
     */
    form?: string;
    /**
     * How the sentence introduces this word when the tile starts a rule's WHEN
     * side. Use \`"verb"\` for an action (\`form: "hear"\` reads "When I hear a
     * bang"), \`"state"\` for a condition -- the sentence adds the "am", so
     * \`form: "hungry"\` reads "When I am hungry" -- or \`"event"\` for a
     * happening (\`form: "my timer ends"\` reads "When my timer ends"). Defaults
     * to \`"verb"\`. An actuator never starts a WHEN side, so setting this on
     * one changes nothing.
     */
    frame?: "verb" | "state" | "event";
    /**
     * The word that finishes the sentence when this tile is placed with nothing
     * after it: a "see" sensor with \`bare: "anything"\` reads "When I see
     * anything". Defaults to the word the frame supplies.
     */
    bare?: string;
  }

  export interface SensorConfig {
    /** Stable identifier for this action, assigned automatically on first compile. Treat as opaque; do not edit or reuse. */
    id?: string;
    name: string;
    label?: string;
    icon?: string;
    docs?: string;
    tags?: string[];
    /** The words this sensor reads with in a rule's sentence. */
    language?: TileLanguageConfig;
    /**
     * When true, this sensor reads as an inline value in a mid-rule value slot
     * and the tile picker offers it in those positions. An inline sensor takes
     * no arguments.
     */
    inline?: boolean;
    /**
     * When true, a bare WHEN that is exactly this sensor gates on value
     * presence: it fires on a delivered falsy value (0, "", false) and skips
     * only when \`onExecute\` returns null (absent). Exclude null from the
     * sensor's value domain when set.
     */
    presenceGated?: boolean;
    /** Return value type, named by TypeRef token (preferred) or type name; defaults to the \`onExecute\` return annotation. */
    returnType?: WendooType | TypeRef<unknown> | EnumTypeRef;
    /**
     * Declares that this sensor consumes the rule's WHEN result, named by TypeRef
     * token (preferred) or type name. The editor uses it to offer and validate the
     * tile against the WHEN-result type. Declare it when \`onExecute\` reads
     * \`ctx.getWhenResult()\`.
     */
    consumesWhenResult?: WendooType | TypeRef<unknown> | EnumTypeRef;
    args?: ArgSpec[];
    /** Named, typed outputs this sensor exposes; each surfaces downstream as an inline value-tile written via \`setOutput\`. */
    outputs?: OutputSpec[];
    onExecute(ctx: Context, args: Record<string, unknown>): unknown;
    onPageEntered?(ctx: Context): void;
    onPageExited?(ctx: Context): void;
  }

  export interface ActuatorConfig {
    /** Stable identifier for this action, assigned automatically on first compile. Treat as opaque; do not edit or reuse. */
    id?: string;
    name: string;
    label?: string;
    icon?: string;
    docs?: string;
    tags?: string[];
    /** The words this actuator reads with in a rule's sentence. */
    language?: TileLanguageConfig;
    /**
     * Declares that this actuator consumes the rule's WHEN result, named by TypeRef
     * token (preferred) or type name. The editor uses it to offer and validate the
     * tile against the WHEN-result type. Declare it when \`onExecute\` reads
     * \`ctx.getWhenResult()\`.
     */
    consumesWhenResult?: WendooType | TypeRef<unknown> | EnumTypeRef;
    args?: ArgSpec[];
    onExecute(ctx: Context, args: Record<string, unknown>): void | Promise<void>;
    onPageEntered?(ctx: Context): void;
    onPageExited?(ctx: Context): void;
  }

  export function Sensor(config: SensorConfig): unknown;
  export function Actuator(config: ActuatorConfig): unknown;

  /**
   * Write one of the enclosing sensor's declared outputs for this evaluation.
   * \`name\` must be a string literal matching an entry of the sensor's
   * \`outputs\`; \`value\` is stored where the matching output tile reads it. Pass
   * \`null\` to clear an output. Valid only inside a sensor \`onExecute\`.
   */
  export function setOutput(ctx: Context, name: string, value: unknown): void;

  /**
   * Lifecycle config for a {@link System}. \`init\` and \`think\` plus any extra
   * methods run with \`this\` bound to the System's state \`S\` and its methods \`M\`.
   */
  export interface SystemConfig<S> {
    /** Display / debug name for this System. */
    name: string;
    /** Initial state: a plain object of VM-representable values (numbers, strings, booleans, small structs). */
    state: S;
    /** Runs once at brain startup, before any rule or think. \`this\` is the state and methods. */
    init?(ctx: Context): void;
    /** Runs every think, after rule evaluation, regardless of the active page. \`this\` is the state and methods. */
    think?(ctx: Context): void;
  }

  /**
   * Declare a System: one shared, brain-global singleton with persistent state,
   * a one-time \`init\`, a per-think \`think\`, and methods. Every reference to the
   * returned binding -- in this module or an importing one -- coordinates through
   * the single instance. Inside \`init\`/\`think\`/methods, \`this\` reads and writes
   * state fields and calls sibling methods.
   */
  export function System<S, M>(config: SystemConfig<S> & M & ThisType<S & M>): S & M;

  /**
   * Value token naming a registered Wendoo type. \`T\` is the TS-side value
   * type the token names; a surface that accepts a TypeRef infers its argument
   * and return types from the token.
   */
  export interface TypeRef<T> {
    readonly __typeRefBrand: T;
  }

  /** Token for the core \`number\` type. */
  export const NumberType: TypeRef<number>;
  /** Token for the core \`string\` type. */
  export const StringType: TypeRef<string>;
  /** Token for the core \`boolean\` type. */
  export const BooleanType: TypeRef<boolean>;
  /** Token for the core \`buffer\` type. */
  export const BufferType: TypeRef<Buffer>;

  /** Configuration for a {@link StructType} declaration. */
  export interface StructTypeConfig<F> {
    /** Display name (tiles, picker). */
    name: string;
    /** Field name -> field type, in declaration order; declaration order is storage order. */
    fields: F;
    /** When true, derive one accessor tile per field. */
    accessors?: boolean;
    /** When true, derive a "create variable" factory tile for the type. */
    variables?: boolean;
  }

  /** The TS value type a struct field type spec names. */
  type StructFieldValue<S> = S extends TypeRef<infer V>
    ? V
    : S extends keyof WendooTypeMap
      ? WendooTypeMap[S]
      : unknown;

  /** The TS object type of a struct instance, derived from a fields config. */
  type StructValueOf<F> = { -readonly [K in keyof F]: StructFieldValue<F[K]> };

  /**
   * Binding returned by a {@link StructType} declaration: a {@link TypeRef}
   * naming the declared type, and a callable factory constructing instances
   * (\`Position({x: 1, y: 2})\`).
   */
  export interface StructTypeBinding<T> extends TypeRef<T> {
    (init: T): T;
  }

  /**
   * Declare a struct type: a named record of typed fields usable across the
   * tile surface. The returned binding names the type wherever a TypeRef is
   * accepted and constructs instances when called. Every importer of the
   * binding resolves to the one declared type.
   */
  export function StructType<const F extends Record<string, TypeRef<unknown> | WendooType>>(
    config: StructTypeConfig<F>
  ): StructTypeBinding<StructValueOf<F>>;

  /** The TS instance type of a {@link StructType} binding: \`StructOf<typeof Position>\`. */
  export type StructOf<R> = R extends TypeRef<infer T> ? T : never;

  /** Configuration for a {@link Conversion} declaration. */
  export interface ConversionConfig<F, T> {
    /** Stable identifier for this conversion, assigned automatically on first compile. Treat as opaque; do not edit or reuse. */
    id?: string;
    /** Source type, named by an imported TypeRef token (preferred) or a type name. */
    from: TypeRef<F> | WendooType;
    /** Target type, named by an imported TypeRef token (preferred) or a type name. */
    to: TypeRef<T> | WendooType;
    /** Relative cost used to pick among conversion paths; a small positive integer. */
    cost: number;
    /** Computes the \`to\`-typed value from a \`from\`-typed value. Must be synchronous. */
    convert(value: F): T;
  }

  /**
   * Declare an implicit value conversion from \`from\`-typed values to
   * \`to\`-typed values. The brain compiler inserts it wherever a \`from\`-typed
   * value fills a \`to\`-expected slot; \`convert\` compiles as a user function
   * and runs once per inserted conversion. One declaration registers one
   * \`(from, to)\` pair program-wide.
   */
  export function Conversion<F, T>(config: ConversionConfig<F, T>): unknown;
}
`;

function isStructTypeDef(def: TypeDef): def is StructTypeDef {
  return def.coreType === NativeType.Struct;
}

function isNativeBacked(def: StructTypeDef): boolean {
  return def.fieldGetter !== undefined || def.fieldSetter !== undefined || def.snapshotNative !== undefined;
}

function typeDefToTs(def: TypeDef, registry: ITypeRegistry): string {
  if (def.nullable) {
    const baseDef = registry.get((def as NullableTypeDef).baseTypeId);
    if (!baseDef) return "unknown";
    return `${typeDefToTs(baseDef, registry)} | null`;
  }
  if (def.coreType === NativeType.Union) {
    const parts: string[] = [];
    (def as UnionTypeDef).memberTypeIds.forEach((mid) => {
      parts.push(typeIdToTs(mid, registry));
    });
    return parts.join(" | ");
  }
  switch (def.coreType) {
    case NativeType.Void:
      return "void";
    case NativeType.Nil:
      return "null";
    case NativeType.Boolean:
      return "boolean";
    case NativeType.Number:
      return "number";
    case NativeType.String:
      return "string";
    case NativeType.Buffer:
      return "Buffer";
    case NativeType.Any:
      return "WendooValue";
    case NativeType.Struct:
    case NativeType.Enum:
      return def.name;
    case NativeType.List: {
      const elemTs = typeIdToTs((def as ListTypeDef).elementTypeId, registry);
      return `Array<${elemTs}>`;
    }
    case NativeType.Map: {
      const mapDef = def as MapTypeDef;
      const keyTs = typeIdToTs(mapDef.keyTypeId, registry);
      const valTs = typeIdToTs(mapDef.valueTypeId, registry);
      return `Map<${keyTs}, ${valTs}>`;
    }
    case NativeType.Function: {
      const fnDef = def as FunctionTypeDef;
      if (fnDef.paramTypeIds) {
        const params: string[] = [];
        let i = 0;
        fnDef.paramTypeIds.forEach((pid) => {
          params.push(`arg${i}: ${typeIdToTs(pid, registry)}`);
          i++;
        });
        return `(${params.join(", ")}) => ${typeIdToTs(fnDef.returnTypeId, registry)}`;
      }
      return "Function";
    }
    default:
      return "unknown";
  }
}

function typeIdToTs(typeId: string, registry: ITypeRegistry): string {
  const def = registry.get(typeId);
  if (!def) return "unknown";
  return typeDefToTs(def, registry);
}

function needsQuoting(name: string): boolean {
  return !/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name);
}

function propertyName(name: string): string {
  return needsQuoting(name) ? JSON.stringify(name) : name;
}

function generateStructInterface(def: StructTypeDef, registry: ITypeRegistry): string {
  const nativeBacked = isNativeBacked(def);
  const hasPerFieldReadOnly = def.fields.some((f) => f.readOnly === true);
  const extension = def.name === "Context" ? " extends WendooPlatformContext" : "";
  let result = `  export interface ${def.name}${extension} {\n`;
  if (nativeBacked) {
    result += "    readonly __brand: unique symbol;\n";
  }
  def.fields.forEach((field) => {
    const tsType = typeIdToTs(field.typeId, registry);
    const fieldName = propertyName(field.name);
    const isReadOnly = hasPerFieldReadOnly ? field.readOnly === true : nativeBacked;
    const prefix = isReadOnly ? "readonly " : "";
    const optionalMark = field.optional === true ? "?" : "";
    result += `    ${prefix}${fieldName}${optionalMark}: ${tsType};\n`;
  });
  def.methods?.forEach((method) => {
    const params: string[] = [];
    method.params.forEach((p) => {
      params.push(`${p.name}${p.optional ? "?" : ""}: ${typeIdToTs(p.typeId, registry)}`);
    });
    const returnType = typeIdToTs(method.returnTypeId, registry);
    const fullReturn = method.isAsync ? `Promise<${returnType}>` : returnType;
    result += `    ${method.name}(${params.join(", ")}): ${fullReturn};\n`;
  });
  result += "  }\n";
  return result;
}

const CORE_TYPE_NAMES = new Set(["boolean", "number", "string", "void", "nil", "unknown", "any"]);

function isEnumTypeDef(def: TypeDef): def is EnumTypeDef {
  return def.coreType === NativeType.Enum;
}

function generateEnumType(def: EnumTypeDef): string {
  const members: string[] = [];
  def.symbols.forEach((sym) => {
    members.push(`"${sym.key}"`);
  });
  return `  export type ${def.name} = ${members.join(" | ") || "never"};\n`;
}

interface AmbientTypeDeclarationParts {
  typeDeclarations: string;
  typeMapEntries: string;
}

function buildAmbientDeclarationParts(
  registry: ITypeRegistry,
  includeDef: (def: TypeDef) => boolean
): AmbientTypeDeclarationParts {
  let typeDeclarations = "";
  let typeMapEntries = "";

  for (const [, def] of registry.entries()) {
    if (CORE_TYPE_NAMES.has(def.name)) continue;
    if (def.autoInstantiated) continue;
    if (def.name.includes("::")) continue;
    if (!includeDef(def)) continue;

    if (def.nullable) {
      const tsType = typeDefToTs(def, registry);
      typeMapEntries += `    ${propertyName(def.name)}: ${tsType};\n`;
    } else if (isStructTypeDef(def)) {
      typeDeclarations += generateStructInterface(def, registry);
      typeMapEntries += `    ${propertyName(def.name)}: ${def.name};\n`;
    } else if (isEnumTypeDef(def)) {
      typeDeclarations += generateEnumType(def);
      typeMapEntries += `    ${propertyName(def.name)}: ${def.name};\n`;
    } else if (
      def.coreType === NativeType.Boolean ||
      def.coreType === NativeType.Number ||
      def.coreType === NativeType.String
    ) {
      typeMapEntries += `    ${propertyName(def.name)}: ${typeDefToTs(def, registry)};\n`;
    } else if (def.coreType === NativeType.List) {
      const tsType = typeDefToTs(def, registry);
      typeDeclarations += `  export type ${def.name} = ${tsType};\n`;
      typeMapEntries += `    ${propertyName(def.name)}: ${def.name};\n`;
    }
  }

  return { typeDeclarations, typeMapEntries };
}

function buildAmbientDeclarationsFromRegistry(registry: ITypeRegistry): string {
  const parts = buildAmbientDeclarationParts(registry, () => true);
  return `${AMBIENT_HEADER}${AMBIENT_MODULE_START}${parts.typeMapEntries}  }\n\n${parts.typeDeclarations}${AMBIENT_MODULE_END}`;
}

function findField(def: StructTypeDef, name: string) {
  for (let i = 0; i < def.fields.size(); i++) {
    const field = def.fields.get(i);
    if (field.name === name) return field;
  }
  return undefined;
}

function hasMethod(def: StructTypeDef, name: string): boolean {
  if (!def.methods) return false;
  for (let i = 0; i < def.methods.size(); i++) {
    if (def.methods.get(i).name === name) return true;
  }
  return false;
}

function generateStructAugmentation(def: StructTypeDef, baseDef: StructTypeDef, registry: ITypeRegistry): string {
  let body = "";
  const hasPerFieldReadOnly = def.fields.some((f) => f.readOnly === true);
  def.fields.forEach((field) => {
    if (findField(baseDef, field.name) !== undefined) return;
    const tsType = typeIdToTs(field.typeId, registry);
    const fieldName = propertyName(field.name);
    const isReadOnly = hasPerFieldReadOnly ? field.readOnly === true : isNativeBacked(def);
    const prefix = isReadOnly ? "readonly " : "";
    const optionalMark = field.optional === true ? "?" : "";
    body += `    ${prefix}${fieldName}${optionalMark}: ${tsType};\n`;
  });
  def.methods?.forEach((method) => {
    if (hasMethod(baseDef, method.name)) return;
    const params: string[] = [];
    method.params.forEach((p) => {
      params.push(`${p.name}${p.optional ? "?" : ""}: ${typeIdToTs(p.typeId, registry)}`);
    });
    const returnType = typeIdToTs(method.returnTypeId, registry);
    const fullReturn = method.isAsync ? `Promise<${returnType}>` : returnType;
    body += `    ${method.name}(${params.join(", ")}): ${fullReturn};\n`;
  });
  if (body.length === 0) return "";
  return `  export interface ${def.name} {\n${body}  }\n`;
}

function buildStructAugmentations(baseRegistry: ITypeRegistry, platformRegistry: ITypeRegistry): string {
  let result = "";
  for (const [typeId, def] of platformRegistry.entries()) {
    if (!isStructTypeDef(def)) continue;
    const baseDef = baseRegistry.get(typeId);
    if (!baseDef || !isStructTypeDef(baseDef)) continue;
    result += generateStructAugmentation(def, baseDef, platformRegistry);
  }
  return result;
}

/** Generate the ambient `.d.ts` source that exposes the host's registered types and functions to the user-tile compiler. */
export function buildAmbientDeclarations(types: ITypeRegistry): string {
  return buildAmbientDeclarationsFromRegistry(types);
}

/** Generate the core ambient declaration file for a registry containing only core Wendoo types. */
export function buildCoreAmbientDeclarations(types: ITypeRegistry): string {
  return buildAmbientDeclarationsFromRegistry(types);
}

/** Options that restrict which platform declarations a generated ambient file carries. */
export interface PlatformAmbientOptions {
  /**
   * Predicate selecting which non-core platform types the file declares. When
   * omitted, every non-core platform type is included. Use it to partition a
   * platform surface across several declaration-merging layer files.
   */
  includeType?: (def: TypeDef) => boolean;
  /**
   * Whether to emit augmentations of core structs (for example `Context`).
   * Defaults to true; set false on a layer file that should not carry them.
   */
  includeAugmentations?: boolean;
}

/** Generate a platform ambient declaration file that augments the core Wendoo module declarations. */
export function buildPlatformAmbientDeclarations(
  baseTypes: ITypeRegistry,
  platformTypes: ITypeRegistry,
  options?: PlatformAmbientOptions
): string {
  const includeType = options?.includeType ?? (() => true);
  const includeAugmentations = options?.includeAugmentations ?? true;
  const parts = buildAmbientDeclarationParts(
    platformTypes,
    (def) => baseTypes.get(def.typeId) === undefined && includeType(def)
  );
  const augmentations = includeAugmentations ? buildStructAugmentations(baseTypes, platformTypes) : "";
  return `declare module "wendoo" {\n  interface WendooTypeMap {\n${parts.typeMapEntries}  }\n\n${parts.typeDeclarations}${augmentations}}\n`;
}
