import { canonicalBytes, compareUtf8, sha256 } from "./canonical.js";
import { manifestDigest } from "./manifest.js";
import type {
  IdelManifest,
  PackageVersionRecord,
  ResolutionResult,
} from "./model.js";
import { PackageRegistryClient } from "./registry.js";

interface Version {
  major: number;
  minor: number;
  patch: number;
  prerelease: Array<string | number>;
}

export class ResolutionError extends Error {
  override readonly name = "ResolutionError";

  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export async function resolveManifest(
  manifest: IdelManifest,
  registry: PackageRegistryClient,
  idelVersion: string,
  policyDigest = `sha256:${"0".repeat(64)}`,
): Promise<ResolutionResult> {
  const rootConstraints = new Map<string, string[]>();
  for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
    rootConstraints.set(name, [range]);
  }
  const available = new Map<string, PackageVersionRecord[]>();
  const solved = await solve(
    new Map(),
    rootConstraints,
    available,
    registry,
  );
  if (!solved) {
    throw new ResolutionError(
      "IDEL_RESOLUTION_CONFLICT",
      "no package graph satisfies all declared version constraints",
    );
  }
  const discovery = await registry.discover();
  const discoveryDigest = await registry.discoveryDigest();
  const packageEntries = [...solved.entries()].sort(([left], [right]) =>
    compareUtf8(left, right),
  );
  const records = new Map<string, PackageVersionRecord>();
  const packages: ResolutionResult["lock"]["packages"] = {};
  for (const [name, record] of packageEntries) {
    const coordinate = `${name}@${record.version}`;
    records.set(coordinate, record);
    packages[coordinate] = {
      registry: discovery.api,
      bundle: record.bundle.digest,
      publisher: record.publisher,
      signature: record.signature,
      provenance: record.provenance,
      sbom: record.sbom,
      trustLevel: record.trustLevel,
      permissionsDigest: record.permissionsDigest,
      dependencies: Object.fromEntries(
        Object.keys(record.dependencies)
          .sort(compareUtf8)
          .map((dependency) => {
            const resolved = solved.get(dependency);
            if (resolved === undefined) {
              throw new ResolutionError(
                "IDEL_RESOLUTION_INCOMPLETE_GRAPH",
                `${coordinate} dependency ${dependency} was not resolved`,
              );
            }
            return [dependency, resolved.version];
          }),
      ),
    };
  }
  return {
    lock: {
      lockVersion: 1,
      projectDigest: manifestDigest(manifest),
      registries: {
        [new URL(discovery.api).host]: { discoveryDigest },
      },
      packages,
      resolution: {
        idelVersion,
        policyDigest,
      },
    },
    records,
  };
}

async function solve(
  assignments: Map<string, PackageVersionRecord>,
  constraints: Map<string, string[]>,
  available: Map<string, PackageVersionRecord[]>,
  registry: PackageRegistryClient,
): Promise<Map<string, PackageVersionRecord> | undefined> {
  for (const [name, record] of assignments) {
    const ranges = constraints.get(name) ?? [];
    if (!ranges.every((range) => satisfies(record.version, range))) {
      return undefined;
    }
  }
  const pending = [...constraints.keys()]
    .filter((name) => !assignments.has(name))
    .sort(compareUtf8);
  if (pending.length === 0) return assignments;
  const name = pending[0]!;
  let candidates = available.get(name);
  if (!candidates) {
    candidates = (await registry.versions(name))
      .filter((record) =>
        record.lifecycle === "published" || record.lifecycle === "deprecated",
      )
      .sort((left, right) => compareVersions(right.version, left.version));
    available.set(name, candidates);
  }
  const ranges = constraints.get(name) ?? [];
  for (const candidate of candidates) {
    if (!ranges.every((range) => satisfies(candidate.version, range))) continue;
    const nextAssignments = new Map(assignments);
    nextAssignments.set(name, candidate);
    const nextConstraints = cloneConstraints(constraints);
    for (const [dependency, range] of Object.entries(candidate.dependencies)) {
      nextConstraints.set(dependency, [
        ...(nextConstraints.get(dependency) ?? []),
        range,
      ]);
    }
    const result = await solve(
      nextAssignments,
      nextConstraints,
      available,
      registry,
    );
    if (result) return result;
  }
  return undefined;
}

export function satisfies(versionText: string, rangeText: string): boolean {
  const version = parseVersion(versionText);
  return rangeText
    .split("||")
    .map((part) => part.trim())
    .some((part) => satisfiesAll(version, part));
}

export function compareVersions(leftText: string, rightText: string): number {
  return compareVersion(parseVersion(leftText), parseVersion(rightText));
}

function satisfiesAll(version: Version, range: string): boolean {
  if (range === "*" || range === "") return version.prerelease.length === 0;
  const tokens = range.split(/\s+/).filter(Boolean);
  return tokens.every((token) => satisfiesToken(version, token));
}

function satisfiesToken(version: Version, token: string): boolean {
  if (token.startsWith("^")) {
    const minimum = parseVersion(token.slice(1));
    const maximum =
      minimum.major > 0
        ? versionValue(minimum.major + 1, 0, 0)
        : minimum.minor > 0
          ? versionValue(0, minimum.minor + 1, 0)
          : versionValue(0, 0, minimum.patch + 1);
    return compareVersion(version, minimum) >= 0 && compareVersion(version, maximum) < 0;
  }
  if (token.startsWith("~")) {
    const minimum = parseVersion(token.slice(1));
    const maximum = versionValue(minimum.major, minimum.minor + 1, 0);
    return compareVersion(version, minimum) >= 0 && compareVersion(version, maximum) < 0;
  }
  const comparator = /^(>=|<=|>|<|=)?(.+)$/.exec(token);
  if (!comparator) invalidRange(token);
  const operator = comparator[1] ?? "=";
  const expectedText = comparator[2]!;
  if (/^[0-9]+(?:\.(?:[0-9]+|x|\*)){0,2}$/i.test(expectedText) &&
      /[x*]/i.test(expectedText)) {
    const parts = expectedText.split(".");
    if (parts[0] !== "*" && parts[0]?.toLowerCase() !== "x" &&
        version.major !== Number(parts[0])) return false;
    if (parts[1] !== undefined && parts[1] !== "*" && parts[1]?.toLowerCase() !== "x" &&
        version.minor !== Number(parts[1])) return false;
    if (parts[2] !== undefined && parts[2] !== "*" && parts[2]?.toLowerCase() !== "x" &&
        version.patch !== Number(parts[2])) return false;
    return version.prerelease.length === 0;
  }
  const expected = parseVersion(expectedText);
  const order = compareVersion(version, expected);
  if (operator === ">=") return order >= 0;
  if (operator === "<=") return order <= 0;
  if (operator === ">") return order > 0;
  if (operator === "<") return order < 0;
  return order === 0;
}

function parseVersion(text: string): Version {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
      text,
    );
  if (!match) invalidRange(text);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease:
      match[4] === undefined
        ? []
        : match[4].split(".").map((part) =>
            /^\d+$/.test(part) ? Number(part) : part,
          ),
  };
}

function compareVersion(left: Version, right: Version): number {
  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] !== right[key]) return left[key] - right[key];
  }
  if (left.prerelease.length === 0 && right.prerelease.length > 0) return 1;
  if (right.prerelease.length === 0 && left.prerelease.length > 0) return -1;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index++) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    if (typeof leftPart === "number" && typeof rightPart === "string") return -1;
    if (typeof leftPart === "string" && typeof rightPart === "number") return 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

function versionValue(major: number, minor: number, patch: number): Version {
  return { major, minor, patch, prerelease: [] };
}

function cloneConstraints(
  constraints: Map<string, string[]>,
): Map<string, string[]> {
  return new Map(
    [...constraints.entries()].map(([name, ranges]) => [name, [...ranges]]),
  );
}

function invalidRange(range: string): never {
  throw new ResolutionError(
    "IDEL_RESOLUTION_INVALID_RANGE",
    `unsupported semantic version range ${JSON.stringify(range)}`,
  );
}

export function resolutionDigest(result: ResolutionResult): string {
  return sha256(canonicalBytes(result.lock));
}
