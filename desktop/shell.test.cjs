const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { EventEmitter } = require('node:events');
const { runInNewContext } = require('node:vm');

async function boot(platform = 'linux') {
  const handlers = new Map();
  const calls = { writes: [], dialogs: 0, menu: 'unset', relaunch: 0, quit: 0 };
  let window;
  const app = new EventEmitter();
  Object.assign(app, { isPackaged: false, requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(), setName() {}, getPath: name => '/test/' + name,
    quit: () => calls.quit++, relaunch: () => calls.relaunch++ });
  const dialog = { showOpenDialog: async () => { calls.dialogs++; return { canceled: false, filePaths: ['/test/new-workspace'] }; },
    showMessageBox: async () => ({ response: 0 }) };
  class BrowserWindow {
    constructor(options) {
      calls.options = options; window = this;
      this.webContents = new EventEmitter();
      Object.assign(this.webContents, { mainFrame: { url: 'http://127.0.0.1:8765/terminal.html' },
        setWindowOpenHandler() {}, session: { setPermissionRequestHandler() {} },
        copy: () => { calls.copy = true; } });
    }
    loadURL() { return Promise.resolve(); }
    show() {}
  }
  const electron = { app, BrowserWindow, dialog, shell: {},
    Menu: { setApplicationMenu: menu => { calls.menu = menu; } },
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    utilityProcess: { fork: () => {
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
      setImmediate(() => child.stdout.emit('data', Buffer.from('listening on http://127.0.0.1:8765')));
      return child;
    } } };
  runInNewContext(readFileSync(join(__dirname, 'main.cjs'), 'utf8'), {
    require: name => name === 'electron' ? electron : name === 'node:fs/promises' ? {
      mkdir: async () => {}, readFile: async () => JSON.stringify({ workspace: '/test/workspace' }),
      writeFile: async (...args) => calls.writes.push(args),
    } : require(name),
    __dirname, URL, process: { ...process, platform, argv: [], stderr: { write() {} } }, setTimeout, clearTimeout,
  });
  await new Promise(resolve => setImmediate(() => setImmediate(resolve)));
  return { calls, window, choose: handlers.get('idel:choose-workspace'), dialog };
}

test('menu-free shell keeps sandboxing and rejects foreign workspace requests', async () => {
  const { calls, window, choose } = await boot();
  assert.equal(calls.menu, null);
  assert.equal(calls.options.webPreferences.sandbox, true);
  assert.equal(calls.options.webPreferences.contextIsolation, true);
  assert.equal(calls.options.webPreferences.nodeIntegration, false);
  assert.equal(calls.options.webPreferences.preload, join(__dirname, 'preload.cjs'));
  assert.equal(calls.options.icon, join(__dirname, 'icon.png'));
  await assert.rejects(choose({ sender: {}, senderFrame: window.webContents.mainFrame }));
  await assert.rejects(choose({ sender: window.webContents, senderFrame: { url: window.webContents.mainFrame.url } }));
  window.webContents.mainFrame.url = 'https://untrusted.example/';
  await assert.rejects(choose({ sender: window.webContents, senderFrame: window.webContents.mainFrame }));
  assert.equal(calls.dialogs, 0);
  assert.equal(calls.writes.length, 0);
});

test('workspace selection persists and relaunches only after both dialogs accept', async () => {
  const { calls, window, choose, dialog } = await boot();
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  dialog.showMessageBox = async () => ({ response: 1 });
  await choose(event);
  assert.equal(calls.writes.length, 0);
  dialog.showMessageBox = async () => ({ response: 0 });
  await choose(event);
  assert.equal(JSON.parse(calls.writes[0][1]).workspace, '/test/new-workspace');
  assert.equal(calls.writes[0][2].mode, 0o600);
  assert.equal(calls.relaunch, 1);
  assert.equal(calls.quit, 1);
});

test('macOS copy shortcut remains available without an Edit menu', async () => {
  const { calls, window } = await boot('darwin');
  let prevented = false;
  window.webContents.emit('before-input-event', { preventDefault: () => { prevented = true; } }, { type: 'keyDown', key: 'c', meta: true });
  assert.equal(calls.copy, true);
  assert.equal(prevented, true);
});
