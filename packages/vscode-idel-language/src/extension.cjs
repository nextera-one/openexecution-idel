const vscode = require("vscode");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const DEBOUNCE_MS = 300;

/** Loaded lazily from lib/structure.mjs (bundled @openexecution/structure). */
let structure = null;
let structureLoadFailed = false;

async function loadStructure(context, output) {
  if (structure || structureLoadFailed) return structure;
  const bundled = path.join(context.extensionPath, "lib", "structure.mjs");
  try {
    structure = await import(pathToFileURL(bundled).href);
  } catch (error) {
    structureLoadFailed = true;
    output.appendLine(`[idel] parser bundle unavailable, diagnostics disabled: ${error.message}`);
  }
  return structure;
}

// --- documentation dictionaries ---------------------------------------------

const VERB_DOCS = {
  "define.function.action": "Reusable IDEL function that may change declared resources. Phase 1: composition-only.",
  "define.function.query": "Read-only IDEL function; may declare read effects only.",
  "define.function.workflow": "Coordinates other functions, invoked by digest; no direct resource effects.",
  "define.package.manifest": "Package metadata and exports (package.idel).",
  "define.config.profile": "Typed, non-secret configuration; secrets by reference only.",
  "define.policy.profile": "Admission and execution policy rules.",
  "define.schema.resource": "Typed field schema for a resource namespace.",
  "define.test.case": "Declarative test case (*.case.idel).",
  "define.run.request": "Signed execution request; requires replay protection.",
  "input.field": "Typed function input parameter.",
  "output.field": "Typed function output field.",
  "require.authority.capability": "Capability the actor must hold before admission.",
  "allow.effect.read": "Grants read access to one declared resource. Effects are a closed set.",
  "allow.effect.write": "Grants write access to one declared resource.",
  "allow.effect.append": "Grants append access (e.g. evidence logs).",
  "allow.effect.invoke": "Grants a workflow the right to invoke one function.",
  "limit.execution.resources": "Hard memory/cpu/timeout/retry ceilings for one execution.",
  "execute.step.query": "Composition step: IDEL-QL read.",
  "execute.step.insert": "Composition step: governed insert through a declared write effect.",
  "execute.step.guard": "Composition step: refuse execution unless a condition holds.",
  "execute.step.invoke": "Composition step: invoke another function, pinned to a digest.",
  "execute.step.evidence": "Composition step: append signed evidence.",
  "execute.step.return": "Composition step: bind output fields.",
  "protect.request.replay": "Replay protection: nonce + valid_until, covered by the request signature.",
  "configure.execution.target": "Which conforming runtime executes the request.",
  "authorize.publisher.namespace": "Publisher namespace and approval requirements.",
  "require.evidence.release": "Evidence artifacts a release must carry.",
  "export.function": "Exports a *.func.idel file from a package.",
  "bind.input.field": "Binds a value to a function input.",
  "bind.output.field": "Binds a step result to a function output.",
};

const VALUE_FUNCTION_DOCS = {
  semver: 'Semantic version, e.g. semver("1.0.0").',
  range: 'Version range, e.g. range(">=1.0.0 <2.0.0").',
  path: "Repository-relative file path.",
  uri: "Absolute URI.",
  duration: 'Time span, e.g. duration("5s").',
  bytes: 'Byte size, e.g. bytes("64mb").',
  cores: 'CPU allocation, e.g. cores("0.25").',
  secret: 'Secret reference, e.g. secret("secret://scope/name"). Never a literal value.',
  evidence: "Evidence destination or provider.",
  idelkey: "IDEL Key identity or authority reference.",
  idel: 'Function or package identity, e.g. idel("idel://org/pkg/fn@1.0.0").',
  digest: 'Immutable content digest, e.g. digest("sha256:…").',
  nonce: "Unique request nonce; consumed once.",
  timestamp: 'Absolute UTC instant, e.g. timestamp("2026-08-01T00:00:00Z").',
  capability: 'Named capability, e.g. capability("user.create").',
  entity: "Data entity within a declared resource.",
  field: "Field selector inside a query or step result.",
  input: "Reference to a declared function input.",
  step: 'Reference to a prior execute step, e.g. step("user").field("id").',
  dobase: "dobase resource locator.",
  spdx: "SPDX license identifier.",
  ref: "Reference to a fixture or document.",
  nexrun: "NexRun runtime locator.",
  empty: "True when a query or field has no rows/value.",
  equal: "Equality predicate.",
  refuse: "Named refusal raised when a guard fails.",
  ip: "Listener IP address.",
  endpoint: "Reference to a declared endpoint.",
  organization: "Organization identity reference.",
  package: "Package reference.",
  git: "Git source locator.",
  oci: "OCI image reference.",
};

const ENUM_TOKENS = [
  "function.query",
  "function.action",
  "function.workflow",
  "environment.production",
  "environment.staging",
  "environment.development",
  "evidence.required",
  "policy.refused",
  "effects.closed",
  "replay.protected",
  "mode.refused",
  "required",
  "forbidden",
  "true",
  "false",
];

const BLOCK_SNIPPETS = [
  {
    label: "define.function.action",
    detail: "Action function skeleton (Phase 1 composition-only)",
    body: [
      'define.function.action "${1:name}" {',
      '  identity = idel("idel://${2:org}/${3:package}/${1:name}")',
      '  version = semver("1.0.0")',
      "  mode = function.action",
      "",
      '  input.field.text "${4:input}" {',
      "    required = true",
      "  }",
      "",
      '  output.field.uuid "${5:output}" {',
      "    required = true",
      "  }",
      "",
      '  require.authority.capability "${6:capability}" {',
      '    scope = dobase("dobase://${7:scope}")',
      "  }",
      "",
      '  allow.effect.read "${8:resource}" {',
      '    resource = dobase("dobase://${7:scope}")',
      "  }",
      "",
      "  limit.execution.resources {",
      '    memory = bytes("64mb")',
      '    cpu = cores("0.25")',
      '    timeout = duration("5s")',
      "    maximum_retries = 0",
      "  }",
      "",
      '  execute.step.return "result" {',
      "    $0",
      "  }",
      "}",
    ],
  },
  {
    label: "protect.request.replay",
    detail: "Replay protection block (required in every run request)",
    body: [
      "protect.request.replay {",
      '  nonce = nonce("${1:uuid}")',
      '  valid_until = timestamp("${2:2026-01-01T00:00:00Z}")',
      "  single_use = true",
      "}",
    ],
  },
  {
    label: "limit.execution.resources",
    detail: "Resource ceiling block",
    body: [
      "limit.execution.resources {",
      '  memory = bytes("${1:64mb}")',
      '  cpu = cores("${2:0.25}")',
      '  timeout = duration("${3:5s}")',
      "  maximum_retries = ${4:0}",
      "}",
    ],
  },
];

// --- diagnostics -------------------------------------------------------------

function toRange(span) {
  return new vscode.Range(
    span.start.line - 1,
    span.start.column - 1,
    span.end.line - 1,
    span.end.column - 1,
  );
}

async function refreshDiagnostics(document, collection, context, output) {
  if (document.languageId !== "idel") return;
  if (!vscode.workspace.getConfiguration("idelLanguage").get("diagnostics", true)) {
    collection.delete(document.uri);
    return;
  }
  const parser = await loadStructure(context, output);
  if (!parser) return;
  const { diagnostics } = parser.checkStructure(document.getText());
  collection.set(
    document.uri,
    diagnostics.map((entry) => {
      const diagnostic = new vscode.Diagnostic(
        toRange(entry.span),
        entry.message,
        entry.severity === "error"
          ? vscode.DiagnosticSeverity.Error
          : vscode.DiagnosticSeverity.Warning,
      );
      diagnostic.source = "idel";
      return diagnostic;
    }),
  );
}

// --- completion --------------------------------------------------------------

function completionItems(document, position) {
  const line = document.lineAt(position.line).text.slice(0, position.character);
  const items = [];

  if (/=\s*[a-z0-9_.]*$/.test(line)) {
    for (const [name, doc] of Object.entries(VALUE_FUNCTION_DOCS)) {
      const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Function);
      item.insertText = new vscode.SnippetString(`${name}("$1")$0`);
      item.documentation = doc;
      items.push(item);
    }
    for (const token of ENUM_TOKENS) {
      items.push(new vscode.CompletionItem(token, vscode.CompletionItemKind.EnumMember));
    }
    return items;
  }

  if (/^\s*[a-z0-9_.]*$/.test(line)) {
    for (const snippet of BLOCK_SNIPPETS) {
      const item = new vscode.CompletionItem(snippet.label, vscode.CompletionItemKind.Snippet);
      item.detail = snippet.detail;
      item.insertText = new vscode.SnippetString(snippet.body.join("\n"));
      items.push(item);
    }
    for (const [verb, doc] of Object.entries(VERB_DOCS)) {
      const item = new vscode.CompletionItem(verb, vscode.CompletionItemKind.Keyword);
      item.documentation = doc;
      item.insertText = new vscode.SnippetString(`${verb} "\${1:name}" {\n  $0\n}`);
      items.push(item);
    }
  }
  return items;
}

// --- hover -------------------------------------------------------------------

function hoverFor(document, position) {
  const range = document.getWordRangeAtPosition(position, /[a-z_][a-z0-9_.]*/);
  if (!range) return null;
  const word = document.getText(range);
  if (VERB_DOCS[word]) {
    return new vscode.Hover(new vscode.MarkdownString(`**${word}** — ${VERB_DOCS[word]}`), range);
  }
  const prefix = Object.keys(VERB_DOCS).find((verb) => word.startsWith(`${verb}.`));
  if (prefix) {
    return new vscode.Hover(
      new vscode.MarkdownString(`**${prefix}** — ${VERB_DOCS[prefix]}`),
      range,
    );
  }
  const head = word.split(".")[0];
  if (VALUE_FUNCTION_DOCS[head]) {
    return new vscode.Hover(
      new vscode.MarkdownString(`**${head}(…)** — ${VALUE_FUNCTION_DOCS[head]}`),
      range,
    );
  }
  return null;
}

// --- activation --------------------------------------------------------------

function activate(context) {
  const output = vscode.window.createOutputChannel("IDEL Language");
  const collection = vscode.languages.createDiagnosticCollection("idel");
  const timers = new Map();

  const scheduleRefresh = (document) => {
    const key = document.uri.toString();
    clearTimeout(timers.get(key));
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        void refreshDiagnostics(document, collection, context, output);
      }, DEBOUNCE_MS),
    );
  };

  context.subscriptions.push(
    output,
    collection,
    vscode.workspace.onDidOpenTextDocument(scheduleRefresh),
    vscode.workspace.onDidChangeTextDocument((event) => scheduleRefresh(event.document)),
    vscode.workspace.onDidCloseTextDocument((document) => collection.delete(document.uri)),
    vscode.languages.registerCompletionItemProvider(
      "idel",
      { provideCompletionItems: completionItems },
      ".",
      "=",
      " ",
    ),
    vscode.languages.registerHoverProvider("idel", { provideHover: hoverFor }),
  );

  for (const document of vscode.workspace.textDocuments) scheduleRefresh(document);
}

function deactivate() {}

module.exports = { activate, deactivate };
