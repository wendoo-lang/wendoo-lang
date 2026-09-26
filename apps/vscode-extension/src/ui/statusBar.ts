import type { ConnectionStatus } from "@wendoo/bridge-client";
import * as vscode from "vscode";
import type { ProjectManager } from "../services/project-manager";

export function createStatusBarItem(
  context: vscode.ExtensionContext,
  projectManager: ProjectManager
): vscode.StatusBarItem {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
  item.command = "wendoo.show";

  function update(): void {
    const status = projectManager.status;
    const pendingChanges = projectManager.pendingChanges;
    const workspaceFolderName = projectManager.workspaceFolderName;

    switch (status) {
      case "disconnected":
        item.text = "$(debug-disconnect) Wendoo: Disconnected";
        item.tooltip = "Not connected to bridge";
        item.backgroundColor = undefined;
        break;
      case "connecting":
        item.text = "$(sync~spin) Wendoo: Connecting...";
        item.tooltip = "Connecting to bridge";
        item.backgroundColor = undefined;
        break;
      case "reconnecting":
        item.text = "$(sync~spin) Wendoo: Reconnecting...";
        item.tooltip = "Reconnecting to bridge";
        item.backgroundColor = undefined;
        break;
      case "connected":
        if (projectManager.paired) {
          const counts = projectManager.diagnosticsManager.compileCounts;
          if (counts.errors > 0) {
            item.text = `$(error) Wendoo: ${counts.errors} error(s)`;
            item.tooltip = `${counts.errors} compilation error(s)`;
            item.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
          } else if (counts.warnings > 0) {
            item.text = `$(warning) Wendoo: ${counts.warnings} warning(s)`;
            item.tooltip = `${counts.warnings} compilation warning(s)`;
            item.backgroundColor = undefined;
          } else {
            item.text = "$(pass-filled) Wendoo: Connected";
            item.tooltip = "Connected to bridge and bound to app";
            item.backgroundColor = undefined;
          }
        } else if (projectManager.hasBindingToken) {
          item.text = `$(warning) Wendoo: Waiting for ${workspaceFolderName}`;
          item.tooltip =
            pendingChanges > 0
              ? `Waiting for ${workspaceFolderName} to reconnect. ${pendingChanges} unsent change(s) will sync on reconnect.`
              : `Waiting for ${workspaceFolderName} to reconnect.`;
          item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
        } else {
          item.text = "$(warning) Wendoo: No App";
          item.tooltip = "Connected to bridge but no app is bound";
          item.backgroundColor = undefined;
        }
        break;
    }
  }

  update();
  item.show();

  context.subscriptions.push(
    projectManager.onDidChangeStatus(update),
    projectManager.onDidChangePaired(update),
    projectManager.onDidChangePendingChanges(update),
    projectManager.diagnosticsManager.onDidChangeCounts(update),
    item
  );

  return item;
}
