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

import { spawn } from "node:child_process";
import {
  appendFile,
  copyFile,
  lstat,
  mkdir,
  open as openFile,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, extname, isAbsolute, resolve as resolvePath } from "node:path";
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
  "tail.file",
  "write.file",
  "append.file",
  "remove.file",
  "remove.folder",
  "list.folder",
  "copy.file",
  "move.file",
  "rename.file",
  "show.path",
  "change.path",
  "get.env",
  "set.env",
  "run.script",
  "edit.file",
  "open.editor",
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

/** Raised when a destructive op's leaf turns out to be a symlink at exec time. */
export class SymlinkRefusedError extends Error {
  override readonly name = "SymlinkRefusedError";
}

/**
 * TOCTOU guard for destructive ops (spec §18). The safety engine classifies the
 * *resolved real path* before execution; but the executor runs later and would
 * otherwise follow whatever the path resolves to AT EXECUTION TIME. If the leaf
 * was swapped for a symlink in that window (e.g. `dist` -> `/` after the scan),
 * a recursive delete could escape the blessed target. We fail closed: refuse to
 * operate when the leaf is a symlink. `unlink`/`rm` on a symlink would only
 * remove the link, but `rm -r` semantics and rename targets make blanket refusal
 * the safe, deterministic choice — a caller who really means the link target
 * should pass the resolved path. A missing leaf is fine (e.g. `force` removal).
 */
async function refuseSwappedSymlink(target: string): Promise<void> {
  let st;
  try {
    st = await lstat(target);
  } catch {
    return; // doesn't exist (or unstattable) — nothing to follow.
  }
  if (st.isSymbolicLink()) {
    throw new SymlinkRefusedError(
      `Refusing destructive op: '${target}' is a symlink at execution time ` +
        `(possible time-of-check/time-of-use swap). Re-run against the resolved path.`,
    );
  }
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
    opts: { dryRun: boolean; cwd: string; interactive?: boolean },
  ): Promise<ExecutionResult> {
    // argv[0] is the command id (see `plan`).
    const id = plan.argv[0] ?? "";
    // Reconstruct params from the descriptive tokens "key=value".
    const params = parseTokenParams(plan.argv.slice(1));

    if (opts.dryRun) {
      if (id === "run.script") {
        return {
          exitCode: 0,
          durationMs: 0,
          stdout: `[dry-run] would run script: ${describeScriptRun(params, opts.cwd)} (cwd=${opts.cwd})\n`,
          stderr: "",
          simulated: true,
        };
      }
      if (isEditorCommand(id)) {
        return {
          exitCode: 0,
          durationMs: 0,
          stdout: `[dry-run] would open editor: ${describeEditFile(params, opts.cwd, id)} (cwd=${opts.cwd})\n`,
          stderr: "",
          simulated: true,
        };
      }
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
      const stdout = await this.runOp(id, params, opts);
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
    opts: { cwd: string; interactive?: boolean },
  ): Promise<string> {
    const cwd = opts.cwd;
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
      case "tail.file": {
        const target = this.requirePath(
          path("file") ?? path("path") ?? path("name"),
          "file",
        );
        return await tailFile({
          path: target,
          lines: asString(params["lines"]) ?? "10",
        });
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
        await refuseSwappedSymlink(target);
        await unlink(target);
        return "";
      }
      case "remove.folder": {
        const target = this.requirePath(path("path") ?? path("name"), "path");
        await refuseSwappedSymlink(target);
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
        await refuseSwappedSymlink(from);
        await rename(from, to);
        return "";
      }
      case "show.path": {
        return cwd + "\n";
      }
      case "change.path": {
        // A child process cannot change the PARENT shell's cwd. We resolve and
        // validate the target (so a bad path is an honest error) and report it;
        // the interactive terminal performs the real process.chdir itself. This
        // limitation is documented in the registry def's semanticNotes.
        const target = this.requirePath(path("to") ?? path("path") ?? path("name"), "to");
        const st = await stat(target).catch(() => undefined);
        if (!st || !st.isDirectory()) {
          throw new Error(`change.path: not a directory: ${target}`);
        }
        return `${target}\n(note: cwd change applies to the idel terminal session, not the parent shell)\n`;
      }
      case "get.env": {
        const name = asString(params["name"]);
        if (name === undefined) throw new Error("get.env: missing name");
        const value = process.env[name];
        return value === undefined ? "" : `${value}\n`;
      }
      case "set.env": {
        // Like change.path, a child cannot mutate the parent shell's env. We set
        // it in THIS process (visible to native passthrough run in the same
        // session) and report it honestly.
        const name = asString(params["name"]);
        if (name === undefined) throw new Error("set.env: missing name");
        const value = asString(params["value"]) ?? "";
        process.env[name] = value;
        return `${name} set for this idel session (not exported to the parent shell)\n`;
      }
      case "run.script": {
        return await runScript({
          cwd,
          path: this.requirePath(path("path") ?? path("name"), "path"),
          args: asString(params["args"]) ?? "",
          shell: asString(params["shell"]) ?? "auto",
        });
      }
      case "edit.file":
      case "open.editor": {
        return await editFile({
          commandId: id,
          cwd,
          path: this.requirePath(
            path("file") ?? path("path") ?? path("name"),
            id === "open.editor" ? "file" : "path",
          ),
          editor: asString(params["editor"]) ?? "auto",
          wait: params["wait"] !== "false",
          interactive: opts.interactive === true,
        });
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

interface TailRun {
  path: string;
  lines: string;
}

const TAIL_CHUNK_BYTES = 64 * 1024;
const MAX_TAIL_LINES = 10_000;

async function tailFile(run: TailRun): Promise<string> {
  const count = parseTailLineCount(run.lines);
  const st = await stat(run.path).catch(() => undefined);
  if (!st) throw new Error(`tail.file: file not found: ${run.path}`);
  if (!st.isFile()) throw new Error(`tail.file: not a file: ${run.path}`);
  if (st.size === 0) return "";

  const handle = await openFile(run.path, "r");
  try {
    const chunks: Buffer[] = [];
    let position = st.size;
    let newlines = 0;
    while (position > 0 && newlines <= count) {
      const size = Math.min(TAIL_CHUNK_BYTES, position);
      position -= size;
      const buffer = Buffer.allocUnsafe(size);
      const { bytesRead } = await handle.read(buffer, 0, size, position);
      const chunk = bytesRead === size ? buffer : buffer.subarray(0, bytesRead);
      chunks.unshift(chunk);
      for (let i = chunk.length - 1; i >= 0; i--) {
        if (chunk[i] === 0x0a) newlines++;
      }
    }

    const text = Buffer.concat(chunks).toString("utf8");
    const hadFinalNewline = text.endsWith("\n");
    const body = hadFinalNewline ? text.slice(0, -1) : text;
    const selected = body.split("\n").slice(-count).join("\n");
    if (!selected) return "";
    return selected + (hadFinalNewline ? "\n" : "");
  } finally {
    await handle.close();
  }
}

function parseTailLineCount(value: string): number {
  const count = Number.parseInt(value, 10);
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`tail.file: lines must be a positive integer, got ${JSON.stringify(value)}`);
  }
  return Math.min(count, MAX_TAIL_LINES);
}

interface ScriptRun {
  cwd: string;
  path: string;
  args: string;
  shell: string;
}

async function runScript(run: ScriptRun): Promise<string> {
  const script = run.path;
  const st = await stat(script).catch(() => undefined);
  if (!st) throw new Error(`run.script: script not found: ${script}`);
  if (!st.isFile()) throw new Error(`run.script: not a file: ${script}`);

  const plan = planScriptRun(script, run.args, run.shell);
  const result = await spawnCapture(plan.command, plan.argv, run.cwd);
  if (result.exitCode !== 0) {
    throw new Error(
      `run.script: ${renderCommand(plan.command, plan.argv)} exited ${result.exitCode}` +
        (result.stderr ? `\n${result.stderr.trimEnd()}` : ""),
    );
  }
  return result.stdout;
}

function describeScriptRun(params: Record<string, string>, cwd: string): string {
  const rawPath = params["path"] ?? params["name"];
  const script = resolveParamPath(cwd, rawPath);
  if (!script) return "run.script <missing path>";
  const plan = planScriptRun(script, params["args"] ?? "", params["shell"] ?? "auto");
  return renderCommand(plan.command, plan.argv);
}

function planScriptRun(
  script: string,
  rawArgs: string,
  shellName: string,
): { command: string; argv: string[] } {
  const args = splitArgs(rawArgs);
  const shell = normalizeScriptShell(shellName, script);
  switch (shell) {
    case "bash":
      return { command: "bash", argv: [script, ...args] };
    case "sh":
      return { command: "sh", argv: [script, ...args] };
    case "node":
      return { command: process.execPath, argv: [script, ...args] };
    case "python":
      return { command: process.platform === "win32" ? "python" : "python3", argv: [script, ...args] };
    case "powershell":
      return {
        command: process.platform === "win32" ? "powershell.exe" : "pwsh",
        argv: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...args],
      };
    case "cmd":
      return { command: "cmd", argv: ["/c", script, ...args] };
    case "direct":
      return { command: script, argv: args };
  }
}

type ScriptShell = "bash" | "sh" | "node" | "python" | "powershell" | "cmd" | "direct";

function normalizeScriptShell(shellName: string, script: string): ScriptShell {
  if (shellName !== "auto") {
    if (isScriptShell(shellName)) return shellName;
    throw new Error(`run.script: unsupported shell: ${shellName}`);
  }
  const ext = extname(script).toLowerCase();
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return "node";
  if (ext === ".py") return "python";
  if (ext === ".ps1") return "powershell";
  if (ext === ".bat" || ext === ".cmd") return "cmd";
  if (ext === ".sh" || ext === ".bash") return process.platform === "win32" ? "bash" : "sh";
  return "direct";
}

function isScriptShell(value: string): value is ScriptShell {
  return (
    value === "bash" ||
    value === "sh" ||
    value === "node" ||
    value === "python" ||
    value === "powershell" ||
    value === "cmd" ||
    value === "direct"
  );
}

function splitArgs(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: string | undefined;
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (c === "\\") {
      const next = input[i + 1];
      if (next === undefined) {
        current += "\\";
        continue;
      }
      if (quote) {
        if (next === quote || next === "\\") {
          current += next;
          i += 1;
          continue;
        }
        current += "\\";
        continue;
      }
      if (/\s/.test(next) || next === "'" || next === '"' || next === "\\") {
        current += next;
        i += 1;
        continue;
      }
      current += "\\";
      continue;
    }
    if (quote) {
      if (c === quote) quote = undefined;
      else current += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }
    if (/\s/.test(c)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += c;
  }
  if (quote) throw new Error("run.script: unterminated quote in args");
  if (current) args.push(current);
  return args;
}

function spawnCapture(
  command: string,
  argv: string[],
  cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolveSpawn) => {
    const child = spawn(command, argv, { cwd, shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      resolveSpawn({ exitCode: 127, stdout, stderr: stderr + `${err.message}\n` });
    });
    child.on("close", (code) => {
      resolveSpawn({ exitCode: code ?? 0, stdout, stderr });
    });
  });
}

function renderCommand(command: string, argv: string[]): string {
  return [command, ...argv].map(renderToken).join(" ");
}

function renderToken(value: string): string {
  return /\s/.test(value) ? JSON.stringify(value) : value;
}

interface EditRun {
  commandId: string;
  cwd: string;
  path: string;
  editor: string;
  wait: boolean;
  interactive: boolean;
}

async function editFile(run: EditRun): Promise<string> {
  await validateEditableTarget(run.commandId, run.path);
  const plan = planEditorRun(run.commandId, run.path, run.editor, run.wait);
  if (!run.interactive || !process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      `${run.commandId} requires an interactive terminal. Use \`idel terminal\` or a local TTY; web/CI/API contexts cannot launch editors.`,
    );
  }
  const result = await spawnInteractive(plan.command, plan.argv, run.cwd);
  if (result.exitCode !== 0) {
    throw new Error(`${run.commandId}: ${renderCommand(plan.command, plan.argv)} exited ${result.exitCode}`);
  }
  return `Edited ${run.path} with ${renderCommand(plan.command, plan.argv)}\n`;
}

function describeEditFile(params: Record<string, string>, cwd: string, commandId = "edit.file"): string {
  const rawPath = params["file"] ?? params["path"] ?? params["name"];
  const target = resolveParamPath(cwd, rawPath);
  if (!target) return `${commandId} <missing ${commandId === "open.editor" ? "file" : "path"}>`;
  const plan = planEditorRun(commandId, target, params["editor"] ?? "auto", params["wait"] !== "false");
  return renderCommand(plan.command, plan.argv);
}

async function validateEditableTarget(commandId: string, target: string): Promise<void> {
  const st = await stat(target).catch(() => undefined);
  if (st?.isDirectory()) throw new Error(`${commandId}: target is a directory: ${target}`);
  if (st) return;
  const parent = await stat(dirname(target)).catch(() => undefined);
  if (!parent || !parent.isDirectory()) {
    throw new Error(`${commandId}: parent directory does not exist: ${dirname(target)}`);
  }
}

function planEditorRun(
  commandId: string,
  target: string,
  editorName: string,
  wait: boolean,
): { command: string; argv: string[] } {
  const resolved = resolveEditor(commandId, editorName, wait);
  return { command: resolved.command, argv: [...resolved.argv, target] };
}

function resolveEditor(
  commandId: string,
  editorName: string,
  wait: boolean,
): { command: string; argv: string[] } {
  if (editorName === "auto") {
    const envEditor = process.env["VISUAL"] || process.env["EDITOR"];
    if (envEditor?.trim()) return parseEditorCommand(commandId, envEditor);
    return process.platform === "win32"
      ? { command: "notepad.exe", argv: [] }
      : { command: "nano", argv: [] };
  }
  if (editorName === "env") {
    const envEditor = process.env["VISUAL"] || process.env["EDITOR"];
    if (!envEditor?.trim()) {
      throw new Error(`${commandId}: VISUAL or EDITOR must be set when editor=env`);
    }
    return parseEditorCommand(commandId, envEditor);
  }
  if (editorName === "nano" || editorName === "vim" || editorName === "vi") {
    return { command: editorName, argv: [] };
  }
  if (editorName === "code") {
    return { command: "code", argv: wait ? ["--wait"] : [] };
  }
  if (editorName === "notepad") {
    return { command: process.platform === "win32" ? "notepad.exe" : "notepad", argv: [] };
  }
  throw new Error(`${commandId}: unsupported editor: ${editorName}`);
}

function parseEditorCommand(
  commandId: string,
  value: string,
): { command: string; argv: string[] } {
  const parts = splitArgs(value.trim());
  const [command, ...argv] = parts;
  if (!command) throw new Error(`${commandId}: empty editor command`);
  return { command, argv };
}

function isEditorCommand(commandId: string): boolean {
  return commandId === "edit.file" || commandId === "open.editor";
}

function spawnInteractive(
  command: string,
  argv: string[],
  cwd: string,
): Promise<{ exitCode: number }> {
  return new Promise((resolveSpawn) => {
    const child = spawn(command, argv, {
      cwd,
      shell: false,
      stdio: "inherit",
    });
    child.on("error", () => {
      resolveSpawn({ exitCode: 127 });
    });
    child.on("close", (code) => {
      resolveSpawn({ exitCode: code ?? 0 });
    });
  });
}

/** Convenience singleton. */
export const nodeAdapter = new NodeAdapter();
