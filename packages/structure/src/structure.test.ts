import { describe, expect, it } from "vitest";

import {
  canonicalCborBytes,
  compileStructureBytes,
  compileStructureDigest,
  formatStructure,
  LANGUAGE_REGISTRY,
  parseStructure,
} from "./index.js";

const PACKAGE = `@idel 1.0

define.package.manifest "@openexecution/hello" {
  version = semver("1.0.0")
  summary = "Hello"
  enabled = true
  platforms = [platform.linux, platform.windows]

  export.intent "hello" {
    source = path("intents/hello.idel")
  }
}`;

describe("IDEL Structure", () => {
  it("parses a typed command document", () => {
    const document = parseStructure(PACKAGE);
    expect(document.languageVersion).toBe("1.0");
    expect(document.commands[0]).toMatchObject({
      name: "define.package.manifest",
      label: "@openexecution/hello",
    });
    expect(document.commands[0]?.commands[0]).toMatchObject({
      name: "export.intent",
      label: "hello",
    });
  });

  it("rejects duplicate fields with a stable diagnostic", () => {
    expect(() =>
      parseStructure(PACKAGE.replace('summary = "Hello"', 'summary = "Hello"\n  summary = "Again"')),
    ).toThrowError(expect.objectContaining({
      code: "IDEL_STRUCTURE_DUPLICATE_FIELD",
    }));
  });

  it("rejects uppercase native identifiers but preserves quoted case", () => {
    expect(() =>
      parseStructure(PACKAGE.replace(
        "define.package.manifest",
        "Define.Package.Manifest",
      )),
    ).toThrowError(expect.objectContaining({
      code: "IDEL_STRUCTURE_INVALID_COMMAND_NAME",
    }));
    expect(parseStructure(PACKAGE.replace('"Hello"', '"GitHub API"'))
      .commands[0]?.assignments[1]?.value).toBe("GitHub API");
  });

  it("requires lowercase snake_case fields", () => {
    expect(() =>
      parseStructure(PACKAGE.replace("enabled = true", "readOnlyRoot = true")),
    ).toThrowError(expect.objectContaining({
      code: "IDEL_STRUCTURE_INVALID_FIELD_PATH",
    }));
    expect(() =>
      parseStructure(PACKAGE.replace("enabled = true", "read_only_root = true")),
    ).not.toThrow();
  });

  it("emits the same deterministic CBOR for differently ordered maps", () => {
    expect(canonicalCborBytes({ second: 2, first: 1 })).toEqual(
      canonicalCborBytes({ first: 1, second: 2 }),
    );
  });

  it("uses the shortest deterministic integer encoding", () => {
    expect(canonicalCborBytes(23).toString("hex")).toBe("17");
    expect(canonicalCborBytes(24).toString("hex")).toBe("1818");
    expect(canonicalCborBytes(-1).toString("hex")).toBe("20");
  });

  it("compiles formatting-equivalent source to identical .idelc bytes", () => {
    const compact = PACKAGE.replaceAll("\n  ", "\n      ");
    expect(compileStructureBytes(PACKAGE)).toEqual(
      compileStructureBytes(compact),
    );
    expect(compileStructureDigest(PACKAGE)).toMatch(
      /^sha256:[0-9a-f]{64}$/,
    );
  });

  it("formats indentation while preserving comments and external case", () => {
    const source = `@idel 1.0

define.project.application "GitHub-API" {
coordinate = git(
"https://github.com/Nextera/CaseSensitive.git"
)
// keep this explanation
}
`;
    expect(formatStructure(source)).toBe(`@idel 1.0

define.project.application "GitHub-API" {
  coordinate = git(
    "https://github.com/Nextera/CaseSensitive.git"
  )
  // keep this explanation
}
`);
  });

  it("parses IDELProxy routing and exposes proxy-aware editor metadata", () => {
    const proxy = `@idel 1.0

define.proxy.gateway "edge" {
  listen.proxy.endpoint "http" {
    address = ip("0.0.0.0")
    port = 80
    protocol = protocol.http1
  }

  redirect.http.request "force-https" {
    from = endpoint("http")

    configure.redirect.destination {
      scheme = "https"
      host = request.host
      path = replace_prefix(request.path, "/old/", "/")
      query = request.query
    }

    status = http.status.permanent_redirect
  }

  define.proxy.backend "application" {
    discover.backend.service {
      source = nexrun("service://default/application")
      port = 8443
    }

    balance.backend.traffic {
      algorithm = balance.consistent_hash
      key = request_cookie("idelproxy_affinity")
    }
  }
}`;

    expect(parseStructure(proxy).commands[0]?.name).toBe(
      "define.proxy.gateway",
    );
    expect(
      LANGUAGE_REGISTRY.commands.some(
        (entry) => entry.name === "redirect.http.request",
      ),
    ).toBe(true);
    expect(
      LANGUAGE_REGISTRY.constructors.some(
        (entry) => entry.name === "request_cookie",
      ),
    ).toBe(true);
    expect(
      LANGUAGE_REGISTRY.enums.some(
        (entry) => entry.name === "balance.consistent_hash",
      ),
    ).toBe(true);
  });
});
