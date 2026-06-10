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
 * A Windows extended-length / device prefix, if present: `\\?\`, `\\.\`, and
 * the UNC variants `\\?\UNC\`. Returns the stripped remainder plus whether the
 * prefix denoted the device namespace (`\\.\`), which `isDevicePath` cares about.
 *
 * Examples (separators may be `\` or `/`):
 *   \\?\C:\Windows      -> { rest: "C:\\Windows", device: false }
 *   \\?\UNC\srv\share   -> { rest: "\\\\srv\\share", device: false }
 *   \\.\PhysicalDrive0  -> { rest: "\\\\.\\PhysicalDrive0", device: true }
 */
function stripWinPrefix(target: string): { rest: string; device: boolean } {
  // Normalize the leading prefix detection on backslashes specifically; the
  // extended-length syntax is backslash-based even when the rest uses `/`.
  const m = target.match(/^[\\/]{2}([?.])[\\/](UNC[\\/])?(.*)$/s);
  if (!m) return { rest: target, device: false };
  const kind = m[1]; // "?" extended-length, "." device namespace
  const isUnc = Boolean(m[2]);
  const tail = m[3] ?? "";
  if (kind === ".") {
    // Device namespace: keep it recognizable as `\\.\...` so isDevicePath fires.
    return { rest: "\\\\.\\" + tail, device: true };
  }
  // Extended-length `\\?\`: `\\?\UNC\srv\share` -> `\\srv\share`; else the tail
  // is a normal rooted path like `C:\Windows`.
  return { rest: isUnc ? "\\\\" + tail : tail, device: false };
}

/** Does `p` look like a Windows-rooted path (drive, drive-relative, or UNC)? */
function isWindowsRooted(p: string): boolean {
  return (
    /^[a-zA-Z]:[\\/]/.test(p) || // C:\ or C:/
    /^[a-zA-Z]:(?![\\/])/.test(p) || // C:foo (drive-relative)
    /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(p) // \\server\share (UNC)
  );
}

/**
 * Normalize a destructive target into an absolute, `..`-collapsed path —
 * cross-platform, so a Windows-shaped target is recognized as such even when we
 * are classifying it on a POSIX host (and vice versa).
 *
 * Steps: strip any `\\?\` / `\\.\` extended-length-or-device prefix, expand a
 * leading `~`, then resolve. A Windows-rooted target (`C:\`, `C:foo`, UNC) is
 * resolved with `path.win32` semantics regardless of host — otherwise the host
 * `path.resolve` on POSIX would join `C:\` under cwd and the drive-root floor
 * would never fire. Everything else resolves against the issuing cwd.
 *
 * Drive-relative `C:foo` has no unambiguous base (its true anchor is the
 * per-drive cwd, which we don't track), so we fail closed: resolve it to the
 * drive root so it reads as escaping cwd rather than as a harmless local dir.
 *
 * NOTE: still a *string-level* normalization. It does NOT follow symlinks or
 * touch the filesystem — that is the resolved phase's job. Env vars are NOT
 * expanded here on purpose: the runtime treats unexpanded `$VAR`/`%VAR%` as
 * opaque, and we never shell out, so there is nothing to expand.
 */
export function normalizeTarget(target: string, cwd: string): string {
  const { rest } = stripWinPrefix(target);
  const expanded = expandHome(rest);
  if (isWindowsRooted(expanded)) {
    // Drive-relative `C:foo` -> anchor at the drive root, fail-closed.
    const driveRel = expanded.match(/^([a-zA-Z]:)(?![\\/])(.*)$/s);
    if (driveRel) {
      return path.win32.resolve(driveRel[1] + "\\", driveRel[2] ?? "");
    }
    return path.win32.resolve(expanded);
  }
  // POSIX / relative: path.resolve collapses `..`/`.` and anchors at cwd.
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

/**
 * Canonicalize for comparison: unify separators, strip a trailing slash, and
 * strip NTFS-style trailing dots/spaces from each segment. Windows silently
 * trims trailing dots and spaces from path components, so `C:\Windows ` and
 * `C:\test.` refer to `C:\Windows` / `C:\test`; without trimming, those evade
 * the root/escape comparisons. POSIX names legitimately can't end in `/`, and a
 * trailing dot/space is exotic enough that trimming for *classification* (never
 * for execution) is the safe, fail-closed choice.
 */
function canon(p: string): string {
  const unified = p
    .replace(/\\/g, "/")
    .split("/")
    .map((seg) => {
      // Don't collapse all-dot segments ("." / ".." / the "\\.\" device marker)
      // to empty — only trim trailing dots/spaces from segments that have other
      // content (e.g. "Windows " -> "Windows", "test." -> "test").
      if (/^[. ]*$/.test(seg)) return seg;
      return seg.replace(/[. ]+$/g, "");
    })
    .join("/");
  return unified.replace(/\/+$/g, "") || "/";
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
 * The static directory prefix of a glob target — the absolute, normalized path
 * formed by the segments BEFORE the first wildcard segment. For `/var/log/*.log`
 * this is `/var/log`; for a recursive `logs` glob it resolves `logs` against cwd;
 * for a glob whose very first segment is itself a wildcard the prefix is the cwd
 * (or root, if the target is absolute). This is the directory whose contents the
 * glob can match, so it's the right place to estimate the blast radius.
 */
export function staticGlobPrefix(rawTarget: string, cwd: string): string {
  const { rest } = stripWinPrefix(rawTarget);
  const expanded = expandHome(rest).replace(/\\/g, "/");
  const segs = expanded.split("/");
  const firstWildIdx = segs.findIndex((s) => GLOB_RE.test(s));
  // Keep the leading empty segment (from a leading "/") so the joined prefix
  // stays ABSOLUTE — otherwise normalizeTarget would re-anchor it under cwd and
  // we'd walk the wrong directory.
  const prefixSegs = segs.slice(0, firstWildIdx).filter((s, i) => i === 0 || s.length > 0);
  const joined = prefixSegs.join("/");
  if (joined.replace(/^\/+/, "").length > 0 || joined.startsWith("/")) {
    return normalizeTarget(joined || "/", cwd);
  }
  return isAbsoluteCrossPlatform(expanded) ? "/" : path.resolve(cwd);
}

/**
 * Is this a *broad* glob — one whose wildcard sits at or very near the root of
 * the path, so it could match an enormous set (e.g. `/*`, `~/*`, `C:\*`)?
 */
export function isBroadGlob(rawTarget: string, cwd: string): boolean {
  if (!hasGlob(rawTarget)) return false;
  const prefix = staticGlobPrefix(rawTarget, cwd);
  // Broad if the wildcard sits directly under root, a drive root, or home.
  return isRoot(prefix) || isDriveRoot(prefix) || isHome(prefix);
}

/** Last path segment is a dotfile / dotfolder (hidden on POSIX). */
export function isHidden(rawTarget: string): boolean {
  const base = path.basename(rawTarget.replace(/\\/g, "/"));
  return base.startsWith(".") && base !== "." && base !== "..";
}
