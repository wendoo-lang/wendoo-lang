export type { CatalogDigest } from "./catalog/digest.js";
export { catalogDigest, languageGrammarLegend } from "./catalog/digest.js";
export {
  CATALOG_TEXT_LIMITS,
  sanitizeCatalogText,
  sanitizeCatalogTile,
  TRUNCATION_MARKER,
} from "./catalog/sanitize.js";
export { CatalogScope } from "./catalog/scope.js";
export type {
  ExcludedRule,
  RuleTotals,
  RunSummaryContext,
  ThinkSummary,
  TraceSpan,
  TraceSummary,
} from "./simulate/summarizer.js";
export { summarizeRun } from "./simulate/summarizer.js";
export type {
  AdapterArtifactResult,
  AdapterExpectation,
  AdapterNonconformance,
  CoreBuild,
  DispatchObservation,
  GateObservation,
  OperationEnding,
  PageSwitchObservation,
  ScenarioInput,
  ScenarioInputKind,
  SimulationRequest,
  SimulationRun,
  SimulationScenario,
  SubjectStateChannel,
  TargetAdapter,
  TargetBuildStamp,
  TargetManifest,
  ThinkObservation,
  WorldObservation,
} from "./target/adapter.js";
export {
  ADAPTER_CONTRACT_VERSION,
  AdapterNonconformanceCode,
  adapterMethods,
  adapterNonconformance,
  DispatchOutcome,
  readAdapterArtifact,
  readBuildStamp,
} from "./target/adapter.js";
export type { DeclaredSurface } from "./target/declared-surface.js";
export {
  DECLARED_SURFACE_FORMAT_VERSION,
  declaredSurfaceOf,
  declaredSurfaceSchema,
} from "./target/declared-surface.js";
export type { CompileDiagnostic, CompileResult } from "./tools/compile.js";
export { compileBrain } from "./tools/compile.js";
export type {
  DiagnosticRuleSideName,
  DiagParamValue,
  SerializedDiagParams,
  ToolDiagnostic,
} from "./tools/diagnostics.js";
export { ruleSideName, serializeDiagParams, toToolDiagnostic } from "./tools/diagnostics.js";
export type { ToolCallError, ToolCallOutcome } from "./tools/dispatch.js";
export { executeToolCall, isToolName, ToolCallErrorCode } from "./tools/dispatch.js";
export type { CatalogFeaturing } from "./tools/featuring.js";
export { admitsLongFormDocs } from "./tools/featuring.js";
export type { LibraryOffered, LibraryOfferView } from "./tools/offer-libraries.js";
export { LibraryOfferUnknownCode, LibraryOfferVerdict, offerLibraries } from "./tools/offer-libraries.js";
export type {
  BatchAccepted,
  BatchResult,
  EditOutcome,
  ProposalAccepted,
  ProposalRejected,
  ProposalResult,
  ProposalUnresolved,
} from "./tools/propose-edit.js";
export { batchReplayStepMs, proposeEdit, proposeEditBatch, resolveRunEntry } from "./tools/propose-edit.js";
export type { CatalogGroup, CatalogTile, CatalogView } from "./tools/read-catalog.js";
export { catalogTiles, catalogTilesInScope, readCatalog } from "./tools/read-catalog.js";
export type { LibraryShelfEntry, LibraryShelfView } from "./tools/read-libraries.js";
export { readLibraries } from "./tools/read-libraries.js";
export type { ProjectPage, ProjectPageRef, ProjectRule, ProjectTile, ProjectView } from "./tools/read-project.js";
export { readProject, readRule } from "./tools/read-project.js";
export type { PolicyDecision, ProposalPolicyEntry, ProposalVerdict } from "./tools/rejection-policy.js";
export { acceptedDiagCodes, decideProposal, proposalPolicy, proposalVerdict } from "./tools/rejection-policy.js";
export type {
  SimulationBlockedResult,
  SimulationInputKindResult,
  SimulationResult,
  SimulationSubjectResult,
  SimulationSummaryResult,
} from "./tools/simulate.js";
export { simulate } from "./tools/simulate.js";
export type { SuggestedTile, SuggestionError, SuggestionView } from "./tools/suggest-tiles.js";
export { suggestTiles } from "./tools/suggest-tiles.js";
export type { SessionTileDocs } from "./tools/tile-descriptions.js";
export { descriptionFromMarkdown, sessionTileDocs } from "./tools/tile-descriptions.js";
export type {
  ProposeEditBatchInput,
  ProposeEditInput,
  RuleSideName,
  TileRunEntry,
  ToolDefinition,
  ToolInput,
  ToolName,
} from "./tools/tool-schemas.js";
export {
  batchRuleIndex,
  maxBatchCommands,
  scenarioInputSchema,
  tileRunEntrySchema,
  toolDefinitions,
  toolInputSchemas,
} from "./tools/tool-schemas.js";
export type {
  AuthoringWorkspace,
  AuthoringWorkspaceOptions,
  BrainEditHistory,
  LandedEdit,
  LocatedRule,
  ScopedTileCatalog,
  ScopedTiles,
} from "./tools/workspace.js";
export {
  allTiles,
  createAuthoringWorkspace,
  findPage,
  findRule,
  findTile,
  isNestedRulePath,
  locateRules,
  ruleIdsByPath,
  scopedCatalogs,
  tileCatalogsOf,
  tilesByScope,
  toRuleSide,
} from "./tools/workspace.js";
