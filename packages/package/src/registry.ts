import { rename, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { canonicalBytes, sha256 } from "./canonical.js";
import type {
  PackageVersionRecord,
  RegistryDiscovery,
} from "./model.js";

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const PACKAGE_NAME = /^@[a-z0-9-]{1,64}\/[a-z0-9-]{1,64}$/;
const TRUST_LEVEL = new Set(["L0", "L1", "L2", "L3", "L4"]);
const LIFECYCLE = new Set([
  "published",
  "deprecated",
  "yanked",
  "quarantined",
  "revoked",
]);

export class RegistryClientError extends Error {
  override readonly name = "RegistryClientError";

  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

export class PackageRegistryClient {
  private readonly registry: URL;
  private discoveryValue: RegistryDiscovery | undefined;
  private readonly authorizedOrigins = new Set<string>();

  constructor(
    registry: string,
    private readonly token?: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.registry = secureUrl(registry, "registry");
    this.authorizedOrigins.add(this.registry.origin);
  }

  async discover(): Promise<RegistryDiscovery> {
    if (this.discoveryValue) return this.discoveryValue;
    const url = new URL("/.well-known/idel-registry", this.registry);
    const value = validateDiscovery(await this.json(url));
    this.discoveryValue = value;
    this.authorizedOrigins.add(new URL(value.api).origin);
    this.authorizedOrigins.add(new URL(value.blobs).origin);
    return value;
  }

  async versions(name: string): Promise<PackageVersionRecord[]> {
    packageName(name);
    const discovery = await this.discover();
    const [namespace, packageSegment] = splitName(name);
    let url: URL | undefined = apiUrl(
      discovery.api,
      `packages/${namespace}/${packageSegment}/versions`,
    );
    const records: PackageVersionRecord[] = [];
    let pages = 0;
    while (url) {
      if (pages++ >= 100) {
        throw new RegistryClientError(
          "IDEL_REGISTRY_CURSOR_LIMIT",
          "registry version pagination exceeded 100 pages",
        );
      }
      const raw = object(await this.json(url), "version listing");
      exactKeys(raw, ["spec", "items", "nextCursor"], "version listing", new Set([
        "nextCursor",
      ]));
      if (raw.spec !== "openexecution.org/idel-registry/package-versions/v1") {
        throw new RegistryClientError(
          "IDEL_REGISTRY_INVALID_RESPONSE",
          "version listing uses an unsupported spec",
        );
      }
      if (!Array.isArray(raw.items)) {
        throw new RegistryClientError(
          "IDEL_REGISTRY_INVALID_RESPONSE",
          "version listing items must be an array",
        );
      }
      records.push(
        ...raw.items.map((item, index) =>
          validateVersion(item, `items[${index}]`, name),
        ),
      );
      url =
        raw.nextCursor === undefined
          ? undefined
          : cursorUrl(url, string(raw.nextCursor, "nextCursor"));
    }
    return records;
  }

  async version(name: string, version: string): Promise<PackageVersionRecord> {
    packageName(name);
    const discovery = await this.discover();
    const [namespace, packageSegment] = splitName(name);
    const value = await this.json(
      apiUrl(
        discovery.api,
        `packages/${namespace}/${packageSegment}/versions/${encodeURIComponent(version)}`,
      ),
    );
    return validateVersion(value, "package version", name, version);
  }

  async download(
    record: PackageVersionRecord,
    cacheDirectory: string,
  ): Promise<string> {
    const url = secureUrl(record.bundle.url, "bundle");
    const discovery = await this.discover();
    const allowedOrigins = new Set([
      this.registry.origin,
      new URL(discovery.api).origin,
      new URL(discovery.blobs).origin,
    ]);
    if (!allowedOrigins.has(url.origin)) {
      throw new RegistryClientError(
        "IDEL_REGISTRY_UNTRUSTED_BUNDLE_ORIGIN",
        `bundle origin ${url.origin} is not declared by registry discovery`,
      );
    }
    const response = await this.request(url, { method: "GET" });
    if (!response.ok) {
      throw statusError(response, "bundle download");
    }
    const finalUrl = secureUrl(response.url || url.href, "bundle response");
    if (!allowedOrigins.has(finalUrl.origin)) {
      throw new RegistryClientError(
        "IDEL_REGISTRY_UNTRUSTED_BUNDLE_ORIGIN",
        `bundle redirect origin ${finalUrl.origin} is not declared by registry discovery`,
      );
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength !== record.bundle.size) {
      throw new RegistryClientError(
        "IDEL_REGISTRY_BUNDLE_SIZE_MISMATCH",
        `bundle ${record.name}@${record.version} expected ${record.bundle.size} bytes; received ${bytes.byteLength}`,
      );
    }
    const actual = sha256(bytes);
    if (actual !== record.bundle.digest) {
      throw new RegistryClientError(
        "IDEL_REGISTRY_BUNDLE_DIGEST_MISMATCH",
        `bundle ${record.name}@${record.version} expected ${record.bundle.digest}; received ${actual}`,
      );
    }
    const path = cachePath(cacheDirectory, actual);
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.tmp-${process.pid}`;
    await writeFile(temporary, bytes, { mode: 0o444 });
    await rename(temporary, path);
    return path;
  }

  async verifyCached(
    cacheDirectory: string,
    digest: string,
    expectedSize?: number,
  ): Promise<string> {
    digestValue(digest, "bundle digest");
    const path = cachePath(cacheDirectory, digest);
    let bytes: Buffer;
    try {
      bytes = await readFile(path);
    } catch (error) {
      throw new RegistryClientError(
        "IDEL_CACHE_BUNDLE_MISSING",
        `cached bundle ${digest} is unavailable: ${(error as Error).message}`,
      );
    }
    if (expectedSize !== undefined && bytes.length !== expectedSize) {
      throw new RegistryClientError(
        "IDEL_CACHE_BUNDLE_SIZE_MISMATCH",
        `cached bundle ${digest} has an unexpected size`,
      );
    }
    const actual = sha256(bytes);
    if (actual !== digest) {
      throw new RegistryClientError(
        "IDEL_CACHE_BUNDLE_DIGEST_MISMATCH",
        `cached bundle ${digest} was modified; received ${actual}`,
      );
    }
    return path;
  }

  async discoveryDigest(): Promise<string> {
    return sha256(canonicalBytes(await this.discover()));
  }

  private async json(url: URL): Promise<unknown> {
    const response = await this.request(url, {
      method: "GET",
      headers: { accept: "application/json" },
    });
    if (!response.ok) throw statusError(response, "registry request");
    secureUrl(response.url || url.href, "registry response");
    try {
      return await response.json();
    } catch (error) {
      throw new RegistryClientError(
        "IDEL_REGISTRY_INVALID_JSON",
        `registry returned invalid JSON: ${(error as Error).message}`,
      );
    }
  }

  private request(url: URL, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.token && this.authorizedOrigins.has(url.origin)) {
      headers.set("authorization", `Bearer ${this.token}`);
    }
    return this.fetcher(url, {
      ...init,
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(30_000),
    });
  }
}

export function validateDiscovery(value: unknown): RegistryDiscovery {
  const raw = object(value, "discovery");
  exactKeys(
    raw,
    [
      "spec",
      "kind",
      "api",
      "blobs",
      "identity",
      "evidence",
      "capabilities",
      "rootMetadata",
    ],
    "discovery",
  );
  if (raw.spec !== "openexecution.org/idel-registry/v1") {
    invalid("registry discovery uses an unsupported spec");
  }
  const kind = string(raw.kind, "kind");
  if (!["public", "private", "mirror", "federated"].includes(kind)) {
    invalid(`unsupported registry kind ${kind}`);
  }
  const capabilities = stringArray(raw.capabilities, "capabilities");
  return {
    spec: "openexecution.org/idel-registry/v1",
    kind: kind as RegistryDiscovery["kind"],
    api: secureUrl(string(raw.api, "api"), "api").href.replace(/\/$/, ""),
    blobs: secureUrl(string(raw.blobs, "blobs"), "blobs").href.replace(/\/$/, ""),
    identity: secureUrl(string(raw.identity, "identity"), "identity").href.replace(
      /\/$/,
      "",
    ),
    evidence: secureUrl(string(raw.evidence, "evidence"), "evidence").href.replace(
      /\/$/,
      "",
    ),
    capabilities,
    rootMetadata: secureUrl(
      string(raw.rootMetadata, "rootMetadata"),
      "rootMetadata",
    ).href,
  };
}

export function validateVersion(
  value: unknown,
  path: string,
  expectedName?: string,
  expectedVersion?: string,
): PackageVersionRecord {
  const raw = object(value, path);
  exactKeys(
    raw,
    [
      "spec",
      "name",
      "version",
      "bundle",
      "manifestDigest",
      "publisher",
      "signature",
      "provenance",
      "sbom",
      "trustLevel",
      "permissionsDigest",
      "dependencies",
      "lifecycle",
    ],
    path,
  );
  if (raw.spec !== "openexecution.org/idel-registry/package-version/v1") {
    invalid(`${path}.spec is unsupported`);
  }
  const name = string(raw.name, `${path}.name`);
  packageName(name);
  const version = string(raw.version, `${path}.version`);
  if (expectedName && name !== expectedName) {
    invalid(`${path}.name does not match the requested package`);
  }
  if (expectedVersion && version !== expectedVersion) {
    invalid(`${path}.version does not match the requested version`);
  }
  const bundle = object(raw.bundle, `${path}.bundle`);
  exactKeys(bundle, ["digest", "size", "url"], `${path}.bundle`);
  const digest = digestValue(bundle.digest, `${path}.bundle.digest`);
  const size = positiveInteger(bundle.size, `${path}.bundle.size`);
  const url = secureUrl(
    string(bundle.url, `${path}.bundle.url`),
    `${path}.bundle.url`,
  ).href;
  const trustLevel = string(raw.trustLevel, `${path}.trustLevel`);
  if (!TRUST_LEVEL.has(trustLevel)) invalid(`${path}.trustLevel is invalid`);
  const lifecycle = string(raw.lifecycle, `${path}.lifecycle`);
  if (!LIFECYCLE.has(lifecycle)) invalid(`${path}.lifecycle is invalid`);
  const dependenciesRaw = object(raw.dependencies, `${path}.dependencies`);
  const dependencies: Record<string, string> = {};
  for (const [dependency, range] of Object.entries(dependenciesRaw)) {
    packageName(dependency);
    dependencies[dependency] = string(range, `${path}.dependencies.${dependency}`);
  }
  return {
    spec: "openexecution.org/idel-registry/package-version/v1",
    name,
    version,
    bundle: { digest, size, url },
    manifestDigest: digestValue(
      raw.manifestDigest,
      `${path}.manifestDigest`,
    ),
    publisher: string(raw.publisher, `${path}.publisher`),
    signature: digestValue(raw.signature, `${path}.signature`),
    provenance: string(raw.provenance, `${path}.provenance`),
    sbom: digestValue(raw.sbom, `${path}.sbom`),
    trustLevel: trustLevel as PackageVersionRecord["trustLevel"],
    permissionsDigest: digestValue(
      raw.permissionsDigest,
      `${path}.permissionsDigest`,
    ),
    dependencies,
    lifecycle: lifecycle as PackageVersionRecord["lifecycle"],
  };
}

function apiUrl(base: string, path: string): URL {
  const normalized = base.endsWith("/") ? base : `${base}/`;
  return new URL(path, normalized);
}

function cursorUrl(current: URL, cursor: string): URL {
  const next = new URL(current);
  next.searchParams.set("cursor", cursor);
  return next;
}

function cachePath(directory: string, digest: string): string {
  return join(directory, "blobs", "sha256", digest.slice("sha256:".length));
}

function splitName(name: string): [string, string] {
  const slash = name.indexOf("/");
  return [encodeURIComponent(name.slice(1, slash)), encodeURIComponent(name.slice(slash + 1))];
}

function packageName(value: string): void {
  if (!PACKAGE_NAME.test(value)) invalid(`${value} is not a scoped package name`);
}

function digestValue(value: unknown, path: string): string {
  const result = string(value, path);
  if (!DIGEST.test(result)) invalid(`${path} is not a sha256 digest`);
  return result;
}

function secureUrl(value: string, path: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new RegistryClientError(
      "IDEL_REGISTRY_INVALID_URL",
      `${path} is not a valid URL: ${(error as Error).message}`,
    );
  }
  const loopback =
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !loopback) {
    throw new RegistryClientError(
      "IDEL_REGISTRY_INSECURE_URL",
      `${path} must use HTTPS except on loopback`,
    );
  }
  if (url.username || url.password) {
    throw new RegistryClientError(
      "IDEL_REGISTRY_INVALID_URL",
      `${path} must not contain embedded credentials`,
    );
  }
  return url;
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    invalid(`${path} must be a non-empty string`);
  }
  return value;
}

function stringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) invalid(`${path} must be an array`);
  return value.map((item, index) => string(item, `${path}[${index}]`));
}

function positiveInteger(value: unknown, path: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    invalid(`${path} must be a positive integer`);
  }
  return value as number;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: string[],
  path: string,
  optional = new Set<string>(),
): void {
  const allowed = new Set(keys);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown !== undefined) invalid(`${path} contains unknown field ${unknown}`);
  const missing = keys.find(
    (key) => !optional.has(key) && value[key] === undefined,
  );
  if (missing !== undefined) invalid(`${path} is missing ${missing}`);
}

function invalid(message: string): never {
  throw new RegistryClientError("IDEL_REGISTRY_INVALID_RESPONSE", message);
}

function statusError(response: Response, operation: string): RegistryClientError {
  return new RegistryClientError(
    "IDEL_REGISTRY_HTTP_ERROR",
    `${operation} failed with HTTP ${response.status}`,
    response.status === 429 || response.status >= 500,
  );
}
