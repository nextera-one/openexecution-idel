import { readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";

import type { Registry } from "@openexecution/registry";

import { isWithinWorkspace } from "./workspace-path.js";

/**
 * Registry-driven autocomplete (spec §24, Module 3). Three completion contexts:
 *  - command completion:   `create.` → create.file, create.folder
 *  - parameter completion: `remove.folder ` → name=, recursive=, force=, dryRun=
 *  - value completion:     `remove.folder name=` → local paths (dist, build, …)
 *
 * This is the same surface the CLI's readline completer uses, exposed here so the
 * web/desktop terminal can offer identical dropdown completion over HTTP. Kept in
 * sync with packages/cli/src/complete.ts — both derive everything from the
 * registry, so the command set drives completion automatically.
 */
export function complete(input: string, registry: Registry, cwd: string, workspaceRoot = cwd): string[] {
  const segment = currentBatchSegment(input);
  const trimmed = segment.replace(/^\s+/, "");
  if (trimmed.startsWith("!")) return completeNative(segment, cwd, workspaceRoot);
  if (!trimmed) return completeCommand("", registry);

  const tokens = looseTokens(trimmed);
  const head = tokens[0] ?? "";
  const atTokenBoundary = endsWithTokenSeparator(segment);

  // Still typing the command name (no space yet).
  if (tokens.length <= 1 && !atTokenBoundary) {
    return completeCommand(head, registry);
  }

  const resolved = registry.resolve(head);
  if (!resolved) {
    // Unknown command, nothing structured to offer.
    return [];
  }

  const last = atTokenBoundary ? "" : currentToken(segment);

  // Value completion: `key=<partial>`.
  const eq = last.indexOf("=");
  if (eq >= 0) {
    const key = last.slice(0, eq);
    const partial = last.slice(eq + 1);
    const schema = resolved.def.params[key];
    if (schema?.enum) {
      return schema.enum
        .map(String)
        .filter((v) => v.startsWith(partial))
        .map((v) => `${key}=${v}`);
    }
    if (schema?.type === "boolean") {
      return ["true", "false"]
        .filter((v) => v.startsWith(partial))
        .map((v) => `${key}=${v}`);
    }
    if (schema?.type === "path") {
      return completePath(partial, cwd, workspaceRoot).map((p) => `${key}=${p}`);
    }
    return [];
  }

  // Parameter-name completion: offer remaining `key=` for unset params.
  const used = new Set(
    tokens.slice(1).map((t) => {
      const i = t.indexOf("=");
      return i >= 0 ? t.slice(0, i) : t;
    }),
  );
  return Object.keys(resolved.def.params)
    .filter((p) => !used.has(p))
    .filter((p) => p.startsWith(last))
    .map((p) => `${p}=`);
}

function currentBatchSegment(input: string): string {
  const trimmed = input.trimStart();
  if (trimmed.startsWith("!")) return input;
  let start = 0;
  let quote: string | undefined;
  let escaped = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (c === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (c === quote) quote = undefined;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }
    if (c === "&" && input[i + 1] === "&") {
      start = i + 2;
      i += 1;
    }
  }
  return input.slice(start);
}

function completeCommand(partial: string, registry: Registry): string[] {
  return registry
    .list()
    .map((d) => d.id)
    .filter((id) => id.startsWith(partial))
    .sort();
}

/** Local path suggestions for `path` params (spec §24 "local path suggestions"). */
function completePath(partial: string, cwd: string, workspaceRoot: string): string[] {
  try {
    const parsed = unwrapQuote(partial);
    const pathPartial = parsed.value;
    if (pathPartial.includes("\0") || isAbsolute(normalizeForPlatform(pathPartial))) return [];
    const trailingSep = endsWithPathSep(pathPartial);
    const dirText =
      pathPartial === ""
        ? "."
        : trailingSep
          ? pathPartial
          : parentPathText(pathPartial) || ".";
    const prefix = pathPartial === "" || trailingSep ? "" : lastPathSegment(pathPartial);
    const lexicalDir = resolve(cwd, normalizeForPlatform(dirText));
    if (!isWithinWorkspace(workspaceRoot, lexicalDir)) return [];
    const canonicalDir = realpathSync.native(lexicalDir);
    if (!isWithinWorkspace(workspaceRoot, canonicalDir)) return [];
    const entries = readdirSync(canonicalDir);
    const prefixCmp = process.platform === "win32" ? prefix.toLowerCase() : prefix;
    return entries
      .filter((e) => {
        const entryCmp = process.platform === "win32" ? e.toLowerCase() : e;
        return entryCmp.startsWith(prefixCmp);
      })
      .slice(0, 50)
      .map((e) => {
        const base = pathPartial === "" || trailingSep
          ? `${pathPartial}${e}`
          : `${parentPathText(pathPartial)}${e}`;
        const full = resolve(canonicalDir, e);
        let isDir = false;
        try {
          const canonical = realpathSync.native(full);
          if (!isWithinWorkspace(workspaceRoot, canonical)) return undefined;
          isDir = statSync(canonical).isDirectory();
        } catch {
          return undefined;
        }
        const candidate = isDir ? `${base}${preferredSep(pathPartial)}` : base;
        return rewrapPath(candidate, parsed.quote, isDir);
      })
      .filter((candidate): candidate is string => candidate !== undefined);
  } catch {
    return [];
  }
}

function completeNative(input: string, cwd: string, workspaceRoot: string): string[] {
  const body = input.replace(/^\s*!\s?/, "");
  const token = endsWithTokenSeparator(body) ? "" : currentToken(body);
  const value = unwrapQuote(token).value;
  const pathish =
    value === "" ||
    value.startsWith(".") ||
    value.startsWith("/") ||
    value.startsWith("~") ||
    /^[A-Za-z]:/.test(value) ||
    value.includes("/") ||
    value.includes("\\");
  return pathish ? completePath(token, cwd, workspaceRoot) : [];
}

function looseTokens(input: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < input.length) {
    while (i < input.length && /\s/.test(input[i]!)) i++;
    if (i >= input.length) break;
    const start = i;
    let quote: string | undefined;
    let escaped = false;
    while (i < input.length) {
      const c = input[i]!;
      if (escaped) {
        escaped = false;
        i++;
        continue;
      }
      if (c === "\\") {
        escaped = true;
        i++;
        continue;
      }
      if (quote) {
        if (c === quote) quote = undefined;
        i++;
        continue;
      }
      if (c === "'" || c === '"') {
        quote = c;
        i++;
        continue;
      }
      if (/\s/.test(c)) break;
      i++;
    }
    tokens.push(input.slice(start, i));
  }
  return tokens;
}

function currentToken(input: string): string {
  let start = 0;
  let quote: string | undefined;
  let escaped = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (c === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (c === quote) quote = undefined;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }
    if (/\s/.test(c)) start = i + 1;
  }
  return input.slice(start);
}

function endsWithTokenSeparator(input: string): boolean {
  if (!/\s$/.test(input)) return false;
  let quote: string | undefined;
  let escaped = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (c === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (c === quote) quote = undefined;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
  }
  return quote === undefined && !escaped;
}

function unwrapQuote(value: string): { quote?: string; value: string } {
  const first = value[0];
  if (first === "'" || first === '"') return { quote: first, value: value.slice(1) };
  return { value };
}

function rewrapPath(value: string, quote: string | undefined, isDir: boolean): string {
  const needsQuote = quote !== undefined || /\s/.test(value);
  if (!needsQuote) return value;
  const q = quote ?? '"';
  const escaped = value.replaceAll("\\", "\\\\").replaceAll(q, `\\${q}`);
  return `${q}${escaped}${isDir ? "" : q}`;
}

function endsWithPathSep(value: string): boolean {
  return value.endsWith("/") || value.endsWith("\\");
}

function parentPathText(value: string): string {
  const idx = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
  return idx >= 0 ? value.slice(0, idx + 1) : "";
}

function lastPathSegment(value: string): string {
  const idx = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
  return idx >= 0 ? value.slice(idx + 1) : value;
}

function preferredSep(value: string): string {
  if (value.includes("\\") && !value.includes("/")) return "\\";
  return "/";
}

function normalizeForPlatform(value: string): string {
  return sep === "\\" ? value.replaceAll("/", "\\") : value.replaceAll("\\", "/");
}
