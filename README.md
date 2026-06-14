# OpenExecution Runtime & IDEL Terminal

**Not prettier Bash — a policy-aware execution runtime that turns human or AI intent into safe, logged, cross-platform execution.**

IDEL is an intent language (`verb.scope param=value`). The OpenExecution Runtime parses it, resolves it through a versioned command registry, classifies its risk, enforces policy, plans a platform-specific execution, runs it through an OS adapter, and records every decision to an append-only audit log. The CLI is `idel`.

The bet of V1 is narrow and defensible: **prove that a runtime can prevent dangerous execution mistakes without slowing developers down.** Readability is a side benefit, not the pitch.

---

## Table of Contents

- [The killer demo](#the-killer-demo)
- [Why this exists](#why-this-exists)
- [Install & build](#install--build)
- [Quick start](#quick-start)
- [Architecture](#architecture)
- [Two-phase safety](#two-phase-safety)
- [Two precedence systems, pointing opposite ways](#two-precedence-systems-pointing-opposite-ways)
- [Risk levels & policy actions](#risk-levels--policy-actions)
- [Native passthrough](#native-passthrough)
- [Web terminal & teaching IDEL a CLI](#quick-start)
- [Using your Claude subscription](#using-your-claude-subscription)
- [OpenLogs](#openlogs)
- [CLI flags](#cli-flags)
- [Exit codes](#exit-codes)
- [Testing](#testing)
- [V1 scope vs. V2 deferred](#v1-scope-vs-v2-deferred)
- [Further reading](#further-reading)

---

## The killer demo

```text
$ idel remove.folder name=/ recursive=true force=true

Command: remove.folder
Risk: CRITICAL
  - [CRITICAL] root-delete: Destructive target resolves to the filesystem root (/).
  - [HIGH] recursive-force: Destructive op uses recursive + force together on /.
Decision: BLOCK [rule #0]
Reason: Matched rule 0 (action: block).
BLOCKED. No files were changed.
Log: ~/.idel/logs/openlogs.jsonl
```

Process exit code: `4` (blocked). No filesystem traversal happened — the runtime short-circuits a CRITICAL classification and refuses to even walk `/` to estimate a blast radius for a command it is about to block. The block is written to OpenLogs as a normal audit event (`result: blocked_before_execution`), not as an error.

The `--yes` flag does **not** clear this. The CRITICAL floor is enforced by the policy engine itself, so neither `--yes` nor a lax custom policy can downgrade it.

The same thing happens for native passthrough:

```text
$ idel ! rm -rf /

Command: rm -rf /
Risk: CRITICAL
  - [CRITICAL] native-rm-rf-root: native `rm` with recursive+force flags
  - [CRITICAL] native-rm-rf-root-target: native `rm` targeting root or home directory
Decision: BLOCK [rule #0]
Reason: Matched rule 0 (action: block).
BLOCKED. No files were changed.
```

---

## Why this exists

Traditional shells hide risk in flags and symbols. `rm -rf /`, `chmod -R 777 /`, and `dd if=x of=/dev/sda` are one typo away from catastrophe, and nothing about them is reviewable, audited, or policy-gated. IDEL exposes risk **at the call site** and lets the runtime decide, before anything touches disk.

The audience is professionals, not beginners:

- **Safety** — destructive intent must be explicit (`recursive=true force=true`), and catastrophic targets (root, home, drive roots, raw devices, recursive `777` on broad trees) are blocked by default.
- **Auditability** — every command, risk decision, adapter, exit code, and duration is appended to a local JSONL audit trail with secret redaction.
- **Policy** — allow / warn / require dry-run / require approval / block, matched on risk, command, params, source, and environment. Built for CI and team enforcement, not just an interactive prompt.
- **Portability** — execution is adapter-based (POSIX, PowerShell, in-process Node), not "compile to Bash." Where platforms genuinely diverge, the registry says so honestly instead of faking parity.

---

## Install & build

This is a pnpm monorepo. It is **not yet published to npm** — you build it from source and run the CLI directly.

```bash
pnpm install
pnpm build          # tsc --build across all packages
```

Run the CLI:

```bash
node packages/cli/bin/idel.js help
node packages/cli/bin/idel.js version      # idel 1.1.0
```

To put `idel` on your `PATH` and prove the build works end to end:

```bash
pnpm install:local  # pnpm build + npm link  → `idel` on PATH
pnpm smoke          # boots idel, asserts the thesis demo is BLOCKED,
                    # and verifies the signed OpenLogs chain
```

Requires **Node.js >= 22.3** for the signed-logging path; `engines` declares `>=22.3` to match (see [CONCERNS.md](CONCERNS.md) §4). Throughout the rest of this README, `idel <…>` is shorthand for `node packages/cli/bin/idel.js <…>`.

---

## Quick start

```bash
# Create a file (LOW risk, runs immediately)
idel create.file name=readme.md

# Plan a recursive delete without touching anything; see the affected-path estimate
idel remove.folder name=dist recursive=true --dry-run

# Run a non-interactive script through a first-class IDEL command
idel run.script path=./scripts/check.js shell=node args="--fix src"

# Run multiple IDEL commands sequentially; stop on the first non-success
idel 'create.file name=a.txt && wait.time ms=500 && read.file name=a.txt'

# Open a file in your local editor (TTY-only; web/CI refuse cleanly)
idel editor README.md

# Native passthrough — risk-scanned and logged, never an unlogged escape hatch
idel ! tar -xvzf backup.tar.gz

# Inspect how a command resolves and what its adapters do on each platform
idel explain.registry command=remove.folder

# Review the audit trail
idel list.history
idel list.logs
```

A dry-run of a real directory shows the plan and the lower-bound blast-radius estimate:

```text
$ idel remove.folder name=dist recursive=true --dry-run

Command: remove.folder
Risk: HIGH
  - [HIGH] recursive-delete: Recursive deletion of a directory (/repo/dist).
  affected paths (estimate): 132
Decision: REQUIRE_DRY_RUN [rule #1]
Reason: Matched rule 1 (action: require_dry_run).
Dry run. No files were changed.
[dry-run] would execute: rm -r dist (cwd=/repo)
Log: ~/.idel/logs/openlogs.jsonl
```

Other useful commands: `idel list.registry` (41 core commands), `idel check.policy`, `idel terminal` (interactive REPL), `idel completion <partial>`.

Web terminal scrollback commands are local to the active terminal tab:
`clear.all`, `clear.last limit=10`, `clear.first limit=5`, and
`clear.range from=2 to=8`. They remove visible rows only; they do not delete
OpenLogs records or command history.

Batch execution uses shell-like `&&` at the IDEL host layer:

```bash
idel 'create.file name=a.txt && write.file name=a.txt content="ready" && read.file name=a.txt'
idel 'run.script path=./scripts/start.sh shell=bash && wait.time seconds=2 && tail.file file=app.log lines=20'
```

Each step is parsed, classified, policy-checked, executed, and logged as its own command. The next step starts only after the previous step completes successfully. During an explicit `--dry-run`, dry-run steps are allowed to continue so you can preview a whole batch. A line beginning with `!` remains native passthrough, so `! cmd1 && cmd2` keeps normal shell semantics inside the IDEL terminal. From Bash, quote the whole IDEL line: `idel '! cmd1 && cmd2'`.

**Web / desktop terminal.** `idel serve` starts a local HTTP+SSE server (loopback, port 7878 by default) that exposes the same runtime — registry-driven autocomplete, risk/policy classification, and signed OpenLogs — over a small JSON API. It is the boundary the browser and desktop (Javelle) terminals talk to; pass `--static <dir>` to also serve a built UI. A command typed in the GUI is audited identically to one typed at the CLI.

A ready-made, dependency-free web terminal + landing page ships in `packages/web/public`. The fastest way to see it:

```bash
pnpm ui            # builds if needed, then serves the terminal at http://127.0.0.1:7878
# (equivalently: idel serve --static packages/web/public)
```

The page at `/` explains the runtime; `/terminal.html` is a live terminal with an **IDEL** mode (registry completion, history, a live audit-log panel) and an **Ask Claude** mode that drives the embedded console over `/api/agent/stream`. The Claude console lights up when Claude is reachable on the `idel serve` process (see [Using your Claude subscription](#using-your-claude-subscription)) — the credential never reaches the browser.

Every command rendered in the terminal — typed or AI-proposed — shows what it **translates to**: the real adapter invocation (e.g. `remove.file name=x force=true` → `rm -f x`, `list.folder` → `ls`), so the mapping from intent to execution is visible at the call site. In the interactive `idel terminal`, a sensitive (HIGH/CRITICAL) command is previewed with its translation and risk and held for confirmation before any real run (and a `require_dry_run`-policy command is shown as dry-run-only, never silently promoted).

The web console can run commands **for real**, behind an explicit approval. Before any real run, the agent pauses and the terminal shows the dry-run plus **Approve / Decline** buttons; the server parks the agent (over `POST /api/agent/approve`) until you choose. A decline leaves the dry-run result standing, and a forgotten approval fails closed after a timeout — the agent never touches disk without a human "Approve." Interactive editor commands such as `open.editor` appear in the web registry and autocomplete, but actual editor launch is CLI/TTY-only; web/API/CI requests return a clear non-interactive failure instead of hanging.

**Teach IDEL an installed CLI.** `idel learn <cli>` introspects a CLI's own `--help`, drafts conservative IDEL command definitions locally, validates each against the registry schema (fail-closed), and **replays each def's declared `tests[]` through a real runtime** to prove its risk/policy classification. Accepted drafts land in the custom layer and are then governed by the same runtime — risk-classified, policy-gated, audited:

```bash
idel learn gh             # preview drafted verb-first gh commands from local help text
idel learn gh --write     # persist them to ~/.idel/registries/custom/learned-gh.json
learn gh                  # same alias inside `idel terminal` / the web terminal
learn.cli cli=gh          # IDEL-shaped terminal form with autocomplete
```

A learned def must clear **two** gates to be accepted: schema validation, and every declared test matching the runtime's actual classification (a schema-valid-but-misclassifying def is shown with its failures but not written). It is introspection-only (it never runs a real subcommand), draft-layer-only, and a learned destructive command is classified by the same two-phase safety engine as a hand-written one — so learning a tool weakens no guarantee. AI can improve draft quality later, including an on-device model, but the baseline learner does not require Claude.

---

## Using your Claude subscription

The AI console (`ask.ai prompt="..."`, `idel ask`, the `?` prefix in `idel terminal`, and the web **Ask Claude** mode) reaches Claude through one of two providers, picked automatically:

1. **Your Pro/Max subscription via the `claude` CLI** *(preferred — no API key)*. If [Claude Code](https://claude.com/claude-code) is installed and you've run `claude login`, IDEL shells out to `claude -p` using your subscription. IDEL **unsets `ANTHROPIC_API_KEY` in the spawned process**, so a stray key never silently bills per token.
2. **`ANTHROPIC_API_KEY` via the Anthropic SDK** *(fallback)* — for CI/servers without the CLI.

Precedence: `claude` CLI → API key → none. Force a provider with `IDEL_CLAUDE_PROVIDER=cli|api`. When neither is available, the console prints how to enable one.

The two providers differ only in transport — the runtime is the enforcement boundary in both. With the subscription CLI, Claude has no tools and cannot touch your filesystem: it replies with the IDEL command(s) to run, and IDEL parses → classifies → policy-checks → executes-or-refuses → audits each one, then feeds the outcome back (via `claude -p --resume`) so Claude can adapt. A CRITICAL command Claude proposes is blocked by the same floor that catches a human typo, and recorded as `source: "agent"`.

```bash
claude login            # once — authenticates the CLI to your subscription
idel ask "clean the build directory"   # Claude proposes IDEL; the runtime runs it
idel ask.ai prompt="clean the build directory"
```

---

## Architecture

The runtime is a single linear pipeline. Each command flows through it once:

```text
parse → resolve → coerce → safety (two-phase) → policy → plan → execute → OpenLogs
```

1. **parse** — turn `verb.scope param=value` into a typed AST (booleans become real booleans; `! cmd` becomes a native AST).
2. **resolve** — find the command definition in the registry (`custom > official > core`).
3. **coerce** — apply the schema: type-check params, fill defaults, reject unknowns (with the narrow `extraArgs` exception).
4. **safety** — two passes: an AST/string pass and a resolved-real-path pass. Effective risk is the **max** of the two.
5. **policy** — map risk + match criteria to an action: allow / warn / require_dry_run / approval_required / block.
6. **plan** — pick the first available adapter and build a real `argv` from the declarative spec.
7. **execute** — run the plan (or simulate it for dry-run / block).
8. **OpenLogs** — append one redacted JSONL record describing everything that happened.

### Packages

| Package | Responsibility |
| --- | --- |
| `packages/parser` | Tokenize and parse IDEL into a typed `CommandAst` / `NativeCommandAst`. |
| `packages/types` | The shared contract every package depends on — the source of truth for all types. |
| `packages/registry` | Load, validate (fail-closed), and resolve command defs across the three layers; schema-driven param coercion. |
| `packages/safety` | Deterministic risk classification — the two-phase engine, native scanner, and non-overridable floors. |
| `packages/policy` | First-match-wins rule evaluation with the CRITICAL hard floor; YAML-subset + JSON policy loading. |
| `packages/adapters-posix` | POSIX adapter (`spawn`, `shell:false`) plus the in-process `@node` fs adapter. |
| `packages/adapters-powershell` | Windows PowerShell adapter. |
| `packages/openlogs` | Signed, hash-chained audit writer (OpenLogs v2) with secret redaction. |
| `packages/runtime` | Orchestrates the whole pipeline; handles native passthrough, approval, meta commands, and outcome assembly. |
| `packages/server` | A dependency-free local HTTP+SSE boundary over the runtime (`idel serve`). Backs the web/desktop (Javelle) terminal; every request still flows through the full safety/policy/OpenLogs pipeline. |
| `packages/agent` | The embedded Claude console: exposes IDEL to Claude as a small tool surface, plus `idel learn` (CLI → IDEL draft). The only package that depends on `@anthropic-ai/sdk`; the key lives in the host process, never the browser. |
| `packages/web` | The dependency-free static web terminal + landing page (no build step). Served by `idel serve --static`. |
| `packages/cli` | The `idel` executable, flag parsing, rendering, completion, the interactive terminal, `idel ask`, `idel learn`, and `idel serve`. |

The core command definitions live in `registries/core/*.json` (filesystem, permissions, archive, find, path/env, meta).

---

## Two-phase safety

Safety runs **twice**, and this is the load-bearing design decision.

- **AST phase** (`assessAst`) — cheap, string-level. Normalizes the target path (expand `~`, resolve, collapse `..`) *without touching the filesystem* and applies the deterministic rules.
- **Resolved phase** (`assessResolved`) — runs immediately before execution, against live filesystem state. It does the real `fs.realpath`, follows symlinks, and (for destructive ops) estimates the blast radius with a capped directory walk.

The effective risk is `MAX(ast, resolved)`. This is what catches the case the command string hides:

```text
idel remove.folder name=dist        # looks like deleting a local folder…
                                    # …but if dist is a symlink to /, the
                                    # resolved phase classifies it as CRITICAL.
```

**CRITICAL short-circuits.** If the AST phase already returns CRITICAL, the resolved phase is skipped entirely. CRITICAL is terminal (nothing is higher, and the resolved pass can only escalate), so there is no reason to walk `/` just to count files for a command that is about to be blocked. The block decision must never depend on traversing the very target it refuses to touch.

There is an acknowledged TOCTOU window between the resolved assessment and execution; the runtime takes the higher of the two phases but cannot defend against a path swapped for a symlink-to-root *after* the check. See [docs/safety-rules.md](docs/safety-rules.md) for the full model, the finding codes, and the non-overridable floor list.

---

## Two precedence systems, pointing opposite ways

This is the subtlety worth internalizing:

- **Registry content resolves `custom > official > core`.** A team's custom definition shadows the official one, which shadows the bundled core one. Overrides are visible via `explain.registry`.
- **Core safety floors resolve `core > everything`.** They are non-overridable. A custom registry, a lax policy file, and `--yes` are all powerless against them: a CRITICAL classification cannot be cleared.

The policy engine is where this is enforced. If a rule matches a CRITICAL command with `allow`, `warn`, or `require_dry_run`, the engine **rewrites the action to `block`** and records why. The only sanctioned escape is an explicit `approval_required` rule — a deliberate, logged team exception — never a silent downgrade.

---

## Risk levels & policy actions

| Risk | Examples | Default action |
| --- | --- | --- |
| **LOW** | `read.file`, `list.folder`, `show.path` | allow |
| **MEDIUM** | `move.file`, `extract.archive` into an existing folder | allow |
| **HIGH** | `remove.folder recursive=true`, recursive `set.folder.permission` | require_dry_run |
| **CRITICAL** | root/home delete, raw-device write, recursive `777` on a broad tree | block |

Policy actions: `allow`, `warn`, `require_dry_run`, `approval_required`, `block`.

The **default policy** (used when no `--policy` file is given) is:

```text
1. risk == CRITICAL   -> block
2. risk == HIGH       -> require_dry_run
3. source == native   -> warn
4. (everything else)   -> allow
```

Rules are **first-match-wins** — ordering in the file is how you express priority, not "most specific wins."

---

## Native passthrough

Native commands keep developers productive without becoming an unlogged hole. Use `! cmd` or `native.run`:

```bash
idel ! tar -xvzf backup.tar.gz
idel native.run command="find . -name '*.js' -mtime -7"
```

For inspecting logs or other text files, use `tail.file`:

```bash
idel tail.file file=app.log lines=50
```

For normal non-interactive scripts, prefer `run.script` so the script path gets
IDEL path completion and the interpreter choice is explicit:

```bash
idel run.script path=./scripts/deploy.sh shell=bash
idel run.script path=./scripts/check.js shell=node args="--fix src"
idel run.script path="scripts\\deploy.bat" shell=cmd
```

For editing, use the first-class interactive editor command from a local TTY:

```bash
idel open.editor file=README.md editor=nano
idel open.editor file=src/index.ts editor=code wait=true
idel editor README.md
```

Other interactive TTY programs (`less`, `top`, long-running TUIs) are still not
general-purpose web/runtime commands. They need broader PTY/session management;
`open.editor` is the scoped editor path that is allowed only from local
interactive CLI contexts.

Native passthrough is:

- **Risk-scanned** by a deterministic pattern scanner (no AI) for known catastrophe shapes — `rm -rf /`, `dd of=/dev/sd*`, `mkfs`, recursive `chmod 777` on root, fork bombs, `curl | sh`, Windows drive-root deletes.
- **Logged** as `source=native` with the exact command line (after secret redaction).
- **Disableable** with `--no-native` for CI and production, where the passthrough is blocked outright.

A clean scan is not a safety guarantee — it only means none of the listed patterns matched.

---

## OpenLogs

Every command produces exactly one record at `~/.idel/logs/openlogs.jsonl`, written through [`@nextera.one/openlogs-sdk`](https://github.com/nextera-one/openlogs) (**OpenLogs v2**). Each record is:

- **TPS-stamped** — a [TPS Reality String](https://github.com/nextera-one/tps) encodes the event time.
- **Hash-chained** — SHA-256-linked to its predecessor, so the log is tamper-*evident*: break a link (edit, reorder, or delete a record) and verification flags the exact index.
- **Ed25519-signed** — signed with a machine-local key (`~/.idel/keys/openlogs.key.json`, generated on first use, `0600`), so each record proves who recorded it.

The chain can be verified programmatically via `OpenLogWriter.verify()`, which returns the SDK's structured result (`integrity`, `signatures`, `trust`). The log remains append-only.

**Secret redaction runs _before_ signing** (the signed payload is immutable, so secrets must never enter it), and is two-pronged:

- **By key name** — values under keys like `password`, `token`, `api_key`, `secret`, `auth`, `private_key` are redacted regardless of shape.
- **By value shape** — JWTs, `sk-…` keys, AWS access key IDs, GitHub PATs, and long opaque tokens are redacted no matter what key they sit under.

Anything redacted is replaced with `***REDACTED***`. A policy block is logged as a normal (signed) audit event (`result: blocked_before_execution`), not a runtime failure.

> **Note:** the signed-logging path depends on an ESM fix to `@nextera.one/tps-standard` that is not yet on npm; this repo vendors it via a pnpm override. See [CONCERNS.md](CONCERNS.md) §1.

---

## CLI flags

| Flag | Effect |
| --- | --- |
| `--dry-run` | Plan and classify, but never touch the filesystem. |
| `--ci` | Non-interactive; approval-required commands fail closed. |
| `--no-native` | Disable native passthrough (blocks `! cmd` / `native.run`). |
| `--yes` | Auto-approve approval-required prompts — **cannot clear CRITICAL.** |
| `--json` | Machine-readable output (risk, findings, decision, result). |
| `--policy <file>` | Load a policy file (`.yml` or `.json`). |
| `--env <name>` | Logical environment for policy matching (e.g. `production`). |

---

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | success or dry_run |
| `1` | failed |
| `3` | approval_required |
| `4` | blocked_before_execution |

These let CI fail closed: a blocked or approval-required command never returns `0`.

---

## Testing

```bash
pnpm test           # vitest run — 300 tests across 15 test files
pnpm typecheck      # tsc --build --dry
```

Coverage spans the parser (quoting/booleans/paths), registry schema validation, the safety engine (root/home/device/symlink/empty-target/glob cases), policy evaluation (all five actions plus the CRITICAL floor), POSIX and PowerShell plan snapshots, OpenLogs redaction, end-to-end runtime flows (including the OpenLogs-append-failure warning), the agent loop on **both** providers — the API/SDK path (multi-turn tool use, max-steps cap, tool-error recovery, API-error handling, per-call approval gate) and the subscription/`claude`-CLI path (a fake spawn driving multi-round plans, block enforcement, real-run approval, non-JSON fallback) — provider selection precedence, `idel learn` (fail-closed validation, hostile-name rejection, and test round-tripping through a real runtime), and the HTTP server (static serving, traversal guard, registry-id validation, injected-agent SSE, and the real-run approval round-trip). Destructive tests run only in temp directories.

---

## V1 scope vs. V2 deferred

**Built in V1:** IDEL parser; core registry schema + ~31 commands (filesystem, permissions, archive, find/search, path/env, scripts, editor, native, meta); two-phase safety engine; policy engine; native passthrough with a deterministic scanner; OpenLogs with redaction; POSIX, PowerShell, and Node adapters; registry-driven autocomplete; CLI and interactive terminal.

**Explicitly deferred to V2 (not built):**

- **AI translation** (`native.convert`) — draft-only, behind review/tests/signing. (Note: **CLI learning** now ships as `idel learn <cli>` — see above. Promoting a learned draft to the signed `official` layer is the remaining V2 piece.)
- Full **Git / Docker / Kubernetes** registries (many of those commands are already readable — or learnable via `idel learn`).
- A **registry marketplace** (needs signing, trust, review, versioning, reputation).
- **Remote / cloud execution** (comes after local safety and logs are proven).

---

## Further reading

- [docs/safety-rules.md](docs/safety-rules.md) — the two-phase safety engine, every finding code, the non-overridable floors, and the native scanner patterns.
- [docs/registry-schema.md](docs/registry-schema.md) — the `CommandDef` shape, the structured `AdapterArgSpec` union, the three layers, the `semanticNotes` honesty principle, and how to add a custom command.
