import { describe, it, expect } from "vitest";

import { ASK_AI_USAGE, askAiIntent, isAskAiCommand } from "./ask-ai.js";

describe("ask.ai command helper", () => {
  it("recognizes the ask.ai command", () => {
    expect(isAskAiCommand('ask.ai prompt="list files"')).toBe(true);
    expect(isAskAiCommand("ask.agent prompt=x")).toBe(false);
  });

  it("extracts a quoted prompt parameter", () => {
    expect(askAiIntent('ask.ai prompt="delete the dist folder"')).toBe(
      "delete the dist folder",
    );
  });

  it("accepts question/text aliases", () => {
    expect(askAiIntent('ask.ai question="explain package.json"')).toBe(
      "explain package.json",
    );
    expect(askAiIntent("ask.ai text=summarize")).toBe("summarize");
  });

  it("accepts natural shorthand after the command", () => {
    expect(askAiIntent("ask.ai explain the package scripts")).toBe(
      "explain the package scripts",
    );
  });

  it("keeps unquoted prompt tails until the next named parameter", () => {
    expect(askAiIntent("ask.ai prompt=delete dist folder dryRun=true")).toBe(
      "delete dist folder",
    );
  });

  it("returns an empty intent for an empty command", () => {
    expect(askAiIntent("ask.ai")).toBe("");
    expect(ASK_AI_USAGE).toContain("prompt=");
  });
});
