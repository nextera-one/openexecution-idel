import { afterEach, describe, expect, it, vi } from "vitest";

import { GeminiApiProvider, OpenAiApiProvider } from "./api-providers.js";

const savedOpenAiKey = process.env["OPENAI_API_KEY"];
const savedGeminiKey = process.env["GEMINI_API_KEY"];

afterEach(() => {
  vi.restoreAllMocks();
  if (savedOpenAiKey === undefined) delete process.env["OPENAI_API_KEY"];
  else process.env["OPENAI_API_KEY"] = savedOpenAiKey;
  if (savedGeminiKey === undefined) delete process.env["GEMINI_API_KEY"];
  else process.env["GEMINI_API_KEY"] = savedGeminiKey;
});

describe("hosted JSON plan providers", () => {
  it("calls the OpenAI Responses API without exposing its key in the body", async () => {
    const request = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe("test-openai");
      expect(body.instructions).toContain("IDEL safety");
      expect(JSON.stringify(body)).not.toContain("openai-secret");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer openai-secret");
      return Response.json({
        output_text: JSON.stringify({ explanation: "Ready.", commands: [], done: true }),
      });
    });
    const provider = new OpenAiApiProvider({
      apiKey: "openai-secret",
      model: "test-openai",
      system: "IDEL safety contract",
      fetch: request as typeof fetch,
    });
    const turn = await provider.next({ userIntent: "list files", priorOutcomes: [] });
    expect(turn).toMatchObject({ text: "Ready.", commands: [], done: true });
    expect(request).toHaveBeenCalledOnce();
  });

  it("calls Gemini with x-goog-api-key and parses its JSON plan", async () => {
    const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toContain("gemini-test:generateContent");
      expect(new Headers(init?.headers).get("x-goog-api-key")).toBe("gemini-secret");
      expect(String(init?.body)).not.toContain("gemini-secret");
      return Response.json({
        candidates: [{
          content: {
            parts: [{ text: JSON.stringify({
              explanation: "Inspecting.",
              commands: [{ command: "list.folder path=.", dryRun: false }],
              done: false,
            }) }],
          },
        }],
      });
    });
    const provider = new GeminiApiProvider({
      apiKey: "gemini-secret",
      model: "gemini-test",
      system: "IDEL safety contract",
      fetch: request as typeof fetch,
    });
    const turn = await provider.next({ userIntent: "list files", priorOutcomes: [] });
    expect(turn.commands).toEqual([{ command: "list.folder path=.", dryRun: false }]);
    expect(turn.done).toBe(false);
  });

  it("requires provider credentials in the host process", () => {
    delete process.env["OPENAI_API_KEY"];
    delete process.env["GEMINI_API_KEY"];
    expect(() => new OpenAiApiProvider({ system: "x" })).toThrow(/OPENAI_API_KEY/);
    expect(() => new GeminiApiProvider({ system: "x" })).toThrow(/GEMINI_API_KEY/);
  });
});
