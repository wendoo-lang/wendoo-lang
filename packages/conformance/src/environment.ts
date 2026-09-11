import type { WendooEnvironment } from "@wendoo/core/app";
import { coreModule, createWendooEnvironment, Rng } from "@wendoo/core/app";
import { createProfileNumerics, type NumberPrecision } from "@wendoo/core/runtime";
import { conformanceModule } from "./profile";

/**
 * Seed of the random stream every conformance environment is built with. The
 * brain, page, rule, and literal-tile ids a case authors are drawn from it, so
 * one authored case compiles to one program with one set of ids on every run.
 */
export const CONFORMANCE_RNG_SEED = 1;

/**
 * Builds the environment a conformance case is authored, compiled, and
 * replayed in: the core module plus the conformance host profile, the seeded
 * random stream, and the numeric semantics of `precision`.
 *
 * @param precision - Numeric precision the environment's operators, conversions, and math builtins compute at.
 */
export function createConformanceEnvironment(precision: NumberPrecision): WendooEnvironment {
  return createWendooEnvironment({
    modules: [coreModule(), conformanceModule()],
    rng: new Rng(CONFORMANCE_RNG_SEED),
    numerics: createProfileNumerics(precision),
  });
}
