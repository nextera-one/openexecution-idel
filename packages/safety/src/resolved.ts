/**
 * Phase 2 — resolved-real-path risk assessment.
 *
 * Runs immediately before execution, against live filesystem state. It does the
 * real `fs.realpath` / `path.resolve` that the string phase cannot: it catches
 * the cases the command string hides —
 *   - `remove.folder name=dist` where `dist` is a symlink to `/`
 *   - a cwd that is itself `/`
 *   - a relative target that *normalizes* to root/home/a device
 * — and, for destructive ops, estimates the blast radius (paths + bytes).
 *
 * TOCTOU: there is an unavoidable window between this assessment and execution.
 * The runtime takes the higher of the ast and resolved levels, but a path that
 * is swapped for a symlink-to-root *after* this check still slips through. That
 * is an acknowledged, documented risk (spec §18).
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import type {
  CommandAst,
  CommandDef,
  RiskAssessment,
  RiskFinding,
} from "@openexecution/types";

import {
  classifyTarget,
  finalize,
  isDestructive,
  readTargetString,
} from "./ast.js";
import {
  isDevicePath,
  isDriveRoot,
  isHome,
  isRoot,
  normalizeTarget,
} from "./paths.js";

/**
 * Hard cap on the number of entries we will walk when estimating the blast
 * radius of a destructive op. Walking an unbounded tree (think `node_modules`
 * or `/`) would hang the pre-execution check, so we stop at the cap and report
 * the estimate as a LOWER BOUND (see `affectedEstimateIsLowerBound`).
 */
export const WALK_ENTRY_CAP = 5000;

interface WalkResult {
  paths: number;
  bytes: number;
  /** True if we hit the cap and stopped early — estimate is a lower bound. */
  capped: boolean;
}

/**
 * Iteratively walk `root` accumulating entry count + byte size, stopping once
 * we reach {@link WALK_ENTRY_CAP} entries. Iterative (explicit stack) to avoid
 * recursion depth blow-ups on deep trees. Symlinks are NOT followed during the
 * walk (we `lstat` each entry) so we never recurse out of the target subtree.
 */
async function walkCapped(root: string): Promise<WalkResult> {
  let paths = 0;
  let bytes = 0;
  const stack: string[] = [root];

  while (stack.length > 0) {
    if (paths >= WALK_ENTRY_CAP) {
      return { paths, bytes, capped: true };
    }
    const current = stack.pop();
    if (current === undefined) break;

    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      // Unreadable dir (permissions, race) — skip; don't fail the assessment.
      continue;
    }

    for (const entry of entries) {
      if (paths >= WALK_ENTRY_CAP) {
        return { paths, bytes, capped: true };
      }
      const full = path.join(current, entry.name);
      paths += 1;
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        stack.push(full);
      } else if (entry.isFile()) {
        try {
          const st = await fs.lstat(full);
          bytes += st.size;
        } catch {
          // ignore unstattable file
        }
      }
      // Symlinks: counted as one path, not followed, size not added.
    }
  }

  return { paths, bytes, capped: false };
}

/**
 * Resolve the real path of `normalized`, following symlinks. Returns the
 * realpath plus whether the *leaf* was a symlink and where it pointed. If the
 * path does not exist yet, we fall back to resolving the nearest existing
 * ancestor (so `remove.folder name=does-not-exist` still classifies sanely).
 */
async function resolveReal(
  normalized: string,
): Promise<{ real: string; symlink?: { from: string; to: string } }> {
  let symlink: { from: string; to: string } | undefined;
  try {
    const lst = await fs.lstat(normalized);
    if (lst.isSymbolicLink()) {
      const target = await fs.readlink(normalized);
      const resolvedLink = path.resolve(path.dirname(normalized), target);
      symlink = { from: normalized, to: resolvedLink };
    }
  } catch {
    // leaf may not exist; that's fine, fall through to realpath attempt.
  }

  try {
    // realpath follows the whole chain of symlinks to the true location.
    const real = await fs.realpath(normalized);
    return { real, symlink };
  } catch {
    // Path (or part of it) doesn't exist. Resolve as far up as we can so that,
    // e.g., a target under a symlinked parent still gets the real prefix.
    let dir = path.dirname(normalized);
    const base = path.basename(normalized);
    try {
      const realDir = await fs.realpath(dir);
      return { real: path.join(realDir, base), symlink };
    } catch {
      // Nothing on this path exists; the normalized string is our best answer.
      return { real: normalized, symlink };
    }
  }
}

/**
 * Phase-2 assessment. Resolves the real filesystem path (following symlinks),
 * re-applies the shared classification rules against it, adds a `symlink-target`
 * finding when the target is/contains a symlink, and — for destructive ops —
 * estimates affected paths/bytes via a capped walk.
 */
export async function assessResolved(
  ast: CommandAst,
  def: CommandDef,
): Promise<RiskAssessment> {
  const findings: RiskFinding[] = [];
  const destructive = isDestructive(ast, def);
  const rawTarget = readTargetString(ast, def);

  // Empty target is fully decided at the string level; mirror the ast phase.
  if (destructive && (rawTarget === undefined || rawTarget.trim() === "")) {
    findings.push({
      code: "empty-target",
      level: "HIGH",
      message: "Destructive command invoked with an empty or missing target.",
    });
    return finalize("resolved", findings, def);
  }

  if (rawTarget === undefined || rawTarget.trim() === "") {
    // Non-destructive, no target — nothing path-based to resolve.
    return finalize("resolved", findings, def);
  }

  const normalized = normalizeTarget(rawTarget, ast.cwd);
  const { real, symlink } = await resolveReal(normalized);

  // If the target is (or routes through) a symlink, surface where it points and
  // classify against the REAL location. This is how `dist -> /` is caught: the
  // string says `dist`, the realpath says `/`.
  if (symlink) {
    const dangerous =
      isRoot(symlink.to) ||
      isDriveRoot(symlink.to) ||
      isHome(symlink.to) ||
      isDevicePath(symlink.to);
    findings.push({
      code: "symlink-target",
      level: dangerous ? "CRITICAL" : "MEDIUM",
      message: `Target '${rawTarget}' is a symlink pointing to ${symlink.to}${
        dangerous ? " (a protected location)" : ""
      }.`,
    });
  }

  // Re-classify against the resolved real path. We pass `real` as both the
  // normalized and (for glob/traversal purposes) keep the raw target so glob
  // and `..` heuristics still see the original authoring.
  findings.push(
    ...classifyTarget({
      ast,
      def,
      normalized: real,
      rawTarget,
      destructive,
    }),
  );

  // --- Blast-radius estimate for destructive ops -------------------------
  // Only worth walking when destructive AND the target is a directory that
  // actually exists. We cap the walk; a capped estimate is a documented lower
  // bound, not an exact count.
  if (destructive) {
    try {
      const st = await fs.lstat(real);
      if (st.isDirectory()) {
        const walk = await walkCapped(real);
        const assessment = finalize("resolved", findings, def);
        assessment.affectedPathsEstimate = walk.paths;
        assessment.affectedBytesEstimate = walk.bytes;
        if (walk.capped) {
          // Annotate that the estimate stopped at the cap (lower bound).
          assessment.findings.push({
            code: "estimate-capped",
            level: "LOW",
            message: `Affected-path estimate capped at ${WALK_ENTRY_CAP} entries; actual count is higher (lower bound reported).`,
          });
        }
        return assessment;
      }
      if (st.isFile()) {
        const assessment = finalize("resolved", findings, def);
        assessment.affectedPathsEstimate = 1;
        assessment.affectedBytesEstimate = st.size;
        return assessment;
      }
    } catch {
      // Target doesn't exist (or unstattable) — no estimate, no extra finding.
    }
  }

  return finalize("resolved", findings, def);
}
