import { mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  createBundleTar,
  createEmptyLock,
  loadLock,
  loadManifest,
  manifestDigest,
  PackageRegistryClient,
  packBundle,
  resolveManifest,
  serializeLock,
  verifyLockForManifest,
  type IdelLock,
  type LockedPackage,
  type PackageVersionRecord,
} from "@openexecution/package";

import type { CliInvocation } from "./argv.js";
import { VERSION } from "./help.js";

export interface PackageCommandOutput {
  exitCode: number;
  text: string;
}

export async function runPackageCommand(
  invocation: CliInvocation,
  cwd = process.cwd(),
): Promise<PackageCommandOutput> {
  try {
    const result = await execute(invocation, cwd);
    return {
      exitCode: 0,
      text: invocation.flags.json
        ? `${JSON.stringify({ ok: true, result })}\n`
        : `${render(result)}\n`,
    };
  } catch (error) {
    const typed = error as Error & { code?: string; path?: string };
    const envelope = {
      ok: false,
      error: {
        code: typed.code ?? "IDEL_PACKAGE_FAILED",
        message: typed.message,
        retryable: false,
        ...(typed.path ? { path: typed.path } : {}),
      },
    };
    return {
      exitCode: typed.code?.includes("DIGEST") ? 4 : 1,
      text: invocation.flags.json
        ? `${JSON.stringify(envelope)}\n`
        : `${envelope.error.code}: ${envelope.error.message}\n`,
    };
  }
}

async function execute(
  invocation: CliInvocation,
  cwd: string,
): Promise<Record<string, unknown>> {
  const root = resolve(cwd);
  const manifestPath = resolve(
    root,
    invocation.flags.manifestPath ?? "package.idel",
  );

  switch (invocation.command) {
    case "init":
      return initProject(root, manifestPath, invocation.flags.force);
    case "validate": {
      const manifest = await loadManifest(manifestPath);
      const bundle = await createBundleTar({ root, manifest, manifestPath });
      return {
        command: "validate",
        manifest: manifestPath,
        package: manifest.name,
        version: manifest.version,
        manifestDigest: manifestDigest(manifest),
        files: bundle.index.files.length,
        valid: true,
      };
    }
    case "pack": {
      const manifest = await loadManifest(manifestPath);
      const bundle = await packBundle({
        root,
        manifest,
        manifestPath,
        outputPath: invocation.flags.outputPath,
      });
      return {
        command: "pack",
        package: manifest.name,
        version: manifest.version,
        output: bundle.outputPath,
        digest: bundle.digest,
        size: bundle.size,
        files: bundle.index.files.length,
      };
    }
    case "resolve":
      return resolveCommand(invocation, root, manifestPath);
    case "lock":
      return lockCommand(invocation, root, manifestPath);
    case "install":
      return installCommand(invocation, root, manifestPath);
    case "verify":
      return verifyCommand(invocation, root, manifestPath);
    default:
      throw commandError(
        "IDEL_PACKAGE_UNKNOWN_COMMAND",
        `unknown package command ${invocation.command}`,
      );
  }
}

async function resolveCommand(
  invocation: CliInvocation,
  root: string,
  manifestPath: string,
): Promise<Record<string, unknown>> {
  const manifest = await loadManifest(manifestPath);
  const lockfilePath = resolve(
    root,
    invocation.flags.lockfilePath ?? "idel.lock",
  );
  const resolution = await resolveManifest(
    manifest,
    registryClient(invocation),
    VERSION,
  );
  await writeAtomic(lockfilePath, serializeLock(resolution.lock));
  return {
    command: "resolve",
    lockfile: lockfilePath,
    packages: resolution.records.size,
    projectDigest: resolution.lock.projectDigest,
    fetched: false,
    verified: true,
  };
}

async function installCommand(
  invocation: CliInvocation,
  root: string,
  manifestPath: string,
): Promise<Record<string, unknown>> {
  const manifest = await loadManifest(manifestPath);
  const lockfilePath = resolve(
    root,
    invocation.flags.lockfilePath ?? "idel.lock",
  );
  const cacheDirectory = resolve(
    invocation.flags.cachePath ?? join(homedir(), ".idel", "cache"),
  );
  if (invocation.flags.offline && !invocation.flags.immutable) {
    throw commandError(
      "IDEL_INSTALL_OFFLINE_REQUIRES_IMMUTABLE",
      "offline installation requires --immutable and an existing lockfile",
    );
  }
  if (invocation.flags.immutable) {
    const lock = await loadLock(lockfilePath);
    verifyLockForManifest(lock, manifest);
    if (invocation.flags.offline) {
      await verifyLockCache(lock, cacheDirectory);
    } else {
      const client = registryClient(invocation);
      await installLocked(lock, client, cacheDirectory);
    }
    return {
      command: "install",
      lockfile: lockfilePath,
      packages: Object.keys(lock.packages).length,
      immutable: true,
      offline: invocation.flags.offline,
      verified: true,
    };
  }

  const client = registryClient(invocation);
  const resolution = await resolveManifest(manifest, client, VERSION);
  for (const record of resolution.records.values()) {
    await client.download(record, cacheDirectory);
  }
  await writeAtomic(lockfilePath, serializeLock(resolution.lock));
  return {
    command: "install",
    lockfile: lockfilePath,
      packages: resolution.records.size,
      immutable: false,
      projectDigest: resolution.lock.projectDigest,
      verified: true,
  };
}

async function verifyCommand(
  invocation: CliInvocation,
  root: string,
  manifestPath: string,
): Promise<Record<string, unknown>> {
  const manifest = await loadManifest(manifestPath);
  const lockfilePath = resolve(
    root,
    invocation.flags.lockfilePath ?? "idel.lock",
  );
  const cacheDirectory = resolve(
    invocation.flags.cachePath ?? join(homedir(), ".idel", "cache"),
  );
  const lock = await loadLock(lockfilePath);
  verifyLockForManifest(lock, manifest);
  await verifyLockCache(lock, cacheDirectory);
  return {
    command: "verify",
    lockfile: lockfilePath,
    packages: Object.keys(lock.packages).length,
    projectDigest: lock.projectDigest,
    verified: true,
  };
}

async function installLocked(
  lock: IdelLock,
  client: PackageRegistryClient,
  cacheDirectory: string,
): Promise<void> {
  const discovery = await client.discover();
  for (const [coordinate, locked] of Object.entries(lock.packages)) {
    const { name, version } = splitCoordinate(coordinate);
    if (locked.registry !== discovery.api) {
      throw commandError(
        "IDEL_LOCK_REGISTRY_MISMATCH",
        `${coordinate} is pinned to ${locked.registry}, not ${discovery.api}`,
      );
    }
    const record = await client.version(name, version);
    verifyLockedRecord(coordinate, locked, record);
    await client.download(record, cacheDirectory);
  }
}

async function verifyLockCache(
  lock: IdelLock,
  cacheDirectory: string,
): Promise<void> {
  const verifier = new PackageRegistryClient(
    "http://127.0.0.1",
    undefined,
  );
  for (const record of Object.values(lock.packages)) {
    await verifier.verifyCached(cacheDirectory, record.bundle);
  }
}

function verifyLockedRecord(
  coordinate: string,
  locked: LockedPackage,
  record: PackageVersionRecord,
): void {
  const comparisons: Array<[string, string, string]> = [
    ["bundle", locked.bundle, record.bundle.digest],
    ["publisher", locked.publisher, record.publisher],
    ["signature", locked.signature, record.signature],
    ["provenance", locked.provenance, record.provenance],
    ["sbom", locked.sbom, record.sbom],
    ["trustLevel", locked.trustLevel, record.trustLevel],
    ["permissionsDigest", locked.permissionsDigest, record.permissionsDigest],
  ];
  const mismatch = comparisons.find(([, expected, actual]) => expected !== actual);
  if (mismatch) {
    throw commandError(
      "IDEL_LOCK_METADATA_MISMATCH",
      `${coordinate} ${mismatch[0]} changed from ${mismatch[1]} to ${mismatch[2]}`,
    );
  }
}

function splitCoordinate(coordinate: string): { name: string; version: string } {
  const separator = coordinate.lastIndexOf("@");
  if (separator <= 0) {
    throw commandError(
      "IDEL_LOCK_INVALID_COORDINATE",
      `invalid locked coordinate ${coordinate}`,
    );
  }
  return {
    name: coordinate.slice(0, separator),
    version: coordinate.slice(separator + 1),
  };
}

function registryClient(invocation: CliInvocation): PackageRegistryClient {
  return new PackageRegistryClient(
    invocation.flags.registryUrl ??
      process.env["IDEL_REGISTRY"] ??
      "https://packages.idel.world",
    process.env["IDEL_REGISTRY_TOKEN"],
  );
}

async function writeAtomic(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, contents, { encoding: "utf8", mode: 0o644 });
  await rename(temporary, path);
}

async function initProject(
  root: string,
  manifestPath: string,
  force: boolean,
): Promise<Record<string, unknown>> {
  const namespace = safeSegment(process.env["IDEL_NAMESPACE"] ?? "local");
  const name = safeSegment(root.split(/[\\/]/).pop() ?? "package");
  const manifest = `@idel 1.0

define.package.manifest "@${namespace}/${name}" {
  version = semver("0.1.0")
  summary = "Describe the goal this package provides"
  license = spdx("Apache-2.0")

  export.intent "hello" {
    source = path("intents/hello.idel")
  }

  configure.runtime.engine "idel" {
    version = range(">=1.0.0 <2.0.0")
    trust = trust.l0.declarative
  }

  authorize.publisher.namespace "@${namespace}" {
    authority = idelkey("https://key.idel.world")
    required_approvals = 1
  }

  require.evidence.release {
    provenance = required
    sbom = required
    conformance = ["idel-package-v1"]
  }
}
`;
  const intentPath = join(dirname(manifestPath), "intents", "hello.idel");
  await mkdir(dirname(intentPath), { recursive: true });
  await writeFile(manifestPath, manifest, {
    encoding: "utf8",
    flag: force ? "w" : "wx",
    mode: 0o644,
  });
  try {
    await writeFile(
      intentPath,
      `@idel 1.0

define.intent.workflow "hello" {
  execute.message.show "greeting" {
    text = "Hello from IDEL"
  }
}
`,
      {
      encoding: "utf8",
      flag: force ? "w" : "wx",
      mode: 0o644,
      },
    );
  } catch (error) {
    if (!force) {
      throw error;
    }
  }
  return {
    command: "init",
    manifest: manifestPath,
    intent: intentPath,
    package: `@${namespace}/${name}`,
  };
}

async function lockCommand(
  invocation: CliInvocation,
  root: string,
  manifestPath: string,
): Promise<Record<string, unknown>> {
  const action = invocation.arguments[0] ?? "verify";
  const lockfilePath = resolve(
    root,
    invocation.flags.lockfilePath ?? "idel.lock",
  );
  const manifest = await loadManifest(manifestPath);
  if (action === "init") {
    const lock = createEmptyLock(manifest, VERSION);
    await writeFile(lockfilePath, serializeLock(lock), {
      encoding: "utf8",
      flag: invocation.flags.force ? "w" : "wx",
      mode: 0o644,
    });
    return {
      command: "lock init",
      lockfile: lockfilePath,
      projectDigest: lock.projectDigest,
      packages: 0,
    };
  }
  if (action === "verify") {
    const lock = await loadLock(lockfilePath);
    verifyLockForManifest(lock, manifest);
    return {
      command: "lock verify",
      lockfile: lockfilePath,
      projectDigest: lock.projectDigest,
      packages: Object.keys(lock.packages).length,
      immutable: invocation.flags.immutable,
      valid: true,
    };
  }
  throw commandError(
    "IDEL_LOCK_UNKNOWN_COMMAND",
    `unknown lock command ${action}; expected init or verify`,
  );
}

function render(result: Record<string, unknown>): string {
  return Object.entries(result)
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join("\n");
}

function safeSegment(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return normalized || "package";
}

function commandError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
