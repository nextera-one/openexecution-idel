/**
 * @openexecution/registry — public surface.
 *
 * The registry loads command definitions (the product's command content),
 * validates them against a hand-rolled schema (fail closed), resolves a command
 * name across the custom > official > core layers, and performs the
 * schema-driven parameter coercion the parser deferred.
 *
 * See spec §14 (registry), §15 (schema + coercion), §16 (core defs),
 * §21 (extraArgs rules), §28 (fail closed).
 */

// Schema validation
export {
  checkCommandDef,
  validateCommandDef,
  PARAM_TYPES,
  RISK_LEVELS,
  ADAPTER_NAMES,
  ADAPTER_KINDS,
  SUPPORT_STATUSES,
  ID_RE,
  VERSION_RE,
  META_CATEGORY,
} from "./schema.js";
export type { ValidationResult } from "./schema.js";

// Loader / registry
export {
  Registry,
  findCoreDir,
  loadLayerFromDir,
} from "./loader.js";
export type {
  RegistryOptions,
  LoadProblem,
  LoadLayerResult,
} from "./loader.js";

// Coercion
export { coerceParams } from "./coerce.js";
export type { CoerceResult } from "./coerce.js";

// Signing (promoted "official" layer integrity)
export {
  canonicalizeDef,
  sha256Hex,
  signDef,
  verifyDef,
  isSignedRegistryEntry,
  REGISTRY_ENVELOPE_VERSION,
  REGISTRY_MANIFEST_VERSION,
  REGISTRY_TRUST_STORE_VERSION,
} from "./signing.js";
export type {
  SignedRegistryEntry,
  SignedRegistryManifest,
  SignedRegistryPayload,
  RegistryPromotionProvenance,
  RegistryTrustStore,
  TrustedRegistryKey,
  SigningKey,
  DefSignature,
  VerifyDefResult,
  VerifyDefFailure,
} from "./signing.js";
