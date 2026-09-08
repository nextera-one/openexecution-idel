# IDEL Language for VS Code

Language support for lowercase IDEL Structure (`*.idel`, `idel.lock`):

- **Syntax highlighting** — verbs, labels, value functions, enum tokens,
  strings, numbers, comments.
- **Diagnostics** — live syntax errors and lint warnings (unlabeled `define`
  blocks, empty blocks, literal secret values) from the real
  `@openexecution/structure` parser, bundled at install time so the editor and
  the runtime never disagree about validity.
- **Completion** — block verbs with documentation, full-block snippets
  (`define.function.action`, `protect.request.replay`,
  `limit.execution.resources`), value functions after `=`, and enum tokens.
- **Hover** — documentation for known verbs and value functions.
- Brackets, auto-closing pairs, `#` comments, and indentation rules.

This extension is editor tooling only; execution, policy, and evidence remain
the runtime's job. It is a sibling of the `openexecution-idel-vscode` terminal
extension and does not replace it.

## Install

```bash
./install.sh                 # installs into ~/.vscode/extensions
./install.sh --dir <path>    # custom extensions directory
```

Restart VS Code (or run "Developer: Reload Window") afterwards.

## Uninstall

```bash
./uninstall.sh
./uninstall.sh --dir <path>
```

## Settings

- `idelLanguage.diagnostics` (default `true`) — parse documents as you type.
