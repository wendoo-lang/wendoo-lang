<div align="center">
  <a href="https://wendoo.com"><img src="https://raw.githubusercontent.com/wendoo-lang/wendoo-lang/main/branding/wendoo-banner.png" alt="Wendoo" width="100%"></a>
</div>

**Wendoo** is a tile-based programming language for creative coding applications. Programs are built by arranging **tiles** -- typed, composable tokens -- into **rules**. A collection of rules forms a **brain**, which drives the behavior of systems ranging from video game characters to physical devices like robots.

<div align="center">
  <img src="https://raw.githubusercontent.com/wendoo-lang/wendoo-lang/main/assets/rule.png" alt="Brain Rule" width="80%">
</div>

## What This Extension Does

This extension lets you **author custom brain tiles in TypeScript** and use them in a live Wendoo app. It runs in both [VS Code for the Web](https://vscode.dev) and VS Code desktop, with a workflow suited to each:

- **In the browser (vscode.dev):** pair VS Code with a Wendoo app running in another browser tab. A bridge connects the two -- edit a tile source file, save it, and the tile is available in the brain editor immediately. No install, no local toolchain.
- **On desktop:** work with Wendoo projects as regular folders on disk. The extension hosts the project's Wendoo app in an editor tab, and everything -- brains, tiles, project settings -- saves to your project folder. Projects work offline and are ready for version control.

_Example: Authoring a "teleport" actuator in TypeScript:_
<div align="center">
  <img src="https://raw.githubusercontent.com/wendoo-lang/wendoo-lang/main/assets/vscode.png" alt="Coding in TypeScript" width="80%">
</div>

## Getting Started in the Browser

1. Open [vscode.dev](https://vscode.dev) and install the **Wendoo** extension.
2. Launch your Wendoo app and enable the VS Code Bridge. Make note of the generated **join code**.
3. In VS Code, open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and run **Wendoo: Connect**, entering your join code.
4. Scaffold a new tile with **Wendoo: Create New Sensor** or **Wendoo: Create New Actuator**.
5. Edit the generated TypeScript file -- save it and the tile is instantly available in the brain editor.

Once your editor is paired to your app, the connection persists and reconnects automatically. A new join code is only needed if either side is manually disconnected.

## Getting Started on Desktop

On desktop, the extension hosts a Wendoo app inside a VS Code editor tab. Which app it hosts is the platform target the project declares in its `wendoo.json`, fetched from the published target registry -- so an existing project opens and runs with no extra setup.

1. Open the folder you want the project to live in.
2. Run **Wendoo: New Project** and pick a target from the list (or **Wendoo: Open Project Folder** for an existing project).
3. The Wendoo editor opens in a tab. Brains you build there and tiles you author in TypeScript all save to the project folder.
4. Use the **Wendoo** panel in the Explorer sidebar for the common actions: create a sensor, create an actuator, open the editor, open settings. Closing the editor tab is fine -- **Wendoo: Open Editor** brings it back.
5. Run **Wendoo: Update Target** to move the project to the latest published build of its target.

New projects include a generated `tsconfig.json` and a `.libraries` folder so tile sources get full type information and error checking in the editor, plus a `.gitignore` that keeps the generated files out of version control.

### Hosting a local or specific target build

You normally do not set the hosted app by hand -- it follows the project's declared target. To override it, set `wendoo.devTarget`. This is the setup for authoring a target app itself (host a local, unpublished build) or pinning a project to a specific published build:

```json
"wendoo.devTarget": {
  "appPath": "/path/to/the/target/app/dist"
}
```

Use `appPath` for a local build's `dist` directory, or `appRef` (`<owner>/<repo>@<ref>`) for a published build. The override's optional `extensions` and `targets` entries are seeded into new projects you create.

### Flashing a Device

For targets whose hardware is programmed by copying a firmware file to a USB drive -- the micro:bit and its `MICROBIT` drive, for example -- each brain has a **Flash** action in the Wendoo editor. Plug the device in, click Flash, and the compiled program is written to the drive. Flashing from desktop VS Code is currently supported on macOS and Linux; Windows support is not yet available (use the browser app to flash on Windows).

## Commands

| Command | Where | Description |
|---|---|---|
| `Wendoo: Connect` | Web | Connect to a running Wendoo app with a join code |
| `Wendoo: Disconnect` | Web | Disconnect from the current session |
| `Wendoo: Show` | Web | Open the Wendoo panel, prompting to connect if needed |
| `Wendoo: Hide` | Web | Hide the Wendoo panel |
| `Wendoo: Sync Files` | Web | Re-sync workspace files with the connected app |
| `Wendoo: Unlock wendoo.json for Editing` | Web | Allow direct edits to the project manifest |
| `Wendoo: New Project` | Desktop | Create a Wendoo project in a workspace folder and open the editor |
| `Wendoo: Import Project` | Desktop | Seed an empty workspace folder from a `.wendoo` export and open the editor |
| `Wendoo: Open Project Folder` | Desktop | Open the editor for an existing project folder |
| `Wendoo: Open Editor` | Desktop | Bring the Wendoo editor tab to front, reopening it if closed |
| `Wendoo: Update Target` | Desktop | Move the project to the latest published build of its target app |
| `Wendoo: Create New Sensor` | Both | Scaffold a new, empty sensor tile |
| `Wendoo: Create New Actuator` | Both | Scaffold a new, empty actuator tile |
| `Wendoo: Open Settings` | Both | Open VS Code Settings filtered to Wendoo options |

## Settings

| Setting | Where | Description |
|---|---|---|
| `wendoo.bridgeUrl` | Web | URL of the bridge service used to pair with a running app |
| `wendoo.devTarget` | Desktop | Author override of the hosted target app -- a local build (`appPath`) or a pinned published build (`appRef`) -- plus optional library and platform-target seeds for new projects |

## Learn More

- [wendoo.com](https://wendoo.com) -- the language's home
- [Source on GitHub](https://github.com/wendoo-lang/wendoo-lang) -- report issues and contribute
