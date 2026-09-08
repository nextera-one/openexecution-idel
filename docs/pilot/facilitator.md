# First-cohort plan

Status: materials prepared; no participant sessions or results are claimed.

## Recruit and schedule

Recruit 6–9 people: aim for 2–3 developers who use AI coding tools, 2–3 who mainly
use terminals, and 2–3 internal team members. Groups may overlap; record all that
apply and keep external and internal findings distinguishable. Cover Windows,
Linux, and both macOS architectures where participants are available. Do not
claim platform coverage until someone has actually installed on that platform.

Run one internal rehearsal first. Then schedule individual 30-minute sessions
over a week. The product owner chooses participants and sends invitations; the
draft below is not a sent invitation. Do not promise incentives or record a
screen without a separate agreement with the participant.

## Session script

1. Explain that we are testing the product, not the person. Ask their usual tool
   and relevant experience. Record the release, OS, and group(s).
2. Observe installation. A security block is an installation outcome; do not
   coach people to weaken OS protections. Stop there if they cannot launch.
3. Give one task goal at a time from the participant guide. Allow up to two
   minutes before offering hints. Record help, retries, time, and requests for a
   shell. Do not count a hinted task as independent completion.
4. Ask “What do you expect to happen?” before a decision and “What happened?”
   afterward. For cleanup, distinguish enforced dry run and actual move; typed LOW/MEDIUM commands
   run immediately under the default policy.
5. Record AI unavailability separately from attempted-task failure. Do not use
   participant credentials yourself. Ask about summary accuracy and extra changes.
6. Ask whether they would choose IDEL for another task and why. Let them review
   feedback before submitting. Do not upload raw audit logs by default.

Use [session-results.csv](session-results.csv) locally as the observation sheet;
it deliberately has no sample participants or invented results. Keep participant
identities/contact details in the owner's existing private scheduling system.
Public feedback can use a pseudonymous session reference, but GitHub profiles
remain visible when participants submit issues.

## Readout and decisions

Report raw counts per group and OS: installation attempts/launches, first-command
time, independent/helped/incomplete tasks, hints and retries, shell requests, AI
availability, and return intent. Report AI completion only among people who
attempted it, alongside the excluded/unavailable count. This small convenience
sample is qualitative evidence, not a population adoption estimate.

Working decision rules for this pilot (team hypotheses, not industry benchmarks):

- Any unintended modification outside the practice goal, unexpected execution
  after a decline, or missing audit evidence: pause that workflow, reproduce,
  and fix before more participants use it. Use private reporting when sensitive.
- Two people independently hit the same installation or comprehension blocker:
  prioritize it before adding features; retest with people who did not learn the fix.
- Most participants need hints on a task: simplify discovery/instructions and
  rerun it. Hints are diagnostic evidence, not a successful unassisted task.
- Repeated shell requests: classify whether the gap is registry coverage,
  discoverability, or a task that falls outside IDEL's intended boundary.
- Voluntary second use for a named task is stronger evidence than a positive
  rating. Ask interested participants to try a fresh practice folder a few days
  later; do not schedule or send a follow-up without their agreement.

End with the top three problems, supporting observations, owner, next change,
and retest condition. Retain stable-release gates: signing/notarization and
manual installation/window/workspace/restart/uninstall checks. Do not interpret
this pilot as a security certification.

## Invitation draft

Would you try IDEL, a local tool for policy-controlled execution, in a 30-minute
pilot? You will use synthetic practice files for project setup, controlled
cleanup, and an optional AI-assisted change. We want to see where the workflow
is confusing or where you would prefer your current tools. This is an unsigned
developer preview; installation may be blocked by your OS. You can stop at any
point. Feedback can be returned to me directly or submitted publicly on GitHub
after you review it. Guide: https://openexecution-idel.digital-pages.chatgpt.site/idel/pilot
