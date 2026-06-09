/**
 * OpenLogWriter — the append-only audit trail (spec §23).
 *
 * One JSONL record per command. The file is *only ever appended to*; we never
 * rewrite or truncate it, so the log is tamper-evident by construction (a hole
 * in the sequence is visible). Reads slurp the whole file and return the tail —
 * fine for the modest sizes a single dev's audit log reaches; if this ever
 * needs to scale we'd add a reverse-chunked reader, but that's out of scope.
 *
 * Every record is run through {@link redact} before it touches disk, so secrets
 * never land in the log even if the caller forgot to scrub them.
 */

import { mkdir, appendFile, readFile } from "node:fs/promises";
import { dirname, join, isAbsolute } from "node:path";
import { homedir } from "node:os";

import type { OpenLogRecord } from "@openexecution/types";

import { redact } from "./redact.js";

/** Default log location: `~/.idel/logs/openlogs.jsonl`. */
const DEFAULT_REL_PATH = ".idel/logs/openlogs.jsonl";

/** Number of records `read()` returns when no limit is given. */
const DEFAULT_READ_LIMIT = 50;

export interface OpenLogWriterOptions {
  /**
   * Override the log file path. `~` is expanded to the user's home directory.
   * Relative paths are resolved against home as well, matching the default.
   */
  path?: string;
}

/**
 * Expand a leading `~` (or `~/…`) to the user's home directory and resolve the
 * result to an absolute path. Non-`~` relative paths are taken relative to home
 * so a bare `"logs/x.jsonl"` lands under the user's home, not the cwd.
 */
function resolveLogPath(input?: string): string {
  const home = homedir();
  if (!input) return join(home, DEFAULT_REL_PATH);
  if (input === "~") return home;
  if (input.startsWith("~/")) return join(home, input.slice(2));
  if (isAbsolute(input)) return input;
  return join(home, input);
}

export class OpenLogWriter {
  /** Absolute, fully-resolved path to the JSONL log file. */
  readonly path: string;

  /** Guards directory creation so we only `mkdir` once per writer instance. */
  private dirEnsured = false;

  constructor(options: OpenLogWriterOptions = {}) {
    this.path = resolveLogPath(options.path);
  }

  /** Create the parent directory (recursively) if it doesn't yet exist. */
  private async ensureDir(): Promise<void> {
    if (this.dirEnsured) return;
    await mkdir(dirname(this.path), { recursive: true });
    this.dirEnsured = true;
  }

  /**
   * Redact `record`, then append it as a single JSON line (terminated by "\n").
   * Append-only: never rewrites existing content. The caller owns the
   * `timestamp`; we write whatever we're given after redaction.
   *
   * A policy block is a normal audit event — pass a record with
   * `result: "blocked_before_execution"` and it is appended like any other.
   */
  async append(record: OpenLogRecord): Promise<void> {
    await this.ensureDir();
    const safe = redact(record);
    await appendFile(this.path, JSON.stringify(safe) + "\n", "utf8");
  }

  /**
   * Return the last `limit` records (default 50), in file (chronological)
   * order. Tolerates a malformed trailing line (e.g. a partial write that was
   * interrupted) and any other unparseable lines, which are skipped silently.
   * A missing file reads as empty.
   */
  async read(limit: number = DEFAULT_READ_LIMIT): Promise<OpenLogRecord[]> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }

    const records: OpenLogRecord[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        records.push(JSON.parse(trimmed) as OpenLogRecord);
      } catch {
        // Skip malformed lines (e.g. an interrupted trailing write) rather
        // than failing the whole read — the audit log must stay legible.
      }
    }

    if (limit <= 0) return [];
    return records.length > limit ? records.slice(records.length - limit) : records;
  }
}
