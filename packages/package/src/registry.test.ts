import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  PackageRegistryClient,
  parseManifest,
  resolveManifest,
  satisfies,
  sha256,
  type PackageVersionRecord,
} from "./index.js";

const servers: Server[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("registry resolution", () => {
  it("implements common deterministic SemVer ranges", () => {
    expect(satisfies("1.4.2", "^1.2.0")).toBe(true);
    expect(satisfies("2.0.0", "^1.2.0")).toBe(false);
    expect(satisfies("0.2.9", "^0.2.1")).toBe(true);
    expect(satisfies("0.3.0", "^0.2.1")).toBe(false);
    expect(satisfies("1.2.9", "~1.2.1")).toBe(true);
    expect(satisfies("1.3.0", "~1.2.1")).toBe(false);
    expect(satisfies("1.5.0", ">=1.0.0 <2.0.0")).toBe(true);
  });

  it("backtracks to the highest version satisfying the complete graph", async () => {
    const registry = await startRegistry({
      "@test/a": [
        record("@test/a", "1.1.0", { "@test/c": "^2.0.0" }),
        record("@test/a", "1.0.0", { "@test/c": "^1.0.0" }),
      ],
      "@test/b": [record("@test/b", "1.0.0", { "@test/c": "^1.0.0" })],
      "@test/c": [
        record("@test/c", "2.0.0"),
        record("@test/c", "1.5.0"),
      ],
    });
    const manifest = parseManifest(manifestText({
      "@test/a": "^1.0.0",
      "@test/b": "^1.0.0",
    }));
    const result = await resolveManifest(manifest, registry, "1.2.0");
    expect(Object.keys(result.lock.packages)).toEqual([
      "@test/a@1.0.0",
      "@test/b@1.0.0",
      "@test/c@1.5.0",
    ]);
  });

  it("downloads and verifies a bundle before placing it in cache", async () => {
    const bytes = Buffer.from("signed deterministic bundle");
    const registry = await startRegistry(
      { "@test/a": [] },
      { "/bundle/a.idelb": bytes },
    );
    const discovery = await registry.discover();
    const recordValue = record("@test/a", "1.0.0");
    recordValue.bundle = {
      digest: sha256(bytes),
      size: bytes.length,
      url: new URL("/bundle/a.idelb", discovery.api).href,
    };
    const directory = await mkdtemp(join(tmpdir(), "idel-cache-test-"));
    directories.push(directory);
    const path = await registry.download(recordValue, directory);
    expect(await readFile(path)).toEqual(bytes);
    await expect(
      registry.verifyCached(directory, recordValue.bundle.digest, bytes.length),
    ).resolves.toBe(path);
  });
});

async function startRegistry(
  versions: Record<string, PackageVersionRecord[]>,
  files: Record<string, Buffer> = {},
): Promise<PackageRegistryClient> {
  let origin = "";
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", origin);
    if (url.pathname === "/.well-known/idel-registry") {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          spec: "openexecution.org/idel-registry/v1",
          kind: "public",
          api: `${origin}/v1`,
          blobs: `${origin}/blobs`,
          identity: `${origin}/identity`,
          evidence: `${origin}/evidence`,
          capabilities: ["packages"],
          rootMetadata: `${origin}/tuf/root.json`,
        }),
      );
      return;
    }
    const match =
      /^\/v1\/packages\/([^/]+)\/([^/]+)\/versions$/.exec(url.pathname);
    if (match) {
      const name = `@${decodeURIComponent(match[1]!)}/${decodeURIComponent(match[2]!)}`;
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          spec: "openexecution.org/idel-registry/package-versions/v1",
          items: versions[name] ?? [],
        }),
      );
      return;
    }
    const file = files[url.pathname];
    if (file) {
      response.setHeader("content-type", "application/octet-stream");
      response.end(file);
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  servers.push(server);
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing server address");
  origin = `http://127.0.0.1:${address.port}`;
  return new PackageRegistryClient(origin);
}

function record(
  name: string,
  version: string,
  dependencies: Record<string, string> = {},
): PackageVersionRecord {
  return {
    spec: "openexecution.org/idel-registry/package-version/v1",
    name,
    version,
    bundle: {
      digest: digest("bundle", name, version),
      size: 10,
      url: "http://127.0.0.1/unused",
    },
    manifestDigest: digest("manifest", name, version),
    publisher: `idel-key://test/${name}`,
    signature: digest("signature", name, version),
    provenance: `openlogs://${name}/${version}`,
    sbom: digest("sbom", name, version),
    trustLevel: "L0",
    permissionsDigest: digest("permissions", name, version),
    dependencies,
    lifecycle: "published",
  };
}

function digest(...parts: string[]): string {
  return sha256(parts.join(":"));
}

function manifestText(dependencies: Record<string, string>): string {
  const dependencyLines = Object.entries(dependencies)
    .map(([name, range]) => `  depend.package ${JSON.stringify(name)} {
    version = range(${JSON.stringify(range)})
  }
`)
    .join("\n");
  return `@idel 1.0

define.package.manifest "@test/root" {
  version = semver("1.0.0")
  summary = "Resolver root"
  license = spdx("Apache-2.0")

  export.intent "root" {
    source = path("intents/root.idel")
  }

${dependencyLines}
  configure.runtime.engine "idel" {
    version = range(">=1.0.0 <2.0.0")
    trust = trust.l0.declarative
  }

  authorize.publisher.namespace "@test" {
    authority = idelkey("https://key.idel.world")
  }

  require.evidence.release {
    provenance = required
    sbom = required
    conformance = ["idel-package-v1"]
  }
}
`;
}
