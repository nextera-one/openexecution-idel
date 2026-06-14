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
const completionsEl = $("completions");
const statusEl = $("status");
const logsEl = $("logs");
const tabsEl = $("tabs");
const newTerminalBtn = $("new-terminal");

let mode = location.hash === "#ask" ? "ask" : "idel";
let completions = [];
let compSel = -1;
let nextTabId = 1;
let terminalCount = 0;
let activeTabId = "";
let lastTerminalTabId = "";
const tabs = [];

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
  const editorActive = tab.type === "editor";
  form.hidden = editorActive;
  completionsEl.hidden = true;
  if (editorActive) hideCompletions();
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
  tabs.splice(index, 1);
  tab.pane.remove();
  if (lastTerminalTabId === tab.id) {
    lastTerminalTabId = tabs.find((candidate) => candidate.type === "terminal")?.id ?? "";
  }
  if (activeTabId === tab.id) {
    const next = tabs[index] ?? tabs[index - 1] ?? tabs.find((candidate) => candidate.type === "terminal");
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
  div.textContent = text;
  return div;
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

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
  for (const token of rest) {
    const eq = token.indexOf("=");
    if (eq <= 0) continue;
    params[token.slice(0, eq)] = token.slice(eq + 1);
  }
  return { command, params };
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
    line(`wrote ${accepted} learned command(s) to ${result.path}`, "ok");
  } else if (accepted > 0) {
    line(`Preview only. Re-run with --write to save ${accepted} command(s).`, "muted");
  } else {
    line("Nothing valid to learn; no defs written.", "err");
  }
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
async function updateCompletions() {
  if (mode !== "idel" || activeTab()?.type !== "terminal") return hideCompletions();
  const value = input.value;
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
  completions.slice(0, 30).forEach((c, i) => {
    const li = document.createElement("li");
    li.textContent = c;
    if (i === compSel) li.classList.add("sel");
    li.addEventListener("mousedown", (e) => {
      e.preventDefault();
      applyCompletion(c);
    });
    completionsEl.appendChild(li);
  });
  completionsEl.hidden = false;
}

function hideCompletions() {
  completionsEl.hidden = true;
  completions = [];
  compSel = -1;
}

function applyCompletion(c) {
  // The server returns whole-token suggestions; replace the last token.
  const bounds = lastTokenBounds(input.value);
  input.value =
    input.value.slice(0, bounds.start) +
    c +
    input.value.slice(bounds.end) +
    completionSuffix(c);
  hideCompletions();
  input.focus();
}

function completionSuffix(c) {
  if (c.endsWith("=") || c.endsWith("/") || c.endsWith("\\") || c.endsWith(".")) return "";
  return " ";
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

function setMode(next) {
  mode = next;
  $("mode-idel").classList.toggle("active", mode === "idel");
  $("mode-ask").classList.toggle("active", mode === "ask");
  promptEl.textContent = mode === "ask" ? "?" : "idel>";
  promptEl.classList.toggle("ask", mode === "ask");
  input.placeholder =
    mode === "ask"
      ? "describe what you want — e.g. delete the dist folder"
      : "verb.scope param=value   (Tab to complete, ↑/↓ history)";
  hideCompletions();
  input.focus();
}

$("mode-idel").addEventListener("click", () => {
  setMode("idel");
  switchTab(activeTerminalTab().id);
});
$("mode-ask").addEventListener("click", () => {
  setMode("ask");
  switchTab(activeTerminalTab().id);
});
$("refresh-logs").addEventListener("click", refreshLogs);
newTerminalBtn.addEventListener("click", () => createTerminalTab(true));

input.addEventListener("input", updateCompletions);

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
  if (!completionsEl.hidden && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
    e.preventDefault();
    const n = Math.min(completions.length, 30);
    compSel = e.key === "ArrowDown" ? (compSel + 1) % n : (compSel - 1 + n) % n;
    renderCompletions();
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
    }
  }
  if (e.key === "ArrowDown" && completionsEl.hidden) {
    e.preventDefault();
    const terminal = activeTerminalTab();
    if (terminal.histIdx >= 0) {
      terminal.histIdx = terminal.histIdx + 1;
      input.value = terminal.histIdx >= terminal.history.length ? ((terminal.histIdx = -1), "") : terminal.history[terminal.histIdx];
    }
  }
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const value = input.value.trim();
  if (!value) return;
  const terminal = activeTerminalTab();
  terminal.history.push(value);
  terminal.histIdx = -1;
  input.value = "";
  hideCompletions();
  input.disabled = true;
  try {
    if (mode === "ask") await runAsk(value);
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
    input.disabled = false;
    input.focus();
  }
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  try {
    const res = await fetch("/api/health");
    const d = res.ok ? await res.json() : null;
    if (d?.ok) {
      statusEl.textContent = "● online · idel " + (d.version ?? "");
      statusEl.classList.add("online");
      if (d.agentAvailable === false) {
        $("mode-ask").disabled = true;
        $("mode-ask").title =
          "Claude console disabled — install Claude Code + run `claude login`, or set ANTHROPIC_API_KEY on the server";
      }
    } else throw new Error();
  } catch {
    statusEl.textContent = "○ offline — start `idel serve --static …`";
    statusEl.classList.add("offline");
  }
  // Probe whether the Claude console is wired on older servers that do not
  // expose health.agentAvailable yet.
  try {
    const probe = await fetch("/api/agent/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: "" }),
    });
    if (probe.status === 501) {
      $("mode-ask").disabled = true;
      $("mode-ask").title =
        "Claude console disabled — install Claude Code + run `claude login`, or set ANTHROPIC_API_KEY on the server";
    }
  } catch {
    /* ignore */
  }
  setMode(mode);
  refreshLogs();
}

initWorkspace();
boot();
