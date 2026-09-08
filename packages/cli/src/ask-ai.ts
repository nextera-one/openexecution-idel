export const ASK_AI_COMMAND = "ask.ai";
export const ASK_AI_USAGE = 'ask.ai prompt="what you want to do"';

const PROMPT_KEYS = new Set(["prompt", "question", "intent", "message", "text"]);

export function isAskAiCommand(line: string): boolean {
  return tokenizeAskAi(line.trim())[0] === ASK_AI_COMMAND;
}

export function askAiIntent(line: string): string {
  const tokens = tokenizeAskAi(line.trim());
  if (tokens[0] !== ASK_AI_COMMAND) return "";

  const rest = tokens.slice(1);
  if (rest.length === 0) return "";

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    const eq = token.indexOf("=");
    if (eq <= 0) continue;

    const key = token.slice(0, eq);
    if (!PROMPT_KEYS.has(key)) continue;

    const words = [token.slice(eq + 1)];
    for (let j = i + 1; j < rest.length; j++) {
      const next = rest[j]!;
      if (isParamToken(next)) break;
      words.push(next);
    }
    return words.join(" ").trim();
  }

  return rest.filter((token) => !isParamToken(token)).join(" ").trim();
}

function isParamToken(token: string): boolean {
  return /^[a-z][a-zA-Z0-9]*=/.test(token);
}

function tokenizeAskAi(value: string): string[] {
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
