# IDEL 1.1.0 Preview 1

Standalone desktop installers for Windows x64, macOS Intel/Apple Silicon, and Linux x64. Electron and the IDEL runtime are included; no system Node, pnpm, or source checkout is required.

## Preview status

This is a developer preview, not the stable release. Installers are unsigned; macOS is not notarized and Gatekeeper may refuse launch. Windows may show an unknown-publisher warning. Manual clean-machine installation, window launch, workspace switching, restart, and uninstall checks remain before stable release. There is no automatic updater; install later releases manually.

## Install

- Windows: download the x64 Setup EXE and run the per-user installer.
- macOS: select arm64 for Apple Silicon or x64 for Intel; open the DMG and drag OpenExecution IDEL to Applications. The underlying Electron 42 runtime requires macOS 12 or later. Platform signing is still pending.
- Linux: use the DEB on Debian/Ubuntu, or make the AppImage executable and launch it. AppImage requires compatible FUSE support and a system that permits Electron's sandbox. Use the DEB where the AppImage sandbox cannot initialize; do not disable sandboxing. Linux ARM64 is not included.

Compare each file's SHA-256 with SHA256SUMS.txt before installing. The desktop workspace defaults to Documents/IDEL and can be changed from the application menu. Audit records remain in ~/.idel. AI configuration is optional.

## Changes

- Ship a self-contained desktop runtime, core registry, web terminal, and production dependencies.
- Bundle the web UI with the CLI and add `idel ui`.
- Fix clean npm installation of the OpenLogs/TPS dependency graph.
- Isolate independent AI requests so their conversation histories do not leak into each other.
- Report persistent native lifecycle audit degradation in health/setup status.
- Accept real workspace aliases on macOS/Windows while rejecting filesystem escapes.
- Classify POSIX and Windows path shapes consistently and stop immediately after identifying a forbidden resolved root.

## Verification

Built from commit 00448d0e0632219d996500e58ca50f2a3da7a43e. All six CI jobs passed on Linux, macOS, and Windows with Node 22/24. Four native installer jobs passed, including checks of each packaged runtime using Electron's bundled Node. These checks start the authenticated local UI/API, run a benign command, load the registry, and verify signed audit records. The local suite passed 586 tests with one platform-specific skip. Clean npm consumer installation and execution passed.

CI: https://github.com/nextera-one/openexecution-idel/actions/runs/34194120871
Installer provenance: https://github.com/nextera-one/openexecution-idel/actions/runs/34194117193
Electron 42 platform requirements: https://github.com/electron/electron/blob/v42.4.1/README.md#platform-support

## Boundaries

IDEL executes on your own machine. The service binds to loopback and must not be exposed as a public command-execution server. Native shell access is disabled in the packaged app. IDEL policy controls are not OS/container isolation. The structured runtime fails closed on audit errors; optional native lifecycle logging is best-effort and reports degradation. AI providers process submitted prompts when configured. npm publication is separate and has not been performed for this release.
