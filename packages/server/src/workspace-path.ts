import { realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

/** Canonicalize the workspace root once so symlink aliases cannot weaken checks. */
export function canonicalWorkspaceRoot(root: string): string {
  const canonical = realpathSync.native(resolve(root));
  if (!statSync(canonical).isDirectory()) {
    throw new Error(`workspace root is not a directory: ${root}`);
  }
  return canonical;
}

/** True only when candidate is the root itself or a descendant of it. */
export function isWithinWorkspace(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/**
 * Resolve an existing request cwd beneath root. Absolute paths may use a
 * filesystem alias (macOS /var, Windows short names, or a workspace symlink),
 * but their canonical target must still be inside the configured root.
 */
export function resolveWorkspaceCwd(root: string, requested?: string): string {
  rejectNul(requested);
  const lexical = requested ? resolve(root, requested) : root;
  if (!isAbsolute(requested ?? "") && !isWithinWorkspace(root, lexical)) {
    throw new Error("cwd escapes the configured workspace root");
  }
  const canonical = realpathSync.native(lexical);
  if (!isWithinWorkspace(root, canonical)) {
    throw new Error("cwd resolves outside the configured workspace root");
  }
  if (!statSync(canonical).isDirectory()) {
    throw new Error("cwd is not a directory");
  }
  return canonical;
}

/**
 * Resolve an editor file beneath a validated cwd. Editor file inputs must be
 * relative; existing symlinks and the parent of a new file are canonicalized
 * before the runtime is allowed to read or write them.
 */
export function resolveWorkspaceFile(
  root: string,
  cwd: string,
  requested: string,
  mode: "open" | "save",
): string {
  rejectNul(requested);
  if (isAbsolute(requested)) {
    throw new Error("editor file must be relative to the workspace");
  }
  const lexical = resolve(cwd, requested);
  if (!isWithinWorkspace(root, lexical)) {
    throw new Error("editor file escapes the configured workspace root");
  }

  if (mode === "open") {
    const canonical = realpathSync.native(lexical);
    if (!isWithinWorkspace(root, canonical)) {
      throw new Error("editor file resolves outside the configured workspace root");
    }
    if (!statSync(canonical).isFile()) {
      throw new Error("editor path is not a file");
    }
    return canonical;
  }

  // Existing save targets may themselves be symlinks. For a new target, its
  // existing parent is the authority that must remain inside the workspace.
  try {
    const canonical = realpathSync.native(lexical);
    if (!isWithinWorkspace(root, canonical)) {
      throw new Error("editor file resolves outside the configured workspace root");
    }
    if (!statSync(canonical).isFile()) {
      throw new Error("editor path is not a file");
    }
    return canonical;
  } catch (err) {
    if (err instanceof Error && !isMissingPathError(err)) throw err;
    const parent = realpathSync.native(dirname(lexical));
    if (!isWithinWorkspace(root, parent)) {
      throw new Error("editor file parent resolves outside the configured workspace root");
    }
    return lexical;
  }
}

function rejectNul(value: string | undefined): void {
  if (value?.includes("\0")) throw new Error("path contains a NUL byte");
}

function isMissingPathError(err: Error): boolean {
  return (err as NodeJS.ErrnoException).code === "ENOENT";
}
