import { List } from "@wendoo/core";
import {
  AddPageCommand,
  AddRuleCommand,
  BrainCommandHistory,
  BrainDef,
  BrainEditOrigin,
  type BrainPageDef,
  brainJsonFromPlain,
  deserializePersistedBrainJson,
  encodePersistedBrainJson,
  RemovePageCommand,
  RenameBrainCommand,
  RenamePageCommand,
  ReplaceBrainCommand,
  ReplaceLastPageCommand,
} from "@wendoo/core/brain/model";
import {
  BookOpen,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ClipboardPaste,
  Copy,
  Download,
  Minus,
  MoreVertical,
  PanelLeft,
  Pencil,
  Plus,
  Printer,
  Redo,
  RotateCcw,
  Save,
  Undo,
  Upload,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { staticAssetUrl } from "../asset-url";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Input } from "../ui/input";
import { Slider } from "../ui/slider";
import { ArmedTargetProvider, useArmedTargetState } from "./ArmedTargetContext";
import { keyboardIsInCandidateStrip } from "./BrainCandidateStrip";
import { useBrainEditorConfig } from "./BrainEditorContext";
import { BrainEditorSidePanel } from "./BrainEditorSidePanel";
import { BrainPageEditor, type RuleReveal } from "./BrainPageEditor";
import { BrainPrintDialog } from "./BrainPrintDialog";
import { LatchedBrainRulesRegion } from "./BrainRulesRegion";
import {
  copyBrainToClipboard,
  getBrainFromClipboard,
  hasBrainInClipboard,
  onBrainClipboardChanged,
} from "./brain-clipboard";
import { hasDiscardableEdits } from "./discard-guard";
import { type EditedBrainPlace, EditedBrainProvider } from "./EditedBrainContext";
import { kDialogChromeLayer } from "./editor-layers";
import { deriveEditorMode, type EditorMode } from "./editor-mode";
import {
  editorContentStands,
  kEditorContentAttribute,
  returnFocusChain,
  returnFocusTarget,
  takeReturnFocus,
} from "./editor-return-focus";
import {
  type BrainEditorFooterControl,
  brainEditorChrome,
  detachedBrainSnapshot,
  replaceBrainContent,
  watchBrainEdits,
} from "./editor-session";
import { decideHistoryShortcut } from "./history-shortcut";
import { takePageGridKeyboard } from "./page-grid-selection";
import { RulePickupProvider, useRulePickupState } from "./RulePickupContext";
import { kSidePanelLayoutClasses, kSidePanelRegionId, sidePanelToggleLabel } from "./side-panel";

// Top-edge brand accent. Uses each app's signature strip tokens when defined
// (microbit-sim's blue->green->teal), else falls back to the brand primary/ring
// so single-brand apps (apps/ecosim) still get a branded accent line.
const brandStripBackground =
  "linear-gradient(90deg, var(--strip-blue, var(--color-primary)) 0%, var(--strip-green, var(--color-ring)) 50%, var(--strip-teal, var(--color-primary)) 100%)";

/** True when no page of `brainDef` holds a rule. */
function brainHoldsNoRule(brainDef: BrainDef): boolean {
  const pages = brainDef.pages();
  for (let index = 0; index < pages.size(); index++) {
    if (pages.get(index).children().size() > 0) return false;
  }
  return true;
}

/** What every host of {@link BrainEditorDialog} passes, whichever kind of session it stands. */
interface BrainEditorDialogCommonProps {
  /** True while the editor stands open. Opening it stands a fresh working copy of `srcBrainDef`. */
  isOpen: boolean;
  /** Called with false when the editor closes itself: from its footer, on Escape, or once a discard is confirmed. */
  onOpenChange: (open: boolean) => void;
  /** The brain to edit. The editor edits a working copy carrying its id, never this brain itself. */
  srcBrainDef?: BrainDef;
  /**
   * Called after each edit the person or a tool call makes -- each command,
   * undo and redo, with a batch counting once as it closes -- and never for the
   * editor's own changes as it opens and closes. `snapshot` returns a detached
   * copy of the working copy as it stands when called, its unused tiles purged.
   */
  onChange?: (snapshot: () => BrainDef) => void;
}

/**
 * Props for a modal {@link BrainEditorDialog}: edits reach the host when the
 * user confirms them, and closing any other way discards them.
 */
export interface BrainEditorDialogProps extends BrainEditorDialogCommonProps {
  /** Absent or false for a modal session. */
  continuous?: false;
  /** Called with a detached copy of the edited brain, its unused tiles purged, when the user confirms. */
  onSubmit: (newBrainDef: BrainDef) => void;
}

/**
 * Props for a continuous {@link BrainEditorDialog}: every edit reaches the host
 * through `onChange` as it is made, and closing hands nothing over and
 * discards nothing.
 */
export interface ContinuousBrainEditorDialogProps extends BrainEditorDialogCommonProps {
  /** True for a continuous session. */
  continuous: true;
  /** Called after each edit, as in any session; a continuous session's edits reach the host through it. */
  onChange: (snapshot: () => BrainDef) => void;
}

/**
 * Brain editor with page navigation, toolbar (undo/redo, copy, paste, print,
 * docs toggle), and save/load. Edits are made on a working copy of
 * `srcBrainDef`, which carries the source brain's id, and every edit, loading a
 * whole brain included, is a step on the editor's undo history.
 *
 * A modal session ({@link BrainEditorDialogProps}) hands the edited brain to
 * `onSubmit` when the user confirms, and asks before a close discards edits. A
 * continuous session ({@link ContinuousBrainEditorDialogProps}) hands each edit
 * to `onChange` as it is made and closes from a single control without asking.
 */
export function BrainEditorDialog(props: BrainEditorDialogProps | ContinuousBrainEditorDialogProps) {
  const { isOpen, onOpenChange, srcBrainDef, onChange } = props;
  const onSubmit = props.continuous === true ? undefined : props.onSubmit;
  const chrome = brainEditorChrome(props);
  const { getDefaultBrain, docsIntegration, sidePanel, brainServices, tileCatalogs, projectNamespace } =
    useBrainEditorConfig();
  const isDocsOpen = docsIntegration?.isOpen ?? false;
  const toggleDocs = docsIntegration?.toggle;
  const closeDocs = docsIntegration?.close;
  const isSidePanelOpen = sidePanel?.isOpen ?? false;
  const toggleSidePanel = sidePanel?.toggle;

  const createEditableBrain = useCallback(
    (sourceBrainDef?: BrainDef): BrainDef => {
      const extraCatalogs = tileCatalogs ? List.from(tileCatalogs) : undefined;
      const nextBrainDef = sourceBrainDef
        ? sourceBrainDef.workingCopy(extraCatalogs)
        : BrainDef.emptyBrainDef(brainServices!);
      if (nextBrainDef.pages().size() === 0) {
        nextBrainDef.appendNewPage();
      }
      return nextBrainDef;
    },
    [brainServices, tileCatalogs]
  );

  const [brainDef, setBrainDef] = useState<BrainDef | undefined>(() => createEditableBrain(srcBrainDef));
  const [currentPageNumber, setCurrentPageNumber] = useState(brainDef ? 1 : 0);
  const [totalPageCount, setTotalPageCount] = useState(brainDef?.pages()?.size() ?? 0);
  const [pageChangeCounter, setPageChangeCounter] = useState(0);
  // True while a menu is closing on a move to another page, whose own landing
  // takes the keyboard.
  const landsOnNewPageRef = useRef(false);
  const currentPageDef = brainDef ? brainDef.pages().get(currentPageNumber - 1) : undefined;

  // The identity of the page whose rules the editor is showing. A fresh working
  // copy, a move to another page, and a change to the page list each stand a
  // new one.
  const shownPage = useMemo(
    () => (currentPageDef === undefined ? undefined : { pageDef: currentPageDef, pageChangeCounter }),
    [currentPageDef, pageChangeCounter]
  );

  // Command history for undo/redo
  const [commandHistory] = useState(() => new BrainCommandHistory());
  // The rule the editor has been asked to bring into view, which the page
  // showing it scrolls to as it renders.
  const [revealRule, setRevealRule] = useState<RuleReveal | undefined>(undefined);
  const brainDefRef = useRef(brainDef);
  brainDefRef.current = brainDef;

  const reveal = useCallback((place: EditedBrainPlace) => {
    const pages = brainDefRef.current?.pages();
    if (pages === undefined) return;
    for (let index = 0; index < pages.size(); index++) {
      if ((pages.get(index) as BrainPageDef).pageId() !== place.pageId) continue;
      setCurrentPageNumber(index + 1);
      if (place.ruleId !== undefined) setRevealRule({ ruleId: place.ruleId });
      return;
    }
  }, []);
  // Armed target for the tile picker, shared with the rule and tile editors.
  const armedTarget = useArmedTargetState();
  const rulePickup = useRulePickupState();
  const disarmTileTarget = armedTarget.disarm;

  // The context the editor's keyboard stands in: the armed tile picker's own,
  // as the rule card standing it reports, and the page's while nothing is
  // armed. A closed editor stands no context at all.
  const reportModeRef = useRef(docsIntegration?.reportMode);
  reportModeRef.current = docsIntegration?.reportMode;
  const isTileTargetArmed = armedTarget.target !== null;
  const isRuleHeld = rulePickup.pickup !== null;
  const armedMode = armedTarget.mode;
  const editorMode: EditorMode | undefined = isTileTargetArmed
    ? (armedMode ?? undefined)
    : deriveEditorMode({ ruleIsHeld: isRuleHeld });
  useEffect(() => {
    if (!isOpen) {
      reportModeRef.current?.(undefined);
      return;
    }
    if (editorMode !== undefined) reportModeRef.current?.(editorMode);
  }, [isOpen, editorMode]);
  useEffect(() => () => reportModeRef.current?.(undefined), []);
  const [canUndo, setCanUndo] = useState(false);
  const [hasBrainClipboard, setHasBrainClipboard] = useState(hasBrainInClipboard);
  const [canRedo, setCanRedo] = useState(false);
  const [isEditingBrainName, setIsEditingBrainName] = useState(false);
  const [brainNameValue, setBrainNameValue] = useState("");
  const [isEditingPageName, setIsEditingPageName] = useState(false);
  const [pageNameValue, setPageNameValue] = useState("");
  const [zoom, setZoom] = useState(1);
  const [isPrintDialogOpen, setIsPrintDialogOpen] = useState(false);
  const [undoDepth, setUndoDepth] = useState(0);
  const [openingDepth, setOpeningDepth] = useState(0);
  const [isConfirmingDiscard, setIsConfirmingDiscard] = useState(false);
  // The element holding the keyboard when the discard confirmation opened.
  const discardReturnFocusRef = useRef<HTMLElement | null>(null);
  const keepEditingRef = useRef<HTMLButtonElement | null>(null);
  // The element holding the keyboard when the editor opened and the containers
  // it stood in, which take it back as the editor closes. Read in a layout
  // pass, which runs before the dialog's own focus move.
  const openerReturnFocusRef = useRef<readonly HTMLElement[]>([]);
  useLayoutEffect(() => {
    if (!isOpen) return;
    const opener = document.activeElement;
    openerReturnFocusRef.current = returnFocusChain(opener instanceof HTMLElement ? opener : null, document);
  }, [isOpen]);

  // Update undo/redo state when history changes
  useEffect(() => {
    const updateUndoRedoState = () => {
      setCanUndo(commandHistory.canUndo());
      setCanRedo(commandHistory.canRedo());
      setUndoDepth(commandHistory.undoDepth());
    };

    const stopListening = commandHistory.onChange(updateUndoRedoState);
    updateUndoRedoState();
    return stopListening;
  }, [commandHistory]);

  // Hands each edit the history records to the host's current onChange.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(
    () =>
      watchBrainEdits(
        commandHistory,
        () => brainDefRef.current,
        (snapshot) => onChangeRef.current?.(snapshot)
      ),
    [commandHistory]
  );

  // Read through a ref so the working copy resets only when the dialog opens
  // or the source brain changes. The host config (and with it this callback's
  // identity) legitimately rebuilds mid-edit -- docs sidebar toggles, tile
  // installs, asset revision bumps -- and an open draft must survive those.
  const createEditableBrainRef = useRef(createEditableBrain);
  useEffect(() => {
    createEditableBrainRef.current = createEditableBrain;
  }, [createEditableBrain]);

  // Clone brainDef when the source brain changes or the dialog opens
  useEffect(() => {
    if (isOpen && srcBrainDef) {
      const newBrainDef = createEditableBrainRef.current(srcBrainDef);
      setBrainDef(newBrainDef);
      setCurrentPageNumber(1);
      setTotalPageCount(newBrainDef.pages().size());
      // Standing the working copy up is the editor's own change, not the
      // person's: it clears the history and, for a brain holding no rule at
      // all, gives it one to start from through the history so it can be taken
      // straight back.
      commandHistory.runAs(BrainEditOrigin.Editor, () => {
        commandHistory.clear();
        if (brainHoldsNoRule(newBrainDef)) {
          commandHistory.executeCommand(new AddRuleCommand(newBrainDef.pages().get(0) as BrainPageDef));
        }
      });
      // Everything on the history from here on is the user's own work.
      setOpeningDepth(commandHistory.undoDepth());
      setIsConfirmingDiscard(false);
      setRevealRule(undefined);
    } else if (!isOpen) {
      // Clear working copy when dialog closes
      setBrainDef(undefined);
      commandHistory.runAs(BrainEditOrigin.Editor, () => commandHistory.clear());
      setOpeningDepth(0);
      setIsConfirmingDiscard(false);
      setRevealRule(undefined);
    }
  }, [isOpen, srcBrainDef, commandHistory]);

  useEffect(() => {
    return onBrainClipboardChanged(() => setHasBrainClipboard(hasBrainInClipboard()));
  }, []);

  const handleCopyBrain = useCallback(() => {
    if (brainDef) {
      copyBrainToClipboard(brainDef);
      toast.success("Brain copied");
    }
  }, [brainDef]);

  const handlePasteBrain = useCallback(() => {
    if (!brainDef) return;
    const json = getBrainFromClipboard();
    if (!json) return;
    const extraCatalogs = tileCatalogs ? List.from(tileCatalogs) : undefined;
    const command = new ReplaceBrainCommand(brainDef, json, extraCatalogs);
    commandHistory.executeCommand(command);
    toast.success("Brain pasted");
  }, [brainDef, commandHistory, tileCatalogs]);

  useEffect(() => {
    if (brainDef) {
      const onBrainChanged = ({
        what,
        pageWhat,
        ruleWhat,
      }: {
        what: string;
        pageWhat?: unknown;
        ruleWhat?: unknown;
      }) => {
        if (what === "page_added") {
          setTotalPageCount(brainDef.pages().size());
          setPageChangeCounter((c) => c + 1);
          if (currentPageNumber === 0) {
            setCurrentPageNumber(1);
          }
        } else if (what === "page_removed") {
          setTotalPageCount(brainDef.pages().size());
          setPageChangeCounter((c) => c + 1);
          setCurrentPageNumber((prev) => Math.min(prev, brainDef.pages().size()));
        } else if (what === "brain_replaced") {
          setTotalPageCount(brainDef.pages().size());
          setPageChangeCounter((c) => c + 1);
          setCurrentPageNumber(1);
        }
      };

      const unsub = brainDef.events().on("brain_changed", onBrainChanged);
      return () => {
        unsub();
      };
    }
  }, [brainDef, currentPageNumber]);

  const handleSubmit = useCallback(() => {
    onSubmit?.(brainDef ? detachedBrainSnapshot(brainDef) : createEditableBrain());
  }, [brainDef, onSubmit, createEditableBrain]);

  const holdsDiscardableEdits = chrome.closeConfirmsDiscard && hasDiscardableEdits({ undoDepth, openingDepth });

  const takeKeyboard = useCallback(() => takePageGridKeyboard(document), []);

  // What the side region's tenant edits: the working copy standing right now,
  // the history the editor's own undo runs through, the way into the rule an
  // edit landed on, and the way to hand the keyboard back to the page.
  const editedBrain = useMemo(
    () => (brainDef === undefined ? undefined : { brainDef, history: commandHistory, reveal, takeKeyboard }),
    [brainDef, commandHistory, reveal, takeKeyboard]
  );

  const rulesRegion = (
    <LatchedBrainRulesRegion shownPage={shownPage}>
      {currentPageDef === undefined ? null : (
        <ArmedTargetProvider value={armedTarget}>
          <RulePickupProvider value={rulePickup}>
            <BrainPageEditor
              key={`${currentPageNumber}-${pageChangeCounter}`}
              pageDef={currentPageDef as BrainPageDef}
              commandHistory={commandHistory}
              zoom={zoom}
              revealRule={revealRule}
            />
          </RulePickupProvider>
        </ArmedTargetProvider>
      )}
    </LatchedBrainRulesRegion>
  );

  /**
   * Close the editor, first asking the user to confirm when a modal session
   * holds work the close would lose. A continuous session closes without
   * asking.
   */
  const requestDiscardingClose = useCallback(() => {
    if (!holdsDiscardableEdits) {
      onOpenChange(false);
      return;
    }
    discardReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setIsConfirmingDiscard(true);
  }, [holdsDiscardableEdits, onOpenChange]);

  // Every control the footer can stand; the session's chrome picks which stand, and in what order.
  const footerControls: Record<BrainEditorFooterControl, ReactNode> = {
    cancel: (
      <Button
        key="cancel"
        variant="cancel"
        className="rounded-lg"
        onClick={requestDiscardingClose}
        title="Discard Changes"
      >
        Cancel
      </Button>
    ),
    submit: (
      <Button
        key="submit"
        title="Save Changes"
        aria-label="Save changes"
        className="rounded-lg"
        onClick={handleSubmit}
        disabled={!brainDef}
      >
        OK
      </Button>
    ),
    close: (
      <Button
        key="close"
        title="Close"
        aria-label="Close the brain editor"
        className="rounded-lg"
        onClick={() => onOpenChange(false)}
      >
        Close
      </Button>
    ),
  };

  const handleConfirmDiscard = useCallback(() => {
    discardReturnFocusRef.current = null;
    setIsConfirmingDiscard(false);
    onOpenChange(false);
  }, [onOpenChange]);

  const handleInsertPageAfterCurrentClick = () => {
    landsOnNewPageRef.current = true;
    if (brainDef && totalPageCount > 0) {
      const currentIndex = currentPageNumber - 1;
      const command = new AddPageCommand(brainDef, currentIndex + 1);
      commandHistory.executeCommand(command);
      setCurrentPageNumber(currentIndex + 2); // Move to the newly added page
    } else if (brainDef && totalPageCount === 0) {
      // If no pages exist, just append a new page
      const command = new AddPageCommand(brainDef, undefined);
      commandHistory.executeCommand(command);
      setCurrentPageNumber(1);
    }
  };

  const handleInsertPageBeforeCurrentClick = () => {
    landsOnNewPageRef.current = true;
    if (brainDef && totalPageCount > 0) {
      const currentIndex = currentPageNumber - 1;
      const command = new AddPageCommand(brainDef, currentIndex);
      commandHistory.executeCommand(command);
      setCurrentPageNumber(currentIndex + 1); // Move to the newly added page
    } else if (brainDef && totalPageCount === 0) {
      // If no pages exist, just append a new page
      const command = new AddPageCommand(brainDef, undefined);
      commandHistory.executeCommand(command);
      setCurrentPageNumber(1);
    }
  };

  const handleRemovePageClick = () => {
    landsOnNewPageRef.current = true;
    if (brainDef && totalPageCount > 0) {
      const pageIndexToRemove = currentPageNumber - 1;

      // Special case: if this is the last remaining page, use ReplaceLastPageCommand
      if (totalPageCount === 1) {
        const command = new ReplaceLastPageCommand(brainDef, pageIndexToRemove);
        commandHistory.executeCommand(command);
      } else {
        const command = new RemovePageCommand(brainDef, pageIndexToRemove);
        commandHistory.executeCommand(command);
      }

      // Immediately update state to reflect the change
      const newPageCount = brainDef.pages().size();
      setTotalPageCount(newPageCount);
      setPageChangeCounter((c) => c + 1);
      setCurrentPageNumber((prev) => Math.min(prev, newPageCount));
    }
  };

  const handleNextPageClick = () => {
    if (currentPageNumber < totalPageCount) {
      setCurrentPageNumber(currentPageNumber + 1);
    }
  };

  /**
   * Move to page `pageNumber` from a menu, which the menu's close then leaves
   * the keyboard alone for: the page opening takes it onto its own selection.
   */
  const goToPageFromMenu = (pageNumber: number) => {
    landsOnNewPageRef.current = true;
    setCurrentPageNumber(pageNumber);
  };

  const handlePrevPageClick = () => {
    if (currentPageNumber > 1) {
      setCurrentPageNumber(currentPageNumber - 1);
    }
  };

  /**
   * A page menu closing. A close that follows a move to another page leaves the
   * keyboard where that page's own landing puts it; every other close hands the
   * keyboard back to the control the menu was opened from, as Radix does.
   */
  const handlePageMenuCloseAutoFocus = (event: Event) => {
    if (!landsOnNewPageRef.current) return;
    landsOnNewPageRef.current = false;
    event.preventDefault();
  };

  const handleUndo = useCallback(() => {
    // Undo can restructure the document out from under an armed picker
    // target, so drop the target before mutating.
    disarmTileTarget();
    commandHistory.undo();
  }, [commandHistory, disarmTileTarget]);

  const handleRedo = useCallback(() => {
    disarmTileTarget();
    commandHistory.redo();
  }, [commandHistory, disarmTileTarget]);

  // The armed target carries closures from the arming components, which are
  // remounted on a page switch or page-editor key bump. Disarm at those
  // boundaries so a stale target never survives them.
  // biome-ignore lint/correctness/useExhaustiveDependencies: currentPageNumber and pageChangeCounter are intentional trigger signals
  useEffect(() => {
    disarmTileTarget();
  }, [currentPageNumber, pageChangeCounter, disarmTileTarget]);

  // A structural change that deletes the armed rule invalidates the target's
  // closures; disarm when the armed rule leaves the document.
  useEffect(() => {
    const target = armedTarget.target;
    if (!target) return;
    return target.ruleDef.events().on("rule_deleted", () => {
      disarmTileTarget();
    });
  }, [armedTarget.target, disarmTileTarget]);

  const handleSaveToFile = useCallback(async () => {
    if (!brainDef) return;

    try {
      // Serialize the brain to its persisted JSON form
      const json =
        projectNamespace !== undefined ? encodePersistedBrainJson(brainDef, projectNamespace) : brainDef.toJson();
      const text = JSON.stringify(json, null, 2);

      // Use File System Access API to save
      // biome-ignore lint/suspicious/noExplicitAny: File System Access API has no standard TS types
      const handle = await (window as any).showSaveFilePicker({
        suggestedName: `${brainDef.name()}.brain`,
        types: [
          {
            description: "Brain Files",
            accept: { "application/json": [".brain"] },
          },
        ],
      });

      const writable = await handle.createWritable();
      await writable.write(text);
      await writable.close();
    } catch (err) {
      // User cancelled or error occurred
      if (err instanceof Error && err.name !== "AbortError") {
        console.error("Failed to save brain:", err);
      }
    }
  }, [brainDef, projectNamespace]);

  const handleLoadFromFile = useCallback(async () => {
    try {
      // Use File System Access API to load
      // biome-ignore lint/suspicious/noExplicitAny: File System Access API has no standard TS types
      const [handle] = await (window as any).showOpenFilePicker({
        types: [
          {
            description: "Brain Files",
            accept: { "application/octet-stream": [".brain"], "application/json": [".brain"] },
          },
        ],
        multiple: false,
      });

      const file = await handle.getFile();
      const arrayBuffer = await file.arrayBuffer();
      const text = new TextDecoder().decode(new Uint8Array(arrayBuffer));

      const extraCatalogs = tileCatalogs ? List.from(tileCatalogs) : undefined;
      const plain = JSON.parse(text) as unknown;
      const loadedBrain: BrainDef =
        projectNamespace !== undefined
          ? deserializePersistedBrainJson(plain, projectNamespace, brainServices!, extraCatalogs)
          : BrainDef.fromJson(brainJsonFromPlain(plain), brainServices!, extraCatalogs);

      if (loadedBrain.pages().size() === 0) {
        loadedBrain.appendNewPage();
      }

      loadedBrain.compile();

      // Read after the picker's wait, so a load lands on the working copy
      // standing once the file is read.
      const workingBrainDef = brainDefRef.current;
      if (!workingBrainDef) return;
      replaceBrainContent(commandHistory, workingBrainDef, loadedBrain, extraCatalogs);
    } catch (err) {
      // User cancelled or error occurred
      if (err instanceof Error && err.name !== "AbortError") {
        console.error("Failed to load brain:", err);
      }
    }
  }, [commandHistory, brainServices, tileCatalogs, projectNamespace]);

  const handleLoadDefault = useCallback(() => {
    if (!brainDef) return;
    const defaultBrain = getDefaultBrain?.();
    if (!defaultBrain) return;

    const extraCatalogs = tileCatalogs ? List.from(tileCatalogs) : undefined;
    const cloned = defaultBrain.clone(extraCatalogs);
    if (cloned.pages().size() === 0) {
      cloned.appendNewPage();
    }
    cloned.compile();

    replaceBrainContent(commandHistory, brainDef, cloned, extraCatalogs);
  }, [brainDef, getDefaultBrain, commandHistory, tileCatalogs]);

  const handleBrainNameClick = () => {
    if (brainDef) {
      setBrainNameValue(brainDef.name());
      setIsEditingBrainName(true);
    }
  };

  const handleBrainNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setBrainNameValue(e.target.value);
  };

  const handleBrainNameBlur = () => {
    const trimmedValue = brainNameValue.trim();
    if (brainDef && trimmedValue && trimmedValue !== brainDef.name()) {
      const command = new RenameBrainCommand(brainDef, trimmedValue);
      commandHistory.executeCommand(command);
    }
    setIsEditingBrainName(false);
  };

  const handleBrainNameKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Stop propagation to prevent dialog shortcuts from interfering
    e.stopPropagation();

    if (e.key === "Enter") {
      e.currentTarget.blur();
    } else if (e.key === "Escape") {
      setIsEditingBrainName(false);
    }
  };

  const handlePageNameClick = () => {
    if (currentPageDef) {
      setPageNameValue(currentPageDef.name());
      setIsEditingPageName(true);
    }
  };

  const handlePageNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setPageNameValue(e.target.value);
  };

  const handlePageNameBlur = () => {
    const trimmedValue = pageNameValue.trim();
    if (currentPageDef && trimmedValue && trimmedValue !== currentPageDef.name()) {
      const command = new RenamePageCommand(currentPageDef as BrainPageDef, trimmedValue);
      commandHistory.executeCommand(command);
    }
    setIsEditingPageName(false);
  };

  const handlePageNameKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Stop propagation to prevent parent handlers from interfering
    e.stopPropagation();

    if (e.key === "Enter") {
      e.currentTarget.blur();
    } else if (e.key === "Escape") {
      setIsEditingPageName(false);
    }
  };

  // The history chord, wherever in the editor it is pressed. A press whose
  // default a surface below has already prevented takes no step; every other
  // press is decided by the mode the keyboard stands in.
  const editorModeRef = useRef(editorMode);
  editorModeRef.current = editorMode;
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const mode = editorModeRef.current;
      if (mode === undefined) return;
      const step = decideHistoryShortcut(mode, {
        key: e.key,
        withCommand: e.metaKey || e.ctrlKey,
        withShift: e.shiftKey,
      });
      if (step === undefined) return;
      e.preventDefault();
      if (step === "undo") handleUndo();
      else handleRedo();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, handleUndo, handleRedo]);

  // Close the docs sidebar when the brain editor leaves the screen, whether the
  // host renders the dialog closed or unmounts it outright.
  useEffect(() => {
    if (!isOpen) return;
    return () => closeDocs?.();
  }, [isOpen, closeDocs]);

  return (
    <>
      {/* When the docs sidebar is open the dialog switches to non-modal so
          focus can reach the sidebar. Radix skips its overlay in non-modal
          mode, so we render a standalone backdrop to keep the dimming. */}
      {isOpen && isDocsOpen && <div className={`fixed inset-0 ${kDialogChromeLayer} bg-black/80`} aria-hidden="true" />}
      <Dialog open={isOpen} onOpenChange={onOpenChange} modal={!isDocsOpen}>
        <DialogContent
          {...{ [kEditorContentAttribute]: "" }}
          // The editor centres itself in the viewport width the documentation
          // panel leaves free, read from the --docs-panel-inset custom property
          // the panel publishes (0% when it covers nothing), and in the height
          // the soft keyboard leaves free, read the same way from
          // --keyboard-inset (0px with no keyboard up). Both shapes give up the
          // covered height, so the rules and the candidate strip stay on screen
          // alongside the keyboard.
          className="left-0 top-0 translate-x-0 translate-y-0 h-[calc(100dvh-var(--keyboard-inset,0))] max-w-full p-2 gap-2 sm:left-[calc(50%-var(--docs-panel-inset,0%)*0.5)] sm:top-[calc(50%-var(--keyboard-inset,0)*0.5)] sm:translate-x-[-50%] sm:translate-y-[-50%] sm:max-w-[min(75%,100%-var(--docs-panel-inset,0%)-2rem)] sm:h-[calc(90%-var(--keyboard-inset,0)*0.9)] sm:p-4 sm:gap-3 flex flex-col bg-card border-2 border-border rounded-none sm:rounded-2xl overflow-hidden"
          onInteractOutside={(e) => e.preventDefault()}
          onPointerDownOutside={(e) => e.preventDefault()}
          onFocusOutside={(e) => e.preventDefault()}
          // The dialog opens holding the keyboard itself; the page grid takes it
          // as soon as its selection has a cell to rest on.
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            if (e.currentTarget instanceof HTMLElement) e.currentTarget.focus();
          }}
          // The keyboard goes back to whatever held it when the editor opened,
          // without moving the view; an opener that stopped rendering gives way
          // to the container it stood in, and then to the page's main landmark.
          // A content still standing means this pass belongs to the swap the
          // documentation panel triggers, whose replacement content already
          // holds the keyboard, not to the editor closing.
          onCloseAutoFocus={(e) => {
            if (editorContentStands(document)) {
              e.preventDefault();
              return;
            }
            const returnTo = returnFocusTarget(openerReturnFocusRef.current, document);
            openerReturnFocusRef.current = [];
            if (returnTo === null) return;
            e.preventDefault();
            takeReturnFocus(returnTo);
          }}
          // While a tile picker is armed, Escape belongs to the candidate strip
          // for as long as the strip holds the keyboard: it clears the strip's
          // filter text and then disarms. Armed with the keyboard anywhere else,
          // no part of the strip serves the press, so the arming ends here and
          // the strip hands the keyboard on as it closes. While a rule is picked
          // up it belongs to that rule, and the page gives it back to where it
          // was picked up from. An open documentation panel takes it next and
          // closes, leaving the editor open. Once nothing else claims it, it
          // closes the editor, through the discard confirmation when a modal
          // session holds user work.
          onEscapeKeyDown={(e) => {
            if (armedTarget.target || rulePickup.pickup) {
              e.preventDefault();
              if (armedTarget.target !== null && !keyboardIsInCandidateStrip()) disarmTileTarget();
              return;
            }
            if (isDocsOpen) {
              e.preventDefault();
              closeDocs?.();
              return;
            }
            if (holdsDiscardableEdits) {
              e.preventDefault();
              requestDiscardingClose();
            }
          }}
          hideClose
        >
          <div
            aria-hidden="true"
            className={`pointer-events-none absolute inset-x-0 top-0 ${kDialogChromeLayer} h-0.75`}
            style={{ background: brandStripBackground }}
          />
          <DialogHeader className="border-b border-border pb-2 sm:pb-3">
            <DialogDescription className="sr-only">
              Edit brain pages, rules, and tiles. Use the toolbar to navigate pages, undo/redo, and manage the brain.
            </DialogDescription>
            <DialogTitle>
              <div className="flex flex-wrap justify-center items-center gap-1.5 sm:gap-3">
                {/* biome-ignore lint/a11y/useSemanticElements: refactoring to fieldset would require restructuring large JSX blocks */}
                <div
                  className="flex bg-muted rounded-lg p-1 border border-border"
                  role="group"
                  aria-label="Page name controls"
                >
                  <img
                    src={staticAssetUrl("assets/brain/icons/page.svg")}
                    alt="Page icon"
                    className="h-8 w-8 bg-muted rounded-sm"
                    aria-hidden="true"
                  />
                  <div className="flex items-center gap-1">
                    {isEditingPageName ? (
                      <>
                        <Input
                          value={pageNameValue}
                          onChange={handlePageNameChange}
                          onBlur={handlePageNameBlur}
                          onKeyDown={handlePageNameKeyDown}
                          autoFocus
                          className="text-foreground font-semibold h-8 px-2 py-1 max-w-xs bg-background border-input"
                        />
                        <Button
                          onMouseDown={(e) => {
                            e.preventDefault();
                            handlePageNameBlur();
                          }}
                          className="h-8 w-8 min-w-8 p-0 rounded-sm"
                          title="Save page name"
                          aria-label="Save page name"
                        >
                          <Save className="h-4 w-4" aria-hidden="true" />
                        </Button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="text-foreground font-semibold cursor-pointer hover:bg-accent px-2 py-1 rounded bg-transparent"
                          onClick={handlePageNameClick}
                          title="Click to edit page name"
                          aria-label={`Page name: ${currentPageDef ? currentPageDef.name() : "Page"}. Click to edit.`}
                        >
                          {currentPageDef ? currentPageDef.name() : "Page"}
                        </button>
                        <Button
                          onClick={handlePageNameClick}
                          className="h-8 w-8 bg-background hover:bg-muted text-muted-foreground hover:text-foreground rounded-md border border-border"
                          title="Edit page name"
                          aria-label="Edit page name"
                        >
                          <Pencil className="h-4 w-4" aria-hidden="true" />
                        </Button>
                      </>
                    )}
                  </div>
                </div>
                <div className="hidden sm:block grow" />
                {/* biome-ignore lint/a11y/useSemanticElements: refactoring to fieldset would require restructuring large JSX blocks */}
                <div
                  className="flex bg-muted rounded-lg p-1 border border-border"
                  role="group"
                  aria-label="Brain name controls"
                >
                  <img
                    src={staticAssetUrl("assets/brain/icons/brain2.svg")}
                    alt="Brain icon"
                    className="h-8 w-8 bg-muted rounded-sm"
                    aria-hidden="true"
                  />
                  <div className="flex items-center gap-1">
                    {isEditingBrainName ? (
                      <>
                        <Input
                          value={brainNameValue}
                          onChange={handleBrainNameChange}
                          onBlur={handleBrainNameBlur}
                          onKeyDown={handleBrainNameKeyDown}
                          autoFocus
                          className="text-foreground font-semibold h-8 px-2 py-1 max-w-xs bg-background border-input"
                        />
                        <Button
                          onMouseDown={(e) => {
                            e.preventDefault();
                            handleBrainNameBlur();
                          }}
                          className="h-8 w-8 min-w-8 p-0 rounded-sm"
                          title="Save brain name"
                          aria-label="Save brain name"
                        >
                          <Save className="h-4 w-4" aria-hidden="true" />
                        </Button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="text-foreground font-semibold cursor-pointer hover:bg-accent px-2 py-1 rounded bg-transparent"
                          onClick={handleBrainNameClick}
                          title="Click to edit brain name"
                          aria-label={`Brain name: ${brainDef ? brainDef.name() : "Brain Editor"}. Click to edit.`}
                        >
                          {brainDef ? brainDef.name() : "Brain Editor"}
                        </button>
                        <Button
                          onClick={handleBrainNameClick}
                          className="h-8 w-8 bg-background hover:bg-muted text-muted-foreground hover:text-foreground rounded-md border border-border"
                          title="Edit brain name"
                          aria-label="Edit brain name"
                        >
                          <Pencil className="h-4 w-4" aria-hidden="true" />
                        </Button>
                      </>
                    )}
                  </div>
                </div>
                <div className="hidden sm:block grow" />
                {/* biome-ignore lint/a11y/useSemanticElements: refactoring to fieldset would require restructuring large JSX blocks */}
                <div
                  className="flex items-center gap-2 bg-muted rounded-lg p-1 border border-border sm:mr-2"
                  role="group"
                  aria-label="Undo, redo, and panel controls"
                >
                  {toggleSidePanel && (
                    <>
                      <Button
                        className="h-8 w-8 px-3 bg-secondary hover:bg-secondary/80 text-secondary-foreground rounded-md"
                        onClick={toggleSidePanel}
                        title={sidePanel?.label ?? "Side panel"}
                        aria-label={sidePanelToggleLabel(sidePanel?.label)}
                        aria-expanded={isSidePanelOpen}
                        aria-controls={kSidePanelRegionId}
                      >
                        <PanelLeft className="h-4 w-4" aria-hidden="true" />
                      </Button>
                      <span className="w-px h-5 bg-border" aria-hidden="true" />
                    </>
                  )}
                  <Button
                    className="h-8 w-8 px-3 bg-secondary hover:bg-secondary/80 text-secondary-foreground rounded-md disabled:opacity-50"
                    onClick={handleUndo}
                    disabled={!canUndo}
                    title="Undo (Ctrl/Cmd+Z)"
                    aria-label="Undo last action"
                  >
                    <Undo className="h-4 w-4" aria-hidden="true" />
                  </Button>
                  <Button
                    className="h-8 w-8 px-3 bg-secondary hover:bg-secondary/80 text-secondary-foreground rounded-md disabled:opacity-50"
                    onClick={handleRedo}
                    disabled={!canRedo}
                    title="Redo (Ctrl/Cmd+Shift+Z)"
                    aria-label="Redo last undone action"
                  >
                    <Redo className="h-4 w-4" aria-hidden="true" />
                  </Button>
                  {toggleDocs && (
                    <>
                      <span className="w-px h-5 bg-border" aria-hidden="true" />
                      <Button
                        className="h-8 w-8 px-3 bg-secondary hover:bg-secondary/80 text-secondary-foreground rounded-md"
                        onClick={toggleDocs}
                        title="Documentation"
                        aria-label="Toggle documentation panel"
                        aria-expanded={isDocsOpen}
                        aria-controls="docs-sidebar"
                      >
                        <BookOpen className="h-4 w-4" aria-hidden="true" />
                      </Button>
                    </>
                  )}
                </div>
                {/* biome-ignore lint/a11y/useSemanticElements: refactoring to fieldset would require restructuring large JSX blocks */}
                <div
                  className="flex items-center gap-1 sm:gap-2 bg-muted rounded-lg p-1 border border-border"
                  role="group"
                  aria-label="Page navigation controls"
                >
                  <Button
                    title="Previous Page"
                    className="h-8 w-8 bg-background hover:bg-muted text-muted-foreground hover:text-foreground rounded-md border border-border"
                    onClick={handlePrevPageClick}
                    aria-label="Go to previous page"
                    disabled={currentPageNumber <= 1}
                  >
                    <ChevronLeft className="h-4 w-4" aria-hidden="true" />
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        className="flex items-center gap-1 px-3 h-8 text-sm font-medium text-muted-foreground hover:text-foreground whitespace-nowrap bg-background hover:bg-muted rounded-md border border-border cursor-pointer"
                        aria-live="polite"
                        aria-atomic="true"
                        aria-label={`Page ${currentPageNumber} of ${totalPageCount}. Click to select a page.`}
                      >
                        {`Page ${currentPageNumber} of ${totalPageCount}`}
                        <ChevronDown className="h-3 w-3 ml-1 text-muted-foreground" aria-hidden="true" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                      align="center"
                      onCloseAutoFocus={handlePageMenuCloseAutoFocus}
                      className="bg-popover border-border text-popover-foreground max-h-64 overflow-y-auto"
                    >
                      {brainDef
                        ?.pages()
                        .toArray()
                        .map((page, index) => (
                          <DropdownMenuItem
                            key={`page-${page.name()}-${index}`}
                            onClick={() => goToPageFromMenu(index + 1)}
                            className={`cursor-pointer focus:bg-accent focus:text-accent-foreground ${
                              index + 1 === currentPageNumber ? "bg-accent font-semibold" : ""
                            }`}
                          >
                            <span className="text-muted-foreground text-xs w-6 text-right mr-2">{index + 1}</span>
                            {page.name()}
                          </DropdownMenuItem>
                        ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <Button
                    title="Next Page"
                    className="h-8 w-8 bg-background hover:bg-muted text-muted-foreground hover:text-foreground rounded-md border border-border"
                    onClick={handleNextPageClick}
                    aria-label="Go to next page"
                    disabled={currentPageNumber >= totalPageCount}
                  >
                    <ChevronRight className="h-4 w-4" aria-hidden="true" />
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        title="Page Actions"
                        className="h-8 w-8 bg-background hover:bg-muted text-muted-foreground hover:text-foreground rounded-md border border-border"
                        variant="default"
                        aria-label="Open page actions menu"
                        aria-haspopup="menu"
                      >
                        <MoreVertical className="h-4 w-4" aria-hidden="true" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                      align="end"
                      onCloseAutoFocus={handlePageMenuCloseAutoFocus}
                      className="bg-popover border-border text-popover-foreground"
                    >
                      <DropdownMenuItem
                        onClick={handleLoadDefault}
                        disabled={!getDefaultBrain}
                        className="cursor-pointer focus:bg-accent focus:text-accent-foreground"
                      >
                        <div className="flex text-center items-center border rounded-md h-8 min-w-8 border-border">
                          <RotateCcw className="h-4 grow mx-1" />
                        </div>
                        <span className="w-full">Load Default Brain</span>
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={handleLoadFromFile}
                        className="cursor-pointer focus:bg-accent focus:text-accent-foreground"
                      >
                        <div className="flex text-center items-center border rounded-md h-8 min-w-8 border-border">
                          <Upload className="h-4 grow mx-1" />
                        </div>
                        <span className="w-full">Load Brain from File</span>
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={handleSaveToFile}
                        disabled={!brainDef}
                        className="cursor-pointer focus:bg-accent focus:text-accent-foreground"
                      >
                        <div className="flex text-center items-center border rounded-md h-8 min-w-8 border-border">
                          <Download className="h-4 grow mx-1" />
                        </div>
                        <span className="w-full">Save Brain to File</span>
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => setIsPrintDialogOpen(true)}
                        disabled={!brainDef}
                        className="cursor-pointer focus:bg-accent focus:text-accent-foreground"
                      >
                        <div className="flex text-center items-center border rounded-md h-8 min-w-8 border-border">
                          <Printer className="h-4 grow mx-1" />
                        </div>
                        <span className="w-full">Print Brain</span>
                      </DropdownMenuItem>
                      <DropdownMenuSeparator className="bg-border" />
                      <DropdownMenuItem
                        onClick={handleCopyBrain}
                        disabled={!brainDef}
                        className="cursor-pointer focus:bg-accent focus:text-accent-foreground"
                      >
                        <div className="flex text-center items-center border rounded-md h-8 min-w-8 border-border">
                          <Copy className="h-4 grow mx-1" />
                        </div>
                        <span className="w-full">Copy Brain</span>
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={handlePasteBrain}
                        disabled={!brainDef || !hasBrainClipboard}
                        className="cursor-pointer focus:bg-accent focus:text-accent-foreground"
                      >
                        <div className="flex text-center items-center border rounded-md h-8 min-w-8 border-border">
                          <ClipboardPaste className="h-4 grow mx-1" />
                        </div>
                        <span className="w-full">Paste Brain</span>
                      </DropdownMenuItem>
                      <DropdownMenuSeparator className="bg-border" />
                      <DropdownMenuItem
                        onClick={handleInsertPageBeforeCurrentClick}
                        className="cursor-pointer focus:bg-accent focus:text-accent-foreground"
                      >
                        <div className="flex text-center items-center border rounded-md h-8 border-border">
                          <ChevronLeft className="h-4 w-4 ml-1" />
                          <Plus className="h-4 w-4 mr-1" />
                        </div>
                        <span className="w-full">Add Page Before</span>
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={handleInsertPageAfterCurrentClick}
                        className="cursor-pointer focus:bg-accent focus:text-accent-foreground"
                      >
                        <div className="flex text-center items-center border rounded-md h-8 border-border">
                          <Plus className="h-4 w-4 ml-1" />
                          <ChevronRight className="h-4 w-4 mr-1" />
                        </div>
                        <span className="w-full">Add Page After</span>
                      </DropdownMenuItem>
                      <DropdownMenuSeparator className="bg-border" />
                      <DropdownMenuItem
                        onClick={handleRemovePageClick}
                        className="cursor-pointer text-destructive focus:bg-destructive/10 focus:text-destructive"
                      >
                        <div className="flex text-center items-center border rounded-md h-8 min-w-8 border-border">
                          <Minus className="h-4 grow mx-1" />
                        </div>
                        <span className="w-full">Delete Page</span>
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
            </DialogTitle>
          </DialogHeader>
          {sidePanel ? (
            <div className={kSidePanelLayoutClasses}>
              {rulesRegion}
              <EditedBrainProvider value={editedBrain}>
                <BrainEditorSidePanel isOpen={isSidePanelOpen} content={sidePanel.content} />
              </EditedBrainProvider>
            </div>
          ) : (
            rulesRegion
          )}
          <DialogFooter className="pt-2 sm:pt-3 border-t border-border flex flex-row flex-wrap items-center gap-2 sm:justify-between">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-xs text-muted-foreground whitespace-nowrap">{Math.round(zoom * 100)}%</span>
              <Slider
                className="w-32"
                min={0.5}
                max={3}
                step={0.1}
                value={[zoom]}
                onValueChange={([v]) => setZoom(v)}
                aria-label="Zoom level"
              />
            </div>
            <div className="flex gap-2">{chrome.footerControls.map((control) => footerControls[control])}</div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {brainDef && (
        <BrainPrintDialog isOpen={isPrintDialogOpen} onOpenChange={setIsPrintDialogOpen} brainDef={brainDef} />
      )}
      <Dialog
        open={isConfirmingDiscard}
        onOpenChange={(open) => {
          if (!open) setIsConfirmingDiscard(false);
        }}
      >
        <DialogContent
          className="max-w-sm rounded-2xl"
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            keepEditingRef.current?.focus();
          }}
          onCloseAutoFocus={(e) => {
            const returnTo = discardReturnFocusRef.current;
            discardReturnFocusRef.current = null;
            if (!returnTo || !returnTo.isConnected) return;
            e.preventDefault();
            returnTo.focus();
          }}
          hideClose
        >
          <DialogHeader>
            <DialogTitle>Discard your changes?</DialogTitle>
            <DialogDescription>
              This brain has changes that have not been saved. Closing the editor now loses them.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="destructive" className="rounded-lg" onClick={handleConfirmDiscard}>
              Discard changes
            </Button>
            <Button ref={keepEditingRef} className="rounded-lg" onClick={() => setIsConfirmingDiscard(false)}>
              Keep editing
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
