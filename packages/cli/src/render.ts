import {
  formatRisk,
  formatDecision,
  describeOutcome,
} from "@openexecution/runtime";
import type { RiskLevel, RuntimeOutcome } from "@openexecution/runtime";

/** Minimal ANSI coloring — no dependency. Disabled when not a TTY or NO_COLOR. */
const useColor = process.stdout.isTTY && !process.env["NO_COLOR"];

function wrap(code: number, s: string): string {
  return useColor ? `\x1b[${code}m${s}\x1b[0m` : s;
}

export const color = {
  red: (s: string) => wrap(31, s),
  green: (s: string) => wrap(32, s),
  yellow: (s: string) => wrap(33, s),
  blue: (s: string) => wrap(34, s),
  gray: (s: string) => wrap(90, s),
  bold: (s: string) => wrap(1, s),
};

function riskColor(level: RiskLevel, s: string): string {
  switch (level) {
    case "CRITICAL":
      return color.red(color.bold(s));
    case "HIGH":
      return color.red(s);
    case "MEDIUM":
      return color.yellow(s);
    case "LOW":
    default:
      return color.green(s);
  }
}

/**
 * Render a runtime outcome in the spec §25 style: command, risk, decision,
 * reason, what changed, and where the log is.
 */
export function render(outcome: RuntimeOutcome): string {
  const { record, result, risk, decision } = outcome;
  const lines: string[] = [];

  lines.push(color.bold(`Command: ${record.command}`));
  lines.push(riskColor(risk.level, formatRisk(risk)));
  lines.push(formatDecision(decision));
  lines.push(describeOutcome(record.result));

  // Command output (stdout/stderr) when something actually ran.
  if (result) {
    if (result.simulated && result.stdout) {
      lines.push(color.gray(result.stdout));
    } else {
      if (result.stdout.trim()) lines.push(result.stdout.replace(/\n$/, ""));
      if (result.stderr.trim()) lines.push(color.red(result.stderr.replace(/\n$/, "")));
    }
  }

  lines.push(color.gray("Log: ~/.idel/logs/openlogs.jsonl"));
  return lines.join("\n");
}

export function renderJson(outcome: RuntimeOutcome): string {
  return JSON.stringify(
    {
      command: outcome.record.command,
      risk: outcome.risk.level,
      findings: outcome.risk.findings,
      decision: outcome.decision,
      result: outcome.record.result,
      exitCode: outcome.result?.exitCode,
      stdout: outcome.result?.stdout,
      stderr: outcome.result?.stderr,
    },
    null,
    2,
  );
}
