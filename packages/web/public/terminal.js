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
const riskIndicator = $("risk-indicator");
const completionsEl = $("completions");
const statusEl = $("status");
const logsEl = $("logs");
const tabsEl = $("tabs");
const modeIdelBtn = $("mode-idel");
const modeAskBtn = $("mode-ask");
const newTerminalBtn = $("new-terminal");
const newNativeTerminalBtn = $("new-native-terminal");
const paletteDialog = $("palette-dialog");
const paletteOpen = $("palette-open");
const paletteClose = $("palette-close");
const paletteSearch = $("palette-search");
const paletteResults = $("palette-results");
const paletteEmpty = $("palette-empty");
const workflowDialog = $("workflow-dialog");
const workflowOpen = $("workflow-open");
const workflowClose = $("workflow-close");
const workflowName = $("workflow-name");
const workflowCommand = $("workflow-command");
const workflowSave = $("workflow-save");
const workflowFillCurrent = $("workflow-fill-current");
const workflowList = $("workflow-list");
const workflowEmpty = $("workflow-empty");
const nativeSessionsDialog = $("native-sessions-dialog");
const nativeSessionsOpen = $("native-sessions-open");
const nativeSessionsClose = $("native-sessions-close");
const nativeSessionsRefresh = $("native-sessions-refresh");
const nativeSessionsCloseAll = $("native-sessions-close-all");
const nativeSessionsList = $("native-sessions-list");
const nativeSessionsEmpty = $("native-sessions-empty");
const setupDialog = $("setup-check-dialog");
const setupOpen = $("setup-open");
const setupClose = $("setup-close");
const setupChecks = $("setup-checks");
const setupDismiss = $("setup-dismiss");
const setupOpenDictionary = $("setup-open-dictionary");
const setupOpenWorkflows = $("setup-open-workflows");
const setupOpenAi = $("setup-open-ai");
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
const blockPasteInput = $("pref-block-paste");
const blockCopyInput = $("pref-block-copy");
const themeButtons = Array.from(document.querySelectorAll("[data-theme]"));
const paletteButtons = Array.from(document.querySelectorAll("[data-palette]"));
const fontSizeButtons = Array.from(document.querySelectorAll("[data-font-size]"));
const effectButtons = Array.from(document.querySelectorAll("[data-effect]"));
const paletteSelected = $("palette-selected");
const paletteSelectedSwatch = $("palette-selected-swatch");
const screenshotDialog = $("screenshot-dialog");
const screenshotClose = $("screenshot-close");
const screenshotRedact = $("screenshot-redact");
const screenshotRedactText = $("screenshot-redact-text");
const screenshotCopy = $("screenshot-copy");
const screenshotDownload = $("screenshot-download");
const screenshotScopeButtons = Array.from(document.querySelectorAll("[data-screenshot-scope]"));
const pageReloadDialog = $("page-reload-dialog");
const pageReloadStay = $("page-reload-stay");
const pageReloadStayX = $("page-reload-stay-x");
const pageReloadConfirm = $("page-reload-confirm");
const pasteConfirmDialog = $("paste-confirm-dialog");
const pasteConfirmPreview = $("paste-confirm-preview");
const pasteConfirmCancel = $("paste-confirm-cancel");
const pasteConfirmCancelX = $("paste-confirm-cancel-x");
const pasteConfirmRun = $("paste-confirm-run");

let mode = location.hash === "#ask" ? "ask" : "idel";
let completions = [];
let compSel = -1;
let nextTabId = 1;
let terminalCount = 0;
let nativeTerminalCount = 0;
let activeTabId = "";
let lastTerminalTabId = "";
const tabs = [];
const compactInputMedia = typeof window.matchMedia === "function" ? window.matchMedia("(max-width: 520px)") : null;
const reducedMotionMedia = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
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
let paletteItems = [];
let paletteSel = 0;
let registryCommandCount = 0;
let serverOnline = false;
let nativeAvailable = true;
let nativeSessionRefreshTimer = 0;
let nextNativeGeneration = 1;
let riskPreviewTimer = 0;
let riskPreviewSeq = 0;
let riskPreviewAbort = null;
let effectCanvas = null;
let matrixAnimationId = 0;
let matrixColumns = [];
let matrixLastFrame = 0;
let pageReloadConfirmed = false;
let pendingNativePaste = null;

const THEMES = new Set(["dark", "light"]);
const PALETTES = new Set(["cyan", "blue", "sky", "teal", "mint", "green", "lime", "amber", "orange", "rose", "red", "fuchsia", "violet", "indigo", "slate", "stone"]);
const FONT_SIZES = new Set(["small", "normal", "large", "xlarge"]);
const EFFECTS = new Set(["none", "matrix", "scanlines", "glow", "grid", "pulse", "static"]);
const PREF_KEYS = {
  theme: "idel.theme",
  palette: "idel.palette",
  fontSize: "idel.fontSize",
  effect: "idel.effect",
  showLogs: "idel.showLogs",
  blockPaste: "idel.blockPaste",
  blockCopy: "idel.blockCopy",
};
const WORKFLOW_KEY = "idel.workflows";
const SETUP_DISMISSED_KEY = "idel.setup.dismissed";
const PAGE_EXIT_MESSAGE =
  "Refresh or leave IDEL terminal? Current terminal output, running commands, and unsaved editor changes may be lost.";
const DEFAULT_PREFERENCES = {
  theme: "dark",
  palette: "cyan",
  fontSize: "normal",
  effect: "none",
  showLogs: true,
  blockPaste: false,
  blockCopy: false,
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
  initHeaderMenus();
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
  for (const btn of effectButtons) {
    btn.addEventListener("click", () => {
      applyPreferences({ ...currentPreferences(), effect: btn.dataset.effect });
    });
  }
  showLogsInput?.addEventListener("change", () => {
    applyPreferences({ ...currentPreferences(), showLogs: showLogsInput.checked });
  });
  blockPasteInput?.addEventListener("change", () => {
    applyPreferences({ ...currentPreferences(), blockPaste: blockPasteInput.checked });
  });
  blockCopyInput?.addEventListener("change", () => {
    applyPreferences({ ...currentPreferences(), blockCopy: blockCopyInput.checked });
  });
  document.addEventListener("copy", (e) => {
    if (!clipboardCopyBlocked() || !isTerminalCopyTarget(e.target)) return;
    e.preventDefault();
    line("Copy is blocked by Preferences.", "muted");
  }, { capture: true });
  pasteConfirmCancel?.addEventListener("click", closePasteConfirmDialog);
  pasteConfirmCancelX?.addEventListener("click", closePasteConfirmDialog);
  pasteConfirmRun?.addEventListener("click", confirmNativePaste);
  pasteConfirmDialog?.addEventListener("cancel", (e) => {
    e.preventDefault();
    closePasteConfirmDialog();
  });
  pasteConfirmDialog?.addEventListener("click", (e) => {
    if (e.target === pasteConfirmDialog) closePasteConfirmDialog();
  });
  const syncMotion = () => applyTerminalEffect(currentPreferences().effect);
  if (reducedMotionMedia?.addEventListener) reducedMotionMedia.addEventListener("change", syncMotion);
  else if (reducedMotionMedia?.addListener) reducedMotionMedia.addListener(syncMotion);
  preferencesOpen?.addEventListener("click", openPreferences);
  preferencesClose?.addEventListener("click", closePreferences);
  preferencesDialog?.addEventListener("click", (e) => {
    if (e.target === preferencesDialog) closePreferences();
  });
}

function initHeaderMenus() {
  const menus = Array.from(document.querySelectorAll(".header-menu"));
  for (const menu of menus) {
    menu.addEventListener("toggle", () => {
      if (!menu.open) return;
      for (const other of menus) {
        if (other !== menu) other.open = false;
      }
    });
  }
  document.querySelector(".actions-menu .header-menu-panel")?.addEventListener("click", (e) => {
    if (!(e.target instanceof HTMLButtonElement)) return;
    const menu = e.currentTarget.closest(".header-menu");
    window.setTimeout(() => {
      if (menu) menu.open = false;
    }, 0);
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
  focusActiveInput();
}

function initCommandPalette() {
  paletteOpen?.addEventListener("click", () => void openCommandPalette());
  paletteClose?.addEventListener("click", closeCommandPalette);
  paletteDialog?.addEventListener("click", (e) => {
    if (e.target === paletteDialog) closeCommandPalette();
  });
  paletteSearch?.addEventListener("input", renderCommandPalette);
  paletteSearch?.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeCommandPalette();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const count = paletteItems.length;
      if (!count) return;
      paletteSel =
        e.key === "ArrowDown"
          ? (paletteSel + 1) % count
          : (paletteSel - 1 + count) % count;
      syncPaletteSelection();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const item = paletteItems[paletteSel] ?? paletteItems[0];
      if (item) runPaletteItem(item);
    }
  });
  window.addEventListener("keydown", (e) => {
    const key = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && key === "k") {
      e.preventDefault();
      void openCommandPalette();
    }
  });
}

async function openCommandPalette() {
  if (!paletteDialog) return;
  if (typeof paletteDialog.showModal === "function") paletteDialog.showModal();
  else paletteDialog.setAttribute("open", "");
  paletteSearch.value = "";
  renderCommandPalette();
  paletteSearch?.focus();
  await loadDictionary();
  renderCommandPalette();
}

function closeCommandPalette() {
  if (!paletteDialog) return;
  if (typeof paletteDialog.close === "function" && paletteDialog.open) paletteDialog.close();
  else paletteDialog.removeAttribute("open");
  focusActiveInput();
}

function buildPaletteItems(query) {
  const active = activeTab();
  const actions = [
    paletteAction("New terminal", "Workspace", "Open a new terminal tab", () => createTerminalTab(true)),
    paletteAction("New native shell", "Workspace", "Open a direct OS shell tab", () => createNativeTerminalTab(true)),
    paletteAction("Open shell sessions", "Workspace", "Attach, focus, or close native shell sessions", () => void openNativeSessionsDialog()),
    paletteAction("Open dictionary", "Reference", "Search IDEL to OS mappings", () => void openDictionary()),
    paletteAction("Open knowledge base", "Reference", "Batch, native, sudo, and package examples", openKnowledgeBase),
    paletteAction("Open workflows", "Workflow", "Create and run saved batches", openWorkflowDialog),
    paletteAction("Open setup checklist", "Setup", "Review local IDEL readiness", () => void openSetupChecklist()),
    paletteAction("Preferences", "Settings", "Theme, palette, font size, audit panel", openPreferences),
    paletteAction("Ask Claude setup", "AI", "Configure Claude Code or ANTHROPIC_API_KEY", () => openClaudeSetupDialog()),
    paletteAction(multilineBatch ? "Turn batch input off" : "Turn batch input on", "Input", "Switch single-line and multiline command entry", () => setMultilineBatch(!multilineBatch)),
  ];
  if (active?.type === "native") {
    actions.splice(2, 0,
      paletteAction("Copy active shell output", "Workspace", "Copy selected text, or the visible native shell output", () => void copyNativeTerminal(active, null)),
      paletteAction("Screenshot active shell", "Workspace", "Open screenshot options for this native shell", () => openScreenshotDialog(active.pane)),
      paletteAction("Interrupt active shell", "Workspace", "Send Ctrl+C / SIGINT to the native shell", () => void sendNativeSignal(active, "interrupt", null)),
      paletteAction("Terminate active shell", "Workspace", "Send SIGTERM to the native shell", () => void sendNativeSignal(active, "terminate", null)),
      paletteAction("Kill active shell", "Workspace", "Send SIGKILL to the native shell", () => {
        if (confirm("Force kill this native shell session?")) void sendNativeSignal(active, "kill", null);
      }),
      paletteAction("Restart active shell", "Workspace", "Stop this shell and start a fresh one in the same tab", () => void restartNativeTerminal(active)),
      paletteAction("Close active shell", "Workspace", "Close this native shell tab", () => closeTab(active)),
    );
  }
  if (input.value.trim()) {
    actions.unshift(paletteAction("Save current input as workflow", "Workflow", input.value.trim(), () => {
      workflowName.value = "";
      workflowCommand.value = input.value.trim();
      openWorkflowDialog();
      workflowName?.focus();
    }));
  }

  const commands = dictionaryEntries.map((entry) => ({
    kind: "Command",
    title: entry.id,
    detail: entry.summary ?? "",
    keywords: [entry.id, entry.category, entry.risk, ...(entry.examples ?? []), dictionaryHaystack(entry)].join(" "),
    run: () => {
      switchTab(activeTerminalTab().id);
      input.value = dictionaryInsertLine(entry);
      resizeCommandInput();
      closeCommandPalette();
      input.focus();
    },
  }));

  const workflows = readWorkflows().map((workflow) => ({
    kind: "Workflow",
    title: workflow.name,
    detail: workflow.command,
    keywords: `${workflow.name} ${workflow.command}`,
    run: () => void runSavedWorkflow(workflow),
  }));

  return [...actions, ...workflows, ...commands]
    .map((item) => ({ item, score: scorePaletteItem(item, query) }))
    .filter(({ score }) => score >= 0)
    .sort((a, b) => b.score - a.score || a.item.title.localeCompare(b.item.title))
    .slice(0, 60)
    .map(({ item }) => item);
}

function paletteAction(title, kind, detail, run) {
  return { title, kind, detail, keywords: `${title} ${kind} ${detail}`, run };
}

function scorePaletteItem(item, query) {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return item.kind === "Action" ? 10 : 1;
  const haystack = `${item.title} ${item.kind} ${item.detail} ${item.keywords ?? ""}`.toLowerCase();
  if (item.title.toLowerCase() === q) return 1000;
  if (item.title.toLowerCase().startsWith(q)) return 800;
  if (haystack.includes(q)) return 400;
  const tokens = q.split(/\s+/).filter(Boolean);
  let score = 0;
  for (const token of tokens) {
    if (!haystack.includes(token)) return -1;
    score += item.title.toLowerCase().includes(token) ? 80 : 30;
  }
  return score;
}

function renderCommandPalette() {
  if (!paletteResults || !paletteEmpty) return;
  paletteItems = buildPaletteItems(paletteSearch?.value ?? "");
  paletteSel = Math.min(paletteSel, Math.max(0, paletteItems.length - 1));
  paletteResults.innerHTML = "";
  for (const [index, item] of paletteItems.entries()) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "palette-item";
    btn.setAttribute("role", "option");
    btn.setAttribute("aria-selected", String(index === paletteSel));
    const title = document.createElement("div");
    title.className = "palette-item-title";
    const name = document.createElement("span");
    name.textContent = item.title;
    const kind = document.createElement("span");
    kind.className = "palette-kind";
    kind.textContent = item.kind;
    title.append(name, kind);
    const detail = document.createElement("div");
    detail.className = "palette-item-detail";
    detail.textContent = item.detail;
    btn.append(title, detail);
    btn.addEventListener("mouseenter", () => {
      paletteSel = index;
      syncPaletteSelection();
    });
    btn.addEventListener("click", () => runPaletteItem(item));
    paletteResults.appendChild(btn);
  }
  paletteEmpty.hidden = paletteItems.length > 0;
  syncPaletteSelection();
}

function syncPaletteSelection() {
  const items = Array.from(paletteResults?.children ?? []);
  for (const [index, item] of items.entries()) {
    item.classList.toggle("sel", index === paletteSel);
    item.setAttribute("aria-selected", String(index === paletteSel));
  }
  items[paletteSel]?.scrollIntoView?.({ block: "nearest" });
}

function runPaletteItem(item) {
  closeCommandPalette();
  item.run();
}

function initWorkflowDialog() {
  workflowOpen?.addEventListener("click", openWorkflowDialog);
  workflowClose?.addEventListener("click", closeWorkflowDialog);
  workflowDialog?.addEventListener("click", (e) => {
    if (e.target === workflowDialog) closeWorkflowDialog();
  });
  workflowFillCurrent?.addEventListener("click", () => {
    workflowCommand.value = input.value.trim();
    workflowCommand.focus();
  });
  workflowSave?.addEventListener("click", () => {
    const name = workflowName.value.trim();
    const command = workflowCommand.value.trim();
    if (!name || !command) {
      line("Workflow save requires name and commands.", "err");
      return;
    }
    saveWorkflow({ name, command });
    workflowName.value = "";
    workflowCommand.value = "";
    renderWorkflowList();
    renderCommandPalette();
    line(`saved workflow: ${name}`, "ok");
  });
}

function openWorkflowDialog() {
  if (!workflowDialog) return;
  renderWorkflowList();
  if (typeof workflowDialog.showModal === "function") workflowDialog.showModal();
  else workflowDialog.setAttribute("open", "");
}

function closeWorkflowDialog() {
  if (!workflowDialog) return;
  if (typeof workflowDialog.close === "function" && workflowDialog.open) workflowDialog.close();
  else workflowDialog.removeAttribute("open");
  focusActiveInput();
}

function readWorkflows() {
  try {
    const parsed = JSON.parse(localStorage.getItem(WORKFLOW_KEY) || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => item && typeof item.name === "string" && typeof item.command === "string")
      .map((item) => ({
        name: item.name,
        command: item.command,
        createdAt: item.createdAt || new Date().toISOString(),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

function writeWorkflows(workflows) {
  try {
    localStorage.setItem(WORKFLOW_KEY, JSON.stringify(workflows, null, 2));
  } catch {
    line("Could not persist workflows in local storage.", "err");
  }
}

function saveWorkflow(workflow) {
  const workflows = readWorkflows().filter((item) => item.name !== workflow.name);
  workflows.push({ ...workflow, createdAt: new Date().toISOString() });
  writeWorkflows(workflows);
}

function deleteWorkflow(name) {
  writeWorkflows(readWorkflows().filter((workflow) => workflow.name !== name));
  renderWorkflowList();
  renderCommandPalette();
}

function renderWorkflowList() {
  if (!workflowList || !workflowEmpty) return;
  const workflows = readWorkflows();
  workflowList.innerHTML = "";
  for (const workflow of workflows) {
    const item = document.createElement("article");
    item.className = "workflow-item";
    const title = document.createElement("div");
    title.className = "workflow-title";
    const name = document.createElement("span");
    name.textContent = workflow.name;
    const created = document.createElement("span");
    created.className = "palette-kind";
    created.textContent = "saved";
    title.append(name, created);
    const command = document.createElement("div");
    command.className = "workflow-command";
    command.textContent = workflow.command;
    const actions = document.createElement("div");
    actions.className = "workflow-actions";
    const run = workflowButton("Run", () => void runSavedWorkflow(workflow));
    const insert = workflowButton("Insert", () => {
      switchTab(activeTerminalTab().id);
      input.value = workflow.command;
      resizeCommandInput();
      closeWorkflowDialog();
      input.focus();
    });
    const remove = workflowButton("Delete", () => deleteWorkflow(workflow.name));
    actions.append(run, insert, remove);
    item.append(title, command, actions);
    workflowList.appendChild(item);
  }
  workflowEmpty.hidden = workflows.length > 0;
}

function workflowButton(label, onClick) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "editor-btn";
  btn.textContent = label;
  btn.addEventListener("click", onClick);
  return btn;
}

function initNativeSessionsDialog() {
  nativeSessionsOpen?.addEventListener("click", () => void openNativeSessionsDialog());
  nativeSessionsClose?.addEventListener("click", closeNativeSessionsDialog);
  nativeSessionsDialog?.addEventListener("click", (e) => {
    if (e.target === nativeSessionsDialog) closeNativeSessionsDialog();
  });
  nativeSessionsRefresh?.addEventListener("click", () => void refreshNativeSessionsDialog());
  nativeSessionsCloseAll?.addEventListener("click", () => void closeAllNativeSessions());
}

async function openNativeSessionsDialog() {
  if (!nativeSessionsDialog) return;
  if (!nativeAvailable) {
    line("Native shell sessions are disabled on this server.", "err");
    return;
  }
  renderNativeSessionsLoading();
  if (typeof nativeSessionsDialog.showModal === "function") nativeSessionsDialog.showModal();
  else nativeSessionsDialog.setAttribute("open", "");
  await refreshNativeSessionsDialog();
}

function closeNativeSessionsDialog() {
  if (!nativeSessionsDialog) return;
  if (typeof nativeSessionsDialog.close === "function" && nativeSessionsDialog.open) nativeSessionsDialog.close();
  else nativeSessionsDialog.removeAttribute("open");
  focusActiveInput();
}

function renderNativeSessionsLoading() {
  if (!nativeSessionsList || !nativeSessionsEmpty) return;
  nativeSessionsList.innerHTML = "";
  nativeSessionsEmpty.hidden = false;
  nativeSessionsEmpty.textContent = "Loading shell sessions...";
  if (nativeSessionsCloseAll) nativeSessionsCloseAll.disabled = true;
}

async function refreshNativeSessionsDialog() {
  if (!nativeSessionsList || !nativeSessionsEmpty) return [];
  try {
    const sessions = await fetchNativeSessions();
    renderNativeSessions(sessions);
    return sessions;
  } catch (err) {
    nativeSessionsList.innerHTML = "";
    nativeSessionsEmpty.hidden = false;
    nativeSessionsEmpty.textContent = "Could not load shell sessions.";
    line("Shell sessions refresh failed: " + (err?.message ?? String(err)), "err");
    return [];
  }
}

async function fetchNativeSessions() {
  const res = await fetch("/api/native/sessions");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const sessions = await res.json();
  return Array.isArray(sessions) ? sessions : [];
}

function renderNativeSessions(sessions) {
  if (!nativeSessionsList || !nativeSessionsEmpty) return;
  const sorted = [...sessions].sort((a, b) => String(a.startedAt ?? "").localeCompare(String(b.startedAt ?? "")));
  nativeSessionsList.innerHTML = "";
  for (const info of sorted) nativeSessionsList.appendChild(nativeSessionItem(info));
  nativeSessionsEmpty.hidden = sorted.length > 0;
  nativeSessionsEmpty.textContent = "No running native shell sessions.";
  if (nativeSessionsCloseAll) nativeSessionsCloseAll.disabled = sorted.length === 0;
}

function nativeSessionItem(info) {
  const localTab = nativeTabForSession(info.id);
  const item = document.createElement("article");
  item.className = "native-session-item";

  const title = document.createElement("div");
  title.className = "native-session-title";
  const name = document.createElement("span");
  const code = document.createElement("code");
  code.textContent = String(info.shell ?? "shell");
  name.appendChild(code);
  const state = document.createElement("span");
  state.className = localTab ? "native-session-local" : "palette-kind";
  state.textContent = localTab ? "open tab" : "server";
  title.append(name, state);

  const detail = document.createElement("div");
  detail.className = "native-session-detail";
  detail.textContent = nativeSessionDetail(info);

  const actions = document.createElement("div");
  actions.className = "native-session-actions";
  actions.append(
    workflowButton(localTab ? "Focus" : "Attach", () => {
      if (localTab) switchTab(localTab.id);
      else attachNativeSession(info);
      closeNativeSessionsDialog();
    }),
  );
  if (localTab) {
    actions.append(workflowButton("Restart", () => {
      closeNativeSessionsDialog();
      void restartNativeTerminal(localTab);
    }));
  }
  actions.append(workflowButton("Close", () => void closeNativeSessionId(info.id)));

  item.append(title, detail, actions);
  return item;
}

function nativeSessionDetail(info) {
  const bits = [
    String(info.cwd ?? ""),
    info.pid ? `pid ${info.pid}` : "",
    `${Number(info.cols ?? 0) || 80}x${Number(info.rows ?? 0) || 24}`,
    info.startedAt ? `started ${formatNativeSessionTime(info.startedAt)}` : "",
  ].filter(Boolean);
  return bits.join(" · ");
}

function formatNativeSessionTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function nativeTabForSession(id) {
  if (!id) return null;
  return tabs.find((tab) => tab.type === "native" && tab.native?.id === id) ?? null;
}

function scheduleNativeSessionsRefresh(delay = 250) {
  if (nativeSessionRefreshTimer) clearTimeout(nativeSessionRefreshTimer);
  nativeSessionRefreshTimer = window.setTimeout(() => {
    nativeSessionRefreshTimer = 0;
    if (nativeSessionsDialog?.open) void refreshNativeSessionsDialog();
  }, delay);
}

async function closeNativeSessionId(id) {
  const sessionId = String(id ?? "");
  if (!sessionId) return false;
  const localTab = nativeTabForSession(sessionId);
  if (localTab) {
    localTab.native.stopping = true;
    updateNativeShellUi(localTab);
  }
  try {
    const res = await fetch(`/api/native/${encodeURIComponent(sessionId)}/close`, { method: "POST" });
    if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`);
    if (localTab) {
      if (res.status === 404) {
        localTab.native.closed = true;
        localTab.native.stopping = false;
        localTab.native.exitCode = null;
        nativeNotice(localTab, "Shell session is no longer running.");
        updateNativeShellUi(localTab);
      } else {
        nativeNotice(localTab, "Close signal sent.");
      }
    }
    scheduleNativeSessionsRefresh();
    return true;
  } catch (err) {
    if (localTab) {
      localTab.native.stopping = false;
      updateNativeShellUi(localTab);
    }
    line("Close shell failed: " + (err?.message ?? String(err)), "err");
    return false;
  }
}

async function closeAllNativeSessions() {
  const sessions = await fetchNativeSessions().catch((err) => {
    line("Close all shells failed: " + (err?.message ?? String(err)), "err");
    return [];
  });
  if (!sessions.length) {
    renderNativeSessions([]);
    return;
  }
  if (!confirm(`Close ${sessions.length} native shell session(s)?`)) return;
  await Promise.all(sessions.map((session) => closeNativeSessionId(session.id)));
  await refreshNativeSessionsDialog();
}

function workflowByName(name) {
  return readWorkflows().find((workflow) => workflow.name === name);
}

function isWorkflowCommand(command) {
  return new Set(["save.workflow", "list.workflows", "run.workflow", "remove.workflow", "open.workflows"]).has(parseIdelLine(command).command);
}

async function handleWorkflowCommand(command) {
  const parsed = parseIdelLine(command);
  switch (parsed.command) {
    case "open.workflows":
      line("idel> " + command, "cmd");
      openWorkflowDialog();
      return true;
    case "list.workflows": {
      line("idel> " + command, "cmd");
      const workflows = readWorkflows();
      line(workflows.length ? workflows.map((workflow) => `${workflow.name}: ${workflow.command}`).join("\n") : "(no workflows)", "text");
      return true;
    }
    case "save.workflow": {
      line("idel> " + command, "cmd");
      const name = String(parsed.params.name ?? parsed.params.title ?? "").trim();
      const body = String(parsed.params.command ?? parsed.params.steps ?? parsed.args.join(" ")).trim();
      if (!name || !body) {
        line('Usage: save.workflow name=<name> command="<cmd.one && cmd.two>"', "err");
        return false;
      }
      saveWorkflow({ name, command: body });
      line(`saved workflow: ${name}`, "ok");
      return true;
    }
    case "run.workflow": {
      line("idel> " + command, "cmd");
      const name = String(parsed.params.name ?? parsed.args[0] ?? "").trim();
      const workflow = workflowByName(name);
      if (!workflow) {
        line(`No workflow named ${name || "(missing)"}.`, "err");
        return false;
      }
      return await runSavedWorkflow(workflow, { echo: false });
    }
    case "remove.workflow": {
      line("idel> " + command, "cmd");
      const name = String(parsed.params.name ?? parsed.args[0] ?? "").trim();
      if (!name || !workflowByName(name)) {
        line(`No workflow named ${name || "(missing)"}.`, "err");
        return false;
      }
      deleteWorkflow(name);
      line(`removed workflow: ${name}`, "ok");
      return true;
    }
    default:
      return false;
  }
}

async function runSavedWorkflow(workflow, options = {}) {
  closeWorkflowDialog();
  closeCommandPalette();
  if (options.echo !== false) line(`workflow> ${workflow.name}`, "cmd");
  const command = workflow.command.trim();
  if (!command) return false;
  if (multilineCommands(command).length > 1) {
    await runMultilineBatch(command);
    return true;
  }
  if (isSingleLocalClearCommand(command)) return clearTerminalLines(command);
  if (isWorkflowCommand(command)) return await handleWorkflowCommand(command);
  await runIdel(command);
  return true;
}

function initSetupChecklist() {
  setupOpen?.addEventListener("click", () => void openSetupChecklist());
  setupClose?.addEventListener("click", closeSetupChecklist);
  setupDialog?.addEventListener("click", (e) => {
    if (e.target === setupDialog) closeSetupChecklist();
  });
  setupDismiss?.addEventListener("click", () => {
    storageSet(SETUP_DISMISSED_KEY, "true");
    closeSetupChecklist();
  });
  setupOpenDictionary?.addEventListener("click", () => {
    closeSetupChecklist();
    void openDictionary();
  });
  setupOpenWorkflows?.addEventListener("click", () => {
    closeSetupChecklist();
    openWorkflowDialog();
  });
  setupOpenAi?.addEventListener("click", () => {
    closeSetupChecklist();
    openClaudeSetupDialog();
  });
}

async function openSetupChecklist() {
  if (!setupDialog) return;
  await loadDictionary();
  renderSetupChecklist();
  if (typeof setupDialog.showModal === "function") setupDialog.showModal();
  else setupDialog.setAttribute("open", "");
}

function closeSetupChecklist() {
  if (!setupDialog) return;
  if (typeof setupDialog.close === "function" && setupDialog.open) setupDialog.close();
  else setupDialog.removeAttribute("open");
  focusActiveInput();
}

function renderSetupChecklist() {
  if (!setupChecks) return;
  const packagePack = dictionaryEntries.some((entry) => /\.apt\.|\.brew\.|\.winget\./.test(entry.id));
  const workflows = readWorkflows();
  const checks = [
    setupCheck("Server", serverOnline, serverOnline ? "Local runtime is reachable." : "Start idel serve or scripts/run-ui.sh."),
    setupCheck("Operating system", Boolean(serverPlatform), serverPlatformLabel()),
    setupCheck("Registry", registryCommandCount > 0, registryCommandCount ? `${registryCommandCount} commands loaded.` : "Registry is not loaded yet."),
    setupCheck("Package commands", packagePack, packagePack ? "Curated package-manager commands are available." : "Package-manager commands are not loaded."),
    setupCheck("Native shell", nativeAvailable, nativeAvailable ? "Native shell tabs are available." : "Native shell tabs are disabled.", "warn"),
    setupCheck("AI provider", agentAvailable, agentAvailable ? "Ask Claude is ready." : "Ask Claude needs Claude Code or ANTHROPIC_API_KEY."),
    setupCheck("Saved workflows", workflows.length > 0, workflows.length ? `${workflows.length} workflow(s) saved.` : "No workflows saved yet.", "warn"),
  ];
  setupChecks.innerHTML = "";
  for (const check of checks) setupChecks.appendChild(setupCheckNode(check));
}

function setupCheck(title, ok, detail, fallbackState = "fail") {
  return { title, detail, state: ok ? "ok" : fallbackState };
}

function setupCheckNode(check) {
  const item = document.createElement("article");
  item.className = `setup-check ${check.state}`;
  const head = document.createElement("div");
  head.className = "setup-check-title";
  const title = document.createElement("span");
  title.textContent = check.title;
  const state = document.createElement("span");
  state.className = "setup-check-state";
  state.textContent = check.state;
  head.append(title, state);
  const detail = document.createElement("div");
  detail.className = "setup-check-detail";
  detail.textContent = check.detail;
  item.append(head, detail);
  return item;
}

function renderKnowledgeBase() {
  const kind = serverPlatformKind();
  const data =
    kind === "windows"
      ? {
          native: "! winget install --id Git.Git -e",
          nativeShell: "winget install --id Git.Git -e",
          packages: "search.winget.package query=Git\nshow.winget.package id=Git.Git\ninstall.winget.package id=Git.Git",
          packageTitle: "Elevation And Windows Packages",
          packageNote:
            "Some installers open UAC or interactive prompts. Use curated IDEL package commands when possible; use a sh tab when an installer needs native interaction.",
          wait:
            "run.script path=./scripts/start.ps1 shell=powershell && wait.time seconds=2 && tail.file file=app.log lines=40",
        }
      : kind === "macos"
        ? {
            native: "! brew install git",
            nativeShell: "brew install git",
            packages: "search.brew.package query=git\nshow.brew.package name=git\ninstall.brew.package name=git",
            packageTitle: "Elevation And macOS Packages",
            packageNote:
              "Homebrew usually does not need sudo. If a command asks for elevation or opens an interactive prompt, run it from a sh tab.",
            wait:
              "run.script path=./scripts/start.sh shell=bash && wait.time seconds=2 && tail.file file=app.log lines=40",
          }
        : {
            native: "! sudo apt install git",
            nativeShell: "sudo apt install git",
            packages: "search.apt.package query=git\nshow.apt.package name=git\ninstall.apt.package name=git",
            packageTitle: "Sudo And Apt",
            packageNote:
              "Use curated IDEL apt commands for structured installs and audit decisions. Use a sh tab for interactive sudo password prompts or package prompts.",
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
  setElementText("knowledge-native-tab-example", data.nativeShell);
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
  focusActiveInput();
}

async function loadDictionary() {
  if (dictionaryLoaded || dictionaryLoading) return;
  dictionaryLoading = true;
  dictionaryCount.textContent = "Loading...";
  try {
    const res = await fetch("/api/registry");
    dictionaryEntries = res.ok ? await res.json() : [];
    dictionaryEntries.sort((a, b) => a.category.localeCompare(b.category) || a.id.localeCompare(b.id));
    registryCommandCount = dictionaryEntries.length;
    dictionaryLoaded = true;
  } catch {
    dictionaryEntries = [];
    registryCommandCount = 0;
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
    switchTab(activeTerminalTab().id);
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

function setNativeAvailability(available) {
  nativeAvailable = available;
  for (const btn of [newNativeTerminalBtn, nativeSessionsOpen]) {
    if (!btn) continue;
    btn.disabled = !available;
    btn.classList.toggle("unavailable", !available);
    btn.setAttribute("aria-disabled", String(!available));
    btn.title = available
      ? btn === nativeSessionsOpen ? "Manage native shell sessions" : "New native shell"
      : "Native shell tabs are disabled on this server.";
  }
}

function askClaudeUnavailable() {
  return agentStatusKnown && !agentAvailable;
}

async function refreshAgentAvailability() {
  try {
    const res = await fetch("/api/health");
    const d = res.ok ? await res.json() : null;
    if (d?.ok && Object.prototype.hasOwnProperty.call(d, "agentAvailable")) {
      serverOnline = true;
      if (Object.prototype.hasOwnProperty.call(d, "platform")) setServerPlatform(d.platform);
      if (Object.prototype.hasOwnProperty.call(d, "nativeAvailable")) {
        setNativeAvailability(d.nativeAvailable !== false);
      }
      setAgentAvailability(d.agentAvailable !== false);
      renderSetupChecklist();
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
  const effect = storageGet(PREF_KEYS.effect);
  const showLogs = storageGet(PREF_KEYS.showLogs);
  const blockPaste = storageGet(PREF_KEYS.blockPaste);
  const blockCopy = storageGet(PREF_KEYS.blockCopy);
  return {
    theme: THEMES.has(theme) ? theme : DEFAULT_PREFERENCES.theme,
    palette: PALETTES.has(palette) ? palette : DEFAULT_PREFERENCES.palette,
    fontSize: FONT_SIZES.has(fontSize) ? fontSize : DEFAULT_PREFERENCES.fontSize,
    effect: EFFECTS.has(effect) ? effect : DEFAULT_PREFERENCES.effect,
    showLogs: showLogs === null ? DEFAULT_PREFERENCES.showLogs : showLogs !== "false",
    blockPaste: blockPaste === null ? DEFAULT_PREFERENCES.blockPaste : blockPaste === "true",
    blockCopy: blockCopy === null ? DEFAULT_PREFERENCES.blockCopy : blockCopy === "true",
  };
}

function currentPreferences() {
  return {
    theme: classChoice(THEMES, "theme", DEFAULT_PREFERENCES.theme),
    palette: classChoice(PALETTES, "palette", DEFAULT_PREFERENCES.palette),
    fontSize: classChoice(FONT_SIZES, "font", DEFAULT_PREFERENCES.fontSize),
    effect: classChoice(EFFECTS, "effect", DEFAULT_PREFERENCES.effect),
    showLogs: !document.body.classList.contains("logs-hidden"),
    blockPaste: document.body.classList.contains("paste-blocked"),
    blockCopy: document.body.classList.contains("copy-blocked"),
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
    effect: EFFECTS.has(next.effect) ? next.effect : DEFAULT_PREFERENCES.effect,
    showLogs: next.showLogs !== false,
    blockPaste: next.blockPaste === true,
    blockCopy: next.blockCopy === true,
  };
  replaceBodyChoice(THEMES, "theme", prefs.theme);
  replaceBodyChoice(PALETTES, "palette", prefs.palette);
  replaceBodyChoice(FONT_SIZES, "font", prefs.fontSize);
  replaceBodyChoice(EFFECTS, "effect", prefs.effect);
  document.body.classList.toggle("logs-hidden", !prefs.showLogs);
  document.body.classList.toggle("paste-blocked", prefs.blockPaste);
  document.body.classList.toggle("copy-blocked", prefs.blockCopy);
  if (showLogsInput) showLogsInput.checked = prefs.showLogs;
  if (blockPasteInput) blockPasteInput.checked = prefs.blockPaste;
  if (blockCopyInput) blockCopyInput.checked = prefs.blockCopy;
  syncChoiceButtons(themeButtons, "theme", prefs.theme);
  syncChoiceButtons(paletteButtons, "palette", prefs.palette);
  syncChoiceButtons(fontSizeButtons, "fontSize", prefs.fontSize);
  syncChoiceButtons(effectButtons, "effect", prefs.effect);
  syncPaletteSummary(prefs.palette);
  if (persist) {
    storageSet(PREF_KEYS.theme, prefs.theme);
    storageSet(PREF_KEYS.palette, prefs.palette);
    storageSet(PREF_KEYS.fontSize, prefs.fontSize);
    storageSet(PREF_KEYS.effect, prefs.effect);
    storageSet(PREF_KEYS.showLogs, String(prefs.showLogs));
    storageSet(PREF_KEYS.blockPaste, String(prefs.blockPaste));
    storageSet(PREF_KEYS.blockCopy, String(prefs.blockCopy));
  }
  applyTerminalEffect(prefs.effect);
  updateNativeTerminalAppearance();
}

function replaceBodyChoice(options, prefix, selected) {
  for (const option of options) document.body.classList.remove(`${prefix}-${option}`);
  document.body.classList.add(`${prefix}-${selected}`);
}

function applyTerminalEffect(effect) {
  const selected = EFFECTS.has(effect) ? effect : DEFAULT_PREFERENCES.effect;
  if (selected === "matrix" && !reducedMotionMedia?.matches) {
    startMatrixEffect();
    return;
  }
  stopMatrixEffect();
}

function ensureEffectCanvas() {
  if (effectCanvas) return effectCanvas;
  effectCanvas = document.createElement("canvas");
  effectCanvas.className = "terminal-effect-canvas";
  effectCanvas.setAttribute("aria-hidden", "true");
  document.body.prepend(effectCanvas);
  window.addEventListener("resize", resizeMatrixEffect);
  return effectCanvas;
}

function startMatrixEffect() {
  const canvas = ensureEffectCanvas();
  resizeMatrixEffect();
  if (matrixAnimationId) return;
  const frame = (time) => {
    drawMatrixFrame(time);
    matrixAnimationId = requestAnimationFrame(frame);
  };
  matrixAnimationId = requestAnimationFrame(frame);
  canvas.hidden = false;
}

function stopMatrixEffect() {
  if (matrixAnimationId) cancelAnimationFrame(matrixAnimationId);
  matrixAnimationId = 0;
  matrixLastFrame = 0;
  if (effectCanvas) {
    const ctx = effectCanvas.getContext("2d");
    ctx?.clearRect(0, 0, effectCanvas.width, effectCanvas.height);
    effectCanvas.hidden = true;
  }
}

function resizeMatrixEffect() {
  if (!effectCanvas) return;
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.floor(window.innerWidth * ratio));
  const height = Math.max(1, Math.floor(window.innerHeight * ratio));
  if (effectCanvas.width === width && effectCanvas.height === height) return;
  effectCanvas.width = width;
  effectCanvas.height = height;
  effectCanvas.style.width = `${window.innerWidth}px`;
  effectCanvas.style.height = `${window.innerHeight}px`;
  const fontSize = Math.max(13, Math.floor(15 * ratio));
  const count = Math.ceil(width / fontSize);
  matrixColumns = Array.from({ length: count }, () => Math.floor(Math.random() * (height / fontSize)));
  const ctx = effectCanvas.getContext("2d");
  if (ctx) ctx.font = `${fontSize}px ${getComputedStyle(document.body).getPropertyValue("--mono").trim() || "monospace"}`;
}

function drawMatrixFrame(time) {
  if (!effectCanvas || !document.body.classList.contains("effect-matrix")) return;
  if (time - matrixLastFrame < 48) return;
  matrixLastFrame = time;
  const ctx = effectCanvas.getContext("2d");
  if (!ctx) return;
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const fontSize = Math.max(13, Math.floor(15 * ratio));
  const css = getComputedStyle(document.body);
  const bg = css.getPropertyValue("--bg").trim() || "#0b0e14";
  const accent = css.getPropertyValue("--accent").trim() || "#5cc8ff";
  ctx.fillStyle = colorWithAlpha(bg, 0.18);
  ctx.fillRect(0, 0, effectCanvas.width, effectCanvas.height);
  ctx.font = `${fontSize}px ${css.getPropertyValue("--mono").trim() || "monospace"}`;
  ctx.fillStyle = colorWithAlpha(accent, 0.88);
  for (let i = 0; i < matrixColumns.length; i++) {
    const x = i * fontSize;
    const y = matrixColumns[i] * fontSize;
    ctx.fillText(randomMatrixGlyph(), x, y);
    if (y > effectCanvas.height && Math.random() > 0.975) matrixColumns[i] = 0;
    else matrixColumns[i] += 1;
  }
}

function randomMatrixGlyph() {
  const glyphs = "01アイウエオカキクケコサシスセソ<>/{}[]#$";
  return glyphs[Math.floor(Math.random() * glyphs.length)] || "0";
}

function colorWithAlpha(color, alpha) {
  const value = String(color ?? "").trim();
  if (/^#[0-9a-f]{6}$/i.test(value)) {
    const r = Number.parseInt(value.slice(1, 3), 16);
    const g = Number.parseInt(value.slice(3, 5), 16);
    const b = Number.parseInt(value.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  if (/^rgb\(/i.test(value)) return value.replace(/^rgb\((.*)\)$/i, `rgba($1, ${alpha})`);
  return value;
}

function syncChoiceButtons(buttons, key, selected) {
  for (const btn of buttons) {
    const active = btn.dataset[key] === selected;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-pressed", String(active));
  }
}

function syncPaletteSummary(palette) {
  const selected = PALETTES.has(palette) ? palette : DEFAULT_PREFERENCES.palette;
  if (paletteSelected) paletteSelected.textContent = paletteLabel(selected);
  if (paletteSelectedSwatch) {
    paletteSelectedSwatch.className = `selected-palette-swatch palette-${selected}`;
  }
}

function paletteLabel(palette) {
  return String(palette || "")
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ") || "Accent";
}

function clipboardPasteBlocked() {
  return document.body.classList.contains("paste-blocked");
}

function clipboardCopyBlocked() {
  return document.body.classList.contains("copy-blocked");
}

function isTerminalCopyTarget(target) {
  const node = target instanceof Element ? target : target?.parentElement;
  if (!node) return false;
  return Boolean(node.closest(".term-output, .native-xterm, .workspace-tabs, .line-actions"));
}

function showClipboardBlocked(kind) {
  line(`${kind} is blocked by Preferences.`, "muted");
}

function shouldConfirmNativePaste(text) {
  const value = String(text ?? "");
  return /[\r\n]/.test(value) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) || value.length > 80;
}

function isLikelyNativePasteData(data) {
  const value = String(data ?? "");
  if (!value || value === "\r" || value === "\n") return false;
  if (/^\x1b\[[0-9;?]*[~A-Za-z]$/.test(value)) return false;
  return value.length > 12 || /[\r\n]/.test(value);
}

function queueNativePaste(tab, text) {
  if (!text) return;
  if (clipboardPasteBlocked()) {
    showClipboardBlocked("Paste");
    return;
  }
  if (shouldConfirmNativePaste(text)) {
    openPasteConfirmDialog(tab, text);
    return;
  }
  queueNativeInput(tab, text, true);
}

function openPasteConfirmDialog(tab, text) {
  if (!tab?.id) return;
  pendingNativePaste = { tabId: tab.id, text: String(text ?? "") };
  if (pasteConfirmPreview) pasteConfirmPreview.textContent = nativePastePreview(pendingNativePaste.text);
  if (!pasteConfirmDialog) {
    if (confirm("Paste this text into the native shell?")) confirmNativePaste();
    return;
  }
  if (typeof pasteConfirmDialog.showModal === "function") pasteConfirmDialog.showModal();
  else pasteConfirmDialog.setAttribute("open", "");
  pasteConfirmRun?.focus();
}

function closePasteConfirmDialog() {
  pendingNativePaste = null;
  if (!pasteConfirmDialog) return;
  if (typeof pasteConfirmDialog.close === "function" && pasteConfirmDialog.open) pasteConfirmDialog.close();
  else pasteConfirmDialog.removeAttribute("open");
  focusActiveInput();
}

function confirmNativePaste() {
  const pending = pendingNativePaste;
  pendingNativePaste = null;
  if (pasteConfirmDialog?.open) {
    if (typeof pasteConfirmDialog.close === "function") pasteConfirmDialog.close();
    else pasteConfirmDialog.removeAttribute("open");
  }
  const tab = tabs.find((item) => item.id === pending?.tabId);
  if (tab?.type === "native" && pending?.text) queueNativeInput(tab, pending.text, true);
  focusActiveInput();
}

function nativePastePreview(text) {
  const normalized = String(text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const visible = normalized
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, (ch) => `^${String.fromCharCode(ch.charCodeAt(0) + 64)}`);
  const lines = visible.split("\n");
  const clipped = lines.slice(0, 8).join("\n");
  const suffix = lines.length > 8 ? `\n... ${lines.length - 8} more line(s)` : "";
  return (clipped + suffix).slice(0, 1200);
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
  pageReloadStay?.addEventListener("click", closePageReloadDialog);
  pageReloadStayX?.addEventListener("click", closePageReloadDialog);
  pageReloadConfirm?.addEventListener("click", confirmPageReload);
  pageReloadDialog?.addEventListener("cancel", (e) => {
    e.preventDefault();
    closePageReloadDialog();
  });
  pageReloadDialog?.addEventListener("click", (e) => {
    if (e.target === pageReloadDialog) closePageReloadDialog();
  });

  window.addEventListener("beforeunload", (e) => {
    if (pageReloadConfirmed || !shouldConfirmPageExit()) return;
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
    e.preventDefault();
    e.stopPropagation();
    openPageReloadDialog();
  }, { capture: true });
}

function openPageReloadDialog() {
  if (!pageReloadDialog) {
    if (confirm(PAGE_EXIT_MESSAGE)) confirmPageReload();
    return;
  }
  if (pageReloadDialog.open) return;
  if (typeof pageReloadDialog.showModal === "function") pageReloadDialog.showModal();
  else pageReloadDialog.setAttribute("open", "");
  pageReloadConfirm?.focus();
}

function closePageReloadDialog() {
  if (!pageReloadDialog) return;
  if (typeof pageReloadDialog.close === "function" && pageReloadDialog.open) pageReloadDialog.close();
  else pageReloadDialog.removeAttribute("open");
  focusActiveInput();
}

function confirmPageReload() {
  pageReloadConfirmed = true;
  if (pageReloadDialog?.open) {
    if (typeof pageReloadDialog.close === "function") pageReloadDialog.close();
    else pageReloadDialog.removeAttribute("open");
  }
  location.reload();
  window.setTimeout(() => {
    pageReloadConfirmed = false;
  }, 3000);
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
  const tab = activeTab();
  if (tab?.type === "terminal" || tab?.type === "native") return tab.pane;
  return activeTerminalTab().pane;
}

function activeInputHistoryTab() {
  const tab = activeTab();
  if (tab?.type === "terminal" || tab?.type === "native") return tab;
  return activeTerminalTab();
}

function focusActiveInput() {
  const tab = activeTab();
  if (tab?.type === "native") {
    tab.native?.terminal?.focus?.();
    return;
  }
  if (tab?.type !== "editor") input.focus();
}

function syncCommandArea() {
  const tab = activeTab();
  const editorActive = tab?.type === "editor";
  const nativeActive = tab?.type === "native";
  const nativeXtermActive = nativeActive && Boolean(tab?.native?.terminal);
  const hidden = editorActive || nativeXtermActive;
  form.hidden = hidden;
  form.setAttribute("aria-hidden", String(hidden));
  input.disabled = editorActive || (commandBusy && !nativeActive);
  batchToggle.hidden = nativeActive;
  batchToggle.setAttribute("aria-hidden", String(nativeActive));
  if (editorActive) {
    input.value = "";
    hideCompletions();
  }
  if (nativeActive) {
    input.value = "";
    hideCompletions();
  }
  syncPrompt();
  syncInputPlaceholder();
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

function createNativeTerminalTab(activate = true, options = {}) {
  if (!options.session && !nativeAvailable) {
    line("Native shell tabs are disabled on this server.", "err");
    return null;
  }
  nativeTerminalCount += 1;
  const nativeNumber = nativeTerminalCount;
  const pane = document.createElement("section");
  pane.className = "term-output native-output";
  pane.setAttribute("aria-live", "polite");
  pane.hidden = true;
  form.parentNode.insertBefore(pane, form);
  const tab = {
    id: `tab-${nextTabId++}`,
    type: "native",
    title: `Shell ${nativeNumber}`,
    pane,
    history: [],
    histIdx: -1,
    native: createNativeState(nativeNumber),
  };
  buildNativeToolbar(tab);
  tabs.push(tab);
  if (activate) switchTab(tab.id);
  else renderTabs();
  mountNativeTerminal(tab);
  if (options.session) {
    attachNativeSessionToTab(tab, options.session);
  } else {
    nativeNotice(tab, "Starting native shell...");
    nativeNotice(tab, "Direct OS shell: not parsed by IDEL and not written to OpenLogs.");
    void startNativeTerminal(tab);
  }
  focusActiveInput();
  return tab;
}

function createNativeState(number) {
  return {
    number,
    generation: nextNativeGeneration++,
    id: "",
    shell: "",
    cwd: "",
    pid: undefined,
    startedAt: "",
    pty: true,
    eventSource: null,
    inputBuffer: "",
    flushTimer: 0,
    writeChain: Promise.resolve(),
    terminal: null,
    fitAddon: null,
    resizeObserver: null,
    resizeDisposable: null,
    resizeTimer: 0,
    cols: 80,
    rows: 24,
    sentCols: 0,
    sentRows: 0,
    dataDisposable: null,
    streamBody: null,
    ansi: defaultAnsiState(),
    closed: false,
    stopping: false,
    streamDisconnected: false,
    exitCode: null,
    toolbar: null,
    toolbarTitle: null,
    toolbarMeta: null,
    toolbarStatus: null,
    restartButton: null,
    closeButton: null,
    signalButtons: [],
  };
}

function buildNativeToolbar(tab) {
  if (tab.type !== "native") return null;
  const toolbar = document.createElement("div");
  toolbar.className = "native-toolbar";
  const title = document.createElement("span");
  title.className = "native-toolbar-title";
  const meta = document.createElement("span");
  meta.className = "native-toolbar-meta";
  const spacer = document.createElement("span");
  spacer.className = "native-toolbar-spacer";
  const status = document.createElement("span");
  status.className = "native-status-pill";
  const copy = nativeToolbarButton("Copy", () => void copyNativeTerminal(tab, copy));
  copy.title = "Copy selected native terminal text, or visible output";
  const shot = nativeToolbarButton("Shot", () => openScreenshotDialog(tab.pane));
  shot.title = "Screenshot this native shell";
  const interrupt = nativeToolbarButton("Ctrl+C", () => void sendNativeSignal(tab, "interrupt", interrupt));
  interrupt.title = "Send SIGINT / Ctrl+C";
  const terminate = nativeToolbarButton("Term", () => void sendNativeSignal(tab, "terminate", terminate));
  terminate.title = "Send SIGTERM";
  const kill = nativeToolbarButton("Kill", () => {
    if (confirm("Force kill this native shell session?")) void sendNativeSignal(tab, "kill", kill);
  });
  kill.title = "Send SIGKILL";
  const sessions = nativeToolbarButton("Sessions", () => void openNativeSessionsDialog());
  const restart = nativeToolbarButton("Restart", () => void restartNativeTerminal(tab));
  const close = nativeToolbarButton("Close", () => closeTab(tab));
  toolbar.append(title, meta, spacer, status, copy, shot, interrupt, terminate, kill, sessions, restart, close);
  tab.native.toolbar = toolbar;
  tab.native.toolbarTitle = title;
  tab.native.toolbarMeta = meta;
  tab.native.toolbarStatus = status;
  tab.native.restartButton = restart;
  tab.native.closeButton = close;
  tab.native.signalButtons = [interrupt, terminate, kill];
  tab.pane.appendChild(toolbar);
  updateNativeShellUi(tab, { renderTabs: false });
  return toolbar;
}

function nativeToolbarButton(label, onClick) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "editor-btn";
  btn.textContent = label;
  btn.addEventListener("click", onClick);
  return btn;
}

function updateNativeShellUi(tab, options = {}) {
  if (tab?.type !== "native" || !tab.native) return;
  const state = nativeTabState(tab);
  if (tab.native.toolbarTitle) tab.native.toolbarTitle.textContent = tab.native.shell || tab.title;
  if (tab.native.toolbarMeta) tab.native.toolbarMeta.textContent = nativeTabMeta(tab);
  if (tab.native.toolbarStatus) {
    tab.native.toolbarStatus.className = `native-status-pill ${state}`;
    tab.native.toolbarStatus.textContent = nativeStatusLabel(state);
  }
  if (tab.native.restartButton) tab.native.restartButton.disabled = tab.native.stopping && !tab.native.closed;
  if (tab.native.closeButton) tab.native.closeButton.disabled = state === "exited" && !tab.native.id;
  for (const btn of tab.native.signalButtons ?? []) btn.disabled = !tab.native.id || tab.native.closed;
  if (options.renderTabs !== false) renderTabs();
}

function nativeTabState(tab) {
  if (tab?.type !== "native" || !tab.native) return "exited";
  if (tab.native.stopping) return "stopping";
  if (tab.native.closed) return "exited";
  if (!tab.native.id) return "starting";
  if (tab.native.streamDisconnected) return "disconnected";
  return "running";
}

function nativeStatusLabel(state) {
  switch (state) {
    case "running":
      return "running";
    case "starting":
      return "starting";
    case "stopping":
      return "stopping";
    case "disconnected":
      return "offline";
    default:
      return "exited";
  }
}

function nativeTabMeta(tab) {
  const native = tab?.native;
  if (!native) return "";
  const size = `${native.cols || 80}x${native.rows || 24}`;
  const pid = native.pid ? `pid ${native.pid}` : "";
  return [native.cwd, pid, size].filter(Boolean).join(" · ");
}

async function copyNativeTerminal(tab, button) {
  if (clipboardCopyBlocked()) {
    flashButton(button, "Blocked");
    showClipboardBlocked("Copy");
    return;
  }
  const text = nativeTerminalCopyText(tab);
  if (!text.trim()) {
    flashButton(button, "Empty");
    return;
  }
  try {
    await writeClipboardText(text);
    flashButton(button, "Copied");
  } catch {
    flashButton(button, "Failed");
  }
}

function nativeTerminalCopyText(tab) {
  const selected = tab?.native?.terminal?.getSelection?.();
  if (String(selected ?? "").trim()) return selected;
  return nativeTerminalBufferText(tab, "visible");
}

async function sendNativeSignal(tab, signal, button) {
  if (!tab?.native?.id || tab.native.closed || tab.native.stopping) {
    flashButton(button, "Off");
    return false;
  }
  if (signal === "kill") {
    tab.native.stopping = true;
    updateNativeShellUi(tab);
  }
  try {
    const res = await fetch(`/api/native/${encodeURIComponent(tab.native.id)}/signal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ signal }),
    });
    if (!res.ok) {
      if (signal === "kill") {
        tab.native.stopping = false;
        updateNativeShellUi(tab);
      }
      if (res.status === 404) {
        tab.native.closed = true;
        updateNativeShellUi(tab);
      }
      flashButton(button, "Failed");
      return false;
    }
    flashButton(button, "Sent");
    if (signal !== "interrupt") scheduleNativeSessionsRefresh();
    return true;
  } catch {
    if (signal === "kill") {
      tab.native.stopping = false;
      updateNativeShellUi(tab);
    }
    flashButton(button, "Failed");
    return false;
  }
}

function tabForOutput(output) {
  return tabs.find((tab) => tab.pane === output) ?? null;
}

function nativeTerminalBufferText(tab, scope = "visible") {
  const term = tab?.native?.terminal;
  const buffer = term?.buffer?.active;
  if (!term || !buffer || typeof buffer.getLine !== "function") {
    return textFromNativeFallback(tab?.pane);
  }
  const rows = [];
  const start = scope === "visible" ? Math.max(0, Number(buffer.viewportY) || 0) : 0;
  const visibleRows = Math.max(1, Number(term.rows) || 24);
  const end = scope === "visible"
    ? Math.min(Number(buffer.length) || 0, start + visibleRows)
    : Number(buffer.length) || 0;
  for (let index = start; index < end; index++) {
    const line = buffer.getLine(index);
    if (!line) continue;
    rows.push(line.translateToString?.(true) ?? "");
  }
  return rows.join("\n").replace(/[ \t\n]+$/g, "");
}

function textFromNativeFallback(output) {
  return Array.from(output?.querySelectorAll?.(".line-body") ?? [])
    .map((node) => node.textContent.trimEnd())
    .filter(Boolean)
    .join("\n");
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
  renderTabs();
  fitNativeTerminal(tab);
  focusActiveInput();
}

function closeTab(tab) {
  if (!tab) return;
  if (tab.type === "terminal" && tabs.filter((candidate) => candidate.type === "terminal").length === 1) {
    return;
  }
  if (tab.type === "editor" && tab.dirty && !confirm(`Close ${tab.title} without saving?`)) return;
  if (tab.type === "native") void shutdownNativeSession(tab, { requestServer: true, dispose: true });
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
    btn.classList.toggle("native-tab", tab.type === "native");
    if (tab.type === "native") btn.classList.add(`state-${nativeTabState(tab)}`);
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-selected", String(tab.id === activeTabId));
    btn.title = tab.title;
    const label = document.createElement("span");
    label.className = "tab-label";
    label.textContent = tab.title;
    btn.appendChild(label);
    if (tab.type === "native") {
      const state = nativeTabState(tab);
      const status = document.createElement("span");
      status.className = `tab-status ${state}`;
      status.title = nativeStatusLabel(state);
      btn.appendChild(status);
    }
    const canClose =
      tab.type === "editor" ||
      tab.type === "native" ||
      tabs.filter((candidate) => candidate.type === "terminal").length > 1;
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

function paneLine(tab, text, cls = "") {
  const div = lineNode(text, cls);
  tab.pane.appendChild(div);
  tab.pane.scrollTop = tab.pane.scrollHeight;
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
  const classes = new Set(String(cls).split(/\s+/).filter(Boolean));

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

  actions.append(copy);
  if (classes.has("cmd")) {
    const command = commandFromLineText(text);
    if (command) {
      const rerun = document.createElement("button");
      rerun.type = "button";
      rerun.className = "line-action";
      rerun.textContent = "Run";
      rerun.title = "Run this command again";
      rerun.addEventListener("click", () => {
        input.value = command;
        resizeCommandInput();
        submitCommandInput();
      });
      const save = document.createElement("button");
      save.type = "button";
      save.className = "line-action";
      save.textContent = "Save";
      save.title = "Save as workflow";
      save.addEventListener("click", () => {
        workflowCommand.value = command;
        openWorkflowDialog();
        workflowName?.focus();
      });
      actions.append(rerun, save);
    }
  }
  if (classes.has("err")) {
    const explain = document.createElement("button");
    explain.type = "button";
    explain.className = "line-action";
    explain.textContent = "Explain";
    explain.title = "Ask AI to explain this error";
    explain.addEventListener("click", () => explainErrorText(text));
    actions.append(explain);
  }
  actions.append(shot);
  lineEl.appendChild(actions);
}

function shouldAddLineActions(cls, text) {
  if (!String(text ?? "").trim()) return false;
  const classes = new Set(String(cls).split(/\s+/).filter(Boolean));
  return ["cmd", "ask", "text", "err", "ok"].some((name) => classes.has(name));
}

function commandFromLineText(text) {
  const value = String(text ?? "").trim();
  if (value.startsWith("idel> ")) return value.slice("idel> ".length).trim();
  if (value.startsWith("batch ") && value.includes("> ")) return value.slice(value.indexOf("> ") + 2).trim();
  return "";
}

function explainErrorText(text) {
  const prompt = `Explain this IDEL terminal error and suggest the safest fix:\n${String(text ?? "").trim()}`;
  if (askClaudeUnavailable()) {
    input.value = `ask.ai prompt=${quoteDictionaryValue(prompt)}`;
    resizeCommandInput();
    openClaudeSetupDialog({ switchToAsk: false });
    line("Ask Claude is not set up. Opened setup guide.", "err");
    return;
  }
  void runAsk(prompt, "? explain error");
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

function xtermGlobals() {
  const TerminalCtor = globalThis.Terminal;
  const FitAddonCtor = globalThis.FitAddon?.FitAddon;
  return { TerminalCtor, FitAddonCtor };
}

function mountNativeTerminal(tab) {
  const { TerminalCtor, FitAddonCtor } = xtermGlobals();
  if (!TerminalCtor || !FitAddonCtor || tab.native.terminal) return;

  const host = document.createElement("div");
  host.className = "native-xterm";
  tab.pane.appendChild(host);

  const term = new TerminalCtor({
    cols: 80,
    rows: 24,
    cursorBlink: true,
    convertEol: false,
    disableStdin: false,
    fontFamily: getComputedStyle(document.body).getPropertyValue("--mono").trim() || "monospace",
    fontSize: xtermFontSize(),
    scrollback: 5000,
    theme: xtermTheme(),
  });
  const fitAddon = new FitAddonCtor();
  term.loadAddon(fitAddon);
  term.open(host);
  host.addEventListener("paste", (e) => {
    const text = e.clipboardData?.getData("text") ?? "";
    if (!text) return;
    e.preventDefault();
    queueNativePaste(tab, text);
  }, { capture: true });
  tab.native.terminal = term;
  tab.native.fitAddon = fitAddon;
  tab.native.dataDisposable = term.onData((data) => {
    if (clipboardPasteBlocked() && isLikelyNativePasteData(data)) {
      showClipboardBlocked("Paste");
      return;
    }
    if (isLikelyNativePasteData(data) && shouldConfirmNativePaste(data)) {
      openPasteConfirmDialog(tab, data);
      return;
    }
    queueNativeInput(tab, data, true);
  });
  tab.native.resizeDisposable = term.onResize(({ cols, rows }) => queueNativeResize(tab, cols, rows));
  if (typeof ResizeObserver === "function") {
    tab.native.resizeObserver = new ResizeObserver(() => fitNativeTerminal(tab));
    tab.native.resizeObserver.observe(tab.pane);
  }
  fitNativeTerminal(tab);
  if (activeTab()?.id === tab.id) syncCommandArea();
}

function nativeNotice(tab, text) {
  if (tab.native?.terminal) {
    tab.native.terminal.writeln(`\x1b[2m${text}\x1b[0m`);
    return;
  }
  paneLine(tab, text, "muted");
}

function fitNativeTerminal(tab) {
  if (tab?.type !== "native" || tab.pane.hidden || !tab.native?.fitAddon) return;
  try {
    tab.native.fitAddon.fit();
    const size = nativeTerminalSize(tab);
    queueNativeResize(tab, size.cols, size.rows);
  } catch {
    /* xterm may not have measurable dimensions while a tab is hidden */
  }
}

function updateNativeTerminalAppearance() {
  for (const tab of tabs) {
    if (tab.type !== "native" || !tab.native?.terminal) continue;
    tab.native.terminal.options.theme = xtermTheme();
    tab.native.terminal.options.fontSize = xtermFontSize();
    fitNativeTerminal(tab);
  }
}

function xtermTheme() {
  const css = getComputedStyle(document.body);
  return {
    background: css.getPropertyValue("--bg").trim() || "#0b0e14",
    foreground: css.getPropertyValue("--fg").trim() || "#d7dce5",
    cursor: css.getPropertyValue("--accent").trim() || "#5cc8ff",
    cursorAccent: css.getPropertyValue("--bg").trim() || "#0b0e14",
    selectionBackground: colorMix(css.getPropertyValue("--accent").trim() || "#5cc8ff", 0.32),
    black: "#1f2937",
    red: "#ef4444",
    green: "#22c55e",
    yellow: "#eab308",
    blue: "#3b82f6",
    magenta: "#d946ef",
    cyan: "#06b6d4",
    white: "#e5e7eb",
    brightBlack: "#6b7280",
    brightRed: "#f87171",
    brightGreen: "#4ade80",
    brightYellow: "#facc15",
    brightBlue: "#60a5fa",
    brightMagenta: "#e879f9",
    brightCyan: "#22d3ee",
    brightWhite: "#f9fafb",
  };
}

function colorMix(color, alpha) {
  const value = color.trim();
  if (/^#[0-9a-f]{6}$/i.test(value)) {
    const r = Number.parseInt(value.slice(1, 3), 16);
    const g = Number.parseInt(value.slice(3, 5), 16);
    const b = Number.parseInt(value.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  return value;
}

function xtermFontSize() {
  const px = Number.parseFloat(getComputedStyle(input).fontSize);
  return Number.isFinite(px) ? px : 14;
}

async function startNativeTerminal(tab) {
  if (!nativeAvailable) {
    nativeNotice(tab, "Native terminals are disabled on this server.");
    tab.native.closed = true;
    updateNativeShellUi(tab);
    return;
  }
  const generation = tab.native.generation;
  try {
    const size = nativeTerminalSize(tab);
    const res = await fetch("/api/native/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(size),
    });
    const body = await res.json().catch(() => ({}));
    if (tab.native.generation !== generation) return;
    if (!res.ok) {
      nativeNotice(tab, "Native terminal error: " + (body.error ?? `HTTP ${res.status}`));
      tab.native.closed = true;
      updateNativeShellUi(tab);
      return;
    }
    applyNativeSessionInfo(tab, body, size);
    nativeNotice(tab, `${body.shell ?? "shell"} · ${body.cwd ?? ""}`);
    updateNativeShellUi(tab);
    queueNativeResize(tab, tab.native.cols || size.cols, tab.native.rows || size.rows, true);
    openNativeStream(tab);
    scheduleNativeSessionsRefresh();
  } catch (err) {
    if (tab.native.generation !== generation) return;
    nativeNotice(tab, "Native terminal error: " + (err?.message ?? String(err)));
    tab.native.closed = true;
    updateNativeShellUi(tab);
  }
}

function applyNativeSessionInfo(tab, info, fallbackSize = {}) {
  if (tab?.type !== "native" || !tab.native) return;
  tab.native.id = String(info.id ?? tab.native.id ?? "");
  tab.native.shell = String(info.shell ?? tab.native.shell ?? "");
  tab.native.cwd = String(info.cwd ?? tab.native.cwd ?? "");
  tab.native.pid = info.pid;
  tab.native.startedAt = String(info.startedAt ?? tab.native.startedAt ?? "");
  tab.native.pty = info.pty !== false;
  tab.native.cols = Number(info.cols ?? fallbackSize.cols ?? tab.native.cols) || tab.native.cols || 80;
  tab.native.rows = Number(info.rows ?? fallbackSize.rows ?? tab.native.rows) || tab.native.rows || 24;
  tab.native.sentCols = Number(info.cols ?? fallbackSize.cols ?? tab.native.sentCols) || tab.native.sentCols || 0;
  tab.native.sentRows = Number(info.rows ?? fallbackSize.rows ?? tab.native.sentRows) || tab.native.sentRows || 0;
  tab.native.closed = Boolean(info.exited);
  tab.native.stopping = false;
  tab.native.streamDisconnected = false;
  tab.native.exitCode = info.exitCode ?? null;
  tab.title = tab.native.pty ? `PTY ${tab.native.number}` : `Shell ${tab.native.number}`;
}

function attachNativeSession(info) {
  const existing = nativeTabForSession(info?.id);
  if (existing) {
    switchTab(existing.id);
    return existing;
  }
  return createNativeTerminalTab(true, { session: info });
}

function attachNativeSessionToTab(tab, info) {
  const size = nativeTerminalSize(tab);
  applyNativeSessionInfo(tab, info, size);
  nativeNotice(tab, `Attached to ${tab.native.shell || "shell"} · ${tab.native.cwd || ""}`);
  updateNativeShellUi(tab);
  openNativeStream(tab);
  queueNativeResize(tab, tab.native.cols || size.cols, tab.native.rows || size.rows, true);
  scheduleNativeSessionsRefresh();
}

function openNativeStream(tab) {
  if (!tab.native?.id || typeof EventSource !== "function") return;
  const generation = tab.native.generation;
  const source = new EventSource(`/api/native/${encodeURIComponent(tab.native.id)}/stream`);
  tab.native.eventSource = source;
  source.addEventListener("ready", (e) => {
    if (tab.native.generation !== generation) return;
    const data = parseSsePayload(e);
    applyNativeSessionInfo(tab, data, nativeTerminalSize(tab));
    updateNativeShellUi(tab);
  });
  source.addEventListener("data", (e) => {
    if (tab.native.generation !== generation) return;
    const data = parseSsePayload(e).data ?? "";
    appendNativeOutput(tab, data);
  });
  source.addEventListener("exit", (e) => {
    if (tab.native.generation !== generation) return;
    const data = parseSsePayload(e);
    tab.native.closed = true;
    tab.native.stopping = false;
    tab.native.exitCode = data.code ?? null;
    paneLine(tab, `native shell exited${data.code == null ? "" : ` (${data.code})`}`, "muted");
    updateNativeShellUi(tab);
    scheduleNativeSessionsRefresh();
    source.close();
  });
  source.addEventListener("done", () => source.close());
  source.onerror = () => {
    if (tab.native.generation !== generation) return;
    if (!tab.native.closed) paneLine(tab, "native shell stream disconnected", "err");
    tab.native.streamDisconnected = true;
    tab.native.stopping = false;
    updateNativeShellUi(tab);
    scheduleNativeSessionsRefresh();
    source.close();
  };
}

function parseSsePayload(event) {
  try {
    return JSON.parse(event.data || "{}");
  } catch {
    return {};
  }
}

function queueNativeInput(tab, data, immediate = false) {
  if (!tab?.native?.id || tab.native.closed || tab.native.stopping || tab.native.streamDisconnected) return;
  tab.native.inputBuffer += data;
  if (immediate) {
    void flushNativeInput(tab);
    return;
  }
  if (!tab.native.flushTimer) {
    tab.native.flushTimer = window.setTimeout(() => {
      tab.native.flushTimer = 0;
      void flushNativeInput(tab);
    }, 12);
  }
}

function nativeTerminalSize(tab) {
  const term = tab?.native?.terminal;
  return {
    cols: Math.max(2, Math.min(1000, Math.floor(Number(term?.cols || tab?.native?.cols || 80)))),
    rows: Math.max(1, Math.min(1000, Math.floor(Number(term?.rows || tab?.native?.rows || 24)))),
  };
}

function queueNativeResize(tab, cols, rows, immediate = false) {
  if (!tab?.native || tab.native.closed || tab.native.stopping) return;
  const size = {
    cols: Math.max(2, Math.min(1000, Math.floor(Number(cols) || 80))),
    rows: Math.max(1, Math.min(1000, Math.floor(Number(rows) || 24))),
  };
  tab.native.cols = size.cols;
  tab.native.rows = size.rows;
  if (!tab.native.id) return;
  if (immediate) {
    void sendNativeResize(tab);
    return;
  }
  if (tab.native.resizeTimer) clearTimeout(tab.native.resizeTimer);
  tab.native.resizeTimer = window.setTimeout(() => {
    tab.native.resizeTimer = 0;
    void sendNativeResize(tab);
  }, 80);
}

async function sendNativeResize(tab) {
  if (!tab?.native?.id || tab.native.closed || tab.native.stopping) return;
  if (tab.native.resizeTimer) {
    clearTimeout(tab.native.resizeTimer);
    tab.native.resizeTimer = 0;
  }
  const { cols, rows } = nativeTerminalSize(tab);
  tab.native.cols = cols;
  tab.native.rows = rows;
  if (tab.native.sentCols === cols && tab.native.sentRows === rows) return;
  try {
    const res = await fetch(`/api/native/${encodeURIComponent(tab.native.id)}/resize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cols, rows }),
    });
    if (res.ok) {
      tab.native.sentCols = cols;
      tab.native.sentRows = rows;
      updateNativeShellUi(tab, { renderTabs: false });
    }
  } catch {
    /* resize is best-effort; input/output remains usable */
  }
}

async function flushNativeInput(tab) {
  if (!tab?.native?.id || tab.native.closed || tab.native.stopping || tab.native.streamDisconnected) return;
  if (tab.native.flushTimer) {
    clearTimeout(tab.native.flushTimer);
    tab.native.flushTimer = 0;
  }
  const data = tab.native.inputBuffer;
  if (!data) return;
  tab.native.inputBuffer = "";
  tab.native.writeChain = tab.native.writeChain.then(async () => {
    const res = await fetch(`/api/native/${encodeURIComponent(tab.native.id)}/input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data }),
    });
    if (!res.ok) paneLine(tab, `native input failed: HTTP ${res.status}`, "err");
  }).catch((err) => {
    paneLine(tab, "native input failed: " + (err?.message ?? String(err)), "err");
  });
  await tab.native.writeChain;
}

async function shutdownNativeSession(tab, options = {}) {
  if (!tab?.native) return false;
  const requestServer = options.requestServer !== false;
  const dispose = options.dispose !== false;
  const sessionId = tab.native.id;
  const generation = tab.native.generation;
  tab.native.stopping = true;
  tab.native.closed = true;
  updateNativeShellUi(tab, { renderTabs: options.renderTabs });
  tab.native.eventSource?.close();
  if (tab.native.flushTimer) clearTimeout(tab.native.flushTimer);
  if (tab.native.resizeTimer) clearTimeout(tab.native.resizeTimer);
  tab.native.flushTimer = 0;
  tab.native.resizeTimer = 0;
  tab.native.inputBuffer = "";
  if (dispose) {
    tab.native.dataDisposable?.dispose?.();
    tab.native.resizeDisposable?.dispose?.();
    tab.native.resizeObserver?.disconnect?.();
    tab.native.terminal?.dispose?.();
  }
  if (requestServer && sessionId) {
    await fetch(`/api/native/${encodeURIComponent(sessionId)}/close`, { method: "POST" }).catch(() => undefined);
  }
  if (tab.native.generation === generation) {
    tab.native.stopping = false;
    updateNativeShellUi(tab, { renderTabs: options.renderTabs });
  }
  scheduleNativeSessionsRefresh();
  return true;
}

async function restartNativeTerminal(tab) {
  if (tab?.type !== "native" || !tab.native) return;
  const number = tab.native.number;
  await shutdownNativeSession(tab, { requestServer: true, dispose: true, renderTabs: false });
  tab.pane.innerHTML = "";
  tab.native = createNativeState(number);
  tab.title = `Shell ${number}`;
  buildNativeToolbar(tab);
  mountNativeTerminal(tab);
  nativeNotice(tab, "Restarting native shell...");
  nativeNotice(tab, "Direct OS shell: not parsed by IDEL and not written to OpenLogs.");
  updateNativeShellUi(tab);
  renderTabs();
  syncCommandArea();
  focusActiveInput();
  void startNativeTerminal(tab);
}

function appendNativeOutput(tab, raw) {
  if (tab.native?.terminal) {
    tab.native.terminal.write(String(raw ?? ""));
    return;
  }
  const text = String(raw ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\u0007/g, "");
  if (!text) return;
  appendAnsiText(tab, text);
  tab.pane.scrollTop = tab.pane.scrollHeight;
}

function ensureNativeStreamBody(tab) {
  let body = tab.native.streamBody;
  if (!body || !body.isConnected) {
    const div = document.createElement("div");
    div.className = "line native-stream";
    body = document.createElement("span");
    body.className = "line-body";
    div.appendChild(body);
    tab.native.streamBody = body;
    tab.pane.appendChild(div);
  }
  return body;
}

function appendAnsiText(tab, value) {
  let body = ensureNativeStreamBody(tab);
  let i = 0;
  while (i < value.length) {
    const esc = value.indexOf("\x1b", i);
    if (esc === -1) {
      appendStyledNativeText(body, value.slice(i), tab.native.ansi);
      break;
    }
    if (esc > i) appendStyledNativeText(body, value.slice(i, esc), tab.native.ansi);
    i = consumeAnsiSequence(tab, body, value, esc);
    if (!body.isConnected) body = ensureNativeStreamBody(tab);
  }
}

function consumeAnsiSequence(tab, body, value, index) {
  const next = value[index + 1];
  if (next === "]") {
    const bell = value.indexOf("\u0007", index + 2);
    const st = value.indexOf("\x1b\\", index + 2);
    const end = bell === -1 ? st : st === -1 ? bell : Math.min(bell, st);
    if (end === -1) return value.length;
    return end === st ? end + 2 : end + 1;
  }
  if (next !== "[") return Math.min(index + 2, value.length);

  let end = index + 2;
  while (end < value.length && !/[\x40-\x7e]/.test(value[end])) end++;
  if (end >= value.length) return value.length;

  const command = value[end];
  const params = value.slice(index + 2, end);
  if (command === "m") {
    applyAnsiSgr(tab.native.ansi, params);
  } else if (command === "J" && shouldClearAnsiScreen(params)) {
    tab.pane.innerHTML = "";
    tab.native.streamBody = null;
  } else if (command === "K") {
    body.textContent = "";
  }
  return end + 1;
}

function appendStyledNativeText(body, text, state) {
  if (!text) return;
  let chunk = "";
  for (const ch of text) {
    if (ch === "\b" || ch === "\u007f") {
      if (chunk) {
        appendNativeChunk(body, chunk, state);
        chunk = "";
      }
      removeLastNativeCharacter(body);
      continue;
    }
    chunk += ch;
  }
  if (chunk) appendNativeChunk(body, chunk, state);
}

function appendNativeChunk(body, text, state) {
  const style = nativeAnsiStyle(state);
  if (!style) {
    body.appendChild(document.createTextNode(text));
    return;
  }
  const span = document.createElement("span");
  span.textContent = text;
  Object.assign(span.style, style);
  body.appendChild(span);
}

function removeLastNativeCharacter(node) {
  const last = node.lastChild;
  if (!last) return;
  if (last.nodeType === Node.TEXT_NODE) {
    last.textContent = last.textContent.slice(0, -1);
    if (!last.textContent) last.remove();
    return;
  }
  removeLastNativeCharacter(last);
  if (!last.textContent) last.remove();
}

function defaultAnsiState() {
  return {
    fg: "",
    bg: "",
    bold: false,
    faint: false,
    italic: false,
    underline: false,
    inverse: false,
  };
}

function resetAnsiState(state) {
  Object.assign(state, defaultAnsiState());
}

function applyAnsiSgr(state, rawParams) {
  const params = parseAnsiParams(rawParams);
  if (!params.length) params.push(0);
  for (let i = 0; i < params.length; i++) {
    const code = params[i] ?? 0;
    if (code === 0) resetAnsiState(state);
    else if (code === 1) state.bold = true;
    else if (code === 2) state.faint = true;
    else if (code === 3) state.italic = true;
    else if (code === 4) state.underline = true;
    else if (code === 7) state.inverse = true;
    else if (code === 22) state.bold = state.faint = false;
    else if (code === 23) state.italic = false;
    else if (code === 24) state.underline = false;
    else if (code === 27) state.inverse = false;
    else if (code === 39) state.fg = "";
    else if (code === 49) state.bg = "";
    else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) state.fg = ansiBasicColor(code);
    else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) state.bg = ansiBasicColor(code - 10);
    else if ((code === 38 || code === 48) && params[i + 1] === 5 && params[i + 2] !== undefined) {
      state[code === 38 ? "fg" : "bg"] = ansi256Color(params[i + 2]);
      i += 2;
    } else if (
      (code === 38 || code === 48) &&
      params[i + 1] === 2 &&
      params[i + 2] !== undefined &&
      params[i + 3] !== undefined &&
      params[i + 4] !== undefined
    ) {
      state[code === 38 ? "fg" : "bg"] = `rgb(${clampRgb(params[i + 2])}, ${clampRgb(params[i + 3])}, ${clampRgb(params[i + 4])})`;
      i += 4;
    }
  }
}

function parseAnsiParams(rawParams) {
  if (!rawParams) return [];
  return rawParams
    .split(/[;:]/)
    .filter((part) => part !== "")
    .map((part) => Number.parseInt(part, 10))
    .filter((value) => Number.isFinite(value));
}

function shouldClearAnsiScreen(params) {
  const values = parseAnsiParams(params);
  return values.length === 0 || values.includes(2) || values.includes(3);
}

function nativeAnsiStyle(state) {
  let fg = state.fg;
  let bg = state.bg;
  if (state.inverse) [fg, bg] = [bg || "var(--fg)", fg || "var(--field-bg)"];
  const style = {};
  if (fg) style.color = fg;
  if (bg) style.backgroundColor = bg;
  if (state.bold) style.fontWeight = "700";
  if (state.faint) style.opacity = "0.72";
  if (state.italic) style.fontStyle = "italic";
  if (state.underline) style.textDecoration = "underline";
  return Object.keys(style).length ? style : null;
}

function ansiBasicColor(code) {
  const colors = {
    30: "#1f2937",
    31: "#ef4444",
    32: "#22c55e",
    33: "#eab308",
    34: "#3b82f6",
    35: "#d946ef",
    36: "#06b6d4",
    37: "#e5e7eb",
    90: "#6b7280",
    91: "#f87171",
    92: "#4ade80",
    93: "#facc15",
    94: "#60a5fa",
    95: "#e879f9",
    96: "#22d3ee",
    97: "#f9fafb",
  };
  return colors[code] ?? "";
}

function ansi256Color(value) {
  const n = Math.max(0, Math.min(255, Number(value) || 0));
  if (n < 16) return ansiBasicColor(n < 8 ? 30 + n : 90 + n - 8);
  if (n >= 232) {
    const level = 8 + (n - 232) * 10;
    return `rgb(${level}, ${level}, ${level})`;
  }
  const idx = n - 16;
  const r = Math.floor(idx / 36);
  const g = Math.floor((idx % 36) / 6);
  const b = idx % 6;
  const scale = (part) => part === 0 ? 0 : 55 + part * 40;
  return `rgb(${scale(r)}, ${scale(g)}, ${scale(b)})`;
}

function clampRgb(value) {
  return Math.max(0, Math.min(255, Number(value) || 0));
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
  if (clipboardCopyBlocked()) {
    flashButton(button, "Blocked");
    showClipboardBlocked("Copy");
    return;
  }
  try {
    await writeClipboardText(text);
    flashButton(button, "Copied");
  } catch {
    flashButton(button, "Failed");
  }
}

async function writeClipboardText(text) {
  if (clipboardCopyBlocked()) throw new Error("copy blocked");
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
    if (clipboardCopyBlocked()) {
      flashButton(screenshotCopy, "Blocked");
      showClipboardBlocked("Copy");
      return;
    }
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
  const tab = tabForOutput(output);
  if (tab?.type === "native" && tab.native?.terminal) return nativeTerminalBufferText(tab, scope);
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
  if (clipboardCopyBlocked()) throw new Error("copy blocked");
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
  if (isWorkflowCommand(command)) return await handleWorkflowCommand(command);
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
// Live risk preview
// ---------------------------------------------------------------------------

function setRiskIndicator(state, label, title) {
  if (!riskIndicator) return;
  const safeState = String(state || "empty").replace(/[^a-z-]/g, "");
  riskIndicator.className = `risk-indicator risk-indicator--${safeState}`;
  const labelEl = riskIndicator.querySelector(".risk-indicator-label");
  if (labelEl) labelEl.textContent = label || "risk";
  riskIndicator.title = title || "Command risk preview";
  riskIndicator.setAttribute("aria-label", riskIndicator.title);
}

function scheduleRiskPreview() {
  if (!riskIndicator) return;
  window.clearTimeout(riskPreviewTimer);
  riskPreviewSeq += 1;
  const seq = riskPreviewSeq;
  if (riskPreviewAbort) {
    riskPreviewAbort.abort();
    riskPreviewAbort = null;
  }

  const tab = activeTab();
  if (form.hidden || tab?.type === "editor") {
    setRiskIndicator("empty", "risk", "Command risk preview");
    return;
  }
  if (tab?.type === "native") {
    setRiskIndicator("empty", "direct", "Native shell input is direct and is not risk-scanned per command.");
    return;
  }
  if (mode !== "idel") {
    setRiskIndicator("empty", "agent", "Ask Claude proposals are risk-scanned before the runtime runs them.");
    return;
  }

  const command = currentInputSegment().value.trim();
  if (!command) {
    setRiskIndicator("empty", "risk", "Command risk preview");
    return;
  }
  if (isSingleLocalClearCommand(command) || isWorkflowCommand(command)) {
    setRiskIndicator("safe", "local", "Local terminal action. No runtime execution.");
    return;
  }
  const learnCommand = parseLearnCommand(command);
  if (learnCommand) {
    setRiskIndicator(
      learnCommand.write ? "caution" : "safe",
      learnCommand.write ? "write" : "learn",
      learnCommand.write
        ? "Learning will write accepted command definitions to the custom registry."
        : "Learning previews command definitions without writing them.",
    );
    return;
  }

  setRiskIndicator("pending", "check", "Checking command risk...");
  riskPreviewTimer = window.setTimeout(() => {
    void previewCommandRisk(command, seq);
  }, 160);
}

async function previewCommandRisk(command, seq) {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  riskPreviewAbort = controller;
  try {
    const res = await fetch("/api/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command }),
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (seq !== riskPreviewSeq) return;
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      setRiskIndicator("offline", "error", `Preview failed: HTTP ${res.status}${text ? ` ${text}` : ""}`);
      return;
    }
    const preview = await res.json();
    if (seq !== riskPreviewSeq) return;
    renderRiskPreview(preview);
  } catch (err) {
    if (err?.name === "AbortError" || seq !== riskPreviewSeq) return;
    setRiskIndicator("offline", "offline", "Could not reach the IDEL preview endpoint.");
  } finally {
    if (riskPreviewAbort === controller) riskPreviewAbort = null;
  }
}

function renderRiskPreview(preview) {
  const risk = String(preview?.risk?.level ?? "LOW").toUpperCase();
  const action = String(preview?.decision?.action ?? "allow");
  const findings = preview?.risk?.findings ?? [];
  const invalid = action === "block" && findings.some((f) => f.code === "parse-error" || f.code === "usage-error");
  if (invalid) {
    setRiskIndicator("invalid", "invalid", riskPreviewTitle(preview, "Invalid command"));
    return;
  }

  const state =
    risk === "CRITICAL" ? "critical" :
      risk === "HIGH" ? "danger" :
        risk === "MEDIUM" ? "caution" :
          action === "block" ? "danger" :
            "safe";
  const label =
    risk === "CRITICAL" ? "critical" :
      risk === "HIGH" ? "high" :
        risk === "MEDIUM" ? "medium" :
          "safe";
  setRiskIndicator(state, label, riskPreviewTitle(preview));
}

function riskPreviewTitle(preview, prefix = "") {
  const risk = preview?.risk?.level ?? "LOW";
  const action = preview?.decision?.action ?? "allow";
  const parts = [];
  if (prefix) parts.push(prefix);
  if (preview?.batch) parts.push(`${preview.commands?.length ?? 0} batch steps`);
  parts.push(`Risk: ${risk}`);
  parts.push(`Decision: ${String(action).replaceAll("_", " ")}`);
  const translated = translateLine(preview);
  if (translated) parts.push(`Translates to: ${translated}`);
  const firstFinding = preview?.risk?.findings?.[0];
  if (firstFinding) parts.push(`${firstFinding.code}: ${firstFinding.message}`);
  return parts.join(" · ");
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
  syncPrompt();
  syncInputPlaceholder();
  hideCompletions();
  syncCommandArea();
  resizeCommandInput();
  focusActiveInput();
}

function syncPrompt() {
  const nativeActive = activeTab()?.type === "native";
  promptEl.textContent = nativeActive ? "sh>" : mode === "ask" ? "?" : "idel>";
  promptEl.classList.toggle("ask", mode === "ask" && !nativeActive);
  promptEl.classList.toggle("native", nativeActive);
}

function syncInputPlaceholder() {
  const compact = compactInputMedia?.matches ?? false;
  if (activeTab()?.type === "native") {
    input.placeholder = compact ? "native shell" : "native shell input is live: Tab, arrows, Ctrl+C go to the shell";
    return;
  }
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
      ? "Multiline batch input is on. Ctrl+B toggles; Ctrl+Enter runs."
      : "Multiline batch input. Ctrl+B toggles; Ctrl+Enter runs.",
  );
  renderKnowledgeBase();
  syncInputPlaceholder();
  resizeCommandInput();
  focusActiveInput();
}

function resizeCommandInput() {
  if (!input || input.tagName !== "TEXTAREA") return;
  input.style.height = "auto";
  const max = multilineBatch && activeTab()?.type !== "native" ? 144 : 32;
  const nextHeight = Math.min(input.scrollHeight, max);
  input.style.height = `${Math.max(nextHeight, 22)}px`;
  input.style.overflowY = input.scrollHeight > max ? "auto" : "hidden";
  scheduleRiskPreview();
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
newNativeTerminalBtn?.addEventListener("click", () => createNativeTerminalTab(true));
if (compactInputMedia?.addEventListener) compactInputMedia.addEventListener("change", syncInputPlaceholder);
else if (compactInputMedia?.addListener) compactInputMedia.addListener(syncInputPlaceholder);

batchToggle?.addEventListener("click", () => setMultilineBatch(!multilineBatch));

input.addEventListener("input", () => {
  if (activeTab()?.type === "native") {
    input.value = "";
    return;
  }
  resizeCommandInput();
  void updateCompletions();
});

function handleNativeKeydown(tab, e) {
  let data = "";
  const key = e.key;
  const lower = key.toLowerCase();

  if (e.ctrlKey && !e.metaKey && !e.altKey) {
    if (lower === "c") data = "\x03";
    else if (lower === "d") data = "\x04";
    else if (lower === "l") data = "\x0c";
    else if (lower === "z") data = "\x1a";
    else if (key === "[") data = "\x1b";
  } else {
    const special = {
      Enter: "\r",
      Backspace: "\x7f",
      Tab: "\t",
      Escape: "\x1b",
      ArrowUp: "\x1b[A",
      ArrowDown: "\x1b[B",
      ArrowRight: "\x1b[C",
      ArrowLeft: "\x1b[D",
      Home: "\x1b[H",
      End: "\x1b[F",
      Delete: "\x1b[3~",
      PageUp: "\x1b[5~",
      PageDown: "\x1b[6~",
    };
    data = special[key] ?? "";
    if (!data && key.length === 1 && !e.metaKey && !e.altKey) data = key;
  }

  if (!data) return;
  e.preventDefault();
  input.value = "";
  resizeCommandInput();
  queueNativeInput(tab, data, data === "\r" || data.length > 1);
}

input.addEventListener("keydown", (e) => {
  const tab = activeTab();
  if (tab?.type === "native") {
    handleNativeKeydown(tab, e);
    return;
  }
  if (e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === "b") {
    e.preventDefault();
    if (!e.repeat) setMultilineBatch(!multilineBatch);
    return;
  }
  if (e.ctrlKey && !e.metaKey && e.key.toLowerCase() === "c") {
    if (input.value.length > 0 || !completionsEl.hidden) {
      e.preventDefault();
      input.value = "";
      activeInputHistoryTab().histIdx = -1;
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
    const terminal = activeInputHistoryTab();
    if (terminal.history.length) {
      terminal.histIdx = terminal.histIdx < 0 ? terminal.history.length - 1 : Math.max(0, terminal.histIdx - 1);
      input.value = terminal.history[terminal.histIdx] ?? "";
      resizeCommandInput();
    }
  }
  if (e.key === "ArrowDown" && completionsEl.hidden) {
    e.preventDefault();
    const terminal = activeInputHistoryTab();
    if (terminal.histIdx >= 0) {
      terminal.histIdx = terminal.histIdx + 1;
      input.value = terminal.histIdx >= terminal.history.length ? ((terminal.histIdx = -1), "") : terminal.history[terminal.histIdx];
      resizeCommandInput();
    }
  }
});

input.addEventListener("paste", (e) => {
  const tab = activeTab();
  if (clipboardPasteBlocked()) {
    e.preventDefault();
    showClipboardBlocked("Paste");
    return;
  }
  if (tab?.type !== "native") return;
  const text = e.clipboardData?.getData("text") ?? "";
  if (!text) return;
  e.preventDefault();
  queueNativePaste(tab, text);
});

form.addEventListener("submit", (e) => {
  e.preventDefault();
  submitCommandInput();
});

function submitCommandInput() {
  void submitCommandInputAsync();
}

async function submitCommandInputAsync() {
  const tab = activeTab();
  if (tab?.type === "native") {
    input.value = "";
    resizeCommandInput();
    queueNativeInput(tab, "\r", true);
    return;
  }
  const value = input.value.trim();
  if (input.disabled) return;
  if (!value) return;
  const terminal = activeInputHistoryTab();
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
    else if (isWorkflowCommand(value)) await handleWorkflowCommand(value);
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
    focusActiveInput();
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
      serverOnline = true;
      statusEl.textContent = "● online · idel " + (d.version ?? "");
      statusEl.classList.add("online");
      if (Object.prototype.hasOwnProperty.call(d, "platform")) setServerPlatform(d.platform);
      if (Object.prototype.hasOwnProperty.call(d, "agentAvailable")) {
        sawHealthAgentStatus = true;
        setAgentAvailability(d.agentAvailable !== false);
      }
      if (Object.prototype.hasOwnProperty.call(d, "nativeAvailable")) {
        setNativeAvailability(d.nativeAvailable !== false);
      }
    } else throw new Error();
  } catch {
    serverOnline = false;
    statusEl.textContent = "○ offline — start `idel serve --static …`";
    statusEl.classList.add("offline");
  }
  // Probe whether the Claude console is wired on older servers that do not
  // expose health.agentAvailable yet.
  if (!sawHealthAgentStatus) await probeAgentAvailability();
  setMode(mode, { suppressSetup: true });
  refreshLogs();
  if (!storageGet(SETUP_DISMISSED_KEY)) {
    window.setTimeout(() => void openSetupChecklist(), 450);
  }
}

initPreferences();
initClaudeSetupDialog();
initDictionary();
initKnowledgeBase();
initCommandPalette();
initWorkflowDialog();
initNativeSessionsDialog();
initSetupChecklist();
initScreenshotActions();
initWorkspace();
initPageRefreshGuard();
setServerPlatform("");
setMultilineBatch(false);
boot();
