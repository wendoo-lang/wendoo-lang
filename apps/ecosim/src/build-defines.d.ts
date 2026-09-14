/**
 * Wendoo identity of the target the headless adapter artifact is, replaced
 * at build time from the `identity` this target's own `wendoo.json`
 * declares. Undeclared in a source run, so read it through a `typeof` guard.
 */
declare const TARGET_IDENTITY: string;

/**
 * The app's tile documentation as raw markdown keyed by content key, replaced
 * at build time so the artifact carries the documentation inside itself.
 * Undeclared in a source run, so read it through a `typeof` guard.
 */
declare const TILE_DOC_CONTENT: Readonly<Record<string, string>>;

/**
 * The brain document the app ships for each archetype, base64-encoded and keyed
 * by archetype name, replaced at build time so the artifact carries the shipped
 * brains inside itself. Undeclared in a source run, so read it through a
 * `typeof` guard.
 */
declare const SHIPPED_BRAIN_DEFS: Readonly<Record<string, string>>;

/**
 * The language build the headless adapter artifact bundles, replaced at build
 * time so a loader can compare the artifact's vintage with its own. Undeclared
 * in a source run and in every build but the headless one, so read it through a
 * `typeof` guard.
 */
declare const BUILD_STAMP: import("@wendoo/core").CoreBuild;

/**
 * The target-package version this app bundle is published as and the language
 * build it bundles, replaced at build time so the bundle states its own build
 * to the assistant service. Declared by the production app build and undeclared
 * in a dev server and a source run, so read it through a `typeof` guard.
 */
declare const CLIENT_BUILD: import("@wendoo/core").ClientBuild;
