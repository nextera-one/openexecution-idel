import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Runtime } from '../packages/runtime/dist/index.js';
import { OpenLogWriter } from '../packages/openlogs/dist/index.js';
import { startServer } from '../packages/server/dist/index.js';

// Exercise the guide's actual commands through the desktop HTTP boundary.
// No provider credentials or live AI calls are used. A home-owned workspace
// avoids macOS's deliberately protected /private/var temporary tree.
const tasks = JSON.parse(await readFile(new URL('../docs/pilot/tasks.json', import.meta.url), 'utf8'));
const workspace = await mkdtemp(join(homedir(), 'idel-pilot-check-'));
let server;
try {
  await cp(new URL('../docs/pilot/fixture/', import.meta.url), workspace, { recursive: true });
  const keepPath = join(workspace, 'pilot-cleanup/keep-me.txt');
  const removePath = join(workspace, 'pilot-cleanup/generated.tmp');
  const notesPath = join(workspace, 'pilot-input/notes.txt');
  const keep = await readFile(keepPath, 'utf8');
  const disposable = await readFile(removePath, 'utf8');
  const notes = await readFile(notesPath, 'utf8');
  const writer = new OpenLogWriter({ path: join(workspace, 'audit.jsonl'), keyPath: join(workspace, 'audit.key.json') });
  const runtime = await Runtime.withCore({ logWriter: writer });
  server = await startServer({ runtime, cwd: workspace, port: 0 });
  async function post(path, body) {
    const response = await fetch(server.url + path, {
      method: 'POST',
      headers: { authorization: `Bearer ${server.authToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200);
    return response.json();
  }
  async function run(command) {
    const result = await post('/api/run', { command });
    assert.equal(result.record.result, 'success', command);
    return result;
  }
  for (const command of tasks.setup) await run(command);
  assert.equal(await readFile(join(workspace, 'pilot-project/README.md'), 'utf8'), 'IDEL pilot project');

  const preview = await post('/api/run', { command: tasks.cleanupPreview });
  assert.equal(preview.risk.level, 'HIGH');
  assert.equal(preview.record.result, 'dry_run');
  assert.equal(await readFile(removePath, 'utf8'), disposable);
  assert.equal(await readFile(keepPath, 'utf8'), keep);

  await run(tasks.cleanupMove);
  await assert.rejects(readFile(removePath), { code: 'ENOENT' });
  assert.equal(await readFile(join(workspace, 'pilot-project/review-later.tmp'), 'utf8'), disposable);
  await run(tasks.cleanupVerify);
  assert.equal(await readFile(keepPath, 'utf8'), keep);
  assert.equal(await readFile(notesPath, 'utf8'), notes);

  await run('read.file name=pilot-input/notes.txt');
  await run(tasks.audit);
  const verification = await writer.verify();
  assert.equal(verification.ok, true);
  assert.ok(verification.records >= 8);
  console.log('pilot: setup, enforced dry run, reversible file move, preserved fixtures, and signed audit passed');
  console.log('pilot: live AI and graphical usability require participant sessions; they are not simulated as pilot results');
} finally {
  await server?.close();
  await rm(workspace, { recursive: true, force: true });
}
