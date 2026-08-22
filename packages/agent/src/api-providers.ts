import { parsePlan, type PlanProvider, type ProviderStep, type ProviderTurn } from "./provider.js";

const API_TIMEOUT_MS = 120_000;

type ConversationMessage = { role: "user" | "assistant"; text: string };

interface ApiProviderOptions {
  apiKey?: string;
  model?: string;
  system: string;
  fetch?: typeof globalThis.fetch;
}

abstract class JsonPlanApiProvider implements PlanProvider {
  abstract readonly name: string;
  protected readonly apiKey: string;
  protected readonly model: string;
  protected readonly system: string;
  protected readonly request: typeof globalThis.fetch;
  protected readonly history: ConversationMessage[] = [];

  protected constructor(opts: ApiProviderOptions, defaultModel: string, envKey: string) {
    const apiKey = opts.apiKey ?? process.env[envKey];
    if (!apiKey) throw new Error(`${envKey} is required for this AI provider.`);
    this.apiKey = apiKey;
    this.model = opts.model ?? defaultModel;
    this.system = opts.system;
    this.request = opts.fetch ?? globalThis.fetch;
  }

  async next(step: ProviderStep): Promise<ProviderTurn> {
    const prompt = formatStep(step);
    this.history.push({ role: "user", text: prompt });
    const text = await this.generate();
    this.history.push({ role: "assistant", text });
    return parsePlan(text);
  }

  protected abstract generate(): Promise<string>;
}

export class OpenAiApiProvider extends JsonPlanApiProvider {
  readonly name = "openai-api";

  constructor(opts: ApiProviderOptions) {
    super(opts, process.env["IDEL_OPENAI_MODEL"] ?? "gpt-5.4", "OPENAI_API_KEY");
  }

  protected async generate(): Promise<string> {
    const baseUrl = (process.env["OPENAI_BASE_URL"] ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    const res = await this.request(`${baseUrl}/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        instructions: this.system,
        input: this.history.map((item) => ({
          role: item.role,
          content: item.text,
        })),
        store: false,
      }),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    const json = await readApiJson(res, "OpenAI");
    const direct = typeof json.output_text === "string" ? json.output_text : "";
    const nested = Array.isArray(json.output)
      ? json.output
          .flatMap((item: unknown) => objectValue(item).content ?? [])
          .map((item: unknown) => objectValue(item).text)
          .filter((item: unknown): item is string => typeof item === "string")
          .join("\n")
      : "";
    const text = direct || nested;
    if (!text.trim()) throw new Error("OpenAI returned no text output.");
    return text;
  }
}

export class GeminiApiProvider extends JsonPlanApiProvider {
  readonly name = "gemini-api";

  constructor(opts: ApiProviderOptions) {
    super(opts, process.env["IDEL_GEMINI_MODEL"] ?? "gemini-3.7-flash", "GEMINI_API_KEY");
  }

  protected async generate(): Promise<string> {
    const model = encodeURIComponent(this.model);
    const res = await this.request(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": this.apiKey,
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: this.system }] },
          contents: this.history.map((item) => ({
            role: item.role === "assistant" ? "model" : "user",
            parts: [{ text: item.text }],
          })),
          generationConfig: { responseMimeType: "application/json" },
        }),
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      },
    );
    const json = await readApiJson(res, "Gemini");
    const candidates = Array.isArray(json.candidates) ? json.candidates : [];
    const text = candidates
      .flatMap((candidate: unknown) => objectValue(objectValue(candidate).content).parts ?? [])
      .map((part: unknown) => objectValue(part).text)
      .filter((item: unknown): item is string => typeof item === "string")
      .join("\n");
    if (!text.trim()) throw new Error("Gemini returned no text output.");
    return text;
  }
}

function formatStep(step: ProviderStep): string {
  if (step.priorOutcomes.length === 0) return step.userIntent;
  const outcomes = step.priorOutcomes.map(
    (item) => `Command: ${item.command}\nResult: ${item.outcomeJson}`,
  );
  return [
    "Here are the results of the commands you proposed. Adapt if needed, or set done:true if the task is complete.",
    "",
    ...outcomes,
  ].join("\n");
}

async function readApiJson(res: Response, provider: string): Promise<Record<string, unknown>> {
  let json: Record<string, unknown> = {};
  try {
    json = objectValue(await res.json());
  } catch {
    if (!res.ok) throw new Error(`${provider} API error ${res.status}.`);
  }
  if (!res.ok) {
    const error = objectValue(json.error);
    const message = typeof error.message === "string" ? `: ${error.message}` : "";
    throw new Error(`${provider} API error ${res.status}${message}`);
  }
  return json;
}

function objectValue(value: unknown): Record<string, any> {
  return value && typeof value === "object" ? value as Record<string, any> : {};
}
