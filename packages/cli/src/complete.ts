import { readdirSync, statSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";

import type { Registry } from "@openexecution/registry";

/**
 * Registry-driven autocomplete (spec §24, Module 3). Three completion contexts:
 *  - command completion:   `create.` → create.file, create.folder
 *  - parameter completion: `remove.folder ` → name=, recursive=, force=, dryRun=
 *  - value completion:     `remove.folder name=` → local paths (dist, build, …)
 *
 * All metadata comes from the registry, so the autocomplete surface stays in
 * sync with the command set automatically — no separate completion table.
 */
export function complete(input: string, registry: Registry, cwd: string): string[] {
  const trimmed = input.replace(/^\s+/, "");
  const tokens = trimmed.split(/\s+/);
  const head = tokens[0] ?? "";

  // Still typing the command name (no space yet).
  if (tokens.length <= 1 && !input.endsWith(" ")) {
    return completeCommand(head, registry);
  }

  const resolved = registry.resolve(head);
  if (!resolved) {
    // Unknown command, nothing structured to offer.
    return [];
  }

  const last = input.endsWith(" ") ? "" : (tokens[tokens.length - 1] ?? "");

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
      return completePath(partial, cwd).map((p) => `${key}=${p}`);
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

function completeCommand(partial: string, registry: Registry): string[] {
  return registry
    .list()
    .map((d) => d.id)
    .filter((id) => id.startsWith(partial))
    .sort();
}

/** Local path suggestions for `path` params (spec §24 "local path suggestions"). */
function completePath(partial: string, cwd: string): string[] {
  try {
    const abs = resolve(cwd, partial);
    const dir = partial.endsWith("/") ? abs : dirname(abs);
    const prefix = partial.endsWith("/") ? "" : basename(abs);
    const entries = readdirSync(dir);
    return entries
      .filter((e) => e.startsWith(prefix))
      .slice(0, 50)
      .map((e) => {
        const full = resolve(dir, e);
        let isDir = false;
        try {
          isDir = statSync(full).isDirectory();
        } catch {
          isDir = false;
        }
        const base = partial.endsWith("/")
          ? `${partial}${e}`
          : partial.includes("/")
            ? `${dirname(partial)}/${e}`
            : e;
        return isDir ? `${base}/` : base;
      });
  } catch {
    return [];
  }
}
