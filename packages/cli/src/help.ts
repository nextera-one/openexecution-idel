export const VERSION = "1.1.0";

export const HELP_TEXT = `idel ${VERSION} — OpenExecution Runtime CLI

USAGE
  idel <verb.scope> [key=value ...] [flags]
  idel ! "<native command>"            native passthrough (risk-scanned + logged)
  idel ask "<natural language>"        ask Claude to do it (proposes IDEL, runs via the runtime)
  idel terminal                        interactive IDEL terminal (readline REPL; \`? <ask>\` for Claude)
  idel serve [--port N] [--static D]   start the local web/desktop terminal server
  idel completion <partial>            print autocomplete suggestions
  idel help | version

EXAMPLES
  idel create.file name=readme.md
  idel remove.folder name=dist recursive=true --dry-run
  idel policy.check
  idel registry.explain command=remove.folder
  idel logs.list
  idel ! "tar -xvzf backup.tar.gz"
  idel ask "delete the dist folder"          (requires ANTHROPIC_API_KEY; --yes to allow real runs)

FLAGS
  --dry-run        plan + classify, never touch the filesystem
  --ci             non-interactive; approval-required commands fail closed
  --no-native      disable native passthrough (CI/production)
  --yes            auto-approve approval-required prompts (cannot clear CRITICAL)
  --json           machine-readable output
  --policy <file>  load a policy file (.yml or .json)
  --env <name>     logical environment for policy matching (e.g. production)

SERVE FLAGS (idel serve)
  --port <n>       HTTP port (default 7878)
  --host <addr>    bind address (default 127.0.0.1, loopback only)
  --static <dir>   serve a built terminal UI from this directory at /

SAFETY
  Every command is risk-classified (LOW/MEDIUM/HIGH/CRITICAL) and policy-checked
  before execution, then recorded to ~/.idel/logs/openlogs.jsonl. CRITICAL
  targets (root/home delete, device writes, recursive 777 on broad trees) are
  blocked by default and cannot be cleared with --yes alone.
`;
