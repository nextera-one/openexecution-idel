import { cp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
const packageRoot = resolve(import.meta.dirname, '..');
const target = resolve(packageRoot, 'web');
await rm(target, { recursive: true, force: true });
await cp(resolve(packageRoot, '../web/public'), target, { recursive: true });
