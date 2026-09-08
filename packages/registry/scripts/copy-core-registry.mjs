#!/usr/bin/env node
import { cp, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");
const repoRoot = resolve(packageRoot, "..", "..");
const source = join(repoRoot, "registries", "core");
const target = join(packageRoot, "registries", "core");

await rm(target, { recursive: true, force: true });
await cp(source, target, { recursive: true });
