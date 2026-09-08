# Public release procedure

The source repository, desktop installers, npm packages, and website are separate
release surfaces. `idel serve` is local-only; never proxy it onto the public web.

## Desktop candidates

Run `pnpm install --frozen-lockfile`, then `pnpm desktop:package:linux`,
`pnpm desktop:package:windows`, or `pnpm desktop:package:macos` on the matching OS.
`desktop:prepare` builds and stages an independent runtime with a hoisted,
materialized dependency tree, registries, web assets, and an executable smoke test.
The app runs its service in Electron's Node utility process; it needs no system
Node installation. User files default to Documents/IDEL and logs remain in ~/.idel.

Run `node scripts/check-desktop.mjs` against each unpacked artifact. It invokes
the actual packaged Electron binary, starts the runtime using its bundled Node,
and checks authenticated UI/API access, a benign command, and signed logging.
On macOS run against each architecture on a matching runner. Also manually check
installation, window launch, workspace switching, restart, and uninstall on a
clean machine before declaring a stable release. Never advertise an untested OS.

The Desktop release candidates workflow builds and tests Linux x64, Windows x64,
macOS Intel, and macOS Apple Silicon. Its artifacts are unsigned candidates. It
does not create releases or enable website downloads. For stable Windows/macOS
releases configure platform signing credentials and macOS notarization with
electron-builder; never store signing material in source. Review the signed
artifact and run the checks again before publication.

Generate `idel.json` and `SHA256SUMS.txt` only from a directory containing the
approved installer set:

```sh
node scripts/release-manifest.mjs dist/installers v1.1.0-preview.1
```

Upload that exact set to the corresponding GitHub Release, together with checksums,
release notes, platform requirements, signing status, and known limitations.
After verifying anonymous asset URLs, copy idel.json to the website's
`public/releases/idel.json`, build, and deploy. Missing platforms remain unavailable.
Use immutable version-specific URLs. A null release intentionally disables downloads.

## CLI/npm

The root stays private. Fifteen workspace packages are publishable under
@openexecution. CLI prepack includes web assets; `idel ui` opens them locally.
The TPS dependency is vendored pending an upstream release. Both TPS and
OpenLogs SDK are bundled together so the SDK resolves the fixed TPS copy
in clean npm installations. Bundling TPS alone lets the SDK resolve broken
upstream 0.8.0 from the consumer root.
`pnpm check:package` starts and exercises the deployed runtime outside the checkout.
Before npm publication, pack the workspace packages and install them with npm in
a clean consumer directory. Confirm transitive registry resolution and signed logs.
Use an npm account with access to the @openexecution scope and the required 2FA
or trusted-publishing configuration. A dry-run is not a publication.

## Security and documentation

Scan full Git history and artifacts before the first public source release.
The initial history review found two synthetic redaction fixtures and three
minified xterm symbol matches; the exact fingerprints are documented in
.gitleaksignore. Do not add broad exclusions for credential-bearing paths.
Enable GitHub private vulnerability reporting. The native-shell lifecycle audit
is best-effort with persistent in-process degraded status; structured runtime
logging retains its fail-closed policy. Cross-platform and signing status must be
reported accurately in release notes.
