// IDEL web terminal — talks to the local `idel serve` HTTP+SSE API. No build
// step, no framework: this file is served verbatim by `idel serve --static`.
//
// Two modes share one input box:
//   IDEL       — type `verb.scope param=value`; POST /api/run/stream (SSE).
//   Ask Claude — natural language; POST /api/agent/stream (SSE). Each command
//                Claude proposes is run through the same pipeline server-side.
// Both render into the same scrollback. The runtime, not this page, is the
// enforcement boundary — the UI only displays what the server decided.

const $ = (id) => document.getElementById(id);
const initialOutput = $("output");
const input = $("input");
const form = $("form");
const promptEl = $("prompt");
const batchToggle = $("batch-toggle");
const completionsEl = $("completions");
const statusEl = $("status");
const logsEl = $("logs");
const tabsEl = $("tabs");
const modeIdelBtn = $("mode-idel");
const modeAskBtn = $("mode-ask");
const newTerminalBtn = $("new-terminal");
const dictionaryDialog = $("dictionary-dialog");
const dictionaryOpen = $("dictionary-open");
const dictionaryClose = $("dictionary-close");
const dictionarySearch = $("dictionary-search");
const dictionaryResults = $("dictionary-results");
const dictionaryEmpty = $("dictionary-empty");
const dictionaryCount = $("dictionary-count");
const dictionaryPlatform = $("dictionary-platform");
const knowledgeDialog = $("knowledge-dialog");
const knowledgeOpen = $("knowledge-open");
const knowledgeClose = $("knowledge-close");
const knowledgePlatform = $("knowledge-platform");
const preferencesDialog = $("preferences-dialog");
const preferencesOpen = $("preferences-open");
const preferencesClose = $("preferences-close");
const claudeSetupDialog = $("claude-setup-dialog");
const claudeSetupClose = $("claude-setup-close");
const claudeSetupCheck = $("claude-setup-check");
const claudeSetupStatus = $("claude-setup-status");
const showLogsInput = $("pref-show-logs");
const themeButtons = Array.from(document.querySelectorAll("[data-theme]"));
const paletteButtons = Array.from(document.querySelectorAll("[data-palette]"));
const fontSizeButtons = Array.from(document.querySelectorAll("[data-font-size]"));
const screenshotDialog = $("screenshot-dialog");
const screenshotClose = $("screenshot-close");
const screenshotRedact = $("screenshot-redact");
const screenshotRedactText = $("screenshot-redact-text");
const screenshotCopy = $("screenshot-copy");
const screenshotDownload = $("screenshot-download");
const screenshotScopeButtons = Array.from(document.querySelectorAll("[data-screenshot-scope]"));

let mode = location.hash === "#ask" ? "ask" : "idel";
let completions = [];
let compSel = -1;
let nextTabId = 1;
let terminalCount = 0;
let activeTabId = "";
let lastTerminalTabId = "";
const tabs = [];
const compactInputMedia = typeof window.matchMedia === "function" ? window.matchMedia("(max-width: 520px)") : null;
let commandBusy = false;
let screenshotScope = "visible";
let screenshotSource = null;
let agentAvailable = true;
let agentStatusKnown = false;
let switchToAskAfterSetup = false;
let dictionaryEntries = [];
let dictionaryLoaded = false;
let dictionaryLoading = false;
let serverPlatform = "";
let serverAdapter = "posix";
let multilineBatch = false;

const THEMES = new Set(["dark", "light"]);
const PALETTES = new Set(["cyan", "blue", "teal", "green", "amber", "orange", "rose", "red", "violet", "slate"]);
const FONT_SIZES = new Set(["small", "normal", "large", "xlarge"]);
const PREF_KEYS = {
  theme: "idel.theme",
  palette: "idel.palette",
  fontSize: "idel.fontSize",
  showLogs: "idel.showLogs",
};
const PAGE_EXIT_MESSAGE =
  "Refresh or leave IDEL terminal? Current terminal output, running commands, and unsaved editor changes may be lost.";
const DEFAULT_PREFERENCES = {
  theme: "dark",
  palette: "cyan",
  fontSize: "normal",
  showLogs: true,
};

function setServerPlatform(platformName) {
  const next = String(platformName ?? "").toLowerCase();
  serverPlatform = next;
  serverAdapter = next === "win32" ? "powershell" : "posix";
  const label = serverPlatformLabel();
  if (dictionaryPlatform) dictionaryPlatform.textContent = label;
  if (knowledgePlatform) knowledgePlatform.textContent = label;
  renderKnowledgeBase();
  if (dictionaryDialog?.open) renderDictionary();
}

function serverPlatformLabel() {
  switch (serverPlatform) {
    case "win32":
      return "Windows / PowerShell";
    case "darwin":
      return "macOS / POSIX shell";
    case "linux":
      return "Linux / POSIX shell";
    case "":
      return "detected OS";
    default:
      return `${serverPlatform} / POSIX shell`;
  }
}

function serverPlatformKind() {
  if (serverPlatform === "win32") return "windows";
  if (serverPlatform === "darwin") return "macos";
  return "linux";
}

function initPreferences() {
  applyPreferences(readPreferences(), false);
  for (const btn of themeButtons) {
    btn.addEventListener("click", () => {
      applyPreferences({ ...currentPreferences(), theme: btn.dataset.theme });
    });
  }
  for (const btn of paletteButtons) {
    btn.addEventListener("click", () => {
      applyPreferences({ ...currentPreferences(), palette: btn.dataset.palette });
    });
  }
  for (const btn of fontSizeButtons) {
    btn.addEventListener("click", () => {
      applyPreferences({ ...currentPreferences(), fontSize: btn.dataset.fontSize });
    });
  }
  showLogsInput?.addEventListener("change", () => {
    applyPreferences({ ...currentPreferences(), showLogs: showLogsInput.checked });
  });
  preferencesOpen?.addEventListener("click", openPreferences);
  preferencesClose?.addEventListener("click", closePreferences);
  preferencesDialog?.addEventListener("click", (e) => {
    if (e.target === preferencesDialog) closePreferences();
  });
}

function initClaudeSetupDialog() {
  claudeSetupClose?.addEventListener("click", closeClaudeSetupDialog);
  claudeSetupDialog?.addEventListener("click", (e) => {
    if (e.target === claudeSetupDialog) closeClaudeSetupDialog();
  });
  claudeSetupCheck?.addEventListener("click", () => void checkClaudeSetup());
}

function initDictionary() {
  dictionaryOpen?.addEventListener("click", () => void openDictionary());
  dictionaryClose?.addEventListener("click", closeDictionary);
  dictionaryDialog?.addEventListener("click", (e) => {
    if (e.target === dictionaryDialog) closeDictionary();
  });
  dictionarySearch?.addEventListener("input", renderDictionary);
  dictionarySearch?.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeDictionary();
  });
}

function initKnowledgeBase() {
  renderKnowledgeBase();
  knowledgeOpen?.addEventListener("click", openKnowledgeBase);
  knowledgeClose?.addEventListener("click", closeKnowledgeBase);
  knowledgeDialog?.addEventListener("click", (e) => {
    if (e.target === knowledgeDialog) closeKnowledgeBase();
  });
}

function openKnowledgeBase() {
  if (!knowledgeDialog) return;
  renderKnowledgeBase();
  if (typeof knowledgeDialog.showModal === "function") knowledgeDialog.showModal();
  else knowledgeDialog.setAttribute("open", "");
}

function closeKnowledgeBase() {
  if (!knowledgeDialog) return;
  if (typeof knowledgeDialog.close === "function" && knowledgeDialog.open) knowledgeDialog.close();
  else knowledgeDialog.removeAttribute("open");
  if (activeTab()?.type !== "editor") input.focus();
}

function renderKnowledgeBase() {
  const kind = serverPlatformKind();
  const data =
    kind === "windows"
      ? {
          native: "! winget install --id Git.Git -e",
          nativeShell: "winget install --id Git.Git -e",
          packages: "! winget search Git\n! winget install --id Git.Git -e\n! winget list Git",
          packageTitle: "Elevation And Windows Packages",
          packageNote:
            "Some installers open UAC or interactive prompts. In the web terminal, prefer commands that can complete without an interactive prompt, or run them from a real terminal when elevation is required.",
          wait:
            "run.script path=./scripts/start.ps1 shell=powershell && wait.time seconds=2 && tail.file file=app.log lines=40",
        }
      : kind === "macos"
        ? {
            native: "! brew install git",
            nativeShell: "brew install git",
            packages: "! brew search git\n! brew install git\n! brew info git",
            packageTitle: "Elevation And macOS Packages",
            packageNote:
              "Homebrew usually does not need sudo. If a command asks for elevation or opens an interactive prompt, run it from a real terminal session.",
            wait:
              "run.script path=./scripts/start.sh shell=bash && wait.time seconds=2 && tail.file file=app.log lines=40",
          }
        : {
            native: "! sudo apt install git",
            nativeShell: "sudo apt install git",
            packages: "! sudo apt update\n! sudo apt install git\n! apt search git",
            packageTitle: "Sudo And Apt",
            packageNote:
              "Interactive sudo password prompts work best in a real terminal. In the web terminal, prefer commands that do not need an interactive password prompt, or run the server from a session where sudo is already ready.",
            wait:
              "run.script path=./scripts/start.sh shell=bash && wait.time seconds=2 && tail.file file=app.log lines=40",
          };

  setElementText("knowledge-batch-example", multilineBatch
    ? "create.folder name=demo\ncreate.file name=demo/readme.md\nread.file name=demo/readme.md"
    : "create.folder name=demo && create.file name=demo/readme.md && read.file name=demo/readme.md");
  setElementText("knowledge-wait-example", data.wait);
  setElementText("knowledge-wait-short-example", "create.file name=ready.txt && wait.time ms=500 && read.file name=ready.txt");
  setElementText("knowledge-native-example", data.native);
  setElementText("knowledge-native-quoted-example", `! "${data.nativeShell}"`);
  setElementText("knowledge-native-shell-example", data.nativeShell);
  setElementText("knowledge-package-title", data.packageTitle);
  setElementText("knowledge-package-examples", data.packages);
  setElementText("knowledge-package-note", data.packageNote);
}

function setElementText(id, text) {
  const el = $(id);
  if (el) el.textContent = text;
}

async function openDictionary() {
  if (!dictionaryDialog) return;
  if (typeof dictionaryDialog.showModal === "function") dictionaryDialog.showModal();
  else dictionaryDialog.setAttribute("open", "");
  await loadDictionary();
  renderDictionary();
  dictionarySearch?.focus();
  dictionarySearch?.select();
}

function closeDictionary() {
  if (!dictionaryDialog) return;
  if (typeof dictionaryDialog.close === "function" && dictionaryDialog.open) dictionaryDialog.close();
  else dictionaryDialog.removeAttribute("open");
  if (activeTab()?.type !== "editor") input.focus();
}

async function loadDictionary() {
  if (dictionaryLoaded || dictionaryLoading) return;
  dictionaryLoading = true;
  dictionaryCount.textContent = "Loading...";
  try {
    const res = await fetch("/api/registry");
    dictionaryEntries = res.ok ? await res.json() : [];
    dictionaryEntries.sort((a, b) => a.category.localeCompare(b.category) || a.id.localeCompare(b.id));
    dictionaryLoaded = true;
  } catch {
    dictionaryEntries = [];
  } finally {
    dictionaryLoading = false;
  }
}

function renderDictionary() {
  if (!dictionaryResults || !dictionaryEmpty || !dictionaryCount) return;
  const query = String(dictionarySearch?.value ?? "").trim();
  const tokens = dictionaryQueryTokens(query);
  const matches = dictionaryEntries
    .map((entry) => ({ entry, score: dictionaryScore(entry, query, tokens) }))
    .filter((match) => match.score >= 0)
    .sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id))
    .slice(0, 80);

  dictionaryResults.innerHTML = "";
  for (const { entry } of matches) {
    dictionaryResults.appendChild(dictionaryEntryNode(entry, query));
  }
  dictionaryEmpty.hidden = matches.length > 0;
  dictionaryCount.textContent = dictionaryLoaded
    ? `${matches.length} of ${dictionaryEntries.length}`
    : "Loading...";
}

function dictionaryQueryTokens(query) {
  return tokenizeIdel(query.toLowerCase()).filter(Boolean);
}

function dictionaryScore(entry, query, tokens) {
  if (!query) return 1;
  const normalizedQuery = query.toLowerCase();
  const first = tokens[0] ?? "";
  const haystack = dictionaryHaystack(entry);
  let score = 0;

  if (entry.id.toLowerCase() === normalizedQuery) score += 140;
  if (entry.id.toLowerCase().includes(normalizedQuery)) score += 80;
  if (dictionaryAliases(entry).some((alias) => alias.includes(normalizedQuery))) score += 70;

  for (const adapter of entry.adapters ?? []) {
    const command = String(adapter.command ?? "").toLowerCase();
    if (command === first) score += 120;
    else if (command.includes(first) && first) score += 45;
    if (String(adapter.pattern ?? "").toLowerCase().includes(normalizedQuery)) score += 30;
  }

  for (const token of tokens) {
    if (haystack.includes(token)) score += 12;
  }
  return score > 0 ? score : -1;
}

function dictionaryHaystack(entry) {
  const parts = [
    entry.id,
    ...dictionaryAliases(entry),
    entry.summary,
    entry.category,
    entry.risk,
    ...(entry.examples ?? []),
  ];
  for (const param of entry.params ?? []) {
    parts.push(param.name, param.type, param.description ?? "");
  }
  for (const adapter of entry.adapters ?? []) {
    parts.push(adapter.name, adapter.command, adapter.pattern, adapter.semanticNotes ?? "");
  }
  return parts.join(" ").toLowerCase();
}

function dictionaryAliases(entry) {
  const aliases = [];
  if (entry.id.includes("folder")) aliases.push(entry.id.replaceAll("folder", "directory"));
  if (entry.id.includes("directory")) aliases.push(entry.id.replaceAll("directory", "folder"));
  return aliases;
}

function dictionaryEntryNode(entry, query) {
  const card = document.createElement("article");
  card.className = "dictionary-item";

  const head = document.createElement("div");
  head.className = "dictionary-item-head";
  const title = document.createElement("div");
  title.className = "dictionary-title";
  const id = document.createElement("code");
  id.textContent = entry.id;
  const risk = document.createElement("span");
  risk.className = `dictionary-risk risk-${entry.risk}`;
  risk.textContent = entry.risk;
  const category = document.createElement("span");
  category.className = "dictionary-category";
  category.textContent = entry.category;
  title.append(id, risk, category);

  const insert = document.createElement("button");
  insert.type = "button";
  insert.className = "editor-btn dictionary-insert";
  insert.textContent = "Insert";
  insert.title = "Insert first example into the terminal";
  insert.addEventListener("click", () => {
    input.value = dictionaryInsertLine(entry);
    closeDictionary();
    input.focus();
  });
  head.append(title, insert);

  const summary = document.createElement("p");
  summary.className = "dictionary-summary";
  summary.textContent = entry.summary;

  card.append(head, summary);

  const conversion = nativeQueryToIdel(entry, query);
  if (conversion) {
    const converted = document.createElement("div");
    converted.className = "dictionary-conversion";
    converted.append("Native search maps to ");
    const code = document.createElement("code");
    code.textContent = conversion;
    converted.appendChild(code);
    card.appendChild(converted);
  }

  const mappings = document.createElement("div");
  mappings.className = "dictionary-mappings";
  if (entry.adapters?.length) {
    const adapters = dictionaryAdaptersForDisplay(entry.adapters);
    for (const adapter of adapters) mappings.appendChild(dictionaryMappingNode(adapter, adapters));
  } else {
    const internal = document.createElement("div");
    internal.className = "dictionary-mapping muted";
    internal.textContent = "Runtime/internal command. No direct OS argv mapping.";
    mappings.appendChild(internal);
  }
  card.appendChild(mappings);

  if (entry.params?.length) card.appendChild(dictionaryParamsNode(entry.params));
  if (entry.examples?.length) card.appendChild(dictionaryExamplesNode(entry.examples));

  const aliases = dictionaryAliases(entry);
  if (aliases.length) {
    const alias = document.createElement("div");
    alias.className = "dictionary-aliases";
    alias.textContent = `Search-only aliases: ${aliases.join(", ")}`;
    card.appendChild(alias);
  }

  return card;
}

function dictionaryAdaptersForDisplay(adapters = []) {
  return [...adapters].sort((a, b) => adapterDisplayPriority(a, adapters) - adapterDisplayPriority(b, adapters));
}

function adapterDisplayPriority(adapter, adapters) {
  if (adapter.name === serverAdapter) return 0;
  if (adapter.name === "node" && !adapters.some((item) => item.name === serverAdapter)) return 0;
  if (adapter.name === "node") return 1;
  return 2;
}

function dictionaryMappingNode(adapter, adapters = []) {
  const row = document.createElement("div");
  row.className = "dictionary-mapping";
  if (adapterIsCurrent(adapter, adapters)) row.classList.add("dictionary-mapping-current");
  else row.classList.add("dictionary-mapping-other");
  const label = document.createElement("span");
  label.className = "dictionary-map-label";
  label.textContent = adapterIsCurrent(adapter, adapters)
    ? `${adapterLabel(adapter.name)} · this OS`
    : adapterLabel(adapter.name);
  const code = document.createElement("code");
  code.textContent = adapter.pattern || adapter.command;
  row.append(label, code);
  if (adapter.semanticNotes) {
    const note = document.createElement("small");
    note.textContent = adapter.semanticNotes;
    row.appendChild(note);
  }
  return row;
}

function adapterIsCurrent(adapter, adapters = []) {
  if (adapter.name === serverAdapter) return true;
  return adapter.name === "node" && !adapters.some((item) => item.name === serverAdapter);
}

function dictionaryParamsNode(params) {
  const wrap = document.createElement("div");
  wrap.className = "dictionary-params";
  for (const param of params) {
    const chip = document.createElement("span");
    chip.className = "dictionary-param";
    chip.title = param.description ?? "";
    chip.textContent = `${param.name}:${param.type}${param.required ? "*" : ""}`;
    wrap.appendChild(chip);
  }
  return wrap;
}

function dictionaryExamplesNode(examples) {
  const wrap = document.createElement("div");
  wrap.className = "dictionary-examples";
  for (const example of examples.slice(0, 3)) {
    const code = document.createElement("code");
    code.textContent = example;
    wrap.appendChild(code);
  }
  return wrap;
}

function adapterLabel(name) {
  switch (name) {
    case "posix":
      return "POSIX shell";
    case "powershell":
      return "PowerShell";
    case "node":
      return "IDEL runtime";
    default:
      return String(name);
  }
}

function dictionaryInsertLine(entry) {
  return entry.examples?.[0] ?? `${entry.id} `;
}

function nativeQueryToIdel(entry, query) {
  const tokens = tokenizeIdel(String(query ?? "").trim());
  if (!tokens.length) return "";
  const nativeCommand = tokens[0].toLowerCase();
  for (const adapter of dictionaryAdaptersForDisplay(entry.adapters ?? [])) {
    if (String(adapter.command ?? "").toLowerCase() !== nativeCommand) continue;
    const params = paramsFromNativeArgs(adapter, tokens.slice(1));
    const rendered = Object.entries(params).map(([key, value]) => `${key}=${quoteDictionaryValue(value)}`);
    return [entry.id, ...rendered].join(" ");
  }
  return "";
}

function paramsFromNativeArgs(adapter, argv) {
  const remaining = [...argv];
  const params = {};
  for (const arg of adapter.args ?? []) {
    switch (arg.kind) {
      case "flag": {
        const index = remaining.indexOf(arg.flag);
        if (index !== -1) {
          params[arg.when] = true;
          remaining.splice(index, 1);
        }
        break;
      }
      case "option": {
        const index = remaining.indexOf(arg.flag);
        if (index !== -1 && index + 1 < remaining.length) {
          params[arg.param] = remaining[index + 1];
          remaining.splice(index, 2);
        }
        break;
      }
      case "literal": {
        const index = remaining.indexOf(arg.value);
        if (index !== -1) remaining.splice(index, 1);
        break;
      }
      case "value": {
        if (params[arg.param] !== undefined || !remaining.length) break;
        const index = remaining.findIndex((value) => value !== "");
        if (index !== -1) {
          params[arg.param] = remaining[index];
          remaining.splice(index, 1);
        }
        break;
      }
    }
  }
  return params;
}

function quoteDictionaryValue(value) {
  const text = String(value);
  if (!/[\s"'\\]/.test(text)) return text;
  return `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function openClaudeSetupDialog({ switchToAsk = false, message = "" } = {}) {
  switchToAskAfterSetup = switchToAsk;
  setClaudeSetupStatus(message || "Ask Claude is not configured on this server.");
  if (!claudeSetupDialog) return;
  if (typeof claudeSetupDialog.showModal === "function") claudeSetupDialog.showModal();
  else claudeSetupDialog.setAttribute("open", "");
}

function closeClaudeSetupDialog() {
  switchToAskAfterSetup = false;
  if (!claudeSetupDialog) return;
  if (typeof claudeSetupDialog.close === "function" && claudeSetupDialog.open) claudeSetupDialog.close();
  else claudeSetupDialog.removeAttribute("open");
}

function setClaudeSetupStatus(message) {
  if (claudeSetupStatus) claudeSetupStatus.textContent = message;
}

async function checkClaudeSetup() {
  if (claudeSetupCheck) claudeSetupCheck.disabled = true;
  setClaudeSetupStatus("Checking this IDEL server...");
  try {
    const available = await refreshAgentAvailability();
    if (available) {
      const shouldSwitchToAsk = switchToAskAfterSetup;
      setClaudeSetupStatus("Ask Claude is ready.");
      closeClaudeSetupDialog();
      if (shouldSwitchToAsk) activateAskMode();
    } else {
      setClaudeSetupStatus("Still not configured. Restart this UI after installing Claude Code or setting ANTHROPIC_API_KEY.");
    }
  } finally {
    if (claudeSetupCheck) claudeSetupCheck.disabled = false;
  }
}

function setAgentAvailability(available) {
  agentStatusKnown = true;
  agentAvailable = available;
  modeAskBtn.disabled = false;
  modeAskBtn.classList.toggle("unavailable", !available);
  modeAskBtn.setAttribute("aria-disabled", String(!available));
  modeAskBtn.title = available
    ? "Ask Claude in natural language"
    : "Ask Claude is not set up. Click for setup instructions.";
  if (!available && mode === "ask") setMode("idel", { suppressSetup: true });
}

function askClaudeUnavailable() {
  return agentStatusKnown && !agentAvailable;
}

async function refreshAgentAvailability() {
  try {
    const res = await fetch("/api/health");
    const d = res.ok ? await res.json() : null;
    if (d?.ok && Object.prototype.hasOwnProperty.call(d, "agentAvailable")) {
      if (Object.prototype.hasOwnProperty.call(d, "platform")) setServerPlatform(d.platform);
      setAgentAvailability(d.agentAvailable !== false);
      return agentAvailable;
    }
  } catch {
    return agentAvailable;
  }
  return await probeAgentAvailability();
}

async function probeAgentAvailability() {
  try {
    const probe = await fetch("/api/agent/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: "" }),
    });
    if (probe.body?.cancel) await probe.body.cancel().catch(() => undefined);
    if (probe.status === 501) {
      setAgentAvailability(false);
      return false;
    }
    if (probe.ok) {
      setAgentAvailability(true);
      return true;
    }
  } catch {
    /* keep the last known state */
  }
  return agentAvailable;
}

function initScreenshotActions() {
  for (const btn of screenshotScopeButtons) {
    btn.addEventListener("click", () => setScreenshotScope(btn.dataset.screenshotScope));
  }
  screenshotClose?.addEventListener("click", closeScreenshotDialog);
  screenshotDialog?.addEventListener("click", (e) => {
    if (e.target === screenshotDialog) closeScreenshotDialog();
  });
  screenshotCopy?.addEventListener("click", () => void exportScreenshot("copy"));
  screenshotDownload?.addEventListener("click", () => void exportScreenshot("download"));
  setScreenshotScope("visible");
}

function setScreenshotScope(scope) {
  screenshotScope = scope === "full" ? "full" : "visible";
  for (const btn of screenshotScopeButtons) {
    const active = btn.dataset.screenshotScope === screenshotScope;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-pressed", String(active));
  }
}

function readPreferences() {
  const theme = storageGet(PREF_KEYS.theme);
  const palette = storageGet(PREF_KEYS.palette);
  const fontSize = storageGet(PREF_KEYS.fontSize);
  const showLogs = storageGet(PREF_KEYS.showLogs);
  return {
    theme: THEMES.has(theme) ? theme : DEFAULT_PREFERENCES.theme,
    palette: PALETTES.has(palette) ? palette : DEFAULT_PREFERENCES.palette,
    fontSize: FONT_SIZES.has(fontSize) ? fontSize : DEFAULT_PREFERENCES.fontSize,
    showLogs: showLogs === null ? DEFAULT_PREFERENCES.showLogs : showLogs !== "false",
  };
}

function currentPreferences() {
  return {
    theme: classChoice(THEMES, "theme", DEFAULT_PREFERENCES.theme),
    palette: classChoice(PALETTES, "palette", DEFAULT_PREFERENCES.palette),
    fontSize: classChoice(FONT_SIZES, "font", DEFAULT_PREFERENCES.fontSize),
    showLogs: !document.body.classList.contains("logs-hidden"),
  };
}

function classChoice(options, prefix, fallback) {
  for (const option of options) {
    if (document.body.classList.contains(`${prefix}-${option}`)) return option;
  }
  return fallback;
}

function applyPreferences(next, persist = true) {
  const prefs = {
    theme: THEMES.has(next.theme) ? next.theme : DEFAULT_PREFERENCES.theme,
    palette: PALETTES.has(next.palette) ? next.palette : DEFAULT_PREFERENCES.palette,
    fontSize: FONT_SIZES.has(next.fontSize) ? next.fontSize : DEFAULT_PREFERENCES.fontSize,
    showLogs: next.showLogs !== false,
  };
  replaceBodyChoice(THEMES, "theme", prefs.theme);
  replaceBodyChoice(PALETTES, "palette", prefs.palette);
  replaceBodyChoice(FONT_SIZES, "font", prefs.fontSize);
  document.body.classList.toggle("logs-hidden", !prefs.showLogs);
  if (showLogsInput) showLogsInput.checked = prefs.showLogs;
  syncChoiceButtons(themeButtons, "theme", prefs.theme);
  syncChoiceButtons(paletteButtons, "palette", prefs.palette);
  syncChoiceButtons(fontSizeButtons, "fontSize", prefs.fontSize);
  if (persist) {
    storageSet(PREF_KEYS.theme, prefs.theme);
    storageSet(PREF_KEYS.palette, prefs.palette);
    storageSet(PREF_KEYS.fontSize, prefs.fontSize);
    storageSet(PREF_KEYS.showLogs, String(prefs.showLogs));
  }
}

function replaceBodyChoice(options, prefix, selected) {
  for (const option of options) document.body.classList.remove(`${prefix}-${option}`);
  document.body.classList.add(`${prefix}-${selected}`);
}

function syncChoiceButtons(buttons, key, selected) {
  for (const btn of buttons) {
    const active = btn.dataset[key] === selected;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-pressed", String(active));
  }
}

function openPreferences() {
  if (!preferencesDialog) return;
  if (typeof preferencesDialog.showModal === "function") preferencesDialog.showModal();
  else preferencesDialog.setAttribute("open", "");
}

function closePreferences() {
  if (!preferencesDialog) return;
  if (typeof preferencesDialog.close === "function" && preferencesDialog.open) preferencesDialog.close();
  else preferencesDialog.removeAttribute("open");
}

function storageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* preferences are best-effort */
  }
}

function initWorkspace() {
  const terminal = {
    id: `tab-${nextTabId++}`,
    type: "terminal",
    title: "Terminal 1",
    pane: initialOutput,
    history: [],
    histIdx: -1,
  };
  terminalCount = 1;
  tabs.push(terminal);
  activeTabId = terminal.id;
  lastTerminalTabId = terminal.id;
  renderTabs();
}

function initPageRefreshGuard() {
  window.addEventListener("beforeunload", (e) => {
    if (!shouldConfirmPageExit()) return;
    e.preventDefault();
    e.returnValue = PAGE_EXIT_MESSAGE;
    return PAGE_EXIT_MESSAGE;
  });

  window.addEventListener("keydown", (e) => {
    const key = e.key.toLowerCase();
    const refreshShortcut =
      key === "f5" ||
      ((e.ctrlKey || e.metaKey) && key === "r");
    if (!refreshShortcut || !shouldConfirmPageExit()) return;
    if (confirm(PAGE_EXIT_MESSAGE)) return;
    e.preventDefault();
    e.stopPropagation();
  }, { capture: true });
}

function shouldConfirmPageExit() {
  return true;
}

function activeTab() {
  return tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];
}

function activeTerminalTab() {
  const tab = activeTab();
  if (tab?.type === "terminal") return tab;
  return tabs.find((candidate) => candidate.id === lastTerminalTabId && candidate.type === "terminal")
    ?? tabs.find((candidate) => candidate.type === "terminal")
    ?? createTerminalTab(false);
}

function activeOutput() {
  return activeTerminalTab().pane;
}

function syncCommandArea() {
  const editorActive = activeTab()?.type === "editor";
  form.hidden = editorActive;
  form.setAttribute("aria-hidden", String(editorActive));
  input.disabled = editorActive || commandBusy;
  if (editorActive) {
    input.value = "";
    hideCompletions();
  }
  resizeCommandInput();
}

function createTerminalTab(activate = true) {
  terminalCount += 1;
  const pane = document.createElement("section");
  pane.className = "term-output";
  pane.setAttribute("aria-live", "polite");
  pane.hidden = true;
  pane.appendChild(lineNode(`Terminal ${terminalCount}. Type an IDEL command and press Enter.`, "muted"));
  form.parentNode.insertBefore(pane, form);
  const tab = {
    id: `tab-${nextTabId++}`,
    type: "terminal",
    title: `Terminal ${terminalCount}`,
    pane,
    history: [],
    histIdx: -1,
  };
  tabs.push(tab);
  if (activate) switchTab(tab.id);
  else renderTabs();
  return tab;
}

function switchTab(id) {
  const tab = tabs.find((candidate) => candidate.id === id);
  if (!tab) return;
  activeTabId = tab.id;
  if (tab.type === "terminal") lastTerminalTabId = tab.id;
  for (const candidate of tabs) candidate.pane.hidden = candidate.id !== tab.id;
  syncCommandArea();
  completionsEl.hidden = true;
  if (tab.type === "editor") hideCompletions();
  else input.focus();
  renderTabs();
}

function closeTab(tab) {
  if (!tab) return;
  if (tab.type === "terminal" && tabs.filter((candidate) => candidate.type === "terminal").length === 1) {
    return;
  }
  if (tab.type === "editor" && tab.dirty && !confirm(`Close ${tab.title} without saving?`)) return;
  const index = tabs.findIndex((candidate) => candidate.id === tab.id);
  if (index === -1) return;
  const closingActiveEditor = activeTabId === tab.id && tab.type === "editor";
  tabs.splice(index, 1);
  tab.pane.remove();
  if (lastTerminalTabId === tab.id) {
    lastTerminalTabId = tabs.find((candidate) => candidate.type === "terminal")?.id ?? "";
  }
  if (activeTabId === tab.id) {
    const terminal = closingActiveEditor
      ? tabs.find((candidate) => candidate.id === lastTerminalTabId && candidate.type === "terminal")
        ?? tabs.find((candidate) => candidate.type === "terminal")
      : undefined;
    const next = terminal ?? tabs[index] ?? tabs[index - 1] ?? tabs.find((candidate) => candidate.type === "terminal");
    if (next) switchTab(next.id);
  } else {
    renderTabs();
  }
}

function renderTabs() {
  for (const node of Array.from(tabsEl.querySelectorAll(".workspace-tab"))) node.remove();
  for (const tab of tabs) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "workspace-tab";
    btn.classList.toggle("active", tab.id === activeTabId);
    btn.classList.toggle("dirty", Boolean(tab.dirty));
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-selected", String(tab.id === activeTabId));
    btn.title = tab.title;
    const label = document.createElement("span");
    label.className = "tab-label";
    label.textContent = tab.title;
    btn.appendChild(label);
    const canClose = tab.type === "editor" || tabs.filter((candidate) => candidate.type === "terminal").length > 1;
    if (canClose) {
      const close = document.createElement("span");
      close.className = "tab-close";
      close.textContent = "x";
      close.addEventListener("click", (e) => {
        e.stopPropagation();
        closeTab(tab);
      });
      btn.appendChild(close);
    }
    btn.addEventListener("click", () => switchTab(tab.id));
    tabsEl.insertBefore(btn, newTerminalBtn);
  }
}

function lineNode(text, cls = "") {
  const div = document.createElement("div");
  div.className = "line " + cls;
  const body = document.createElement("span");
  body.className = "line-body";
  body.textContent = text;
  div.appendChild(body);
  attachLineActions(div, body.textContent, cls);
  return div;
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function attachLineActions(lineEl, text, cls = "") {
  if (!shouldAddLineActions(cls, text)) return;
  lineEl.classList.add("has-actions");
  const actions = document.createElement("span");
  actions.className = "line-actions";
  actions.setAttribute("aria-label", "Line actions");

  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "line-action";
  copy.textContent = "Copy";
  copy.title = cls.includes("cmd") || cls.includes("ask") ? "Copy command" : "Copy output";
  copy.addEventListener("click", () => void copyLineText(text, copy));

  const shot = document.createElement("button");
  shot.type = "button";
  shot.className = "line-action";
  shot.textContent = "Shot";
  shot.title = "Screenshot terminal";
  shot.addEventListener("click", () => openScreenshotDialog(lineEl.closest(".term-output")));

  actions.append(copy, shot);
  lineEl.appendChild(actions);
}

function shouldAddLineActions(cls, text) {
  if (!String(text ?? "").trim()) return false;
  const classes = new Set(String(cls).split(/\s+/).filter(Boolean));
  return ["cmd", "ask", "text", "err", "ok"].some((name) => classes.has(name));
}

function line(text, cls = "") {
  const output = activeOutput();
  const div = lineNode(text, cls);
  output.appendChild(div);
  output.scrollTop = output.scrollHeight;
  return div;
}

function html(node) {
  const output = activeOutput();
  output.appendChild(node);
  output.scrollTop = output.scrollHeight;
}

function terminalLines(output = activeOutput()) {
  return Array.from(output?.children ?? []).filter((node) => node.classList?.contains("line"));
}

function clearTerminalLines(command) {
  const parsed = parseIdelLine(command);
  const name = parsed.command === "clear" || parsed.command === "cleare.all" ? "clear.all" : parsed.command;
  const output = activeOutput();
  const lines = terminalLines(output);
  const positional = parsed.args[0];

  if (name === "clear.all") {
    output.replaceChildren();
    return true;
  }

  if (name === "clear.last" || name === "clear.first") {
    const limit = positiveInteger(parsed.params.limit ?? positional ?? 1);
    if (!limit) return clearUsage(command, "limit must be a positive number.");
    const selected = name === "clear.last" ? lines.slice(-limit) : lines.slice(0, limit);
    for (const node of selected) node.remove();
    output.scrollTop = output.scrollHeight;
    return true;
  }

  if (name === "clear.range") {
    const from = positiveInteger(parsed.params.from);
    const to = positiveInteger(parsed.params.to);
    if (!from || !to) return clearUsage(command, "from and to must be positive row numbers.");
    if (from > to) return clearUsage(command, "from must be less than or equal to to.");
    const selected = lines.slice(from - 1, to);
    for (const node of selected) node.remove();
    output.scrollTop = Math.min(output.scrollTop, output.scrollHeight);
    return true;
  }

  return false;
}

function isLocalClearCommand(command) {
  const parsed = parseIdelLine(command);
  return new Set(["clear", "clear.all", "clear.last", "clear.first", "clear.range", "cleare.all"]).has(parsed.command);
}

function isSingleLocalClearCommand(command) {
  if (!isLocalClearCommand(command)) return false;
  try {
    return splitBatchLine(command).length === 1;
  } catch {
    return false;
  }
}

function clearUsage(command, reason) {
  line("idel> " + command, "cmd");
  line(`${reason} Usage: clear.all | clear.last limit=10 | clear.first limit=10 | clear.range from=2 to=5`, "err");
  return true;
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : 0;
}

async function copyLineText(text, button) {
  try {
    await writeClipboardText(text);
    flashButton(button, "Copied");
  } catch {
    flashButton(button, "Failed");
  }
}

async function writeClipboardText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.left = "-9999px";
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand("copy");
  ta.remove();
  if (!ok) throw new Error("copy failed");
}

function flashButton(button, label) {
  if (!button) return;
  const previous = button.textContent;
  button.textContent = label;
  window.setTimeout(() => {
    button.textContent = previous;
  }, 1100);
}

function openScreenshotDialog(sourceOutput = activeOutput()) {
  screenshotSource = sourceOutput || activeOutput();
  setScreenshotScope(screenshotScope);
  if (!screenshotDialog) return;
  if (typeof screenshotDialog.showModal === "function") screenshotDialog.showModal();
  else screenshotDialog.setAttribute("open", "");
}

function closeScreenshotDialog() {
  if (!screenshotDialog) return;
  if (typeof screenshotDialog.close === "function" && screenshotDialog.open) screenshotDialog.close();
  else screenshotDialog.removeAttribute("open");
}

async function exportScreenshot(action) {
  const output = screenshotSource || activeOutput();
  const text = screenshotText(output, screenshotScope);
  if (!text.trim()) {
    flashButton(action === "copy" ? screenshotCopy : screenshotDownload, "Empty");
    return;
  }
  const redacted = screenshotRedact?.checked ? redactScreenshotText(text) : text;
  const canvas = renderTextScreenshot(output, redacted, screenshotScope);
  if (action === "copy") {
    try {
      await copyCanvasPng(canvas);
      flashButton(screenshotCopy, "Copied");
      return;
    } catch {
      downloadCanvasPng(canvas);
      flashButton(screenshotCopy, "Saved");
      return;
    }
  }
  downloadCanvasPng(canvas);
  flashButton(screenshotDownload, "Saved");
}

function screenshotText(output, scope) {
  const lineEls = terminalLineElements(output, scope);
  return lineEls.map(textFromTerminalLine).filter(Boolean).join("\n");
}

function terminalLineElements(output, scope) {
  const children = Array.from(output?.children ?? []).filter((node) => node.classList?.contains("line"));
  if (scope !== "visible") return children;
  const viewport = output.getBoundingClientRect();
  return children.filter((node) => {
    const rect = node.getBoundingClientRect();
    return rect.bottom >= viewport.top && rect.top <= viewport.bottom;
  });
}

function textFromTerminalLine(node) {
  const directBody = node.querySelector(":scope > .line-body");
  if (directBody) return directBody.textContent.trimEnd();
  const childLines = Array.from(node.children).filter((child) => child.classList?.contains("line"));
  if (childLines.length) return childLines.map(textFromTerminalLine).filter(Boolean).join("\n");
  const clone = node.cloneNode(true);
  for (const action of clone.querySelectorAll(".line-actions")) action.remove();
  return clone.textContent.trimEnd();
}

function redactScreenshotText(text) {
  let next = text
    .replace(/-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/g, "[hidden private key]")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/g, "$1[hidden]")
    .replace(/\b(sk-[A-Za-z0-9_-]{16,})\b/g, "[hidden token]")
    .replace(/\b(gh[pousr]_[A-Za-z0-9_]{16,})\b/g, "[hidden token]")
    .replace(/\b([A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASS)[A-Z0-9_]*)\s*=\s*([^\s"'`]+)/gi, "$1=[hidden]")
    .replace(/\b([A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASS)[A-Z0-9_]*)\s*=\s*["'`]([^"'`]+)["'`]/gi, "$1=\"[hidden]\"");
  for (const term of customRedactionTerms()) {
    next = next.replace(new RegExp(escapeRegex(term), "g"), "[hidden]");
  }
  return next;
}

function customRedactionTerms() {
  return String(screenshotRedactText?.value ?? "")
    .split(/[\n,]/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function renderTextScreenshot(output, text, scope) {
  const outputStyle = getComputedStyle(output);
  const bodyStyle = getComputedStyle(document.body);
  const fontSize = Number.parseFloat(outputStyle.fontSize) || 14;
  const lineHeight = Number.parseFloat(outputStyle.lineHeight) || fontSize * 1.55;
  const padding = 18;
  const width = Math.max(340, Math.min(output.clientWidth || 900, 1400));
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  const font = `${fontSize}px ${outputStyle.fontFamily || "monospace"}`;
  ctx.font = font;
  const wrapped = wrapScreenshotText(ctx, text, width - padding * 2);
  const maxRows = Math.max(1, Math.floor((24000 - padding * 2) / lineHeight));
  const rows = wrapped.length > maxRows
    ? wrapped.slice(0, maxRows - 1).concat(`[${scope} screenshot truncated]`)
    : wrapped;
  const height = Math.ceil(padding * 2 + rows.length * lineHeight);
  const ratio = height > 14000 ? 1 : Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.ceil(width * ratio);
  canvas.height = Math.ceil(height * ratio);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  ctx.scale(ratio, ratio);
  ctx.fillStyle = outputStyle.backgroundColor && outputStyle.backgroundColor !== "rgba(0, 0, 0, 0)"
    ? outputStyle.backgroundColor
    : bodyStyle.backgroundColor || "#0b0e14";
  ctx.fillRect(0, 0, width, height);
  ctx.font = font;
  ctx.textBaseline = "top";
  ctx.fillStyle = outputStyle.color || bodyStyle.color || "#d7dce5";
  rows.forEach((row, index) => {
    ctx.fillText(row || " ", padding, padding + index * lineHeight);
  });
  return canvas;
}

function wrapScreenshotText(ctx, text, maxWidth) {
  const rows = [];
  for (const rawLine of String(text).split("\n")) {
    if (!rawLine) {
      rows.push("");
      continue;
    }
    let line = "";
    for (const chunk of rawLine.split(/(\s+)/)) {
      const candidate = line + chunk;
      if (ctx.measureText(candidate).width <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line) rows.push(line.trimEnd());
      line = "";
      if (ctx.measureText(chunk).width <= maxWidth) {
        line = chunk.trimStart();
        continue;
      }
      const parts = splitLongScreenshotChunk(ctx, chunk, maxWidth);
      rows.push(...parts.slice(0, -1));
      line = parts.at(-1) ?? "";
    }
    rows.push(line.trimEnd());
  }
  return rows;
}

function splitLongScreenshotChunk(ctx, chunk, maxWidth) {
  const parts = [];
  let line = "";
  for (const ch of chunk) {
    if (ctx.measureText(line + ch).width <= maxWidth) {
      line += ch;
      continue;
    }
    if (line) parts.push(line);
    line = ch;
  }
  if (line) parts.push(line);
  return parts;
}

async function copyCanvasPng(canvas) {
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
    throw new Error("image clipboard unavailable");
  }
  const blob = await canvasToBlob(canvas);
  await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
}

function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("png export failed")), "image/png");
  });
}

function downloadCanvasPng(canvas) {
  const a = document.createElement("a");
  a.href = canvas.toDataURL("image/png");
  a.download = `idel-${screenshotScope}-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** The platform command an outcome maps to (the "original command" preview). */
function translateLine(o) {
  const plan = o.plan;
  if (!plan) return "";
  if (plan.command === "@node") return plan.describe || "";
  return plan.command + (plan.argv?.length ? " " + plan.argv.join(" ") : "");
}

/** Render a RuntimeOutcome the way the CLI's `render()` does, but as DOM. */
function renderOutcome(o) {
  if (!o || !o.record) return;
  const wrap = document.createElement("div");
  wrap.className = "line";

  // "Translates to" — show the real adapter invocation this IDEL command maps to.
  const translated = translateLine(o);
  if (translated) {
    const tl = document.createElement("div");
    tl.className = "line muted";
    tl.textContent = "translates to: " + translated;
    wrap.appendChild(tl);
  }

  const risk = o.risk?.level ?? "LOW";
  const head = document.createElement("div");
  head.innerHTML =
    `Risk: <span class="risk-${risk}">${risk}</span>` +
    `  ·  Decision: <span class="risk-${risk}">${(o.decision?.action ?? "").toUpperCase()}</span>`;
  wrap.appendChild(head);

  for (const f of o.risk?.findings ?? []) {
    const fl = document.createElement("div");
    fl.className = "line muted";
    fl.textContent = `  - [${f.level}] ${f.code}: ${f.message}`;
    wrap.appendChild(fl);
  }
  if (typeof o.record.affectedPathsEstimate === "number") {
    const af = document.createElement("div");
    af.className = "line muted";
    af.textContent = `  affected paths (estimate): ${o.record.affectedPathsEstimate}`;
    wrap.appendChild(af);
  }

  const res = o.record.result;
  const resLine = document.createElement("div");
  resLine.className =
    "line " + (res === "blocked_before_execution" ? "err" : res === "success" || res === "dry_run" ? "ok" : "");
  resLine.textContent = describeResult(res);
  wrap.appendChild(resLine);

  const out = o.result;
  if (out) {
    if (out.simulated && out.stdout) line(out.stdout, "muted");
    else {
      if (out.stdout?.trim()) line(out.stdout.replace(/\n$/, ""), "text");
      if (out.stderr?.trim()) line(out.stderr.replace(/\n$/, ""), "err");
    }
  }
  html(wrap);
}

function describeResult(r) {
  switch (r) {
    case "success":
      return "✓ executed.";
    case "dry_run":
      return "dry run. No files were changed.";
    case "blocked_before_execution":
      return "BLOCKED. No files were changed.";
    case "approval_required":
      return "approval required — re-run with confirmation.";
    case "failed":
      return "failed.";
    default:
      return String(r ?? "");
  }
}

// ---------------------------------------------------------------------------
// SSE plumbing (POST + ReadableStream — EventSource can't POST a body)
// ---------------------------------------------------------------------------

async function postSse(path, body, onEvent) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    const txt = await res.text().catch(() => "");
    onEvent("error", { error: `HTTP ${res.status}${txt ? ": " + txt : ""}` });
    onEvent("done", {});
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    // Parse complete SSE frames (separated by a blank line).
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = "message";
      let data = "";
      for (const l of frame.split("\n")) {
        if (l.startsWith("event:")) event = l.slice(6).trim();
        else if (l.startsWith("data:")) data += l.slice(5).trim();
      }
      let parsed = {};
      try {
        parsed = data ? JSON.parse(data) : {};
      } catch {
        /* ignore malformed frame */
      }
      onEvent(event, parsed);
    }
  }
}

// ---------------------------------------------------------------------------
// Run (IDEL mode)
// ---------------------------------------------------------------------------

async function runIdel(command) {
  line("idel> " + command, "cmd");
  await postSse("/api/run/stream", { command, dryRun: false }, (event, data) => {
    if (event === "outcome") renderOutcome(data);
    else if (event === "batch_start") line(`batch: ${data.commands?.length ?? 0} step(s)`, "muted");
    else if (event === "batch_step") line(`batch ${data.index}/${data.total}> ${data.command}`, "muted");
    else if (event === "batch_stop") {
      const skipped = Math.max(0, Number(data.total ?? 0) - Number(data.index ?? 0));
      line(`batch stopped at step ${data.index}; ${skipped} step(s) skipped`, "err");
    }
    else if (event === "error") line("Error: " + (data.error ?? "unknown"), "err");
  });
  refreshLogs();
}

async function runMultilineBatch(raw) {
  const commands = multilineCommands(raw);
  line("idel> " + raw, "cmd");
  line(`batch: ${commands.length} step(s)`, "muted");
  for (let i = 0; i < commands.length; i++) {
    const command = commands[i];
    line(`batch ${i + 1}/${commands.length}> ${command}`, "muted");
    const ok = await runBatchStep(command);
    if (!ok) {
      const skipped = Math.max(0, commands.length - i - 1);
      if (skipped) line(`batch stopped at step ${i + 1}; ${skipped} step(s) skipped`, "err");
      break;
    }
  }
  refreshLogs();
}

async function runBatchStep(command) {
  if (isLocalClearCommand(command)) return clearTerminalLines(command);
  let lastOutcome;
  let stopped = false;
  let errored = false;
  await postSse("/api/run/stream", { command, dryRun: false }, (event, data) => {
    if (event === "outcome") {
      lastOutcome = data;
      renderOutcome(data);
    } else if (event === "batch_start") line(`nested batch: ${data.commands?.length ?? 0} step(s)`, "muted");
    else if (event === "batch_step") line(`nested batch ${data.index}/${data.total}> ${data.command}`, "muted");
    else if (event === "batch_stop") {
      stopped = true;
      line(`nested batch stopped at step ${data.index}`, "err");
    }
    else if (event === "error") {
      errored = true;
      line("Error: " + (data.error ?? "unknown"), "err");
    }
  });
  return !errored && !stopped && outcomeSucceeded(lastOutcome);
}

function outcomeSucceeded(outcome) {
  const result = outcome?.record?.result;
  return result === "success" || result === "dry_run";
}

async function runEditorCommand(command) {
  const parsed = parseIdelLine(command);
  const file = parsed.params.file ?? parsed.params.path;
  line("idel> " + command, "cmd");
  if (!file) {
    line("open.editor requires file=<path>", "err");
    return;
  }
  try {
    const res = await fetch("/api/editor/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      line("Editor error: " + (body.error ?? `HTTP ${res.status}`), "err");
      return;
    }
    renderInlineEditor(body.file, body.content ?? "", body.language ?? languageForPath(body.file));
  } catch (err) {
    line("Editor error: " + (err?.message ?? String(err)), "err");
  } finally {
    refreshLogs();
  }
}

function renderInlineEditor(file, content, language) {
  const existing = tabs.find((tab) => tab.type === "editor" && tab.editorState?.file === file);
  if (existing) {
    switchTab(existing.id);
    return;
  }

  const pane = document.createElement("section");
  pane.className = "editor-workspace editor-card";
  pane.hidden = true;
  form.parentNode.insertBefore(pane, form);
  const tab = {
    id: `tab-${nextTabId++}`,
    type: "editor",
    title: file,
    pane,
    dirty: false,
    editorState: undefined,
  };
  tabs.push(tab);

  const card = pane;

  const state = {
    file,
    language: language || languageForPath(file),
    clean: content,
    saving: false,
    history: [{ value: content, start: 0, end: 0 }],
    historyIndex: 0,
    applyingHistory: false,
  };
  tab.editorState = state;

  const head = document.createElement("div");
  head.className = "editor-head";
  const title = document.createElement("div");
  title.className = "editor-title";
  title.textContent = file;
  const meta = document.createElement("span");
  meta.className = "editor-lang";
  meta.textContent = state.language;
  const status = document.createElement("span");
  status.className = "editor-status";
  status.textContent = "opened";
  const tools = document.createElement("div");
  tools.className = "editor-tools";
  const undo = editorButton("Undo");
  const redo = editorButton("Redo");
  const save = editorButton("Save");
  const saveAs = editorButton("Save As");
  const find = editorButton("Find");
  const reload = editorButton("Reload");
  const close = editorButton("Close");
  tools.append(undo, redo, save, saveAs, find, reload, close);
  head.append(title, meta, status, tools);

  const findBar = document.createElement("div");
  findBar.className = "editor-findbar";
  findBar.hidden = true;
  const findInput = editorFindInput("Find");
  const replaceInput = editorFindInput("Replace");
  const matchInfo = document.createElement("span");
  matchInfo.className = "editor-match";
  matchInfo.textContent = "0/0";
  const prevMatch = editorButton("Prev");
  const nextMatch = editorButton("Next");
  const replaceOne = editorButton("Replace");
  const replaceAll = editorButton("All");
  const caseToggle = editorButton("Aa");
  caseToggle.setAttribute("aria-pressed", "false");
  const closeFind = editorButton("Close");
  findBar.append(
    findInput,
    replaceInput,
    matchInfo,
    prevMatch,
    nextMatch,
    replaceOne,
    replaceAll,
    caseToggle,
    closeFind,
  );

  const shell = document.createElement("div");
  shell.className = "editor-shell";
  const pre = document.createElement("pre");
  pre.className = "editor-highlight";
  const code = document.createElement("code");
  pre.appendChild(code);
  const ta = document.createElement("textarea");
  ta.className = "editor-input";
  ta.spellcheck = false;
  ta.autocapitalize = "off";
  ta.autocomplete = "off";
  ta.setAttribute("aria-label", `Editor for ${file}`);
  ta.value = content;
  shell.append(pre, ta);

  const setDirty = () => {
    const dirty = ta.value !== state.clean;
    tab.dirty = dirty;
    card.classList.toggle("dirty", dirty);
    status.textContent = dirty ? "modified" : "saved";
    updateHistoryButtons();
    renderTabs();
  };
  const syncHighlight = () => {
    code.innerHTML = highlightCode(ta.value, state.language) + "\n";
    pre.scrollTop = ta.scrollTop;
    pre.scrollLeft = ta.scrollLeft;
  };
  const setContent = (next, nextLanguage = state.language) => {
    state.clean = next;
    state.language = nextLanguage;
    meta.textContent = state.language;
    ta.value = next;
    resetHistory(next);
    syncHighlight();
    setDirty();
  };

  ta.addEventListener("input", () => {
    recordHistory();
    syncHighlight();
    setDirty();
    updateFindInfo();
  });
  ta.addEventListener("scroll", () => {
    pre.scrollTop = ta.scrollTop;
    pre.scrollLeft = ta.scrollLeft;
  });
  ta.addEventListener("select", updateFindInfo);
  ta.addEventListener("mouseup", updateFindInfo);
  ta.addEventListener("keyup", updateFindInfo);
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Tab") {
      e.preventDefault();
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      ta.setRangeText("  ", start, end, "end");
      ta.dispatchEvent(new Event("input"));
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      if (e.shiftKey) void saveEditorAs();
      else void saveEditorBuffer();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
      e.preventDefault();
      showFind();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "h") {
      e.preventDefault();
      showFind(true);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      if (!findBar.hidden) hideFind();
      else closeEditor();
    }
  });

  async function saveEditorBuffer(targetFile = state.file) {
    if (state.saving) return;
    const file = String(targetFile ?? "").trim();
    if (!file) {
      line("Editor save failed: file path is required", "err");
      return;
    }
    state.saving = true;
    status.textContent = "saving";
    save.disabled = saveAs.disabled = reload.disabled = true;
    try {
      const res = await fetch("/api/editor/save", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file, content: ta.value }),
      });
      const outcome = await res.json().catch(() => ({}));
      if (!res.ok) {
        status.textContent = "save failed";
        line("Editor save failed: " + (outcome.error ?? `HTTP ${res.status}`), "err");
        return;
      }
      if (outcome.record?.result === "success") {
        state.file = file;
        state.language = languageForPath(file);
        state.clean = ta.value;
        title.textContent = state.file;
        tab.title = state.file;
        tab.editorState = state;
        meta.textContent = state.language;
        ta.setAttribute("aria-label", `Editor for ${state.file}`);
        syncHighlight();
        status.textContent = "saved";
        setDirty();
      } else {
        status.textContent = "save blocked";
        renderOutcome(outcome);
      }
      refreshLogs();
    } catch (err) {
      status.textContent = "save failed";
      line("Editor save failed: " + (err?.message ?? String(err)), "err");
    } finally {
      state.saving = false;
      save.disabled = saveAs.disabled = reload.disabled = false;
    }
  }

  async function saveEditorAs() {
    const next = prompt("Save as", state.file);
    if (next === null) return;
    await saveEditorBuffer(next);
  }

  async function reloadEditorBuffer() {
    if (ta.value !== state.clean && !confirm(`Discard unsaved changes to ${state.file}?`)) return;
    status.textContent = "loading";
    try {
      const res = await fetch("/api/editor/open", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file: state.file }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        status.textContent = "reload failed";
        line("Editor reload failed: " + (body.error ?? `HTTP ${res.status}`), "err");
        return;
      }
      setContent(body.content ?? "", body.language ?? languageForPath(state.file));
      status.textContent = "reloaded";
      updateFindInfo();
      refreshLogs();
    } catch (err) {
      status.textContent = "reload failed";
      line("Editor reload failed: " + (err?.message ?? String(err)), "err");
    }
  }

  function closeEditor() {
    closeTab(tab);
  }

  function resetHistory(value) {
    state.history = [{ value, start: ta.selectionStart, end: ta.selectionEnd }];
    state.historyIndex = 0;
    updateHistoryButtons();
  }

  function recordHistory() {
    if (state.applyingHistory) return;
    const current = state.history[state.historyIndex];
    if (current?.value === ta.value) return;
    state.history = state.history.slice(0, state.historyIndex + 1);
    state.history.push({
      value: ta.value,
      start: ta.selectionStart,
      end: ta.selectionEnd,
    });
    if (state.history.length > 120) state.history.shift();
    state.historyIndex = state.history.length - 1;
    updateHistoryButtons();
  }

  function applyHistory(index) {
    const snapshot = state.history[index];
    if (!snapshot) return;
    state.applyingHistory = true;
    state.historyIndex = index;
    ta.value = snapshot.value;
    syncHighlight();
    setDirty();
    updateFindInfo();
    ta.focus();
    ta.setSelectionRange(snapshot.start, snapshot.end);
    state.applyingHistory = false;
  }

  function updateHistoryButtons() {
    undo.disabled = state.historyIndex <= 0;
    redo.disabled = state.historyIndex >= state.history.length - 1;
  }

  function runEditCommand(command) {
    ta.focus();
    if (command === "undo") applyHistory(Math.max(0, state.historyIndex - 1));
    if (command === "redo") applyHistory(Math.min(state.history.length - 1, state.historyIndex + 1));
  }

  function showFind(focusReplace = false) {
    const selected = ta.value.slice(ta.selectionStart, ta.selectionEnd);
    if (!focusReplace && selected && !selected.includes("\n")) findInput.value = selected;
    findBar.hidden = false;
    updateFindInfo();
    (focusReplace ? replaceInput : findInput).focus();
    (focusReplace ? replaceInput : findInput).select();
  }

  function hideFind() {
    findBar.hidden = true;
    ta.focus();
  }

  function currentFindQuery() {
    return {
      query: findInput.value,
      caseSensitive: caseToggle.getAttribute("aria-pressed") === "true",
    };
  }

  function findMatches() {
    const { query, caseSensitive } = currentFindQuery();
    if (!query) return [];
    const source = caseSensitive ? ta.value : ta.value.toLowerCase();
    const needle = caseSensitive ? query : query.toLowerCase();
    const matches = [];
    let index = 0;
    while (index <= source.length) {
      const found = source.indexOf(needle, index);
      if (found === -1) break;
      matches.push({ start: found, end: found + query.length });
      index = found + Math.max(query.length, 1);
    }
    return matches;
  }

  function selectedMatchIndex(matches) {
    return matches.findIndex((m) => m.start === ta.selectionStart && m.end === ta.selectionEnd);
  }

  function updateFindInfo() {
    if (findBar.hidden) return;
    const matches = findMatches();
    const idx = selectedMatchIndex(matches);
    matchInfo.textContent = matches.length ? `${idx >= 0 ? idx + 1 : 0}/${matches.length}` : "0/0";
  }

  function selectMatch(match) {
    if (!match) {
      updateFindInfo();
      return;
    }
    ta.focus();
    ta.setSelectionRange(match.start, match.end);
    const lineHeight = Number.parseFloat(getComputedStyle(ta).lineHeight) || 20;
    const before = ta.value.slice(0, match.start);
    const row = before.split("\n").length - 1;
    ta.scrollTop = Math.max(0, row * lineHeight - ta.clientHeight / 2);
    pre.scrollTop = ta.scrollTop;
    updateFindInfo();
  }

  function findNextMatch(reverse = false) {
    const matches = findMatches();
    if (!matches.length) {
      updateFindInfo();
      return;
    }
    const selected = selectedMatchIndex(matches);
    let nextIndex;
    if (selected >= 0) {
      nextIndex = reverse
        ? (selected - 1 + matches.length) % matches.length
        : (selected + 1) % matches.length;
    } else if (reverse) {
      nextIndex = matches.findLastIndex((m) => m.start < ta.selectionStart);
      if (nextIndex < 0) nextIndex = matches.length - 1;
    } else {
      nextIndex = matches.findIndex((m) => m.start >= ta.selectionEnd);
      if (nextIndex < 0) nextIndex = 0;
    }
    selectMatch(matches[nextIndex]);
  }

  function selectedTextMatchesQuery() {
    const { query, caseSensitive } = currentFindQuery();
    if (!query || ta.selectionStart === ta.selectionEnd) return false;
    const selected = ta.value.slice(ta.selectionStart, ta.selectionEnd);
    return caseSensitive
      ? selected === query
      : selected.toLowerCase() === query.toLowerCase();
  }

  function replaceCurrentMatch() {
    if (!selectedTextMatchesQuery()) {
      findNextMatch(false);
      return;
    }
    const start = ta.selectionStart;
    ta.setRangeText(replaceInput.value, ta.selectionStart, ta.selectionEnd, "select");
    ta.setSelectionRange(start, start + replaceInput.value.length);
    ta.dispatchEvent(new Event("input"));
    findNextMatch(false);
  }

  function replaceEveryMatch() {
    const matches = findMatches();
    if (!matches.length) {
      updateFindInfo();
      return;
    }
    let next = "";
    let offset = 0;
    for (const match of matches) {
      next += ta.value.slice(offset, match.start) + replaceInput.value;
      offset = match.end;
    }
    next += ta.value.slice(offset);
    ta.focus();
    ta.setRangeText(next, 0, ta.value.length, "end");
    ta.dispatchEvent(new Event("input"));
  }

  findInput.addEventListener("input", updateFindInfo);
  replaceInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      replaceCurrentMatch();
    }
  });
  findInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      findNextMatch(e.shiftKey);
    }
    if (e.key === "Escape") {
      e.preventDefault();
      hideFind();
    }
  });
  prevMatch.addEventListener("click", () => findNextMatch(true));
  nextMatch.addEventListener("click", () => findNextMatch(false));
  replaceOne.addEventListener("click", replaceCurrentMatch);
  replaceAll.addEventListener("click", replaceEveryMatch);
  caseToggle.addEventListener("click", () => {
    const pressed = caseToggle.getAttribute("aria-pressed") === "true";
    caseToggle.setAttribute("aria-pressed", String(!pressed));
    caseToggle.classList.toggle("active", !pressed);
    updateFindInfo();
  });
  closeFind.addEventListener("click", hideFind);

  undo.addEventListener("click", () => runEditCommand("undo"));
  redo.addEventListener("click", () => runEditCommand("redo"));
  save.addEventListener("click", () => void saveEditorBuffer());
  saveAs.addEventListener("click", () => void saveEditorAs());
  find.addEventListener("click", () => showFind());
  reload.addEventListener("click", () => void reloadEditorBuffer());
  close.addEventListener("click", closeEditor);

  pane.append(head, findBar, shell);
  syncHighlight();
  setDirty();
  switchTab(tab.id);
  ta.focus();
}

function editorButton(label) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "editor-btn";
  btn.textContent = label;
  btn.title = label;
  return btn;
}

function editorFindInput(label) {
  const field = document.createElement("input");
  field.type = "text";
  field.className = "editor-find-input";
  field.placeholder = label;
  field.setAttribute("aria-label", label);
  return field;
}

function parseIdelLine(value) {
  const tokens = tokenizeIdel(value.trim());
  const [command = "", ...rest] = tokens;
  const params = {};
  const args = [];
  for (const token of rest) {
    const eq = token.indexOf("=");
    if (eq <= 0) {
      args.push(token);
      continue;
    }
    params[token.slice(0, eq)] = token.slice(eq + 1);
  }
  return { command, params, args };
}

function tokenizeIdel(value) {
  const tokens = [];
  let i = 0;
  while (i < value.length) {
    while (i < value.length && /\s/.test(value[i])) i++;
    if (i >= value.length) break;
    let token = "";
    while (i < value.length && !/\s/.test(value[i])) {
      const ch = value[i];
      if (ch === "'" || ch === '"') {
        const quote = ch;
        i++;
        while (i < value.length) {
          const q = value[i];
          if (q === "\\") {
            if (i + 1 < value.length) token += value[i + 1];
            i += 2;
            continue;
          }
          if (q === quote) {
            i++;
            break;
          }
          token += q;
          i++;
        }
        continue;
      }
      if (ch === "\\") {
        if (i + 1 < value.length) token += value[i + 1];
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

function isEditorCommand(value) {
  const parsed = parseIdelLine(value);
  return parsed.command === "open.editor" || parsed.command === "edit.file";
}

function isAskAiCommand(value) {
  return parseIdelLine(value).command === "ask.ai";
}

function parseLearnCommand(value) {
  let tokens = tokenizeIdel(value.trim());
  if (tokens[0] === "idel") tokens = tokens.slice(1);
  const head = tokens[0];
  if (head !== "learn" && head !== "learn.cli") return null;
  let cli = "";
  let write = false;
  for (const token of tokens.slice(1)) {
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
      if (key === "cli" || key === "name" || key === "tool") cli = token.slice(eq + 1);
      continue;
    }
    if (!cli && !token.startsWith("-")) cli = token;
  }
  return { cli, write };
}

function splitBatchLine(value) {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("!")) return [trimmed];
  const parts = [];
  let start = 0;
  let quote;
  let escaped = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "&" && value[i + 1] === "&") {
      const part = value.slice(start, i).trim();
      if (!part) throw new Error("Empty command in batch near `&&`");
      parts.push(part);
      i += 1;
      start = i + 1;
    }
  }
  const tail = value.slice(start).trim();
  if (!tail) throw new Error("Empty command in batch near `&&`");
  parts.push(tail);
  return parts;
}

function isBatchLine(value) {
  try {
    return splitBatchLine(value).length > 1;
  } catch {
    return true;
  }
}

function askAiIntent(value) {
  const tokens = tokenizeIdel(value.trim());
  if (tokens[0] !== "ask.ai") return "";
  const rest = tokens.slice(1);
  const promptKeys = new Set(["prompt", "question", "intent", "message", "text"]);
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    const eq = token.indexOf("=");
    if (eq <= 0) continue;
    const key = token.slice(0, eq);
    if (!promptKeys.has(key)) continue;
    const words = [token.slice(eq + 1)];
    for (let j = i + 1; j < rest.length; j++) {
      if (/^[a-z][a-zA-Z0-9]*=/.test(rest[j])) break;
      words.push(rest[j]);
    }
    return words.join(" ").trim();
  }
  return rest.filter((token) => !/^[a-z][a-zA-Z0-9]*=/.test(token)).join(" ").trim();
}

async function runLearnCommand(command) {
  const parsed = parseLearnCommand(command);
  line("idel> " + command, "cmd");
  if (!parsed?.cli) {
    line("Usage: learn <cli> [--write]  or  learn.cli cli=<cli> write=true", "err");
    return;
  }
  line(`Introspecting "${parsed.cli}" and drafting IDEL commands...`, "muted");
  try {
    const res = await fetch("/api/learn", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cli: parsed.cli, write: parsed.write }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      line("Learn error: " + (body.error ?? `HTTP ${res.status}`), "err");
      return;
    }
    renderLearnResult(body);
  } catch (err) {
    line("Learn error: " + (err?.message ?? String(err)), "err");
  } finally {
    refreshLogs();
  }
}

function renderLearnResult(result) {
  const accepted = Number(result.accepted ?? 0);
  const rejected = Number(result.rejected ?? 0);
  line(`Learned ${result.cli ?? ""}  (${accepted} accepted, ${rejected} rejected)`, "text");
  for (const cmd of result.commands ?? []) {
    const mark = cmd.accepted ? "✓" : "✗";
    const cls = cmd.accepted ? "ok" : "err";
    const risk = cmd.risk ? ` [${cmd.risk}]` : "";
    line(`  ${mark} ${cmd.id}${risk}  ${cmd.summary ?? (cmd.errors ?? []).join("; ")}`, cls);
    for (const failure of cmd.verification?.failures ?? []) {
      line(`      · ${failure}`, "err");
    }
  }
  if (result.path) {
    invalidateDictionary();
    line(`wrote and loaded ${accepted} learned command(s) from ${result.path}`, "ok");
  } else if (accepted > 0) {
    line(`Preview only. Re-run with --write to save ${accepted} command(s).`, "muted");
  } else {
    line("Nothing valid to learn; no defs written.", "err");
  }
}

function invalidateDictionary() {
  dictionaryEntries = [];
  dictionaryLoaded = false;
  if (!dictionaryDialog?.open) return;
  void loadDictionary().then(renderDictionary);
}

function languageForPath(file) {
  const lower = String(file).toLowerCase();
  if (lower.endsWith(".json") || lower.endsWith(".jsonl")) return "json";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "html";
  if (lower.endsWith(".css")) return "css";
  if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) return "javascript";
  if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return "typescript";
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "markdown";
  if (lower.endsWith(".sh") || lower.endsWith(".bash") || lower.endsWith(".zsh")) return "shell";
  if (lower.endsWith(".yml") || lower.endsWith(".yaml")) return "yaml";
  return "text";
}

function highlightCode(code, language) {
  if (language === "json") return highlightJson(code);
  if (language === "html") return highlightByRules(code, htmlRules);
  if (language === "css") return highlightByRules(code, cssRules);
  if (language === "javascript" || language === "typescript") return highlightByRules(code, jsRules);
  if (language === "markdown") return highlightByRules(code, markdownRules);
  if (language === "shell") return highlightByRules(code, shellRules);
  if (language === "yaml") return highlightByRules(code, yamlRules);
  return escapeHtml(code);
}

function highlightJson(code) {
  const rules = [
    {
      className: "tok-string",
      re: /"(?:\\[\s\S]|[^"\\])*"/y,
      classify: (value, input, end) => {
        let i = end;
        while (/\s/.test(input[i] ?? "")) i++;
        return input[i] === ":" ? "tok-key" : "tok-string";
      },
    },
    { className: "tok-number", re: /-?\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b/iy },
    { className: "tok-keyword", re: /\b(?:true|false|null)\b/y },
    { className: "tok-punct", re: /[{}[\],:]/y },
  ];
  return highlightByRules(code, rules);
}

function highlightByRules(code, rules) {
  let out = "";
  let i = 0;
  while (i < code.length) {
    let matched = false;
    for (const rule of rules) {
      rule.re.lastIndex = i;
      const m = rule.re.exec(code);
      if (!m || m.index !== i) continue;
      const raw = m[0];
      const cls = rule.classify ? rule.classify(raw, code, i + raw.length) : rule.className;
      out += `<span class="${cls}">${escapeHtml(raw)}</span>`;
      i += raw.length;
      matched = true;
      break;
    }
    if (!matched) {
      out += escapeHtml(code[i]);
      i++;
    }
  }
  return out;
}

const htmlRules = [
  { className: "tok-comment", re: /<!--[\s\S]*?-->/y },
  { className: "tok-tag", re: /<\/?[A-Za-z][^>]*>/y },
  { className: "tok-entity", re: /&[A-Za-z0-9#]+;/y },
];

const cssRules = [
  { className: "tok-comment", re: /\/\*[\s\S]*?\*\//y },
  { className: "tok-string", re: /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'/y },
  { className: "tok-keyword", re: /@[A-Za-z-]+/y },
  { className: "tok-number", re: /-?\b\d+(?:\.\d+)?(?:px|rem|em|vh|vw|%|s|ms)?\b/y },
  { className: "tok-key", re: /--?[A-Za-z][A-Za-z0-9-]*(?=\s*:)/y },
  { className: "tok-punct", re: /[{}:;,()]/y },
];

const jsRules = [
  { className: "tok-comment", re: /\/\/[^\n]*|\/\*[\s\S]*?\*\//y },
  { className: "tok-string", re: /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`/y },
  {
    className: "tok-keyword",
    re: /\b(?:async|await|break|case|catch|class|const|continue|default|else|export|extends|false|finally|for|from|function|if|import|in|interface|let|new|null|return|switch|true|try|type|undefined|var|while|yield)\b/y,
  },
  { className: "tok-number", re: /\b\d+(?:\.\d+)?\b/y },
  { className: "tok-key", re: /\b[A-Za-z_$][\w$]*(?=\s*:)/y },
  { className: "tok-punct", re: /[{}[\]().,;:?]/y },
];

const markdownRules = [
  { className: "tok-keyword", re: /^#{1,6}[^\n]*/my },
  { className: "tok-string", re: /`[^`\n]+`/y },
  { className: "tok-key", re: /\[[^\]]+\]\([^)]+\)/y },
  { className: "tok-comment", re: /^>\s.*$/my },
];

const shellRules = [
  { className: "tok-comment", re: /#[^\n]*/y },
  { className: "tok-string", re: /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'/y },
  { className: "tok-keyword", re: /\b(?:case|do|done|elif|else|esac|fi|for|function|if|in|then|while)\b/y },
  { className: "tok-key", re: /\$[A-Za-z_][A-Za-z0-9_]*|\$\{[^}]+\}/y },
];

const yamlRules = [
  { className: "tok-comment", re: /#[^\n]*/y },
  { className: "tok-string", re: /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'/y },
  { className: "tok-key", re: /^[ \t-]*[A-Za-z0-9_.-]+(?=\s*:)/my },
  { className: "tok-keyword", re: /\b(?:true|false|null)\b/y },
  { className: "tok-number", re: /-?\b\d+(?:\.\d+)?\b/y },
];

// ---------------------------------------------------------------------------
// Ask (Claude mode)
// ---------------------------------------------------------------------------

async function runAsk(intent, displayLine) {
  if (askClaudeUnavailable()) {
    line(displayLine ?? "? " + intent, displayLine ? "cmd" : "ask");
    line("Ask Claude is not set up. Opened setup guide.", "err");
    openClaudeSetupDialog({ switchToAsk: true });
    return;
  }
  line(displayLine ?? "? " + intent, displayLine ? "cmd" : "ask");
  let sawAgent = false;
  // allowReal:true lets the agent request a REAL run — but each one still pauses
  // here for an explicit human click (the server parks until we POST /approve).
  await postSse("/api/agent/stream", { intent, allowReal: true }, (event, data) => {
    sawAgent = true;
    switch (event) {
      case "text":
        if (data.text?.trim()) line(data.text.replace(/\n+$/, ""), "text");
        break;
      case "proposed":
        line(data.dryRun ? "↳ proposed (dry-run): " + data.command : "↳ ran: " + data.command, "muted");
        renderOutcome(data.outcome);
        break;
      case "blocked":
        line("↳ BLOCKED: " + data.command, "err");
        renderOutcome(data.outcome);
        break;
      case "approval_request":
        // The agent is parked server-side awaiting our decision. Show the
        // dry-run and Approve/Decline buttons; clicking POSTs the decision and
        // the same SSE stream resumes with the real outcome (or the dry-run
        // standing). No second connection, no key in the browser.
        renderApprovalPrompt(data);
        break;
      case "needs_approval":
        line("↳ declined: " + data.command + " (dry-run result stands)", "muted");
        break;
      case "tool_error":
        line(`↳ tool error (${data.tool}): ${data.message}`, "err");
        break;
      case "error":
        if (String(data.error ?? "").includes("agent not configured")) {
          setAgentAvailability(false);
          openClaudeSetupDialog({ switchToAsk: true, message: data.error });
        }
        line("Agent error: " + (data.error ?? "unknown"), "err");
        break;
    }
  });
  if (!sawAgent) {
    line(
      "(no response — install Claude Code + run `claude login`, or set ANTHROPIC_API_KEY on the server)",
      "muted",
    );
  }
  refreshLogs();
}

/** Render a real-run approval card with Approve / Decline buttons. */
function renderApprovalPrompt(data) {
  line("↳ wants to run for REAL: " + data.command, "ask");
  if (data.outcome) renderOutcome(data.outcome);

  const card = document.createElement("div");
  card.className = "line approval";
  const q = document.createElement("span");
  q.textContent = "Run this for real? ";
  const yes = document.createElement("button");
  yes.className = "appr-btn yes";
  yes.textContent = "Approve";
  const no = document.createElement("button");
  no.className = "appr-btn no";
  no.textContent = "Decline";

  let settled = false;
  const decide = async (approve) => {
    if (settled) return;
    settled = true;
    yes.disabled = no.disabled = true;
    card.classList.add("decided");
    q.textContent = approve ? "Approved — running… " : "Declined. ";
    try {
      await fetch("/api/agent/approve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ approvalId: data.approvalId, approve }),
      });
    } catch {
      line("(failed to send approval — the agent may have timed out)", "err");
    }
  };
  yes.addEventListener("click", () => decide(true));
  no.addEventListener("click", () => decide(false));
  card.append(q, yes, no);
  html(card);
}

// ---------------------------------------------------------------------------
// Completion (IDEL mode only)
// ---------------------------------------------------------------------------

let completeTimer;
const COMPLETION_LIMIT = 30;
async function updateCompletions() {
  if (mode !== "idel" || activeTab()?.type !== "terminal") return hideCompletions();
  const value = currentInputSegment().value;
  if (!value.trim()) return hideCompletions();
  clearTimeout(completeTimer);
  completeTimer = setTimeout(async () => {
    try {
      const res = await fetch("/api/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: value }),
      });
      completions = res.ok ? await res.json() : [];
    } catch {
      completions = [];
    }
    renderCompletions();
  }, 90);
}

function renderCompletions() {
  if (!completions.length) return hideCompletions();
  completionsEl.innerHTML = "";
  if (compSel >= visibleCompletionCount()) compSel = visibleCompletionCount() - 1;
  completions.slice(0, COMPLETION_LIMIT).forEach((c, i) => {
    const li = document.createElement("li");
    li.textContent = c;
    li.addEventListener("mousedown", (e) => {
      e.preventDefault();
      applyCompletion(c);
    });
    completionsEl.appendChild(li);
  });
  completionsEl.hidden = false;
  updateCompletionSelection();
}

function visibleCompletionCount() {
  return Math.min(completions.length, COMPLETION_LIMIT);
}

function updateCompletionSelection() {
  const items = Array.from(completionsEl.children);
  items.forEach((item, i) => {
    item.classList.toggle("sel", i === compSel);
  });
  scrollSelectedCompletionIntoView();
}

function scrollSelectedCompletionIntoView() {
  if (completionsEl.hidden || compSel < 0) return;
  scrollSelectedCompletionIntoViewNow();
  window.requestAnimationFrame?.(scrollSelectedCompletionIntoViewNow);
}

function scrollSelectedCompletionIntoViewNow() {
  if (completionsEl.hidden || compSel < 0) return;
  const selected = completionsEl.children[compSel] ?? completionsEl.querySelector("li.sel");
  if (!selected) return;
  const containerRect = completionsEl.getBoundingClientRect();
  const selectedRect = selected.getBoundingClientRect();
  const topOverflow = selectedRect.top - containerRect.top;
  const bottomOverflow = selectedRect.bottom - containerRect.bottom;

  if (topOverflow < 0) {
    completionsEl.scrollTop += topOverflow;
  } else if (bottomOverflow > 0) {
    completionsEl.scrollTop += bottomOverflow;
  }
}

function hideCompletions() {
  completionsEl.hidden = true;
  completions = [];
  compSel = -1;
}

function applyCompletion(c) {
  // The server returns whole-token suggestions; replace the last token.
  const segment = currentInputSegment();
  const value = segment.value;
  const bounds = lastTokenBounds(value);
  const replacement =
    value.slice(0, bounds.start) +
    c +
    value.slice(bounds.end) +
    completionSuffix(c, value, bounds);
  input.value =
    input.value.slice(0, segment.start) +
    replacement +
    input.value.slice(segment.end);
  const cursor = segment.start + replacement.length;
  input.setSelectionRange?.(cursor, cursor);
  hideCompletions();
  resizeCommandInput();
  input.focus();
}

function completionSuffix(c, value, bounds) {
  if (isCommandCompletion(value, bounds)) return "";
  if (c.endsWith("=") || c.endsWith("/") || c.endsWith("\\") || c.endsWith(".")) return "";
  return " ";
}

function isCommandCompletion(value, bounds) {
  const segmentStart = currentBatchSegmentStart(value);
  const prefix = value.slice(segmentStart, bounds.start);
  const segment = value.slice(segmentStart);
  if (segment.trimStart().startsWith("!")) return false;
  return prefix.trim() === "";
}

function currentBatchSegmentStart(value) {
  const trimmed = value.trimStart();
  if (trimmed.startsWith("!")) return 0;
  let start = 0;
  let quote;
  let escaped = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "&" && value[i + 1] === "&") {
      start = i + 2;
      i += 1;
    }
  }
  return start;
}

function lastTokenBounds(value) {
  if (endsWithTokenSeparator(value)) return { start: value.length, end: value.length };
  let start = 0;
  let quote;
  let escaped = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) start = i + 1;
  }
  return { start, end: value.length };
}

function endsWithTokenSeparator(value) {
  if (!/\s$/.test(value)) return false;
  let quote;
  let escaped = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
  }
  return quote === undefined && !escaped;
}

// ---------------------------------------------------------------------------
// Audit log side panel
// ---------------------------------------------------------------------------

async function refreshLogs() {
  try {
    const res = await fetch("/api/logs?limit=20");
    if (!res.ok) return;
    const recs = await res.json();
    logsEl.innerHTML = "";
    for (const r of recs.reverse()) {
      const div = document.createElement("div");
      div.className = "log-rec";
      const src = r.source === "agent" ? '<span class="log-src-agent">agent</span>' : r.source;
      div.innerHTML =
        `<div class="lr-cmd">${escapeHtml(r.command)}</div>` +
        `<div class="lr-meta"><span class="risk-${r.risk}">${r.risk}</span> · ${r.policyDecision} · ${r.result} · ${src}</div>`;
      logsEl.appendChild(div);
    }
  } catch {
    /* logs are best-effort */
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
}

// ---------------------------------------------------------------------------
// Mode switching + input handling
// ---------------------------------------------------------------------------

function setMode(next, options = {}) {
  if (next === "ask" && askClaudeUnavailable()) {
    if (!options.suppressSetup) openClaudeSetupDialog({ switchToAsk: true });
    next = "idel";
  }
  mode = next;
  modeIdelBtn.classList.toggle("active", mode === "idel");
  modeAskBtn.classList.toggle("active", mode === "ask");
  promptEl.textContent = mode === "ask" ? "?" : "idel>";
  promptEl.classList.toggle("ask", mode === "ask");
  syncInputPlaceholder();
  hideCompletions();
  syncCommandArea();
  resizeCommandInput();
  if (activeTab()?.type !== "editor") input.focus();
}

function syncInputPlaceholder() {
  const compact = compactInputMedia?.matches ?? false;
  input.placeholder =
    mode === "ask"
      ? compact ? "ask what to do" : "describe what you want — e.g. delete the dist folder"
      : multilineBatch
        ? compact ? "batch lines (Ctrl+Enter)" : "one command per line   (Ctrl+Enter to run, Tab completes current line)"
        : compact ? "command (Tab, ↑/↓)" : "verb.scope param=value   (Tab to complete, ↑/↓ history)";
}

function setMultilineBatch(next) {
  multilineBatch = Boolean(next);
  form.classList.toggle("multiline", multilineBatch);
  batchToggle?.classList.toggle("active", multilineBatch);
  batchToggle?.setAttribute("aria-pressed", String(multilineBatch));
  batchToggle?.setAttribute(
    "title",
    multilineBatch
      ? "Multiline batch input is on. Use Ctrl+Enter to run."
      : "Multiline batch input. Use Ctrl+Enter to run.",
  );
  renderKnowledgeBase();
  syncInputPlaceholder();
  resizeCommandInput();
  input.focus();
}

function resizeCommandInput() {
  if (!input || input.tagName !== "TEXTAREA") return;
  input.style.height = "auto";
  const max = multilineBatch ? 144 : 32;
  const nextHeight = Math.min(input.scrollHeight, max);
  input.style.height = `${Math.max(nextHeight, 22)}px`;
  input.style.overflowY = input.scrollHeight > max ? "auto" : "hidden";
}

function currentInputSegment() {
  if (!multilineBatch) return { start: 0, end: input.value.length, value: input.value };
  const cursor = input.selectionStart ?? input.value.length;
  const start = input.value.slice(0, cursor).lastIndexOf("\n") + 1;
  const nextNewline = input.value.indexOf("\n", cursor);
  const end = nextNewline === -1 ? input.value.length : nextNewline;
  return { start, end, value: input.value.slice(start, end) };
}

function multilineCommands(value) {
  return String(value)
    .split(/\r?\n/)
    .map((lineText) => lineText.trim())
    .filter(Boolean);
}

function activateAskMode() {
  setMode("ask");
  switchTab(activeTerminalTab().id);
}

modeIdelBtn.addEventListener("click", () => {
  setMode("idel");
  switchTab(activeTerminalTab().id);
});
modeAskBtn.addEventListener("click", () => {
  if (askClaudeUnavailable()) {
    openClaudeSetupDialog({ switchToAsk: true });
    return;
  }
  activateAskMode();
});
$("refresh-logs").addEventListener("click", refreshLogs);
newTerminalBtn.addEventListener("click", () => createTerminalTab(true));
if (compactInputMedia?.addEventListener) compactInputMedia.addEventListener("change", syncInputPlaceholder);
else if (compactInputMedia?.addListener) compactInputMedia.addListener(syncInputPlaceholder);

batchToggle?.addEventListener("click", () => setMultilineBatch(!multilineBatch));

input.addEventListener("input", () => {
  resizeCommandInput();
  void updateCompletions();
});

input.addEventListener("keydown", (e) => {
  if (e.ctrlKey && !e.metaKey && e.key.toLowerCase() === "c") {
    if (input.value.length > 0 || !completionsEl.hidden) {
      e.preventDefault();
      input.value = "";
      activeTerminalTab().histIdx = -1;
      hideCompletions();
      line("^C", "muted");
    }
    return;
  }
  if (e.key === "Enter") {
    if (multilineBatch) {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        submitCommandInput();
      }
      return;
    }
    e.preventDefault();
    submitCommandInput();
    return;
  }
  if (!completionsEl.hidden && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
    e.preventDefault();
    const n = visibleCompletionCount();
    if (!n) return hideCompletions();
    compSel =
      e.key === "ArrowDown"
        ? compSel < 0
          ? 0
          : (compSel + 1) % n
        : compSel < 0
          ? n - 1
          : (compSel - 1 + n) % n;
    updateCompletionSelection();
    return;
  }
  if (e.key === "Tab") {
    e.preventDefault();
    if (completions.length) applyCompletion(completions[compSel >= 0 ? compSel : 0]);
    return;
  }
  if (e.key === "Escape") return hideCompletions();
  if (e.key === "ArrowUp" && completionsEl.hidden) {
    e.preventDefault();
    const terminal = activeTerminalTab();
    if (terminal.history.length) {
      terminal.histIdx = terminal.histIdx < 0 ? terminal.history.length - 1 : Math.max(0, terminal.histIdx - 1);
      input.value = terminal.history[terminal.histIdx] ?? "";
      resizeCommandInput();
    }
  }
  if (e.key === "ArrowDown" && completionsEl.hidden) {
    e.preventDefault();
    const terminal = activeTerminalTab();
    if (terminal.histIdx >= 0) {
      terminal.histIdx = terminal.histIdx + 1;
      input.value = terminal.histIdx >= terminal.history.length ? ((terminal.histIdx = -1), "") : terminal.history[terminal.histIdx];
      resizeCommandInput();
    }
  }
});

form.addEventListener("submit", (e) => {
  e.preventDefault();
  submitCommandInput();
});

function submitCommandInput() {
  void submitCommandInputAsync();
}

async function submitCommandInputAsync() {
  const value = input.value.trim();
  if (input.disabled) return;
  if (!value) return;
  const terminal = activeTerminalTab();
  terminal.history.push(value);
  terminal.histIdx = -1;
  input.value = "";
  resizeCommandInput();
  hideCompletions();
  commandBusy = true;
  syncCommandArea();
  try {
    if (mode === "ask") await runAsk(value);
    else if (multilineBatch && multilineCommands(value).length > 1) await runMultilineBatch(value);
    else if (isSingleLocalClearCommand(value)) clearTerminalLines(value);
    else if (isBatchLine(value)) await runIdel(value);
    else if (parseLearnCommand(value)) await runLearnCommand(value);
    else if (isAskAiCommand(value)) {
      const intent = askAiIntent(value);
      if (intent) await runAsk(intent, "idel> " + value);
      else line('Usage: ask.ai prompt="what you want to do"', "err");
    }
    else if (isEditorCommand(value)) await runEditorCommand(value);
    else await runIdel(value);
  } finally {
    commandBusy = false;
    syncCommandArea();
    if (activeTab()?.type !== "editor") input.focus();
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  let sawHealthAgentStatus = false;
  try {
    const res = await fetch("/api/health");
    const d = res.ok ? await res.json() : null;
    if (d?.ok) {
      statusEl.textContent = "● online · idel " + (d.version ?? "");
      statusEl.classList.add("online");
      if (Object.prototype.hasOwnProperty.call(d, "platform")) setServerPlatform(d.platform);
      if (Object.prototype.hasOwnProperty.call(d, "agentAvailable")) {
        sawHealthAgentStatus = true;
        setAgentAvailability(d.agentAvailable !== false);
      }
    } else throw new Error();
  } catch {
    statusEl.textContent = "○ offline — start `idel serve --static …`";
    statusEl.classList.add("offline");
  }
  // Probe whether the Claude console is wired on older servers that do not
  // expose health.agentAvailable yet.
  if (!sawHealthAgentStatus) await probeAgentAvailability();
  setMode(mode, { suppressSetup: true });
  refreshLogs();
}

initPreferences();
initClaudeSetupDialog();
initDictionary();
initKnowledgeBase();
initScreenshotActions();
initWorkspace();
initPageRefreshGuard();
setServerPlatform("");
setMultilineBatch(false);
boot();
