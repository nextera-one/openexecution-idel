# IDEL pilot 1

Try three small workflows and tell us where IDEL helps or gets in your way.
Developers using AI tools, terminal-focused developers, and internal team
members are all welcome. Allow about 30 minutes; stopping early is useful feedback.

[Public pilot guide](https://openexecution-idel.digital-pages.chatgpt.site/idel/pilot)
· [Preview installers](https://github.com/nextera-one/openexecution-idel/releases/tag/v1.1.0-preview.1)
· [Feedback form](https://github.com/nextera-one/openexecution-idel/issues/new?template=pilot-feedback.yml)

## Before you start

Use preview 1.1.0-preview.1. It is unsigned, and macOS is not notarized. Read the
release notes; if your system blocks installation, record that outcome and stop.
You do not need to change OS security settings to participate.

Download the practice ZIP from the guide and extract it to a **new folder under
Documents**. In IDEL choose **IDEL → Choose workspace…**, select the extracted
`idel-pilot-v1` folder containing `pilot-input` and `pilot-cleanup`, and accept the
workspace restart. Stay in IDEL mode and retain the default policy. Use the same
new practice folder for all tasks; extract a fresh copy for a repeat session.

No AI account is needed for tasks 1 and 2. For task 3, use an already configured
provider or record “AI unavailable”. Provider use may incur its normal charges.
The practice notes contain synthetic data; do not substitute work documents.

## How to record a task

First try the goal for up to two minutes using IDEL's completion and help. Open
the command hints only if needed, and count that as help. Run one command at a
time. Before submitting a command, say what you expect to change. Record the time, whether
you needed help, the actual outcome, and any point where you wanted a shell.
Time limits are prompts to stop and report friction, not a speed competition.

### 1. Project setup — about 5 minutes

Goal: create `pilot-project/README.md` containing `IDEL pilot project`, then read
it back. Under the default policy, these LOW/MEDIUM typed commands execute when
submitted. Review the command before pressing Enter; an approval dialog is not
guaranteed. AI real-run requests have a separate approval flow.

<details><summary>Command hints</summary>

```text
create.folder name=pilot-project
write.file name=pilot-project/README.md content="IDEL pilot project"
read.file name=pilot-project/README.md
```

</details>

Done means the file exists with the expected content. Record your first
successful command time and whether you understood the proposed action.

### 2. Controlled cleanup — about 7 minutes

Goal: understand the result of a recursive cleanup proposal, then move generated output aside for review. Move
`pilot-cleanup/generated.tmp` to `pilot-project/review-later.tmp`, keeping
`keep-me.txt` and the moved file contents unchanged.

With the default policy, the recursive folder proposal is HIGH risk and
**dry-run only**. Both practice files should still exist. Do not change policy
to force the folder deletion. Both folder and file deletion are HIGH risk and remain dry-run only.
Use a reversible move for the actual cleanup step. Inspect both paths before
submitting it: this MEDIUM operation executes immediately under the default policy.

<details><summary>Command hints</summary>

```text
remove.folder name=pilot-cleanup recursive=true
list.folder path=pilot-cleanup
move.file from=pilot-cleanup/generated.tmp to=pilot-project/review-later.tmp
read.file name=pilot-cleanup/keep-me.txt
```

Do not paste this sequence as one batch. Inspect the outcome of each step. No `--dry-run` CLI flag is needed in the desktop
input: the default policy enforces the recursive proposal's dry run.

</details>

Done means generated.tmp has moved to review-later.tmp with its original
content, keep-me.txt is unchanged, and you can explain the enforced dry run
versus the real move. No file deletion is expected. Record whether moving a
file aside is useful or whether you needed an actual deletion workflow.

### 3. AI-assisted change — about 8 minutes, optional

Goal: use Ask AI to turn `pilot-input/notes.txt` into a three-bullet summary in
`pilot-project/SUMMARY.md`, without changing any other file.

Paste this prompt in Ask AI:

> Read pilot-input/notes.txt and propose a three-bullet summary in pilot-project/SUMMARY.md. Use IDEL commands only. Do not use a native shell, install anything, or change any other file. I will review the proposed commands before approving them.

Review each proposal before approval. Decline any proposal outside the goal.
Read the saved summary using `read.file name=pilot-project/SUMMARY.md`. Compare it
with the notes and inspect recent records with `list.logs limit=20`.

Record provider/model names, whether the summary is accurate, and any unexpected
proposal. If AI cannot be configured, record that separately from task failure.
If task 1 failed, record task 3 as blocked by setup rather than changing real files.

## Send feedback — about 5 minutes

Use the linked GitHub form, or fill [feedback.md](feedback.md) and return it to
the person who invited you. GitHub feedback is public and requires a GitHub
account. Review what you share; omit keys, private paths, full logs, and private
file contents. This guide does not automatically send task results or record
your screen. IDEL still writes local audit records, and configured AI providers
receive the prompts/files you approve for their workflow.

For security-sensitive findings, use the repository's private vulnerability
reporting instead of the public pilot form.
