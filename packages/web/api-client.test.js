import { describe, expect, it } from "vitest";

import {
  apiUrl,
  authorizedRequestOptions,
  normalizeApiBase,
  readBootstrapApiToken,
} from "./public/api-client.js";

describe("web API client", () => {
  it("normalizes loopback connection URLs and removes paths/query fragments", () => {
    expect(normalizeApiBase("127.0.0.1:8787/path?q=1#x")).toBe("http://127.0.0.1:8787/path");
    expect(apiUrl("http://127.0.0.1:8787/path", "/api/health")).toBe(
      "http://127.0.0.1:8787/api/health",
    );
  });

  it("rejects credentials embedded in a server URL", () => {
    expect(normalizeApiBase("http://user:secret@127.0.0.1:8787")).toBeNull();
  });

  it("adds a bearer only to API requests", () => {
    const api = authorizedRequestOptions("/api/registry", "secret", {
      headers: { "content-type": "application/json" },
    });
    expect(new Headers(api.headers).get("authorization")).toBe("Bearer secret");
    expect(authorizedRequestOptions("/landing.js", "secret", undefined)).toBeUndefined();
  });

  it("supports the current and legacy no-store bootstrap meta names", () => {
    const current = { querySelector: (selector) => selector.includes("idel-api-auth") ? { content: "abc" } : null };
    expect(readBootstrapApiToken(current)).toBe("abc");
    const placeholder = {
      querySelector: (selector) => selector.includes("idel-api-auth")
        ? { content: "__IDEL_API_AUTH_TOKEN__" }
        : null,
    };
    expect(readBootstrapApiToken(placeholder)).toBe("");
  });
});
