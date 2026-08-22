# OpenExecution IDEL Terminal for VS Code

This extension embeds the existing OpenExecution IDEL web terminal in VS Code.
It starts or reuses `idel serve`, then loads `/terminal.html` in a VS Code
webview.

## Commands

- `IDEL: Open Terminal` opens the terminal in an editor panel.
- `IDEL: Start Local Server` starts `idel serve`.
- `IDEL: Stop Local Server` stops the server started by this extension.
- `IDEL: Open Terminal in Browser` opens the same terminal URL externally.

The extension also contributes an `IDEL` activity-bar view.

## Development

From the repository root:

```sh
pnpm install
pnpm build
cd packages/vscode-extension
npm run check
```

Then open `packages/vscode-extension` in VS Code and run the `Extension
Development Host`.

By default the extension auto-detects the repository root and starts:

```sh
node packages/cli/bin/idel.js serve --static packages/web/public --port 7878
```

Raw native shell tabs are disabled by default because they bypass IDEL command
policy. Enable `openexecutionIdel.enableNativeTerminal` only when you need them.

If you already run the server yourself, set `openexecutionIdel.serverUrl` to the
local URL, for example `http://127.0.0.1:7878`.

## Local Install

From the repository root:

```sh
scripts/install-vscode-extension.sh
```

On macOS, double-click or run:

```sh
scripts/install-vscode-extension-macos.command
```

On Windows:

```bat
scripts\install-vscode-extension.bat
```

To uninstall:

```sh
scripts/uninstall-vscode-extension.sh
```

On macOS:

```sh
scripts/uninstall-vscode-extension-macos.command
```

On Windows:

```bat
scripts\uninstall-vscode-extension.bat
```

The scripts install the unpacked extension into the default VS Code extension
folder and write the detected Node executable path into `node-path.json`. Set
`VSCODE_EXTENSIONS_DIR` first if you use Insiders, VSCodium, or a custom
extensions directory.

If the terminal shows `spawn node ENOENT`, VS Code cannot find Node from its GUI
environment. Re-run the installer from a shell where `node` works, or set
`openexecutionIdel.nodePath` to the full Node executable path.
