# CONCERNS — open items to resolve

Captured 2026-06-09. These are known caveats from the OpenLogs-v2 signed-logging
integration and packaging work. Nothing here blocks the build or tests (all 192
pass, smoke test passes), but each needs attention before calling V1 "done" or
shipping to a clean machine. Ordered roughly by priority.

---

## 1. ⚠️ BLOCKING for clean-machine install: publish `@nextera.one/tps-standard@0.8.1`

The published `tps-standard` (0.7.x / 0.8.0) **cannot be imported as native ESM**
(extensionless imports + `typeof require` Node detection). That breaks
`@nextera.one/openlogs-sdk`, which IDEL's OpenLogs layer now depends on.

The fix is **nextera-one/tps PR #2** (branch `fix/esm-node-compat`, version
bumped to **0.8.1**). It is **not yet published to npm** — the automation
environment is not authenticated to npm.

**Until 0.8.1 is on npm, this repo pins the fix via a pnpm override that points
at a vendored tarball:**

```jsonc
// package.json
"pnpm": {
  "overrides": {
    "@nextera.one/tps-standard": "file:./vendor/nextera.one-tps-standard-0.8.1.tgz"
  }
}
```

The tarball is committed under `vendor/`. This makes `pnpm install`, the build,
the tests, and CI fully reproducible **without** waiting on the publish.

**To resolve:**
1. Merge nextera-one/tps PR #2.
2. `cd tps && npm run build && npm run bundle && npm publish --access public` (0.8.1).
3. In this repo: remove the `pnpm.overrides` block and the `vendor/` tarball,
   set `@nextera.one/tps-standard` to `^0.8.1` in `packages/openlogs/package.json`,
   run `pnpm install`, re-run `pnpm test && pnpm smoke`, commit.
4. Only then is `npm install -g @openexecution/cli` viable from a clean machine
   (also requires un-setting `"private": true` on the packages you publish).

## 2. Runtime swallows OpenLogs write failures (silent) — FIXED

`packages/runtime/src/runtime.ts`: the runtime still never lets a failed append
sink a command (the product stance), but it no longer fails *silently*. The
first append failure per runtime instance now writes a one-time warning to
stderr:

```
openlogs: failed to record this command — audit trail may be incomplete (<detail>)
```

Subsequent failures in the same process are not re-warned (no log spam). Covered
by a runtime test that injects a failing writer and asserts (a) the command still
succeeds and (b) exactly one warning is emitted across two failed appends.

## 3. Legacy (pre-signing) log records are ignored, not migrated

A log file written by the old plain-JSONL writer has records with no
`entry`/`hash`. The new writer:
- **skips** them in `read()` and `verify()` (they aren't signed, can't be
  verified), and
- starts a **fresh signed chain** on top of them (so `append` no longer throws).

This is handled and tested, but it means: after upgrade, `idel list.logs` stops
showing pre-upgrade entries, and `verify()` only covers records written since the
upgrade. If preserving the old entries matters, write a one-shot migration that
re-wraps legacy records into signed v2 records (note: their hashes/signatures
would be newly minted, so they'd attest "imported at T", not original integrity).

## 4. ESM on Node 20–22.2 degrades zlib / TPS-native-crypto

The tps-standard ESM fix loads Node builtins via `process.getBuiltinModule`,
added in **Node 22.3**. On the ESM build running Node 20–22.2, `zlib` and
`node:crypto` are `null`, so compressed TPS-UID and TPS's own Ed25519 helpers
degrade. Impact on IDEL is small: `randomBytes` still works (Web Crypto), and the
OpenLogs **signing** uses `@noble/ed25519` (pure JS, no Node builtin), not TPS's.

**Resolved (the honest option):** `package.json` `engines` is now `>=22.3`, so
the declared floor matches the version the signed-logging path is actually
exercised on. (The alternative — a `createRequire` fallback in tps-standard's
`env.ts` for full Node-20 ESM support — remains open upstream if Node-20 support
is ever required.)

## 5. OpenLogs key management is local-only

`~/.idel/keys/openlogs.key.json` is generated on first use, `0600`. There is:
- **no rotation** (one key forever),
- **no trust registry** (the writer signs with its own key; `verify()` checks
  integrity + signature presence, but full *trust* verification — actor binding
  to a known key — is not wired into `list.logs` / `show.logs` yet), and
- **no protection** beyond file permissions (no OS keychain / HSM).

This is fine for the local V1 story but is the seam where the team/CI story (a
managed `KeyRegistry`, signed policies) will need real design. The SDK supports
`trustedKeys` / `KeyRegistry`; we just don't use them yet.

## 6. TPS records use a placeholder location (`L:-`)

A local CLI has no meaningful coordinate, so each record's TPS string carries the
SDK's placeholder location. Time is encoded correctly (Gregorian). If/when
location matters (e.g. per-host/per-datacenter audit), thread a configurable
location through `OpenLogWriter`.

## 7. `pnpm deploy` doesn't work here (informational)

`pnpm deploy` (the canonical "self-contained artifact" tool) errored in this
pnpm 10.0.0 setup (`ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE`, and a 254 with the
`file:` override). Packaging therefore uses `scripts/install-local.sh`
(`pnpm build` + `npm link`) as the supported V1 install, plus
`scripts/smoke-test.sh`. Revisit `pnpm deploy` once §1 removes the tarball
override.

---

## 8. Windows cross-platform bugs found by CI (FIXED)

The new Windows CI leg immediately caught two pre-existing, platform-specific
**test** bugs (production code was correct), now fixed:

- `registry.test.ts` used `import.meta.url.replace("file://","")` (invalid
  `/D:/...` path on Windows) and a hardcoded `/` separator → now uses
  `fileURLToPath` + `path.join`.
- `safety.test.ts` asserted `root-delete` for `name=/`, but `/` normalizes to a
  drive root on Windows (`drive-root-delete`) → now accepts either CRITICAL
  root-class finding.

Both legs (Linux + Windows) are green. Worth a wider audit for other
POSIX-only assumptions in tests (path separators, `~`, `file://` munging) as
part of Phase 2.

---

## Status of the larger plan (for context)

Done: OpenLogs-v2 signed-chain swap (with tamper/chain-hole/cross-instance tests),
packaging scripts + smoke test, CI (Linux + Windows).

Done: **Phase 2** — adversarial safety hardening (commit `a246ad6`). Closed the four
real gaps an audit surfaced; the fifth (`~` expansion) was found safe by defensive
over-flagging, so no change:
- **Windows/UNC normalization** — `paths.ts` now resolves Windows-rooted targets
  with `path.win32` semantics regardless of host, strips `\\?\`/`\\.\` prefixes, and
  trims NTFS trailing dots/spaces, so `C:\`, `\\?\C:\`, UNC shares, and drive-relative
  `C:foo` are classified instead of joined under cwd. (Caveat: the IDEL parser treats
  an unquoted `\` as a shell escape, so Windows paths must be **quoted** —
  `name="C:\Windows"` — to reach the classifier with backslashes intact; the server
  API and GUI pass quoted strings, so this is covered there.)
- **Glob blast-radius** — a wildcard target walks its static prefix for a lower-bound
  `affectedPathsEstimate` (`glob-estimate`) or emits `glob-unbounded`.
- **`requiresAffectedPathEstimate` enforcement** — the formerly-dead flag now fails
  closed (escalate to ≥ HIGH when no estimate); also fixed a latent bug where a
  runtime-escalated level/findings weren't surfaced in the outcome.
- **Secret redaction** — targeted URL-userinfo / query-token / Authorization-header /
  case-insensitive-AWS passes + `policyReason` scrubbing, without lowering the generic
  threshold.
- **TOCTOU** — destructive ops `lstat` the leaf immediately before the syscall and
  refuse (fail-closed) if it is a symlink, defeating a check→swap→use window.

Done: **Phase 3 (first cut)** — `idel learn <cli>`: introspect an installed
CLI's `--help`, draft IDEL `CommandDef`s with Claude, and validate each through
the registry's own `checkCommandDef` (fail-closed). Three safety rails hold:
introspection-only (never executes a real subcommand — only `<cli> --help`),
draft layer only (`source: "custom"`, written to `~/.idel/registries/custom/`),
and fail-closed validation (an invalid def never reaches disk). Learned commands
are re-classified by the same two-phase safety engine, so learning a destructive
tool weakens no floor. Hostile CLI names are rejected before any spawn. Preview
is the default; `--write` persists. Covered by `packages/agent/src/learn.test.ts`.

Done: **`idel learn` test round-tripping** — the model now emits a `tests[]`
array per def (`{ input, expectRisk?, expectPolicy? }`), and `learnCli` REPLAYS
each test through a real runtime (ephemeral, learned defs as a custom layer, all
dry-run) to PROVE the classification. A def is accepted only if it is
schema-valid AND every declared test matches the runtime's actual risk/policy; a
schema-valid-but-misclassifying def is shown with its failures but NOT written.
The verifier is injected (CLI wires the runtime-backed one) so the agent package
stays runtime-free. Covered by the verification suite in `learn.test.ts`
(including an end-to-end replay through a real runtime).

Done: **Web terminal + landing page** — `packages/web` ships a dependency-free
static UI (no build step): `index.html` (the "all about it" landing page) and
`terminal.html` (a live terminal with IDEL mode, an embedded **Ask Claude**
console over `/api/agent/stream`, registry-driven completion, history, and a live
audit-log panel). Served by `idel serve --static packages/web/public`
(`pnpm ui` / `scripts/run-ui.sh`). The Claude console only lights up when
`ANTHROPIC_API_KEY` is set server-side; the key never reaches the browser.

Done: **Web real-run approval flow** — the hosted agent is no longer
propose-only. When the client sends `allowReal: true`, the agent gets an approval
gate that round-trips to the browser: before a real run it emits an
`approval_request` SSE event (with an `approvalId` + the dry-run outcome) and
PARKS server-side until the client POSTs `/api/agent/approve { approvalId,
approve }` on the same stream. A `PendingApprovals` coordinator owns the parked
promises, arms a 5-minute fail-closed timeout, denies on client disconnect (per
stream, not globally), and releases all on shutdown. The agent only touches disk
on an explicit human "Approve" click; the Anthropic key still never leaves the
server. The agent's `ask()` now takes a per-call gate that overrides the
constructor gate (the CLI keeps its readline gate; the server injects the HTTP
one). Covered by the approval round-trip suite in `server.test.ts` + per-call
gate tests in `agent.test.ts`.

Done: **Claude subscription (claude CLI) provider** — the embedded console no
longer requires a pay-per-token `ANTHROPIC_API_KEY`. A `ClaudeProvider`
abstraction (`packages/agent/src/provider.ts`) decouples the agent loop from auth;
`ClaudeCliProvider` shells out to the installed `claude` CLI in headless JSON mode
(`claude -p --output-format json --tools "" --append-system-prompt … [--resume]`)
using the user's Pro/Max login. Because the CLI returns a final text answer (no
tool protocol), the system prompt asks Claude to reply with a JSON plan
(`{ commands, explanation, done }`); `IdelCliAgent` runs each command through the
same `service.run(origin:"agent")` pipeline (dry-run first, real only on
approval), then feeds outcomes back via `--resume`. Selection
(`select.ts#detectProvider`) prefers the CLI, falls back to the API key, and is
overridable with `IDEL_CLAUDE_PROVIDER=cli|api`. The CLI provider **unsets
ANTHROPIC_API_KEY in the spawned child** so a stray key never silently bills per
token (the CLI's own precedence puts the key above the subscription). Wired into
`idel ask`, the REPL `?`, and `idel serve` (web). Covered by `cli-agent.test.ts`
(fake spawn) + `select.test.ts`.

Done: **Translated-command preview + sensitive confirm** — every rendered
outcome now shows what the IDEL command translates to on this platform (the real
adapter argv, e.g. `remove.file … force=true` → `rm -f x`; the `@node` adapter
uses its `describe`). `idel terminal` classifies a command as a dry run first to
build the preview, then: blocks stay blocked; `require_dry_run` (the HIGH
default) is shown as dry-run-only and never silently promoted; allow/
approval_required sensitive commands are previewed and held for a y/N confirm
before a real run. Also fixed a pre-existing REPL hazard the preview exposed: the
readline `line` handler now drains a queue serially (so a confirm answer can't
race the in-flight command) and distinguishes `exit` from stdin-EOF (so piped
input fully drains and no `ERR_USE_AFTER_CLOSE` fires). The web terminal shows
the same "translates to" line.

Deferred (next):
- **Phase 3 (rest)** — promote a learned draft to the `official` layer behind
  review/signing; let `idel learn` propose `powershell` adapters too.
- Multi-turn web conversations (today each `ask` is a fresh turn); persisting the
  agent message history across SSE connections behind the approval coordinator.
- Wire the runtime's `onApproval` to an interactive prompt in `idel terminal` so
  `approval_required` commands prompt in the REPL (today they fall to `--yes`).
- Stream the CLI provider's tokens live (`stream-json`) instead of awaiting the
  full `claude -p` result, for snappier REPL/web output.
