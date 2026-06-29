import { createInterface } from "node:readline";

import type { RuntimeOutcome } from "@openexecution/runtime";

import { color, render } from "./render.js";

interface RemoteRegistryEntry {
  id: string;
  params?: { name: string; type: string; required?: boolean; enum?: string[] }[];
}

interface RemoteHealth {
  ok?: boolean;
  version?: string;
  platform?: string;
  nativeAvailable?: boolean;
  agentAvailable?: boolean;
}

export async function connectTerminal(rawUrl: string): Promise<number> {
  const baseUrl = normalizeServerUrl(rawUrl);
  if (!baseUrl) {
    process.stderr.write(
      color.gray(
        "Usage: idel connect <server-url>\n" +
          "Example over SSH tunnel: ssh -L 8787:127.0.0.1:7878 user@host\n" +
          "Then: idel connect http://127.0.0.1:8787\n",
      ),
    );
    return 2;
  }

  let health: RemoteHealth;
  try {
    health = await getJson<RemoteHealth>(baseUrl, "/api/health");
    if (!health.ok) throw new Error("health check did not return ok=true");
  } catch (err) {
    process.stderr.write(color.red(`Could not connect to ${baseUrl}: ${(err as Error).message}\n`));
    return 1;
  }

  const registry = await getJson<RemoteRegistryEntry[]>(baseUrl, "/api/registry").catch(() => []);
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: color.blue(`idel@${new URL(baseUrl).host}> `),
    completer: (line: string): [string[], string] => {
      const suggestions = completeRemote(line, registry);
      return [suggestions, completionFragment(line)];
    },
  });

  process.stdout.write(
    color.bold("IDEL Remote Terminal") +
      color.gray(`  —  ${baseUrl} · idel ${health.version ?? "unknown"} · ${health.platform ?? "unknown"}\n`),
  );
  process.stdout.write(color.gray("Commands run on the connected server and are audited there. Type `exit` to close.\n"));
  rl.prompt();

  return await new Promise<number>((resolveP) => {
    const queue: string[] = [];
    let draining = false;
    let stopped = false;
    let inputEnded = false;

    const finish = (): void => {
      if (stopped) return;
      stopped = true;
      process.stdout.write("\n");
      rl.close();
      resolveP(0);
    };

    const drain = async (): Promise<void> => {
      if (draining) return;
      draining = true;
      while (queue.length && !stopped) {
        const line = queue.shift()!.trim();
        if (!line) continue;
        if (line === "exit" || line === "quit") {
          finish();
          break;
        }
        await runRemoteLine(baseUrl, line, rl);
      }
      draining = false;
      if (!stopped && inputEnded) finish();
      else if (!stopped) rl.prompt();
    };

    rl.on("line", (raw) => {
      queue.push(raw);
      void drain();
    });
    rl.on("close", () => {
      inputEnded = true;
      if (!draining) finish();
    });
    rl.on("SIGINT", () => {
      if (draining) {
        process.stdout.write("^C\n");
        return;
      }
      finish();
    });
  });
}

async function runRemoteLine(baseUrl: string, command: string, rl: ReturnType<typeof createInterface>): Promise<void> {
  try {
    const outcome = await postJson<RuntimeOutcome>(baseUrl, "/api/run", {
      command,
      dryRun: false,
    });
    process.stdout.write(render(outcome) + "\n");
    if (outcome.record.result === "approval_required") {
      const approved = await promptYesNo(rl, `Approve and run for real on ${new URL(baseUrl).host}: ${command}?`);
      const finalOutcome = await postJson<RuntimeOutcome>(baseUrl, "/api/run", {
        command,
        dryRun: false,
        approve: approved,
      });
      process.stdout.write(render(finalOutcome) + "\n");
    }
  } catch (err) {
    process.stdout.write(color.red(`Remote error: ${(err as Error).message}\n`));
  }
}

async function promptYesNo(rl: ReturnType<typeof createInterface>, question: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    rl.question(color.yellow(`${question} [y/N] `), (answer) => {
      resolve(/^(y|yes)$/i.test(answer.trim()));
    });
  });
}

function normalizeServerUrl(raw: string): string | undefined {
  const text = raw.trim();
  if (!text) return undefined;
  const withScheme = /^https?:\/\//i.test(text) ? text : `http://${text}`;
  try {
    const url = new URL(withScheme);
    url.pathname = url.pathname.replace(/\/+$/, "");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

async function getJson<T>(baseUrl: string, path: string): Promise<T> {
  const res = await fetch(new URL(path, baseUrl));
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await safeText(res)}`);
  return await res.json() as T;
}

async function postJson<T>(baseUrl: string, path: string, body: unknown): Promise<T> {
  const res = await fetch(new URL(path, baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await safeText(res)}`);
  return await res.json() as T;
}

async function safeText(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  return text.trim() || res.statusText;
}

function completeRemote(input: string, registry: RemoteRegistryEntry[]): string[] {
  const trimmed = input.trimStart();
  if (!trimmed || (!trimmed.includes(" ") && !/\s$/.test(input))) {
    return registry.map((entry) => entry.id).filter((id) => id.startsWith(trimmed)).sort();
  }
  const head = trimmed.split(/\s+/, 1)[0] ?? "";
  const entry = registry.find((item) => item.id === head);
  if (!entry) return [];
  const last = /\s$/.test(input) ? "" : (trimmed.match(/(\S+)$/)?.[1] ?? "");
  const eq = last.indexOf("=");
  if (eq >= 0) {
    const key = last.slice(0, eq);
    const partial = last.slice(eq + 1);
    const param = entry.params?.find((item) => item.name === key);
    if (param?.enum?.length) return param.enum.filter((value) => value.startsWith(partial)).map((value) => `${key}=${value}`);
    if (param?.type === "boolean") return ["true", "false"].filter((value) => value.startsWith(partial)).map((value) => `${key}=${value}`);
    return [];
  }
  const used = new Set(
    trimmed.split(/\s+/).slice(1).map((token) => token.split("=", 1)[0] ?? token),
  );
  return (entry.params ?? [])
    .map((param) => param.name)
    .filter((name) => !used.has(name) && name.startsWith(last))
    .map((name) => `${name}=`);
}

function completionFragment(input: string): string {
  if (/\s$/.test(input)) return "";
  return input.match(/(\S+)$/)?.[1] ?? "";
}
