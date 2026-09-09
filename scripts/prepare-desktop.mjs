import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, join, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = resolve(import.meta.dirname, '..');
const stage = join(root, 'dist/desktop-stage');
const pnpm = process.env.npm_execpath;
if (!pnpm) throw new Error('Run through pnpm desktop:prepare');
function run(args) {
  const result = spawnSync(process.execPath, [pnpm, ...args], { cwd: root, stdio: 'inherit', env: { ...process.env, CI: 'true' } });
  if (result.status !== 0) throw new Error(`pnpm ${args.join(' ')} failed`);
}
run(['build']);
await import('./sync-xterm-assets.mjs');
await import('../packages/cli/scripts/copy-web.mjs');
await rm(stage, { recursive: true, force: true });
await mkdir(join(stage, 'app'), { recursive: true });
const deployed = join(stage, 'deployed');
run(['--config.node-linker=hoisted', '--filter', '@openexecution/cli', 'deploy', '--prod', deployed]);
// electron-builder excludes pnpm's hidden store while preserving its symlinks.
// Materialize dependencies so the shipped runtime has no store/check-out links.
await cp(deployed, join(stage, 'runtime'), { recursive: true, dereference: true, filter: path => !['.pnpm', '.bin'].includes(basename(path)) });
await rm(deployed, { recursive: true, force: true });
// pnpm deploy is not guaranteed to run package prepack hooks.
await cp(join(root, 'registries/core'), join(stage, 'runtime/node_modules/@openexecution/registry/registries/core'), { recursive: true });
await cp(join(root, 'packages/web/public'), join(stage, 'runtime/web'), { recursive: true });
await cp(join(root, 'scripts/artifact-smoke.mjs'), join(stage, 'runtime/artifact-smoke.mjs'));
await cp(join(root, 'desktop/main.cjs'), join(stage, 'app/main.cjs'));
await cp(join(root, 'desktop/preload.cjs'), join(stage, 'app/preload.cjs'));
await cp(join(root, 'desktop/icon.png'), join(stage, 'app/icon.png'));
await cp(join(root, 'LICENSE'), join(stage, 'app/LICENSE'));
const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
await writeFile(join(stage, 'app/package.json'), JSON.stringify({
  name: 'openexecution-idel-desktop', version: metadata.version, main: 'main.cjs',
  description: metadata.description, author: metadata.author, license: metadata.license,
}, null, 2));
const check = spawnSync(process.execPath, [join(stage, 'runtime/artifact-smoke.mjs'), join(stage, 'runtime')], { cwd: stage, stdio: 'inherit' });
if (check.status !== 0) throw new Error('Staged runtime did not pass its smoke test');
console.log('desktop: staged standalone runtime and application');
