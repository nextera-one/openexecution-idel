export interface ParsedLearnCommand {
  cli: string;
  write: boolean;
}

export const LEARN_USAGE = "learn <cli> [--write]";

export function parseLearnCommand(line: string): ParsedLearnCommand | undefined {
  let tokens = tokenizeCommand(line.trim());
  if (tokens[0] === "idel") tokens = tokens.slice(1);
  const head = tokens[0];
  if (head !== "learn" && head !== "learn.cli") return undefined;

  const body = tokens.slice(1);
  let cli = "";
  let write = false;
  for (const token of body) {
    if (token === "--write" || token === "write=true") {
      write = true;
      continue;
    }
    if (token === "write=false") {
      write = false;
      continue;
    }
    const eq = token.indexOf("=");
    if (eq > 0) {
      const key = token.slice(0, eq);
      const value = token.slice(eq + 1);
      if (key === "cli" || key === "name" || key === "tool") cli = value;
      continue;
    }
    if (!cli && !token.startsWith("-")) cli = token;
  }

  return { cli, write };
}

function tokenizeCommand(value: string): string[] {
  const tokens: string[] = [];
  let i = 0;

  while (i < value.length) {
    while (i < value.length && /\s/.test(value[i]!)) i++;
    if (i >= value.length) break;

    let token = "";
    while (i < value.length && !/\s/.test(value[i]!)) {
      const ch = value[i]!;
      if (ch === "'" || ch === '"') {
        const quote = ch;
        i++;
        while (i < value.length) {
          const quoted = value[i]!;
          if (quoted === "\\") {
            if (i + 1 < value.length) token += value[i + 1]!;
            i += 2;
            continue;
          }
          if (quoted === quote) {
            i++;
            break;
          }
          token += quoted;
          i++;
        }
        continue;
      }
      if (ch === "\\") {
        if (i + 1 < value.length) token += value[i + 1]!;
        i += 2;
        continue;
      }
      token += ch;
      i++;
    }
    tokens.push(token);
  }

  return tokens;
}
