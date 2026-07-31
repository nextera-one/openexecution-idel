import { describe, expect, it } from "vitest";

import { ManifestError, parseManifest } from "./index.js";

const VALID = `@idel 1.0

define.package.manifest "@idel-world/identity-functions" {
  version = semver("0.1.0")
  summary = "Identity functions"
  license = spdx("Apache-2.0")

  export.function "create_user" {
    source = path("create_user.func.idel")
  }

  require.evidence.release {
    provenance = required
    conformance = ["idel-package-v1"]
  }
}
`;

describe("parseManifest", () => {
  it("extracts name, version, and exports", () => {
    const manifest = parseManifest(VALID);
    expect(manifest.name).toBe("@idel-world/identity-functions");
    expect(manifest.version).toBe("0.1.0");
    expect(manifest.license).toBe("Apache-2.0");
    expect(manifest.exports).toEqual([
      { kind: "function", name: "create_user", source: "create_user.func.idel" },
    ]);
  });

  it("rejects a manifest without a semver version", () => {
    const source = VALID.replace('version = semver("0.1.0")', 'version = semver("newest")');
    expect(() => parseManifest(source)).toThrow(ManifestError);
  });

  it("rejects a wrong root verb", () => {
    const source = VALID.replace("define.package.manifest", "define.package.profile");
    expect(() => parseManifest(source)).toThrow(/define\.package\.manifest/);
  });

  it("rejects exports without a path source", () => {
    const source = VALID.replace('source = path("create_user.func.idel")', "source = required");
    expect(() => parseManifest(source)).toThrow(/source = path/);
  });
});
