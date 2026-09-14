import type { ClientBuild } from "./build-identity";

/**
 * TEST-ONLY. The build a connecting client states, for an exercise that needs
 * one client build to stand for a real one. Neither value names a release this
 * repository ever published, and nothing reads either of them apart.
 */
export const __test__clientBuild: ClientBuild = {
  targetPackageVersion: "0.4.2",
  coreDistHash: "b6d0e4c7f1a95382",
};
