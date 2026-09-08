import {
  parseStructure,
  StructureError,
  type Assignment,
  type Block,
  type StructureDocument,
} from "@openexecution/structure";

export interface PackageExport {
  kind: string;
  name: string;
  source: string;
}

export interface PackageManifest {
  name: string;
  version: string;
  summary: string | null;
  license: string | null;
  exports: PackageExport[];
  document: StructureDocument;
}

export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestError";
  }
}

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9a-z.-]+)?$/;

/**
 * Parse and semantically validate a package.idel manifest. Throws
 * {@link StructureError} on syntax errors and {@link ManifestError} on
 * semantic violations.
 */
export function parseManifest(source: string): PackageManifest {
  const document = parseStructure(source);
  const roots = document.entries.filter((entry) => entry.kind === "block");
  if (document.entries.length !== 1 || roots.length !== 1) {
    throw new ManifestError("a manifest contains exactly one top-level block");
  }
  const root = roots[0] as Block;
  if (root.verb !== "define.package.manifest") {
    throw new ManifestError(`expected define.package.manifest, found ${root.verb}`);
  }
  if (!root.label) {
    throw new ManifestError("define.package.manifest requires a package name label");
  }

  const assignments = new Map<string, Assignment>();
  for (const entry of root.entries) {
    if (entry.kind === "assignment") assignments.set(entry.key, entry);
  }

  const version = assignments.get("version");
  const versionArg =
    version?.value.kind === "call" && version.value.name === "semver"
      ? version.value.args[0]
      : undefined;
  if (versionArg?.kind !== "string") {
    throw new ManifestError('a manifest requires version = semver("<major>.<minor>.<patch>")');
  }
  const versionText = versionArg.value;
  if (!SEMVER.test(versionText)) {
    throw new ManifestError(`"${versionText}" is not a valid semantic version`);
  }

  const summary = assignments.get("summary");
  const license = assignments.get("license");
  if (license && (license.value.kind !== "call" || license.value.name !== "spdx")) {
    throw new ManifestError('license must be declared as spdx("<identifier>")');
  }

  const exports: PackageExport[] = [];
  for (const entry of root.entries) {
    if (entry.kind !== "block" || !entry.verb.startsWith("export.")) continue;
    if (!entry.label) {
      throw new ManifestError(`${entry.verb} requires an export name label`);
    }
    const sourceEntry = entry.entries.find(
      (child): child is Assignment => child.kind === "assignment" && child.key === "source",
    );
    const sourceArg =
      sourceEntry?.value.kind === "call" && sourceEntry.value.name === "path"
        ? sourceEntry.value.args[0]
        : undefined;
    if (sourceArg?.kind !== "string") {
      throw new ManifestError(`${entry.verb} "${entry.label}" requires source = path("…")`);
    }
    exports.push({
      kind: entry.verb.slice("export.".length),
      name: entry.label,
      source: sourceArg.value,
    });
  }

  const licenseArg = license?.value.kind === "call" ? license.value.args[0] : undefined;
  return {
    name: root.label,
    version: versionText,
    summary: summary?.value.kind === "string" ? summary.value.value : null,
    license: licenseArg?.kind === "string" ? licenseArg.value : null,
    exports,
    document,
  };
}

export { StructureError };
