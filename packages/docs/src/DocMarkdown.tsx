import type { IBrainTileDef } from "@wendoo/core/brain";
import type { Element } from "hast";
import type { ReactNode } from "react";
import { useState } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { BrainCodeBlock } from "./BrainCodeBlock";
import { InlineTileChip, InlineTileIcon } from "./DocsRule";
import { useDocsResolveTileVisual, useDocsSidebar } from "./DocsSidebarContext";

// ---------------------------------------------------------------------------
// Tag pill helpers
// ---------------------------------------------------------------------------

interface TagSpec {
  label: string;
  color: string;
}

const TAG_DEFAULT_COLOR = "#64748b";

function parseTagSpec(text: string): TagSpec | null {
  const body = text.slice(4); // strip "tag:"
  if (!body) return null;
  const parts = body.split(";");
  const label = parts[0].trim();
  if (!label) return null;
  let color = TAG_DEFAULT_COLOR;
  for (let i = 1; i < parts.length; i++) {
    const colonIdx = parts[i].indexOf(":");
    if (colonIdx !== -1) {
      const key = parts[i].slice(0, colonIdx).trim();
      const val = parts[i].slice(colonIdx + 1).trim();
      if (key === "color" && /^#[0-9a-f]{6}$/i.test(val)) {
        color = val;
      }
    }
  }
  return { label, color };
}

function tagTextColor(bgHex: string): string {
  const r = Number.parseInt(bgHex.slice(1, 3), 16);
  const g = Number.parseInt(bgHex.slice(3, 5), 16);
  const b = Number.parseInt(bgHex.slice(5, 7), 16);
  // W3C perceived brightness formula
  const brightness = (r * 299 + g * 587 + b * 114) / 1000;
  return brightness > 128 ? "#000000" : "#ffffff";
}

function InlineTagPill({ label, color }: TagSpec) {
  return (
    <span
      className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold align-middle"
      style={{ backgroundColor: color, color: tagTextColor(color) }}
    >
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// InlineTileLink -- wraps InlineTileIcon with click-to-navigate behavior.
// Rendered as a component so it can use the sidebar context hook.
// ---------------------------------------------------------------------------

function InlineTileLink({ tileId, tileDef }: { tileId: string; tileDef: IBrainTileDef }) {
  const { registry, navigateToEntry } = useDocsSidebar();
  const resolveTileVisual = useDocsResolveTileVisual();
  const hasDocPage = registry.tiles.has(tileId);
  const label = resolveTileVisual(tileDef)?.label ?? tileId;

  return (
    <button
      type="button"
      onClick={() => navigateToEntry("tiles", tileId)}
      className="inline-flex shrink-0 cursor-pointer hover:brightness-125 transition-[filter]"
      aria-label={`View docs for ${label}`}
    >
      <InlineTileIcon tileDef={tileDef} />
    </button>
  );
}

// ---------------------------------------------------------------------------
// InlineEntryLink -- a `tile:` reference to a registry entry no catalog tile
// stands for, drawn with the label and icon the entry carries.
// ---------------------------------------------------------------------------

function InlineEntryLink({ tileId, label, iconUrl }: { tileId: string; label: string; iconUrl: string | undefined }) {
  const { navigateToEntry } = useDocsSidebar();

  return (
    <button
      type="button"
      onClick={() => navigateToEntry("tiles", tileId)}
      className="inline-flex shrink-0 cursor-pointer hover:brightness-125 transition-[filter]"
      aria-label={`View docs for ${label}`}
    >
      <InlineTileChip label={label} iconUrl={iconUrl} />
    </button>
  );
}

// ---------------------------------------------------------------------------
// InlineConceptLink -- a concept page's registered title, navigating to that
// page on click.
// ---------------------------------------------------------------------------

function InlineConceptLink({ conceptId, title }: { conceptId: string; title: string }) {
  const { navigateToEntry } = useDocsSidebar();

  return (
    <button
      type="button"
      data-concept-id={conceptId}
      onClick={() => navigateToEntry("concepts", conceptId)}
      className="text-foreground underline hover:text-foreground/80 transition-colors"
    >
      {title}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Fence inspection
// ---------------------------------------------------------------------------

/** The `code` element a `<pre>` wraps, or undefined when it wraps anything else. */
function fencedCodeElement(node: Element | undefined): Element | undefined {
  const child = node?.children.find((c): c is Element => c.type === "element");
  return child?.tagName === "code" ? child : undefined;
}

/** The language a fenced code element's `language-*` class names, empty for a fence with no info string. */
function fenceLanguage(node: Element | undefined): string {
  const className = node?.properties?.className;
  const names = Array.isArray(className) ? className.map(String) : [];
  const named = names.find((name) => name.startsWith("language-"));
  return named ? named.slice("language-".length) : "";
}

// ---------------------------------------------------------------------------
// Assistant section
// ---------------------------------------------------------------------------

/**
 * The assistant section of a document, closed until the reader opens it: while
 * it is closed `text` is not rendered at all. The button reports its state on
 * `aria-expanded`.
 */
function AssistantSection({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="my-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="text-xs text-muted-foreground underline hover:text-foreground transition-colors"
      >
        Notes for the assistant
      </button>
      {open ? (
        <div className="border-l-2 border-border pl-3 mt-1 text-sm text-muted-foreground whitespace-pre-wrap">
          {text}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stable components map -- defined at module level so the object reference
// never changes between renders. react-markdown uses component references
// to determine whether to remount subtrees; inline definitions would create
// new references on every render and destroy text selections.
// ---------------------------------------------------------------------------

const MD_COMPONENTS: Components = {
  // A brain fence and an assistant section each draw their own container, so
  // the <pre> around them is dropped; every other fence keeps a real block
  // wrapper.
  pre({ children: preChildren, node }) {
    const language = fenceLanguage(fencedCodeElement(node));
    if (language === "brain" || language === "assistant") {
      return <>{preChildren}</>;
    }
    return <pre className="bg-muted border border-border rounded p-3 my-2 overflow-x-auto">{preChildren}</pre>;
  },

  code({ className, children, node }) {
    return (
      <MarkdownCode className={className} node={node}>
        {children}
      </MarkdownCode>
    );
  },

  // Headings
  h1({ children: h }) {
    return <h1 className="text-base font-bold text-foreground mt-4 mb-2 first:mt-0">{h}</h1>;
  },
  h2({ children: h }) {
    return <h2 className="text-sm font-semibold text-foreground mt-3 mb-1.5 border-b border-border pb-1">{h}</h2>;
  },
  h3({ children: h }) {
    return <h3 className="text-sm font-medium text-foreground mt-2 mb-1">{h}</h3>;
  },

  // Block elements
  p({ children: p }) {
    return <p className="text-sm text-foreground leading-relaxed mb-2">{p}</p>;
  },
  ul({ children: ul }) {
    return <ul className="list-disc list-inside text-sm text-foreground mb-2 space-y-0.5 pl-2">{ul}</ul>;
  },
  ol({ children: ol }) {
    return <ol className="list-decimal list-inside text-sm text-foreground mb-2 space-y-0.5 pl-2">{ol}</ol>;
  },
  li({ children: li }) {
    return <li className="leading-relaxed">{li}</li>;
  },
  blockquote({ children: bq }) {
    return (
      <blockquote className="border-l-2 border-border pl-3 my-2 text-sm text-muted-foreground italic">{bq}</blockquote>
    );
  },
  strong({ children: s }) {
    return <strong className="font-semibold text-foreground">{s}</strong>;
  },
  em({ children: e }) {
    return <em className="italic text-muted-foreground">{e}</em>;
  },
  hr() {
    return <hr className="border-border my-3" />;
  },

  // Table elements
  table({ children: t }) {
    return (
      <div className="overflow-x-auto my-3">
        <table className="w-full text-sm border-collapse">{t}</table>
      </div>
    );
  },
  thead({ children: t }) {
    return <thead className="border-b border-border">{t}</thead>;
  },
  tbody({ children: t }) {
    return <tbody>{t}</tbody>;
  },
  tr({ children: t }) {
    return <tr className="border-b border-border/50 last:border-0">{t}</tr>;
  },
  th({ children: t }) {
    return <th className="text-left text-foreground font-semibold px-2 py-1.5">{t}</th>;
  },
  td({ children: t }) {
    return <td className="text-foreground px-2 py-1.5 align-top">{t}</td>;
  },

  a({ href, children }) {
    const isExternal = typeof href === "string" && /^https?:\/\//.test(href);
    if (isExternal) {
      return (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary underline hover:text-primary/80 transition-colors"
        >
          {children}
        </a>
      );
    }
    return (
      <a href={href} className="text-foreground underline hover:text-foreground/80 transition-colors">
        {children}
      </a>
    );
  },
};

function MarkdownCode({ className, children, node }: { className?: string; children?: ReactNode; node?: unknown }) {
  const { tileCatalog, registry } = useDocsSidebar();
  const lang = (className ?? "").replace("language-", "");

  if (lang === "brain") {
    const meta = ((node as Element | undefined)?.data as { meta?: string } | undefined)?.meta ?? "";
    return <BrainCodeBlock content={String(children).trimEnd()} meta={meta} />;
  }

  if (lang === "assistant") {
    return <AssistantSection text={String(children).trimEnd()} />;
  }

  if (!className) {
    const text = String(children);
    if (text.startsWith("tile:")) {
      const tileId = text.slice(5);
      const tileDef = tileCatalog?.get(tileId);
      if (tileDef) {
        return <InlineTileLink tileId={tileId} tileDef={tileDef} />;
      }
      const entry = registry.tiles.get(tileId);
      if (entry?.label) {
        return <InlineEntryLink tileId={tileId} label={entry.label} iconUrl={entry.iconUrl} />;
      }
      return <code className="bg-muted text-warning px-1 rounded text-xs font-mono">{tileId}</code>;
    }
    if (text.startsWith("concept:")) {
      const conceptId = text.slice(8);
      const concept = registry.concepts.get(conceptId);
      if (concept) {
        return <InlineConceptLink conceptId={conceptId} title={concept.title} />;
      }
      return <code className="bg-muted text-warning px-1 rounded text-xs font-mono">{conceptId}</code>;
    }
    if (text.startsWith("tag:")) {
      const spec = parseTagSpec(text);
      if (spec) {
        return <InlineTagPill label={spec.label} color={spec.color} />;
      }
    }
  }

  return <code className="bg-muted text-foreground px-1 rounded text-xs font-mono">{children}</code>;
}

// ---------------------------------------------------------------------------
// DocMarkdown -- renders a markdown string with brain-fence and tile-ref support
// ---------------------------------------------------------------------------

interface DocMarkdownProps {
  children: string;
}

/**
 * Render a markdown string with the docs-package custom components: ```brain```
 * fences are rendered via {@link BrainCodeBlock}, ```assistant``` fences via
 * {@link AssistantSection}, `tile:xxx` references via {@link InlineTileIcon},
 * and `concept:xxx` references via {@link InlineConceptLink}, which reads the
 * concept page's registered title and opens that page. A tile reference the
 * catalog holds no tile for, naming a registry entry that carries a label,
 * renders that label and the entry's icon and opens the entry. Any other
 * reference naming a tile the catalog does not hold, and a reference naming a
 * concept the registry does not hold, renders the id it names as
 * warning-colored code.
 */
export function DocMarkdown({ children }: DocMarkdownProps) {
  return (
    <Markdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
      {children}
    </Markdown>
  );
}
