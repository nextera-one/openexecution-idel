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

## 2. Runtime swallows OpenLogs write failures (silent)

`packages/runtime/src/runtime.ts` (~line 507):

```ts
await this.logWriter.append(record).catch(() => undefined);
```

The comment says "Logging must never sink a command." That is a defensible
product stance — but it **silently hid a real bug** during this work: a
`prev_hash must be a string or null` throw on machines with a pre-existing
(legacy, unsigned) log meant *no record was written at all*, and the demo still
printed BLOCKED. The append bug is now fixed (see §3), but the swallow remains.

**Consider:** keep swallowing, but surface a one-time `stderr` warning when an
append fails (e.g. "openlogs: failed to record this command — audit trail may be
incomplete"). An accountability layer that silently stops recording is worse
than one that complains. Worth a follow-up.

## 3. Legacy (pre-signing) log records are ignored, not migrated

A log file written by the old plain-JSONL writer has records with no
`entry`/`hash`. The new writer:
- **skips** them in `read()` and `verify()` (they aren't signed, can't be
  verified), and
- starts a **fresh signed chain** on top of them (so `append` no longer throws).

This is handled and tested, but it means: after upgrade, `idel logs.list` stops
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
But `package.json` `engines` says `node >=20`, while the signed-logging path is
only fully exercised on **>=22.3**. Either bump `engines` to `>=22.3`, or add a
`createRequire(import.meta.url)` fallback in tps-standard's `env.ts` for full
Node-20 ESM support.

## 5. OpenLogs key management is local-only

`~/.idel/keys/openlogs.key.json` is generated on first use, `0600`. There is:
- **no rotation** (one key forever),
- **no trust registry** (the writer signs with its own key; `verify()` checks
  integrity + signature presence, but full *trust* verification — actor binding
  to a known key — is not wired into `logs.*` yet), and
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

Deferred (next phases, not yet started):
- **Phase 2** — adversarial safety hardening (TOCTOU between the two-phase scan
  and execution, Windows/UNC path normalization, `~` expansion, glob target
  estimation, redaction-bypass shapes).
- **Phase 3** — V2 `native.learn` draft-only flow (behind the safety engine,
  disabled by default).
