# OpenExecution IDEL for VS Code

This extension provides native `.idel` editing and embeds the existing
OpenExecution IDEL web terminal in VS Code.

## IDEL Structure editing

- TextMate coloring for headers, lowercase dotted commands and enums,
  `snake_case` fields, constructors, strings, comments, and typed literals.
- Live parser diagnostics with stable IDEL error codes.
- Autocomplete snippets for registered commands, fields, constructors, and
  enums.
- Hover documentation from the shared IDEL Structure language registry.
- Comment-preserving document formatting through the shared Structure formatter.
- `IDEL: Validate Structure` for an explicit validation pass.
- IDELProxy-aware completion and hover help for `proxy.idel` listeners,
  redirects, host/path matching, routes, NexRun discovery, load balancing,
  health checks, failover, timeouts, limits, authority, and evidence policy.

The installed extension includes the same `@openexecution/structure` parser
used by the CLI. Quoted external values preserve their case; native IDEL
identifiers are lowercase.

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
node packages/cli/bin/idel.js serve --static packages/web/public --port 7878 --enable-native-terminal
```

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

The scripts build-install the unpacked extension and IDEL Structure runtime
into the default VS Code extension folder and write the detected Node executable
path into `node-path.json`. Set
`VSCODE_EXTENSIONS_DIR` first if you use Insiders, VSCodium, or a custom
extensions directory.

If the terminal shows `spawn node ENOENT`, VS Code cannot find Node from its GUI
environment. Re-run the installer from a shell where `node` works, or set
`openexecutionIdel.nodePath` to the full Node executable path.
