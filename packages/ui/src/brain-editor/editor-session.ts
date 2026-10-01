import type { ReadonlyList } from "@wendoo/core";
import type { ITileCatalog } from "@wendoo/core/brain";
import {
  type BrainCommandHistory,
  type BrainDef,
  BrainEditOrigin,
  ReplaceBrainCommand,
} from "@wendoo/core/brain/model";

/**
 * A separate brain holding what `brainDef` holds right now, carrying its id,
 * with every tile no page places dropped from its catalog. Later edits to
 * `brainDef` do not reach it, and `brainDef` itself is left untouched.
 */
export function detachedBrainSnapshot(brainDef: BrainDef): BrainDef {
  const snapshot = brainDef.workingCopy();
  snapshot.purgeUnusedTiles();
  return snapshot;
}

/**
 * Report every edit made through `history` to `onChange`: each command, undo,
 * redo and cleared history run by the person or by a tool call. Changes run
 * under {@link BrainEditOrigin.Editor} report nothing, and neither does a
 * command joining a batch still open; the batch reports once as it closes,
 * whether it is ended or aborted. A change while `readBrain` returns undefined
 * reports nothing.
 *
 * `onChange` is handed a function taking a {@link detachedBrainSnapshot} of the
 * brain `readBrain` returned at the change, read when the function is called.
 *
 * @returns A function that stops the reporting.
 */
export function watchBrainEdits(
  history: BrainCommandHistory,
  readBrain: () => BrainDef | undefined,
  onChange: (snapshot: () => BrainDef) => void
): () => void {
  return history.onChange((origin) => {
    if (origin === BrainEditOrigin.Editor || history.isBatchOpen()) return;
    const brainDef = readBrain();
    if (brainDef === undefined) return;
    onChange(() => detachedBrainSnapshot(brainDef));
  });
}

/**
 * Replace everything `brainDef` holds with what `replacement` holds, as one
 * undoable step on `history`. `brainDef` keeps its own id, and takes on the
 * persisted references `replacement` carries so its unresolved tiles keep
 * their persisted identity.
 *
 * @param extraCatalogs - Catalogs the replaced content resolves tiles against;
 *   `brainDef`'s own when omitted.
 */
export function replaceBrainContent(
  history: BrainCommandHistory,
  brainDef: BrainDef,
  replacement: BrainDef,
  extraCatalogs?: ReadonlyList<ITileCatalog>
): void {
  const refs = brainDef.persistedIdRefs();
  replacement.persistedIdRefs().forEach((ref, id) => {
    refs.set(id, ref);
  });
  history.executeCommand(new ReplaceBrainCommand(brainDef, replacement.toJson(), extraCatalogs));
}

/**
 * A control the brain editor's footer stands.
 *
 * - `cancel` -- closes without handing the edits over, through the discard confirmation
 * - `submit` -- hands the edited brain to the host
 * - `close` -- closes, the host already holding every edit
 */
export type BrainEditorFooterControl = "cancel" | "submit" | "close";

/** The chrome a brain editing session stands. */
export interface BrainEditorChrome {
  /** The footer's controls, in the order they stand. */
  readonly footerControls: readonly BrainEditorFooterControl[];
  /** True when closing with edits standing first asks to discard them. */
  readonly closeConfirmsDiscard: boolean;
}

const kModalChrome: BrainEditorChrome = { footerControls: ["cancel", "submit"], closeConfirmsDiscard: true };
const kContinuousChrome: BrainEditorChrome = { footerControls: ["close"], closeConfirmsDiscard: false };

/**
 * The chrome the session `props` ask for: a continuous one when `continuous`
 * is true, and a modal one otherwise.
 */
export function brainEditorChrome(props: { readonly continuous?: boolean }): BrainEditorChrome {
  return props.continuous === true ? kContinuousChrome : kModalChrome;
}
