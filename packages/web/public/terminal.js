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
const output = $("output");
const input = $("input");
const form = $("form");
const promptEl = $("prompt");
const completionsEl = $("completions");
const statusEl = $("status");
const logsEl = $("logs");

let mode = location.hash === "#ask" ? "ask" : "idel";
const history = [];
let histIdx = -1;
let completions = [];
let compSel = -1;

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function line(text, cls = "") {
  const div = document.createElement("div");
  div.className = "line " + cls;
  div.textContent = text;
  output.appendChild(div);
  output.scrollTop = output.scrollHeight;
  return div;
}

function html(node) {
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
    else if (event === "error") line("Error: " + (data.error ?? "unknown"), "err");
  });
  refreshLogs();
}

// ---------------------------------------------------------------------------
// Ask (Claude mode)
// ---------------------------------------------------------------------------

async function runAsk(intent) {
  line("? " + intent, "ask");
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
  if (mode !== "idel") return hideCompletions();
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

$("mode-idel").addEventListener("click", () => setMode("idel"));
$("mode-ask").addEventListener("click", () => setMode("ask"));
$("refresh-logs").addEventListener("click", refreshLogs);

input.addEventListener("input", updateCompletions);

input.addEventListener("keydown", (e) => {
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
    if (history.length) {
      histIdx = histIdx < 0 ? history.length - 1 : Math.max(0, histIdx - 1);
      input.value = history[histIdx] ?? "";
    }
  }
  if (e.key === "ArrowDown" && completionsEl.hidden) {
    e.preventDefault();
    if (histIdx >= 0) {
      histIdx = histIdx + 1;
      input.value = histIdx >= history.length ? ((histIdx = -1), "") : history[histIdx];
    }
  }
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const value = input.value.trim();
  if (!value) return;
  history.push(value);
  histIdx = -1;
  input.value = "";
  hideCompletions();
  input.disabled = true;
  try {
    if (mode === "ask") await runAsk(value);
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

boot();
