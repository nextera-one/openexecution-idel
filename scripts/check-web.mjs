#!/usr/bin/env node
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const publicDir = resolve(root, "packages/web/public");
const pages = ["index.html", "terminal.html"];
const failures = [];

for (const page of pages) {
  const source = await readFile(resolve(publicDir, page), "utf8");
  const ids = [...source.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  if (duplicates.length) failures.push(`${page}: duplicate ids: ${duplicates.join(", ")}`);
  if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(source)) failures.push(`${page}: inline script violates CSP`);
  if (/\sstyle="/i.test(source)) failures.push(`${page}: inline style attribute violates CSP hygiene`);
  for (const match of source.matchAll(/<button\b([^>]*)>/gi)) {
    const attrs = match[1];
    if (!/\btype="button"/i.test(attrs) && !/\btype="submit"/i.test(attrs)) {
      failures.push(`${page}: button missing explicit type near ${match[0].slice(0, 90)}`);
    }
  }
}

for (const asset of (await readdir(publicDir)).filter((name) => name.endsWith(".js"))) {
  const syntax = spawnSync(process.execPath, ["--check", resolve(publicDir, asset)], {
    encoding: "utf8",
  });
  if (syntax.status !== 0) failures.push(`${asset}: ${syntax.stderr.trim()}`);
}

if (failures.length) {
  process.stderr.write(`web checks failed:\n- ${failures.join("\n- ")}\n`);
  process.exit(1);
}
process.stdout.write("web checks passed: syntax, CSP hygiene, ids, and button types\n");
