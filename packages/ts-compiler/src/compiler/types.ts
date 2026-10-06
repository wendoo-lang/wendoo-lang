import type { BrainServices, DiagnosticSeverity, ITileLanguageMetadata } from "@wendoo/core/brain";
import type { ActionKind, ConstantOffsets, TypeId, UserActionArtifact } from "@wendoo/core/runtime";
import type ts from "typescript";
import type { TsDiagCode } from "./diag-codes.js";
import type { DependencyMount, ProjectDependency } from "./extension-mounts.js";

/** A diagnostic produced by any phase of the user-tile compiler. Lines and columns are 1-based when present. */
export interface CompileDiagnostic {
  code: TsDiagCode;
  message: string;
  severity: DiagnosticSeverity;
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
}

/** Compiler output for a single user tile: a {@link UserActionArtifact} extended with extracted descriptor metadata. */
export interface UserAuthoredProgram extends UserActionArtifact {
  /** Opaque stable identifier from the source declaration. */
  id: string;
  /** Namespace of the project that compiled this program; prefixes every symbol key minted from the project's content. */
  projectNamespace: string;
  name: string;
  args: ExtractedArgSpec[];
  debugMetadata?: DebugMetadata;
  label?: string;
  iconUrl?: string;
  docsMarkdown?: string;
  tags?: string[];
  /** Sentence words declared by the config's `language` group, forwarded to the generated tile def's `metadata.language`. */
  language?: ITileLanguageMetadata;
  /** When true (sensors only), the generated tile def is placement-inline; the picker offers it in value-slot positions. */
  inline?: boolean;
  /** When true (sensors only), sets the generated tile def's PresenceGated capability bit. */
  presenceGated?: boolean;
  /** Resolved {@link TypeId} of the WHEN result this tile consumes, forwarded to the generated tile def; undefined when not declared. */
  consumesWhenResult?: TypeId;
  /** Named, typed outputs declared on a sensor; each surfaces as a derived inline output value-tile. */
  outputs?: ExtractedOutput[];
  /** Struct types this program declares or imports; accessor and variable-factory tiles derive from them at registration. */
  structTypes?: ArtifactStructTypeInfo[];
}

/**
 * Surface definition of a user tile: the {@link UserAuthoredProgram} fields
 * that register the tile on the language surface (picker, brain typechecking,
 * placement), without the executable program fields. A `CompileResult`
 * carries one when the file's tile definition extracted and its declared
 * surface types resolved but no program compiled this session; the tile is
 * placeable, and a brain using it reports a link failure until the file
 * compiles.
 */
export type UserTileDefinition = Pick<
  UserAuthoredProgram,
  | "id"
  | "projectNamespace"
  | "key"
  | "kind"
  | "name"
  | "callDef"
  | "isAsync"
  | "outputType"
  | "consumesWhenResult"
  | "args"
  | "outputs"
  | "label"
  | "iconUrl"
  | "docsMarkdown"
  | "tags"
  | "language"
  | "inline"
  | "presenceGated"
  | "revisionId"
>;

/**
 * One user-declared struct type collected while compiling a program: the
 * registered type, its declared tile surface, and its fields. Registration
 * derives accessor tiles and the variable-factory tile from it,
 * register-if-absent by tile id.
 */
export interface ArtifactStructTypeInfo {
  /** Cross-module identity: `<namespace>:<declaring-file>::<binding-name>`. */
  identity: string;
  /** Display name from the config. */
  name: string;
  /** Registered struct {@link TypeId}. */
  typeId: string;
  /** When true, one accessor tile per field derives at registration. */
  accessors: boolean;
  /** When true, a "create variable" factory tile derives at registration. */
  variables: boolean;
  /** Declared fields in storage order. */
  fields: { name: string; typeId: string }[];
}

/** A {@link UserAuthoredProgram} plus the offsets at which the linker placed its functions, constants, and variables in the merged brain program. */
export interface LinkedUserProgram {
  program: UserAuthoredProgram;
  functionOffset: number;
  constantOffsets: ConstantOffsets;
  variableOffset: number;
  linkedDebugMetadata?: DebugMetadata;
}

/** Ambient declaration file supplied to the user-tile compiler. */
export interface AmbientFile {
  /** Workspace-visible path for the declaration file. */
  path: string;
  /** Full TypeScript declaration source. */
  content: string;
}

/**
 * A compilable `.ts` stdlib source module contributed by a target. It is
 * mounted in the compiler's virtual file map, resolvable as an importable
 * module, and lowered/emitted through the ordinary import pipeline when user
 * code imports it.
 */
export interface StdlibSourceFile {
  /**
   * Virtual `.ts` path at which the source is mounted. User code imports it by
   * this path minus the `.ts` extension (path `wendoo/microbit.ts` is
   * imported as `"wendoo/microbit"`).
   */
  path: string;
  /** Full TypeScript source. */
  content: string;
}

/** Options passed to the user-tile compiler. */
export interface CompileOptions {
  /** Namespace of the project being compiled (its store id, or an extension origin); prefixes every symbol key minted from the project's content. */
  projectNamespace: string;
  /** Ordered ambient declaration files available to the TypeScript compiler. */
  ambientFiles: readonly AmbientFile[];
  /** Compilable `.ts` stdlib source modules a target contributes, resolvable by user import. */
  stdlibFiles?: readonly StdlibSourceFile[];
  services: BrainServices;
  /** Mints a fresh stable action id when a source declaration has none. Defaults to a random opaque token. */
  generateActionId?: () => string;
  /** The project's extensions list: each entry maps an `@lib/<owner>/<repo>` coordinate to a dependency namespace. */
  dependencies?: readonly ProjectDependency[];
  /** Dependency projects' content mounted read-only into this compilation, transitively covering `dependencies`. */
  dependencyMounts?: readonly DependencyMount[];
  /**
   * Publish the entry module's exported name-keyed declarations under public
   * `<namespace>::<name>` keys and enforce the publication rules (single
   * published name, published type closure). Defaults to false.
   */
  publishEntry?: boolean;
  /**
   * When true, the project's source is read-only and regenerated on load (an
   * installed extension), so a minted stable `id` cannot be persisted. A
   * declaration missing an explicit `id` is then rejected with
   * {@link CompileDiagCode.ExtensionDeclarationMissingId}. Defaults to false: a
   * writable host project mints an id and rewrites the source.
   */
  readOnlySource?: boolean;
}

/** A 1-based source range produced by the descriptor extractor. */
export interface SourceSpan {
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

/** Descriptor extracted from a `Sensor({...})`, `Actuator({...})`, or `Conversion({...})` default export. */
export interface ExtractedDescriptor {
  kind: ActionKind;
  /** Stable id from the source `id` field, or `undefined` when the declaration omits it (the compiler then mints one). */
  id?: string;
  /** Absolute source offset just inside the config object's opening brace, where a minted `id` is inserted on write-back. */
  idInsertOffset: number;
  name: string;
  returnType: string | undefined;
  /** Unresolved `returnType` config reference; resolves to `returnType` during compilation. */
  returnTypeNode?: ts.Expression;
  /** The `onExecute` return type annotation node (Promise-unwrapped); set when `returnType` came from the annotation. */
  returnTypeAnnotation?: ts.TypeNode;
  /** Declared `consumesWhenResult` type name (sensor or actuator), or undefined when not declared. */
  consumesWhenResult?: string;
  /** Unresolved `consumesWhenResult` config reference; resolves to `consumesWhenResult` during compilation. */
  consumesWhenResultNode?: ts.Expression;
  args: ExtractedArgSpec[];
  execIsAsync: boolean;
  onExecuteNode: ts.FunctionExpression | ts.MethodDeclaration | ts.ArrowFunction;
  onPageEnteredNode: ts.MethodDeclaration | ts.FunctionExpression | ts.ArrowFunction | null;
  onPageExitedNode: ts.MethodDeclaration | ts.FunctionExpression | ts.ArrowFunction | null;
  label?: string;
  icon?: string;
  iconSpan?: SourceSpan;
  docs?: string;
  docsSpan?: SourceSpan;
  tags?: string[];
  /** Sentence words from the config's `language` group, or undefined when the config declares none. */
  language?: ITileLanguageMetadata;
  /** When true, the sensor reads inline in value slots; the generated tile is placement-inline (sensors only). */
  inline?: boolean;
  /** When true, a bare WHEN of this sensor gates on value presence, via the PresenceGated capability (sensors only). */
  presenceGated?: boolean;
  /** Output declarations from the `outputs` config field (sensors only). */
  outputs?: ExtractedOutput[];
  /** Conversion members from a `Conversion({...})` config (conversions only). `onExecuteNode` is the `convert` function. */
  conversion?: ExtractedConversionParts;
}

/**
 * The type-naming and cost members of a `Conversion({...})` config. The
 * `from`/`to` expressions are resolved to canonical type names during
 * compilation, where a type checker is available.
 */
export interface ExtractedConversionParts {
  fromNode: ts.Expression;
  toNode: ts.Expression;
  cost: number;
}

/**
 * One entry of a sensor's `outputs` config: a named, typed value the sensor
 * exposes as an inline output tile. The `(type, name)` pair is the output
 * identity; `type` is a declared type name resolved to a TypeId at registration.
 */
export interface ExtractedOutput {
  name: string;
  type: string;
  /** Unresolved `type` config reference; resolves to `type` during compilation. */
  typeNode?: ts.Expression;
  label?: string;
  icon?: string;
  docs?: string;
  tags?: string[];
  /**
   * When true, the output's value is a writable l-value: a brain may write a
   * field through the output's tile. Absent when the config declares none,
   * which reads as false.
   */
  writableResult?: boolean;
}

/** Modifier arg spec extracted from a `modifier(...)` call. */
export interface ExtractedModifier {
  kind: "modifier";
  id: string;
  label: string;
  icon?: string;
}

/** Parameter arg spec extracted from a `param(...)` call or a top-level `params` object. */
export interface ExtractedParam {
  kind: "param";
  name: string;
  type: string;
  /** Unresolved `type` config reference; resolves to `type` during compilation. */
  typeNode?: ts.Expression;
  defaultValue?: number | string | boolean | null;
  anonymous: boolean;
}

/** Tagged-union of arg spec shapes accepted by the descriptor extractor. */
export type ExtractedArgSpec =
  | ExtractedModifier
  | ExtractedParam
  | ExtractedChoice
  | ExtractedOptional
  | ExtractedRepeated
  | ExtractedConditional
  | ExtractedSeq;

/** Choice arg spec: any one of `items` may appear at the call site. */
export interface ExtractedChoice {
  kind: "choice";
  name?: string;
  items: ExtractedArgSpec[];
}

/** Optional arg spec: `item` may be omitted at the call site. */
export interface ExtractedOptional {
  kind: "optional";
  item: ExtractedArgSpec;
}

/** Repeated arg spec: `item` may appear between `min` and `max` times. */
export interface ExtractedRepeated {
  kind: "repeated";
  item: ExtractedArgSpec;
  min?: number;
  max?: number;
}

/** Conditional arg spec: `thenItem` is included when `condition` is satisfied at the call site, otherwise `elseItem`. */
export interface ExtractedConditional {
  kind: "conditional";
  condition: string;
  thenItem: ExtractedArgSpec;
  elseItem?: ExtractedArgSpec;
}

/** Sequence arg spec: `items` appear in order at the call site. */
export interface ExtractedSeq {
  kind: "seq";
  items: ExtractedArgSpec[];
}

/** Debug metadata for a compiled user-tile program: per-file source info and per-function PC mappings. */
export interface DebugMetadata {
  files: DebugFileInfo[];
  functions: DebugFunctionInfo[];
}

/** Identifies a source file referenced by debug spans. */
export interface DebugFileInfo {
  fileIndex: number;
  path: string;
  sourceHash: string;
}

/** Per-function debug info: spans, PC-to-span map, scopes, locals, and call/suspend sites. */
export interface DebugFunctionInfo {
  debugFunctionId: string;
  compiledFuncId: number;
  fileIndex: number;
  prettyName: string;
  isGenerated: boolean;
  sourceSpan: DebugSpan;
  spans: DebugSpan[];
  pcToSpanIndex: number[];
  scopes: ScopeInfo[];
  locals: LocalInfo[];
  callSites: CallSiteInfo[];
  suspendSites: SuspendSiteInfo[];
}

/** A source-position range tagged with a `spanId` and a flag marking statement boundaries. */
export interface DebugSpan {
  spanId: number;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  isStatementBoundary: boolean;
}

/** A lexical scope for debug inspection: function, block, module, or brain. */
export interface ScopeInfo {
  scopeId: number;
  kind: "function" | "block" | "module" | "brain";
  parentScopeId: number | null;
  startPc: number;
  endPc: number;
  name: string | null;
}

/** A local variable's slot, scope, lifetime, and (optional) static type hint for debug inspection. */
export interface LocalInfo {
  name: string;
  slotIndex: number;
  storageKind: "local" | "parameter" | "capture";
  scopeId: number;
  lifetimeStartPc: number;
  lifetimeEndPc: number;
  typeHint: string | null;
}

/** Identifies a `Call` instruction at PC `pc`, with the target function (when known) and async flag. */
export interface CallSiteInfo {
  pc: number;
  callSiteId: number;
  targetDebugFunctionId: string | null;
  isAsync: boolean;
}

/** Identifies the PC range and source span surrounding an `await` site. */
export interface SuspendSiteInfo {
  awaitPc: number;
  resumePc: number;
  sourceSpan: DebugSpan;
}
