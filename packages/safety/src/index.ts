/**
 * @openexecution/safety — the deterministic, local (NO AI) safety engine.
 *
 * Two-phase risk classification (spec §18, §28):
 *  - {@link assessAst}      — phase "ast": classify from the parsed command +
 *                             params alone (string level). Cheap, runs early.
 *  - {@link assessResolved} — phase "resolved": classify from the REAL resolved
 *                             filesystem path immediately before execution.
 *
 * The runtime takes the HIGHER of the two via {@link maxRisk}. TOCTOU between
 * the phases is an acknowledged, documented risk.
 */

export { assessAst, isDestructive, resolveTargetParam, readTargetString } from "./ast.js";
export { classifyNetworkIntent, isNetworkCommand } from "./network.js";
export { assessResolved, WALK_ENTRY_CAP } from "./resolved.js";
export { scanNative } from "./native.js";
export { SAFETY_FLOORS } from "./floors.js";
export {
  RISK_ORDER,
  riskRank,
  higherRisk,
  levelOfFindings,
  maxRisk,
} from "./risk.js";
export {
  normalizeTarget,
  expandHome,
  homeDir,
  isRoot,
  isHome,
  isDriveRoot,
  isDevicePath,
  hasGlob,
  isBroadGlob,
  staticGlobPrefix,
  hasParentTraversal,
  isOutsideCwd,
  escapesCwd,
  isHidden,
} from "./paths.js";
