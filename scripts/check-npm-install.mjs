import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const root = resolve(import.meta.dirname, '..');
const pnpm = process.env.npm_execpath;
if (!pnpm) throw new Error('Run through pnpm check:npm');
const scratch = await mkdtemp(join(tmpdir(), 'idel-npm-consumer-'));
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: { ...process.env, CI: 'true' }, timeout: 180000 });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || result.error?.message || `${command} failed`);
  return result.stdout;
}
try {
  const dependencies = {};
  for (const entry of await readdir(join(root, 'packages'))) {
    const dir = join(root, 'packages', entry);
    const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
    if (manifest.private) continue;
    run(process.execPath, [pnpm, '--config.node-linker=hoisted', 'pack', '--pack-destination', scratch], dir);
    const tarball = `${manifest.name.replace('@', '').replace('/', '-')}-${manifest.version}.tgz`;
    dependencies[manifest.name] = `file:${join(scratch, tarball).replaceAll('\\', '/')}`;
  }
  await writeFile(join(scratch, 'package.json'), JSON.stringify({ name: 'idel-clean-consumer', private: true, dependencies }));
  // npm ships with Node; resolve its JS entry to avoid Windows .cmd shell quoting.
  const npmCli = process.env.IDEL_NPM_CLI ?? [resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'), join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')].find(existsSync);
  if (!npmCli) throw new Error('Set IDEL_NPM_CLI to npm/bin/npm-cli.js for this Node installation');
  run(process.execPath, [npmCli, 'install', '--ignore-scripts', '--no-audit', '--no-fund'], scratch);
  const cli = run(process.execPath, [join(scratch, 'node_modules/@openexecution/cli/bin/idel.js'), 'version'], scratch);
  if (!cli.startsWith('idel ')) throw new Error('Installed CLI failed');
  process.stdout.write(run(process.execPath, [join(root, 'scripts/artifact-smoke.mjs'), scratch], scratch));
  console.log('npm consumer: all 15 public packages installed from tarballs and executed');
} finally { await rm(scratch, { recursive: true, force: true }); }
