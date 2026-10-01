/**
 * Pins what a host sees of a brain editing session: which history changes
 * report an edit to the host, what the brain it is handed holds, how a whole
 * brain replaces the working copy, and the chrome each kind of session stands.
 */

import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import type { BrainServices } from "@wendoo/core/brain";
import { CoreLiteralFactoryId, mkLiteralFactoryTileId, RuleSide } from "@wendoo/core/brain";
import { __test__createBrainServices } from "@wendoo/core/brain/__test__";
import {
  AddPageCommand,
  AddTileCommand,
  BrainCommandHistory,
  BrainDef,
  BrainEditOrigin,
  type BrainRuleDef,
  RemovePageCommand,
  RemoveTileCommand,
  RenameBrainCommand,
} from "@wendoo/core/brain/model";
import { type BrainTileFactoryDef, manufactureLiteralTile } from "@wendoo/core/brain/tiles";
import type { BrainEditorDialogProps, ContinuousBrainEditorDialogProps } from "./BrainEditorDialog";
import { hasDiscardableEdits } from "./discard-guard";
import { brainEditorChrome, detachedBrainSnapshot, replaceBrainContent, watchBrainEdits } from "./editor-session";

let services: BrainServices;

before(() => {
  services = __test__createBrainServices();
});

/** The first rule on the first page of `brainDef`. */
function firstRule(brainDef: BrainDef): BrainRuleDef {
  return brainDef.pages().get(0).children().get(0) as BrainRuleDef;
}

/** A number literal registered in `brainDef`'s own catalog, placed nowhere. */
function numberLiteral(brainDef: BrainDef, value: number) {
  const factory = services.edit.tiles.get(mkLiteralFactoryTileId(CoreLiteralFactoryId.Number)) as BrainTileFactoryDef;
  const literal = manufactureLiteralTile(factory, brainDef.catalog(), value);
  assert.ok(literal);
  return literal;
}

/** A watcher over `history` and `brainDef`, recording each snapshot it is handed. */
function watchInto(history: BrainCommandHistory, brainDef: BrainDef | undefined) {
  const snapshots: Array<() => BrainDef> = [];
  const stop = watchBrainEdits(
    history,
    () => brainDef,
    (snapshot) => {
      snapshots.push(snapshot);
    }
  );
  return { snapshots, stop };
}

describe("which history changes report an edit", () => {
  test("a person's command reports one", () => {
    const brainDef = BrainDef.emptyBrainDef(services);
    const history = new BrainCommandHistory();
    const { snapshots } = watchInto(history, brainDef);

    history.executeCommand(new RenameBrainCommand(brainDef, "Mover"));

    assert.equal(snapshots.length, 1);
  });

  test("a tool call's command reports one", () => {
    const brainDef = BrainDef.emptyBrainDef(services);
    const history = new BrainCommandHistory();
    const { snapshots } = watchInto(history, brainDef);

    history.runAs(BrainEditOrigin.Tool, () => history.executeCommand(new RenameBrainCommand(brainDef, "Mover")));

    assert.equal(snapshots.length, 1);
  });

  test("the editor's own changes report none", () => {
    const brainDef = BrainDef.emptyBrainDef(services);
    const history = new BrainCommandHistory();
    const { snapshots } = watchInto(history, brainDef);

    history.runAs(BrainEditOrigin.Editor, () => {
      history.clear();
      history.executeCommand(new AddPageCommand(brainDef, undefined));
      history.clear();
    });

    assert.equal(snapshots.length, 0);
  });

  test("undo and redo each report one", () => {
    const brainDef = BrainDef.emptyBrainDef(services);
    const history = new BrainCommandHistory();
    history.executeCommand(new RenameBrainCommand(brainDef, "Mover"));
    const { snapshots } = watchInto(history, brainDef);

    history.undo();
    history.redo();

    assert.equal(snapshots.length, 2);
  });

  test("a batch reports once, as it closes, and not for the commands it gathers", () => {
    const brainDef = BrainDef.emptyBrainDef(services);
    const history = new BrainCommandHistory();
    const { snapshots } = watchInto(history, brainDef);

    history.beginBatch("Move rule");
    history.executeCommand(new AddPageCommand(brainDef, undefined));
    history.executeCommand(new AddPageCommand(brainDef, undefined));
    assert.equal(snapshots.length, 0);
    history.endBatch();

    assert.equal(snapshots.length, 1);
  });

  test("an aborted batch reports once, for the brain it put back", () => {
    const brainDef = BrainDef.emptyBrainDef(services);
    const history = new BrainCommandHistory();
    const { snapshots } = watchInto(history, brainDef);

    history.beginBatch("Move rule");
    history.executeCommand(new AddPageCommand(brainDef, undefined));
    history.abortBatch();

    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0]().pages().size(), 1);
  });

  test("a change with no working copy standing reports none", () => {
    const history = new BrainCommandHistory();
    const { snapshots } = watchInto(history, undefined);

    history.clear();

    assert.equal(snapshots.length, 0);
  });

  test("stopping the watch reports nothing further", () => {
    const brainDef = BrainDef.emptyBrainDef(services);
    const history = new BrainCommandHistory();
    const { snapshots, stop } = watchInto(history, brainDef);

    stop();
    history.executeCommand(new RenameBrainCommand(brainDef, "Mover"));

    assert.equal(snapshots.length, 0);
  });

  test("a snapshot reads the working copy when it is taken, not when it was reported", () => {
    const brainDef = BrainDef.emptyBrainDef(services);
    const history = new BrainCommandHistory();
    const { snapshots } = watchInto(history, brainDef);

    history.executeCommand(new RenameBrainCommand(brainDef, "Mover"));
    history.executeCommand(new RenameBrainCommand(brainDef, "Chaser"));

    assert.equal(snapshots[0]().name(), "Chaser");
  });
});

describe("the brain a host is handed", () => {
  test("is a separate brain carrying the working copy's id", () => {
    const brainDef = BrainDef.emptyBrainDef(services);

    const snapshot = detachedBrainSnapshot(brainDef);

    assert.notEqual(snapshot, brainDef);
    assert.equal(snapshot.id(), brainDef.id());
  });

  test("does not follow later edits to the working copy", () => {
    const brainDef = BrainDef.emptyBrainDef(services);
    brainDef.setName("Mover");

    const snapshot = detachedBrainSnapshot(brainDef);
    brainDef.setName("Chaser");

    assert.equal(snapshot.name(), "Mover");
  });

  test("drops tiles no page places, and leaves them in the working copy's catalog", () => {
    const brainDef = BrainDef.emptyBrainDef(services);
    const literal = numberLiteral(brainDef, 7);

    const snapshot = detachedBrainSnapshot(brainDef);

    assert.equal(snapshot.catalog().get(literal.tileId), undefined);
    assert.equal(brainDef.catalog().get(literal.tileId), literal);
  });

  test("keeps tiles a page places", () => {
    const brainDef = BrainDef.emptyBrainDef(services);
    const literal = numberLiteral(brainDef, 7);
    firstRule(brainDef).side(RuleSide.Do).appendTile(literal);

    const snapshot = detachedBrainSnapshot(brainDef);

    assert.ok(snapshot.catalog().get(literal.tileId));
  });

  test("leaves a removed tile's placement restorable by undo", () => {
    const brainDef = BrainDef.emptyBrainDef(services);
    const history = new BrainCommandHistory();
    const literal = numberLiteral(brainDef, 7);
    history.executeCommand(new AddTileCommand(firstRule(brainDef), RuleSide.Do, literal));
    history.executeCommand(new RemoveTileCommand(firstRule(brainDef), RuleSide.Do, 0));

    detachedBrainSnapshot(brainDef);
    history.undo();

    assert.equal(firstRule(brainDef).side(RuleSide.Do).tiles().get(0), literal);
    assert.equal(brainDef.catalog().get(literal.tileId), literal);
  });

  test("holds what purging the working copy in place leaves", () => {
    const brainDef = BrainDef.emptyBrainDef(services);
    const history = new BrainCommandHistory();
    history.executeCommand(new AddPageCommand(brainDef, undefined));
    history.executeCommand(new RemovePageCommand(brainDef, 1));
    const placed = numberLiteral(brainDef, 3);
    firstRule(brainDef).side(RuleSide.Do).appendTile(placed);
    numberLiteral(brainDef, 7);

    const snapshot = detachedBrainSnapshot(brainDef);
    brainDef.purgeUnusedTiles();

    assert.deepEqual(snapshot.toJson(), brainDef.toJson());
  });
});

describe("replacing the whole working copy", () => {
  test("is one step on the history, under the working copy's own id", () => {
    const brainDef = BrainDef.emptyBrainDef(services, "Mover");
    const history = new BrainCommandHistory();
    const id = brainDef.id();
    const replacement = BrainDef.emptyBrainDef(services, "Chaser");
    replacement.appendNewPage();

    replaceBrainContent(history, brainDef, replacement);

    assert.equal(history.undoDepth(), 1);
    assert.equal(brainDef.id(), id);
    assert.notEqual(brainDef.id(), replacement.id());
    assert.equal(brainDef.name(), "Chaser");
    assert.equal(brainDef.pages().size(), 2);
  });

  test("undoes back to the brain that stood before it, and redoes forward again", () => {
    const brainDef = BrainDef.emptyBrainDef(services, "Mover");
    const history = new BrainCommandHistory();
    const before = brainDef.toJson();
    const replacement = BrainDef.emptyBrainDef(services, "Chaser");
    replacement.appendNewPage();
    const after = { ...replacement.toJson(), id: brainDef.id() };

    replaceBrainContent(history, brainDef, replacement);
    history.undo();
    assert.deepEqual(brainDef.toJson(), before);

    history.redo();
    assert.deepEqual(brainDef.toJson(), after);
  });

  test("carries the replacement's persisted references onto the working copy", () => {
    const brainDef = BrainDef.emptyBrainDef(services);
    const history = new BrainCommandHistory();
    const replacement = BrainDef.emptyBrainDef(services);
    const ref = { k: "anon", name: "wander" } as const;
    replacement.persistedIdRefs().set("anon:wander", ref);

    replaceBrainContent(history, brainDef, replacement);

    assert.equal(brainDef.persistedIdRefs().get("anon:wander"), ref);
  });

  test("reports an edit to the host", () => {
    const brainDef = BrainDef.emptyBrainDef(services);
    const history = new BrainCommandHistory();
    const { snapshots } = watchInto(history, brainDef);

    replaceBrainContent(history, brainDef, BrainDef.emptyBrainDef(services, "Chaser"));

    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0]().name(), "Chaser");
  });

  test("holds discardable work until it is undone", () => {
    const brainDef = BrainDef.emptyBrainDef(services);
    const history = new BrainCommandHistory();
    const openingDepth = history.undoDepth();

    replaceBrainContent(history, brainDef, BrainDef.emptyBrainDef(services, "Chaser"));
    assert.equal(hasDiscardableEdits({ undoDepth: history.undoDepth(), openingDepth }), true);

    history.undo();
    assert.equal(hasDiscardableEdits({ undoDepth: history.undoDepth(), openingDepth }), false);
  });
});

describe("the chrome each kind of session stands", () => {
  test("a modal session offers cancel and submit, and confirms a discarding close", () => {
    const chrome = brainEditorChrome({});

    assert.deepEqual(chrome.footerControls, ["cancel", "submit"]);
    assert.equal(chrome.closeConfirmsDiscard, true);
  });

  test("a session marked not continuous is modal", () => {
    assert.deepEqual(brainEditorChrome({ continuous: false }), brainEditorChrome({}));
  });

  test("a continuous session offers a single close, and closes without confirming", () => {
    const chrome = brainEditorChrome({ continuous: true });

    assert.deepEqual(chrome.footerControls, ["close"]);
    assert.equal(chrome.closeConfirmsDiscard, false);
  });
});

describe("the props a host passes", () => {
  const handleOpenChange = (_open: boolean) => {};
  const handleSubmit = (_brainDef: BrainDef) => {};
  const handleChange = (_snapshot: () => BrainDef) => {};

  test("a modal host passes what it always has, and stands the modal chrome", () => {
    const props: BrainEditorDialogProps = { isOpen: true, onOpenChange: handleOpenChange, onSubmit: handleSubmit };

    assert.equal(brainEditorChrome(props).closeConfirmsDiscard, true);
  });

  test("a continuous host passes onChange in place of onSubmit, and stands the continuous chrome", () => {
    const props: ContinuousBrainEditorDialogProps = {
      isOpen: true,
      onOpenChange: handleOpenChange,
      continuous: true,
      onChange: handleChange,
    };

    assert.deepEqual(brainEditorChrome(props).footerControls, ["close"]);
  });

  test("each kind of session refuses the other's shape", () => {
    // @ts-expect-error a modal session takes onSubmit
    const modalWithoutSubmit: BrainEditorDialogProps = { isOpen: true, onOpenChange: handleOpenChange };
    // @ts-expect-error a continuous session takes onChange
    const continuousWithoutChange: ContinuousBrainEditorDialogProps = {
      isOpen: true,
      onOpenChange: handleOpenChange,
      continuous: true,
    };

    assert.equal(brainEditorChrome(modalWithoutSubmit).closeConfirmsDiscard, true);
    assert.equal(brainEditorChrome(continuousWithoutChange).closeConfirmsDiscard, false);
  });
});
