import { parseStructure } from "./parser.js";

export function formatStructure(source: string): string {
  parseStructure(source);
  const normalized = source.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  const output: string[] = [];
  let depth = 0;
  let previousBlank = false;

  for (const raw of lines) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      if (output.length > 0 && !previousBlank) output.push("");
      previousBlank = true;
      continue;
    }

    const delta = delimiterDelta(trimmed);
    if (delta.closesFirst) depth = Math.max(0, depth - 1);
    output.push(`${"  ".repeat(depth)}${trimmed}`);
    depth = Math.max(
      0,
      depth + delta.opens - delta.closes + (delta.closesFirst ? 1 : 0),
    );
    previousBlank = false;
  }

  while (output.at(-1) === "") output.pop();
  return `${output.join("\n")}\n`;
}

export const formatStructureSource = formatStructure;

function delimiterDelta(line: string): {
  opens: number;
  closes: number;
  closesFirst: boolean;
} {
  let opens = 0;
  let closes = 0;
  let inString = false;
  let escaped = false;
  let firstStructural: "open" | "close" | undefined;

  for (let index = 0; index < line.length; index++) {
    const character = line[index]!;
    if (!inString && character === "#") break;
    if (
      !inString &&
      character === "/" &&
      line[index + 1] === "/"
    ) {
      break;
    }
    if (character === "\"" && !escaped) {
      inString = !inString;
      continue;
    }
    if (inString) {
      escaped = character === "\\" && !escaped;
      if (character !== "\\") escaped = false;
      continue;
    }
    escaped = false;
    if (character === "{" || character === "[" || character === "(") {
      firstStructural ??= "open";
      opens++;
    } else if (character === "}" || character === "]" || character === ")") {
      firstStructural ??= "close";
      closes++;
    }
  }
  return { opens, closes, closesFirst: firstStructural === "close" };
}
