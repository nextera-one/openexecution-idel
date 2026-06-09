/**
 * Path normalization helpers for the safety engine.
 *
 * These are intentionally *pure string/path* operations (the resolved phase
 * layers real fs calls on top). They must behave sensibly for both POSIX and
 * Windows-style targets, because a command string authored on one platform may
 * be classified on another, and because the danger of `C:\` or `/` is the same
 * regardless of the host we happen to be running on.
 */

import os from "node:os";
import path from "node:path";

/** Home directory of the current user (absolute). */
export function homeDir(): string {
  return os.homedir();
}

/**
 * Expand a leading `~` or `~/...` to the user's home directory.
 * Only a *leading* tilde is expanded (matching shell semantics); a tilde in
 * the middle of a path is left untouched.
 */
export function expandHome(target: string, home: string = homeDir()): string {
  if (target === "~") return home;
  if (target.startsWith("~/") || target.startsWith("~\\")) {
    return path.join(home, target.slice(2));
  }
  return target;
}

/**
 * Normalize a destructive target into an absolute, `..`-collapsed path.
 *
 * Steps: expand a leading `~`, then `path.resolve(cwd, target)` which both
 * makes it absolute relative to the issuing cwd and collapses `.`/`..`.
 *
 * NOTE: this is a *string-level* normalization. It does NOT follow symlinks or
 * touch the filesystem — that is the resolved phase's job. Env vars are NOT
 * expanded here on purpose: the runtime treats unexpanded `$VAR`/`%VAR%` as
 * opaque, and we never shell out, so there is nothing to expand.
 */
export function normalizeTarget(target: string, cwd: string): string {
  const expanded = expandHome(target);
  // path.resolve already collapses `..` and `.` segments and yields an
  // absolute path anchored at `cwd` when `expanded` is relative.
  return path.resolve(cwd, expanded);
}

/**
 * Is this an absolute path? Accepts both POSIX (`/x`) and Windows (`C:\x`,
 * `\\server\share`) forms regardless of the host platform, since we may be
 * classifying a foreign command string.
 */
export function isAbsoluteCrossPlatform(p: string): boolean {
  if (path.posix.isAbsolute(p)) return true;
  if (path.win32.isAbsolute(p)) return true;
  return false;
}

/** Normalize separators + lowercase a Windows drive letter for comparison. */
function canon(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/g, "") || "/";
}

/**
 * Is `p` the filesystem root `/`? After normalization, root may render as ``
 * (path.resolve of `/` is `/` on POSIX), so we test the canonical form.
 */
export function isRoot(p: string): boolean {
  const c = canon(p);
  return c === "/" || c === "";
}

/**
 * Is `p` a drive root? Matches POSIX root and Windows drive roots like
 * `C:\`, `C:/`, `C:` (bare drive). UNC share roots `\\server\share` also count
 * as a drive-root-equivalent: deleting one wipes a whole share.
 */
export function isDriveRoot(p: string): boolean {
  if (isRoot(p)) return true;
  const c = canon(p);
  // C:/  or  C:  (bare drive letter, possibly with trailing slash already trimmed)
  if (/^[a-zA-Z]:$/.test(c)) return true;
  if (/^[a-zA-Z]:\/$/.test(c + "/")) return true; // defensive; canon trims trailing /
  // UNC root: //server/share  (exactly two segments after the leading //)
  const unc = c.match(/^\/\/[^/]+\/[^/]+$/);
  if (unc) return true;
  return false;
}

/**
 * Is `p` (already normalized) the user's home directory exactly?
 * We compare the canonical forms so `/home/u/` and `/home/u` match.
 */
export function isHome(p: string, home: string = homeDir()): boolean {
  return canon(p) === canon(home);
}

/**
 * Is `p` a raw device path (block/char device or physical drive)? Writing to
 * one of these (e.g. `dd of=/dev/sda`) destroys the underlying disk.
 *
 * Patterns:
 *  - POSIX whole disks / partitions: /dev/sd*, /dev/nvme*, /dev/hd*, /dev/vd*,
 *    /dev/mmcblk*, /dev/disk* (macOS), /dev/loop*
 *  - Windows raw devices: \\.\PhysicalDriveN, \\.\C:
 */
export function isDevicePath(p: string): boolean {
  const c = canon(p);
  // POSIX block/char devices that map to real storage.
  if (/^\/dev\/(sd[a-z]|nvme\d|hd[a-z]|vd[a-z]|mmcblk\d|disk\d|loop\d)/i.test(c)) {
    return true;
  }
  // Windows raw device namespace, e.g. \\.\PhysicalDrive0  ->  //./physicaldrive0
  if (/^\/\/\.\/(physicaldrive\d+|[a-z]:)/i.test(c)) {
    return true;
  }
  return false;
}

/**
 * Does the *original, pre-normalization* target contain a parent traversal
 * (`..`) segment? Used to flag destructive ops that climb out of cwd.
 */
export function hasParentTraversal(rawTarget: string): boolean {
  const parts = rawTarget.replace(/\\/g, "/").split("/");
  return parts.some((seg) => seg === "..");
}

/**
 * Does the normalized target escape the issuing cwd? True when `target` is not
 * `cwd` itself and not contained within it. Both are canonicalized first.
 */
export function escapesCwd(normalizedTarget: string, cwd: string): boolean {
  const t = canon(normalizedTarget);
  const c = canon(path.resolve(cwd));
  if (t === c) return false;
  return !t.startsWith(c + "/");
}

/**
 * Does the normalized target lie outside the issuing cwd (including being a
 * sibling / ancestor)? Same as {@link escapesCwd} but named for the MEDIUM
 * "outside cwd" rule.
 */
export function isOutsideCwd(normalizedTarget: string, cwd: string): boolean {
  return escapesCwd(normalizedTarget, cwd);
}

/** Glob/wildcard metacharacters that broaden a destructive target. */
const GLOB_RE = /[*?[\]]|\{[^}]*\}/;

/** Does the *raw* target contain a glob/wildcard? */
export function hasGlob(rawTarget: string): boolean {
  return GLOB_RE.test(rawTarget);
}

/**
 * Is this a *broad* glob — one whose wildcard sits at or very near the root of
 * the path, so it could match an enormous set (e.g. `/*`, `~/*`, `C:\*`)?
 */
export function isBroadGlob(rawTarget: string, cwd: string): boolean {
  if (!hasGlob(rawTarget)) return false;
  const expanded = expandHome(rawTarget).replace(/\\/g, "/");
  // The directory portion before the first wildcard segment.
  const segs = expanded.split("/");
  const firstWildIdx = segs.findIndex((s) => GLOB_RE.test(s));
  const prefixSegs = segs.slice(0, firstWildIdx).filter((s) => s.length > 0);
  // Resolve the static prefix against cwd to see how high up it is.
  const prefix = prefixSegs.length
    ? path.resolve(cwd, prefixSegs.join("/"))
    : (isAbsoluteCrossPlatform(expanded) ? "/" : cwd);
  // Broad if the wildcard sits directly under root, a drive root, or home.
  return isRoot(prefix) || isDriveRoot(prefix) || isHome(prefix);
}

/** Last path segment is a dotfile / dotfolder (hidden on POSIX). */
export function isHidden(rawTarget: string): boolean {
  const base = path.basename(rawTarget.replace(/\\/g, "/"));
  return base.startsWith(".") && base !== "." && base !== "..";
}
