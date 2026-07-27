import { readFile } from "node:fs/promises";

import {
  canonicalCborDigest,
  parseStructure,
  type StructureCommand,
  type StructureConstructor,
  type StructureEnum,
  type StructureValue,
} from "@openexecution/structure";

import {
  IDEL_PACKAGE_SPEC,
  type IdelManifest,
  type PackageEvidence,
  type PackagePublisher,
  type PackageRuntime,
  type TrustLevel,
} from "./model.js";

const PACKAGE_NAME = /^@[a-z0-9-]{1,64}\/[a-z0-9-]{1,64}$/;
const NAMESPACE = /^@[a-z0-9-]{1,64}$/;
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const TRUST_LEVELS = new Set<TrustLevel>(["L0", "L1", "L2", "L3", "L4"]);
const EVIDENCE_RULES = new Set(["required", "optional", "forbidden"]);
const EXPORT_KEYS = new Set(["intents", "schemas", "policies", "profiles", "wasm"]);
const PERMISSION_KEYS = new Set([
  "data",
  "network",
  "secrets",
  "filesystem",
  "subprocess",
  "device",
  "identity",
  "system",
]);
const TOP_LEVEL_KEYS = new Set([
  "spec",
  "name",
  "version",
  "summary",
  "license",
  "homepage",
  "repository",
  "sourceRevision",
  "exports",
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
  "runtime",
  "permissions",
  "publisher",
  "evidence",
  "extensions",
]);

export class ManifestValidationError extends Error {
  override readonly name = "ManifestValidationError";

  constructor(
    readonly code: string,
    message: string,
    readonly path?: string,
  ) {
    super(message);
  }
}

export async function loadManifest(path: string): Promise<IdelManifest> {
  const text = await readFile(path, "utf8");
  return parseManifest(text);
}

export function parseManifest(text: string): IdelManifest {
  const trimmed = text.trim();
  if (!trimmed) {
    fail("IDEL_PACKAGE_EMPTY", "Package manifest is empty");
  }
  try {
    return validateManifest(compilePackageManifest(parseStructure(text)));
  } catch (error) {
    if (error instanceof ManifestValidationError) throw error;
    const typed = error as Error & {
      code?: string;
      line?: number;
      column?: number;
    };
    fail(
      typed.code ?? "IDEL_PACKAGE_PARSE_FAILED",
      `Package manifest could not be parsed: ${typed.message}`,
      typed.line === undefined
        ? undefined
        : `${typed.line}:${typed.column ?? 1}`,
    );
  }
}

function compilePackageManifest(
  document: ReturnType<typeof parseStructure>,
): Record<string, unknown> {
  if (document.uses.length > 0) {
    fail(
      "IDEL_PACKAGE_USE_FORBIDDEN",
      "package manifests declare dependencies with depend.* commands, not use",
    );
  }
  if (document.commands.length !== 1) {
    fail(
      "IDEL_PACKAGE_ROOT_COUNT",
      "package.idel must contain exactly one define.package.manifest command",
    );
  }
  const root = document.commands[0]!;
  if (root.name !== "define.package.manifest") {
    fail(
      "IDEL_PACKAGE_ROOT_COMMAND",
      "package.idel root must be define.package.manifest",
    );
  }
  if (root.label === undefined) {
    fail("IDEL_PACKAGE_INVALID_NAME", "package manifest requires a quoted label");
  }
  const rootFields = fields(root, new Set([
    "version",
    "summary",
    "license",
    "homepage",
    "repository",
    "source_revision",
  ]));
  const exports: Record<string, string[]> = {};
  const dependencies: Record<string, string> = {};
  const devDependencies: Record<string, string> = {};
  const peerDependencies: Record<string, string> = {};
  const optionalDependencies: Record<string, string> = {};
  const engines: Record<string, string> = {};
  const entryPoints: Record<string, string> = {};
  const permissions: Record<string, unknown[]> = {};
  let trustLevel: TrustLevel | undefined;
  let cpuMillis: number | undefined;
  let memoryMiB: number | undefined;
  let publisher: Record<string, unknown> | undefined;
  let evidence: Record<string, unknown> | undefined;

  for (const command of root.commands) {
    const exportKind = ({
      "export.intent": "intents",
      "export.schema": "schemas",
      "export.policy": "policies",
      "export.profile": "profiles",
      "export.wasm": "wasm",
    } as const)[command.name];
    if (exportKind !== undefined) {
      const source = constructorText(command, "source", "path");
      (exports[exportKind] ??= []).push(source);
      continue;
    }

    const dependencyKind = ({
      "depend.package": dependencies,
      "depend.package.runtime": dependencies,
      "depend.package.development": devDependencies,
      "depend.package.peer": peerDependencies,
      "depend.package.optional": optionalDependencies,
    } as const)[command.name];
    if (dependencyKind !== undefined) {
      const label = requiredLabel(command);
      dependencyKind[label] = constructorText(command, "version", "range");
      fields(command, new Set(["version"]));
      continue;
    }

    if (command.name === "configure.runtime.engine") {
      const engine = requiredLabel(command);
      const runtimeFields = fields(command, new Set([
        "version",
        "trust",
        "entry_point",
        "limit.cpu",
        "limit.memory",
      ]));
      engines[engine] = constructorFromValue(
        requiredField(runtimeFields, "version", command),
        "range",
        `${command.name}.version`,
      );
      const nextTrust = trust(
        enumFromValue(
          requiredField(runtimeFields, "trust", command),
          `${command.name}.trust`,
        ),
      );
      if (trustLevel !== undefined && trustLevel !== nextTrust) {
        fail(
          "IDEL_PACKAGE_CONFLICTING_TRUST",
          "all runtime engines must declare the same trust level in package v1",
        );
      }
      trustLevel = nextTrust;
      if (runtimeFields.entry_point !== undefined) {
        entryPoints[engine] = constructorOrString(
          runtimeFields.entry_point,
          "path",
          `${command.name}.entry_point`,
        );
      }
      if (runtimeFields["limit.cpu"] !== undefined) {
        cpuMillis = durationMillis(
          constructorFromValue(
            runtimeFields["limit.cpu"],
            "duration",
            `${command.name}.limit.cpu`,
          ),
        );
      }
      if (runtimeFields["limit.memory"] !== undefined) {
        memoryMiB = bytesMiB(
          constructorFromValue(
            runtimeFields["limit.memory"],
            "bytes",
            `${command.name}.limit.memory`,
          ),
        );
      }
      continue;
    }

    if (command.name.startsWith("permit.")) {
      const segments = command.name.split(".");
      const category = segments[1];
      if (category === undefined || !PERMISSION_KEYS.has(category)) {
        fail(
          "IDEL_PACKAGE_UNKNOWN_PERMISSION",
          `unsupported permission command ${command.name}`,
        );
      }
      const permissionFields = fields(command);
      const item: Record<string, unknown> = {
        ...(command.label === undefined ? {} : { resource: command.label }),
      };
      for (const [path, value] of Object.entries(permissionFields)) {
        item[toCamelCase(path)] = plainValue(value);
      }
      (permissions[category] ??= []).push(item);
      continue;
    }

    if (command.name === "authorize.publisher.namespace") {
      if (publisher !== undefined) {
        fail(
          "IDEL_PACKAGE_DUPLICATE_PUBLISHER",
          "package manifest may authorize only one publisher namespace",
        );
      }
      const publisherFields = fields(
        command,
        new Set(["authority", "required_approvals"]),
      );
      publisher = compact({
        namespace: requiredLabel(command),
        authority: constructorFromValue(
          requiredField(publisherFields, "authority", command),
          "idelkey",
          `${command.name}.authority`,
        ),
        requiredApprovals:
          publisherFields.required_approvals === undefined
            ? undefined
            : integerValue(
                publisherFields.required_approvals,
                `${command.name}.required_approvals`,
              ),
      });
      continue;
    }

    if (command.name === "require.evidence.release") {
      if (evidence !== undefined) {
        fail(
          "IDEL_PACKAGE_DUPLICATE_EVIDENCE",
          "package manifest may contain only one release evidence requirement",
        );
      }
      const evidenceFields = fields(
        command,
        new Set(["provenance", "sbom", "conformance"]),
      );
      evidence = {
        buildProvenance: evidenceRule(
          requiredField(evidenceFields, "provenance", command),
          `${command.name}.provenance`,
        ),
        sbom: evidenceRule(
          requiredField(evidenceFields, "sbom", command),
          `${command.name}.sbom`,
        ),
        conformance: stringList(
          requiredField(evidenceFields, "conformance", command),
          `${command.name}.conformance`,
        ),
      };
      continue;
    }

    fail(
      "IDEL_PACKAGE_UNKNOWN_COMMAND",
      `package manifest contains unknown command ${command.name}`,
    );
  }

  return compact({
    spec: IDEL_PACKAGE_SPEC,
    name: root.label,
    version: constructorFromValue(
      requiredField(rootFields, "version", root),
      "semver",
      "define.package.manifest.version",
    ),
    summary: textValue(
      requiredField(rootFields, "summary", root),
      "define.package.manifest.summary",
    ),
    license: constructorFromValue(
      requiredField(rootFields, "license", root),
      "spdx",
      "define.package.manifest.license",
    ),
    homepage:
      rootFields.homepage === undefined
        ? undefined
        : constructorFromValue(
            rootFields.homepage,
            "uri",
            "define.package.manifest.homepage",
          ),
    repository:
      rootFields.repository === undefined
        ? undefined
        : constructorFromValue(
            rootFields.repository,
            "git",
            "define.package.manifest.repository",
          ),
    sourceRevision:
      rootFields.source_revision === undefined
        ? undefined
        : constructorOrString(
            rootFields.source_revision,
            "commit",
            "define.package.manifest.source_revision",
          ),
    exports,
    dependencies:
      Object.keys(dependencies).length === 0 ? undefined : dependencies,
    devDependencies:
      Object.keys(devDependencies).length === 0 ? undefined : devDependencies,
    peerDependencies:
      Object.keys(peerDependencies).length === 0 ? undefined : peerDependencies,
    optionalDependencies:
      Object.keys(optionalDependencies).length === 0
        ? undefined
        : optionalDependencies,
    runtime: compact({
      trustLevel,
      engines,
      entryPoints:
        Object.keys(entryPoints).length === 0 ? undefined : entryPoints,
      limits:
        cpuMillis === undefined && memoryMiB === undefined
          ? undefined
          : compact({ cpuMillis, memoryMiB }),
    }),
    permissions,
    publisher,
    evidence,
  });
}

export function validateManifest(value: unknown): IdelManifest {
  const raw = object(value, "$");
  rejectUnknown(raw, TOP_LEVEL_KEYS, "$");

  if (raw.spec !== IDEL_PACKAGE_SPEC) {
    fail(
      "IDEL_PACKAGE_UNSUPPORTED_SPEC",
      `spec must be ${IDEL_PACKAGE_SPEC}`,
      "$.spec",
    );
  }
  const name = string(raw.name, "$.name");
  if (!PACKAGE_NAME.test(name)) {
    fail(
      "IDEL_PACKAGE_INVALID_NAME",
      "name must be a scoped lowercase package such as @namespace/name",
      "$.name",
    );
  }
  const version = string(raw.version, "$.version");
  if (!SEMVER.test(version)) {
    fail(
      "IDEL_PACKAGE_INVALID_VERSION",
      "version must be Semantic Versioning 2.0.0 without a leading v",
      "$.version",
    );
  }
  const summary = string(raw.summary, "$.summary");
  if (summary.length > 280) {
    fail("IDEL_PACKAGE_INVALID_SUMMARY", "summary exceeds 280 characters", "$.summary");
  }
  const license = string(raw.license, "$.license");
  const exports = exportMap(raw.exports);
  if (Object.keys(exports).length === 0) {
    fail("IDEL_PACKAGE_MISSING_EXPORTS", "exports must not be empty", "$.exports");
  }
  const runtime = runtimeValue(raw.runtime);
  const permissions = permissionMap(raw.permissions);
  const publisher = publisherValue(raw.publisher);
  if (publisher.namespace !== name.slice(0, name.indexOf("/"))) {
    fail(
      "IDEL_PACKAGE_PUBLISHER_MISMATCH",
      "publisher.namespace must match the package namespace",
      "$.publisher.namespace",
    );
  }
  const evidence = evidenceValue(raw.evidence);

  return compact({
    spec: IDEL_PACKAGE_SPEC,
    name,
    version,
    summary,
    license,
    homepage: optionalString(raw.homepage, "$.homepage"),
    repository: optionalString(raw.repository, "$.repository"),
    sourceRevision: optionalString(raw.sourceRevision, "$.sourceRevision"),
    exports,
    dependencies: dependencyMap(raw.dependencies, "$.dependencies"),
    devDependencies: dependencyMap(raw.devDependencies, "$.devDependencies"),
    peerDependencies: dependencyMap(raw.peerDependencies, "$.peerDependencies"),
    optionalDependencies: dependencyMap(
      raw.optionalDependencies,
      "$.optionalDependencies",
    ),
    runtime,
    permissions,
    publisher,
    evidence,
    extensions:
      raw.extensions === undefined
        ? undefined
        : object(raw.extensions, "$.extensions"),
  }) as unknown as IdelManifest;
}

export function manifestDigest(manifest: IdelManifest): string {
  return canonicalCborDigest(canonicalManifest(manifest));
}

export function canonicalManifest(
  manifest: IdelManifest,
): Record<string, unknown> {
  return compact({
    spec: manifest.spec,
    name: manifest.name,
    version: manifest.version,
    summary: manifest.summary,
    license: manifest.license,
    homepage: manifest.homepage,
    repository: manifest.repository,
    source_revision: manifest.sourceRevision,
    exports: manifest.exports,
    dependencies: manifest.dependencies,
    dev_dependencies: manifest.devDependencies,
    peer_dependencies: manifest.peerDependencies,
    optional_dependencies: manifest.optionalDependencies,
    runtime: compact({
      trust_level: manifest.runtime.trustLevel.toLowerCase(),
      engines: manifest.runtime.engines,
      entry_points: manifest.runtime.entryPoints,
      limits:
        manifest.runtime.limits === undefined
          ? undefined
          : compact({
              cpu_millis: manifest.runtime.limits.cpuMillis,
              memory_mib: manifest.runtime.limits.memoryMiB,
            }),
      platforms: manifest.runtime.platforms,
    }),
    permissions: manifest.permissions,
    publisher: compact({
      namespace: manifest.publisher.namespace,
      authority: manifest.publisher.authority,
      required_approvals: manifest.publisher.requiredApprovals,
    }),
    evidence: {
      build_provenance: manifest.evidence.buildProvenance,
      sbom: manifest.evidence.sbom,
      conformance: manifest.evidence.conformance,
    },
    extensions: manifest.extensions,
  });
}

function fields(
  command: StructureCommand,
  allowed?: ReadonlySet<string>,
): Record<string, StructureValue> {
  const result: Record<string, StructureValue> = {};
  for (const assignment of command.assignments) {
    if (allowed !== undefined && !allowed.has(assignment.path)) {
      fail(
        "IDEL_PACKAGE_UNKNOWN_FIELD",
        `${command.name} contains unknown field ${assignment.path}`,
        `${command.name}.${assignment.path}`,
      );
    }
    result[assignment.path] = assignment.value;
  }
  return result;
}

function requiredField(
  values: Record<string, StructureValue>,
  path: string,
  command: StructureCommand,
): StructureValue {
  const value = values[path];
  if (value === undefined) {
    fail(
      "IDEL_PACKAGE_MISSING_FIELD",
      `${command.name} is missing ${path}`,
      `${command.name}.${path}`,
    );
  }
  return value;
}

function requiredLabel(command: StructureCommand): string {
  if (command.label === undefined || command.label.length === 0) {
    fail(
      "IDEL_PACKAGE_LABEL_REQUIRED",
      `${command.name} requires a quoted label`,
      command.name,
    );
  }
  return command.label;
}

function constructorText(
  command: StructureCommand,
  path: string,
  expected: string,
): string {
  const commandFields = fields(command, new Set([path]));
  return constructorFromValue(
    requiredField(commandFields, path, command),
    expected,
    `${command.name}.${path}`,
  );
}

function constructorFromValue(
  value: StructureValue,
  expected: string,
  path: string,
): string {
  if (!isConstructor(value) ||
      value.name !== expected ||
      value.arguments.length !== 1 ||
      typeof value.arguments[0] !== "string") {
    fail(
      "IDEL_PACKAGE_INVALID_CONSTRUCTOR",
      `${path} must be ${expected}("...")`,
      path,
    );
  }
  return value.arguments[0];
}

function constructorOrString(
  value: StructureValue,
  expected: string,
  path: string,
): string {
  if (typeof value === "string") return value;
  return constructorFromValue(value, expected, path);
}

function isConstructor(value: StructureValue): value is StructureConstructor {
  return typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    value.kind === "constructor";
}

function isEnum(value: StructureValue): value is StructureEnum {
  return typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    value.kind === "enum";
}

function textValue(value: StructureValue, path: string): string {
  if (typeof value !== "string") {
    fail("IDEL_PACKAGE_INVALID_TYPE", `${path} must be text`, path);
  }
  return value;
}

function integerValue(value: StructureValue, path: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    fail(
      "IDEL_PACKAGE_INVALID_TYPE",
      `${path} must be a non-negative integer`,
      path,
    );
  }
  return value as number;
}

function enumFromValue(value: StructureValue, path: string): string {
  if (!isEnum(value)) {
    fail(
      "IDEL_PACKAGE_INVALID_TYPE",
      `${path} must be a lowercase enum value`,
      path,
    );
  }
  return value.name;
}

function trust(value: string): TrustLevel {
  const match = /^trust\.(l[0-4])\.[a-z0-9]+$/.exec(value);
  if (!match) {
    fail(
      "IDEL_PACKAGE_INVALID_TRUST_LEVEL",
      "trust must be trust.l0.* through trust.l4.*",
    );
  }
  return match[1]!.toUpperCase() as TrustLevel;
}

function evidenceRule(
  value: StructureValue,
  path: string,
): PackageEvidence["buildProvenance"] {
  const rule = enumFromValue(value, path);
  if (!EVIDENCE_RULES.has(rule)) {
    fail(
      "IDEL_PACKAGE_INVALID_EVIDENCE_RULE",
      `${path} must be required, optional, or forbidden`,
      path,
    );
  }
  return rule as PackageEvidence["buildProvenance"];
}

function stringList(value: StructureValue, path: string): string[] {
  if (!Array.isArray(value) ||
      value.some((child) => typeof child !== "string")) {
    fail(
      "IDEL_PACKAGE_INVALID_TYPE",
      `${path} must be a list of strings`,
      path,
    );
  }
  return value as string[];
}

function durationMillis(value: string): number {
  const match = /^([1-9][0-9]*)(ms|s|m|h)$/.exec(value.toLowerCase());
  if (!match) {
    fail(
      "IDEL_PACKAGE_INVALID_DURATION",
      `unsupported duration ${JSON.stringify(value)}`,
    );
  }
  const factor = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[
    match[2] as "ms" | "s" | "m" | "h"
  ];
  return Number(match[1]) * factor;
}

function bytesMiB(value: string): number {
  const match = /^([1-9][0-9]*)(b|kib|mib|gib)$/.exec(value.toLowerCase());
  if (!match) {
    fail(
      "IDEL_PACKAGE_INVALID_BYTES",
      `unsupported byte quantity ${JSON.stringify(value)}`,
    );
  }
  const bytes = Number(match[1]) * {
    b: 1,
    kib: 1024,
    mib: 1024 ** 2,
    gib: 1024 ** 3,
  }[match[2] as "b" | "kib" | "mib" | "gib"];
  if (bytes % (1024 ** 2) !== 0) {
    fail(
      "IDEL_PACKAGE_INVALID_BYTES",
      "package v1 runtime memory must resolve to a whole MiB",
    );
  }
  return bytes / (1024 ** 2);
}

function plainValue(value: StructureValue): unknown {
  if (Array.isArray(value)) return value.map(plainValue);
  if (isEnum(value)) return value.name;
  if (isConstructor(value)) {
    return {
      type: value.name,
      arguments: value.arguments.map(plainValue),
    };
  }
  return value;
}

function toCamelCase(value: string): string {
  return value.replace(/_([a-z0-9])/g, (_, child: string) =>
    child.toUpperCase(),
  );
}

function runtimeValue(value: unknown): PackageRuntime {
  const raw = object(value, "$.runtime");
  rejectUnknown(
    raw,
    new Set(["trustLevel", "engines", "entryPoints", "limits", "platforms"]),
    "$.runtime",
  );
  const trustLevel = string(raw.trustLevel, "$.runtime.trustLevel") as TrustLevel;
  if (!TRUST_LEVELS.has(trustLevel)) {
    fail(
      "IDEL_PACKAGE_INVALID_TRUST_LEVEL",
      "runtime.trustLevel must be L0, L1, L2, L3, or L4",
      "$.runtime.trustLevel",
    );
  }
  const limits =
    raw.limits === undefined ? undefined : object(raw.limits, "$.runtime.limits");
  const result: PackageRuntime = {
    trustLevel,
    engines: stringMap(raw.engines, "$.runtime.engines", false),
  };
  if (raw.entryPoints !== undefined) {
    result.entryPoints = stringMap(
      raw.entryPoints,
      "$.runtime.entryPoints",
      false,
    );
  }
  if (limits !== undefined) {
    rejectUnknown(limits, new Set(["cpuMillis", "memoryMiB"]), "$.runtime.limits");
    result.limits = compact({
      cpuMillis: optionalPositiveInteger(
        limits.cpuMillis,
        "$.runtime.limits.cpuMillis",
      ),
      memoryMiB: optionalPositiveInteger(
        limits.memoryMiB,
        "$.runtime.limits.memoryMiB",
      ),
    });
  }
  if (raw.platforms !== undefined) {
    result.platforms = stringArray(raw.platforms, "$.runtime.platforms");
  }
  return result;
}

function publisherValue(value: unknown): PackagePublisher {
  const raw = object(value, "$.publisher");
  rejectUnknown(
    raw,
    new Set(["namespace", "authority", "requiredApprovals"]),
    "$.publisher",
  );
  const namespace = string(raw.namespace, "$.publisher.namespace");
  if (!NAMESPACE.test(namespace)) {
    fail(
      "IDEL_PACKAGE_INVALID_NAMESPACE",
      "publisher.namespace must be a lowercase scoped namespace",
      "$.publisher.namespace",
    );
  }
  return compact({
    namespace,
    authority: string(raw.authority, "$.publisher.authority"),
    requiredApprovals: optionalNonNegativeInteger(
      raw.requiredApprovals,
      "$.publisher.requiredApprovals",
    ),
  });
}

function evidenceValue(value: unknown): PackageEvidence {
  const raw = object(value, "$.evidence");
  rejectUnknown(
    raw,
    new Set(["buildProvenance", "sbom", "conformance"]),
    "$.evidence",
  );
  const buildProvenance = string(
    raw.buildProvenance,
    "$.evidence.buildProvenance",
  );
  const sbom = string(raw.sbom, "$.evidence.sbom");
  if (!EVIDENCE_RULES.has(buildProvenance) || !EVIDENCE_RULES.has(sbom)) {
    fail(
      "IDEL_PACKAGE_INVALID_EVIDENCE_RULE",
      "evidence rules must be required, optional, or forbidden",
      "$.evidence",
    );
  }
  return {
    buildProvenance: buildProvenance as PackageEvidence["buildProvenance"],
    sbom: sbom as PackageEvidence["sbom"],
    conformance: stringArray(raw.conformance, "$.evidence.conformance"),
  };
}

function exportMap(value: unknown): Record<string, string[]> {
  const raw = object(value, "$.exports");
  rejectUnknown(raw, EXPORT_KEYS, "$.exports");
  const result: Record<string, string[]> = {};
  for (const [key, child] of Object.entries(raw)) {
    result[key] = stringArray(child, `$.exports.${key}`).map((path) => {
      validatePackagePath(path, `$.exports.${key}`);
      return path;
    });
  }
  return result;
}

function permissionMap(value: unknown): Record<string, unknown[]> {
  const raw = object(value, "$.permissions");
  rejectUnknown(raw, PERMISSION_KEYS, "$.permissions");
  const result: Record<string, unknown[]> = {};
  for (const [key, child] of Object.entries(raw)) {
    if (!Array.isArray(child)) {
      fail(
        "IDEL_PACKAGE_INVALID_PERMISSION",
        `${key} permissions must be an array`,
        `$.permissions.${key}`,
      );
    }
    result[key] = child;
  }
  return result;
}

function dependencyMap(
  value: unknown,
  path: string,
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const result = stringMap(value, path, true);
  for (const name of Object.keys(result)) {
    if (!PACKAGE_NAME.test(name)) {
      fail(
        "IDEL_PACKAGE_INVALID_DEPENDENCY",
        `dependency ${name} is not a scoped package name`,
        `${path}.${name}`,
      );
    }
  }
  return result;
}

export function validatePackagePath(value: string, path = "$"): void {
  if (
    value.length === 0 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.split("/").some((part) => part === ".." || part === "")
  ) {
    fail(
      "IDEL_PACKAGE_UNSAFE_PATH",
      `unsafe package path ${JSON.stringify(value)}`,
      path,
    );
  }
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("IDEL_PACKAGE_INVALID_TYPE", `${path} must be an object`, path);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    fail("IDEL_PACKAGE_INVALID_TYPE", `${path} must be a non-empty string`, path);
  }
  return value;
}

function optionalString(value: unknown, path: string): string | undefined {
  return value === undefined ? undefined : string(value, path);
}

function stringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) {
    fail("IDEL_PACKAGE_INVALID_TYPE", `${path} must be an array`, path);
  }
  const result = value.map((child, index) => string(child, `${path}[${index}]`));
  if (new Set(result).size !== result.length) {
    fail("IDEL_PACKAGE_DUPLICATE_VALUE", `${path} contains duplicates`, path);
  }
  return result;
}

function stringMap(
  value: unknown,
  path: string,
  allowEmpty: boolean,
): Record<string, string> {
  const raw = object(value, path);
  if (!allowEmpty && Object.keys(raw).length === 0) {
    fail("IDEL_PACKAGE_INVALID_TYPE", `${path} must not be empty`, path);
  }
  const result: Record<string, string> = {};
  for (const [key, child] of Object.entries(raw)) {
    result[key] = string(child, `${path}.${key}`);
  }
  return result;
}

function optionalPositiveInteger(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < 1) {
    fail("IDEL_PACKAGE_INVALID_TYPE", `${path} must be a positive integer`, path);
  }
  return value as number;
}

function optionalNonNegativeInteger(
  value: unknown,
  path: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < 0) {
    fail(
      "IDEL_PACKAGE_INVALID_TYPE",
      `${path} must be a non-negative integer`,
      path,
    );
  }
  return value as number;
}

function rejectUnknown(
  objectValue: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
): void {
  const unknown = Object.keys(objectValue).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    fail(
      "IDEL_PACKAGE_UNKNOWN_FIELD",
      `${path} contains unknown field ${unknown[0]}`,
      `${path}.${unknown[0]}`,
    );
  }
}

function compact<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, child]) => child !== undefined),
  ) as T;
}

function fail(code: string, message: string, path?: string): never {
  throw new ManifestValidationError(code, message, path);
}
