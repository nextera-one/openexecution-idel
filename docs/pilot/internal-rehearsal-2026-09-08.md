# Internal engineering rehearsal — 8 September 2026

The published preview's bundled runtime and browser interface passed the two
non-AI pilot workflows. This is an automated engineering rehearsal, not a human
pilot session or evidence of clean-machine desktop installation.

## Package and method

- Release: `v1.1.0-preview.1`, source `00448d0e0632219d996500e58ca50f2a3da7a43e`.
- Download: `IDEL-1.1.0-linux-amd64.deb`, 101,461,616 bytes.
- SHA-256: `91b77b3216198eee13a5e1c3c76dbed2716e2157fcf4360a3faa9ef67abc44bd`;
  matched the public release manifest.
- Host: Ubuntu 26.04.1, x86-64. Extracted the DEB without installing it.
- Attempted the Electron window with Playwright 1.63.0 and Chromium sandboxing
  enabled. The extracted sandbox helper lacked installed ownership/permissions;
  a user-namespace fallback also failed. Administrator authentication was not
  available. The desktop window, native workspace picker, desktop restart,
  install, and uninstall remain **unverified**.
- Continued using the extracted package's Electron executable in Node mode to
  run its bundled CLI and web assets. No system Node was used by the runtime.
  Drove the actual interface in a fresh, sandbox-enabled Chrome context with
  Playwright. This is a browser-interface check, not an Electron-window pass.
- Used synthetic pilot fixtures, separate settings/cache, and a mount-isolated
  `.idel` directory for audit keys and records. No personal provider credentials
  were supplied. No live model requests were made.

The DEB contains an installation script and AppArmor profile for its installed
executable path. Extracting the archive does not apply that integration. An
installed-package test is still necessary; do not infer it will pass from this
inspection. Chromium documents the underlying Ubuntu restrictions in its
[sandbox guidance](https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md).

## Observed outcomes

| Check | Outcome |
| --- | --- |
| First-run setup | Runtime online; 78 registry commands loaded; AI correctly reported unconfigured. |
| Create project folder | Executed successfully through the command input. |
| Write and read README | Exact expected content: `IDEL pilot project`. |
| Recursive folder removal | HIGH risk, `require_dry_run`, `dry_run`; no deletion. |
| Move generated output | MEDIUM risk, executed; original absent, destination bytes unchanged. |
| Preserve practice files | `keep-me.txt` and `notes.txt` match the fixture byte for byte. |
| Audit list and Verify button | Seven records; interface reported `Verified · 7 records`. |
| Browser reload | Runtime remained online; seven records still verified. |
| New runtime process | Existing seven audit records remained verifiable. |
| Ask AI without credentials | Setup explains no provider is configured; live AI task unavailable. |
| Renderer JavaScript errors | None observed during the exercised flows. |

The six submissions after folder creation completed in 21–29 ms each from
automated Enter to the completed streaming HTTP response. These are local
automation measurements, not human task-completion or first-success times.
The initial automation mistakenly waited for `/api/run`; the UI uses
`/api/run/stream`. That harness timeout was corrected and is not an app failure.

## Corrections made after the rehearsal

1. Replaced welcome copy suggesting universal review-before-execution with the
   actual default-policy behavior and the separate Ask AI approval flow.
2. Renamed “Preview a write” to “Fill a write command”: the button fills the
   input; it does not execute a dry run.
3. Removed the inaccurate `aria-disabled` state from the actionable Ask AI setup
   button. Without a provider its accessible name is now “Set up Ask AI”. The
   original button opened setup by keyboard, but automation and assistive
   technology were told it was disabled.

Validated the corrected source interface against the same packaged backend:
normal accessible-button activation opened setup; the key control remained a
password input; filling a write command created no file; the seven audit records
still verified; no renderer errors occurred. Visually inspected the corrected
welcome screen at 1320 × 860. `check:web` and `git diff --check` passed.

These corrections are source changes for a subsequent release. The immutable
`v1.1.0-preview.1` installer still contains the original interface.

## Outstanding pilot evidence

- Install, launch, choose a workspace, quit/relaunch, and uninstall on clean
  Windows, macOS (both architectures), and Linux environments.
- A live AI session with a participant's configured provider, including proposal
  review, decline, approval, file verification, and audit verification.
- Actual sessions with all three audience groups. No invitations were sent and
  no participant results were entered in `session-results.csv`.

Keep the release labelled preview. Proceed with a small facilitated pilot using
the documented command behavior; record installation barriers and unavailable
AI separately from task failures.
