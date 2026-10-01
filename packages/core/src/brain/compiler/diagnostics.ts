import { Error } from "../../platform/error";
import type { ReadonlyList } from "../../platform/list";
import type { LinkedBrainProgram } from "../../runtime";
import type { RuleSide } from "../interfaces";

/**
 * Diagnostic codes for brain compiler errors and warnings.
 *
 * Each diagnostic has a unique numeric code (similar to TypeScript's "ts(xxxx)").
 * Codes are organized by subsystem:
 * - 1000-1999: Parser diagnostics
 * - 2000-2999: Type inference diagnostics
 * - 3000-3999: Code-generation diagnostics
 * - 4000-4999: Link diagnostics
 *
 * These codes enable programmatic handling of diagnostics, such as:
 * - Displaying context-specific suggestions in the UI
 * - Suppressing specific diagnostic types
 * - Analytics and error tracking
 */

/**
 * Parser diagnostic codes (1000-1999)
 */
export enum ParseDiagCode {
  /** Unexpected token found after when expression */
  UnexpectedTokenAfterExpression = 1000,

  /** Expected expression but found end of input */
  ExpectedExpressionFoundEOF = 1001,

  /** Unexpected action call after expression */
  UnexpectedActionCallAfterExpression = 1002,

  /** Unexpected expression after previous expression */
  UnexpectedExpressionAfterExpression = 1003,

  /** Expected sensor or actuator but found different token kind */
  ExpectedSensorOrActuator = 1004,

  /** Failed to parse action call - required arguments missing or invalid */
  ActionCallParseFailure = 1005,

  /** Unexpected action call kind */
  UnexpectedActionCallKind = 1006,

  /** Expected expression but found end of input in sub-expression */
  ExpectedExpressionInSubExpr = 1007,

  /** Unexpected token kind in expression */
  UnexpectedTokenKindInExpression = 1008,

  /** Unexpected operator in expression context */
  UnexpectedOperatorInExpression = 1009,

  /** Expected closing parenthesis */
  ExpectedClosingParen = 1010,

  /** Unexpected control flow token in expression */
  UnexpectedControlFlowInExpression = 1011,

  /** Unknown operator reference */
  UnknownOperator = 1012,

  /** Invalid assignment target (left-hand side must be a variable or field access) */
  InvalidAssignmentTarget = 1013,

  /** Assignment to a read-only field access */
  ReadOnlyFieldAssignment = 1014,

  /** Assignment to a field of a read-only base value (e.g. a sensor result) */
  ReadOnlyResultFieldAssignment = 1015,

  /** Tile placed on a rule side its placement flags do not allow */
  TilePlacementSideMismatch = 1016,

  /** Output value tile with no sensor providing its output key in the rule hierarchy */
  OutputTileMissingProvider = 1017,

  /** Tile whose required capabilities no tile in the rule hierarchy provides */
  TileRequirementsNotProvided = 1018,

  /** Tile requiring a WHEN result placed where no compatible WHEN result is available */
  TileWhenResultUnavailable = 1019,

  /** Tile reporting on the preceding sibling rule placed in the first rule at its level, which has none */
  NoPrecedingSiblingRule = 1020,

  /** Rule carrying the `otherwise` trigger mode placed first at its level, where it has no rule to complement */
  OtherwiseTriggerNoPrecedingSiblingRule = 1021,

  /** Rule carrying the `then` trigger mode placed first at its level, where it has no rule to follow */
  ThenTriggerNoPrecedingSiblingRule = 1022,

  /** Free slot -- available for reuse. */
  Unused1023 = 1023,
}

/**
 * Type inference diagnostic codes (2000-2999)
 */
export enum TypeDiagCode {
  /** No overload found for binary operator with given argument types */
  NoOverloadForBinaryOp = 2000,

  /** No overload found for unary operator with given argument type */
  NoOverloadForUnaryOp = 2001,

  /** Type mismatch between inferred type and expected type */
  DataTypeMismatch = 2002,

  /** Tile type mismatch for a given tile ID reference */
  TileTypeMismatch = 2003,

  /** Tile not found for a given tile ID reference */
  TileNotFound = 2004,

  /** Data type conversion applied to match expected type */
  DataTypeConverted = 2005,

  /** Field accessor applied to a base expression of a different type */
  AccessorBaseTypeMismatch = 2006,
}

/**
 * Compilation diagnostic codes (3000-3999)
 */
export enum CompilationDiagCode {
  /** Missing type information for node during compilation */
  MissingTypeInfo = 3000,

  /** No overload found for operator during code generation */
  MissingOperatorOverload = 3001,

  /**
   * Code generation reached an expression it cannot compile and stood an absent
   * value in its place, so an argument slot the expression filled arrives
   * unsupplied and a rule side the expression was the whole of evaluates to
   * absent -- a WHEN that does not fire, a DO that does nothing. Emitted at
   * "warning" severity: the surrounding program still compiles, links, and runs.
   * The message names the rule path, the rule side, and the tile the dropped
   * expression starts at when one resolves.
   */
  UncompilableExpressionDropped = 3002,

  /**
   * Two variable tiles share a name but declare different data types, and the
   * compiler gave them one slot. The slot takes the type of the first
   * occurrence in compilation order, including that type's starting value; the
   * later occurrence reads and writes the same slot at its own declared type.
   * Emitted at "warning" severity: the program still compiles, links, and
   * runs. `params` names the variable and both type ids.
   */
  VariableTypeConflict = 3003,

  /**
   * A text literal or a variable name is longer than a compiled program can
   * carry: its UTF-8 encoding exceeds the bytecode string limit
   * (`kMaxLongStringLength` bytes). Emitted at "error" severity, so the build
   * produces no program. `params` names the rule path and the rule side; the
   * message does not quote the string.
   */
  StringTooLarge = 3004,
}

/**
 * Link diagnostic codes (4000-4999).
 *
 * `MissingActionBinding` is also emitted at compile time: the compiler resolves
 * each action's binding to choose its call opcode, so an action with no binding
 * in the environment is reported there rather than at link. The code is shared
 * because the condition is the same regardless of which phase detects it.
 */
export enum LinkDiagCode {
  /** Brain references an action with no descriptor in the catalog */
  MissingActionDescriptor = 4000,

  /**
   * Action has a descriptor but no binding resolves in the environment.
   * Emitted at compile time (binding resolution) and at link time.
   */
  MissingActionBinding = 4001,

  /** A resolved user-tile bytecode artifact is malformed or signature-mismatched */
  InvalidActionArtifact = 4002,
}

/**
 * Union type of all diagnostic codes for type safety
 */
export type DiagCode = ParseDiagCode | TypeDiagCode | CompilationDiagCode | LinkDiagCode;

/** Severity classification for a diagnostic. */
export type DiagnosticSeverity = "error" | "warning" | "info";

/**
 * Machine-readable values a diagnostic's `message` interpolates. A diagnostic
 * populates only the fields its own message names; a message that interpolates
 * nothing carries no params at all.
 */
export interface DiagParams {
  /** Stable id of the tile the diagnostic is about. */
  readonly tileId?: string;

  /** Display label of {@link tileId}, falling back to the tile's id when it has no label. */
  readonly tileLabel?: string;

  /** `kind` discriminator of the tile the diagnostic is about, for example "sensor". */
  readonly tileKind?: string;

  /** Rule side the offending tile sits on. */
  readonly side?: RuleSide;

  /** `pageIndex/ruleIndex[/childIndex...]` path of the rule the diagnostic is about. */
  readonly rulePath?: string;

  /** Id of the operator the diagnostic is about. */
  readonly operatorId?: string;

  /** Id of the control-flow tile the diagnostic is about. */
  readonly controlFlowId?: string;

  /** Machine name of the struct field the diagnostic is about. */
  readonly fieldName?: string;

  /** Display label of {@link fieldName}, falling back to the field's name. */
  readonly fieldLabel?: string;

  /** Output identity key (see `mkOutputVarKey`) the diagnostic is about. */
  readonly outputKey?: string;

  /** Tile ids of the sensors that would satisfy the unmet requirement, in catalog order. */
  readonly providerTileIds?: ReadonlyList<string>;

  /** Type ids accepted at the reported position. */
  readonly expectedTypeIds?: ReadonlyList<string>;

  /** Type ids the reported expression actually produced. */
  readonly actualTypeIds?: ReadonlyList<string>;

  /** Path cost of the conversion that was applied. */
  readonly conversionCost?: number;

  /** Key of the action the diagnostic is about. */
  readonly actionKey?: string;

  /** Name of the brain variable the diagnostic is about. */
  readonly varName?: string;
}

/**
 * Severity `code` carries everywhere it is reported: "error" blocks producing a
 * program, "warning" reports degraded output that still compiles, and "info"
 * reports a resolution the compiler made silently. Classify a rule's edit-time
 * parse and type diagnostics with this to decide error-versus-informational
 * without compiling and linking the whole brain; the answer matches the
 * severity the build result carries for the same code.
 *
 * A code the pipeline does not classify is reported as an error.
 */
export function diagnosticSeverity(code: DiagCode): DiagnosticSeverity {
  switch (code) {
    case TypeDiagCode.DataTypeConverted:
      return "info";

    case ParseDiagCode.UnexpectedTokenAfterExpression:
    case ParseDiagCode.ExpectedExpressionFoundEOF:
    case ParseDiagCode.UnexpectedActionCallAfterExpression:
    case ParseDiagCode.UnexpectedExpressionAfterExpression:
    case ParseDiagCode.ExpectedSensorOrActuator:
    case ParseDiagCode.ActionCallParseFailure:
    case ParseDiagCode.UnexpectedActionCallKind:
    case ParseDiagCode.ExpectedExpressionInSubExpr:
    case ParseDiagCode.UnexpectedTokenKindInExpression:
    case ParseDiagCode.UnexpectedOperatorInExpression:
    case ParseDiagCode.ExpectedClosingParen:
    case ParseDiagCode.UnexpectedControlFlowInExpression:
    case ParseDiagCode.UnknownOperator:
    case ParseDiagCode.InvalidAssignmentTarget:
    case ParseDiagCode.ReadOnlyFieldAssignment:
    case ParseDiagCode.ReadOnlyResultFieldAssignment:
      return "warning";

    case TypeDiagCode.NoOverloadForBinaryOp:
    case TypeDiagCode.NoOverloadForUnaryOp:
    case TypeDiagCode.DataTypeMismatch:
    case TypeDiagCode.TileTypeMismatch:
    case TypeDiagCode.TileNotFound:
      return "warning";

    case CompilationDiagCode.UncompilableExpressionDropped:
    case CompilationDiagCode.VariableTypeConflict:
      return "warning";

    default:
      return "error";
  }
}

/** A diagnostic produced while compiling and linking a brain definition. */
export interface BrainBuildDiagnostic {
  /** Stable diagnostic code. */
  readonly code: DiagCode;

  /** An "error" blocks producing a program; "warning"/"info" do not. */
  readonly severity: DiagnosticSeverity;

  /** Human-readable description of the diagnostic. */
  readonly message: string;

  /** Machine-readable values {@link message} interpolates; absent when it interpolates none. */
  readonly params?: DiagParams;
}

/**
 * Result of a brain build step: the produced program and any diagnostics.
 * `program` is present if and only if `diagnostics` contains no "error"-severity
 * entries. `TProgram` is the unlinked program during compilation and the linked
 * program after linking.
 */
export interface BrainBuildResult<TProgram = LinkedBrainProgram> {
  readonly program?: TProgram;
  readonly diagnostics: ReadonlyList<BrainBuildDiagnostic>;
}

/**
 * Thrown by brain runtime construction ({@link WendooEnvironment.createBrain})
 * when the brain has error-severity diagnostics.
 */
export class BrainBuildError extends Error {
  constructor(
    message: string,
    readonly diagnostics: ReadonlyList<BrainBuildDiagnostic>
  ) {
    super(message);
    this.name = "BrainBuildError";
  }
}

/** True when `value` is a {@link BrainBuildError}. */
export function isBrainBuildError(value: unknown): value is BrainBuildError {
  return value instanceof BrainBuildError;
}

/** Builds a human-readable summary of the error-severity diagnostics for a {@link BrainBuildError} message. */
export function summarizeBrainBuildDiagnostics(diagnostics: ReadonlyList<BrainBuildDiagnostic>): string {
  let count = 0;
  let firstMessage = "";
  for (let i = 0; i < diagnostics.size(); i++) {
    const diag = diagnostics.get(i)!;
    if (diag.severity === "error") {
      count++;
      if (firstMessage === "") {
        firstMessage = diag.message;
      }
    }
  }
  if (count === 0) {
    return "Brain build failed.";
  }
  if (count === 1) {
    return `Brain build failed: ${firstMessage}`;
  }
  return `Brain build failed (${count} errors): ${firstMessage}`;
}
