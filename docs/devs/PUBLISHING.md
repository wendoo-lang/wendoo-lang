# Publishing Guide

This document describes how to publish `@wendoo/*` packages to npm.

## Package Dependency Order

Packages have internal `file:` dependencies that form a directed graph (the
`wendoo` package lives in `packages/cli`):

```
bridge-protocol   (no local deps)
core              (no local deps)
assistant-relay   -> core
service-api       -> core
ui                -> core
app-host          -> core, service-api
docs              -> core, ui
ts-compiler       -> core, service-api
bridge-client     -> bridge-protocol, core, service-api
assistant-bridge  -> app-host, assistant-relay, core
assistant-panel   -> assistant-bridge, assistant-relay, core, ui
bridge-app        -> app-host, bridge-client, bridge-protocol, core, ts-compiler
wendoo            -> app-host, assistant-bridge, service-api
```

Private packages (not published to npm):

```
join-codes        (no local deps)
bridge-session    -> bridge-protocol, join-codes
conformance       -> core
```

Private apps (not published to npm):

```
ecosim            -> app-host, assistant-bridge, assistant-panel, assistant-relay, bridge-app, core, docs, ts-compiler, ui, wendoo (dev)
ecosim-rbx        -> core
vscode-bridge     -> bridge-protocol, bridge-session
vscode-extension  -> app-host, bridge-app, bridge-client, bridge-protocol, service-api (all dev)
```

The release scripts handle dependency ordering automatically -- see "Running a Release"
below.

## How Publishing Works

Each package has `release:patch`, `release:minor`, and `release:major` npm scripts that
invoke `scripts/release.js`. The script automatically walks the `file:` dependency tree,
releasing upstream packages first in topological order. For each package in the chain it:

1. Runs pre-release checks (build, lint) locally
2. Bumps the version in `package.json`
3. Commits `package.json` and `package-lock.json` with a message matching the git tag
4. Creates a git tag (e.g. `core-v0.2.0`)
5. Pushes the commit and tag to origin
6. Waits for the corresponding GitHub Actions publish workflow to succeed

Only after a dependency's CI workflow succeeds does the script proceed to the next package.
If any workflow fails, the script aborts immediately -- no downstream packages are bumped.

Private packages (`"private": true`) in the dependency chain are skipped.

Pushing a tag triggers the corresponding GitHub Actions workflow
(`.github/workflows/publish-*.yml` for npm packages, `deploy-*.yml` for private apps),
which runs lint/build/tests and then publishes or deploys.

## Local `file:` Dependencies

In source, `package.json` files use `file:` paths for sibling packages:

```json
"@wendoo/core": "file:../core"
```

This ensures `npm install` on a fresh clone always creates the correct local symlinks,
regardless of whether a `package-lock.json` is present. See the note in
`packages/package.json` for the install order.

`file:` references are never committed to npm. Each publish workflow runs
`scripts/rewrite-local-deps.js` on the CI runner, which rewrites every `file:`
specifier naming a public sibling -- in `dependencies` and in `devDependencies` -- to a
version range (e.g. `^0.1.10`) and re-resolves the lockfile against the registry. Later,
after the build and tests, `scripts/strip-private-local-deps.js` removes the `file:`
dependencies naming a private sibling, so the private package is available while the
package is built and absent from what is published. Both run on the runner only; the
source files in the repository are never modified.

## Running a Release

From the package directory:

```sh
cd packages/bridge-client
npm run release:patch   # or release:minor / release:major
```

This will release `core`, `bridge-protocol`, and `service-api`, then `bridge-client` --
each bumped by `patch`, each waiting for CI before proceeding. For a leaf package like `core` with no
local deps, only `core` itself is released.

### Releasing Everything That Changed

`scripts/release-all.js` releases the packages a release needs to include, rather than
all of them. From `packages/`:

```sh
npm run release:all:patch   # or release:all:minor / release:all:major
```

Membership is derived from the repository:

- a package with no release tag has never been published, and is included;
- a package whose directory differs between its latest release tag and HEAD is included;
- a package is included when a dependency it declares is going to a version the caret
  range published for it does not admit. A bump that range does admit needs no release
  of the dependent, because npm resolves it at install time. Note that on a `0.x`
  version a caret range is pinned to the minor component, so a `minor` bump of a `0.x`
  dependency does cascade to its dependents.

The bump level applies to every member and is the one part of a release that is chosen
rather than derived.

Add `--dry-run` to print the derived set, the reason for each member and the release
order, and exit without changing anything:

```sh
npm run release:all:patch -- --dry-run
```

### Bundled Apps

Bundled apps are `"private": true` and deployed from their build output, not published to
npm. Their tags trigger deploy workflows instead of publish workflows.

#### ecosim

`ecosim` uses `--skip-deps` so upstream packages are not published as a side effect:

```sh
cd apps/ecosim
npm run release:patch
```

This bumps `ecosim`'s version, commits, tags (`ecosim-v<version>`), and pushes. The tag
triggers the `deploy-ecosim` GitHub Actions workflow which builds and deploys to
S3/CloudFront.

#### vscode-bridge

`vscode-bridge` does NOT use `--skip-deps`, so releasing it also releases its upstream
dependencies first:

```sh
cd apps/vscode-bridge
npm run release:patch
```

The tag triggers `deploy-vscode-bridge`, which builds a Docker image, pushes it to GHCR,
and deploys to EC2 via SSH.

#### vscode-extension

`vscode-extension` uses `--skip-deps` because esbuild bundles all local dependencies into
`dist/extension.js` -- upstream packages do not need to be published to npm:

```sh
cd apps/vscode-extension
npm run release:patch
```

The tag triggers `deploy-vscode-extension`, which builds the extension and publishes it
to the VS Code Marketplace via `vsce`.

### Prerequisites

- **Clean working tree** -- the script aborts if there are uncommitted changes.
- **GitHub CLI (`gh`)** -- required to watch CI workflow runs. Install with
  `brew install gh` and authenticate with `gh auth login`.

### Failure Recovery

If a CI workflow fails mid-chain, the script stops. The packages that already succeeded
are published on npm with their new versions. Fix the issue and re-run.

`release-all.js` resumes correctly: the packages that already released match their new
tags, so the next run leaves them out and picks up where it stopped. `release.js`
releases the chain it is given and will bump an already-released package again; release
the remaining packages individually to avoid a no-op bump.

## Versioning Policy

This repo follows semantic versioning:

- `patch` -- bug fixes, no API changes
- `minor` -- new backwards-compatible features
- `major` -- breaking API changes
