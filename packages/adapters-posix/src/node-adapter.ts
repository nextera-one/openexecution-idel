/**
 * NodeAdapter — the SAFEST executor (spec §22): file operations implemented
 * IN-PROCESS with `node:fs/promises` instead of shelling out. This improves
 * safety (no shell, no argv injection surface) and portability (one code path
 * on POSIX and Windows). Commands opt in by setting their adapter spec's
 * `command` to the `@node` sentinel; the runtime should PREFER this adapter
 * whenever it `supports` the command.
 *
 * It lives in `@openexecution/adapters-posix` because node fs ops are
 * cross-platform — the posix package is a fine home and avoids a third package.
 */

import {
  appendFile,
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, resolve as resolvePath } from "node:path";
import type {
  Adapter,
  AdapterName,
  CommandAst,
  ExecutionPlan,
  ExecutionResult,
  ParamValue,
  ResolvedCommand,
} from "@openexecution/types";

/** Command ids this adapter knows how to execute in-process. */
const HANDLED_IDS = new Set<string>([
  "create.file",
  "create.folder",
  "read.file",
  "write.file",
  "append.file",
  "remove.file",
  "remove.folder",
  "list.folder",
  "copy.file",
  "move.file",
  "rename.file",
  "path.current",
  "path.change",
  "env.get",
  "env.set",
]);

/** Sentinel marking a def whose execution is the in-process node fs path. */
const NODE_SENTINEL = "@node";

function asString(value: ParamValue | undefined): string | undefined {
  if (value === undefined || value === "") return undefined;
  return String(value);
}

/** Resolve a param path against cwd; absolute params are honored as-is. */
function resolveParamPath(
  cwd: string,
  raw: string | undefined,
): string | undefined {
  if (raw === undefined) return undefined;
  return isAbsolute(raw) ? raw : resolvePath(cwd, raw);
}

export class NodeAdapter implements Adapter {
  readonly name: AdapterName = "node";
  /** Cross-platform: always available. */
  readonly available: boolean = true;

  supports(commandId: string): boolean {
    return HANDLED_IDS.has(commandId);
  }

  /**
   * Authoritative check: the def must both target `@node` AND be an id we
   * implement. The runtime can call this when it has the resolved def; the
   * id-only {@link supports} above is what the {@link Adapter} interface needs.
   */
  supportsResolved(resolved: ResolvedCommand): boolean {
    const spec = resolved.def.adapters.node;
    if (spec === undefined || spec.command !== NODE_SENTINEL) return false;
    return HANDLED_IDS.has(resolved.def.id);
  }

  plan(resolved: ResolvedCommand, ast: CommandAst): ExecutionPlan {
    const id = resolved.def.id;
    // Build a descriptive token list (NOT a shell line) for logging/preview.
    const tokens: string[] = [id];
    for (const [key, value] of Object.entries(ast.params)) {
      tokens.push(`${key}=${String(value)}`);
    }
    return {
      adapter: "node",
      command: NODE_SENTINEL,
      argv: tokens,
      describe: `node:${id} ${tokens.slice(1).join(" ")}`.trimEnd(),
    };
  }

  async execute(
    plan: ExecutionPlan,
    opts: { dryRun: boolean; cwd: string },
  ): Promise<ExecutionResult> {
    // argv[0] is the command id (see `plan`).
    const id = plan.argv[0] ?? "";
    // Reconstruct params from the descriptive tokens "key=value".
    const params = parseTokenParams(plan.argv.slice(1));

    if (opts.dryRun) {
      return {
        exitCode: 0,
        durationMs: 0,
        stdout: `[dry-run] would perform in-process op: ${plan.describe} (cwd=${opts.cwd})\n`,
        stderr: "",
        simulated: true,
      };
    }

    const start = process.hrtime.bigint();
    const done = (
      exitCode: number,
      stdout: string,
      stderr: string,
    ): ExecutionResult => ({
      exitCode,
      durationMs: Number(process.hrtime.bigint() - start) / 1e6,
      stdout,
      stderr,
      simulated: false,
    });

    try {
      const stdout = await this.runOp(id, params, opts.cwd);
      return done(0, stdout, "");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return done(1, "", `${message}\n`);
    }
  }

  /** Dispatch on command id; returns stdout text (empty for write-only ops). */
  private async runOp(
    id: string,
    params: Record<string, string>,
    cwd: string,
  ): Promise<string> {
    const path = (name: string): string | undefined =>
      resolveParamPath(cwd, asString(params[name]));

    switch (id) {
      case "create.file": {
        // touch-like: create the file only if it does not already exist.
        const target = this.requirePath(path("name") ?? path("path"), "name");
        const exists = await pathExists(target);
        if (!exists) await writeFile(target, "", { flag: "wx" });
        return "";
      }
      case "create.folder": {
        const target = this.requirePath(path("name") ?? path("path"), "name");
        await mkdir(target, { recursive: true });
        return "";
      }
      case "read.file": {
        const target = this.requirePath(path("path") ?? path("name"), "path");
        return await readFile(target, "utf8");
      }
      case "write.file": {
        const target = this.requirePath(path("path") ?? path("name"), "path");
        await writeFile(target, asString(params["content"]) ?? "", "utf8");
        return "";
      }
      case "append.file": {
        const target = this.requirePath(path("path") ?? path("name"), "path");
        await appendFile(target, asString(params["content"]) ?? "", "utf8");
        return "";
      }
      case "remove.file": {
        const target = this.requirePath(path("path") ?? path("name"), "path");
        await unlink(target);
        return "";
      }
      case "remove.folder": {
        const target = this.requirePath(path("path") ?? path("name"), "path");
        const recursive = params["recursive"] === "true";
        const force = params["force"] === "true";
        await rm(target, { recursive, force });
        return "";
      }
      case "list.folder": {
        // Path is optional here; default to the cwd when omitted.
        const target = path("path") ?? path("name") ?? cwd;
        const entries = await readdir(target);
        return entries.length > 0 ? entries.join("\n") + "\n" : "";
      }
      case "copy.file": {
        const from = this.requirePath(path("from") ?? path("source"), "from");
        const to = this.requirePath(path("to") ?? path("dest"), "to");
        await copyFile(from, to);
        return "";
      }
      case "move.file":
      case "rename.file": {
        const from = this.requirePath(path("from") ?? path("source"), "from");
        const to = this.requirePath(path("to") ?? path("dest"), "to");
        await rename(from, to);
        return "";
      }
      case "path.current": {
        return cwd + "\n";
      }
      case "path.change": {
        // A child process cannot change the PARENT shell's cwd. We resolve and
        // validate the target (so a bad path is an honest error) and report it;
        // the interactive terminal performs the real process.chdir itself. This
        // limitation is documented in the registry def's semanticNotes.
        const target = this.requirePath(path("path") ?? path("name"), "path");
        const st = await stat(target).catch(() => undefined);
        if (!st || !st.isDirectory()) {
          throw new Error(`path.change: not a directory: ${target}`);
        }
        return `${target}\n(note: cwd change applies to the idel terminal session, not the parent shell)\n`;
      }
      case "env.get": {
        const name = asString(params["name"]);
        if (name === undefined) throw new Error("env.get: missing name");
        const value = process.env[name];
        return value === undefined ? "" : `${value}\n`;
      }
      case "env.set": {
        // Like path.change, a child cannot mutate the parent shell's env. We set
        // it in THIS process (visible to native passthrough run in the same
        // session) and report it honestly.
        const name = asString(params["name"]);
        if (name === undefined) throw new Error("env.set: missing name");
        const value = asString(params["value"]) ?? "";
        process.env[name] = value;
        return `${name} set for this idel session (not exported to the parent shell)\n`;
      }
      default:
        throw new Error(`NodeAdapter: unsupported command id "${id}"`);
    }
  }

  private requirePath(p: string | undefined, param: string): string {
    if (p === undefined) {
      throw new Error(`NodeAdapter: missing required path parameter "${param}"`);
    }
    return p;
  }
}

/** Parse "key=value" tokens (value may contain '='); used by execute(). */
function parseTokenParams(tokens: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const token of tokens) {
    const eq = token.indexOf("=");
    if (eq < 0) continue;
    const key = token.slice(0, eq);
    const value = token.slice(eq + 1);
    if (key.length > 0) out[key] = value;
  }
  return out;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/** Convenience singleton. */
export const nodeAdapter = new NodeAdapter();
