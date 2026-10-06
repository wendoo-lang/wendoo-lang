import { Error } from "../platform/error";
import { List, type ReadonlyList } from "../platform/list";
import { TypeUtils } from "../platform/types";
import type { StableIdOwner } from "./abi-ids";
import type { TypeId } from "./type-defs";
import { isNumberValue, type Value } from "./value";
import type { HostAsyncFn, HostFn, HostSyncFn } from "./vm-types";

// ----------------------------------------------------
// Action Calls - Grammar-Like CallSpec Specification
// ----------------------------------------------------

/**
 * Grammar-like specification for action calls.
 */
export type BrainActionCallSpec =
  | BrainActionCallArgSpec
  | BrainActionCallSeqSpec
  | BrainActionCallChoiceSpec
  | BrainActionCallOptionalSpec
  | BrainActionCallRepeatSpec
  | BrainActionCallBagSpec
  | BrainActionCallConditionalSpec;

/**
 * What the implementation does with a numeric argument outside the declared
 * bounds, as a token the model reads: `clamp` holds the value at the bound it
 * exceeded and the call proceeds, `wrap` brings the value back into the bounds
 * by modulus and the call proceeds, `drop` lets the call complete without doing
 * anything.
 */
export type BrainActionArgOnExceed = "clamp" | "wrap" | "drop";

/**
 * The bounds an action's implementation holds a numeric argument slot to,
 * stated for the model. A bound left absent is unbounded on that side.
 */
export interface BrainActionArgRange {
  /** Smallest value the implementation accepts. */
  readonly min?: number;
  /** Largest value the implementation accepts. */
  readonly max?: number;
  /** What the implementation does with a value outside `min`..`max`. */
  readonly onExceed: BrainActionArgOnExceed;
}

/**
 * A single argument slot (parameter or modifier tile)
 *
 * `default`, `derived`, `range` and `unit` are argument metadata for the
 * assistant: structured facts about the slot, rendered into the catalog digest
 * the model reads, like the `tileId` beside them. None of them is display text
 * and none is localized; anything that ever renders one to a person must pass
 * it through the Localizer first.
 */
export interface BrainActionCallArgSpec {
  readonly type: "arg";
  /**
   * Name the slot is read by, unique among the names anywhere in one call
   * spec. A `conditional` spec resolves its `condition` against the names the
   * parser matched, so a name identifies this spec to the grammar as well as
   * naming the slot wherever its value is described.
   */
  readonly name?: string;
  readonly tileId: string;
  readonly required?: boolean;
  readonly anonymous?: boolean;
  /**
   * What the implementation does when the slot is left empty: it acts on this
   * value. Nothing substitutes it into a call. Never declared together with
   * `derived`.
   */
  readonly default?: Value;
  /**
   * Declared when leaving the slot empty makes the action choose the value as
   * it runs, so no fixed value states what an empty slot means. Never declared
   * together with `default`.
   */
  readonly derived?: true;
  /**
   * Bounds the implementation holds the slot's value to; declared on numeric
   * slots only. Absent when the implementation accepts any value.
   */
  readonly range?: BrainActionArgRange;
  /**
   * Unit the slot's value is measured in, as the author writes it. Absent for
   * a slot whose value counts no unit.
   */
  readonly unit?: string;
}

/**
 * Check one argument declaration and throw when it contradicts itself: a slot
 * declaring both `default` and `derived`, a slot declaring either beside
 * `required`, a `range` carrying no bound or a `min` above its `max`, or a
 * `range` on a slot whose `default` is not a number.
 *
 * The non-numeric check applies only to a slot declaring a `default`; a `range`
 * on a slot without one passes.
 */
function validateArgSpec(argSpec: BrainActionCallArgSpec): void {
  const where = argSpec.name ?? argSpec.tileId;
  if (argSpec.default !== undefined && argSpec.derived !== undefined) {
    throw new Error(`Arg ${where} declares both a default and derived; an empty slot means one or the other`);
  }
  if (argSpec.required === true && (argSpec.default !== undefined || argSpec.derived !== undefined)) {
    throw new Error(`Arg ${where} is required and declares what an empty slot means; a required slot is never empty`);
  }
  const range = argSpec.range;
  if (range === undefined) return;
  if (range.min === undefined && range.max === undefined) {
    throw new Error(`Arg ${where} declares a range carrying neither bound`);
  }
  if (range.min !== undefined && range.max !== undefined && range.min > range.max) {
    throw new Error(`Arg ${where} declares a range whose min ${range.min} is above its max ${range.max}`);
  }
  if (argSpec.default !== undefined && !isNumberValue(argSpec.default)) {
    throw new Error(`Arg ${where} declares a range on a non-numeric slot`);
  }
}

/**
 * Check that no two specs anywhere in `callSpec` carry the same name, so a
 * `conditional` naming one resolves to exactly one spec. Throws on a repeat.
 */
function validateSpecNames(callSpec: BrainActionCallSpec): void {
  const seen = List.empty<string>();
  const visit = (spec: BrainActionCallSpec): void => {
    if (spec.name !== undefined) {
      if (seen.indexOf(spec.name) !== -1) {
        throw new Error(`Call spec names ${spec.name} twice; a name identifies one spec to the grammar`);
      }
      seen.push(spec.name);
    }
    switch (spec.type) {
      case "arg":
        return;
      case "seq":
      case "bag":
        for (const item of spec.items) visit(item);
        return;
      case "choice":
        for (const option of spec.options) visit(option);
        return;
      case "optional":
      case "repeat":
        visit(spec.item);
        return;
      case "conditional":
        visit(spec.then);
        if (spec.else) visit(spec.else);
        return;
    }
  };
  visit(callSpec);
}

/**
 * All items must appear in sequence
 */
export interface BrainActionCallSeqSpec {
  readonly type: "seq";
  readonly name?: string;
  readonly items: readonly BrainActionCallSpec[];
}

/**
 * Exactly one option must be chosen
 */
export interface BrainActionCallChoiceSpec {
  readonly type: "choice";
  readonly name?: string;
  readonly options: readonly BrainActionCallSpec[];
}

/**
 * Zero or one occurrence
 */
export interface BrainActionCallOptionalSpec {
  readonly type: "optional";
  readonly name?: string;
  readonly item: BrainActionCallSpec;
}

/**
 * Repetition with min/max bounds
 */
export interface BrainActionCallRepeatSpec {
  readonly type: "repeat";
  readonly name?: string;
  readonly item: BrainActionCallSpec;
  readonly min?: number; // default 0
  readonly max?: number; // default Infinity
}

/**
 * Unordered set of items (bag) where items can appear in any order.
 * Each item is typically an arg spec or optional arg spec.
 * The parser will try to match items in any order until no more items can be matched.
 */
export interface BrainActionCallBagSpec {
  readonly type: "bag";
  readonly name?: string;
  readonly items: readonly BrainActionCallSpec[];
}

/**
 * Conditional spec that checks if a named call spec has been successfully matched.
 * Used in bag specs to make certain items available only when a condition is met.
 * The condition is the name of another call spec - if that spec matched, the condition is true.
 */
export interface BrainActionCallConditionalSpec {
  readonly type: "conditional";
  readonly name?: string;
  readonly condition: string; // Name of the call spec to check
  readonly then: BrainActionCallSpec;
  readonly else?: BrainActionCallSpec;
}

/** A flattened (slot-indexed) view of an arg in a {@link BrainActionCallDef}. */
export interface BrainActionArgSlot {
  readonly slotId: number;
  readonly argSpec: BrainActionCallArgSpec;
  readonly choiceGroup?: number;
  /**
   * True when the slot comes from a `repeat` spec, so multiple tiles can fill
   * it. A repeated anonymous/parameter slot gathers its values into a
   * `List<T>`; a repeated modifier slot instead counts its occurrences.
   */
  readonly repeated?: boolean;
}

/** Compiled call definition: the original {@link BrainActionCallSpec} tree plus its flattened arg slots. */
export type BrainActionCallDef = {
  callSpec: BrainActionCallSpec;
  argSlots: ReadonlyList<BrainActionArgSlot>;
};

/** Stable string key identifying a registered action. */
export type ActionKey = string;

/** The action kind. A `conversion` action backs a registered value conversion and has no tile surface. */
export type ActionKind = "sensor" | "actuator" | "conversion";

/**
 * One named, typed output a built-in action exposes. The `(type, name)` pair is
 * the output identity: it derives a downstream inline output value-tile and the
 * backing rule variable the action writes and that tile reads. The `type` is an
 * already-resolved {@link TypeId}.
 */
export interface ActionOutputSpec {
  /** Output name; with `type`, forms the output identity. */
  name: string;
  /** Resolved value type the output produces. */
  type: TypeId;
  /** Display label for the output tile; defaults to `name`. */
  label?: string;
  iconUrl?: string;
  docsMarkdown?: string;
  tags?: readonly string[];
  /**
   * When true, the output's value is a writable l-value: a field write through
   * the output's tile is permitted. Defaults to false, making the value
   * read-only.
   */
  writableResult?: boolean;
}

/** Static metadata for a registered action: its key, kind, call grammar, async flag, named outputs, and (for sensors) output type. */
export type ActionDescriptor = {
  key: ActionKey;
  kind: ActionKind;
  callDef: BrainActionCallDef;
  isAsync: boolean;
  outputType?: TypeId;
  /** Named, typed outputs the action exposes; each surfaces as an inline output value-tile. */
  outputs?: readonly ActionOutputSpec[];
};

/**
 * Flatten a {@link BrainActionCallSpec} tree into a {@link BrainActionCallDef}.
 * Throws when an argument declaration in the tree contradicts itself, or when
 * two specs in the tree carry the same name.
 */
export function mkCallDef(callSpec: BrainActionCallSpec): BrainActionCallDef {
  validateSpecNames(callSpec);
  const argSlots = callSpecToArgSlots(callSpec);
  return {
    callSpec,
    argSlots,
  };
}

/**
 * Looks up the slotId for a given tileId in a callDef's argSlots.
 * Accepts either a raw tileId string or a BrainActionCallArgSpec (extracts `.tileId`).
 * Throws if the tileId is not found, catching misconfigured call specs early.
 */
export function getSlotId(callDef: BrainActionCallDef, tileIdOrSpec: string | BrainActionCallArgSpec): number {
  const tileId = TypeUtils.isString(tileIdOrSpec) ? tileIdOrSpec : tileIdOrSpec.tileId;
  const idx = callDef.argSlots.findIndex((s) => s.argSpec.tileId === tileId);
  if (idx === -1) {
    throw new Error(`No arg slot found for tileId: ${tileId}`);
  }
  return idx;
}

let nextChoiceGroupId = 0;

/**
 * Flatten a {@link BrainActionCallSpec} into ordered, slot-indexed args. Throws
 * when an argument declaration in the tree contradicts itself.
 */
export function callSpecToArgSlots(callSpec: BrainActionCallSpec): ReadonlyList<BrainActionArgSlot> {
  const argList = List.empty<BrainActionArgSlot>();
  callSpecToArgSlotsImpl(callSpec, argList, undefined, undefined);
  return argList.asReadonly();
}

function callSpecToArgSlotsImpl(
  callSpec: BrainActionCallSpec,
  argList: List<BrainActionArgSlot>,
  choiceGroup: number | undefined,
  repeated: true | undefined
) {
  switch (callSpec.type) {
    case "arg":
      validateArgSpec(callSpec);
      argList.push({
        slotId: argList.size(),
        argSpec: callSpec,
        choiceGroup,
        repeated,
      });
      break;
    case "seq":
      for (const item of callSpec.items) {
        callSpecToArgSlotsImpl(item, argList, choiceGroup, repeated);
      }
      break;
    case "choice": {
      const groupId = nextChoiceGroupId++;
      for (const option of callSpec.options) {
        callSpecToArgSlotsImpl(option, argList, groupId, repeated);
      }
      break;
    }
    case "optional":
      callSpecToArgSlotsImpl(callSpec.item, argList, choiceGroup, repeated);
      break;
    case "repeat":
      callSpecToArgSlotsImpl(callSpec.item, argList, choiceGroup, true);
      break;
    case "bag":
      for (const item of callSpec.items) {
        callSpecToArgSlotsImpl(item, argList, choiceGroup, repeated);
      }
      break;
    case "conditional":
      callSpecToArgSlotsImpl(callSpec.then, argList, choiceGroup, repeated);
      if (callSpec.else) {
        callSpecToArgSlotsImpl(callSpec.else, argList, choiceGroup, repeated);
      }
      break;
    default: {
      const _exhaustive: never = callSpec;
      break;
    }
  }
}

export type BrainFunctionCommon = {
  /**
   * Author-assigned stable funcId. Serialized programs record it verbatim;
   * once assigned it is never changed or reused.
   */
  id: number;
  name: string;
  callDef: BrainActionCallDef;
};

export type BrainSyncFunctionEntry = BrainFunctionCommon & {
  isAsync: false;
  fn: HostSyncFn;
};

export type BrainAsyncFunctionEntry = BrainFunctionCommon & {
  isAsync: true;
  fn: HostAsyncFn;
};

export type BrainFunctionEntry = BrainSyncFunctionEntry | BrainAsyncFunctionEntry;

export function mkActionDescriptor(
  kind: ActionKind,
  fnEntry: BrainFunctionEntry,
  outputType?: TypeId
): ActionDescriptor {
  return {
    key: fnEntry.name,
    kind,
    callDef: fnEntry.callDef,
    isAsync: fnEntry.isAsync,
    outputType,
  };
}

export interface IFunctionRegistry {
  /**
   * Register a host function under the author-assigned stable `id`. The id
   * must be a non-negative integer, unused in this registry, and inside the
   * range of the active registration owner. Throws on any violation, and
   * when `name` is empty or already registered.
   */
  register(id: number, name: string, isAsync: boolean, fn: HostFn, callDef: BrainActionCallDef): BrainFunctionEntry;
  /**
   * Run `body` with registrations validated against `owner`'s id range:
   * core `[0, TARGET_FUNC_ID_BASE)`, target `[TARGET_FUNC_ID_BASE, ...)`.
   * The previous owner is restored when `body` returns or throws. The
   * default owner is `target`.
   */
  withOwner<T>(owner: StableIdOwner, body: () => T): T;
  unregister(name: string): boolean;
  get(name: string): BrainFunctionEntry | undefined;
  getSyncById(id: number): BrainSyncFunctionEntry | undefined;
  getAsyncById(id: number): BrainAsyncFunctionEntry | undefined;
  size(): number;
}
