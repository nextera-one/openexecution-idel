#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { chmod, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const packageJson = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
const DEFAULT_OUT = join(ROOT, "dist", "desktop");
const APP_NAME = "OpenExecution IDEL";
const APP_ID = "one.nextera.openexecution.idel";
const APP_VERSION = typeof packageJson.version === "string" ? packageJson.version : "0.0.0";

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  usage();
  process.exit(0);
}

resolveElectronBinary();
const outDir = resolve(ROOT, args.out ?? DEFAULT_OUT);
const platforms = platformList(args.platform ?? "all");
const staticDir = join(ROOT, "packages", "web", "public");
const idelBin = join(ROOT, "packages", "cli", "bin", "idel.js");
const idelDist = join(ROOT, "packages", "cli", "dist", "main.js");

if (!args.skipBuild) {
  runPnpm(["build"]);
}
runNodeScript(join(ROOT, "scripts", "sync-xterm-assets.mjs"));

if (!existsSync(idelBin) || !existsSync(idelDist)) {
  fail("desktop build requires the CLI build output; run `pnpm build` first.");
}
if (!existsSync(join(staticDir, "terminal.html"))) {
  fail(`desktop build could not find terminal assets at ${staticDir}`);
}

await mkdir(outDir, { recursive: true });
for (const platform of platforms) {
  await buildPlatform(platform, outDir, staticDir);
}

console.log(`desktop: built Electron ${platforms.join(", ")} into ${relative(outDir)}`);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") continue;
    else if (arg === "-h" || arg === "--help") out.help = true;
    else if (arg === "--skip-build") out.skipBuild = true;
    else if (arg === "--platform") out.platform = requiredValue(argv, ++i, arg);
    else if (arg.startsWith("--platform=")) out.platform = arg.slice("--platform=".length);
    else if (arg === "--out") out.out = requiredValue(argv, ++i, arg);
    else if (arg.startsWith("--out=")) out.out = arg.slice("--out=".length);
    else fail(`unknown option: ${arg}`);
  }
  return out;
}

function requiredValue(argv, index, flag) {
  const value = argv[index];
  if (!value) fail(`${flag} requires a value`);
  return value;
}

function usage() {
  console.log(`Usage: scripts/build-desktop.mjs [options]

Build repo-backed Electron desktop app folders for the IDEL terminal.

Options:
  --platform <all|linux|macos|windows>  Target platform set. Default: all.
  --out <dir>                           Output directory. Default: dist/desktop.
  --skip-build                          Do not run pnpm build first.
  -h, --help                            Show this help.

Output:
  dist/desktop/linux/openexecution-idel.sh + .desktop launcher
  dist/desktop/macos/OpenExecution IDEL.app
  dist/desktop/windows/OpenExecution IDEL.cmd

These launchers run the generated Electron app with the local Electron binary
from this checkout, start idel serve on loopback, and load the bundled terminal
UI in a desktop window.`);
}

function platformList(raw) {
  const value = String(raw).toLowerCase();
  if (value === "all") return ["linux", "macos", "windows"];
  if (value === "darwin" || value === "mac" || value === "macos") return ["macos"];
  if (value === "win" || value === "win32" || value === "windows") return ["windows"];
  if (value === "linux") return ["linux"];
  fail(`unsupported desktop platform: ${raw}`);
}

async function buildPlatform(platform, baseOut, sourceStaticDir) {
  const target = join(baseOut, platform);
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });

  if (platform === "macos") {
    await buildMacos(target, sourceStaticDir);
  } else {
    await buildElectronApp(join(target, "app"), sourceStaticDir, platform);
    await writeLauncher(target, platform);
    if (platform === "linux") await writeLinux(target);
    if (platform === "windows") await writeWindows(target);
  }
  await writeReadme(target, platform);
  console.log(`desktop: Electron ${platform} -> ${relative(target)}`);
}

async function buildMacos(target, sourceStaticDir) {
  const appRoot = join(target, `${APP_NAME}.app`);
  const contents = join(appRoot, "Contents");
  const resources = join(contents, "Resources");
  const macos = join(contents, "MacOS");
  await mkdir(resources, { recursive: true });
  await mkdir(macos, { recursive: true });
  await buildElectronApp(join(resources, "app"), sourceStaticDir, "macos");
  await writeLauncher(resources, "macos");
  await writeFile(join(contents, "Info.plist"), macInfoPlist(), "utf8");
  const executable = join(macos, "openexecution-idel");
  await writeFile(executable, macShell(), "utf8");
  await chmod(executable, 0o755);
}

async function buildElectronApp(appDir, sourceStaticDir, platform) {
  await mkdir(appDir, { recursive: true });
  await cp(sourceStaticDir, join(appDir, "web"), {
    recursive: true,
    force: true,
    dereference: true,
  });
  await writeFile(join(appDir, "package.json"), electronAppPackage(platform), "utf8");
  await writeFile(join(appDir, "main.mjs"), electronMainSource(), "utf8");
  await writeFile(join(appDir, "preload.mjs"), electronPreloadSource(), "utf8");
}

async function writeLauncher(target, platform) {
  const config = {
    appName: APP_NAME,
    sourceRoot: ROOT,
    idelBin,
    defaultPort: 7878,
    openPath: "/terminal.html",
    appDir: platform === "macos" ? join(target, "app") : join(target, "app"),
  };
  await writeFile(
    join(target, "launch-electron.mjs"),
    electronLauncherSource(config),
    "utf8",
  );
}

async function writeLinux(target) {
  const shPath = join(target, "openexecution-idel.sh");
  await writeFile(shPath, linuxShell(), "utf8");
  await chmod(shPath, 0o755);
  await writeFile(join(target, "openexecution-idel.desktop"), linuxDesktopEntry(shPath), "utf8");
}

async function writeWindows(target) {
  await writeFile(join(target, "OpenExecution IDEL.cmd"), windowsCmd(), "utf8");
  await writeFile(join(target, "OpenExecution IDEL.ps1"), windowsPowerShell(), "utf8");
}

async function writeReadme(target, platform) {
  await writeFile(
    join(target, "README.txt"),
    `${APP_NAME} Electron desktop launcher (${platform})

This is a repo-backed Electron app. It bundles the static terminal UI in the
generated app folder and starts the IDEL server from this checkout:

  ${ROOT}

Requirements:
  - This checkout remains available at the path above
  - The local Electron dev dependency remains installed

Runtime knobs:
  IDEL_DESKTOP_PORT=9000     use another local port
  IDEL_ELECTRON_BIN=/path    use a specific Electron executable

The launcher starts idel serve on loopback, then opens the bundled terminal UI
in an Electron desktop window. Commands still flow through the normal
safety/policy/OpenLogs runtime.
`,
    "utf8",
  );
}

function electronAppPackage(platform) {
  return JSON.stringify({
    name: "openexecution-idel-electron",
    version: APP_VERSION,
    private: true,
    type: "module",
    main: "main.mjs",
    productName: APP_NAME,
    description: `Electron desktop shell for ${APP_NAME} (${platform})`,
  }, null, 2) + "\n";
}

function electronLauncherSource(config) {
  return `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const CONFIG = ${JSON.stringify(config, null, 2)};
const rootRequire = createRequire(resolve(CONFIG.sourceRoot, "package.json"));
const electron = process.env.IDEL_ELECTRON_BIN || resolveElectronBinary();
const appDir = resolve(CONFIG.appDir);
const nodeBin = process.env.IDEL_NODE_BIN || process.execPath;
const passThrough = process.argv.slice(2).filter((arg) => arg !== "--");
let electronChild = null;
let serverChild = null;
let serverReady = false;

if (!existsSync(electron)) {
  console.error(CONFIG.appName + ": missing Electron executable at " + electron);
  console.error("Run pnpm install, or set IDEL_ELECTRON_BIN to an Electron executable.");
  process.exit(1);
}
if (!existsSync(appDir)) {
  console.error(CONFIG.appName + ": missing Electron app at " + appDir);
  process.exit(1);
}
if (!existsSync(CONFIG.idelBin)) {
  console.error(CONFIG.appName + ": missing idel binary at " + CONFIG.idelBin);
  process.exit(1);
}

startServer();

function startServer() {
  const serveArgs = [
    CONFIG.idelBin,
    "serve",
    "--static",
    resolve(appDir, "web"),
  ];
  if (!hasPort(passThrough)) serveArgs.push("--port", String(selectedPort(passThrough)));
  serveArgs.push(...passThrough);

  serverChild = spawn(nodeBin, serveArgs, {
    cwd: CONFIG.sourceRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });

  const startupTimer = setTimeout(() => {
    if (!serverReady) {
      console.error(CONFIG.appName + ": IDEL server did not become ready within 20 seconds.");
      stopServer();
      process.exit(1);
    }
  }, 20000);

  serverChild.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    process.stdout.write(text);
    const match = text.match(/listening on (http:\\/\\/[^\\s]+)/);
    if (match && !serverReady) {
      serverReady = true;
      clearTimeout(startupTimer);
      startElectron(new URL(CONFIG.openPath, match[1]).toString());
    }
  });
  serverChild.stderr.on("data", (chunk) => process.stderr.write(chunk));
  serverChild.on("error", (err) => {
    clearTimeout(startupTimer);
    console.error(CONFIG.appName + ": failed to start IDEL server: " + err.message);
    process.exit(1);
  });
  serverChild.on("exit", (code, signal) => {
    clearTimeout(startupTimer);
    serverChild = null;
    if (!serverReady) {
      console.error(CONFIG.appName + ": IDEL server exited before startup (" + (signal || code || "unknown") + ").");
      process.exit(code ?? 1);
    }
    if (electronChild) electronChild.kill("SIGTERM");
  });
}

function startElectron(url) {
  const electronEnv = {
    ...process.env,
    IDEL_NODE_BIN: nodeBin,
    IDEL_DESKTOP_URL: url,
  };
  delete electronEnv.ELECTRON_RUN_AS_NODE;
  delete electronEnv.ELECTRON_NO_ATTACH_CONSOLE;
  const electronArgs = [appDir];
  prepareLinuxDesktopEnvironment(electronEnv, electronArgs);

  electronChild = spawn(electron, electronArgs, {
    cwd: CONFIG.sourceRoot,
    env: electronEnv,
    stdio: "inherit",
    shell: false,
  });

  electronChild.on("exit", (code, signal) => {
    stopServer();
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 0);
  });
  electronChild.on("error", (err) => {
    console.error(CONFIG.appName + ": failed to start Electron: " + err.message);
    stopServer();
    process.exit(1);
  });
}

function prepareLinuxDesktopEnvironment(env, args) {
  if (process.platform !== "linux") return;

  // Launchers invoked from sandboxed/Snap editors can inherit private GTK and
  // schema paths that are incompatible with the checkout's Electron binary.
  const snapInjected = [
    env.GTK_PATH,
    env.GTK_EXE_PREFIX,
    env.GDK_PIXBUF_MODULEDIR,
    env.GDK_PIXBUF_MODULE_FILE,
    env.XDG_DATA_HOME,
  ].some((value) => typeof value === "string" && value.includes("/snap/"));
  if (snapInjected) {
    for (const key of [
      "GTK_PATH",
      "GTK_EXE_PREFIX",
      "GTK_MODULES",
      "GTK_IM_MODULE_FILE",
      "GDK_PIXBUF_MODULEDIR",
      "GDK_PIXBUF_MODULE_FILE",
      "XDG_DATA_HOME",
    ]) delete env[key];
    if (env.XDG_DATA_DIRS_VSCODE_SNAP_ORIG) {
      env.XDG_DATA_DIRS = env.XDG_DATA_DIRS_VSCODE_SNAP_ORIG;
    }
    if (env.XDG_CONFIG_DIRS_VSCODE_SNAP_ORIG) {
      env.XDG_CONFIG_DIRS = env.XDG_CONFIG_DIRS_VSCODE_SNAP_ORIG;
    }
  }

  // Electron/Chromium currently has a GNOME Wayland schema crash on affected
  // systems. Prefer the active XWayland bridge when one is available.
  const xAuthority = resolveXAuthority(env);
  if (env.DISPLAY && xAuthority) {
    env.XAUTHORITY = xAuthority;
    env.GDK_BACKEND = "x11";
    env.ELECTRON_OZONE_PLATFORM_HINT = "x11";
    delete env.WAYLAND_DISPLAY;
    args.unshift("--ozone-platform=x11");
  }
}

function resolveXAuthority(env) {
  if (env.XAUTHORITY && existsSync(env.XAUTHORITY)) return env.XAUTHORITY;
  const runtime = env.XDG_RUNTIME_DIR;
  if (!runtime || !existsSync(runtime)) return undefined;
  try {
    const file = readdirSync(runtime).find((name) => name.startsWith(".mutter-Xwaylandauth."));
    return file ? resolve(runtime, file) : undefined;
  } catch {
    return undefined;
  }
}

function stopServer() {
  if (!serverChild) return;
  const child = serverChild;
  serverChild = null;
  child.kill("SIGTERM");
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, 1500).unref();
}

function resolveElectronBinary() {
  try {
    const resolved = rootRequire("electron");
    if (typeof resolved === "string" && existsSync(resolved)) return resolved;
  } catch {
    /* handled below */
  }
  console.error(CONFIG.appName + ": Electron is not installed in " + CONFIG.sourceRoot);
  console.error("Run pnpm install, or set IDEL_ELECTRON_BIN to an Electron executable.");
  process.exit(1);
}

function selectedPort(argv) {
  const explicit = portFromArgs(argv);
  const envPort = numberFromString(process.env.IDEL_DESKTOP_PORT);
  return explicit ?? envPort ?? CONFIG.defaultPort;
}

function hasPort(argv) {
  return argv.some((arg) => arg === "--port" || arg.startsWith("--port="));
}

function portFromArgs(argv) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--port" && argv[i + 1]) return numberFromString(argv[i + 1]);
    if (arg.startsWith("--port=")) return numberFromString(arg.slice("--port=".length));
  }
  return undefined;
}

function numberFromString(value) {
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) return undefined;
  return parsed;
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopServer();
    if (electronChild) electronChild.kill(signal);
    else process.exit(0);
  });
}
`;
}

function electronMainSource() {
  const config = {
    appName: APP_NAME,
    sourceRoot: ROOT,
    idelBin,
    defaultPort: 7878,
    openPath: "/terminal.html",
  };
  return `import { app, BrowserWindow, Menu, dialog, shell } from "electron";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CONFIG = ${JSON.stringify(config, null, 2)};
const here = dirname(fileURLToPath(import.meta.url));
const staticDir = resolve(here, "web");
const desktopUrl = process.env.IDEL_DESKTOP_URL || "";
let mainWindow = null;
let server = null;
let serverReady = false;
let quitting = false;
let startupTimer = null;

app.setName(CONFIG.appName);
// Electron defaults to GTK 4 on recent GNOME releases. Some supported Linux
// desktops and inherited Snap environments expose incompatible GTK schemas;
// Electron documents GTK 3 as the compatibility fallback.
if (process.platform === "linux") app.commandLine.appendSwitch("gtk-version", "3");
app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => {
  quitting = true;
  stopServer();
});

// Register readiness without top-level await. Electron completes app startup
// only after the ESM entry module has evaluated; awaiting readiness at module
// scope therefore deadlocks before a renderer/window can be created.
void app.whenReady().then(startDesktop).catch((err) => {
  console.error(CONFIG.appName + ": desktop startup failed: " + err.message);
  app.quit();
});

function startDesktop() {
  Menu.setApplicationMenu(buildMenu());
  mainWindow = createWindow();
  loadStartupScreen();
  if (desktopUrl) {
    serverReady = true;
    void loadTerminal(desktopUrl);
  } else {
    startServer();
  }
}

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    mainWindow = createWindow();
    if (desktopUrl) void loadTerminal(desktopUrl);
    else if (serverReady) void loadTerminal("http://127.0.0.1:" + selectedPort() + CONFIG.openPath);
  }
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 940,
    minHeight: 620,
    title: CONFIG.appName,
    backgroundColor: "#0b0e14",
    webPreferences: {
      preload: resolve(here, "preload.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      devTools: process.env.IDEL_DESKTOP_DEVTOOLS === "1",
    },
  });
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\\/\\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!isTrustedNavigation(url)) event.preventDefault();
  });
  win.webContents.on("will-redirect", (event, url) => {
    if (!isTrustedNavigation(url)) event.preventDefault();
  });
  win.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    const clipboardPermission = permission === "clipboard-read" || permission === "clipboard-sanitized-write";
    callback(clipboardPermission && isTrustedNavigation(webContents.getURL()));
  });
  return win;
}

function isTrustedNavigation(value) {
  if (value.startsWith("data:text/html")) return true;
  try {
    const url = new URL(value);
    if (desktopUrl && url.origin === new URL(desktopUrl).origin) return true;
    return (url.protocol === "http:" || url.protocol === "https:") &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]");
  } catch {
    return false;
  }
}

function startServer() {
  if (!existsSync(CONFIG.idelBin)) {
    void showStartupError("Missing idel binary at " + CONFIG.idelBin);
    return;
  }
  if (!existsSync(staticDir)) {
    void showStartupError("Missing bundled web assets at " + staticDir);
    return;
  }

  const serveArgs = [
    CONFIG.idelBin,
    "serve",
    "--static",
    staticDir,
  ];
  const argv = userArgs();
  if (!hasPort(argv)) serveArgs.push("--port", String(selectedPort()));
  serveArgs.push(...argv);
  const nodeBin = process.env.IDEL_NODE_BIN || "node";

  startupTimer = setTimeout(() => {
    if (!serverReady) {
      void showStartupError("IDEL server did not become ready within 20 seconds. Node executable: " + nodeBin);
    }
  }, 20000);

  server = spawn(nodeBin, serveArgs, {
    cwd: CONFIG.sourceRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  server.stdout.on("data", (chunk) => handleServerOutput(chunk, "log"));
  server.stderr.on("data", (chunk) => handleServerOutput(chunk, "error"));
  server.on("error", (err) => {
    void showStartupError("Failed to start IDEL server: " + err.message);
  });
  server.on("exit", (code, signal) => {
    server = null;
    if (!quitting && !serverReady) {
      void showStartupError("IDEL server exited before startup (" + (signal || code || "unknown") + ").");
    }
  });
}

function handleServerOutput(chunk, level) {
  const text = chunk.toString();
  if (level === "error") console.error(text);
  else console.log(text);
  const match = text.match(/listening on (http:\\/\\/[^\\s]+)/);
  if (match && !serverReady) {
    serverReady = true;
    if (startupTimer) clearTimeout(startupTimer);
    startupTimer = null;
    void loadTerminal(new URL(CONFIG.openPath, match[1]).toString());
  }
}

function loadStartupScreen() {
  if (!mainWindow) return;
  const html = encodeURIComponent(\`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'" />
    <title>\${CONFIG.appName}</title>
    <style>
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: #0b0e14;
        color: #d7dce5;
        font: 14px system-ui, -apple-system, Segoe UI, sans-serif;
      }
      main {
        display: grid;
        gap: 0.55rem;
        text-align: center;
      }
      strong {
        color: #5cc8ff;
        font-size: 1rem;
      }
      span {
        color: #8b94a6;
      }
    </style>
  </head>
  <body>
    <main>
      <strong>Starting \${CONFIG.appName}</strong>
      <span>Opening the local IDEL runtime...</span>
    </main>
  </body>
</html>\`);
  void mainWindow.loadURL("data:text/html;charset=utf-8," + html);
}

async function loadTerminal(url) {
  if (!mainWindow) return;
  await mainWindow.loadURL(url);
}

async function showStartupError(message) {
  console.error(CONFIG.appName + ": " + message);
  await dialog.showMessageBox({
    type: "error",
    title: CONFIG.appName,
    message: "Could not start IDEL desktop",
    detail: message,
  });
  app.quit();
}

function stopServer() {
  if (startupTimer) clearTimeout(startupTimer);
  startupTimer = null;
  if (!server) return;
  server.kill("SIGTERM");
  const child = server;
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, 1500).unref();
}

function userArgs() {
  return process.argv.slice(2).filter((arg) => arg !== "--");
}

function hasPort(argv) {
  return argv.some((arg) => arg === "--port" || arg.startsWith("--port="));
}

function selectedPort() {
  const explicit = portFromArgs(userArgs());
  const envPort = numberFromString(process.env.IDEL_DESKTOP_PORT);
  return explicit ?? envPort ?? CONFIG.defaultPort;
}

function portFromArgs(argv) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--port" && argv[i + 1]) return numberFromString(argv[i + 1]);
    if (arg.startsWith("--port=")) return numberFromString(arg.slice("--port=".length));
  }
  return undefined;
}

function numberFromString(value) {
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) return undefined;
  return parsed;
}

function buildMenu() {
  return Menu.buildFromTemplate([
    {
      label: CONFIG.appName,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        ...(process.env.IDEL_DESKTOP_DEVTOOLS === "1" ? [{ role: "toggleDevTools" }] : []),
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
  ]);
}
`;
}

function electronPreloadSource() {
  return `window.addEventListener("DOMContentLoaded", () => {
  document.documentElement.classList.add("electron");
});
`;
}

function linuxShell() {
  return `#!/usr/bin/env sh
set -eu
DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
exec node "$DIR/launch-electron.mjs" "$@"
`;
}

function linuxDesktopEntry(execPath) {
  return `[Desktop Entry]
Type=Application
Name=${APP_NAME}
Comment=Policy-aware IDEL Electron desktop terminal
Exec=${desktopEntryPath(execPath)}
Icon=utilities-terminal
Terminal=false
Categories=Development;System;TerminalEmulator;
`;
}

function desktopEntryPath(path) {
  return `"${path.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function macShell() {
  return `#!/usr/bin/env sh
set -eu
APP_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
exec node "$APP_DIR/Resources/launch-electron.mjs" "$@"
`;
}

function macInfoPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key>
  <string>${APP_NAME}</string>
  <key>CFBundleExecutable</key>
  <string>openexecution-idel</string>
  <key>CFBundleIdentifier</key>
  <string>${APP_ID}</string>
  <key>CFBundleName</key>
  <string>${APP_NAME}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${APP_VERSION}</string>
</dict>
</plist>
`;
}

function windowsCmd() {
  return `@echo off
set "DIR=%~dp0"
node "%DIR%launch-electron.mjs" %*
`;
}

function windowsPowerShell() {
  return `$ErrorActionPreference = "Stop"
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
& node (Join-Path $dir "launch-electron.mjs") @args
`;
}

function resolveElectronBinary() {
  try {
    const resolved = require("electron");
    if (typeof resolved === "string" && existsSync(resolved)) return resolved;
  } catch {
    fail("Electron is not installed; run `pnpm install` first.");
  }
  fail("could not resolve Electron executable from the electron package.");
}

function runPnpm(args) {
  if (commandWorks("pnpm", ["--version"])) {
    run("pnpm", args);
    return;
  }
  if (commandWorks("corepack", ["--version"])) {
    run("corepack", ["pnpm", ...args]);
    return;
  }
  fail("neither pnpm nor corepack was found; cannot build the workspace.");
}

function runNodeScript(script) {
  run(process.execPath, [script]);
}

function commandWorks(command, args) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: "ignore",
    shell: process.platform === "win32",
  });
  return result.status === 0;
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.error) fail(`${command}: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} ${args.join(" ")} failed with exit ${result.status}`);
}

function fail(message) {
  console.error(`desktop: ${message}`);
  process.exit(1);
}

function relative(path) {
  return path.startsWith(ROOT) ? path.slice(ROOT.length + 1) : path;
}
