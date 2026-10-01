// Context and types

export type { BrainCommand } from "@wendoo/core/brain/model";
// Commands (relocated to @wendoo/core/brain/model; re-exported for API stability)
export {
  AddPageCommand,
  AddTileCommand,
  BrainCommandHistory,
  DeleteRuleCommand,
  IndentRuleCommand,
  InsertRuleCommand,
  InsertTileCommand,
  MoveRuleDownCommand,
  MoveRuleUpCommand,
  OutdentRuleCommand,
  PasteRulesCommand,
  PasteTileBeforeCommand,
  RemovePageCommand,
  RemoveTileCommand,
  RenameBrainCommand,
  RenamePageCommand,
  RenameVariableCommand,
  ReplaceBrainCommand,
  ReplaceLastPageCommand,
  ReplaceTileCommand,
} from "@wendoo/core/brain/model";
// Action call-spec arg entries
export type {
  AcceleratorBinding,
  AcceleratorClaim,
  AcceleratorContribution,
  AcceleratorModifier,
  AcceleratorPlatform,
  LiveAcceleratorSection,
} from "./accelerators";
// Documented accelerators, filtered to the mode the editor stands in
export {
  acceleratorChips,
  acceleratorKeyName,
  acceleratorModifierName,
  acceleratorPlatform,
  acceleratorsForMode,
  kAcceleratorContributions,
  liveAcceleratorSection,
} from "./accelerators";
export type { ActionArgEntry, ActionArgTileEntry, ActionArgTypeEntry, TypeDisplaySources } from "./action-arg-tiles";
export { getActionArgEntries, resolveTypeDisplayName } from "./action-arg-tiles";
export type { BrainEditorConfig, CustomLiteralType } from "./BrainEditorContext";
export {
  BrainEditorProvider,
  useBrainEditorConfig,
  useLocalizer,
  useOptionalBrainEditorConfig,
  useTr,
} from "./BrainEditorContext";
export type { BrainEditorDialogProps, ContinuousBrainEditorDialogProps } from "./BrainEditorDialog";
// Components
export { BrainEditorDialog } from "./BrainEditorDialog";
export type { RuleReveal } from "./BrainPageEditor";
export { BrainPageEditor } from "./BrainPageEditor";
export { BrainPrintDialog } from "./BrainPrintDialog";
export { BrainPrintTextView } from "./BrainPrintTextView";
export { BrainPrintView } from "./BrainPrintView";
export { BrainRuleEditor } from "./BrainRuleEditor";
export { BrainPrintRuleSentence, BrainRuleSentence } from "./BrainRuleSentence";
export { BrainTile } from "./BrainTile";
export { BrainTileEditor } from "./BrainTileEditor";
export {
  copyBrainToClipboard,
  getBrainFromClipboard,
  hasBrainInClipboard,
  onBrainClipboardChanged,
} from "./brain-clipboard";
export { CreateLiteralDialog } from "./CreateLiteralDialog";
export { CreateVariableDialog } from "./CreateVariableDialog";
export { DisplayFormatPicker } from "./DisplayFormatPicker";
// What the side region's tenant edits: the standing working copy and its history
export type { EditedBrain, EditedBrainPlace } from "./EditedBrainContext";
export { EditedBrainProvider, useEditedBrain } from "./EditedBrainContext";
export { EditLiteralFormatDialog } from "./EditLiteralFormatDialog";
export type { EditorArmingFacts, EditorMode, EditorModeFacts } from "./editor-mode";
// The one derived value naming the editor's keyboard context
export { deriveEditorMode, kEditorModes } from "./editor-mode";
// Hooks
export { useRuleCapabilities, useRuleOutputKeys } from "./hooks/useRuleCapabilities";
export { useTileSelection } from "./hooks/useTileSelection";
export { RenameVariableDialog } from "./RenameVariableDialog";
// Clipboard utilities
export {
  copyRuleToClipboard,
  deserializeAllRulesFromClipboard,
  deserializeRuleFromClipboard,
  hasRuleInClipboard,
  onClipboardChanged,
} from "./rule-clipboard";
// What marks the region the rules lay out in
export { kBrainRulesAttribute } from "./rules-region";
// Sentence projection consumption
export type { SentenceSegmentIdentity } from "./sentence-reflection";
export { changedSentenceSegments, sentenceSegmentIdentities } from "./sentence-reflection";
export { TileValue } from "./TileValue";
export type { TileBadge } from "./tile-badges";
// Tile badges
export { buildNodeMap, computeTileBadges } from "./tile-badges";
export {
  copyTileToClipboard,
  hasTileInClipboard,
  importTileFromClipboard,
  onTileClipboardChanged,
} from "./tile-clipboard";
export type { LibraryTileCluster, LibraryTileGroups, TileSourceLibrary } from "./tile-library-groups";
// Library attribution
export { groupTilesByLibrary, tileSourceNamespace } from "./tile-library-groups";
export { formatValue } from "./tile-value-utils";
export type { TileColorDef, TileVisual } from "./types";
