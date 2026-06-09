#!/usr/bin/env bash
#
# smoke-test.sh — prove a freshly built `idel` actually works end to end.
#
# Runs the binary the way a user would (no test runner, no source imports) and
# asserts the load-bearing V1 behaviors from the spec's "Definition of Live":
#   1. `idel --version` prints a version.
#   2. The thesis demo (`remove.folder name=/ ...`) is BLOCKED (exit code 4) and
#      changes nothing.
#   3. A harmless command succeeds (exit 0).
#   4. Every command produced a *signed* OpenLogs record and the chain verifies.
#
# Writes its log/keys under an isolated temp HOME so it never touches the real
# `~/.idel`. Exits non-zero on the first failed assertion.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IDEL="$ROOT/packages/cli/bin/idel.js"

if [[ ! -f "$IDEL" ]]; then
  echo "smoke: CLI not built ($IDEL missing). Run 'pnpm build' first." >&2
  exit 1
fi

# Isolated sandbox HOME so OpenLogs writes here, not to the real ~/.idel.
SANDBOX="$(mktemp -d)"
trap 'rm -rf "$SANDBOX"' EXIT
export HOME="$SANDBOX"

run() { node "$IDEL" "$@"; }

fail() { echo "smoke: FAIL — $1" >&2; exit 1; }

echo "smoke: HOME=$SANDBOX"

# 1) --version
VERSION="$(run --version || true)"
[[ "$VERSION" == idel* ]] || fail "--version did not print a version (got: '$VERSION')"
echo "smoke: ✓ $VERSION"

# 2) thesis demo must BLOCK with exit code 4 and change nothing.
set +e
run remove.folder name=/ recursive=true force=true >"$SANDBOX/demo.out" 2>&1
CODE=$?
set -e
[[ $CODE -eq 4 ]] || fail "thesis demo exit code was $CODE, expected 4 (BLOCK)"
grep -q "CRITICAL" "$SANDBOX/demo.out" || fail "thesis demo did not classify CRITICAL"
grep -qi "BLOCK" "$SANDBOX/demo.out" || fail "thesis demo was not BLOCKED"
echo "smoke: ✓ remove.folder name=/ → CRITICAL → BLOCKED (exit 4)"

# 3) a harmless command succeeds.
set +e
run path.current >"$SANDBOX/ok.out" 2>&1
OKCODE=$?
set -e
[[ $OKCODE -eq 0 ]] || fail "path.current exit code was $OKCODE, expected 0"
echo "smoke: ✓ path.current → exit 0"

# 4) the OpenLogs chain must contain signed records and verify clean.
IDEL_ROOT="$ROOT" node -e '
import("file://" + process.env.IDEL_ROOT + "/packages/openlogs/dist/index.js").then(async ({ OpenLogWriter }) => {
  const w = new OpenLogWriter();
  const v = await w.verify();
  if (v.records < 2) { console.error("smoke: FAIL — expected >=2 signed records, got " + v.records); process.exit(1); }
  if (!v.ok || !v.integrity.ok || !v.signatures.ok) {
    console.error("smoke: FAIL — chain did not verify: " + JSON.stringify({ ok: v.ok, integrity: v.integrity.ok, sig: v.signatures.ok }));
    process.exit(1);
  }
  console.log("smoke: ✓ OpenLogs chain verified (" + v.records + " signed records, integrity+signatures OK)");
}).catch((e) => { console.error("smoke: FAIL — " + e.message); process.exit(1); });
'

echo "smoke: ALL CHECKS PASSED"
