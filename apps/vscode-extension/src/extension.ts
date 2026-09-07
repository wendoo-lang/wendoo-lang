import * as vscode from "vscode";
import {
  installTestTargetPick,
  installTestTargetUpdatePick,
  installTestTargetUpdateSpecificInput,
  registerFolderCommands,
} from "./commands/folder-commands";
import { activateBridgeSession } from "./services/bridge-session";
import {
  autoOpenFolderSessionOnActivation,
  disposeActiveFolderSession,
  folderSessionVolumeWriteForTest,
  hasFolderSessionHandshakeCompleted,
  isFolderSessionEditorOpen,
  registerFolderSessionSerializer,
  restoreFolderSessionForTest,
} from "./services/folder-session";
import { trackWorkspaceProjectPresence } from "./services/project-presence";
import type { RemovableVolumeRoot } from "./services/removable-volume";
import { installTestTargetAppTransport, testTargetAppTransportCalls } from "./services/target-app-cache-host";
import { targetRegistryEntries } from "./services/target-registry";
import { isWendooEnabled } from "./state/context";
import { ProjectActionsProvider } from "./views/projectActionsProvider";

export async function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand("wendoo.openSettings", () => {
      vscode.commands.executeCommand("workbench.action.openSettings", `@ext:${context.extension.id}`);
    })
  );
  // Mode is environment-keyed: the web UI runs bridge mode only, desktop runs
  // folder mode only. The context key gates command and view visibility.
  const isWebHost = vscode.env.uiKind === vscode.UIKind.Web;
  void vscode.commands.executeCommand("setContext", "wendoo.webHost", isWebHost);
  if (isWebHost) {
    activateBridgeSession(context);
    return;
  }
  registerFolderCommands(context);
  // Resolve the context the desktop view's when-clause reads -- enabled only
  // while a workspace folder carries a root wendoo.json -- before the view is
  // created, so the view's presence is correct the moment it registers on every
  // activation path -- including the onWebviewPanel restore path, where context
  // keys reset on window reload and the extension activates early to restore
  // the app tab. Awaiting removes the race where the Explorer evaluates the
  // when-clause while the context set is still in flight; view presence never
  // depends on reveal.
  await trackWorkspaceProjectPresence(context);
  const projectActionsProvider = new ProjectActionsProvider();
  const projectActionsView = vscode.window.createTreeView("wendoo.projectActions", {
    treeDataProvider: projectActionsProvider,
  });
  context.subscriptions.push(projectActionsView);
  context.subscriptions.push(registerFolderSessionSerializer(context));
  // Expansion is a one-time convenience; view presence follows the when-clause.
  void expandProjectActionsViewOnFirstRender(context, projectActionsProvider, projectActionsView);
  // Test-only hooks for integration harnesses.
  context.subscriptions.push(
    vscode.commands.registerCommand("wendoo.testHooks.folderSessionHandshakeCompleted", () =>
      hasFolderSessionHandshakeCompleted()
    ),
    vscode.commands.registerCommand("wendoo.testHooks.desktopViewState", () => ({
      enabled: isWendooEnabled(),
      viewVisible: projectActionsView.visible,
    })),
    vscode.commands.registerCommand("wendoo.testHooks.folderEditorOpen", () => isFolderSessionEditorOpen()),
    vscode.commands.registerCommand(
      "wendoo.testHooks.folderVolumeWrite",
      (payload: unknown, mountRoots?: readonly RemovableVolumeRoot[]) =>
        folderSessionVolumeWriteForTest(payload, mountRoots)
    ),
    vscode.commands.registerCommand(
      "wendoo.testHooks.installTargetAppTransport",
      (files?: Record<string, string | { readonly file: string }>, versions?: readonly string[]) =>
        installTestTargetAppTransport(files, versions)
    ),
    vscode.commands.registerCommand("wendoo.testHooks.installTargetPick", (coordinate?: string) =>
      installTestTargetPick(coordinate)
    ),
    vscode.commands.registerCommand("wendoo.testHooks.installTargetUpdatePick", (kind?: string) =>
      installTestTargetUpdatePick(kind as "approved" | "published" | "specific" | undefined)
    ),
    vscode.commands.registerCommand("wendoo.testHooks.installTargetUpdateSpecificInput", (value?: string) =>
      installTestTargetUpdateSpecificInput(value)
    ),
    vscode.commands.registerCommand("wendoo.testHooks.targetRegistryEntries", () => targetRegistryEntries()),
    vscode.commands.registerCommand("wendoo.testHooks.targetAppTransportCalls", () => testTargetAppTransportCalls()),
    vscode.commands.registerCommand("wendoo.testHooks.disposeFolderSession", () => disposeActiveFolderSession()),
    vscode.commands.registerCommand("wendoo.testHooks.restoreFolderSession", () =>
      restoreFolderSessionForTest(context)
    ),
    vscode.commands.registerCommand("wendoo.testHooks.autoOpenFolderSession", () =>
      autoOpenFolderSessionOnActivation(context)
    )
  );
  // Auto-open the hosted editor for a single-project workspace. Runs after the
  // serializer registration so a restored tab from the previous window wins.
  void autoOpenFolderSessionOnActivation(context);
}

export function deactivate() {}

const PROJECT_ACTIONS_VIEW_EXPANDED_KEY = "wendoo.projectActionsViewExpanded";

/**
 * Expands the project actions view the first time it renders in a workspace.
 * The Explorer container starts contributed views collapsed regardless of the
 * declarative view visibility; a one-time reveal opens the view, after which
 * VS Code's persisted workspace view state carries the user's choice. Does
 * nothing while the view is hidden (no project in the workspace), leaving the
 * one-time expansion for an activation that shows the view.
 */
async function expandProjectActionsViewOnFirstRender(
  context: vscode.ExtensionContext,
  provider: ProjectActionsProvider,
  view: vscode.TreeView<vscode.TreeItem>
): Promise<void> {
  if (!isWendooEnabled() || context.workspaceState.get(PROJECT_ACTIONS_VIEW_EXPANDED_KEY)) {
    return;
  }
  await context.workspaceState.update(PROJECT_ACTIONS_VIEW_EXPANDED_KEY, true);
  await view.reveal(provider.getChildren()[0], { select: false, focus: false });
}
