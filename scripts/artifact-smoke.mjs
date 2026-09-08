import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
// This file is also included in desktop artifacts, where Electron's utility
// process runs it with its own Node runtime and no workspace dependencies.
const root = resolve(process.argv[2] ?? '.');
const webDir = existsSync(join(root, 'web/terminal.html')) ? join(root, 'web') : join(root, 'node_modules/@openexecution/cli/web');
const sandbox = await mkdtemp(join(tmpdir(), 'idel-artifact-'));
try {
  const { Runtime } = await import(pathToFileURL(join(root, 'node_modules/@openexecution/runtime/dist/index.js')).href);
  const { OpenLogWriter } = await import(pathToFileURL(join(root, 'node_modules/@openexecution/openlogs/dist/index.js')).href);
  const { defaultPolicy } = await import(pathToFileURL(join(root, 'node_modules/@openexecution/policy/dist/index.js')).href);
  const { startServer } = await import(pathToFileURL(join(root, 'node_modules/@openexecution/server/dist/index.js')).href);
  const writer = new OpenLogWriter({ path: join(sandbox, 'audit.jsonl'), keyPath: join(sandbox, 'key.json') });
  const runtime = await Runtime.withCore({ policy: defaultPolicy(), logWriter: writer });
  const server = await startServer({ runtime, cwd: sandbox, port: 0, staticDir: webDir });
  try {
    const page = await fetch(server.url + '/terminal.html');
    assert.equal(page.status, 200);
    assert.match(await page.text(), /idel-api-auth/);
    assert.equal((await fetch(server.url + '/api/registry')).status, 401);
    const response = await fetch(server.url + '/api/run', {
      method: 'POST', headers: { authorization: `Bearer ${server.authToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'show.path' }),
    });
    assert.equal(response.status, 200);
    const verification = await writer.verify();
    assert.equal(verification.ok, true);
    assert.ok(verification.records >= 1);
    const html = await (await fetch(server.url + '/terminal.html')).text();
    const assets = [...html.matchAll(/(?:src|href)="([^"#]+\.(?:js|css))"/g)].map(m => m[1]);
    for (const asset of assets) assert.equal((await fetch(new URL(asset, server.url))).status, 200, asset);
    console.log('artifact smoke: authenticated UI, registry, execution, and signed logs passed');
  } finally { await server.close(); }
} finally { await rm(sandbox, { recursive: true, force: true }); }
// Electron utility processes retain their parent message port after module
// evaluation, so signal completion explicitly after all server/file cleanup.
if (process.parentPort) process.exit(0);
