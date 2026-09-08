# CONCERNS — open items to resolve

Reviewed 2026-08-22. These are known caveats from the OpenLogs-v2 signed-logging
integration and packaging work. Nothing here blocks the current 572-test suite
or smoke test, but each needs attention before calling V1 "done" or
shipping to a clean machine. Ordered roughly by priority.

---

## 1. TPS publishing and clean-install verification

`@nextera.one/tps-standard@0.8.1` is not yet on npm. The committed vendored
ESM fix and OpenLogs SDK remain bundled together inside `@openexecution/openlogs`, so the published
manifest does not leak a repository-relative file dependency. Do not remove
this workaround until the fixed upstream package is published and verified.

The package check now executes the deployed CLI and exercises the staged runtime,
web assets, authenticated API, and signed logging outside the checkout. Desktop
packaging uses a hoisted, materialized dependency tree to avoid pnpm store links.
A clean npm consumer install remains a separate release gate. The workspace root
should remain private; public library and CLI manifests already have public access.

---

## 2. Runtime audit append failures — FAIL-CLOSED BY DEFAULT

`packages/runtime/src/runtime.ts` now throws `AuditAppendError` whenever a
configured OpenLogs writer cannot persist the command outcome. A host can opt
into `auditFailureMode: "warn-and-continue"`, but that availability-first mode
prints a warning for **every** missed record; it never becomes silent after the
first failure. Fail-closed runtimes latch the first error, so later `run()`
calls stop before execution even if a caller catches the original exception.

The outcome record is written after execution, so an append failure does not
roll back an OS side effect. `AuditAppendError` therefore carries the intended
record and warns callers not to retry the command blindly. A stronger future
transaction protocol would need an auditable pre-execution intent plus durable
completion/recovery semantics.

## 3. Legacy (pre-signing) log records are ignored, not migrated

A log file written by the old plain-JSONL writer has records with no
`entry`/`hash`. The new writer may still skip them for unverified display via
`read()`, but strict verification and append reject malformed/legacy lines. It
also refuses to adopt any populated chain lacking a continuity checkpoint
unless the caller explicitly enables `allowUnanchoredLegacyAdoption`. A
migration must validate and preserve the old material deliberately; newly
minted signatures could only attest "imported at T", not original integrity.

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

`~/.idel/keys/openlogs.key.json` is generated on first use, `0600`. Verification
no longer derives trust from that private-key file. Public verifier trust is
separate, and a durable `0600` continuity checkpoint binds the expected `kid`,
public key, record count, and chain head. Writes use the append lock, fsync, and
atomic state replacement; truncation, reset, missing state/trust, malformed
tails, and key replacement fail closed. There is still:

- **no rotation** (one key forever),
- **only local trust pinning by default** (production callers can supply
  `trustedKeys` and disable local self-pinning, but there is no managed team/CI
  trust registry or out-of-band key distribution),
- **no external/remote chain-head anchor**, and
- **no protection** beyond file permissions (no OS keychain / HSM).

Results explicitly report `signing: "local-development"` and
`externalAnchoring: false`. A principal able to replace the log, trust file,
and checkpoint together can still forge history. Production evidence still
needs independently administered verifier keys, key rotation/revocation, and a
remote append-only head anchor or transparency service.

## 6. TPS records use a placeholder location (`L:-`)

A local CLI has no meaningful coordinate, so each record's TPS string carries the
SDK's placeholder location. Time is encoded correctly (Gregorian). If/when
location matters (e.g. per-host/per-datacenter audit), thread a configurable
location through `OpenLogWriter`.

## 7. `pnpm deploy` packaging (FIXED with legacy deploy)

The shared-lockfile deploy path cannot copy the repository-relative TPS override
into its temporary workspace. `pnpm-workspace.yaml` now enables injected
workspace packages and explicitly selects pnpm's legacy deploy implementation,
which creates a self-contained CLI artifact while resolving the committed TPS
tarball from the real workspace. `pnpm check:package` packs OpenLogs, verifies
the bundled ESM dependency, deploys the CLI to a temporary directory, and checks
both runtime entrypoints. Remove `forceLegacyDeploy` after §1 moves TPS to npm.

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
  `C:foo` are classified instead of joined under cwd. Quoted Windows paths are still
  the recommended human CLI form (`name="C:\Windows"`), but the parser preserves
  quoted backslashes and the server/API path passes them through directly.
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
`terminal.html` (a live terminal with IDEL mode, an embedded **Ask AI**
console over `/api/agent/stream`, registry-driven completion, history, and a live
audit-log panel). Served by `idel serve --static packages/web/public`
(`pnpm ui` / `scripts/run-ui.sh`). The AI console only lights up when
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
approval_required commands are previewed before any real run. `approval_required`
uses the runtime's interactive approval prompt in `idel terminal`, while
non-policy-sensitive commands use a single y/N confirm. Also fixed a pre-existing
REPL hazard the preview exposed: the
readline `line` handler now drains a queue serially (so a confirm answer can't
race the in-flight command) and distinguishes `exit` from stdin-EOF (so piped
input fully drains and no `ERR_USE_AFTER_CLOSE` fires). The web terminal shows
the same "translates to" line.

Done: **Native terminal lifecycle audit** — raw web `sh` tabs remain direct shell
sessions and are not parsed command-by-command, but enabling them now requires
`--enable-native-terminal` and writes signed OpenLogs lifecycle records for
`native.terminal.start`, `native.terminal.close`, `native.terminal.signal`, and
`native.terminal.exit`. Raw stdin is intentionally not logged because it can
contain passwords, prompts, and terminal control streams.

Done: **Phase 3 — promote a learned draft to the signed `official` layer**
(`idel promote <cli>`). Promotion is the deliberate, gated step from the
lowest-trust *custom* draft layer to the trusted *official* layer:
- **Re-verify, don't trust the past** — every draft is re-validated against the
  schema AND its declared `tests[]` are REPLAYED through a real runtime at
  promote time (not relying on the earlier learn run). A def that no longer
  validates or misclassifies is rejected, never promoted (fail-closed).
- **Explicit review gate** — the eligible set is shown with its risk and gated
  behind an interactive y/N (`--yes` for CI; a non-interactive JSON promote
  without `--yes` is refused). Nothing is signed without confirmation.
- **Ed25519 v2 envelopes** — each confirmed def is signed with a separate,
  explicitly development-only key over a domain-separated canonical envelope.
  The envelope binds the complete command bytes, digest/version, signing `kid`,
  and `promotedBy`/`promotedAt`/`promotedFrom`/signing-mode provenance. Defs go to
  `~/.idel/registries/official/promoted-<cli>.json` + a detached
  `promoted-<cli>.sig.json` manifest; the promoted ids are pruned from the
  custom draft so a command lives in one writable layer.
- **Pinned trust, never self-authentication** — manifests contain no public key.
  `idel registry verify` accepts signers only from the independently managed
  `~/.idel/trust/registry-keys.json` (or `IDEL_REGISTRY_TRUST_STORE`) pin set and
  fails closed on missing/wrong/ambiguous pins, metadata/content tamper, unsigned
  definitions, and legacy v1 self-anchored manifests. Promotion prints the
  development public key but deliberately does not add it to that trust store.
- **Load-time gate** — the CLI verifies the official layer before trusting it;
  if ANY def fails, the WHOLE official layer is dropped (not partially honored)
  with a stderr warning, so a bad def can't be smuggled in beside good ones.
- Promotion raises *trust/provenance*, never *privilege*: a promoted destructive
  command is re-classified by the same two-phase safety engine on every run.
- Honest scope: local promotion is a development signing workflow. Trust exists
  only after the operator/team pins that key through an independent channel;
  production key custody, rotation/revocation, and signed trust-store
  distribution remain future gates. Covered by `registry/src/signing.test.ts`
  and `cli/src/promote.test.ts`, including attacker self-signing, wrong/missing
  pins, provenance tamper, and explicit v1 migration rejection.

Deferred (next):
- **Phase 3 (rest)** — production key custody plus rotation/revocation and
  authenticated trust-store/signed-policy distribution across machines; let
  `idel learn` propose `powershell` adapters too.
- Multi-turn web conversations (today each `ask` is a fresh turn); persisting the
  agent message history across SSE connections behind the approval coordinator.
- Stream the CLI provider's tokens live (`stream-json`) instead of awaiting the
  full `claude -p` result, for snappier REPL/web output.
