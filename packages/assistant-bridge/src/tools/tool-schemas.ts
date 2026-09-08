import { z } from "zod";

/**
 * The rule side a tile sits on, in the spelling the model reads and writes.
 * Maps to core's numeric `RuleSide` at the bridge boundary.
 */
const ruleSideSchema = z.enum(["when", "do"]);

/** {@link ruleSideSchema} as a type. */
export type RuleSideName = z.infer<typeof ruleSideSchema>;

/**
 * The trigger mode a rule carries, in the spelling the model reads and writes,
 * matching core's `RuleTriggerMode`. Carried on every operation that makes a
 * rule or changes one's mode.
 */
const ruleTriggerSchema = z
  .enum(["when", "otherwise", "then"])
  .describe(
    'What arms the rule. "when" evaluates every think it is scheduled and is the default. "otherwise" fires on the thinks no earlier rule of its flat otherwise-run fired, making the run an if/else-if/else ladder. "then" runs once the rule above it completes -- its DO finished and every rule that firing spawned finished with it -- and a run of them sequences. The first rule at a level takes "when" alone; the other two need a rule above them at the same level.'
  );

/** {@link ruleTriggerSchema} as a type. */
export type RuleTriggerName = z.infer<typeof ruleTriggerSchema>;

/** The id a tool names a rule by: the rule's own durable id. */
const ruleIdSchema = z
  .string()
  .describe(
    "Rule id, exactly as read_project reports it. It stays the rule's id as other rules come and go. Inside a batch, \"#N\" instead names the rule the batch's own command at index N creates."
  );

/** The id a tool names a page by: the page's own durable id. */
const pageIdSchema = z
  .string()
  .describe("Page id, exactly as read_project reports it. It stays the page's id as other pages come and go.");

/**
 * Commands one `propose_edit` batch may carry, which is one stage of a build.
 * A batch over this is refused by the tool's own schema, before any command
 * runs.
 */
export const maxBatchCommands = 24;

/**
 * Tiles one `placeTiles` run may carry. A run over this is refused by the
 * tool's own schema, before any tile is placed.
 */
export const maxPlacedTiles = 12;

/** The form a batch command names a rule an earlier command in the same batch created. */
const batchRulePattern = /^#(\d+)$/;

/** The form a batch command names the page tile of a page an earlier command in the same batch created. */
const batchPageTilePattern = /^#(\d+)\.page$/;

/**
 * The index of the batch command that creates the rule `ruleId` names. Returns
 * `undefined` for a durable rule id.
 */
export function batchRuleIndex(ruleId: string): number | undefined {
  const matched = batchRulePattern.exec(ruleId);
  return matched ? Number(matched[1]) : undefined;
}

/**
 * The index of the batch command whose page `tileId` names the page tile of.
 * Returns `undefined` for any other tile id.
 */
export function batchPageTileIndex(tileId: string): number | undefined {
  const matched = batchPageTilePattern.exec(tileId);
  return matched ? Number(matched[1]) : undefined;
}

/** Input of `read_project`: the whole document, with nothing to select. */
const readProjectInputSchema = z.object({});

/** Input of `read_catalog`. */
const readCatalogInputSchema = z.object({
  filter: z
    .string()
    .optional()
    .describe("Case-insensitive substring matched against tile id, label, kind, and description."),
});

/**
 * Libraries one `offer_libraries` call may present. A call naming more is
 * refused by the tool's own schema, before any card is presented.
 */
export const maxOfferedLibraries = 3;

/** Input of `offer_libraries`. */
const offerLibrariesInputSchema = z.object({
  coordinates: z
    .array(z.string().min(1))
    .min(1)
    .max(maxOfferedLibraries)
    .describe(
      `The <owner>/<repo> coordinates of the libraries to present, exactly as read_libraries reports them, in the order their cards should stand. A call presents at most ${maxOfferedLibraries}.`
    ),
});

/** Input of `read_libraries`. */
const readLibrariesInputSchema = z.object({
  filter: z
    .string()
    .optional()
    .describe("Case-insensitive substring matched against library coordinate, name, and description."),
});

/** Input of `suggest_tiles`: one question about a position, discriminated by `mode`. */
const suggestTilesInputSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("insert"),
    ruleId: ruleIdSchema,
    side: ruleSideSchema,
    position: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Insertion index on that side; defaults to the end of the side."),
  }),
  z.object({
    mode: z.literal("replace"),
    ruleId: ruleIdSchema,
    side: ruleSideSchema,
    position: z.number().int().min(0).describe("Index of the tile that would be replaced."),
  }),
]);

/**
 * One tile an edit names: a tile id on its own, or a factory tile id together
 * with the input it mints its tile from -- `value`, and optionally
 * `displayFormat` and `name`, for a literal factory; `name` for a variable
 * factory. Every `propose_edit` operation that names a tile takes this shape.
 * Inside a batch, the tile id `"#N.page"` names the page tile of the page the
 * batch's own command at index N creates.
 */
export const tileRunEntrySchema = z.union([
  z.string(),
  z.object({
    tileId: z.string().describe("Factory tile id from read_catalog or suggest_tiles."),
    value: z
      .union([z.string(), z.number(), z.boolean()])
      .optional()
      .describe("Literal factory: the value the minted tile carries."),
    displayFormat: z
      .string()
      .optional()
      .describe(
        'Literal factory: how a numeric value reads. One of "default", "percent", "percent:N", "fixed:N", "thousands", "time_seconds", "time_seconds:N", "time_ms", "time_ms:N", where N is the number of decimal places. Anything else is refused.'
      ),
    name: z
      .string()
      .optional()
      .describe(
        "The word the minted tile reads by: the variable's name for a variable factory, and for a literal factory the name the value goes by, which a factory minting values with an identity of their own requires."
      ),
  }),
]);

/** One tile an edit names: a tile id, or a factory tile with its mint input. */
export type TileRunEntry = z.infer<typeof tileRunEntrySchema>;

/** The editor commands `propose_edit` applies, one per `op`. */
const editCommandBranches = [
  z.object({
    op: z.literal("addRule"),
    pageIndex: z.number().int().min(0).describe("Zero-based page index from read_project."),
    trigger: ruleTriggerSchema.optional(),
  }),
  z.object({
    op: z.literal("addChildRule"),
    parentRuleId: ruleIdSchema.describe(
      "Rule id of the rule the new rule goes under, from read_project. The new rule is added after any children that rule already has, and runs each time that rule finishes its DO."
    ),
    trigger: ruleTriggerSchema.optional(),
  }),
  z.object({
    op: z.literal("setRuleTrigger"),
    ruleId: ruleIdSchema.describe("Rule id of the rule whose trigger mode changes, from read_project."),
    trigger: ruleTriggerSchema,
  }),
  z.object({
    op: z.literal("placeTile"),
    ruleId: ruleIdSchema,
    side: ruleSideSchema,
    tileId: tileRunEntrySchema.describe(
      "Tile to place: a tile id from read_catalog or suggest_tiles, or an object giving a factory tile's id plus what to mint."
    ),
    position: z.number().int().min(0).optional().describe("Insertion index; defaults to the end of the side."),
  }),
  z.object({
    op: z.literal("placeTiles"),
    ruleId: ruleIdSchema,
    side: ruleSideSchema,
    tileIds: z
      .array(tileRunEntrySchema)
      .min(1)
      .max(maxPlacedTiles)
      .describe(
        `Tiles to place in order, starting at the insertion index; validated as one end state. A factory tile is given as an object carrying its mint input. A run carries at most ${maxPlacedTiles} tiles.`
      ),
    position: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Insertion index of the first tile; defaults to the end of the side."),
  }),
  z.object({
    op: z.literal("replaceTile"),
    ruleId: ruleIdSchema,
    side: ruleSideSchema,
    position: z.number().int().min(0).describe("Index of the tile being replaced."),
    tileId: tileRunEntrySchema.describe(
      "Tile to put there: a tile id from read_catalog or suggest_tiles, or an object giving a factory tile's id plus what to mint."
    ),
  }),
  z.object({
    op: z.literal("deleteTile"),
    ruleId: ruleIdSchema,
    side: ruleSideSchema,
    position: z.number().int().min(0).describe("Index of the tile being removed."),
  }),
  z.object({
    op: z.literal("addPage"),
    name: z
      .string()
      .min(1)
      .optional()
      .describe("What the page is called, in the person's words; omit to leave it with the default name."),
  }),
  z.object({
    op: z.literal("deleteRule"),
    ruleId: ruleIdSchema.describe(
      "Rule id of the rule to remove, from read_project. Any rules nested under it go with it."
    ),
  }),
  z.object({
    op: z.literal("deletePage"),
    pageId: pageIdSchema.describe(
      "Page id of the page to remove, from read_project. Every rule on it goes with it. The pages after it shift down one, so put deletes last in a batch that also addresses pages by pageIndex."
    ),
  }),
] as const;

/** One editor command of `propose_edit`, discriminated by `op`. */
const editCommandSchema = z.discriminatedUnion("op", editCommandBranches);

/** Input of `propose_edit`: one editor command, or a batch of them, discriminated by `op`. */
const proposeEditInputSchema = z.discriminatedUnion("op", [
  ...editCommandBranches,
  z.object({
    op: z.literal("batch"),
    commands: z
      .array(editCommandSchema)
      .min(2)
      .max(maxBatchCommands)
      .describe(
        `Commands to apply in order, judged as one end state; every one lands or none does. A command may name a rule an earlier command created, as "#N" for that command's index. A batch carries at most ${maxBatchCommands} commands, which is one stage of a build; a build larger than that is made a stage at a time.`
      ),
  }),
]);

/** Input of `compile`: the whole brain, with nothing to select. */
const compileInputSchema = z.object({});

/**
 * One scripted percept of a `simulate` scenario: a value of `kind`, delivered
 * before think `at`. The kind is checked against the target's registered kinds
 * when the call runs, never here. It parses to the `ScenarioInput` shape a
 * target adapter reads.
 */
export const scenarioInputSchema = z.object({
  kind: z.string().min(1).describe("What to deliver, from the input kinds this target reads."),
  at: z.number().int().min(0).describe("Zero-based think this input is applied before."),
  value: z
    .union([z.number(), z.boolean(), z.string()])
    .describe("What the kind is set to; a level holds until another entry of the same kind changes it."),
});

/** Input of `simulate`: a scenario to stage and how many thinks to run. */
const simulateInputSchema = z.object({
  scenario: z
    .object({
      seed: z.number().int().describe("Seed for every random choice the run makes."),
      subject: z.string().describe("Population role the brain under study drives, from the scenario catalog."),
      inputs: z.array(scenarioInputSchema).optional().describe("Percepts to script into the run; omit to script none."),
    })
    .describe("Staged world description; the run is a bounded, deterministic rehearsal."),
  thinks: z
    .number()
    .int()
    .min(1)
    .max(5000)
    .describe(
      "Number of fixed-step thinks to run; an action that takes time to play out needs many of them to finish, so size the run to what the brain does."
    ),
});

/** Every tool input schema, keyed by tool name. */
export const toolInputSchemas = {
  compile: compileInputSchema,
  offer_libraries: offerLibrariesInputSchema,
  propose_edit: proposeEditInputSchema,
  read_catalog: readCatalogInputSchema,
  read_libraries: readLibrariesInputSchema,
  read_project: readProjectInputSchema,
  simulate: simulateInputSchema,
  suggest_tiles: suggestTilesInputSchema,
} as const;

/** Name of one bridge tool. */
export type ToolName = keyof typeof toolInputSchemas;

/** Parsed input of the tool named `N`. */
export type ToolInput<N extends ToolName> = z.infer<(typeof toolInputSchemas)[N]>;

/** Parsed input of `propose_edit`, one editor command discriminated by `op`. */
export type ProposeEditInput = z.infer<typeof editCommandSchema>;

/** Parsed batch form of `propose_edit`: an ordered run of editor commands. */
export type ProposeEditBatchInput = Extract<z.infer<typeof proposeEditInputSchema>, { op: "batch" }>;

/** Prescriptive when-to-call guidance carried with each tool. */
const toolDescriptions: Record<ToolName, string> = {
  compile:
    "Build the whole brain and return its diagnostics. Call after a group of edits that should hold together, before claiming the brain is ready.",
  offer_libraries:
    "Present the install cards the person adds these libraries from. Offering is a deliberate act: call this for a library you have judged to carry what the wish needs, never to describe what the shelf holds. Naming a library in your own words describes it; this is what offers it. Each coordinate comes back listed, which stands its card at the end of your message, or unknown, which stands nothing and carries the code saying why -- read that code and correct the coordinate rather than repeating it. Coordinates and descriptions both come from read_libraries.",
  propose_edit: `Apply one editor command to the document. The editor validates it: an accepted edit is in the document and undoable, and a rejected edit leaves the document untouched and returns the diagnostic code that rejected it. Read the code, adjust, and propose again. This is the only way to change the brain. Any tile that leaves an expression unfinished -- an operator, an opening paren, a NOT, a parameter awaiting its value -- is rejected on its own, because the editor validates the state the edit leaves behind. Place it with the tiles that finish it in one placeTiles call: the whole run lands together or not at all. A factory tile carries no value of its own and cannot be placed by id alone: name it as an object giving its tileId plus what to mint -- a value, optionally with a displayFormat and a name, for a literal factory, or a name for a variable factory. A literal factory that mints values with an identity of their own refuses a mint carrying no name, since the tile would read by that raw identity. Every place a tile is named takes that object, so a minted value can be placed by placeTile, swapped in by replaceTile, or carried in a placeTiles run. The minted tile joins the document's catalog, and a rejected edit takes the minting back with the placement. Every rule carries a trigger mode, which is how rules branch and sequence: addRule and addChildRule take an optional trigger and default to when, and setRuleTrigger changes the mode of a rule already standing. A mode the rule's position does not admit -- otherwise or then in the first rule at its level -- comes back refused under the diagnostic code that says so, as any other rejected edit does. Pages are how a brain holds more than one mode: addPage appends a page, gives it the name you pass, and reports the pageId it minted; the page arrives holding one empty rule you can fill straight away. Inside a batch that rule is what "#N" names for the addPage command at index N, and "#N.page" names the new page's own tile -- the tile you place after switch-page to send yourself there, since its id does not exist until the page does. Name every page you make something the person would recognise. A page appended this way sits one past the last page read_project reported, which is the pageIndex addRule takes for it. deleteRule removes a rule and everything nested under it; deletePage removes a page and every rule on it. Both are refused when something would be left dangling: a page another rule still switches to comes back as page_still_referenced naming those rules, so retarget or remove them first -- a batch may do both at once, since only the end state is judged -- and the only page left in the brain comes back as last_page, because a brain always has somewhere to be; empty its rules instead. Removing a page shifts every page after it down one, so put deletes last in a batch that also names pages by pageIndex. Author one command per call, narrating each as it lands; that is the default. Reach for the batch op when one stage of the work must land or fail as one thing, such as a refactor or a structure of several rules whose half-applied form would be worse than none: the commands apply in order, only the state they leave is judged, and one undo takes the whole plan back. A batch carries at most ${maxBatchCommands} commands, which is the size of one stage; a build larger than that is made a stage at a time, each stage its own batch, rehearsed before the next. States in the middle of a batch may be broken. A command that cannot apply at all stops the batch and reports its index.`,
  read_catalog:
    'List the tiles available in this world with their descriptions, argument grammar, and where they may be placed. Call before planning which tiles a goal needs. Tiles come back in groups: the "environment" group is the vocabulary this world installs, and the "document" group is what this brain minted for itself -- its page tiles, its variables, and the literals it minted. Either group is left out when it holds nothing matching.',
  read_libraries:
    "List the libraries this world approves for the project: the shelf of extra capabilities the person can add to it, each with its name, the approved version, a description of what it adds, and whether it is installed. An installed library's tiles are already in read_catalog's answer; an uninstalled one's are not, and nothing more of it can be read until the person adds it, which offer_libraries is how you put to them. Call this when the catalog holds no tile for what is being asked, before saying the thing cannot be built, and describe a library only from what its own description says.",
  read_project:
    "Read the current brain: its pages, rules, and the tiles on each rule side. Call at the start of a request and again whenever the document may have changed under you.",
  simulate:
    "Run the compiled brain in a bounded rehearsal and return a summary of what happened: which rules fired, what their WHEN evaluated to, which actions dispatched, and how the state of the thing you are programming changed as it ran. Call before claiming the brain does something. A call the summary reports as pending had not finished when the run ended, so run again with more thinks before concluding anything about the brain from what did not appear.",
  suggest_tiles:
    "Ask the editor which tiles are legal at one position. Insert mode answers what may go in at a spot; call before placing a tile you are not certain of, and ask again after each placement to see what may follow. Every tile it offers can be placed there, but one that leaves the expression unfinished only lands in a placeTiles run that finishes it. Replace mode answers what may stand in for a tile already there; that is the move for a tile that is wrong rather than missing, so ask in replace mode first and then swap it with a propose_edit replaceTile.",
};

/** JSON Schema draft the tool definitions are emitted in. */
const jsonSchemaTarget = "draft-2020-12" as const;

/** One bridge tool as the model is offered it. */
export interface ToolDefinition {
  readonly name: ToolName;
  readonly description: string;
  /** JSON Schema of the tool's input, with no additional properties permitted. */
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

/** One object branch of a union input schema. */
interface SchemaBranch {
  readonly properties?: Record<string, unknown>;
  readonly required?: readonly string[];
}

/** The property every branch fixes to a constant, which selects the branch. */
function discriminatorOf(branches: readonly SchemaBranch[]): string | undefined {
  const first = branches[0]?.properties ?? {};
  return Object.keys(first).find((name) =>
    branches.every((branch) => typeof (branch.properties?.[name] as { const?: unknown })?.const === "string")
  );
}

/** Property names `branch` accepts besides `discriminator`, in schema order. */
function branchProperties(branch: SchemaBranch, discriminator: string): string[] {
  return Object.keys(branch.properties ?? {}).filter((name) => name !== discriminator);
}

/** The discriminator value `branch` fixes. */
function branchValue(branch: SchemaBranch, discriminator: string): string {
  return (branch.properties?.[discriminator] as { const: string }).const;
}

/**
 * How `property` reads across every branch that both names and describes it: the
 * shared wording when they agree, and one `value: wording` clause per branch
 * when they differ, so a property meaning different things under different
 * discriminator values says so. `undefined` when no branch describes it.
 */
function mergedDescription(
  branches: readonly SchemaBranch[],
  discriminator: string,
  property: string
): string | undefined {
  const described = branches.flatMap((branch) => {
    const { description } = (branch.properties?.[property] as { description?: string } | undefined) ?? {};
    return description === undefined ? [] : [{ value: branchValue(branch, discriminator), description }];
  });
  if (described.length === 0) return undefined;
  const wordings = new Set(described.map((entry) => entry.description));
  if (wordings.size === 1) return described[0]!.description;
  return described.map((entry) => `${entry.value}: ${entry.description}`).join(" ");
}

/**
 * Flatten a union of object branches into one object schema: the discriminator
 * becomes an enum whose description names the properties each value takes, and
 * every other property is merged in, left optional, and described across every
 * branch that names it.
 */
function flattenUnion(branches: readonly SchemaBranch[], discriminator: string): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    [discriminator]: {
      type: "string",
      enum: branches.map((branch) => branchValue(branch, discriminator)),
      description: branches
        .map(
          (branch) =>
            `${branchValue(branch, discriminator)} takes ${branchProperties(branch, discriminator).join(", ")}`
        )
        .join("; "),
    },
  };
  for (const branch of branches) {
    for (const name of branchProperties(branch, discriminator)) {
      if (name in properties) continue;
      const shape = branch.properties?.[name] as Record<string, unknown>;
      const description = mergedDescription(branches, discriminator, name);
      properties[name] = flattenedShape(description === undefined ? shape : { ...shape, description });
    }
  }
  return { type: "object", properties, required: [discriminator], additionalProperties: false };
}

/**
 * `shape` with every union of object branches it holds advertised flattened,
 * including one standing as an array's item schema. A shape holding no such
 * union comes back unchanged.
 */
function flattenedShape(shape: Record<string, unknown>): Record<string, unknown> {
  const { oneOf, items, ...rest } = shape as {
    oneOf?: SchemaBranch[];
    items?: Record<string, unknown>;
  };
  if (oneOf) {
    const discriminator = discriminatorOf(oneOf);
    return discriminator ? { ...rest, ...flattenUnion(oneOf, discriminator) } : shape;
  }
  return items ? { ...rest, items: flattenedShape(items) } : shape;
}

/**
 * The JSON Schema of one tool's input, as an object schema with no union at its
 * top level. A tool whose input is a discriminated union is advertised
 * flattened; the tool's own schema still validates the union when the call runs.
 */
function inputSchemaOf(name: ToolName): Readonly<Record<string, unknown>> {
  const schema = z.toJSONSchema(toolInputSchemas[name], { target: jsonSchemaTarget }) as {
    $schema?: string;
    oneOf?: SchemaBranch[];
  };
  const branches = schema.oneOf;
  if (!branches) return { ...schema, type: "object" };
  const discriminator = discriminatorOf(branches);
  if (!discriminator) throw new Error(`${name} input schema is a union with no discriminating property`);
  return { $schema: schema.$schema, ...flattenUnion(branches, discriminator) };
}

/**
 * Every bridge tool, in ascending name order. The order and the emitted
 * schemas are byte-stable across a session.
 */
export const toolDefinitions: readonly ToolDefinition[] = (Object.keys(toolInputSchemas) as ToolName[])
  .sort()
  .map((name) => ({
    name,
    description: toolDescriptions[name],
    inputSchema: inputSchemaOf(name),
  }));
