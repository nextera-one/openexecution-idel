import { readFile } from "node:fs/promises";

import {
  parseStructure,
  type StructureCommand,
  type StructureConstructor,
  type StructureEnum,
  type StructureValue,
} from "@openexecution/structure";

import { compareUtf8 } from "./canonical.js";
import { manifestDigest } from "./manifest.js";
import {
  IDEL_LOCK_VERSION,
  type IdelLock,
  type IdelManifest,
  type LockedPackage,
  type TrustLevel,
} from "./model.js";

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const TRUST_LEVELS = new Set<TrustLevel>(["L0", "L1", "L2", "L3", "L4"]);
const EXACT_COORDINATE =
  /^@[a-z0-9-]{1,64}\/[a-z0-9-]{1,64}@(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;

export class LockValidationError extends Error {
  override readonly name = "LockValidationError";

  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export async function loadLock(path: string): Promise<IdelLock> {
  return parseLock(await readFile(path, "utf8"));
}

export function parseLock(text: string): IdelLock {
  try {
    return validateLock(compileLock(parseStructure(text)));
  } catch (error) {
    if (error instanceof LockValidationError) throw error;
    const typed = error as Error & { code?: string };
    throw new LockValidationError(
      typed.code ?? "IDEL_LOCK_PARSE_FAILED",
      `lockfile could not be parsed: ${typed.message}`,
    );
  }
}

function compileLock(
  document: ReturnType<typeof parseStructure>,
): Record<string, unknown> {
  if (document.uses.length > 0 || document.commands.length !== 1) {
    throw new LockValidationError(
      "IDEL_LOCK_ROOT_COUNT",
      "idel.lock must contain exactly one lock.project.graph command",
    );
  }
  const root = document.commands[0]!;
  if (root.name !== "lock.project.graph" || root.label !== undefined) {
    throw new LockValidationError(
      "IDEL_LOCK_ROOT_COMMAND",
      "idel.lock root must be lock.project.graph without a label",
    );
  }
  const rootFields = commandFields(root, new Set(["project"]));
  const registries: Record<string, unknown> = {};
  const packages: Record<string, unknown> = {};
  let resolution: Record<string, unknown> | undefined;

  for (const command of root.commands) {
    if (command.name === "lock.registry.discovery") {
      const label = lockLabel(command);
      const values = commandFields(command, new Set(["discovery"]));
      registries[label] = {
        discoveryDigest: lockConstructor(
          lockRequired(values, "discovery", command),
          "digest",
          `${command.name}.discovery`,
        ),
      };
      continue;
    }
    if (command.name === "lock.package") {
      const label = lockLabel(command);
      const values = commandFields(command, new Set([
        "registry",
        "bundle",
        "publisher",
        "signature",
        "provenance",
        "sbom",
        "trust",
        "permissions",
      ]));
      const dependencies: Record<string, string> = {};
      for (const dependency of command.commands) {
        if (dependency.name !== "lock.package.dependency") {
          throw new LockValidationError(
            "IDEL_LOCK_UNKNOWN_COMMAND",
            `unknown lock package command ${dependency.name}`,
          );
        }
        const dependencyFields = commandFields(
          dependency,
          new Set(["version"]),
        );
        dependencies[lockLabel(dependency)] = lockConstructor(
          lockRequired(dependencyFields, "version", dependency),
          "semver",
          `${dependency.name}.version`,
        );
      }
      packages[label] = {
        registry: lockConstructor(
          lockRequired(values, "registry", command),
          "uri",
          `${command.name}.registry`,
        ),
        bundle: lockConstructor(
          lockRequired(values, "bundle", command),
          "digest",
          `${command.name}.bundle`,
        ),
        publisher: lockConstructor(
          lockRequired(values, "publisher", command),
          "idelkey",
          `${command.name}.publisher`,
        ),
        signature: lockConstructor(
          lockRequired(values, "signature", command),
          "digest",
          `${command.name}.signature`,
        ),
        provenance: lockConstructor(
          lockRequired(values, "provenance", command),
          "evidence",
          `${command.name}.provenance`,
        ),
        sbom: lockConstructor(
          lockRequired(values, "sbom", command),
          "digest",
          `${command.name}.sbom`,
        ),
        trustLevel: lockTrust(
          lockEnum(
            lockRequired(values, "trust", command),
            `${command.name}.trust`,
          ),
        ),
        permissionsDigest: lockConstructor(
          lockRequired(values, "permissions", command),
          "digest",
          `${command.name}.permissions`,
        ),
        dependencies,
      };
      continue;
    }
    if (command.name === "record.resolution.result") {
      if (resolution !== undefined) {
        throw new LockValidationError(
          "IDEL_LOCK_DUPLICATE_RESOLUTION",
          "idel.lock may contain only one record.resolution.result",
        );
      }
      const values = commandFields(
        command,
        new Set(["created", "engine", "policy"]),
      );
      resolution = {
        ...(values.created === undefined
          ? {}
          : {
              createdAt: lockConstructor(
                values.created,
                "instant",
                `${command.name}.created`,
              ),
            }),
        idelVersion: lockConstructor(
          lockRequired(values, "engine", command),
          "semver",
          `${command.name}.engine`,
        ),
        policyDigest: lockConstructor(
          lockRequired(values, "policy", command),
          "digest",
          `${command.name}.policy`,
        ),
      };
      continue;
    }
    throw new LockValidationError(
      "IDEL_LOCK_UNKNOWN_COMMAND",
      `unknown lock command ${command.name}`,
    );
  }
  if (resolution === undefined) {
    throw new LockValidationError(
      "IDEL_LOCK_MISSING_RESOLUTION",
      "idel.lock is missing record.resolution.result",
    );
  }
  return {
    lockVersion: 1,
    projectDigest: lockConstructor(
      lockRequired(rootFields, "project", root),
      "digest",
      "lock.project.graph.project",
    ),
    registries,
    packages,
    resolution,
  };
}

export function validateLock(value: unknown): IdelLock {
  const raw = object(value, "lockfile");
  exactKeys(
    raw,
    ["lockVersion", "projectDigest", "registries", "packages", "resolution"],
    "lockfile",
  );
  if (raw.lockVersion !== IDEL_LOCK_VERSION) {
    throw new LockValidationError(
      "IDEL_LOCK_UNSUPPORTED_VERSION",
      `lockVersion must be ${IDEL_LOCK_VERSION}`,
    );
  }
  const projectDigest = digest(raw.projectDigest, "projectDigest");
  const registriesRaw = object(raw.registries, "registries");
  const registries: IdelLock["registries"] = {};
  for (const [name, value] of Object.entries(registriesRaw)) {
    const record = object(value, `registries.${name}`);
    exactKeys(record, ["discoveryDigest"], `registries.${name}`);
    registries[name] = {
      discoveryDigest: digest(
        record.discoveryDigest,
        `registries.${name}.discoveryDigest`,
      ),
    };
  }
  const packagesRaw = object(raw.packages, "packages");
  const packages: Record<string, LockedPackage> = {};
  for (const [coordinate, value] of Object.entries(packagesRaw)) {
    if (!EXACT_COORDINATE.test(coordinate)) {
      throw new LockValidationError(
        "IDEL_LOCK_INVALID_COORDINATE",
        `${coordinate} is not an exact scoped package coordinate`,
      );
    }
    packages[coordinate] = lockedPackage(value, coordinate);
  }
  const resolutionRaw = object(raw.resolution, "resolution");
  exactKeys(
    resolutionRaw,
    ["createdAt", "idelVersion", "policyDigest"],
    "resolution",
    new Set(["createdAt"]),
  );
  return {
    lockVersion: 1,
    projectDigest,
    registries,
    packages,
    resolution: {
      ...(resolutionRaw.createdAt === undefined
        ? {}
        : { createdAt: string(resolutionRaw.createdAt, "resolution.createdAt") }),
      idelVersion: string(resolutionRaw.idelVersion, "resolution.idelVersion"),
      policyDigest: digest(
        resolutionRaw.policyDigest,
        "resolution.policyDigest",
      ),
    },
  };
}

export function serializeLock(lock: IdelLock): string {
  const value = validateLock(lock);
  const lines = [
    "@idel 1.0",
    "",
    "lock.project.graph {",
    `  project = digest(${quote(value.projectDigest)})`,
  ];
  for (const name of Object.keys(value.registries).sort(compareUtf8)) {
    lines.push(
      "",
      `  lock.registry.discovery ${quote(name)} {`,
      `    discovery = digest(${quote(value.registries[name]!.discoveryDigest)})`,
      "  }",
    );
  }
  for (const coordinate of Object.keys(value.packages).sort(compareUtf8)) {
    const record = value.packages[coordinate]!;
    lines.push(
      "",
      `  lock.package ${quote(coordinate)} {`,
      `    registry = uri(${quote(record.registry)})`,
      `    bundle = digest(${quote(record.bundle)})`,
      `    publisher = idelkey(${quote(record.publisher)})`,
      `    signature = digest(${quote(record.signature)})`,
      `    provenance = evidence(${quote(record.provenance)})`,
      `    sbom = digest(${quote(record.sbom)})`,
      `    trust = ${lockTrustEnum(record.trustLevel)}`,
      `    permissions = digest(${quote(record.permissionsDigest)})`,
    );
    for (const name of Object.keys(record.dependencies).sort(compareUtf8)) {
      lines.push(
        "",
        `    lock.package.dependency ${quote(name)} {`,
        `      version = semver(${quote(record.dependencies[name]!)})`,
        "    }",
      );
    }
    lines.push("  }");
  }
  lines.push(
    "",
    "  record.resolution.result {",
    ...(value.resolution.createdAt === undefined
      ? []
      : [`    created = instant(${quote(value.resolution.createdAt)})`]),
    `    engine = semver(${quote(value.resolution.idelVersion)})`,
    `    policy = digest(${quote(value.resolution.policyDigest)})`,
    "  }",
    "}",
    "",
  );
  return lines.join("\n");
}

export function verifyLockForManifest(
  lock: IdelLock,
  manifest: IdelManifest,
): void {
  const expected = manifestDigest(manifest);
  if (lock.projectDigest !== expected) {
    throw new LockValidationError(
      "IDEL_LOCK_PROJECT_MISMATCH",
      `lockfile projectDigest is ${lock.projectDigest}; expected ${expected}`,
    );
  }
  const requested = new Set(Object.keys(manifest.dependencies ?? {}));
  const locked = new Set(
    Object.keys(lock.packages).map((coordinate) =>
      coordinate.slice(0, coordinate.lastIndexOf("@")),
    ),
  );
  for (const name of requested) {
    if (!locked.has(name)) {
      throw new LockValidationError(
        "IDEL_LOCK_DEPENDENCY_MISSING",
        `dependency ${name} is not present in the lockfile`,
      );
    }
  }
}

export function createEmptyLock(
  manifest: IdelManifest,
  idelVersion: string,
  policyDigest = `sha256:${"0".repeat(64)}`,
): IdelLock {
  if (Object.keys(manifest.dependencies ?? {}).length > 0) {
    throw new LockValidationError(
      "IDEL_LOCK_RESOLUTION_REQUIRED",
      "cannot create an empty lock for a manifest with runtime dependencies",
    );
  }
  return {
    lockVersion: 1,
    projectDigest: manifestDigest(manifest),
    registries: {},
    packages: {},
    resolution: {
      idelVersion,
      policyDigest,
    },
  };
}

function lockedPackage(value: unknown, coordinate: string): LockedPackage {
  const raw = object(value, coordinate);
  exactKeys(
    raw,
    [
      "registry",
      "bundle",
      "publisher",
      "signature",
      "provenance",
      "sbom",
      "trustLevel",
      "permissionsDigest",
      "dependencies",
    ],
    coordinate,
  );
  const trustLevel = string(raw.trustLevel, `${coordinate}.trustLevel`) as TrustLevel;
  if (!TRUST_LEVELS.has(trustLevel)) {
    throw new LockValidationError(
      "IDEL_LOCK_INVALID_TRUST_LEVEL",
      `${coordinate}.trustLevel is invalid`,
    );
  }
  const dependenciesRaw = object(
    raw.dependencies,
    `${coordinate}.dependencies`,
  );
  const dependencies: Record<string, string> = {};
  for (const [name, child] of Object.entries(dependenciesRaw)) {
    dependencies[name] = string(child, `${coordinate}.dependencies.${name}`);
  }
  return {
    registry: string(raw.registry, `${coordinate}.registry`),
    bundle: digest(raw.bundle, `${coordinate}.bundle`),
    publisher: string(raw.publisher, `${coordinate}.publisher`),
    signature: digest(raw.signature, `${coordinate}.signature`),
    provenance: string(raw.provenance, `${coordinate}.provenance`),
    sbom: digest(raw.sbom, `${coordinate}.sbom`),
    trustLevel,
    permissionsDigest: digest(
      raw.permissionsDigest,
      `${coordinate}.permissionsDigest`,
    ),
    dependencies,
  };
}

function commandFields(
  command: StructureCommand,
  allowed: ReadonlySet<string>,
): Record<string, StructureValue> {
  const result: Record<string, StructureValue> = {};
  for (const assignment of command.assignments) {
    if (!allowed.has(assignment.path)) {
      throw new LockValidationError(
        "IDEL_LOCK_UNKNOWN_FIELD",
        `${command.name} contains unknown field ${assignment.path}`,
      );
    }
    result[assignment.path] = assignment.value;
  }
  return result;
}

function lockRequired(
  values: Record<string, StructureValue>,
  path: string,
  command: StructureCommand,
): StructureValue {
  const value = values[path];
  if (value === undefined) {
    throw new LockValidationError(
      "IDEL_LOCK_MISSING_FIELD",
      `${command.name} is missing ${path}`,
    );
  }
  return value;
}

function lockLabel(command: StructureCommand): string {
  if (command.label === undefined || command.label.length === 0) {
    throw new LockValidationError(
      "IDEL_LOCK_LABEL_REQUIRED",
      `${command.name} requires a quoted label`,
    );
  }
  return command.label;
}

function lockConstructor(
  value: StructureValue,
  expected: string,
  path: string,
): string {
  if (!isLockConstructor(value) ||
      value.name !== expected ||
      value.arguments.length !== 1 ||
      typeof value.arguments[0] !== "string") {
    throw new LockValidationError(
      "IDEL_LOCK_INVALID_CONSTRUCTOR",
      `${path} must be ${expected}("...")`,
    );
  }
  return value.arguments[0];
}

function lockEnum(value: StructureValue, path: string): string {
  if (!isLockEnum(value)) {
    throw new LockValidationError(
      "IDEL_LOCK_INVALID_ENUM",
      `${path} must be a lowercase enum value`,
    );
  }
  return value.name;
}

function isLockConstructor(
  value: StructureValue,
): value is StructureConstructor {
  return typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    value.kind === "constructor";
}

function isLockEnum(value: StructureValue): value is StructureEnum {
  return typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    value.kind === "enum";
}

function lockTrust(value: string): TrustLevel {
  const match = /^trust\.(l[0-4])\.[a-z0-9]+$/.exec(value);
  if (!match) {
    throw new LockValidationError(
      "IDEL_LOCK_INVALID_TRUST_LEVEL",
      `invalid trust enum ${value}`,
    );
  }
  return match[1]!.toUpperCase() as TrustLevel;
}

function lockTrustEnum(value: TrustLevel): string {
  return {
    L0: "trust.l0.declarative",
    L1: "trust.l1.portable",
    L2: "trust.l2.connected",
    L3: "trust.l3.native",
    L4: "trust.l4.system",
  }[value];
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new LockValidationError(
      "IDEL_LOCK_INVALID_TYPE",
      `${path} must be an object`,
    );
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new LockValidationError(
      "IDEL_LOCK_INVALID_TYPE",
      `${path} must be a non-empty string`,
    );
  }
  return value;
}

function digest(value: unknown, path: string): string {
  const result = string(value, path);
  if (!DIGEST.test(result)) {
    throw new LockValidationError(
      "IDEL_LOCK_INVALID_DIGEST",
      `${path} must be a sha256 digest`,
    );
  }
  return result;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: string[],
  path: string,
  optional = new Set<string>(),
): void {
  const allowed = new Set(keys);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown !== undefined) {
    throw new LockValidationError(
      "IDEL_LOCK_UNKNOWN_FIELD",
      `${path} contains unknown field ${unknown}`,
    );
  }
  const missing = keys.find(
    (key) => !optional.has(key) && value[key] === undefined,
  );
  if (missing !== undefined) {
    throw new LockValidationError(
      "IDEL_LOCK_MISSING_FIELD",
      `${path} is missing ${missing}`,
    );
  }
}
