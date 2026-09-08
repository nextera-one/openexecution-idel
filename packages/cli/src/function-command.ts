/**
 * `idel run.function` and `idel verify.execution` — the local development
 * runtime for Phase 1 IDEL functions.
 *
 * The executor itself is in `@openexecution/function`; this module is the
 * boundary that gives it durable adapters. Three of those are load-bearing:
 *
 * - the **nonce store is file-backed**, because replay protection that resets
 *   every process is no protection at all;
 * - **authority fails closed** — with no grants file, every request is
 *   refused rather than silently executed with ambient authority;
 * - the **evidence log is hash-chained across runs**, continuing the chain
 *   from the last record on disk.
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";

import {
  FunctionResolver,
  MemoryStore,
  loadRunRequest,
  renderReceipt,
  runRequest,
  verifyReceipt,
  type AuthorityProvider,
  type EntityRow,
  type EvidenceRecord,
  type EvidenceSink,
  type NonceStore,
} from "@openexecution/function";

import { color } from "./render.js";

export interface FunctionCommandOptions {
  json: boolean;
  /** Directory scanned for `*.func.idel`. Defaults to the working directory. */
  root?: string;
  storePath?: string;
  evidencePath?: string;
  authorityPath?: string;
  noncePath?: string;
  receiptPath?: string;
  dryRun?: boolean;
}

const DEFAULT_DIR = ".idel";

const inDir = (root: string, file: string): string => join(root, DEFAULT_DIR, file);

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Nonces consumed so far, persisted so replay protection survives restarts. */
class FileNonceStore implements NonceStore {
  private readonly used: Set<string>;

  constructor(private readonly path: string) {
    this.used = new Set(readJson<string[]>(path, []));
  }

  seen(nonce: string): boolean {
    return this.used.has(nonce);
  }

  consume(nonce: string): boolean {
    mkdirSync(dirname(this.path), { recursive: true });
    const lockPath = `${this.path}.lock`;
    const temporaryPath = `${this.path}.${process.pid}.tmp`;
    const lock = openSync(lockPath, "wx", 0o600);
    let temporary: number | undefined;
    try {
      // Re-read under the cross-process lock. The constructor snapshot is only
      // an optimization and is never the replay authority.
      const current = new Set(readJson<string[]>(this.path, []));
      if (current.has(nonce)) {
        this.used.add(nonce);
        return false;
      }
      current.add(nonce);
      temporary = openSync(temporaryPath, "wx", 0o600);
      writeFileSync(temporary, `${JSON.stringify([...current], null, 2)}\n`, "utf8");
      fsyncSync(temporary);
      closeSync(temporary);
      temporary = undefined;
      renameSync(temporaryPath, this.path);
      // Persist the directory entry as well as the file contents before any
      // function side effect can execute.
      if (process.platform !== "win32") {
        const directory = openSync(dirname(this.path), "r");
        try { fsyncSync(directory); } finally { closeSync(directory); }
      }
      this.used.clear();
      for (const value of current) this.used.add(value);
      return true;
    } finally {
      if (temporary !== undefined) closeSync(temporary);
      try { unlinkSync(temporaryPath); } catch { /* no temporary file */ }
      closeSync(lock);
      unlinkSync(lockPath);
    }
  }
}

/** Hash-chained JSONL evidence, continuing the chain already on disk. */
class FileEvidence implements EvidenceSink {
  private previous: string | null = null;
  private index = 0;

  constructor(private readonly path: string) {
    if (!existsSync(path)) return;
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    this.index = lines.length;
    const last = lines.at(-1);
    if (last) {
      try {
        this.previous = (JSON.parse(last) as { hash: string }).hash;
      } catch {
        this.previous = null;
      }
    }
  }

  append(record: EvidenceRecord): void {
    const entry = { ...record, index: this.index, previous: this.previous };
    const hash = createHash("sha256").update(JSON.stringify(entry), "utf8").digest("hex");
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify({ ...entry, hash })}\n`);
    this.previous = hash;
    this.index += 1;
  }
}

/**
 * Actor -> capabilities, read from a grants file. Absent file means no
 * grants: every capability check fails closed.
 */
class FileAuthority implements AuthorityProvider {
  private readonly grants: Record<string, string[]>;

  constructor(path: string) {
    this.grants = readJson<Record<string, string[]>>(path, {});
  }

  capabilities(actor: string): string[] {
    return this.grants[actor] ?? [];
  }

  get isEmpty(): boolean {
    return Object.keys(this.grants).length === 0;
  }
}

/** `idel run.function <request.run.idel>` */
export async function runFunction(
  requestPath: string,
  options: FunctionCommandOptions,
): Promise<number> {
  const root = resolve(options.root ?? process.cwd());
  const path = resolve(requestPath);
  if (!existsSync(path)) {
    process.stderr.write(`No such run request: ${requestPath}\n`);
    return 1;
  }

  const storePath = options.storePath ?? inDir(root, "function-store.json");
  const authorityPath = options.authorityPath ?? inDir(root, "authority.json");
  const noncePath = options.noncePath ?? inDir(root, "nonces.json");
  const evidencePath = options.evidencePath ?? inDir(root, "function-evidence.jsonl");

  let resolver: FunctionResolver;
  try {
    resolver = FunctionResolver.fromDirectory(root);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 1;
  }

  const authority = new FileAuthority(authorityPath);
  if (authority.isEmpty && !options.json) {
    process.stderr.write(
      color.gray(
        `No capability grants at ${authorityPath} — every request will be refused.\n` +
          `Create it as {"user://you": ["user.create"]} to grant capabilities.\n`,
      ),
    );
  }

  const seed = readJson<Record<string, EntityRow[]>>(storePath, {});
  const store = new MemoryStore({ seed });
  const evidence = new FileEvidence(evidencePath);

  const source = readFileSync(path, "utf8");
  let request;
  try {
    request = loadRunRequest(source);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 1;
  }

  // A dry run stops after admission-shaped checks: it resolves and verifies
  // the digest but never touches the store or the evidence log.
  if (options.dryRun) {
    try {
      const resolved = resolver.resolve(request.functionRef, request.resolved);
      const report = {
        dryRun: true,
        function: resolved.definition.identity,
        version: resolved.definition.version,
        digest: resolved.definition.digest,
        mode: resolved.definition.mode,
        effects: resolved.definition.effects.map((e) => `${e.kind}:${e.entity ?? e.resource}`),
        steps: resolved.definition.steps.map((s) => `${s.kind}:${s.name}`),
      };
      process.stdout.write(
        options.json ? `${JSON.stringify(report, null, 2)}\n` : renderDryRun(report),
      );
      return 0;
    } catch (error) {
      process.stderr.write(`${(error as Error).message}\n`);
      return 4;
    }
  }

  const receipt = await runRequest(request, {
    resolver,
    store,
    evidence,
    audit: evidence,
    authority,
    nonces: new FileNonceStore(noncePath),
  });

  if (receipt.outcome === "success") writeJson(storePath, store.snapshot());

  const rendered = renderReceipt(receipt);
  if (options.receiptPath) {
    mkdirSync(dirname(resolve(options.receiptPath)), { recursive: true });
    writeFileSync(resolve(options.receiptPath), rendered);
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  } else if (receipt.outcome === "success") {
    process.stdout.write(
      `${color.gray("function")} ${receipt.function}@${receipt.version}\n` +
        `${color.gray("digest  ")} ${receipt.digest}\n` +
        `${color.gray("steps   ")} ${receipt.trace.map((t) => t.kind).join(" -> ")}\n` +
        `${color.gray("outputs ")} ${JSON.stringify(receipt.outputs)}\n` +
        `${color.gray("receipt ")} ${receipt.receiptDigest}\n`,
    );
  } else {
    process.stderr.write(`refused: ${receipt.refusal}\n`);
  }

  return receipt.outcome === "success" ? 0 : 4;
}

function renderDryRun(report: {
  function: string;
  version: string;
  digest: string;
  mode: string;
  effects: string[];
  steps: string[];
}): string {
  return (
    `${color.gray("function")} ${report.function}@${report.version}\n` +
    `${color.gray("digest  ")} ${report.digest} ${color.gray("(verified)")}\n` +
    `${color.gray("mode    ")} function.${report.mode}\n` +
    `${color.gray("effects ")} ${report.effects.join(", ") || "(none)"}\n` +
    `${color.gray("steps   ")} ${report.steps.join(" -> ")}\n` +
    `${color.gray("dry run — nothing was executed")}\n`
  );
}

/** `idel verify.execution <receipt.idel>` */
export function verifyExecution(receiptPath: string, options: FunctionCommandOptions): number {
  const path = resolve(receiptPath);
  if (!existsSync(path)) {
    process.stderr.write(`No such receipt: ${receiptPath}\n`);
    return 1;
  }
  const verification = verifyReceipt(readFileSync(path, "utf8"));
  if (options.json) {
    process.stdout.write(`${JSON.stringify(verification, null, 2)}\n`);
  } else if (verification.valid) {
    process.stdout.write(`receipt ${verification.request} verified (${verification.outcome})\n`);
  } else {
    process.stderr.write(`receipt verification failed: ${verification.reason}\n`);
  }
  return verification.valid ? 0 : 1;
}
