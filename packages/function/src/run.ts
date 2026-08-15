/**
 * Admission and execution of a signed run request, plus receipt emission.
 *
 * Admission order is deliberate and fails closed at the first gate:
 *
 *   nonce/expiry -> digest -> capabilities -> inputs -> execute
 *
 * Replay is checked before anything expensive; the digest is verified before a
 * single step runs; capabilities are checked before inputs so an unauthorized
 * caller learns nothing about the input schema from error messages.
 */

import { createHash } from "node:crypto";

import { canonicalize, parseStructure, quoteStructureString } from "@openexecution/structure";

import { buildHandles, type EvidenceSink, type DataStore } from "./handles.js";
import { executeFunction, type ExecutionTrace } from "./execute.js";
import { FunctionResolver } from "./resolver.js";
import { loadRunRequest, type FunctionDefinition, type RunRequest } from "./model.js";
import { RefusalError, validateInputs, type IdelValue } from "./values.js";

/** Records consumed nonces. A run request may be admitted at most once. */
export interface NonceStore {
  seen(nonce: string): boolean | Promise<boolean>;
  /** Atomically records a nonce, returning false when it was already present. */
  consume(nonce: string): boolean | Promise<boolean>;
}

export class MemoryNonceStore implements NonceStore {
  private readonly used = new Set<string>();
  seen(nonce: string): boolean {
    return this.used.has(nonce);
  }
  consume(nonce: string): boolean {
    if (this.used.has(nonce)) return false;
    this.used.add(nonce);
    return true;
  }
}

/** Capabilities an actor holds. Stands in for IDEL Key authority resolution. */
export interface AuthorityProvider {
  capabilities(actor: string): string[] | Promise<string[]>;
}

export class StaticAuthority implements AuthorityProvider {
  constructor(private readonly grants: Record<string, string[]>) {}
  capabilities(actor: string): string[] {
    return this.grants[actor] ?? [];
  }
}

/** Grants every capability. Development only; never a production default. */
export class OpenAuthority implements AuthorityProvider {
  capabilities(): string[] {
    return ["*"];
  }
}

export interface RunDependencies {
  resolver: FunctionResolver;
  store: DataStore;
  evidence: EvidenceSink;
  /** Mandatory admission/refusal audit sink, independent of declared function effects. */
  audit: EvidenceSink;
  authority: AuthorityProvider;
  /** Required replay authority; callers choose its durable or in-memory scope. */
  nonces: NonceStore;
  now?: () => number;
  timestamp?: () => string;
}

export interface ExecutionReceipt {
  request: string;
  function: string;
  version: string;
  digest: string;
  actor: string;
  nonce: string;
  inputDigest: string;
  outcome: "success" | "refused";
  refusal?: string;
  outputs: Record<string, IdelValue>;
  trace: ExecutionTrace[];
  evidenceRequired: boolean;
  startedAt: string;
  completedAt: string;
  receiptDigest: string;
}

const canonicalInput = (inputs: Record<string, IdelValue>): string =>
  JSON.stringify(Object.fromEntries(Object.entries(inputs).sort(([a], [b]) => a.localeCompare(b))));

const digestOf = (text: string): string => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;

/**
 * The receipt digest covers the canonical bytes of the receipt document with
 * the digest line itself removed — the same value {@link verifyReceipt}
 * recomputes, so sealing and verification cannot drift apart.
 */
function sealReceipt(receipt: Omit<ExecutionReceipt, "receiptDigest">): ExecutionReceipt {
  const body = renderReceiptBody(receipt);
  return { ...receipt, receiptDigest: digestOf(canonicalize(parseStructure(body))) };
}

/** Execute a parsed run request. Refusals return a receipt; they do not throw. */
export async function runRequest(
  request: RunRequest,
  dependencies: RunDependencies,
): Promise<ExecutionReceipt> {
  const now = dependencies.now ?? (() => Date.now());
  const timestamp = dependencies.timestamp ?? (() => new Date().toISOString());
  const nonces = dependencies.nonces;
  const startedAt = timestamp();

  const base = {
    request: request.name,
    function: request.functionIdentity,
    actor: request.actor,
    nonce: request.nonce,
    inputDigest: digestOf(canonicalInput(request.inputs as Record<string, IdelValue>)),
    evidenceRequired: request.evidenceRequired,
    startedAt,
  };
  const auditReceipt = async (receipt: ExecutionReceipt): Promise<ExecutionReceipt> => {
    await dependencies.audit.append({
      event: receipt.outcome === "success" ? "function.request.executed" : "function.request.refused",
      subject: receipt.receiptDigest,
      actor: receipt.actor,
      resource: "openlogs://function-admission",
      timestamp: receipt.completedAt,
    });
    return receipt;
  };
  const refuse = (reason: string, version = "", digest = ""): Promise<ExecutionReceipt> =>
    auditReceipt(sealReceipt({
      ...base,
      version,
      digest,
      outcome: "refused",
      refusal: reason,
      outputs: {},
      trace: [],
      completedAt: timestamp(),
    }));

  // 1. Replay protection.
  if (request.singleUse && (await nonces.seen(request.nonce))) return refuse("nonce_replayed");
  if (Date.parse(request.validUntil) <= now()) return refuse("request_expired");

  // 2. Resolution and digest verification.
  let definition: FunctionDefinition;
  try {
    definition = dependencies.resolver.resolve(request.functionRef, request.resolved).definition;
  } catch (error) {
    return refuse((error as Error).message);
  }

  // 3. Capability admission: the actor must hold every capability the
  //    function requires and every capability the request itself claims.
  const held = new Set(await dependencies.authority.capabilities(request.actor));
  const holdsAll = held.has("*");
  const required = new Set([
    ...definition.capabilities.map((entry) => entry.name),
    ...request.requiredCapabilities,
  ]);
  for (const capability of required) {
    if (!holdsAll && !held.has(capability)) {
      return refuse(`capability_denied:${capability}`, definition.version, definition.digest);
    }
  }

  // `seen()` is an early rejection only. The atomic consume below closes the
  // check/use race between concurrent requests that both passed that check.
  if (request.singleUse && !(await nonces.consume(request.nonce))) {
    return refuse("nonce_replayed", definition.version, definition.digest);
  }

  // 4. Inputs, then execution.
  try {
    const inputs = validateInputs(definition.inputs, request.inputs);
    const result = await executeFunction({
      definition,
      handles: buildHandles(definition, dependencies),
      inputs,
      actor: request.actor,
      invoker: {
        invoke: async (identity, resolvedDigest, nestedInputs) => {
          const nested = dependencies.resolver.resolve(identity, resolvedDigest).definition;
          const nestedResult = await executeFunction({
            definition: nested,
            handles: buildHandles(nested, dependencies),
            inputs: validateInputs(
              nested.inputs,
              nestedInputs as Record<string, string | number | boolean>,
            ),
            actor: request.actor,
            ...(dependencies.now ? { now: dependencies.now } : {}),
            ...(dependencies.timestamp ? { timestamp: dependencies.timestamp } : {}),
          });
          return nestedResult.outputs;
        },
      },
      ...(dependencies.now ? { now: dependencies.now } : {}),
      ...(dependencies.timestamp ? { timestamp: dependencies.timestamp } : {}),
    });

    return auditReceipt(sealReceipt({
      ...base,
      version: definition.version,
      digest: definition.digest,
      outcome: "success",
      outputs: result.outputs,
      trace: result.trace,
      completedAt: timestamp(),
    }));
  } catch (error) {
    if (error instanceof RefusalError) {
      return refuse(error.reason, definition.version, definition.digest);
    }
    throw error;
  }
}

/** Convenience: load a `*.run.idel` source and execute it. */
export async function runRequestSource(
  source: string,
  dependencies: RunDependencies,
): Promise<ExecutionReceipt> {
  return runRequest(loadRunRequest(source), dependencies);
}

/** Render a receipt as an IDEL Structure document (`*.receipt.idel`). */
export function renderReceipt(receipt: ExecutionReceipt): string {
  return `${renderReceiptBody(receipt).trimEnd()}\n`.replace(
    /\n}\n$/,
    `\n  receipt_digest = digest("${receipt.receiptDigest}")\n}\n`,
  );
}

/** The receipt document *without* its digest line — the sealed payload. */
function renderReceiptBody(receipt: Omit<ExecutionReceipt, "receiptDigest">): string {
  const lines = [
    "@idel 1.0",
    "",
    `define.execution.receipt ${quoteStructureString(receipt.request)} {`,
    `  function = idel(${quoteStructureString(receipt.function)})`,
    `  version = semver(${quoteStructureString(receipt.version)})`,
    `  digest = digest(${quoteStructureString(receipt.digest)})`,
    `  actor = idelkey(${quoteStructureString(receipt.actor)})`,
    `  nonce = nonce(${quoteStructureString(receipt.nonce)})`,
    `  input_digest = digest(${quoteStructureString(receipt.inputDigest)})`,
    `  outcome = outcome.${receipt.outcome}`,
  ];
  if (receipt.refusal) lines.push(`  refusal = refuse(${quoteStructureString(receipt.refusal)})`);
  lines.push(`  started_at = timestamp(${quoteStructureString(receipt.startedAt)})`);
  lines.push(`  completed_at = timestamp(${quoteStructureString(receipt.completedAt)})`);
  for (const [field, value] of Object.entries(receipt.outputs)) {
    lines.push(`  record.output.field ${quoteStructureString(field)} {`);
    lines.push(`    value = ${typeof value === "string" ? quoteStructureString(value) : String(value)}`);
    lines.push("  }");
  }
  for (const entry of receipt.trace) {
    lines.push(`  record.execution.step ${quoteStructureString(entry.step)} {`);
    lines.push(`    kind = step.${entry.kind}`);
    lines.push("  }");
  }
  lines.push("}");
  return `${lines.join("\n")}\n`;
}

export interface ReceiptVerification {
  valid: boolean;
  reason?: string;
  request?: string;
  outcome?: string;
}

/**
 * Verify a rendered receipt: it must parse, and its stated receipt digest must
 * match a recomputation over the canonical body with that line removed.
 */
export function verifyReceipt(source: string): ReceiptVerification {
  let stated: string | undefined;
  try {
    const document = parseStructure(source);
    const root = document.entries.find(
      (entry) => entry.kind === "block" && entry.verb === "define.execution.receipt",
    );
    if (!root || root.kind !== "block") return { valid: false, reason: "not_a_receipt" };
    for (const entry of root.entries) {
      if (entry.kind === "assignment" && entry.key === "receipt_digest" && entry.value.kind === "call") {
        const arg = entry.value.args[0];
        if (arg?.kind === "string") stated = arg.value;
      }
    }
    if (!stated) return { valid: false, reason: "missing_receipt_digest" };

    const body = canonicalize(
      parseStructure(source.replace(/^\s*receipt_digest = digest\("[^"]*"\)\n/m, "")),
    );
    const recomputed = digestOf(body);
    const outcomeEntry = root.entries.find(
      (entry) => entry.kind === "assignment" && entry.key === "outcome",
    );
    const result: ReceiptVerification = {
      valid: recomputed === stated,
      request: root.label ?? undefined,
    };
    if (outcomeEntry?.kind === "assignment" && outcomeEntry.value.kind === "token") {
      result.outcome = outcomeEntry.value.name.replace("outcome.", "");
    }
    if (!result.valid) result.reason = "digest_mismatch";
    return result;
  } catch (error) {
    return { valid: false, reason: (error as Error).message };
  }
}
