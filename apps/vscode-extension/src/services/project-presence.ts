import * as vscode from "vscode";
import { setWendooEnabled } from "../state/context";
import { WENDOO_JSON } from "../wendoo-json";
import { findProjectFolderCandidates } from "./folder-target-resolver";

/**
 * Keep the `wendoo.enabled` context key aligned with project presence: enabled
 * while at least one workspace folder carries a root `wendoo.json`, disabled
 * otherwise. Recomputes when workspace folders change and when a `wendoo.json`
 * is created or deleted anywhere in the workspace (non-root manifests, such as
 * those inside a materialized `.libraries` tree, trigger a recompute that
 * leaves the key unchanged). Resolves once the initial state is applied;
 * listeners are disposed with `context`.
 */
export async function trackWorkspaceProjectPresence(context: vscode.ExtensionContext): Promise<void> {
  let generation = 0;
  const refresh = async (): Promise<void> => {
    const ticket = ++generation;
    const hasProject = (await findProjectFolderCandidates()).length > 0;
    // A refresh that lost the race to a newer event leaves the key to that
    // newer refresh, so the key always reflects the latest workspace state.
    if (ticket === generation) {
      await setWendooEnabled(hasProject);
    }
  };
  const watcher = vscode.workspace.createFileSystemWatcher(`**/${WENDOO_JSON}`);
  context.subscriptions.push(
    watcher,
    watcher.onDidCreate(() => {
      void refresh();
    }),
    watcher.onDidDelete(() => {
      void refresh();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void refresh();
    })
  );
  await refresh();
}
