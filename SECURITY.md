# Security

## Supported boundary

`idel serve` is a local execution service. It refuses non-loopback bind hosts,
validates `Host` and browser `Origin`, and requires a high-entropy bearer for
every API except `/api/health`. The same-origin terminal receives a generated
token only in its no-store boot document. API-only and SSH-tunneled clients must
set `IDEL_SERVER_AUTH_TOKEN` and send `Authorization: Bearer …`.

Cross-origin loopback access is off by default. `--cors` is an explicit
development option and still requires the bearer. Do not place the service
behind a public reverse proxy; use a purpose-built remote execution boundary
with independent identity, authorization, and isolation instead.

Direct command approvals are opaque, single-use, five-minute capabilities bound
server-side to the exact command, cwd, and API origin that was reviewed. Client
`approve` and `origin` fields are not trusted. CRITICAL safety floors remain
non-overridable.

## Native shell warning

Raw native shell sessions bypass IDEL parsing and command-level policy. They are
disabled by default in the CLI, web launcher, Electron launchers, and VS Code
extension. Enable `--enable-native-terminal` only when an interactive OS shell
is required. Session lifecycle is audited, but raw terminal input is not logged
because it may contain passwords and control sequences. Native lifecycle audit
append failures are best-effort: every failure warns and increments persistent
in-process degraded status, exposed by health and the setup checklist. This
does not provide the structured runtime’s fail-closed audit guarantee.

## Files, archives, and logs

- Destructive filesystem operations perform resolved-path and symlink checks.
- Archive extraction lists entries first and rejects traversal, absolute paths,
  control characters, and symbolic/hard links before invoking the adapter.
- OpenLogs redacts secrets before signing and verifies signatures, hash-chain
  integrity, and a local continuity checkpoint.
- OpenLogs assurance is local-development only; it is not externally anchored.
  A production deployment needs independently administered verifier keys and a
  remote append-only head anchor or transparency service.

## Reporting a vulnerability

Do not include live credentials, private logs, or exploit targets in a public
issue. Use [private vulnerability reporting](https://github.com/nextera-one/openexecution-idel/security/advisories/new). Include
the affected version, platform, minimal reproduction, expected boundary, and
observed impact. Rotate any credential that may have appeared in a report.
