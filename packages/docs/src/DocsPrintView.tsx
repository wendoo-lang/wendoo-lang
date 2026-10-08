import { type IBrainTileDef, type ITileCatalog, RuleSide, type RuleTriggerMode } from "@wendoo/core/brain";
import type { TileCatalog } from "@wendoo/core/brain/tiles";
import { createDefaultLocalizer } from "@wendoo/core/localization";
import { kDefaultTileHue } from "@wendoo/ui/brain-editor/tile-visual-utils";
import { triggerModeLabel } from "@wendoo/ui/brain-editor/trigger-mode";
import type { TileVisual } from "@wendoo/ui/brain-editor/types";
import type { Element } from "hast";
import type { ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  type BrainFenceRule,
  brainFenceRuleTrigger,
  brainFenceTileSide,
  buildBrainFenceCatalog,
  parseBrainFence,
  parseBrainFenceMeta,
  resolveBrainFenceTiles,
} from "./brain-fence";
import {
  useDocsBrainServices,
  useDocsResolveTileVisual,
  useDocsSidebar,
  useDocsTileCatalog,
} from "./DocsSidebarContext";

// ---------------------------------------------------------------------------
// Print-friendly tile chip -- no glass, no gradients, border-only
// ---------------------------------------------------------------------------

interface PrintTileChipProps {
  tileDef: IBrainTileDef;
  side: RuleSide;
}

function PrintTileChip({ tileDef, side }: PrintTileChipProps) {
  const resolveTileVisual = useDocsResolveTileVisual();
  const visual = resolveTileVisual(tileDef);
  const label = visual?.label || tileDef.tileId.split(".").pop() || tileDef.tileId;
  const iconUrl = visual?.iconUrl;
  const baseColor = (side === RuleSide.When ? visual?.colorDef?.when : visual?.colorDef?.do) || kDefaultTileHue;

  return (
    <div className="docs-print-tile" style={{ borderColor: baseColor }}>
      {iconUrl && <img src={iconUrl} alt="" className="docs-print-tile-icon" aria-hidden="true" />}
      <span className="docs-print-tile-label">{label}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Print-friendly rule row
// ---------------------------------------------------------------------------

/** Localizer the print chrome reads its mode words through, which renders the English sources. */
const kPrintLocalizer = createDefaultLocalizer();

interface PrintRuleRowProps {
  comment?: string;
  trigger: RuleTriggerMode;
  whenTiles: IBrainTileDef[];
  doTiles: IBrainTileDef[];
  depth: number;
  lineNumber: number;
}

function PrintRuleRow({ comment, trigger, whenTiles, doTiles, depth, lineNumber }: PrintRuleRowProps) {
  return (
    <div className="docs-print-rule" style={{ marginLeft: `${depth * 24}px` }}>
      {comment && <div className="docs-print-rule-comment">{comment}</div>}
      <div className="docs-print-rule-number">{lineNumber}</div>
      <div className="docs-print-chip docs-print-chip-when">
        {triggerModeLabel(trigger, kPrintLocalizer).toUpperCase()}
      </div>
      {whenTiles.map((tile, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: stable in print view
        <PrintTileChip key={`w${i}`} tileDef={tile} side={RuleSide.When} />
      ))}
      {whenTiles.length === 0 && <span className="docs-print-empty-hint">always</span>}
      <div className="docs-print-chip docs-print-chip-do">DO</div>
      {doTiles.map((tile, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: stable in print view
        <PrintTileChip key={`d${i}`} tileDef={tile} side={RuleSide.Do} />
      ))}
      {doTiles.length === 0 && <span className="docs-print-empty-hint">nothing</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Brain fence -> print rules
// ---------------------------------------------------------------------------

interface FlatPrintRule {
  comment?: string;
  trigger: RuleTriggerMode;
  whenTiles: IBrainTileDef[];
  doTiles: IBrainTileDef[];
  depth: number;
  lineNumber: number;
}

/** Resolve the fence's rules into one numbered, depth-carrying row per rule and child rule. */
function flattenFenceRules(
  rules: BrainFenceRule[],
  tileCatalog: ITileCatalog | undefined,
  localCatalog: TileCatalog | undefined,
  depth = 0,
  startLine = 1
): FlatPrintRule[] {
  const result: FlatPrintRule[] = [];
  let line = startLine;
  for (const rule of rules) {
    result.push({
      comment: rule.comment,
      trigger: brainFenceRuleTrigger(rule),
      whenTiles: resolveBrainFenceTiles(rule.when ?? [], tileCatalog, localCatalog),
      doTiles: resolveBrainFenceTiles(rule.do ?? [], tileCatalog, localCatalog),
      depth,
      lineNumber: line++,
    });
    if (rule.children && rule.children.length > 0) {
      const children = flattenFenceRules(rule.children, tileCatalog, localCatalog, depth + 1, line);
      result.push(...children);
      line += children.length;
    }
  }
  return result;
}

function PrintBrainCodeBlock({ content, meta }: { content: string; meta: string }) {
  const tileCatalog = useDocsTileCatalog();
  const brainServices = useDocsBrainServices();
  const fenceMeta = parseBrainFenceMeta(meta);
  const block = parseBrainFence(content);

  if (!block) {
    return <pre className="docs-print-code-fallback">{content}</pre>;
  }

  const localCatalog = buildBrainFenceCatalog(block.catalogEntries, brainServices);

  if (block.kind === "tiles") {
    const tiles = resolveBrainFenceTiles(block.tileIds, tileCatalog, localCatalog);
    const side = brainFenceTileSide(block.side, fenceMeta.side);
    return (
      <div className={fenceMeta.noFrame ? "docs-print-tiles-noframe" : "docs-print-brain-block"}>
        {tiles.map((tile, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: stable in print view
          <PrintTileChip key={i} tileDef={tile} side={side} />
        ))}
      </div>
    );
  }

  const flat = flattenFenceRules(block.rules, tileCatalog, localCatalog);
  return (
    <div className="docs-print-brain-block">
      {flat.map((r) => (
        <PrintRuleRow
          key={r.lineNumber}
          comment={r.comment}
          trigger={r.trigger}
          whenTiles={r.whenTiles}
          doTiles={r.doTiles}
          depth={r.depth}
          lineNumber={r.lineNumber}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tag pill helpers (print)
// ---------------------------------------------------------------------------

function parsePrintTagSpec(text: string): { label: string } | null {
  const body = text.slice(4); // strip "tag:"
  if (!body) return null;
  const label = body.split(";")[0].trim();
  if (!label) return null;
  return { label };
}

function PrintTagPill({ label }: { label: string }) {
  return <span className="docs-print-tag-pill">{label}</span>;
}

// ---------------------------------------------------------------------------
// Inline tile reference for print
// ---------------------------------------------------------------------------

function PrintInlineTileIcon({ tileDef }: { tileDef: IBrainTileDef }) {
  const resolveTileVisual = useDocsResolveTileVisual();
  const visual = resolveTileVisual(tileDef);
  const label = visual?.label || tileDef.tileId.split(".").pop() || tileDef.tileId;
  const iconUrl = visual?.iconUrl;
  const baseColor = visual?.colorDef?.when || visual?.colorDef?.do || kDefaultTileHue;

  return (
    <span className="docs-print-inline-tile" style={{ borderColor: baseColor }}>
      {iconUrl && <img src={iconUrl} alt="" className="docs-print-inline-tile-icon" aria-hidden="true" />}
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Print-friendly markdown components
// ---------------------------------------------------------------------------

const PRINT_MD_COMPONENTS: Components = {
  pre({ children }) {
    return <>{children}</>;
  },

  code({ className, children, node }) {
    return (
      <PrintMarkdownCode className={className} node={node}>
        {children}
      </PrintMarkdownCode>
    );
  },

  h1({ children }) {
    return <h1 className="docs-print-h1">{children}</h1>;
  },
  h2({ children }) {
    return <h2 className="docs-print-h2">{children}</h2>;
  },
  h3({ children }) {
    return <h3 className="docs-print-h3">{children}</h3>;
  },
  p({ children }) {
    return <p className="docs-print-p">{children}</p>;
  },
  ul({ children }) {
    return <ul className="docs-print-ul">{children}</ul>;
  },
  ol({ children }) {
    return <ol className="docs-print-ol">{children}</ol>;
  },
  li({ children }) {
    return <li className="docs-print-li">{children}</li>;
  },
  blockquote({ children }) {
    return <blockquote className="docs-print-blockquote">{children}</blockquote>;
  },
  strong({ children }) {
    return <strong className="docs-print-strong">{children}</strong>;
  },
  em({ children }) {
    return <em className="docs-print-em">{children}</em>;
  },
  hr() {
    return <hr className="docs-print-hr" />;
  },

  // Table elements
  table({ children }) {
    return (
      <div className="docs-print-table-wrap">
        <table className="docs-print-table">{children}</table>
      </div>
    );
  },
  thead({ children }) {
    return <thead className="docs-print-thead">{children}</thead>;
  },
  tbody({ children }) {
    return <tbody>{children}</tbody>;
  },
  tr({ children }) {
    return <tr className="docs-print-tr">{children}</tr>;
  },
  th({ children }) {
    return <th className="docs-print-th">{children}</th>;
  },
  td({ children }) {
    return <td className="docs-print-td">{children}</td>;
  },
};

function PrintMarkdownCode({
  className,
  children,
  node,
}: {
  className?: string;
  children?: ReactNode;
  node?: unknown;
}) {
  const { tileCatalog, registry } = useDocsSidebar();
  const lang = (className ?? "").replace("language-", "");

  if (lang === "brain") {
    const meta = ((node as Element | undefined)?.data as { meta?: string } | undefined)?.meta ?? "";
    return <PrintBrainCodeBlock content={String(children).trimEnd()} meta={meta} />;
  }

  if (!className) {
    const text = String(children);
    if (text.startsWith("tile:")) {
      const tileId = text.slice(5);
      const tileDef = tileCatalog?.get(tileId);
      if (tileDef) {
        return <PrintInlineTileIcon tileDef={tileDef} />;
      }
      return <code className="docs-print-code-inline">{tileId}</code>;
    }
    if (text.startsWith("concept:")) {
      const conceptId = text.slice(8);
      const concept = registry.concepts.get(conceptId);
      if (concept) {
        return <>{concept.title}</>;
      }
      return <code className="docs-print-code-inline">{conceptId}</code>;
    }
    if (text.startsWith("tag:")) {
      const spec = parsePrintTagSpec(text);
      if (spec) {
        return <PrintTagPill label={spec.label} />;
      }
    }
  }

  return <code className="docs-print-code-inline">{children}</code>;
}

// ---------------------------------------------------------------------------
// DocsPrintView -- renders a markdown doc page for print
// ---------------------------------------------------------------------------

interface DocsPrintViewProps {
  content: string;
}

/**
 * Renders a markdown doc page with print-optimized styling. A `concept:xxx`
 * reference prints as the concept page's registered title, and as the id it
 * names when the registry holds no such concept.
 */
export function DocsPrintView({ content }: DocsPrintViewProps) {
  return (
    <div className="docs-print-view">
      <Markdown remarkPlugins={[remarkGfm]} components={PRINT_MD_COMPONENTS}>
        {content}
      </Markdown>
    </div>
  );
}
