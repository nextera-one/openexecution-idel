const { app, BrowserWindow, Menu, dialog, shell, utilityProcess, ipcMain } = require('electron');
const { mkdir, readFile, writeFile } = require('node:fs/promises');
const { join } = require('node:path');

let win;
let child;
let origin;
let quitting = false;
let workspace;
const resources = app.isPackaged ? process.resourcesPath : join(__dirname, '../dist/desktop-stage');
const runtime = join(resources, 'runtime');
const settingsPath = () => join(app.getPath('userData'), 'workspace.json');
const trusted = (value) => {
  try { return Boolean(origin) && new URL(value).origin === origin; } catch { return false; }
};

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { win?.show(); win?.focus(); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => { quitting = true; child?.kill(); });
  app.whenReady().then(start).catch(fail);
}

async function start() {
  app.setName('OpenExecution IDEL');
  Menu.setApplicationMenu(null);
  if (process.argv.includes('--idel-smoke')) {
    const worker = utilityProcess.fork(join(runtime, 'artifact-smoke.mjs'), [runtime], { stdio: 'pipe' });
    const timer = setTimeout(() => { worker.kill(); app.exit(1); }, 30000);
    worker.stdout.on('data', data => process.stdout.write(data));
    worker.stderr.on('data', data => process.stderr.write(data));
    worker.on('exit', code => { clearTimeout(timer); app.exit(code); });
    return;
  }
  workspace = join(app.getPath('documents'), 'IDEL');
  try {
    const saved = JSON.parse(await readFile(settingsPath(), 'utf8'));
    if (typeof saved.workspace === 'string') workspace = saved.workspace;
  } catch { /* first launch */ }
  await mkdir(workspace, { recursive: true });
  win = new BrowserWindow({
    width: 1320, height: 860, minWidth: 800, minHeight: 580,
    title: 'OpenExecution IDEL', backgroundColor: '#0b0e14', show: false,
    icon: join(__dirname, 'icon.png'),
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  for (const eventName of ['will-navigate', 'will-redirect']) {
    win.webContents.on(eventName, (event, url) => { if (!trusted(url)) event.preventDefault(); });
  }
  win.webContents.session.setPermissionRequestHandler((contents, permission, callback) => {
    callback(trusted(contents.getURL()) && ['clipboard-read', 'clipboard-sanitized-write'].includes(permission));
  });
  ipcMain.handle('idel:choose-workspace', async event => {
    if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || !trusted(event.senderFrame.url)) {
      throw new Error('Workspace selection is only available from the local desktop window.');
    }
    await chooseWorkspace();
  });
  // Native editing shortcuts on macOS normally come from the removed Edit menu.
  win.webContents.on('before-input-event', (event, input) => {
    if (process.platform !== 'darwin' || input.type !== 'keyDown' || !input.meta || input.control || input.alt) return;
    const key = input.key.toLowerCase();
    const action = key === 'z' ? (input.shift ? 'redo' : 'undo') : !input.shift ? { x: 'cut', c: 'copy', v: 'paste', a: 'selectAll' }[key] : undefined;
    if (action) { event.preventDefault(); win.webContents[action](); }
    else if (key === 'q' && !input.shift) { event.preventDefault(); app.quit(); }
  });
  await startRuntime();
}

let choosingWorkspace = false;
async function chooseWorkspace() {
  if (choosingWorkspace) return;
  choosingWorkspace = true;
  try {
    const selection = await dialog.showOpenDialog(win, { title: 'Choose IDEL workspace', properties: ['openDirectory', 'createDirectory'] });
    if (selection.canceled || !selection.filePaths[0]) return;
    const confirmation = await dialog.showMessageBox(win, {
      type: 'question', buttons: ['Change workspace', 'Cancel'], defaultId: 1, cancelId: 1,
      message: 'Restart IDEL in this workspace?', detail: 'Active terminal sessions will close.',
    });
    if (confirmation.response !== 0) return;
    workspace = selection.filePaths[0];
    await mkdir(app.getPath('userData'), { recursive: true });
    await writeFile(settingsPath(), JSON.stringify({ workspace }), { mode: 0o600 });
    app.relaunch(); app.quit();
  } finally { choosingWorkspace = false; }
}

async function startRuntime() {
  // Electron supplies Node in a utility process; users need no system Node or checkout.
  child = utilityProcess.fork(join(runtime, 'bin/idel.js'), ['serve', '--static', join(runtime, 'web'), '--port', '0'], {
    cwd: workspace, stdio: 'pipe', serviceName: 'IDEL local runtime',
  });
  let output = '';
  let ready = false;
  const timer = setTimeout(() => fail(new Error('The local runtime did not start within 30 seconds.')), 30000);
  child.stdout.on('data', chunk => {
    output = (output + chunk.toString()).slice(-8192);
    const match = output.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/);
    if (!match || ready) return;
    ready = true; clearTimeout(timer); origin = match[1];
    win.loadURL(origin + '/terminal.html').then(() => win.show()).catch(fail);
  });
  child.stderr.on('data', chunk => process.stderr.write(chunk));
  child.on('exit', code => {
    clearTimeout(timer);
    if (!quitting) void fail(new Error(`The local runtime stopped (exit ${code}). Restart IDEL to continue.`));
  });
}

async function fail(error) {
  if (quitting) return;
  quitting = true;
  child?.kill();
  await dialog.showMessageBox({ type: 'error', title: 'OpenExecution IDEL', message: 'IDEL could not continue', detail: error.message });
  app.quit();
}
