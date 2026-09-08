/**
 * Function resolution: identity -> definition, with digest verification.
 *
 * A resolver indexes `*.func.idel` sources by their declared identity. Lookup
 * always verifies the caller's pinned digest against the loaded content, so a
 * function whose source changed after publication fails resolution instead of
 * silently executing something else.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { loadFunction, FunctionLoadError, type FunctionDefinition } from "./model.js";

export interface ResolvedFunction {
  definition: FunctionDefinition;
  path: string;
  source: string;
}

export class FunctionResolver {
  private readonly byIdentity = new Map<string, ResolvedFunction>();

  /** Index every `*.func.idel` under a directory tree. */
  static fromDirectory(root: string): FunctionResolver {
    const resolver = new FunctionResolver();
    for (const path of collect(root)) {
      const source = readFileSync(path, "utf8");
      resolver.add(loadFunction(source), path, source);
    }
    return resolver;
  }

  add(definition: FunctionDefinition, path: string, source: string): void {
    const existing = this.byIdentity.get(definition.identity);
    if (existing && existing.definition.digest !== definition.digest) {
      throw new FunctionLoadError(
        `two different functions claim identity ${definition.identity}: ${existing.path} and ${path}`,
      );
    }
    this.byIdentity.set(definition.identity, { definition, path, source });
  }

  identities(): string[] {
    return [...this.byIdentity.keys()].sort();
  }

  /**
   * Resolve by identity (with or without an `@version` suffix). When
   * `expectedDigest` is given, a mismatch is a hard failure.
   */
  resolve(reference: string, expectedDigest?: string): ResolvedFunction {
    const identity = reference.split("@")[0] as string;
    const found = this.byIdentity.get(identity);
    if (!found) throw new FunctionLoadError(`no function published as ${identity}`);

    const requestedVersion = reference.includes("@") ? reference.split("@")[1] : undefined;
    if (
      requestedVersion &&
      !requestedVersion.startsWith("sha256:") &&
      requestedVersion !== found.definition.version
    ) {
      throw new FunctionLoadError(
        `${identity}: requested version ${requestedVersion}, published ${found.definition.version}`,
      );
    }
    const pinned = requestedVersion?.startsWith("sha256:") ? requestedVersion : expectedDigest;
    if (pinned && pinned !== found.definition.digest) {
      throw new FunctionLoadError(
        `${identity}: digest mismatch — pinned ${pinned}, content is ${found.definition.digest}`,
      );
    }
    return found;
  }
}

function collect(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) out.push(...collect(path));
    else if (entry.name.endsWith(".func.idel")) out.push(path);
  }
  return out.sort();
}
