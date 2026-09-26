import * as vscode from "vscode";
import { registerCommands } from "../commands";
import { BuildMembershipCodeLensProvider } from "../providers/build-membership-codelens-provider";
import { BuildMembershipDecorationProvider } from "../providers/build-membership-decoration-provider";
import { WendooJsonCodeLensProvider } from "../providers/wendoo-json-codelens-provider";
import { setWendooEnabled } from "../state/context";
import { createStatusBarItem } from "../ui/statusBar";
import { WendooSessionsProvider } from "../views/wendooSessionsProvider";
import { ProjectManager } from "./project-manager";
import type { ProjectSession } from "./project-session";
import { WENDOO_SCHEME } from "./wendoo-fs-provider";

/**
 * Activate bridge mode: the virtual `wendoo:` filesystem mirroring a
 * remote app over the websocket relay, with its sessions view, status bar,
 * and commands.
 */
export function activateBridgeSession(context: vscode.ExtensionContext): ProjectSession {
  const projectManager = new ProjectManager();

  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider(WENDOO_SCHEME, projectManager.fsProvider, {
      isCaseSensitive: true,
    }),
    vscode.window.registerFileDecorationProvider(projectManager.fsProvider),
    vscode.window.registerFileDecorationProvider(
      new BuildMembershipDecorationProvider(WENDOO_SCHEME, projectManager.buildMembership)
    ),
    vscode.languages.registerCodeLensProvider(
      { scheme: WENDOO_SCHEME, pattern: "**/wendoo.json" },
      new WendooJsonCodeLensProvider(projectManager.fsProvider)
    ),
    vscode.languages.registerCodeLensProvider(
      { scheme: WENDOO_SCHEME },
      new BuildMembershipCodeLensProvider(projectManager.buildMembership)
    )
  );

  const sessionsProvider = new WendooSessionsProvider(projectManager);
  const treeView = vscode.window.createTreeView("wendoo.sessions", {
    treeDataProvider: sessionsProvider,
  });

  registerCommands(context, projectManager);
  createStatusBarItem(context, projectManager);

  context.subscriptions.push(
    projectManager.onDidChangePaired(async (paired) => {
      if (paired && !treeView.visible) {
        await setWendooEnabled(true);
        vscode.commands.executeCommand("wendoo.sessions.focus");
      }
    })
  );

  projectManager.initialize(context.globalState);

  context.subscriptions.push(treeView, projectManager);
  return projectManager;
}
