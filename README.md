# OpenExecution Runtime & IDEL Terminal

**Policy-controlled execution for developers and AI agents.** Inspect proposed commands, enforce execution policy, and retain signed audit records on your own machine.

IDEL is an intent language (`verb.scope param=value`). The OpenExecution Runtime parses it, resolves it through a versioned command registry, classifies its risk, enforces policy, plans a platform-specific execution, runs it through an OS adapter, and records every decision to an append-only audit log. The CLI is `idel`.

The first pilot asks whether these controls help with project setup, controlled cleanup, and AI-assisted changes. [Try the three practice workflows](https://openexecution-idel.digital-pages.chatgpt.site/idel/pilot) or read the [pilot plan](docs/pilot/facilitator.md). Policy checks are not operating-system isolation.

---

Desktop preview installers are published in [GitHub Releases](https://github.com/nextera-one/openexecution-idel/releases). Windows x64, macOS Intel/Apple Silicon, and Linux x64 packages include the runtime. Read the signing status and installation limitations in each preview's release notes.

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
- [Using Ask AI](#using-ask-ai)
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

Other useful commands: `idel list.registry` (59 core commands), `idel check.policy`, `idel terminal` (interactive REPL), `idel completion <partial>`.

Web terminal scrollback commands are local to the active terminal tab:
`clear.all`, `clear.last limit=10`, `clear.first limit=5`, and
`clear.range from=2 to=8`. They remove visible rows only; they do not delete
OpenLogs records or command history.

The web terminal also includes a command palette, setup checklist, and local
workflows. Use `save.workflow name=setup command="cmd.one && cmd.two"`,
`list.workflows`, `run.workflow name=setup`, or the Workflows panel to save and
reuse repeatable batches.

Curated package-manager commands are included for common OS package flows:
`search.apt.package`, `show.apt.package`, `install.apt.package`,
`search.brew.package`, `install.brew.package`, `search.winget.package`, and
`install.winget.package`. Install/remove/update commands are HIGH risk, so the
default policy dry-runs them first.

Batch execution uses shell-like `&&` at the IDEL host layer:

```bash
idel 'create.file name=a.txt && write.file name=a.txt content="ready" && read.file name=a.txt'
idel 'run.script path=./scripts/start.sh shell=bash && wait.time seconds=2 && tail.file file=app.log lines=20'
```

Each step is parsed, classified, policy-checked, executed, and logged as its own command. The next step starts only after the previous step completes successfully. During an explicit `--dry-run`, dry-run steps are allowed to continue so you can preview a whole batch. A line beginning with `!` remains native passthrough, so `! cmd1 && cmd2` keeps normal shell semantics inside the IDEL terminal. From Bash, quote the whole IDEL line: `idel '! cmd1 && cmd2'`.

**Web / desktop terminal.** `idel serve` starts a local HTTP+SSE server (loopback, port 7878 by default) that exposes the same runtime — registry-driven autocomplete, risk/policy classification, and signed OpenLogs — over a small JSON API. It is the boundary the browser and Electron desktop terminal talk to; pass `--static <dir>` to also serve a built UI. All non-health API routes require a high-entropy bearer, and browser origins must match the server by default. A command typed in the GUI is audited identically to one typed at the CLI.

A ready-made, dependency-free web terminal + landing page ships in `packages/web/public`. The fastest way to see it:

```bash
pnpm build
pnpm ui            # opens the terminal at http://127.0.0.1:7878
# (equivalently: idel serve --static packages/web/public)
```

The same-origin terminal boot page receives a generated, in-memory bearer and
is served with `Cache-Control: no-store`; the token is never printed or exposed
by an API. For API-only, SSH-tunneled, or cross-origin development clients, set
`IDEL_SERVER_AUTH_TOKEN` to a private 32–256 character base64url value and send
`Authorization: Bearer …`. Cross-origin loopback access additionally requires
the explicit `--cors` development flag.

An API-only `idel serve` (without `--static`) requires
`IDEL_SERVER_AUTH_TOKEN`; there is no boot page in which to deliver a generated
secret safely.

Build standalone desktop installers (no system Node or source checkout required):

```bash
pnpm desktop:package:linux    # AppImage + DEB, Linux x64
pnpm desktop:package:windows  # NSIS setup EXE, build on Windows
pnpm desktop:package:macos    # DMG for Apple Silicon + Intel, build on macOS
```

The desktop app starts in `Documents/IDEL`. Use the **Workspace…** button to
select another folder. Native shell mode remains disabled by default. Release
builds are currently candidates until platform testing and signing are complete.
See [release instructions](docs/releasing.md).

For development, build repo-backed Electron launchers:


```bash
pnpm desktop:build          # all Electron launchers under dist/desktop/
pnpm desktop:build:linux    # dist/desktop/linux/openexecution-idel.sh
pnpm desktop:build:macos    # dist/desktop/macos/OpenExecution IDEL.app
pnpm desktop:build:windows  # dist/desktop/windows/OpenExecution IDEL.cmd/.ps1
```

These are repo-backed Electron launchers around the same `idel serve` boundary
and bundled web UI, not signed installers. They require this checkout and the
local Electron dev dependency to remain available on the desktop machine. Set
`IDEL_DESKTOP_PORT=9000` to choose another port, or `IDEL_ELECTRON_BIN=/path`
to use a specific Electron executable.

The VS Code extension lives in `packages/vscode-extension`. It contributes an
`IDEL` activity-bar view and an `IDEL: Open Terminal` command, starts or reuses
the same local `idel serve` process, and embeds `/terminal.html` inside a VS Code
webview. Build the repo first with `pnpm build`, then open the extension folder
in VS Code's Extension Development Host, or install it locally with
`scripts/install-vscode-extension.sh`,
`scripts/install-vscode-extension-macos.command`, or
`scripts\install-vscode-extension.bat`. Remove it with the matching
`scripts/uninstall-vscode-extension.sh`,
`scripts/uninstall-vscode-extension-macos.command`, or
`scripts\uninstall-vscode-extension.bat`.
If VS Code reports `spawn node ENOENT`, re-run the installer from a shell where
`node` works or set `openexecutionIdel.nodePath` to the full Node executable
path.

Upgrade dependencies to the latest published versions:

```bash
pnpm upgrade:latest       # npx npm-check-updates -u, pnpm install, pnpm audit --fix update, build, test
pnpm upgrade:latest:npm   # same flow using npm install and npm audit fix
```

Pass npm-check-updates options after `--`, for example
`pnpm upgrade:latest -- --target minor`. The pnpm path is the default because
the workspace declares `packageManager: pnpm`.

The page at `/` explains the runtime; `/terminal.html` is a live terminal with an **IDEL** mode (registry completion, history, a live audit-log panel), an **Ask AI** mode that drives the embedded console over `/api/agent/stream`, and optional `sh` tabs for a native OS shell. Ask AI can use Claude Code, the Anthropic API, the OpenAI Responses API, or the Google Gemini API on the `idel serve` process (see [Using Ask AI](#using-ask-ai)) — keys entered in setup are sent to the authenticated local server and retained only for that server session.

Use IDEL tabs for the audited policy pipeline. Use a native `sh` tab only when you need interactive OS behavior such as `sudo apt install git`, package prompts, shell autocomplete, Ctrl+C, arrows, or full-screen terminal tools. Native shell tabs are backed by xterm.js and are intentionally direct shell sessions, so commands typed there are not converted into IDEL commands or risk-scanned command-by-command. Native mode is disabled by default in the CLI, web launcher, desktop launchers, and VS Code extension. When explicitly enabled with `--enable-native-terminal`, session start/close/signal/exit lifecycle events are still written to signed OpenLogs and every native request uses the same authenticated API boundary. Native cwd values remain inside the configured server workspace and clients may select only an explicitly allowed shell.

Every command rendered in the terminal — typed or AI-proposed — shows what it **translates to**: the real adapter invocation (e.g. `remove.file name=x force=true` → `rm -f x`, `list.folder` → `ls`), so the mapping from intent to execution is visible at the call site. In the interactive `idel terminal`, a sensitive (HIGH/CRITICAL) command is previewed with its translation and risk and held for confirmation before any real run (and a `require_dry_run`-policy command is shown as dry-run-only, never silently promoted).

The web console executes typed commands according to policy. With the default policy, LOW/MEDIUM commands run when submitted, HIGH commands are dry-run only, and CRITICAL commands are blocked. Direct **Approve / Decline** buttons appear when the selected policy requires approval; they are not a universal confirmation step. Those approvals are opaque, single-use capabilities bound server-side to the exact proposed command, cwd, and API origin; client-supplied `approve` or `origin` fields are ignored. Ask AI real-run proposals use a separate approval gate and wait for the user's decision. Interactive editor commands such as `open.editor` remain CLI/TTY-only; web/API/CI requests return a non-interactive failure.

**Teach IDEL an installed CLI.** `idel learn <cli>` introspects a CLI's own `--help`, drafts conservative IDEL command definitions locally, validates each against the registry schema (fail-closed), and **replays each def's declared `tests[]` through a real runtime** to prove its risk/policy classification. Accepted drafts land in the custom layer and are then governed by the same runtime — risk-classified, policy-gated, audited:

```bash
idel learn gh             # preview drafted verb-first gh commands from local help text
idel learn gh --write     # persist them to ~/.idel/registries/custom/learned-gh.json
learn gh                  # same alias inside `idel terminal` / the web terminal
learn.cli cli=gh          # IDEL-shaped terminal form with autocomplete
```

A learned def must clear **two** gates to be accepted: schema validation, and every declared test matching the runtime's actual classification (a schema-valid-but-misclassifying def is shown with its failures but not written). It is introspection-only (it never runs a real subcommand), draft-layer-only, and a learned destructive command is classified by the same two-phase safety engine as a hand-written one — so learning a tool weakens no guarantee. AI can improve draft quality later, including an on-device model, but the baseline learner does not require Claude.

Promote reviewed drafts with `idel promote gh`. This emits a v2 development
signature and prints its `kid` and public key, but does **not** trust them. To
make an explicit local-development pin, independently check those values and
create `~/.idel/trust/registry-keys.json`:

```json
{
  "trustStoreVersion": 1,
  "keys": [
    {
      "kid": "key:registry-development:<printed-id>",
      "publicKeyHex": "<64 hex characters printed by promote>"
    }
  ]
}
```

Then run `idel registry verify`. Set `IDEL_REGISTRY_TRUST_STORE` to an absolute
team-managed trust-store path when pins are provisioned separately. Never copy
a key from an untrusted `.sig.json`; v2 manifests intentionally contain no key,
and v1 self-anchored manifests must be re-promoted.

---

## Using Ask AI

The AI console (`ask.ai prompt="..."`, `idel ask`, the `?` prefix in `idel terminal`, and the web **Ask AI** mode) supports four host-side providers:

1. **Your Pro/Max subscription via the `claude` CLI** *(preferred — no API key)*. If [Claude Code](https://claude.com/claude-code) is installed and you've run `claude login`, IDEL shells out to `claude -p` using your subscription. IDEL **unsets `ANTHROPIC_API_KEY` in the spawned process**, so a stray key never silently bills per token.
2. **`ANTHROPIC_API_KEY` via the Anthropic SDK** *(fallback)* — for CI/servers without the CLI.
3. **`OPENAI_API_KEY` via the OpenAI Responses API.** Override the default model with `IDEL_OPENAI_MODEL`.
4. **`GEMINI_API_KEY` via the Google Gemini API.** `GOOGLE_API_KEY` is also accepted; override the default model with `IDEL_GEMINI_MODEL`.

Automatic precedence is Claude Code → Anthropic → OpenAI → Gemini. Select the default with `IDEL_AI_PROVIDER=cli|api|openai|gemini`; the older `IDEL_CLAUDE_PROVIDER=cli|api` remains compatible. The web/Electron provider picker can switch between every provider configured at server startup. When none is available, the console prints how to enable one.

Provider roadmap: Microsoft Copilot, Perplexity, Mistral, Grok, and Llama/local models.

The providers differ only in transport — the runtime remains the enforcement boundary. Each model returns structured IDEL proposals; IDEL parses → classifies → policy-checks → executes-or-refuses → audits each one, then feeds the outcome back so the model can adapt. A CRITICAL command proposed by any model is blocked by the same floor that catches a human typo and is recorded as `source: "agent"`.

```bash
claude login            # once — authenticates the current Claude provider
export OPENAI_API_KEY=...   # or ANTHROPIC_API_KEY / GEMINI_API_KEY
export IDEL_AI_PROVIDER=openai
idel ask "clean the build directory"   # AI proposes IDEL; the runtime runs it
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
| `packages/server` | A dependency-free local HTTP+SSE boundary over the runtime (`idel serve`). Backs the web/Electron desktop terminal; every request still flows through the full safety/policy/OpenLogs pipeline. |
| `packages/agent` | The embedded AI console: connects Claude Code, Anthropic, OpenAI, or Gemini to a constrained IDEL proposal surface, plus `idel learn` (CLI → IDEL draft). API keys live in the host process, never the browser. |
| `packages/web` | The dependency-free static web terminal + landing page (no build step). Served by `idel serve --static`. |
| `packages/vscode-extension` | VS Code extension that embeds the same `/terminal.html` UI in a webview and starts/reuses the local `idel serve` boundary. |
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

Interactive OS work belongs in a native shell tab in the web terminal, or in a
local terminal. Native shell tabs are direct OS sessions for prompts, Ctrl+C,
Tab, and arrows. Their lifecycle events are recorded in OpenLogs; raw terminal
input is not recorded. Native audit append failures are reported in setup and
health status and do not block the native shell. Use `open.editor` for the scoped editor path in local interactive CLI
contexts.

Native passthrough is:

- **Risk-scanned** by a deterministic pattern scanner (no AI) for known catastrophe shapes — `rm -rf /`, `dd of=/dev/sd*`, `mkfs`, recursive `chmod 777` on root, fork bombs, `curl | sh`, Windows drive-root deletes.
- **Logged** as `source=native` with the exact command line (after secret redaction).
- **Disableable** with `--no-native` for CI and production, where the passthrough is blocked outright.

A clean scan is not a safety guarantee — it only means none of the listed patterns matched.

---

## OpenLogs

Every successfully audited command produces one record at `~/.idel/logs/openlogs.jsonl`, written through [`@nextera.one/openlogs-sdk`](https://github.com/nextera-one/openlogs) (**OpenLogs v2**). Audit append failure stops the workflow by default with `AuditAppendError`; an explicit `warn-and-continue` mode reports every missed record. Each persisted record is:

- **TPS-stamped** — a [TPS Reality String](https://github.com/nextera-one/tps) encodes the event time.
- **Hash-chained and continuity-checked** — SHA-256-linked to its predecessor, with a separate durable checkpoint binding the expected key, record count, and chain head. Corruption, tail truncation, reset, and missing continuity evidence fail closed.
- **Ed25519-signed** — signed with a machine-local development key (`~/.idel/keys/openlogs.key.json`, generated on first use, `0600`). Verifier trust comes from a separate public configuration, never from the signing private-key file.

The chain can be verified programmatically via `OpenLogWriter.verify()`, which returns the SDK's structured result (`integrity`, `signatures`, `trust`) plus `continuity` and an explicit assurance label. Local self-pinning can be disabled in favor of pre-provisioned `trustedKeys`.

This is still **local-development evidence, not external anchoring**. Verification returns `externalAnchoring: false`; a principal able to replace the log, public trust file, and continuity checkpoint together can rewrite history. Production accountability requires an independently administered trust root and a remote append-only head anchor or transparency service.

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
pnpm test           # Vitest suite (586 passing, 1 skipped across 28 test files)
pnpm typecheck      # full TypeScript project build/type-check
pnpm check:web      # static UI syntax, CSP hygiene, duplicate-id, and button checks
pnpm check:package  # bundled OpenLogs package + self-contained CLI deploy artifact
```

Coverage spans the parser (quoting/booleans/paths), registry schema validation, the safety engine (root/home/device/symlink/empty-target/glob cases), policy evaluation (all five actions plus the CRITICAL floor), POSIX and PowerShell plan snapshots, OpenLogs redaction, end-to-end runtime flows (including the OpenLogs-append-failure warning), the agent loop on **both** providers — the API/SDK path (multi-turn tool use, max-steps cap, tool-error recovery, API-error handling, per-call approval gate) and the subscription/`claude`-CLI path (a fake spawn driving multi-round plans, block enforcement, real-run approval, non-JSON fallback) — provider selection precedence, `idel learn` (fail-closed validation, hostile-name rejection, and test round-tripping through a real runtime), and the HTTP server (static serving, traversal guard, registry-id validation, injected-agent SSE, and the real-run approval round-trip). Destructive tests run only in temp directories.

---

## V1 scope vs. V2 deferred

**Built in V1:** IDEL parser; core registry schema + 70+ commands (filesystem, permissions, archive, find/search, path/env, scripts, editor, native, meta); two-phase safety engine; policy engine; native passthrough with a deterministic scanner; OpenLogs with redaction; POSIX, PowerShell, and Node adapters; registry-driven autocomplete; CLI and interactive terminal.

**Explicitly deferred to V2 (not built):**

- **AI translation** (`native.convert`) — draft-only, behind review/tests/signing. (Note: **CLI learning** ships as `idel learn <cli>`, and **promotion** of a learned draft to the **signed `official` layer** now ships as `idel promote <cli>` — re-verifies schema + replays `tests[]`, then creates a v2 Ed25519 envelope binding command bytes, key identity, and promotion provenance. The development signer is **not trusted automatically**: `idel registry verify` and runtime loading accept only keys pinned independently in `~/.idel/trust/registry-keys.json` or `IDEL_REGISTRY_TRUST_STORE`, and reject legacy v1 self-anchored manifests. Production key custody, rotation/revocation, and authenticated cross-machine trust-store distribution remain deferred.)
- Full **Git / Docker / Kubernetes** registries (many of those commands are already readable — or learnable via `idel learn`).
- A **registry marketplace** (needs signing, trust, review, versioning, reputation).
- **Remote / cloud execution** (comes after local safety and logs are proven).

---

## Further reading

- [Security model and reporting](SECURITY.md) — local API, approval, native-shell, archive, and OpenLogs trust boundaries.
- [Safety rules](docs/safety-rules.md) — the two-phase engine, finding codes, non-overridable floors, and native scanner patterns.
- [Registry schema](docs/registry-schema.md) — `CommandDef`, adapter argument specs, resolution layers, and custom commands.
