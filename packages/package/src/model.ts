export const IDEL_PACKAGE_SPEC = "openexecution.org/idel-package/v1";
export const IDEL_BUNDLE_MEDIA_TYPE =
  "application/vnd.idel.bundle.v1+tar+zstd";
export const IDEL_LOCK_VERSION = 1;

export type TrustLevel = "L0" | "L1" | "L2" | "L3" | "L4";

export interface PackageRuntime {
  trustLevel: TrustLevel;
  engines: Record<string, string>;
  entryPoints?: Record<string, string>;
  limits?: {
    cpuMillis?: number;
    memoryMiB?: number;
  };
  platforms?: string[];
}

export interface PackagePublisher {
  namespace: string;
  authority: string;
  requiredApprovals?: number;
}

export interface PackageEvidence {
  buildProvenance: "required" | "optional" | "forbidden";
  sbom: "required" | "optional" | "forbidden";
  conformance: string[];
}

export interface IdelManifest {
  spec: typeof IDEL_PACKAGE_SPEC;
  name: string;
  version: string;
  summary: string;
  license: string;
  homepage?: string;
  repository?: string;
  sourceRevision?: string;
  exports: Record<string, string[]>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  runtime: PackageRuntime;
  permissions: Record<string, unknown[]>;
  publisher: PackagePublisher;
  evidence: PackageEvidence;
  extensions?: Record<string, unknown>;
}

export interface BundleFile {
  path: string;
  size: number;
  mode: "file" | "executable";
  mediaType: string;
  digest: string;
}

export interface BundleIndex {
  spec: "openexecution.org/idel-bundle/v1";
  mediaType: typeof IDEL_BUNDLE_MEDIA_TYPE;
  package: {
    name: string;
    version: string;
  };
  manifestDigest: string;
  files: BundleFile[];
}

export interface RegistryLock {
  discoveryDigest: string;
}

export interface LockedPackage {
  registry: string;
  bundle: string;
  publisher: string;
  signature: string;
  provenance: string;
  sbom: string;
  trustLevel: TrustLevel;
  permissionsDigest: string;
  dependencies: Record<string, string>;
}

export interface IdelLock {
  lockVersion: 1;
  projectDigest: string;
  registries: Record<string, RegistryLock>;
  packages: Record<string, LockedPackage>;
  resolution: {
    createdAt?: string;
    idelVersion: string;
    policyDigest: string;
  };
}

export interface RegistryDiscovery {
  spec: "openexecution.org/idel-registry/v1";
  kind: "public" | "private" | "mirror" | "federated";
  api: string;
  blobs: string;
  identity: string;
  evidence: string;
  capabilities: string[];
  rootMetadata: string;
}

export interface PackageVersionRecord {
  spec: "openexecution.org/idel-registry/package-version/v1";
  name: string;
  version: string;
  bundle: {
    digest: string;
    size: number;
    url: string;
  };
  manifestDigest: string;
  publisher: string;
  signature: string;
  provenance: string;
  sbom: string;
  trustLevel: TrustLevel;
  permissionsDigest: string;
  dependencies: Record<string, string>;
  lifecycle:
    | "published"
    | "deprecated"
    | "yanked"
    | "quarantined"
    | "revoked";
}

export interface ResolutionResult {
  lock: IdelLock;
  records: Map<string, PackageVersionRecord>;
}
