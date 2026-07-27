export const VERSION = "1.2.0";

export const HELP_TEXT = `idel ${VERSION} — universal client for IDEL World

USAGE
  idel <verb.scope> [key=value ...] [flags]
  idel "<cmd.one ... && cmd.two ...>"  run an IDEL batch; stop on first non-success
  idel run <workflow.idel>             validate, compile, and govern a workflow
  idel <workflow.idel>                 short form for running an IDEL workflow
  idel ! <native command>              native passthrough (risk-scanned + logged)
  idel ask "<natural language>"        ask AI to do it (proposes IDEL, runs via the runtime)
  idel ask.ai prompt="<request>"       IDEL-shaped alias for the AI console
  idel learn <cli> [--write]           teach IDEL an installed CLI (drafts IDEL commands from its --help)
  learn <cli>                          same command inside \`idel terminal\`
  idel promote <cli> [--yes]           promote learned drafts to the signed official layer (re-verify + sign)
  idel registry verify                 check signatures on the official registry layer (fail-closed)
  idel editor <file>                   open a file in your local editor (TTY only)
  idel terminal                        interactive IDEL terminal (readline REPL; \`? <ask>\` for AI)
  idel connect <server-url>            connect this terminal to a remote IDEL server
  idel serve [--port N] [--static D]   start the local web/desktop terminal server
  idel init                           create a minimal IDEL package
  idel new application <name>         create a universal IDEL application
  idel validate [--file <file>]       validate IDEL Structure or package files
  idel format [--file <file>]         format IDEL Structure deterministically
  idel compile [--file <file>]        compile IDEL Structure to canonical CBOR
  idel resolve                        resolve package dependencies to idel.lock
  idel add <coordinate>               add pkg:, git+, or idel:// dependency
  idel remove <dependency>            remove a direct project dependency
  idel outdated                       list dependencies requiring adapter checks
  idel why <dependency>               explain why a dependency is present
  idel repository list                list repository providers
  idel repository add <name>          add a repository provider
  idel repository remove <name>       remove a repository provider
  idel repository verify              validate repository declarations
  idel permissions                    show declared package permissions
  idel pack                           create a deterministic .idelb bundle
  idel lock init|verify               create or verify idel.lock
  idel install [--immutable]           resolve, fetch, and verify packages
  idel verify                          verify lock consistency and cached bytes
  idel completion <partial>            print autocomplete suggestions
  idel help | version

EXAMPLES
  idel create.file name=readme.md
  idel tail.file file=app.log lines=50
  idel 'create.file name=a.txt && wait.time ms=500 && read.file name=a.txt'
  idel remove.folder name=dist recursive=true --dry-run
  idel run.script path=./scripts/deploy.sh shell=bash
  idel run.script path=./scripts/check.js shell=node args="--fix src"
  idel open.editor file=README.md editor=nano
  idel editor README.md
  idel check.policy
  idel explain.registry command=remove.folder
  idel list.history
  idel list.logs
  idel ! tar -xvzf backup.tar.gz
  idel ask "delete the dist folder"          (uses the configured AI provider; --yes to allow real runs)
  idel ask.ai prompt="delete the dist folder"
  idel learn gh --write                      (drafts IDEL commands for the gh CLI into the custom layer)
  learn.cli cli=git
  idel promote gh                            (review + sign gh drafts into the official layer)
  idel registry verify                       (verify every signed official command)
  ssh -L 8787:127.0.0.1:7878 user@host       (safe remote access tunnel)
  idel connect http://127.0.0.1:8787         (use IDEL through that tunnel)
  idel validate --manifest ./package.idel --json
  idel pack --output ./dist/release.idelb
  idel lock verify --immutable
  idel install --registry https://packages.idel.world
  idel install --immutable --offline
  idel new application customer-portal
  idel run intents/release.idel
  # inside \`idel terminal\`, for workflow.idel:
  run.workflow.idel
  run.workflow
  idel add pkg:npm/vue@3.5.17
  idel add git+https://github.com/nextera/custom-adapter.git#<commit>
  idel repository add npmjs --kind npm --endpoint https://registry.npmjs.org
  idel compile --file project.idel

ASK AI
  The AI console (ask.ai, idel ask, \`?\` in terminal, the web "Ask AI") reaches
  the currently supported Claude provider via — in order — the installed \`claude\` CLI (your Pro/Max SUBSCRIPTION;
  run \`claude login\` once), else ANTHROPIC_API_KEY (pay-per-token API). Force one
  with IDEL_CLAUDE_PROVIDER=cli|api.
  Provider roadmap: ChatGPT/OpenAI, Gemini, Microsoft Copilot, Perplexity,
  Mistral, Grok, and Llama/local models.

FLAGS
  --dry-run        plan + classify, never touch the filesystem
  --ci             non-interactive; approval-required commands fail closed
  --no-native      disable native passthrough (CI/production)
  --yes            auto-approve approval-required prompts (cannot clear CRITICAL)
  --json           machine-readable output
  --policy <file>  load a policy file (.yml or .json)
  --env <name>     logical environment for policy matching (e.g. production)
  --manifest <file> package manifest (default: ./package.idel)
  --output <file>   bundle output path
  --lockfile <file> lockfile path (default: ./idel.lock)
  --immutable       require manifest/lock consistency
  --offline         use only verified cached artifacts
  --registry <url>  registry origin (default: https://packages.idel.world)
  --cache <dir>     content-addressed package cache
  --file <file>     IDEL Structure/project/repository source
  --kind <kind>     repository kind for \`repository add\`
  --endpoint <url>  repository endpoint for \`repository add\`
  --adapter <pkg>   repository adapter package (or builtin)
  --repository <id> repository reference for \`add\`
  --purpose <name>  dependency purpose for \`add\` (default: runtime)
  --force           replace files created by init or lock init

SERVE FLAGS (idel serve)
  --port <n>       HTTP port (default 7878)
  --host <addr>    bind address (default 127.0.0.1, loopback only)
  --static <dir>   serve a built terminal UI from this directory at /
  --enable-native-terminal
                   enable native shell sessions and web native passthrough

SAFETY
  Every command is risk-classified (LOW/MEDIUM/HIGH/CRITICAL) and policy-checked
  before execution, then recorded to ~/.idel/logs/openlogs.jsonl. CRITICAL
  targets (root/home delete, device writes, recursive 777 on broad trees) are
  blocked by default and cannot be cleared with --yes alone.
`;
