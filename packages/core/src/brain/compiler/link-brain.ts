import { List, type ReadonlyList } from "../../platform/list";
import type { BrainLinkEnvironment, IConversionRegistry } from "../../runtime";
import type { IBrainDef } from "../interfaces";
import { compileBrain } from "./brain-compiler";
import type { BrainBuildDiagnostic, BrainBuildResult } from "./diagnostics";
import { linkBrainProgram } from "./linker";
import { treeshakeProgram } from "./tree-shaker";

function hasError(diagnostics: ReadonlyList<BrainBuildDiagnostic>): boolean {
  for (let i = 0; i < diagnostics.size(); i++) {
    if (diagnostics.get(i)!.severity === "error") {
      return true;
    }
  }
  return false;
}

function appendAll(target: List<BrainBuildDiagnostic>, source: ReadonlyList<BrainBuildDiagnostic>): void {
  for (let i = 0; i < source.size(); i++) {
    target.push(source.get(i)!);
  }
}

/**
 * Runs the brain compile -> link -> treeshake pipeline once and returns the
 * linked program with any diagnostics.
 *
 * @param brainDef - Brain definition to compile and link.
 * @param linkEnvironment - Tile catalogs and action resolver used for linking.
 * @param conversions - Conversion registry used during compilation.
 */
export function runBrainLinkPipeline(
  brainDef: IBrainDef,
  linkEnvironment: BrainLinkEnvironment,
  conversions: IConversionRegistry
): BrainBuildResult {
  const diagnostics = List.empty<BrainBuildDiagnostic>();

  const compiled = compileBrain(
    brainDef,
    linkEnvironment.catalogs,
    conversions,
    linkEnvironment.actionResolver,
    linkEnvironment.typeRegistry
  );
  appendAll(diagnostics, compiled.diagnostics);
  if (hasError(diagnostics) || !compiled.program) {
    return { diagnostics };
  }

  const linked = linkBrainProgram(
    compiled.program,
    brainDef,
    linkEnvironment.catalogs,
    linkEnvironment.actionResolver,
    conversions
  );
  appendAll(diagnostics, linked.diagnostics);
  if (!linked.program) {
    return { diagnostics };
  }

  return { program: treeshakeProgram(linked.program, compiled.program.pinnedTypeIndices), diagnostics };
}
