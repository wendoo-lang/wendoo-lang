import type { IRngServices, WendooEnvironment } from "@wendoo/core/app";
import { coreModule, createWendooEnvironment, Rng } from "@wendoo/core/app";
import { createProfileNumerics, type NumberPrecision } from "@wendoo/core/runtime";
import { conformanceModule } from "./profile";

/**
 * Seed of the random stream a conformance case is authored in. The brain,
 * page, rule, and literal-tile ids a case authors are drawn from it, so one
 * authored case compiles to one program with one set of ids on every run.
 */
export const CONFORMANCE_RNG_SEED = 1;

/**
 * Builds the environment a conformance case is authored, compiled, and
 * replayed in: the core module plus the conformance host profile, the random
 * stream `rng`, and the numeric semantics of `precision`.
 *
 * @param precision - Numeric precision the environment's operators, conversions, and math builtins compute at.
 * @param rng - Random stream the environment's document ids are minted from and its random reads draw from.
 *   Defaults to a fresh stream seeded with {@link CONFORMANCE_RNG_SEED}.
 */
export function createConformanceEnvironment(
  precision: NumberPrecision,
  rng: IRngServices = new Rng(CONFORMANCE_RNG_SEED)
): WendooEnvironment {
  return createWendooEnvironment({
    modules: [coreModule(), conformanceModule()],
    rng,
    numerics: createProfileNumerics(precision),
  });
}
