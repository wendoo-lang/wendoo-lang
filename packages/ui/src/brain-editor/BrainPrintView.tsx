import { type IBrainTileDef, RuleSide } from "@wendoo/core/brain";
import type { BrainDef, BrainPageDef, BrainRuleDef } from "@wendoo/core/brain/model";
import { staticAssetUrl } from "../asset-url";
import { useBrainEditorConfig } from "./BrainEditorContext";
import { BrainPrintRuleSentence } from "./BrainRuleSentence";
import { TileValue } from "./TileValue";
import { kDefaultTileHue, resolveTileVisual, tileVisualCategory } from "./tile-visual-utils";

// -- Print tile (simplified, no glass, no gradients) -------------------------

interface PrintTileProps {
  tileDef: IBrainTileDef;
  side: RuleSide;
}

function PrintTile({ tileDef, side }: PrintTileProps) {
  const editorConfig = useBrainEditorConfig();

  const visual = resolveTileVisual(editorConfig, tileDef);
  const label = visual.label;
  const iconUrl = visual.iconUrl || staticAssetUrl("assets/brain/icons/question_mark.svg");
  const baseColor =
    (side === RuleSide.When ? visual?.colorDef?.when : side === RuleSide.Do ? visual?.colorDef?.do : undefined) ||
    kDefaultTileHue;

  const category = tileVisualCategory(tileDef);
  // A printed accessor reads its field name in a value box, its own icon in the corner.
  const isValueTile = category === "value" || category === "accessor";
  const isFactoryTile = category === "factory";

  return (
    <div className="brain-print-tile" style={{ borderColor: baseColor }}>
      {isValueTile && (
        <div
          style={{
            WebkitMaskImage: `url(${iconUrl})`,
            WebkitMaskSize: "contain",
            WebkitMaskRepeat: "no-repeat",
            WebkitMaskPosition: "center",
            maskImage: `url(${iconUrl})`,
            maskSize: "contain",
            maskRepeat: "no-repeat",
            maskPosition: "center",
            backgroundColor: "#555",
          }}
          className="brain-print-tile-icon-small"
          aria-hidden="true"
        />
      )}
      <div className="brain-print-tile-content">
        {isValueTile ? (
          <div className="brain-print-tile-value">
            <TileValue tileDef={tileDef} />
          </div>
        ) : (
          <img
            src={iconUrl}
            alt=""
            className={`brain-print-tile-icon ${isFactoryTile ? "brain-print-tile-icon-factory" : ""}`}
            aria-hidden="true"
          />
        )}
        <span className="brain-print-tile-label">{label}</span>
      </div>
    </div>
  );
}

// -- Print rule (simplified, no glass, no interactive elements) ---------------

interface PrintRuleProps {
  ruleDef: BrainRuleDef;
  depth: number;
  lineNumber: number;
}

function PrintRule({ ruleDef, depth, lineNumber }: PrintRuleProps) {
  const whenTiles = ruleDef.when().tiles().toArray();
  const doTiles = ruleDef.do().tiles().toArray();
  const comment = ruleDef.comment();

  return (
    <div className="brain-print-rule" style={{ marginLeft: `${depth * 24}px` }}>
      {comment && <div className="brain-print-rule-comment">{comment}</div>}
      {/* Line number */}
      <div className="brain-print-rule-number">{lineNumber}</div>

      {/* WHEN chip */}
      <div className="brain-print-chip brain-print-chip-when">WHEN</div>

      {/* WHEN tiles */}
      {whenTiles.map((tileDef, idx) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: tiles have no stable IDs in print view
        <PrintTile key={`w${idx}`} tileDef={tileDef} side={RuleSide.When} />
      ))}

      {/* DO chip */}
      <div className="brain-print-chip brain-print-chip-do">DO</div>

      {/* DO tiles */}
      {doTiles.map((tileDef, idx) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: tiles have no stable IDs in print view
        <PrintTile key={`d${idx}`} tileDef={tileDef} side={RuleSide.Do} />
      ))}

      {/* The rule read as a sentence, on its own line under the tiles */}
      <BrainPrintRuleSentence ruleDef={ruleDef} />
    </div>
  );
}

// -- Flatten rules (same logic as BrainPageEditor) ----------------------------

interface FlatRule {
  ruleDef: BrainRuleDef;
  depth: number;
  lineNumber: number;
}

function flattenRules(rules: BrainRuleDef[], depth: number = 0, startLine: number = 1): FlatRule[] {
  const result: FlatRule[] = [];
  let currentLine = startLine;

  rules.forEach((ruleDef) => {
    result.push({ ruleDef, depth, lineNumber: currentLine });
    currentLine++;

    if (ruleDef.children().size() > 0) {
      const childRules = flattenRules(ruleDef.children().toArray() as BrainRuleDef[], depth + 1, currentLine);
      result.push(...childRules);
      currentLine += childRules.length;
    }
  });

  return result;
}

// -- Print page ---------------------------------------------------------------

interface PrintPageProps {
  pageDef: BrainPageDef;
  pageNumber: number;
}

function PrintPage({ pageDef, pageNumber }: PrintPageProps) {
  const flatRules = flattenRules(pageDef.children().toArray() as BrainRuleDef[]);

  // Filter out trailing empty rules (the editor always appends an empty one)
  const nonEmptyRules = flatRules.filter((fr) => !fr.ruleDef.isEmpty(false));

  return (
    <div className="brain-print-page">
      <h2 className="brain-print-page-header">
        <span className="brain-print-page-number">Page {pageNumber}</span>
        <span className="brain-print-page-name">{pageDef.name()}</span>
      </h2>
      <div className="brain-print-page-rules">
        {nonEmptyRules.length === 0 ? (
          <div className="brain-print-empty">(empty page)</div>
        ) : (
          nonEmptyRules.map((fr) => (
            <PrintRule key={fr.lineNumber} ruleDef={fr.ruleDef} depth={fr.depth} lineNumber={fr.lineNumber} />
          ))
        )}
      </div>
    </div>
  );
}

// -- Main print view ----------------------------------------------------------

interface BrainPrintViewProps {
  brainDef: BrainDef;
}

/** Visual print layout for a brain. Renders each page as a series of WHEN/DO rule rows with tile chips. */
export function BrainPrintView({ brainDef }: BrainPrintViewProps) {
  const pages = brainDef.pages().toArray() as BrainPageDef[];

  return (
    <div className="brain-print-view">
      <div className="brain-print-header">
        <h1 className="brain-print-title">{brainDef.name()}</h1>
      </div>
      {pages.map((pageDef, idx) => (
        <PrintPage key={pageDef.pageId()} pageDef={pageDef} pageNumber={idx + 1} />
      ))}
    </div>
  );
}
