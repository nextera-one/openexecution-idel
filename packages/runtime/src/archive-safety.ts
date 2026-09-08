import { spawn } from "node:child_process";
import { isAbsolute, resolve } from "node:path";

const MAX_LIST_BYTES = 8 * 1024 * 1024;
const MAX_ENTRIES = 100_000;

/** Raised before extraction when an archive can write outside its destination. */
export class UnsafeArchiveError extends Error {
  override readonly name = "UnsafeArchiveError";
}

/** Validate newline-delimited names returned by `tar -tf`. Exported for tests. */
export function validateArchiveEntryNames(listing: string): void {
  const entries = listing.split(/\r?\n/).filter(Boolean);
  if (entries.length > MAX_ENTRIES) {
    throw new UnsafeArchiveError(`archive has too many entries (${entries.length})`);
  }
  for (const raw of entries) {
    if (/\p{Cc}/u.test(raw)) {
      throw new UnsafeArchiveError("archive entry contains control characters");
    }
    const name = raw.replaceAll("\\", "/");
    if (
      name.startsWith("/") ||
      name.startsWith("//") ||
      /^[A-Za-z]:\//.test(name) ||
      name.split("/").includes("..")
    ) {
      throw new UnsafeArchiveError(`archive entry escapes the destination: ${JSON.stringify(raw)}`);
    }
  }
}

/**
 * List an archive without extracting, reject traversal/control paths and reject
 * links. Links are deliberately fail-closed because a safe-looking child path
 * can otherwise traverse through a symlink created by an earlier entry.
 */
export async function preflightArchiveExtraction(
  archive: string,
  cwd: string,
): Promise<void> {
  const archivePath = isAbsolute(archive) ? archive : resolve(cwd, archive);
  const names = await tarList(["-tf", archivePath], cwd);
  validateArchiveEntryNames(names);

  const verbose = await tarList(["-tvf", archivePath], cwd);
  for (const line of verbose.split(/\r?\n/)) {
    if (/^[lh]/.test(line) || line.includes(" -> ") || line.includes(" link to ")) {
      throw new UnsafeArchiveError("archive contains a symbolic or hard link; extraction is refused");
    }
  }
}

function tarList(argv: string[], cwd: string): Promise<string> {
  return new Promise((resolveListing, reject) => {
    const child = spawn("tar", argv, { cwd, shell: false, windowsHide: true });
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    let size = 0;
    let exceeded = false;

    child.stdout?.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_LIST_BYTES) {
        exceeded = true;
        child.kill();
        return;
      }
      chunks.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => errors.push(chunk));
    child.on("error", (error) => {
      reject(new UnsafeArchiveError(`cannot inspect archive safely: ${error.message}`));
    });
    child.on("close", (code) => {
      if (exceeded) {
        reject(new UnsafeArchiveError("archive listing exceeds the 8 MiB safety limit"));
        return;
      }
      if (code !== 0) {
        const detail = Buffer.concat(errors).toString("utf8").trim();
        reject(new UnsafeArchiveError(`cannot inspect archive safely${detail ? `: ${detail}` : ""}`));
        return;
      }
      resolveListing(Buffer.concat(chunks).toString("utf8"));
    });
  });
}
