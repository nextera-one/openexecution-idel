import { createHash } from 'node:crypto';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const dir = resolve(process.argv[2] ?? 'dist/installers');
const tag = process.argv[3];
if (!tag || !/^v\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(tag)) throw new Error('Supply an explicit release tag, e.g. v1.1.0-preview.1');
const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
if (!tag.startsWith(`v${metadata.version}`) || !new RegExp(`^v${metadata.version.replaceAll('.', '\\.')}($|-)`).test(tag)) throw new Error('Release tag does not match the package version');
const root = `https://github.com/nextera-one/openexecution-idel/releases`;
const assets = [];
for (const name of (await readdir(dir)).sort()) {
  if (!/\.(AppImage|deb|dmg|exe)$/.test(name)) continue;
  if (!name.startsWith(`IDEL-${metadata.version}-`)) throw new Error(`Stale asset: ${name}`);
  const platform = name.includes('-linux-') ? 'linux' : name.includes('-mac-') ? 'macos' : name.includes('-win-') ? 'windows' : null;
  if (!platform) throw new Error(`Unknown target: ${name}`);
  const architecture = /arm64/.test(name) ? 'Apple Silicon' : platform === 'macos' ? 'Intel' : '64-bit';
  const format = name.endsWith('.AppImage') ? 'AppImage' : name.endsWith('.deb') ? 'DEB' : name.endsWith('.dmg') ? 'DMG' : 'Setup EXE';
  const path = join(dir, name);
  assets.push({ name, platform, label: `${architecture} · ${format}`, url: `${root}/download/${tag}/${encodeURIComponent(name)}`, size: (await stat(path)).size, sha256: createHash('sha256').update(await readFile(path)).digest('hex') });
}
if (!assets.length) throw new Error('No installer artifacts found');
await writeFile(join(dir, 'idel.json'), JSON.stringify({ schemaVersion: 1, release: { version: tag.slice(1), date: new Date().toISOString().slice(0, 10), notesUrl: `${root}/tag/${tag}`, assets } }, null, 2) + '\n');
await writeFile(join(dir, 'SHA256SUMS.txt'), assets.map(asset => `${asset.sha256}  ${asset.name}`).join('\n') + '\n');
console.log(`Release metadata written for ${assets.length} installer(s)`);
