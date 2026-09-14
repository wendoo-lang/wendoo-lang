/**
 * The build of the language package a consumer holds. Two consumers agree on
 * the semantics a brain runs under exactly when they report the same
 * {@link CoreBuild.coreDistHash}.
 */
export interface CoreBuild {
  /** Version the language package declares for itself, for example `0.2.18`. */
  readonly coreVersion: string;
  /**
   * Hex sha256 over the language package's Node build output, content and
   * layout alike. It changes whenever the bundled semantics can change.
   */
  readonly coreDistHash: string;
}

/**
 * Target-package version a build that no release produced states for itself: an
 * app bundle built outside a release, and a run straight from source.
 */
export const DEV_TARGET_PACKAGE_VERSION = "dev";

/**
 * {@link CoreBuild.coreDistHash} a build states when no bundler measured the
 * language build it holds. It equals no measured hash, so a host comparing it
 * against one reads the two builds as different.
 */
export const UNKNOWN_CORE_DIST_HASH = "unknown";

/**
 * What a client application's build is: the target package it was published
 * as, and the language build it bundles. A host the client talks to holds this
 * to know which build of which target package it is serving.
 */
export interface ClientBuild {
  /**
   * Version of the target package the client was published as, as that
   * package's own manifest declares it. A build no release produced states the
   * version its build names for one, which is not a release version.
   */
  readonly targetPackageVersion: string;
  /** {@link CoreBuild.coreDistHash} of the language build the client bundles. */
  readonly coreDistHash: string;
}

/**
 * What a client application states of its build when no bundler stamped one
 * into it: a run straight from source, and a dev server's bundle. Neither value
 * names a release or a measured language build.
 */
export const DEV_CLIENT_BUILD: ClientBuild = {
  targetPackageVersion: DEV_TARGET_PACKAGE_VERSION,
  coreDistHash: UNKNOWN_CORE_DIST_HASH,
};
