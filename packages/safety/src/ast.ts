/**
 * Phase 1 — AST-level risk assessment.
 *
 * Classifies risk from the parsed command + params alone, at the string level.
 * Cheap, runs early. It normalizes the target path (without touching the
 * filesystem) and applies the deterministic detection rules. The resolved phase
 * ({@link ./resolved}) re-runs the same core logic against the *real* path and
 * the two are combined via {@link maxRisk}.
 */

import type {
  AnyAst,
  CommandAst,
  CommandDef,
  NativeCommandAst,
  ParamValue,
  RiskAssessment,
  RiskFinding,
} from "@openexecution/types";
import { isNativeAst } from "@openexecution/types";

import { scanNative } from "./native.js";
import { SAFETY_FLOORS } from "./floors.js";
import {
  hasGlob,
  hasParentTraversal,
  isBroadGlob,
  isDevicePath,
  isDriveRoot,
  isHidden,
  isHome,
  isOutsideCwd,
  isRoot,
  normalizeTarget,
} from "./paths.js";
import { levelOfFindings, riskRank } from "./risk.js";

/**
 * Param names that may hold the primary filesystem target, in priority order.
 * Used as a fallback when a CommandDef does not declare `safety.targetParam`.
 * `to` is the destination for move/copy and is the relevant target for those.
 */
const TARGET_PARAM_FALLBACKS = ["name", "path", "target", "to", "destination"] as const;

/**
 * Command verb prefixes that imply a destructive operation, used to infer
 * destructiveness when no CommandDef is available (native / unmapped commands).
 */
const DESTRUCTIVE_PREFIXES = ["remove.", "delete.", "move.", "rename.", "trash."] as const;

/** Verb prefixes that change permissions (chmod-like). */
const PERMISSION_PREFIXES = ["permission.", "chmod.", "acl."] as const;

// ---------------------------------------------------------------------------
// Param extraction
// ---------------------------------------------------------------------------

/** Resolve the param name that holds the target for this command. */
export function resolveTargetParam(ast: CommandAst, def?: CommandDef): string | undefined {
  const declared = def?.safety?.targetParam;
  if (declared) return declared;
  for (const name of TARGET_PARAM_FALLBACKS) {
    if (name in ast.params || name in ast.rawParams) return name;
  }
  return undefined;
}

/** Read the raw (pre-coercion) target string for this command, if any. */
export function readTargetString(ast: CommandAst, def?: CommandDef): string | undefined {
  const param = resolveTargetParam(ast, def);
  if (!param) return undefined;
  // Prefer the raw string (preserves `~`, globs, trailing slashes); fall back
  // to the coerced value rendered as a string.
  if (param in ast.rawParams) {
    const raw = ast.rawParams[param];
    return raw;
  }
  const coerced = ast.params[param];
  return coerced === undefined ? undefined : String(coerced);
}

/** Is this command destructive? def hint first, then verb-prefix inference. */
export function isDestructive(ast: CommandAst, def?: CommandDef): boolean {
  if (def?.safety?.destructive !== undefined) return def.safety.destructive;
  return DESTRUCTIVE_PREFIXES.some((p) => ast.command.startsWith(p));
}

/** Is this a permission/chmod-style command? */
function isPermissionCommand(ast: CommandAst): boolean {
  return PERMISSION_PREFIXES.some((p) => ast.command.startsWith(p));
}

/** Coerce a param to boolean truthiness (handles string "true"/"false"). */
function boolParam(v: ParamValue | undefined): boolean {
  if (v === undefined) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v === "true" || v === "1";
  return v !== 0;
}

function readBool(ast: CommandAst, name: string): boolean {
  if (name in ast.params) return boolParam(ast.params[name]);
  if (name in ast.rawParams) return boolParam(ast.rawParams[name]);
  return false;
}

/** Read the permission mode (e.g. "777") from params, if present. */
function readMode(ast: CommandAst): string | undefined {
  const v = ast.params["mode"] ?? ast.rawParams["mode"];
  return v === undefined ? undefined : String(v);
}

function isMode777(mode: string | undefined): boolean {
  if (!mode) return false;
  // Accept "777", "0777", and symbolic "a+rwx".
  return /^0?777$/.test(mode) || mode === "a+rwx";
}

// ---------------------------------------------------------------------------
// Shared classification — used by BOTH phases.
// ---------------------------------------------------------------------------

/** Inputs the resolved phase passes in once it has the *real* path. */
export interface ClassifyInput {
  ast: CommandAst;
  def?: CommandDef;
  /** Normalized absolute target (string-level for ast, realpath for resolved). */
  normalized: string;
  /** Raw target string as authored. */
  rawTarget: string;
  /** True if this op is destructive. */
  destructive: boolean;
}

/**
 * Apply the deterministic location-based rules to an already-normalized target.
 * Shared so the ast and resolved phases agree on what `/`, home, a device, a
 * drive root, recursive+force, chmod 777, globs and cwd-escape mean.
 */
export function classifyTarget(input: ClassifyInput): RiskFinding[] {
  const { ast, normalized, rawTarget, destructive } = input;
  const findings: RiskFinding[] = [];

  const recursive = readBool(ast, "recursive");
  const force = readBool(ast, "force");
  const permission = isPermissionCommand(ast);
  const mode = readMode(ast);

  // --- Device write (any op writing to a raw device) — CRITICAL ----------
  // Device writes are catastrophic for disk.write / native dd alike; we flag
  // regardless of `destructive` because writing a device IS destruction.
  if (isDevicePath(normalized) || isDevicePath(rawTarget)) {
    findings.push({
      code: "device-write",
      level: "CRITICAL",
      message: `Target is a raw device path (${normalized}); writing destroys the underlying disk.`,
    });
  }

  if (destructive) {
    // --- Root / drive-root / home — CRITICAL ----------------------------
    if (isRoot(normalized)) {
      findings.push({
        code: "root-delete",
        level: "CRITICAL",
        message: `Destructive target resolves to the filesystem root (${normalized}).`,
      });
    } else if (isDriveRoot(normalized)) {
      findings.push({
        code: "drive-root-delete",
        level: "CRITICAL",
        message: `Destructive target resolves to a drive/share root (${normalized}).`,
      });
    }
    if (isHome(normalized)) {
      findings.push({
        code: "home-delete",
        level: "CRITICAL",
        message: `Destructive target resolves to the user home directory (${normalized}).`,
      });
    }

    // --- Permission recursive 777 on a broad target — CRITICAL ----------
    if (permission && recursive && isMode777(mode)) {
      const broad = isRoot(normalized) || isDriveRoot(normalized) || isHome(normalized);
      findings.push({
        code: broad ? "recursive-chmod-777-broad" : "recursive-chmod-777",
        level: broad ? "CRITICAL" : "HIGH",
        message: broad
          ? `Recursive chmod 777 on a broad target (${normalized}).`
          : `Recursive chmod 777 on ${normalized}.`,
      });
    } else if (permission && recursive) {
      // Recursive permission change on a real tree — HIGH.
      findings.push({
        code: "recursive-permission",
        level: "HIGH",
        message: `Recursive permission change on ${normalized}.`,
      });
    }

    // --- Recursive + force together — HIGH ------------------------------
    if (recursive && force) {
      findings.push({
        code: "recursive-force",
        level: "HIGH",
        message: `Destructive op uses recursive + force together on ${normalized}.`,
      });
    } else if (recursive) {
      // Recursive deletion of a (non-trivial) dir — HIGH. The resolved phase
      // may downgrade-by-omission for trivially small/empty dirs, but at the
      // ast level we cannot know size, so recursive delete is HIGH.
      findings.push({
        code: "recursive-delete",
        level: "HIGH",
        message: `Recursive deletion of a directory (${normalized}).`,
      });
    }

    // --- Glob / wildcard in a destructive target ------------------------
    if (hasGlob(rawTarget)) {
      const broad = isBroadGlob(rawTarget, ast.cwd);
      findings.push({
        code: broad ? "broad-glob" : "glob-target",
        level: broad ? "HIGH" : "MEDIUM",
        message: broad
          ? `Destructive target uses a broad glob near root/home (${rawTarget}).`
          : `Destructive target contains a wildcard/glob (${rawTarget}).`,
      });
    }

    // --- Parent traversal escaping cwd ----------------------------------
    if (hasParentTraversal(rawTarget) && isOutsideCwd(normalized, ast.cwd)) {
      findings.push({
        code: "parent-traversal",
        level: "HIGH",
        message: `Destructive target uses '..' to escape cwd, resolving to ${normalized}.`,
      });
    } else if (
      isOutsideCwd(normalized, ast.cwd) &&
      !isRoot(normalized) &&
      !isHome(normalized) &&
      !isDriveRoot(normalized)
    ) {
      // Destructive op outside cwd (but not root/home) — MEDIUM.
      findings.push({
        code: "outside-cwd",
        level: "MEDIUM",
        message: `Destructive target is outside the working directory (${normalized}).`,
      });
    }

    // --- Hidden / dotfile target (informational; does not escalate) -----
    if (isHidden(rawTarget)) {
      findings.push({
        code: "hidden-target",
        level: "LOW",
        message: `Target is a hidden (dot) path (${rawTarget}).`,
      });
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Public AST-phase entry point
// ---------------------------------------------------------------------------

/**
 * Phase-1 assessment. For native commands, runs the string danger scanner. For
 * IDEL commands, normalizes the (string-level) target and applies the shared
 * classification rules. The result's `level` is the max of all findings and the
 * command's `riskDefault` floor (a command declared HIGH never reports LOW).
 */
export function assessAst(ast: AnyAst, def?: CommandDef): RiskAssessment {
  const findings: RiskFinding[] = [];

  if (isNativeAst(ast)) {
    findings.push(...scanNative(ast.native));
    // Native commands also get a baseline: an unmatched native command is
    // MEDIUM by convention (passthrough is inherently less audited), unless a
    // catastrophe pattern already pushed it higher.
    const baseline: RiskFinding = {
      code: "native-passthrough",
      level: "MEDIUM",
      message: "Native passthrough command (not registry-classified).",
    };
    findings.push(baseline);
    return finalize("ast", findings, def);
  }

  const destructive = isDestructive(ast, def);
  const rawTarget = readTargetString(ast, def);

  // --- Empty / missing target on a destructive verb — BLOCK/HIGH --------
  if (destructive && (rawTarget === undefined || rawTarget.trim() === "")) {
    findings.push({
      code: "empty-target",
      level: "HIGH",
      message: "Destructive command invoked with an empty or missing target.",
    });
    return finalize("ast", findings, def);
  }

  if (rawTarget !== undefined && rawTarget.trim() !== "") {
    const normalized = normalizeTarget(rawTarget, ast.cwd);
    findings.push(
      ...classifyTarget({ ast, def, normalized, rawTarget, destructive }),
    );
  }

  return finalize("ast", findings, def);
}

/**
 * Combine findings into an assessment, applying the command's declared
 * `riskDefault` as a floor so a registry-stated risk is never under-reported.
 */
export function finalize(
  phase: "ast" | "resolved",
  findings: RiskFinding[],
  def?: CommandDef,
): RiskAssessment {
  applySafetyFloors(findings);
  let level = levelOfFindings(findings);
  if (def?.riskDefault && riskRank(def.riskDefault) > riskRank(level)) {
    // riskDefault is a floor, not a ceiling. Keep it as a real finding when it
    // raises the level so downstream merged assessments do not lose the floor.
    findings.push({
      code: "risk-default",
      level: def.riskDefault,
      message: `Command default risk is ${def.riskDefault}.`,
    });
    level = def.riskDefault;
  }
  return { phase, level, findings };
}

function applySafetyFloors(findings: RiskFinding[]): void {
  for (const finding of findings) {
    const floor = SAFETY_FLOORS.find((f) => f.code === finding.code);
    if (floor && riskRank(floor.level) > riskRank(finding.level)) {
      finding.level = floor.level;
      finding.message = `${finding.message} Safety floor: ${floor.description}`;
    }
  }
}
