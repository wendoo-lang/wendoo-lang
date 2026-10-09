import { assertUnreachable } from "@wendoo/core";
import { type IBrainTileDef, RuleSide, RuleTriggerMode } from "@wendoo/core/brain";
import type { BrainTileAccessorDef, BrainTileLiteralDef, BrainTileVariableDef } from "@wendoo/core/brain/tiles";
import { createDefaultLocalizer } from "@wendoo/core/localization";
import { adjustColor, cn, formatValue, readableInk, staticAssetUrl } from "@wendoo/ui";
import { kDefaultTileHue, tileBorderColor, tileEdgeColor } from "@wendoo/ui/brain-editor/tile-visual-utils";
import { triggerModeLabel } from "@wendoo/ui/brain-editor/trigger-mode";
import type { TileVisual } from "@wendoo/ui/brain-editor/types";
import { useLayoutEffect, useState } from "react";
import { useDocsResolveTileVisual } from "./DocsSidebarContext";

// ---------------------------------------------------------------------------
// Single tile chip -- simplified, read-only, no interactivity
// ---------------------------------------------------------------------------

interface DocsTileChipProps {
  tileDef: IBrainTileDef;
  side: RuleSide;
}

/**
 * The boxed value a tile chip displays, or undefined for a tile rendered as an
 * icon chip. Value tiles are literal, variable, and accessor tiles; `italic`
 * marks a variable name.
 */
function docsTileValue(tileDef: IBrainTileDef): { text: string; italic: boolean } | undefined {
  switch (tileDef.kind) {
    case "literal": {
      const literalDef = tileDef as BrainTileLiteralDef;
      const raw =
        literalDef.displayFormat && literalDef.displayFormat !== "default"
          ? literalDef.value
          : literalDef.valueLabel || literalDef.value;
      return { text: formatValue(raw, literalDef.valueType, [], literalDef.displayFormat), italic: false };
    }
    case "variable":
      return { text: (tileDef as BrainTileVariableDef).varName, italic: true };
    case "accessor": {
      const accessorDef = tileDef as BrainTileAccessorDef;
      return { text: formatValue(accessorDef.fieldName, accessorDef.fieldTypeId, []), italic: false };
    }
    case "undefined":
    case "sensor":
    case "actuator":
    case "parameter":
    case "operator":
    case "factory":
    case "controlFlow":
    case "modifier":
    case "page":
    case "output":
    case "missing":
      return undefined;
    default:
      return assertUnreachable(tileDef.kind);
  }
}

/** Read-only rendering of a single brain tile, used inside doc tile strips and rule rows. */
export function DocsTileChip({ tileDef, side }: DocsTileChipProps) {
  const resolveTileVisual = useDocsResolveTileVisual();
  const visual = resolveTileVisual(tileDef);
  const label = visual?.label || tileDef.tileId.split(".").pop() || tileDef.tileId;
  const iconUrl = visual?.iconUrl || staticAssetUrl("assets/brain/icons/question_mark.svg");
  const baseColor = (side === RuleSide.When ? visual?.colorDef?.when : visual?.colorDef?.do) || kDefaultTileHue;

  const value = docsTileValue(tileDef);
  const isValueTile = value !== undefined;
  const displayValue = value?.text;
  const isItalic = value?.italic ?? false;

  const lighterColor2 = adjustColor(baseColor, 0.4);
  const darkerColor = adjustColor(baseColor, 0);
  const darkerSaturatedColor = tileEdgeColor(baseColor);

  const [labelBasedWidth, setLabelBasedWidth] = useState<number | undefined>(undefined);

  useLayoutEffect(() => {
    const tempSpan = document.createElement("span");
    tempSpan.style.visibility = "hidden";
    tempSpan.style.position = "absolute";
    tempSpan.style.whiteSpace = "nowrap";
    tempSpan.style.fontSize = "0.875rem";
    tempSpan.style.fontFamily =
      "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace";
    tempSpan.style.fontWeight = "600";
    tempSpan.textContent = label;
    document.body.appendChild(tempSpan);

    const labelWidth = tempSpan.offsetWidth;
    document.body.removeChild(tempSpan);

    const defaultWidth = 96;
    const maxWidth = isValueTile ? 288 : 192;
    const labelPadding = isValueTile ? 24 : 16;
    const neededWidth = labelWidth + labelPadding;

    if (neededWidth > defaultWidth) {
      setLabelBasedWidth(Math.min(neededWidth, maxWidth));
    } else {
      setLabelBasedWidth(undefined);
    }
  }, [label, isValueTile]);

  return (
    <div
      role="img"
      className={`relative flex flex-col border-2 h-24 min-h-24 max-h-24 ${
        isValueTile ? "w-auto min-w-24 max-w-72 px-3 pb-2.5" : "w-24 min-w-24 max-w-48 px-1 pb-1.5"
      } overflow-hidden rounded-lg pt-2 shrink-0`}
      aria-label={label}
      title={label}
      style={{
        borderColor: tileBorderColor(baseColor),
        background: baseColor,
        ...(labelBasedWidth !== undefined ? { minWidth: labelBasedWidth } : {}),
      }}
    >
      {isValueTile && (
        <div
          style={{
            backgroundColor: darkerSaturatedColor,
            WebkitMaskImage: `url(${iconUrl})`,
            WebkitMaskSize: "contain",
            WebkitMaskRepeat: "no-repeat",
            WebkitMaskPosition: "center",
            maskImage: `url(${iconUrl})`,
            maskSize: "contain",
            maskRepeat: "no-repeat",
            maskPosition: "center",
          }}
          className="absolute top-1 left-1 w-4 h-4 pointer-events-none"
          aria-hidden="true"
        />
      )}
      <div className="flex-1 flex flex-col items-center justify-center relative z-10">
        {isValueTile ? (
          <div className="min-h-16 flex-1 flex items-center justify-center text-lg font-semibold text-center px-2 overflow-hidden w-full">
            <div
              className="truncate border-[3px] rounded px-2 py-1 shadow-inner"
              style={{
                backgroundColor: lighterColor2,
                borderColor: "white",
                boxShadow: "inset 0 0 0 1px #363535",
              }}
            >
              <span className={`font-math text-2xl${isItalic ? " italic" : ""}`} style={{ color: "#1a1a1a" }}>
                {displayValue}
              </span>
            </div>
          </div>
        ) : (
          <img src={iconUrl} alt="" className="h-16 w-full" aria-hidden="true" />
        )}
        <span className="flex-1 flex items-end w-full text-sm overflow-hidden justify-center">
          <span
            className="whitespace-nowrap inline-block font-mono font-semibold"
            style={{ color: readableInk(darkerColor) }}
          >
            {label}
          </span>
        </span>
      </div>
    </div>
  );
}

/** Blend a hex color toward transparent by setting an alpha. */
function adjustAlpha(hex: string, alpha: number): string {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return hex;
  return `rgba(${r},${g},${b},${alpha})`;
}

// ---------------------------------------------------------------------------
// Inline tile icon -- used in prose for `tile:xxx` references
// ---------------------------------------------------------------------------

interface InlineTileIconProps {
  tileDef: IBrainTileDef;
  /** Additional classes merged onto the chip's root element. */
  className?: string;
}

/** Compact tile rendering used inline in prose for `tile:xxx` references. */
export function InlineTileIcon({ tileDef, className }: InlineTileIconProps) {
  const resolveTileVisual = useDocsResolveTileVisual();
  const visual = resolveTileVisual(tileDef);
  const label = visual?.label || tileDef.tileId.split(".").pop() || tileDef.tileId;
  const baseColor = visual?.colorDef?.when || visual?.colorDef?.do || kDefaultTileHue;

  return <InlineTileChip label={label} iconUrl={visual?.iconUrl} baseColor={baseColor} className={className} />;
}

interface InlineTileChipProps {
  /** Text the chip reads as. */
  label: string;
  /** Icon drawn before the label, as an image source, or undefined for none. */
  iconUrl: string | undefined;
  /** Hex color of the chip's border, its fill a faint wash of it; the default tile hue when omitted. */
  baseColor?: string;
  /** Additional classes merged onto the chip's root element. */
  className?: string;
}

/**
 * The compact chip an inline `tile:xxx` reference is drawn as, from a label
 * and an icon already resolved.
 */
export function InlineTileChip({ label, iconUrl, baseColor = kDefaultTileHue, className }: InlineTileChipProps) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 min-w-max items-center gap-0.5 align-middle px-1 py-0.5 rounded border text-xs font-mono font-normal text-nowrap",
        className
      )}
      style={{
        borderColor: baseColor,
        backgroundColor: adjustAlpha(baseColor, 0.15),
        color: "var(--color-brain-inline-ink)",
      }}
      title={label}
    >
      {iconUrl && <img src={iconUrl} alt="" className="w-3.5 h-3.5 mr-px inline-block" aria-hidden="true" />}
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Single read-only brain rule row
// ---------------------------------------------------------------------------

/**
 * Shape, spacing and chrome shared by the two capsules at the head of a rule
 * row's sides. Fill, edge and letter ink are supplied by the call site.
 */
const kCapsuleClasses =
  "px-2 py-1 border-2 rounded-md rounded-l-2xl flex h-24 self-center items-center justify-center shadow-sm relative overflow-hidden shrink-0";

/** How a capsule's stacked-upright letters are set, in the ink the capsule around them carries. */
const kCapsuleLettersClasses = "font-semibold text-sm uppercase cursor-default";

/**
 * The leading each stacked letter carries along the capsule's vertical inline
 * axis, which is what `mx-*` sets under the capsule's vertical writing mode.
 * Every letter carries the same, so the word's rows are evenly spaced and
 * bar-heavy letterforms stay apart.
 */
const kCapsuleLetterLeading = "mx-0.75";

/** The fill, edge and ink of a capsule reading in the `when` mode, which the DO capsule also wears. */
const kWhenCapsuleChrome = "bg-brain-capsule border-brain-capsule-edge text-brain-capsule-ink";

/** The fill, edge and ink each trigger mode's capsule is painted in, matching the editor's treatment. */
const kTriggerCapsuleChrome: Record<RuleTriggerMode, string> = {
  [RuleTriggerMode.When]: kWhenCapsuleChrome,
  [RuleTriggerMode.Otherwise]:
    "bg-brain-capsule-otherwise border-brain-capsule-otherwise-edge text-brain-capsule-otherwise-ink",
  [RuleTriggerMode.Then]: "bg-brain-capsule-then border-brain-capsule-then-edge text-brain-capsule-then-ink",
};

/**
 * The connective a rule of each mode opens its reading with when its WHEN side
 * holds tiles: the mode's own word, and after the two marked modes the ordinary
 * "when" the condition clause keeps.
 */
const kTriggerReadingConnective: Record<RuleTriggerMode, string> = {
  [RuleTriggerMode.When]: "When",
  [RuleTriggerMode.Otherwise]: "Otherwise, when",
  [RuleTriggerMode.Then]: "Then, when",
};

/** The word a rule of each mode opens its reading with when its WHEN side holds no tiles. */
const kBareTriggerReading: Record<RuleTriggerMode, string> = {
  [RuleTriggerMode.When]: "Always",
  [RuleTriggerMode.Otherwise]: "Otherwise",
  [RuleTriggerMode.Then]: "Then",
};

/** Localizer the read-only docs chrome reads its mode words through, which renders the English sources. */
const kDocsLocalizer = createDefaultLocalizer();

/** `word` as one upright span per character, which reads down a vertical capsule. */
function stackedLetters(word: string): React.ReactNode[] {
  return [...word].map((character, index) => (
    <span
      // biome-ignore lint/suspicious/noArrayIndexKey: a letter's place in the word is its identity
      key={index}
      className={`inline-block rotate-270 ${kCapsuleLetterLeading}`}
    >
      {character}
    </span>
  ));
}

interface DocsRuleRowProps {
  comment?: string;
  trigger: RuleTriggerMode;
  whenTiles: IBrainTileDef[];
  doTiles: IBrainTileDef[];
  depth?: number;
  lineNumber?: number;
}

function DocsRuleRow({ comment, trigger, whenTiles, doTiles, depth = 0, lineNumber }: DocsRuleRowProps) {
  const resolveTileVisual = useDocsResolveTileVisual();
  const whenLabel = whenTiles.map((t) => resolveTileVisual(t)?.label ?? t.tileId).join(", ");
  const doLabel = doTiles.map((t) => resolveTileVisual(t)?.label ?? t.tileId).join(", ");
  const triggerReading = whenLabel
    ? `${kTriggerReadingConnective[trigger]} ${whenLabel}`
    : kBareTriggerReading[trigger];
  const reading = `${triggerReading}, do ${doLabel || ""}`;
  const rowLabel = lineNumber !== undefined ? `Rule ${lineNumber}: ${reading}` : reading;

  return (
    <div
      role="img"
      className={`flex flex-col rounded-xl border border-border p-2 mb-1 shadow-(--shadow-brain-rule) overflow-x-auto${comment ? "" : " h-30"}`}
      aria-label={rowLabel}
      style={{
        marginLeft: depth * 32,
        background: "linear-gradient(55deg, var(--color-brain-rule-from) 0%, var(--color-brain-rule-to) 100%)",
      }}
    >
      {comment && <span className="text-xs text-brain-ink/70 italic mb-1">{comment}</span>}
      <div className="flex flex-1 gap-1">
        {/* Line number badge -- aria-hidden because the number is already in the group aria-label */}
        {lineNumber !== undefined && (
          <span
            className="self-center shrink-0 h-9 w-9 rounded-full bg-brain-pill text-brain-pill-ink text-lg font-semibold flex items-center justify-center border-2 border-brain-pill-edge"
            aria-hidden="true"
          >
            {lineNumber}
          </span>
        )}

        {/* Trigger capsule, standing at the head of the WHEN side and reading
            the rule's own mode. */}
        <div
          className={`ml-2 ${kCapsuleClasses} ${kTriggerCapsuleChrome[trigger]}`}
          style={{ writingMode: "vertical-rl" }}
          aria-hidden="true"
        >
          <span className={kCapsuleLettersClasses}>{stackedLetters(triggerModeLabel(trigger, kDocsLocalizer))}</span>
        </div>

        {/* WHEN tiles */}
        <div className="self-center flex gap-1">
          {whenTiles.map((tile, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: stable in read-only view
            <DocsTileChip key={i} tileDef={tile} side={RuleSide.When} />
          ))}
        </div>

        {/* DO capsule */}
        <div
          className={`ml-3 ${kCapsuleClasses} ${kWhenCapsuleChrome}`}
          style={{ writingMode: "vertical-rl" }}
          aria-hidden="true"
        >
          <span className={kCapsuleLettersClasses}>{stackedLetters("Do")}</span>
        </div>

        {/* DO tiles */}
        <div className="self-center flex gap-1">
          {doTiles.map((tile, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: stable in read-only view
            <DocsTileChip key={i} tileDef={tile} side={RuleSide.Do} />
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Flat rule representation (tileIds resolved to IBrainTileDef)
// ---------------------------------------------------------------------------

/** Flat representation of a brain rule with `tileId`s already resolved to `IBrainTileDef`s. */
export interface DocsRuleData {
  comment?: string;
  /** Mode arming the rule, which its capsule reads. */
  trigger: RuleTriggerMode;
  whenTiles: IBrainTileDef[];
  doTiles: IBrainTileDef[];
  depth: number;
  children: DocsRuleData[];
}

// ---------------------------------------------------------------------------
// Rendered block of one or more rules
// ---------------------------------------------------------------------------

interface DocsRuleBlockProps {
  rules: DocsRuleData[];
}

function flattenRules(rules: DocsRuleData[], startLine: number = 1): Array<DocsRuleData & { lineNumber: number }> {
  const result: Array<DocsRuleData & { lineNumber: number }> = [];
  let line = startLine;
  for (const rule of rules) {
    result.push({ ...rule, lineNumber: line++ });
    if (rule.children.length > 0) {
      const childFlat = flattenRules(rule.children, line);
      result.push(...childFlat);
      line += childFlat.length;
    }
  }
  return result;
}

/** Render a stack of read-only brain rules as numbered rows. */
export function DocsRuleBlock({ rules }: DocsRuleBlockProps) {
  const flat = flattenRules(rules);
  return (
    <div className="rounded-lg overflow-hidden" style={{ zoom: 0.75 }}>
      {flat.map((rule) => (
        <DocsRuleRow
          key={rule.lineNumber}
          comment={rule.comment}
          trigger={rule.trigger}
          whenTiles={rule.whenTiles}
          doTiles={rule.doTiles}
          depth={rule.depth}
          lineNumber={rule.lineNumber}
        />
      ))}
    </div>
  );
}
