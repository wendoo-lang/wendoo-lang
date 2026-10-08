import type { ReactNode } from "react";
import { LoadingIndicator } from "../ui/loading-indicator";
import { kBrainDeskFill } from "./brain-desk";
import { type RulesAreaStand, rulesAreaStand, useLatchedPage } from "./rules-latch";
import { kBrainRulesAttribute } from "./rules-region";

/** Props for {@link BrainRulesRegion}. */
export interface BrainRulesRegionProps {
  /** What the region stands, from {@link rulesAreaStand}. */
  stand: RulesAreaStand;
  /** The rules, rendered only while `stand` is `"rules"`. */
  children: ReactNode;
}

/**
 * The recessed desk the editor's rules lay out on. Renders `children` only in
 * the `"rules"` stand; until then it marks itself busy and stands a loading
 * indicator in their place.
 */
export function BrainRulesRegion({ stand, children }: BrainRulesRegionProps) {
  return (
    <section
      {...{ [kBrainRulesAttribute]: "" }}
      className="overflow-hidden grow rounded-lg"
      style={{
        background: `radial-gradient(130% 90% at 50% -10%, var(--color-brain-desk-glow) 0%, transparent 55%), radial-gradient(circle at center, rgba(255, 255, 255, 0.035) 1px, transparent 1.3px), ${kBrainDeskFill}`,
        backgroundSize: "100% 100%, 22px 22px, 100% 100%",
        boxShadow: "inset 0 0 0 1px rgba(255, 255, 255, 0.06), inset 0 4px 20px var(--color-brain-desk-shade)",
      }}
      aria-label="Brain page editor content"
      aria-busy={stand === "loading"}
    >
      {stand === "rules" && children}
      {stand === "loading" && <LoadingIndicator label="Loading..." className="text-brain-ink/80" />}
      {stand === "no-page" && <p className="text-brain-ink/80 p-6">No BrainDef attached to this object.</p>}
    </section>
  );
}

/** Props for {@link LatchedBrainRulesRegion}. */
export interface LatchedBrainRulesRegionProps<T> {
  /** Identity of the page being shown, or undefined while there is no page. */
  shownPage: T | undefined;
  /** The rules of `shownPage`, rendered once they are latched on. */
  children: ReactNode;
}

/**
 * The rules region for `shownPage`, latching its rules on in an effect. Mount
 * it where the rules themselves are mounted: the commit that mounts it carries
 * the editor's chrome and the loading indicator, and the rules follow on the
 * next commit.
 */
export function LatchedBrainRulesRegion<T>({ shownPage, children }: LatchedBrainRulesRegionProps<T>) {
  return <BrainRulesRegion stand={rulesAreaStand(shownPage, useLatchedPage(shownPage))}>{children}</BrainRulesRegion>;
}
