import type { ITileCatalog } from "@wendoo/core/brain";
import type { TileCatalog } from "@wendoo/core/brain/tiles";
import { toast } from "@wendoo/ui";
import { setClipboardFromJson } from "@wendoo/ui/brain-editor/rule-clipboard";
import { ClipboardCopy } from "lucide-react";
import { useMemo } from "react";
import {
  type BrainFenceRule,
  brainFenceRuleTrigger,
  brainFenceTileSide,
  buildBrainFenceCatalog,
  parseBrainFence,
  parseBrainFenceMeta,
  resolveBrainFenceTiles,
} from "./brain-fence";
import { DocsRuleBlock, type DocsRuleData, DocsTileChip } from "./DocsRule";
import { useDocsBrainServices, useDocsSidebar, useDocsTileCatalog } from "./DocsSidebarContext";

/** Resolve one fence rule and its children into the flat shape the rule rows draw. */
function convertRule(
  plain: BrainFenceRule,
  tileCatalog: ITileCatalog | undefined,
  localCatalog: TileCatalog | undefined,
  depth = 0
): DocsRuleData {
  return {
    comment: plain.comment,
    trigger: brainFenceRuleTrigger(plain),
    whenTiles: resolveBrainFenceTiles(plain.when ?? [], tileCatalog, localCatalog),
    doTiles: resolveBrainFenceTiles(plain.do ?? [], tileCatalog, localCatalog),
    depth,
    children: (plain.children ?? []).map((c) => convertRule(c, tileCatalog, localCatalog, depth + 1)),
  };
}

// ---------------------------------------------------------------------------
// BrainCodeBlock component
// ---------------------------------------------------------------------------

interface BrainCodeBlockProps {
  /** Raw JSON string from inside the brain fence. */
  content: string;
  /** Meta string from the code fence info (e.g., "noframe"). */
  meta?: string;
}

/**
 * Renders a fenced ```brain``` code block: the JSON inside is parsed and shown
 * either as a strip of read-only tile chips or as a stack of read-only rule
 * rows. For rule blocks, also exposes a copy-to-clipboard action so the user
 * can paste the example into the brain editor.
 */
export function BrainCodeBlock({ content, meta = "" }: BrainCodeBlockProps) {
  const { close } = useDocsSidebar();
  const tileCatalog = useDocsTileCatalog();
  const brainServices = useDocsBrainServices();
  const isMobile = typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches;
  const fenceMeta = useMemo(() => parseBrainFenceMeta(meta), [meta]);

  const parsed = useMemo(() => {
    const block = parseBrainFence(content);
    if (!block) return null;
    const localCatalog = buildBrainFenceCatalog(block.catalogEntries, brainServices);
    if (block.kind === "tiles") {
      const side = brainFenceTileSide(block.side, fenceMeta.side);
      return { kind: "tiles" as const, tiles: resolveBrainFenceTiles(block.tileIds, tileCatalog, localCatalog), side };
    }
    return { kind: "rules" as const, rules: block.rules.map((r) => convertRule(r, tileCatalog, localCatalog)) };
  }, [content, fenceMeta.side, tileCatalog, brainServices]);

  const handleInsert = () => {
    const block = parseBrainFence(content);
    if (!block || block.kind !== "rules") return;
    setClipboardFromJson(block.rules, block.catalogEntries);
    const count = block.rules.length;
    toast.success(count === 1 ? "Example copied -- paste into a rule" : `${count} rules copied -- paste into a rule`);
    if (isMobile) {
      close();
    }
  };

  if (!parsed) {
    return (
      <pre className="rounded bg-muted border border-border p-3 text-xs text-red-400 overflow-x-auto my-2">
        {content}
      </pre>
    );
  }

  // Standalone tile rendering (no rule frame)
  if (parsed.kind === "tiles") {
    if (fenceMeta.noFrame) {
      return (
        <div className="my-3 flex flex-wrap gap-1" style={{ zoom: 0.75 }}>
          {parsed.tiles.map((tile, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: stable in read-only view
            <DocsTileChip key={i} tileDef={tile} side={parsed.side} />
          ))}
        </div>
      );
    }
    return (
      <div className="my-3 rounded-lg border border-border overflow-hidden">
        <div className="p-2 bg-muted/50 flex flex-wrap gap-1" style={{ zoom: 0.75 }}>
          {parsed.tiles.map((tile, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: stable in read-only view
            <DocsTileChip key={i} tileDef={tile} side={parsed.side} />
          ))}
        </div>
      </div>
    );
  }

  // Rule rendering
  if (fenceMeta.noFrame) {
    return (
      <div className="my-3">
        <DocsRuleBlock rules={parsed.rules} />
      </div>
    );
  }

  return (
    <div className="my-3 rounded-lg border border-slate-700 overflow-hidden">
      {/* Rendered tiles */}
      <div className="p-2 bg-muted/50">
        <DocsRuleBlock rules={parsed.rules} />
      </div>

      {/* Insert button */}
      <div className="flex items-center justify-between px-3 py-2 bg-muted/80 border-t border-border">
        <span className="text-xs text-muted-foreground">
          {parsed.rules.length} {parsed.rules.length === 1 ? "rule" : "rules"}
        </span>
        <button
          type="button"
          onClick={handleInsert}
          aria-label="Copy rules to clipboard"
          className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded bg-secondary hover:bg-secondary/80 text-secondary-foreground transition-colors border border-border pointer-events-auto"
        >
          <ClipboardCopy className="w-3 h-3" aria-hidden="true" />
          Copy
        </button>
      </div>
    </div>
  );
}
