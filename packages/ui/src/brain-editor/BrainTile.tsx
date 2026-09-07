import { type IBrainTileDef, isActionTileDef, RuleSide } from "@wendoo/core/brain";
import { CircleAlert, ClockFading } from "lucide-react";
import { type ButtonHTMLAttributes, forwardRef, useLayoutEffect, useState } from "react";
import { staticAssetUrl } from "../asset-url";
import { adjustColor, readableInk } from "../lib/color";
import { BrainBadge } from "./BrainBadge";
import { useBrainEditorConfig } from "./BrainEditorContext";
import { kRuleChromeLayer, kRuleContentLayer } from "./editor-layers";
import { kPageGridSelectionAttribute } from "./page-grid-selection";
import { customLiteralValueNode, TileValue } from "./TileValue";
import type { TileBadge } from "./tile-badges";
import {
  kDefaultTileHue,
  resolveTileVisual,
  tileAccessibleName,
  tileBorderColor,
  tileEdgeColor,
  tileVisualCategory,
} from "./tile-visual-utils";

interface BrainTileProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  tileDef: IBrainTileDef;
  side: RuleSide;
  badge?: TileBadge;
}

/**
 * Attribute marking the frame every value tile draws its value inside, text and
 * custom-drawn node alike. Valued empty.
 */
export const kTileValueFrameAttribute = "data-tile-value-frame";

/** The font a tile's label is laid out in, which its measurement reproduces. */
const kTileLabelFontSize = "0.875rem";
const kTileLabelFontFamily =
  "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace";
const kTileLabelFontWeight = "600";

/**
 * Widths already measured, keyed by the document's font-loading status followed
 * by a newline and the label. A width depends only on the label and the tile
 * font, so a hit is exact; carrying the font-loading status in the key keeps a
 * width measured before a webfont resolved from being served afterwards.
 */
const tileLabelWidths = new Map<string, number>();

/**
 * The width `label` renders at in the tile font, in CSS pixels, rounded as
 * `offsetWidth` rounds. The first call for a label lays the text out in a hidden
 * span appended to `document.body`, which forces a synchronous layout of the
 * whole document; every later call for the same label and font-loading status is
 * served from {@link tileLabelWidths} and lays nothing out.
 */
function measureTileLabelWidth(label: string): number {
  const key = `${document.fonts.status}\n${label}`;
  const cached = tileLabelWidths.get(key);
  if (cached !== undefined) return cached;

  const tempSpan = document.createElement("span");
  tempSpan.style.visibility = "hidden";
  tempSpan.style.position = "absolute";
  tempSpan.style.whiteSpace = "nowrap";
  tempSpan.style.fontSize = kTileLabelFontSize;
  tempSpan.style.fontFamily = kTileLabelFontFamily;
  tempSpan.style.fontWeight = kTileLabelFontWeight;
  tempSpan.textContent = label;
  document.body.appendChild(tempSpan);
  const labelWidth = tempSpan.offsetWidth;
  document.body.removeChild(tempSpan);

  tileLabelWidths.set(key, labelWidth);
  return labelWidth;
}

/**
 * Renders a single brain tile as a styled button with icon, label, and optional
 * data-type indicator and badge. Forwards a ref to the underlying button.
 */
export const BrainTile = forwardRef<HTMLButtonElement, BrainTileProps>(
  ({ tileDef, side, badge, className = "", style, ...props }, ref) => {
    const editorConfig = useBrainEditorConfig();
    const { customLiteralTypes } = editorConfig;
    const [isOverflowing, setIsOverflowing] = useState(false);
    const [isHovered, setIsHovered] = useState(false);
    const [labelBasedWidth, setLabelBasedWidth] = useState<number | undefined>(undefined);

    const visual = resolveTileVisual(editorConfig, tileDef);
    const label = visual.label;
    const iconUrl = visual.iconUrl || staticAssetUrl("assets/brain/icons/question_mark.svg");
    const baseColor =
      (side === RuleSide.When ? visual?.colorDef?.when : side === RuleSide.Do ? visual?.colorDef?.do : undefined) ||
      kDefaultTileHue;

    const category = tileVisualCategory(tileDef);
    const isValueTile = category === "value";
    // True when this value tile's type supplies its own node for the value box.
    const drawsOwnValue = isValueTile && customLiteralValueNode(tileDef, customLiteralTypes) !== undefined;
    const isFactoryTile = category === "factory";
    const isActionTile = isActionTileDef(tileDef);
    const isAsyncAction = isActionTile && tileDef.action.isAsync === true;

    const lighterColor2 = adjustColor(baseColor, 0.4);
    const darkerColor = adjustColor(baseColor, 0);
    const darkerSaturatedColor = tileEdgeColor(baseColor);
    // The label sits on the tile fill, so its ink is chosen against that fill.
    const labelInk = readableInk(darkerColor);
    const surfaceStyle = {
      background: baseColor,
      borderColor: tileBorderColor(baseColor),
    };

    // A tile the page's selection rests on stands grown, and takes no further
    // growth from the pointer resting on it as well.
    const isPageGridSelected = kPageGridSelectionAttribute in props;

    useLayoutEffect(() => {
      const labelWidth = measureTileLabelWidth(label);

      const defaultWidth = 96;
      const maxWidth = isValueTile ? 288 : 192;
      const labelPadding = isValueTile ? 24 : 16;
      const neededWidth = labelWidth + labelPadding;

      if (neededWidth > defaultWidth) {
        setLabelBasedWidth(Math.min(neededWidth, maxWidth));
      } else {
        setLabelBasedWidth(undefined);
      }

      setIsOverflowing(neededWidth > maxWidth);
    }, [label, isValueTile]);

    return (
      <div
        className={`relative self-center transition-transform duration-100 ${isPageGridSelected ? "brain-tile-selected" : "hover:scale-105"}`}
      >
        {isAsyncAction && (
          <BrainBadge
            className={`absolute -top-1.5 -left-1.5 ${kRuleChromeLayer} flex items-center justify-center rounded-full w-6 h-6 shadow-md border pointer-events-auto bg-brain-timed border-brain-timed-ink text-brain-timed-ink`}
            message="May take time to complete"
          >
            <ClockFading className="w-4 h-4" />
          </BrainBadge>
        )}
        {badge && (
          <BrainBadge
            className={`absolute -top-1.5 -right-1.5 ${kRuleChromeLayer} flex items-center justify-center rounded-full w-6 h-6 shadow-md border pointer-events-auto ${
              badge.type === "error"
                ? "bg-destructive border-destructive text-destructive-foreground"
                : "bg-brain-warn border-brain-warn-edge text-brain-warn-ink"
            }`}
            message={badge.message}
          >
            <CircleAlert className="w-4 h-4" />
          </BrainBadge>
        )}
        <button
          ref={ref}
          data-scrollable={isOverflowing}
          onMouseEnter={() => setIsHovered(true)}
          onMouseLeave={() => setIsHovered(false)}
          // A caller's own style is layered over the tile's, never in place of it.
          style={{
            ...surfaceStyle,
            ...(labelBasedWidth !== undefined ? { minWidth: labelBasedWidth } : {}),
            ...style,
          }}
          className={`flex flex-col border-2 h-24 max-h-24 min-h-24 ${isValueTile ? "w-auto min-w-24 max-w-72 px-3 pb-2.5" : "w-24 min-w-24 max-w-48 px-1 pb-1.5"} overflow-hidden rounded-lg pt-2 text-black text-sm font-medium cursor-pointer self-center shadow-sm relative transition-[outline-offset] duration-150 ${className}`}
          aria-label={tileAccessibleName(editorConfig, tileDef)}
          {...props}
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
          <div className={`flex-1 flex flex-col items-center justify-center relative ${kRuleContentLayer}`}>
            {isValueTile ? (
              <div className="min-h-16 flex-1 flex items-center justify-center text-lg font-semibold text-center px-2 overflow-hidden w-full">
                <div
                  {...{ [kTileValueFrameAttribute]: "" }}
                  className="truncate border-[3px] rounded px-2 py-1 shadow-inner"
                  style={{
                    backgroundColor: drawsOwnValue ? "var(--color-panel)" : lighterColor2,
                    borderColor: "white",
                    boxShadow: "inset 0 0 0 1px #363535",
                  }}
                >
                  <TileValue tileDef={tileDef} />
                </div>
              </div>
            ) : (
              <img
                src={iconUrl}
                alt=""
                className={`h-16 w-full object-contain ${isFactoryTile ? "scale-50" : ""}`}
                aria-hidden="true"
              />
            )}
            <span
              className={`flex-1 flex items-end w-full text-sm ${isOverflowing ? "overflow-visible justify-start" : "overflow-hidden justify-center"}`}
            >
              <span
                className="whitespace-nowrap inline-block font-mono font-semibold"
                style={{
                  color: labelInk,
                  ...(isOverflowing && isHovered ? { animation: "marquee-scroll 4s linear infinite" } : {}),
                }}
              >
                {isOverflowing
                  ? `${label}\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0${label}\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0${label}\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0`
                  : label}
              </span>
            </span>
          </div>
        </button>
      </div>
    );
  }
);

BrainTile.displayName = "BrainTile";
