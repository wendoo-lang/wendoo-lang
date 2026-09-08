import type { IBrainTileDef, ITileCatalog, RuleSide, RuleTriggerMode } from "@wendoo/core/brain";
import { isDisplayFormat, isVariableFactoryTileId, mkPageTileId } from "@wendoo/core/brain";
import type { BrainCommand, BrainDef, BrainPageDef, BrainRuleDef } from "@wendoo/core/brain/model";
import {
  AddPageCommand,
  AddRuleCommand,
  AddTileCommand,
  DeleteRuleCommand,
  IndentRuleCommand,
  InsertRuleCommand,
  InsertTileCommand,
  kMaxBrainPageCount,
  RemovePageCommand,
  RemoveTileCommand,
  ReplaceTileCommand,
  SetRuleTriggerCommand,
} from "@wendoo/core/brain/model";
import type { BrainTileFactoryDef } from "@wendoo/core/brain/tiles";
import { manufactureLiteralTile, manufactureVariableTile } from "@wendoo/core/brain/tiles";
import type { SerializedDiagParams, ToolDiagnostic } from "./diagnostics.js";
import { toToolDiagnostic } from "./diagnostics.js";
import type { ProjectPageRef, ProjectRule } from "./read-project.js";
import { readRule } from "./read-project.js";
import { decideProposal, rejectionParams } from "./rejection-policy.js";
import type { ProposeEditBatchInput, ProposeEditInput, RuleTriggerName, TileRunEntry } from "./tool-schemas.js";
import { batchPageTileIndex, batchRuleIndex } from "./tool-schemas.js";
import type { AuthoringWorkspace, LandedEdit } from "./workspace.js";
import {
  findPage,
  findPageById,
  findRule,
  findTile,
  ruleIdsByPath,
  rulesNamingTile,
  tileCatalogsOf,
  toRuleSide,
} from "./workspace.js";

/**
 * What one command of a proposal left in, or took out of, the document.
 *
 * A command that added or changed a rule reports it under {@link rule}, read
 * back once the whole proposal stands in the document. A command that removed
 * something reports it as it stood the moment before it went, and says which
 * kind of thing it was under {@link removed}.
 */
export interface EditOutcome {
  /** The rule the command left standing, or the rule it removed. Absent for a command that removed a page. */
  readonly rule?: ProjectRule;
  /** The page `addPage` minted, or the page `deletePage` removed. Absent for every other command. */
  readonly page?: ProjectPageRef;
  /**
   * The page the rule under {@link EditOutcome.rule} stands on, read as the
   * command left it, or as it stood the moment before a removed rule went.
   * `pageIndex` is that page's position at that moment. Absent for a command
   * that removed a page, and for a rule the document holds on no page.
   */
  readonly onPage?: ProjectPageRef;
  /** What the command took out of the document; absent for a command that added or changed. */
  readonly removed?: "rule" | "page";
}

/** An edit that landed in the document. */
export interface ProposalAccepted extends EditOutcome {
  readonly ok: true;
  /** Command-history depth after the edit; every entry is undoable. */
  readonly historyDepth: number;
}

/** A batch of edits that landed in the document together. */
export interface BatchAccepted {
  readonly ok: true;
  /** What the batch's commands left behind, one per command and in that order. */
  readonly results: readonly EditOutcome[];
  /** Command-history depth after the batch, which the batch raised by one. */
  readonly historyDepth: number;
}

/** An edit the bridge refused, leaving the document untouched. */
export interface ProposalRejected {
  readonly ok: false;
  /** Stable diagnostic code that rejected the edit. */
  readonly code: number;
  /**
   * Machine-readable values that place and describe the refusal: what the
   * rejecting diagnostic reports, the durable id of the rule under `ruleId`,
   * and the `side` and `tileId` a companion diagnostic pins for the same
   * failure when one does.
   */
  readonly params: SerializedDiagParams;
}

/** An edit that never reached validation because the request named something absent. */
export interface ProposalUnresolved {
  readonly ok: false;
  /**
   * `invalid_mint_input` reports a factory tile named without the input it
   * mints from, or with an input the factory makes no tile of.
   * `invalid_display_format` reports a mint whose `displayFormat` is outside the
   * format grammar, and names the format. `unnamed_literal` reports a mint of a
   * literal that carries an identity of its own without the name it has to read
   * by, and names the factory tile. `rule_nesting_too_deep` reports a parent
   * rule the document cannot nest another rule under. `unknown_batch_reference`
   * reports a `#N` naming no command of the batch that creates a rule before
   * this one runs. `page_limit_reached` reports a document already holding as
   * many pages as a brain may have. `last_page` reports an attempt to remove the
   * only page a brain has left. `page_still_referenced` reports a page other
   * rules still switch to, and names them under {@link referencedBy}.
   */
  readonly error:
    | "unknown_rule"
    | "unknown_page"
    | "unknown_tile"
    | "position_out_of_range"
    | "invalid_mint_input"
    | "invalid_display_format"
    | "unnamed_literal"
    | "rule_nesting_too_deep"
    | "unknown_batch_reference"
    | "page_limit_reached"
    | "last_page"
    | "page_still_referenced";
  /** The rule id, page id, page index, tile id, position, display format, or limit the request ran into. */
  readonly named: string;
  /** Durable ids of the rules still naming what the request asked to remove. */
  readonly referencedBy?: readonly string[];
  /** Index in the batch of the command that named it; absent outside a batch. */
  readonly commandIndex?: number;
}

/** Result of one `propose_edit` call carrying a single command. */
export type ProposalResult = ProposalAccepted | ProposalRejected | ProposalUnresolved;

/** Result of one `propose_edit` call carrying a batch of commands. */
export type BatchResult = BatchAccepted | ProposalRejected | ProposalUnresolved;

/** Milliseconds an accepted batch waits between replaying one command and the next. */
export const batchReplayStepMs = 120;

/** The operation that places a run of tiles as one transaction. */
type PlaceTilesInput = Extract<ProposeEditInput, { op: "placeTiles" }>;

/** The operation that nests a new rule under an existing one. */
type AddChildRuleInput = Extract<ProposeEditInput, { op: "addChildRule" }>;

/** A rule under the id every tool addresses it by. */
interface RuleRef {
  readonly ruleId: string;
  readonly rule: BrainRuleDef;
}

/**
 * Nests a new empty rule under `parent` as its last child. The first execute
 * makes the rule and names it through {@link NestRuleCommand.nestedRule}; every
 * later execute nests that same rule again, so its id survives an undo/redo
 * round trip. A document that cannot hold another level under `parent` leaves
 * nothing behind and names no rule. Undoing takes the rule back out.
 */
class NestRuleCommand implements BrainCommand {
  private insert_?: InsertRuleCommand;
  private indent_?: IndentRuleCommand;
  private nested_?: BrainRuleDef;

  constructor(private readonly parent: BrainRuleDef) {}

  execute(): void {
    if (this.insert_ && this.indent_) {
      this.insert_.execute();
      this.indent_.execute();
      return;
    }

    const insert = new InsertRuleCommand(this.parent, "after");
    insert.execute();
    const inserted = insert.insertedRule();
    if (!inserted) return;

    const indent = new IndentRuleCommand(inserted);
    indent.execute();
    if (inserted.ancestor() !== this.parent) {
      indent.undo();
      insert.undo();
      return;
    }

    this.insert_ = insert;
    this.indent_ = indent;
    this.nested_ = inserted;
  }

  undo(): void {
    this.indent_?.undo();
    this.insert_?.undo();
  }

  /** The rule this command nests, or undefined when the document cannot hold it. */
  nestedRule(): BrainRuleDef | undefined {
    return this.nested_;
  }

  getDescription(): string {
    return "Add child rule";
  }
}

/**
 * Gives `trigger` to the rule `resolve` names, which the commands running
 * before this one leave standing. The rule is resolved on the first execute and
 * kept, so undo and every later execute address that same rule; a `resolve`
 * naming none leaves the document untouched.
 */
class SetNewRuleTriggerCommand implements BrainCommand {
  private applied_?: SetRuleTriggerCommand;

  constructor(
    private readonly resolve: () => BrainRuleDef | undefined,
    private readonly trigger: RuleTriggerMode
  ) {}

  execute(): void {
    if (!this.applied_) {
      const rule = this.resolve();
      if (!rule) return;
      this.applied_ = new SetRuleTriggerCommand(rule, this.trigger);
    }
    this.applied_.execute();
  }

  undo(): void {
    this.applied_?.undo();
  }

  getDescription(): string {
    return "Set rule trigger";
  }
}

/**
 * Appends a page and gives it `name` when one is asked for. The first execute
 * makes the page and names it, and names it through {@link MakePageCommand.page};
 * every later execute puts that same page back, so its id, its name, and the
 * rule it opens with survive an undo/redo round trip. A brain that cannot hold
 * another page leaves nothing behind and names no page. Undoing takes the page
 * back out.
 */
class MakePageCommand implements BrainCommand {
  private readonly add_: AddPageCommand;
  private page_?: BrainPageDef;

  constructor(
    private readonly brainDef: BrainDef,
    private readonly name?: string
  ) {
    this.add_ = new AddPageCommand(brainDef);
  }

  execute(): void {
    const before = this.brainDef.pages().size();
    this.add_.execute();
    if (this.page_ !== undefined) return;
    const pages = this.brainDef.pages();
    if (pages.size() !== before + 1) return;
    const page = pages.get(pages.size() - 1) as BrainPageDef;
    if (this.name !== undefined) page.setName(this.name);
    this.page_ = page;
  }

  undo(): void {
    this.add_.undo();
  }

  /** The page this command makes, or undefined when the brain cannot hold another. */
  page(): BrainPageDef | undefined {
    return this.page_;
  }

  getDescription(): string {
    return this.name === undefined ? "Add page" : `Add page "${this.name}"`;
  }
}

/** What one edit left behind, read once its commands have run. */
interface EditLanding {
  /** The rule the edit is judged on and reports. Absent for an edit that took its subject out of the document. */
  readonly judged?: RuleRef;
  /** What the edit reports beyond {@link judged}, captured as the edit ran. */
  readonly outcome: EditOutcome;
  /** Where the editor should look now. Absent for an edit with no place to show. */
  readonly landed?: LandedEdit;
}

/** The editor commands one proposed edit runs, and what they leave behind. */
interface BuiltEdit {
  /** Commands to execute in the order given. */
  readonly commands: readonly BrainCommand[];
  /** What the edit left behind, read after its commands have run. */
  readonly land: () => EditLanding | undefined;
  /** What to report when the commands ran but left nothing behind. */
  readonly absent?: ProposalUnresolved;
  /** How the history entry reads when the edit runs more than one command. */
  readonly historyLabel?: string;
}

/**
 * The page `rule` stands on, at the position that page holds right now, or
 * `undefined` when the document holds `rule` on no page.
 */
function pageOf(brainDef: BrainDef, rule: BrainRuleDef): ProjectPageRef | undefined {
  const page = rule.page();
  if (!page) return undefined;
  return { pageId: page.pageId(), pageIndex: brainDef.pages().indexOf(page), name: page.name() };
}

/** The landing of an edit that leaves `located` standing and shows it where it is. */
function ruleLanding(brainDef: BrainDef, located: RuleRef): EditLanding {
  const onPage = pageOf(brainDef, located.rule);
  return {
    judged: located,
    outcome: onPage === undefined ? {} : { onPage },
    ...(onPage === undefined ? {} : { landed: { pageId: onPage.pageId, ruleId: located.ruleId } }),
  };
}

/** The command that puts `tile` at `position` on `side` of `rule`, which currently holds `tileCount` tiles. */
function placementCommand(
  rule: BrainRuleDef,
  side: RuleSide,
  position: number,
  tileCount: number,
  tile: IBrainTileDef
): BrainCommand {
  return position === tileCount
    ? new AddTileCommand(rule, side, tile)
    : new InsertTileCommand(rule, side, position, tile);
}

/**
 * The commands giving the rule `resolve` names the mode `trigger` asks for, and
 * none for a rule left in the `when` mode every new rule already carries.
 */
function triggerCommands(
  resolve: () => BrainRuleDef | undefined,
  trigger: RuleTriggerName | undefined
): BrainCommand[] {
  if (trigger === undefined || trigger === "when") return [];
  return [new SetNewRuleTriggerCommand(resolve, trigger)];
}

/** The operations that name no rule of the document at all. */
type RulelessInput = Extract<ProposeEditInput, { op: "addRule" | "addPage" | "deletePage" }>;

/** True for an operation that names no rule of the document at all. */
function namesNoRule(input: ProposeEditInput): input is RulelessInput {
  return input.op === "addRule" || input.op === "addPage" || input.op === "deletePage";
}

/** The rule an edit runs against, or `undefined` for an edit that makes its own or names none. */
function editTarget(workspace: AuthoringWorkspace, input: ProposeEditInput): RuleRef | ProposalUnresolved | undefined {
  if (namesNoRule(input)) return undefined;
  const named = input.op === "addChildRule" ? input.parentRuleId : input.ruleId;
  const located = findRule(workspace.brainDef, named);
  return located ?? { ok: false, error: "unknown_rule", named };
}

/**
 * Turn one proposed edit into the editor commands that apply it, resolving
 * every tile it names and minting the tiles a factory entry describes. `target`
 * is the rule the edit runs against, absent for an edit that makes its own.
 * Reports what the edit named that the document cannot supply.
 */
function buildEdit(
  workspace: AuthoringWorkspace,
  input: ProposeEditInput,
  target: RuleRef | undefined,
  madePages?: ReadonlyMap<number, string>
): BuiltEdit | ProposalUnresolved {
  if (input.op === "addRule") {
    const page = findPage(workspace.brainDef, input.pageIndex);
    if (!page) return { ok: false, error: "unknown_page", named: String(input.pageIndex) };
    const appended = () => {
      const rules = page.children();
      return rules.get(rules.size() - 1) as BrainRuleDef;
    };
    return {
      commands: [new AddRuleCommand(page), ...triggerCommands(appended, input.trigger)],
      land: () => {
        const rule = appended();
        return ruleLanding(workspace.brainDef, { ruleId: rule.ruleId(), rule });
      },
      historyLabel: "Add rule",
    };
  }

  if (input.op === "addPage") return addPageEdit(workspace, input.name);
  if (input.op === "deletePage") return deletePageEdit(workspace, input.pageId);

  const located = target as RuleRef;
  if (input.op === "addChildRule") return nestedEdit(workspace, located, input);
  if (input.op === "deleteRule") return deleteRuleEdit(workspace, located);
  if (input.op === "setRuleTrigger") {
    return {
      commands: [new SetRuleTriggerCommand(located.rule, input.trigger)],
      land: () => ruleLanding(workspace.brainDef, located),
    };
  }

  const side = toRuleSide(input.side);
  const tileCount = located.rule.side(side).tiles().size();
  const land = () => ruleLanding(workspace.brainDef, located);

  if (input.op === "deleteTile") {
    if (input.position >= tileCount)
      return { ok: false, error: "position_out_of_range", named: String(input.position) };
    return { commands: [new RemoveTileCommand(located.rule, side, input.position)], land };
  }

  if (input.op === "placeTiles") return tileRunEdit(workspace, input, located, side, tileCount, madePages);

  const tile = resolveRunEntry(workspace, input.tileId, madePages);
  if ("ok" in tile) return tile;

  if (input.op === "replaceTile") {
    if (input.position >= tileCount)
      return { ok: false, error: "position_out_of_range", named: String(input.position) };
    return { commands: [new ReplaceTileCommand(located.rule, side, input.position, tile)], land };
  }

  const position = input.position ?? tileCount;
  if (position > tileCount) return { ok: false, error: "position_out_of_range", named: String(position) };
  return { commands: [placementCommand(located.rule, side, position, tileCount, tile)], land };
}

/**
 * The edit that appends a page. The page arrives holding one empty rule, and
 * that rule is what the edit is judged on, reports, and shows, so a batch can
 * name it as `#N` and fill the new page in the same run.
 */
function addPageEdit(workspace: AuthoringWorkspace, name?: string): BuiltEdit | ProposalUnresolved {
  const brainDef = workspace.brainDef;
  const atLimit: ProposalUnresolved = { ok: false, error: "page_limit_reached", named: String(kMaxBrainPageCount) };
  if (brainDef.pages().size() >= kMaxBrainPageCount) return atLimit;

  const command = new MakePageCommand(brainDef, name);
  return {
    commands: [command],
    land: () => {
      const page = command.page();
      const opening = page?.children().get(0) as BrainRuleDef | undefined;
      if (!page || !opening) return undefined;
      const minted: ProjectPageRef = {
        pageId: page.pageId(),
        pageIndex: brainDef.pages().indexOf(page),
        name: page.name(),
      };
      return {
        judged: { ruleId: opening.ruleId(), rule: opening },
        outcome: { page: minted, onPage: minted },
        landed: { pageId: page.pageId(), ruleId: opening.ruleId() },
      };
    },
    absent: atLimit,
  };
}

/**
 * The edit that removes `located` and every rule nested under it. The rule is
 * read before it goes, so the edit reports what came out, and the editor is
 * shown the page it stood on.
 */
function deleteRuleEdit(workspace: AuthoringWorkspace, located: RuleRef): BuiltEdit {
  const rule = readRule(located.rule, workspace.environment.appServices.localizer);
  const onPage = pageOf(workspace.brainDef, located.rule);
  return {
    commands: [new DeleteRuleCommand(located.rule)],
    land: () => ({
      outcome: { rule, removed: "rule", ...(onPage === undefined ? {} : { onPage }) },
      ...(onPage === undefined ? {} : { landed: { pageId: onPage.pageId, ruleId: located.ruleId } }),
    }),
  };
}

/** Durable ids of `page`'s rules and of every rule nested under them. */
function ruleIdsOn(page: BrainPageDef): Set<string> {
  const ids = new Set<string>();
  const collect = (rule: BrainRuleDef): void => {
    ids.add(rule.ruleId());
    const children = rule.children();
    for (let i = 0; i < children.size(); i++) collect(children.get(i) as BrainRuleDef);
  };
  const rules = page.children();
  for (let i = 0; i < rules.size(); i++) collect(rules.get(i) as BrainRuleDef);
  return ids;
}

/**
 * The edit that removes the page `pageId` names and every rule on it. Reports
 * `last_page` for the only page a brain has left, and `page_still_referenced`,
 * naming them, when rules elsewhere in the document switch to this page. The
 * editor is shown a page the document still holds.
 */
function deletePageEdit(workspace: AuthoringWorkspace, pageId: string): BuiltEdit | ProposalUnresolved {
  const brainDef = workspace.brainDef;
  const located = findPageById(brainDef, pageId);
  if (!located) return { ok: false, error: "unknown_page", named: pageId };
  if (brainDef.pages().size() <= 1) return { ok: false, error: "last_page", named: pageId };

  const goingWithIt = ruleIdsOn(located.page);
  const referencedBy = rulesNamingTile(brainDef, mkPageTileId(pageId)).filter((ruleId) => !goingWithIt.has(ruleId));
  if (referencedBy.length > 0) return { ok: false, error: "page_still_referenced", named: pageId, referencedBy };

  const removed: ProjectPageRef = { pageId, pageIndex: located.pageIndex, name: located.page.name() };
  return {
    commands: [new RemovePageCommand(brainDef, located.pageIndex)],
    land: () => {
      const pages = brainDef.pages();
      const surviving = pages.get(Math.min(located.pageIndex, pages.size() - 1)) as BrainPageDef | undefined;
      return {
        outcome: { page: removed, removed: "page" },
        ...(surviving === undefined ? {} : { landed: { pageId: surviving.pageId() } }),
      };
    },
  };
}

/** The edit that nests a new rule under `parent`. */
function nestedEdit(workspace: AuthoringWorkspace, parent: RuleRef, input: AddChildRuleInput): BuiltEdit {
  const command = new NestRuleCommand(parent.rule);
  return {
    commands: [command, ...triggerCommands(() => command.nestedRule(), input.trigger)],
    land: () => {
      const nested = command.nestedRule();
      return nested ? ruleLanding(workspace.brainDef, { ruleId: nested.ruleId(), rule: nested }) : undefined;
    },
    absent: { ok: false, error: "rule_nesting_too_deep", named: input.parentRuleId },
    historyLabel: "Add child rule",
  };
}

/**
 * The edit that places a run of tiles from `position` in the order given. Every
 * entry resolves before any command is built, so a run naming a tile the
 * document cannot supply builds nothing.
 */
function tileRunEdit(
  workspace: AuthoringWorkspace,
  input: PlaceTilesInput,
  located: RuleRef,
  side: RuleSide,
  tileCount: number,
  madePages?: ReadonlyMap<number, string>
): BuiltEdit | ProposalUnresolved {
  const position = input.position ?? tileCount;
  if (position > tileCount) return { ok: false, error: "position_out_of_range", named: String(position) };

  const tiles: IBrainTileDef[] = [];
  for (const entry of input.tileIds) {
    const tile = resolveRunEntry(workspace, entry, madePages);
    if ("ok" in tile) return tile;
    tiles.push(tile);
  }

  // Each tile lands past the ones before it, so the run reads in the order given.
  const commands = tiles.map((tile, index) =>
    placementCommand(located.rule, side, position + index, tileCount + index, tile)
  );
  return {
    commands,
    land: () => ruleLanding(workspace.brainDef, located),
    historyLabel: commands.length === 1 ? "Place tile" : `Place ${commands.length} tiles`,
  };
}

/** A run entry in its object form: the tile it names, plus any mint input. */
type TileMint = Exclude<TileRunEntry, string>;

/**
 * The tile one entry of a run names. An entry naming a factory tile mints the
 * tile its input describes and registers it in the document's catalog, reusing
 * an equivalent tile the catalog already holds. An entry of the form `#N.page`
 * names the page tile of the page `madePages` records the batch's command at
 * index N as having made. Returns `invalid_mint_input` when the entry names a
 * factory without the input that factory mints from, the code the literal mint
 * refused the entry under (see {@link ProposalUnresolved.error}), and
 * `unknown_batch_reference` for a `#N.page` naming no command of the batch that
 * makes a page before this one runs.
 */
export function resolveRunEntry(
  workspace: AuthoringWorkspace,
  entry: TileRunEntry,
  madePages?: ReadonlyMap<number, string>
): IBrainTileDef | ProposalUnresolved {
  const mint: TileMint = typeof entry === "string" ? { tileId: entry } : entry;
  const madeIndex = batchPageTileIndex(mint.tileId);
  if (madeIndex !== undefined) {
    const pageId = madePages?.get(madeIndex);
    if (pageId === undefined) return { ok: false, error: "unknown_batch_reference", named: mint.tileId };
    const pageTile = findTile(tileCatalogsOf(workspace.catalogs), mkPageTileId(pageId));
    if (!pageTile) return { ok: false, error: "unknown_tile", named: mkPageTileId(pageId) };
    return pageTile;
  }
  const tile = findTile(tileCatalogsOf(workspace.catalogs), mint.tileId);
  if (!tile) return { ok: false, error: "unknown_tile", named: mint.tileId };
  if (tile.kind !== "factory") return tile;

  const factoryTileDef = tile as BrainTileFactoryDef;
  const catalog = workspace.brainDef.catalog();
  const minted = isVariableFactoryTileId(mint.tileId)
    ? manufactureVariableTile(factoryTileDef, catalog, mint.name ?? "")
    : mintLiteral(factoryTileDef, catalog, mint);
  if (!minted) return { ok: false, error: "invalid_mint_input", named: mint.tileId };
  return minted;
}

/**
 * The literal `factoryTileDef` mints from `mint`, registered in `catalog` under
 * the name the entry gives it. Returns `undefined` when the entry carries no
 * value or the factory makes no tile of it, `invalid_display_format` for a
 * format outside the grammar, and `unnamed_literal` for a literal minted with an
 * identity of its own but no name, which would read by its raw identity.
 */
function mintLiteral(
  factoryTileDef: BrainTileFactoryDef,
  catalog: ITileCatalog,
  mint: TileMint
): IBrainTileDef | ProposalUnresolved | undefined {
  if (mint.value === undefined) return undefined;
  if (mint.displayFormat !== undefined && !isDisplayFormat(mint.displayFormat)) {
    return { ok: false, error: "invalid_display_format", named: mint.displayFormat };
  }
  const minted = manufactureLiteralTile(factoryTileDef, catalog, mint.value, mint.displayFormat, mint.name);
  if (minted && minted.uniqueId !== undefined && minted.displayName === undefined) {
    return { ok: false, error: "unnamed_literal", named: mint.tileId };
  }
  return minted;
}

/** Tile ids `catalog` holds right now. */
function catalogTileIds(catalog: ITileCatalog): Set<string> {
  const tileIds = new Set<string>();
  catalog.getAll().forEach((tileDef) => {
    tileIds.add(tileDef.tileId);
  });
  return tileIds;
}

/** Drop every tile `catalog` has gained since it held exactly `before`. */
function dropTilesRegisteredSince(catalog: ITileCatalog, before: ReadonlySet<string>): void {
  for (const tileId of catalogTileIds(catalog)) {
    if (!before.has(tileId)) catalog.delete(tileId);
  }
}

/**
 * Every parse and type diagnostic `rule`'s own typecheck reported, for the whole
 * rule, each addressed to the rule that reported it.
 */
function ruleDiagnostics(rule: BrainRuleDef): ToolDiagnostic[] {
  // Both sides hold the same whole-rule typecheck result.
  const result = rule.when().typecheckResult();
  if (!result) return [];
  const noRuleIds = new Map<string, string>();
  const ruleId = rule.ruleId();
  const diagnostics: ToolDiagnostic[] = [];
  const addressed = (diagnostic: ToolDiagnostic): ToolDiagnostic => ({
    code: diagnostic.code,
    params: { ...diagnostic.params, ruleId },
  });
  result.parseResult.diags.forEach((diag) => {
    diagnostics.push(addressed(toToolDiagnostic(diag.code, diag.params, noRuleIds)));
  });
  result.typeInfo.diags.forEach((diag) => {
    diagnostics.push(addressed(toToolDiagnostic(diag.code, diag.params, noRuleIds)));
  });
  return diagnostics;
}

/**
 * Whole-brain build diagnostics that bear on an edit: every error, plus any
 * other diagnostic naming one of the rules in `ruleIds`. Pass an empty set for
 * an edit whose rule the document does not hold yet.
 */
function buildDiagnostics(workspace: AuthoringWorkspace, ruleIds: ReadonlySet<string>): ToolDiagnostic[] {
  const build = workspace.environment.linkBrain(workspace.brainDef);
  const byPath = ruleIdsByPath(workspace.brainDef);
  const diagnostics: ToolDiagnostic[] = [];
  build.diagnostics.forEach((diag) => {
    const diagnostic = toToolDiagnostic(diag.code, diag.params, byPath);
    const named = diagnostic.params?.ruleId;
    if (diag.severity === "error" || (typeof named === "string" && ruleIds.has(named))) {
      diagnostics.push(diagnostic);
    }
  });
  return diagnostics;
}

/**
 * Every diagnostic the document reports that bears on an edit to `rules`: each
 * of those rules' own typecheck, and the whole-brain build.
 */
function proposalDiagnostics(workspace: AuthoringWorkspace, rules: readonly RuleRef[]): ToolDiagnostic[] {
  const diagnostics: ToolDiagnostic[] = [];
  const ruleIds = new Set<string>();
  for (const { ruleId, rule } of rules) {
    rule.typecheck();
    ruleIds.add(ruleId);
    diagnostics.push(...ruleDiagnostics(rule));
  }
  return [...diagnostics, ...buildDiagnostics(workspace, ruleIds)];
}

/** The key a diagnostic is counted under: its code, and the durable id of the rule it names. */
function diagnosticKey(diagnostic: ToolDiagnostic): string {
  const ruleId = diagnostic.params?.ruleId;
  return `${diagnostic.code}@${typeof ruleId === "string" ? ruleId : ""}`;
}

/** How many diagnostics of each key `diagnostics` holds. */
function countByKey(diagnostics: readonly ToolDiagnostic[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const diagnostic of diagnostics) {
    const key = diagnosticKey(diagnostic);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * The rejection-relevant diagnostics an edit introduced: those whose
 * `(code, ruleId)` key the document reports more often after the edit than
 * before it. A diagnostic already standing in the document, in any rule and at
 * any severity, is not one of these, so an edit that leaves the document no
 * worse carries none. An edit that removes diagnostics without adding any
 * carries none either.
 */
function newDiagnostics(before: readonly ToolDiagnostic[], after: readonly ToolDiagnostic[]): ToolDiagnostic[] {
  const beforeCounts = countByKey(before);
  const seen = new Map<string, number>();
  const introduced: ToolDiagnostic[] = [];
  for (const diagnostic of after) {
    const key = diagnosticKey(diagnostic);
    const index = (seen.get(key) ?? 0) + 1;
    seen.set(key, index);
    if (index > (beforeCounts.get(key) ?? 0)) introduced.push(diagnostic);
  }
  return introduced;
}

/** The refusal the proposal policy produces for `rules` as they stand, or undefined when it accepts them. */
function refusalFor(
  workspace: AuthoringWorkspace,
  rules: readonly RuleRef[],
  before: readonly ToolDiagnostic[]
): ProposalRejected | undefined {
  const introduced = newDiagnostics(before, proposalDiagnostics(workspace, rules));
  const decision = decideProposal(introduced);
  if (decision.verdict === "accept") return undefined;
  const rejection = decision.rejectedBy!;
  return {
    ok: false,
    code: rejection.code,
    params: rejectionParams(rejection, introduced, rules[0]?.ruleId ?? ""),
  };
}

/** Tell `workspace`'s watcher where an edit has just come to rest. */
function reportLanded(workspace: AuthoringWorkspace, landed: LandedEdit | undefined): void {
  if (landed === undefined) return;
  workspace.onEditLanded?.(landed);
}

/** What an accepted landing reports back, reading its rule as the document holds it now. */
function outcomeOf(workspace: AuthoringWorkspace, landing: EditLanding): EditOutcome {
  if (!landing.judged) return landing.outcome;
  return { ...landing.outcome, rule: readRule(landing.judged.rule, workspace.environment.appServices.localizer) };
}

/** How an applied edit is kept or taken back once the policy has judged it. */
interface EditTransaction {
  /** Leave the applied commands in the document and in the history. */
  readonly keep: () => void;
  /** Take the applied commands back out, leaving no history entry. */
  readonly takeBack: () => void;
}

/**
 * Judge the edit now standing in the document against the proposal policy,
 * keeping it or taking it back through `transaction`. Validation reads the end
 * state, so a sequence of commands is judged once, by what it leaves behind,
 * and only against the diagnostics the edit introduced over `before`. An edit
 * that removed its subject is judged on the whole document alone.
 */
function decideApplied(
  workspace: AuthoringWorkspace,
  landing: EditLanding,
  before: readonly ToolDiagnostic[],
  transaction: EditTransaction
): ProposalResult {
  const refusal = refusalFor(workspace, landing.judged ? [landing.judged] : [], before);
  if (refusal) {
    transaction.takeBack();
    return refusal;
  }

  transaction.keep();
  reportLanded(workspace, landing.landed);
  return {
    ok: true,
    ...outcomeOf(workspace, landing),
    historyDepth: workspace.history.undoDepth(),
  };
}

/**
 * Run one proposed edit through the editor's own command and validation path.
 * An accepted edit stays in the document as an undoable history entry; a
 * rejected edit is undone before returning, so the document rests exactly as it
 * did before the call. A tile the edit minted is registered in the document's
 * catalog as it resolves and is dropped again if the edit does not land.
 * `placeTiles` applies its whole run as one transaction and one history entry.
 */
export function proposeEdit(workspace: AuthoringWorkspace, input: ProposeEditInput): ProposalResult {
  const target = editTarget(workspace, input);
  if (target && "ok" in target) return target;

  // A rule the edit has yet to make cannot be named by any diagnostic.
  const before = target ? proposalDiagnostics(workspace, [target]) : buildDiagnostics(workspace, new Set<string>());

  const catalog = workspace.brainDef.catalog();
  const registeredBefore = catalogTileIds(catalog);
  const built = buildEdit(workspace, input, target);
  if ("ok" in built) {
    dropTilesRegisteredSince(catalog, registeredBefore);
    return built;
  }

  const runs = built.commands.length > 1 || input.op === "placeTiles";
  if (runs) workspace.history.beginBatch(built.historyLabel ?? "Edit");
  for (const command of built.commands) workspace.history.executeCommand(command);

  const takeBack = () => {
    if (runs) workspace.history.abortBatch();
    else workspace.history.undo();
    dropTilesRegisteredSince(catalog, registeredBefore);
  };

  const landing = built.land();
  if (!landing) {
    takeBack();
    return built.absent as ProposalUnresolved;
  }

  return decideApplied(workspace, landing, before, {
    keep: () => {
      if (runs) workspace.history.endBatch();
    },
    takeBack,
  });
}

/** Resolve once `ms` milliseconds have passed. */
function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * The rule a batch command names: the document's own rule under a durable id,
 * or the rule the batch's earlier command at `#N` made. Reports
 * `unknown_batch_reference` for an index no earlier command of the batch
 * created a rule at.
 */
function batchTarget(
  workspace: AuthoringWorkspace,
  input: ProposeEditInput,
  made: ReadonlyMap<number, RuleRef>
): RuleRef | ProposalUnresolved | undefined {
  if (namesNoRule(input)) return undefined;
  const named = input.op === "addChildRule" ? input.parentRuleId : input.ruleId;
  const index = batchRuleIndex(named);
  if (index === undefined) return editTarget(workspace, input);
  return made.get(index) ?? { ok: false, error: "unknown_batch_reference", named };
}

/** Every rule the batch's commands name that the document already holds. */
function standingRules(workspace: AuthoringWorkspace, input: ProposeEditBatchInput): RuleRef[] {
  const rules: RuleRef[] = [];
  const seen = new Set<string>();
  for (const command of input.commands) {
    if (namesNoRule(command)) continue;
    const named = command.op === "addChildRule" ? command.parentRuleId : command.ruleId;
    if (batchRuleIndex(named) !== undefined || seen.has(named)) continue;
    seen.add(named);
    const located = findRule(workspace.brainDef, named);
    if (located) rules.push(located);
  }
  return rules;
}

/**
 * The rules a batch is judged on: those it named and those its commands left
 * standing, each once. A rule the batch took out of the document is not among
 * them, however it was named.
 */
function judgedRules(
  workspace: AuthoringWorkspace,
  standing: readonly RuleRef[],
  landings: readonly EditLanding[]
): RuleRef[] {
  const judged: RuleRef[] = [];
  const seen = new Set<string>();
  const add = (located: RuleRef): void => {
    if (seen.has(located.ruleId)) return;
    if (!findRule(workspace.brainDef, located.ruleId)) return;
    seen.add(located.ruleId);
    judged.push(located);
  };
  for (const located of standing) add(located);
  for (const landing of landings) {
    if (landing.judged) add(landing.judged);
  }
  return judged;
}

/**
 * Apply a batch of proposed edits as one thing. The commands run in the order
 * given, states in the middle are not judged, and the policy reads only the
 * state the whole run leaves. A batch that is refused leaves the document, the
 * history, and the catalog exactly as they stood; a batch that is accepted
 * replays its commands into the document one at a time, {@link batchReplayStepMs}
 * apart, and closes as a single undoable history entry, so the call returns once
 * the document holds the state that was judged.
 *
 * Reports the index of the command that named something the document cannot
 * supply.
 */
export async function proposeEditBatch(
  workspace: AuthoringWorkspace,
  input: ProposeEditBatchInput
): Promise<BatchResult> {
  const catalog = workspace.brainDef.catalog();
  const registeredBefore = catalogTileIds(catalog);
  const standing = standingRules(workspace, input);
  const before = proposalDiagnostics(workspace, standing);

  // Each editor command, under the index of the batch command that built it, so
  // the replay can say where the step it just took came to rest.
  const applied: { readonly command: BrainCommand; readonly at: number }[] = [];
  const landings: EditLanding[] = [];
  const made = new Map<number, RuleRef>();
  const madePages = new Map<number, string>();
  const undoApplied = () => {
    for (let i = applied.length - 1; i >= 0; i--) applied[i]?.command.undo();
  };
  const rollBack = () => {
    undoApplied();
    dropTilesRegisteredSince(catalog, registeredBefore);
  };

  for (const [index, command] of input.commands.entries()) {
    const target = batchTarget(workspace, command, made);
    if (target && "ok" in target) {
      rollBack();
      return { ...target, commandIndex: index };
    }

    const built = buildEdit(workspace, command, target, madePages);
    if ("ok" in built) {
      rollBack();
      return { ...built, commandIndex: index };
    }

    for (const editorCommand of built.commands) {
      editorCommand.execute();
      applied.push({ command: editorCommand, at: index });
    }

    const landing = built.land();
    if (!landing) {
      rollBack();
      return { ...(built.absent as ProposalUnresolved), commandIndex: index };
    }
    if (landing.judged && (command.op === "addRule" || command.op === "addChildRule" || command.op === "addPage")) {
      made.set(index, landing.judged);
    }
    if (landing.outcome.page && command.op === "addPage") madePages.set(index, landing.outcome.page.pageId);
    landings.push(landing);
  }

  const refusal = refusalFor(workspace, judgedRules(workspace, standing, landings), before);
  // Every command comes back out either way: a refused batch leaves nothing
  // behind, and an accepted one is replayed a command at a time.
  undoApplied();
  if (refusal) {
    dropTilesRegisteredSince(catalog, registeredBefore);
    return refusal;
  }

  workspace.history.beginBatch(`Apply ${input.commands.length} edits`);
  for (const [index, step] of applied.entries()) {
    if (index > 0) await pause(batchReplayStepMs);
    workspace.history.executeCommand(step.command);
    reportLanded(workspace, landings[step.at]?.landed);
  }
  workspace.history.endBatch();

  return {
    ok: true,
    results: landings.map((landing) => outcomeOf(workspace, landing)),
    historyDepth: workspace.history.undoDepth(),
  };
}
