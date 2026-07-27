import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createBundleTar,
  createEmptyLock,
  manifestDigest,
  ManifestValidationError,
  parseManifest,
  parseLock,
  serializeLock,
  sha256,
  verifyLockForManifest,
} from "./index.js";

const roots: string[] = [];

const VALID = `
@idel 1.0

define.package.manifest "@openexecution/hello" {
  version = semver("1.0.0")
  summary = "Hello package"
  license = spdx("Apache-2.0")

  export.intent "hello" {
    source = path("intents/hello.idel")
  }

  configure.runtime.engine "idel" {
    version = range(">=1.0.0 <2.0.0")
    trust = trust.l0.declarative
  }

  authorize.publisher.namespace "@openexecution" {
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

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe("IDEL Package v1", () => {
  it("parses and validates a minimal manifest", () => {
    const manifest = parseManifest(VALID);
    expect(manifest.name).toBe("@openexecution/hello");
    expect(manifest.runtime.trustLevel).toBe("L0");
    expect(manifestDigest(manifest)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("rejects unscoped public package names", () => {
    expect(() => parseManifest(VALID.replace("@openexecution/hello", "hello"))).toThrowError(
      expect.objectContaining<Partial<ManifestValidationError>>({
        code: "IDEL_PACKAGE_INVALID_NAME",
      }),
    );
  });

  it("rejects parent traversal in exports", () => {
    expect(() =>
      parseManifest(VALID.replace("intents/hello.idel", "../hello.idel")),
    ).toThrowError(
      expect.objectContaining<Partial<ManifestValidationError>>({
        code: "IDEL_PACKAGE_UNSAFE_PATH",
      }),
    );
  });

  it("produces identical deterministic tar bytes across source mtimes", async () => {
    const root = await project();
    const manifest = parseManifest(VALID);
    const first = await createBundleTar({ root, manifest });
    await writeFile(
      join(root, "intents/hello.idel"),
      '@idel 1.0\n\ndefine.intent.workflow "hello" {\n  text = "Hello"\n}\n',
    );
    const second = await createBundleTar({ root, manifest });
    expect(sha256(first.bytes)).toBe(sha256(second.bytes));
    expect(first.index).toEqual(second.index);
  });

  it("rejects declared exports that do not exist", async () => {
    const root = await project();
    const manifest = parseManifest(
      VALID.replace("intents/hello.idel", "intents/missing.idel"),
    );
    await expect(createBundleTar({ root, manifest })).rejects.toMatchObject({
      code: "IDEL_BUNDLE_EXPORT_MISSING",
    });
  });

  it("refuses to package credential-like files", async () => {
    const root = await project();
    await writeFile(join(root, ".env.production"), "TOKEN=do-not-package\n");
    await expect(
      createBundleTar({ root, manifest: parseManifest(VALID) }),
    ).rejects.toMatchObject({
      code: "IDEL_BUNDLE_SENSITIVE_FILE",
    });
  });

  it("creates and verifies a canonical empty lock", () => {
    const manifest = parseManifest(VALID);
    const lock = createEmptyLock(manifest, "1.2.0");
    expect(() => verifyLockForManifest(lock, manifest)).not.toThrow();
    expect(parseLock(serializeLock(lock))).toEqual(lock);
  });

  it("detects manifest and lock drift", () => {
    const manifest = parseManifest(VALID);
    const lock = createEmptyLock(manifest, "1.2.0");
    const changed = parseManifest(
      VALID.replace('semver("1.0.0")', 'semver("1.0.1")'),
    );
    expect(() => verifyLockForManifest(lock, changed)).toThrowError(
      expect.objectContaining({ code: "IDEL_LOCK_PROJECT_MISMATCH" }),
    );
  });
});

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "idel-package-test-"));
  roots.push(root);
  await mkdir(join(root, "intents"));
  await writeFile(join(root, "package.idel"), VALID);
  await writeFile(
    join(root, "intents/hello.idel"),
    '@idel 1.0\n\ndefine.intent.workflow "hello" {\n  text = "Hello"\n}\n',
  );
  expect(await readFile(join(root, "package.idel"), "utf8")).toContain(
    "define.package.manifest",
  );
  return root;
}
