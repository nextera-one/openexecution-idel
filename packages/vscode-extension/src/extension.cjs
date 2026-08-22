const vscode = require("vscode");
const { spawn } = require("node:child_process");
const { existsSync, readFileSync, readdirSync } = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const VIEW_TYPE = "openexecutionIdel.terminalView";
const DEFAULT_PORT = 7878;
const STARTUP_TIMEOUT_MS = 20000;

let manager;
let output;
let panel;

function activate(context) {
  output = vscode.window.createOutputChannel("OpenExecution IDEL");
  manager = new IdelServerManager(context, output);

  const provider = new IdelTerminalViewProvider(context, manager, output);
  context.subscriptions.push(
    output,
    manager,
    vscode.window.registerWebviewViewProvider(VIEW_TYPE, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("openexecutionIdel.openTerminal", async () => {
      await openTerminalPanel(manager, output);
    }),
    vscode.commands.registerCommand("openexecutionIdel.startServer", async () => {
      const url = await manager.ensureServer();
      vscode.window.showInformationMessage(`IDEL server ready at ${url.origin}`);
      await provider.refresh();
    }),
    vscode.commands.registerCommand("openexecutionIdel.stopServer", async () => {
      const stopped = await manager.stop();
      vscode.window.showInformationMessage(
        stopped ? "IDEL server stopped." : "No IDEL server was started by this extension.",
      );
      await provider.refresh({ allowStart: false });
      if (panel) {
        await renderTerminalWebview(panel.webview, manager, output, { allowStart: false });
      }
    }),
    vscode.commands.registerCommand("openexecutionIdel.openInBrowser", async () => {
      const terminalUrl = await manager.ensureTerminalUrl();
      const externalUri = await vscode.env.asExternalUri(vscode.Uri.parse(terminalUrl.toString()));
      await vscode.env.openExternal(externalUri);
    }),
  );
}

async function openTerminalPanel(serverManager, out) {
  if (panel) {
    panel.reveal(vscode.ViewColumn.Active);
  } else {
    panel = vscode.window.createWebviewPanel(
      "openexecutionIdel.terminal",
      "IDEL Terminal",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      },
    );
    const createdPanel = panel;
    createdPanel.onDidDispose(() => {
      panel = undefined;
    });
    createdPanel.webview.onDidReceiveMessage(async (message) => {
      await handleWebviewMessage(message, createdPanel.webview, serverManager, out);
    });
  }

  await renderTerminalWebview(panel.webview, serverManager, out);
}

class IdelTerminalViewProvider {
  constructor(context, serverManager, out) {
    this.context = context;
    this.serverManager = serverManager;
    this.output = out;
    this.view = undefined;
  }

  async resolveWebviewView(webviewView) {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
    };
    webviewView.webview.onDidReceiveMessage(async (message) => {
      await handleWebviewMessage(message, webviewView.webview, this.serverManager, this.output);
    });
    await this.refresh();
  }

  async refresh(options = {}) {
    if (!this.view) return;
    await renderTerminalWebview(this.view.webview, this.serverManager, this.output, options);
  }
}

class IdelServerManager {
  constructor(context, out) {
    this.context = context;
    this.output = out;
    this.child = undefined;
    this.managedUrl = undefined;
  }

  dispose() {
    void this.stop();
  }

  async ensureTerminalUrl(options = {}) {
    const baseUrl = await this.ensureServer(options);
    const terminalUrl = new URL("/terminal.html", baseUrl);
    if (!(await isHttpOk(terminalUrl))) {
      throw new Error(
        `IDEL server is reachable at ${baseUrl.origin}, but /terminal.html is not available. Start it with \`idel serve --static packages/web/public\`.`,
      );
    }
    return terminalUrl;
  }

  async ensureServer(options = {}) {
    const config = readConfig(this.context.extensionPath);
    if (config.serverUrl) {
      await assertHealthy(config.serverUrl);
      return config.serverUrl;
    }

    if (this.managedUrl && (await isHealthy(this.managedUrl))) {
      return this.managedUrl;
    }

    const defaultUrl = new URL(`http://127.0.0.1:${config.port}`);
    if (await isHealthy(defaultUrl)) {
      return defaultUrl;
    }

    if (options.allowStart === false) {
      throw new Error("IDEL server is stopped. Use Start Server to launch the embedded terminal.");
    }

    if (!config.manageServer) {
      throw new Error(
        "No IDEL server is reachable. Start `idel serve --static packages/web/public`, set openexecutionIdel.serverUrl, or enable openexecutionIdel.manageServer.",
      );
    }

    return await this.startManagedServer(config);
  }

  async startManagedServer(config) {
    if (this.child) {
      await this.stop();
    }

    const root = findIdelRoot(config.sourceRoot, this.context.extensionPath);
    const idelBin = path.join(root, "packages", "cli", "bin", "idel.js");
    const staticDir = path.join(root, "packages", "web", "public");
    const cliDist = path.join(root, "packages", "cli", "dist", "main.js");
    if (!existsSync(idelBin)) {
      throw new Error(`Could not find IDEL CLI at ${idelBin}. Set openexecutionIdel.sourceRoot to the checkout root.`);
    }
    if (!existsSync(staticDir)) {
      throw new Error(`Could not find IDEL web assets at ${staticDir}. Set openexecutionIdel.sourceRoot to the checkout root.`);
    }
    if (!existsSync(cliDist)) {
      throw new Error(
        `IDEL is not built yet. Run \`pnpm build\` in ${root}, then run "IDEL: Start Local Server" again.`,
      );
    }
    if (!config.nodePath) {
      throw new Error(
        "Node.js was not found. Install Node.js >=22.3, set openexecutionIdel.nodePath to the full node executable path, or reinstall with scripts/install-vscode-extension.sh from a shell where `node` works.",
      );
    }

    const args = [
      idelBin,
      "serve",
      "--static",
      staticDir,
      "--port",
      String(config.port),
    ];
    if (config.enableNativeTerminal) {
      args.push("--enable-native-terminal");
    }
    args.push(...config.extraServeArgs);

    this.output.appendLine(`Starting IDEL server: ${config.nodePath} ${args.map(shellQuote).join(" ")}`);
    const child = spawn(config.nodePath, args, {
      cwd: root,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    this.child = child;

    const url = await new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        finish(new Error("IDEL server did not become ready within 20 seconds."));
      }, STARTUP_TIMEOUT_MS);

      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.stdout.off("data", onStdout);
        child.stderr.off("data", onStderr);
        child.off("error", onError);
        child.off("exit", onExitBeforeReady);
        if (result instanceof Error) reject(result);
        else resolve(result);
      };

      const onStdout = (chunk) => {
        const text = chunk.toString();
        this.output.append(text);
        const match = text.match(/listening on (http:\/\/[^\s]+)/);
        if (match && match[1]) {
          finish(new URL(match[1]));
        }
      };
      const onStderr = (chunk) => {
        this.output.append(chunk.toString());
      };
      const onError = (err) => {
        finish(err);
      };
      const onExitBeforeReady = (code, signal) => {
        finish(new Error(`IDEL server exited before startup (${signal || code || "unknown"}).`));
      };

      child.stdout.on("data", onStdout);
      child.stderr.on("data", onStderr);
      child.on("error", onError);
      child.on("exit", onExitBeforeReady);
    }).catch((err) => {
      if (this.child === child) {
        this.child = undefined;
      }
      child.kill("SIGTERM");
      throw err;
    });

    child.stdout.on("data", (chunk) => this.output.append(chunk.toString()));
    child.stderr.on("data", (chunk) => this.output.append(chunk.toString()));
    child.on("exit", (code, signal) => {
      if (this.child === child) {
        this.child = undefined;
        this.managedUrl = undefined;
      }
      this.output.appendLine(`IDEL server exited (${signal || code || "unknown"}).`);
    });

    this.managedUrl = url;
    return url;
  }

  async stop() {
    if (!this.child) {
      this.managedUrl = undefined;
      return false;
    }

    const child = this.child;
    this.child = undefined;
    this.managedUrl = undefined;

    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 3000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill("SIGTERM");
    });
    return true;
  }
}

async function renderTerminalWebview(webview, serverManager, out, options = {}) {
  try {
    const terminalUrl = await serverManager.ensureTerminalUrl(options);
    const externalUri = await vscode.env.asExternalUri(vscode.Uri.parse(terminalUrl.toString()));
    webview.html = terminalHtml(webview, externalUri.toString(), terminalUrl.toString());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    out.appendLine(`IDEL webview error: ${message}`);
    webview.html = errorHtml(message);
  }
}

async function handleWebviewMessage(message, webview, serverManager, out) {
  if (!message || typeof message.command !== "string") return;
  if (message.command === "refresh") {
    await renderTerminalWebview(webview, serverManager, out);
  } else if (message.command === "start") {
    await renderTerminalWebview(webview, serverManager, out);
  } else if (message.command === "stop") {
    await serverManager.stop();
    await renderTerminalWebview(webview, serverManager, out, { allowStart: false });
  } else if (message.command === "browser") {
    const terminalUrl = await serverManager.ensureTerminalUrl();
    const externalUri = await vscode.env.asExternalUri(vscode.Uri.parse(terminalUrl.toString()));
    await vscode.env.openExternal(externalUri);
  } else if (message.command === "logs") {
    out.show();
  }
}

function terminalHtml(webview, frameUrl, displayUrl) {
  const nonce = getNonce();
  const origin = new URL(frameUrl).origin;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${escapeAttribute(origin)}; img-src ${webview.cspSource} data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>IDEL Terminal</title>
  <style>
    html, body { width: 100%; height: 100%; padding: 0; margin: 0; overflow: hidden; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); }
    .shell { display: grid; grid-template-rows: minmax(0, 1fr) auto; width: 100%; height: 100vh; }
    iframe { width: 100%; height: 100%; border: 0; background: var(--vscode-editor-background); }
    .bar { display: flex; align-items: center; gap: 8px; min-height: 28px; padding: 4px 8px; border-top: 1px solid var(--vscode-panel-border); background: var(--vscode-sideBar-background); font: 12px var(--vscode-font-family); box-sizing: border-box; }
    .status { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: 0.82; }
    button { height: 22px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 3px; padding: 0 8px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); font: 12px var(--vscode-font-family); cursor: pointer; }
    button:hover { background: var(--vscode-button-hoverBackground); }
  </style>
</head>
<body>
  <div class="shell">
    <iframe
      title="OpenExecution IDEL Terminal"
      src="${escapeAttribute(frameUrl)}"
      sandbox="allow-downloads allow-forms allow-modals allow-popups allow-same-origin allow-scripts"
      allow="clipboard-read; clipboard-write"
    ></iframe>
    <div class="bar">
      <span class="status">${escapeHtml(displayUrl)}</span>
      <button type="button" data-command="refresh">Reload</button>
      <button type="button" data-command="stop">Stop</button>
      <button type="button" data-command="browser">Browser</button>
      <button type="button" data-command="logs">Logs</button>
    </div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-command]");
      if (!button) return;
      vscode.postMessage({ command: button.dataset.command });
    });
  </script>
</body>
</html>`;
}

function errorHtml(message) {
  const nonce = getNonce();
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>IDEL Terminal</title>
  <style>
    html, body { width: 100%; height: 100%; padding: 0; margin: 0; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); }
    main { box-sizing: border-box; max-width: 720px; padding: 24px; font: 13px/1.5 var(--vscode-font-family); }
    h1 { margin: 0 0 12px; font-size: 18px; font-weight: 600; }
    p { margin: 0 0 12px; }
    code { font-family: var(--vscode-editor-font-family); color: var(--vscode-textPreformat-foreground); }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 18px; }
    button { min-height: 28px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 3px; padding: 0 10px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); font: 12px var(--vscode-font-family); cursor: pointer; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    .secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    .secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  </style>
</head>
<body>
  <main>
    <h1>IDEL terminal is not ready</h1>
    <p>${escapeHtml(message)}</p>
    <p>Build this checkout with <code>pnpm build</code>, then start the embedded terminal again. If you already run <code>idel serve</code>, set <code>openexecutionIdel.serverUrl</code> to that local URL.</p>
    <div class="actions">
      <button type="button" data-command="start">Start Server</button>
      <button class="secondary" type="button" data-command="refresh">Retry</button>
      <button class="secondary" type="button" data-command="logs">Logs</button>
    </div>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-command]");
      if (!button) return;
      vscode.postMessage({ command: button.dataset.command });
    });
  </script>
</body>
</html>`;
}

function readConfig(extensionPath) {
  const cfg = vscode.workspace.getConfiguration("openexecutionIdel");
  const rawServerUrl = String(cfg.get("serverUrl", "") || "").trim();
  const configuredNode = String(cfg.get("nodePath", "") || "").trim();
  return {
    serverUrl: rawServerUrl ? normalizeBaseUrl(rawServerUrl) : undefined,
    manageServer: Boolean(cfg.get("manageServer", true)),
    port: normalizePort(cfg.get("port", DEFAULT_PORT)),
    sourceRoot: String(cfg.get("sourceRoot", "") || "").trim(),
    nodePath:
      configuredNode ||
      process.env.IDEL_NODE_BIN ||
      readInstalledNodePath(extensionPath) ||
      findNodeExecutable(),
    enableNativeTerminal: Boolean(cfg.get("enableNativeTerminal", true)),
    extraServeArgs: normalizeStringArray(cfg.get("extraServeArgs", [])),
  };
}

function readInstalledNodePath(extensionPath) {
  try {
    const raw = readFileSync(path.join(extensionPath, "node-path.json"), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.nodePath === "string" && parsed.nodePath && existsSync(parsed.nodePath)) {
      return parsed.nodePath;
    }
  } catch {
    // Optional installer hint.
  }
  return undefined;
}

function findNodeExecutable() {
  return (
    findExecutableOnPath() ||
    firstExisting(commonNodeCandidates()) ||
    undefined
  );
}

function findExecutableOnPath() {
  const names = process.platform === "win32" ? ["node.exe", "nodejs.exe"] : ["node", "nodejs"];
  const pathValue = process.env.PATH || "";
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

function commonNodeCandidates() {
  const home = os.homedir();
  if (process.platform === "win32") {
    return [
      process.env.NVM_SYMLINK && path.join(process.env.NVM_SYMLINK, "node.exe"),
      process.env.NVM_HOME && path.join(process.env.NVM_HOME, "current", "node.exe"),
      process.env.ProgramFiles && path.join(process.env.ProgramFiles, "nodejs", "node.exe"),
      process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"], "nodejs", "node.exe"),
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "nodejs", "node.exe"),
      home && path.join(home, "AppData", "Roaming", "nvm", "current", "node.exe"),
    ];
  }

  return [
    newestVersionedNode(path.join(home, ".nvm", "versions", "node"), "bin/node"),
    newestVersionedNode(path.join(home, ".fnm", "node-versions"), "installation/bin/node"),
    newestVersionedNode(path.join(home, ".local", "share", "fnm", "node-versions"), "installation/bin/node"),
    path.join(home, ".volta", "bin", "node"),
    path.join(home, ".asdf", "shims", "node"),
    path.join(home, ".local", "share", "mise", "shims", "node"),
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    "/usr/bin/node",
    "/bin/node",
  ];
}

function newestVersionedNode(baseDir, relativeNodePath) {
  try {
    if (!existsSync(baseDir)) return undefined;
    const dirs = readdirSync(baseDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const dir of dirs) {
      const candidate = path.join(baseDir, dir, relativeNodePath);
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function firstExisting(candidates) {
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return undefined;
}

function normalizeBaseUrl(value) {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url;
}

function normalizePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    return DEFAULT_PORT;
  }
  return port;
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === "string");
}

function findIdelRoot(configuredRoot, extensionPath) {
  const candidates = [];
  if (configuredRoot) candidates.push(configuredRoot);
  for (const folder of vscode.workspace.workspaceFolders || []) {
    candidates.push(folder.uri.fsPath);
  }
  candidates.push(extensionPath);
  candidates.push(path.resolve(extensionPath, ".."));
  candidates.push(path.resolve(extensionPath, "..", ".."));

  for (const candidate of candidates) {
    const root = path.resolve(candidate);
    if (
      existsSync(path.join(root, "packages", "cli", "bin", "idel.js")) &&
      existsSync(path.join(root, "packages", "web", "public", "terminal.html"))
    ) {
      return root;
    }
  }

  return path.resolve(configuredRoot || path.resolve(extensionPath, "..", ".."));
}

async function assertHealthy(baseUrl) {
  if (!(await isHealthy(baseUrl))) {
    throw new Error(`IDEL server is not reachable at ${baseUrl.origin}.`);
  }
}

function isHealthy(baseUrl) {
  return isHttpOk(new URL("/api/health", baseUrl));
}

function isHttpOk(url) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 2000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });
}

function getNonce() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let i = 0; i < 32; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttribute(value) {
  return escapeHtml(value);
}

function shellQuote(value) {
  return /[^A-Za-z0-9_./:=+-]/.test(value) ? JSON.stringify(value) : value;
}

function deactivate() {
  if (manager) {
    return manager.stop();
  }
  return undefined;
}

module.exports = {
  activate,
  deactivate,
};
