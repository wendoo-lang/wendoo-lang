import type { ClientBuild } from "@wendoo/core";
import { DEV_CLIENT_BUILD } from "@wendoo/core";

/**
 * What this build of the app is: the version of the target package it was
 * published as, and the hash of the language build it bundles. Replaced at
 * build time from the app's own target manifest and the `@wendoo/core` the
 * build linked; a run no bundler stamped states {@link DEV_CLIENT_BUILD}.
 */
export const clientBuild: ClientBuild = typeof CLIENT_BUILD === "object" ? CLIENT_BUILD : DEV_CLIENT_BUILD;
