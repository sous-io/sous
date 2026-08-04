The agent performing this work MUST load `about-task-files`.

**CRITICAL: Do NOTHING ELSE. Update the task file IMMEDIATELY. Use as few edits as possible.**

## Delegation

Per the sub-agent delegation pattern (`~sous-shared/_partials/sub-agent-delegation.md`), writing the
task file is delegated work. The orchestrator does not edit the file itself; it hands an Opus
sub-agent everything below in one self-contained prompt:

- The task file path (branch name), or instructions to derive it from `git status`.
- The facts and decisions to record. Compiling these is orchestrator-only; sub-agents cannot see
  this conversation, so anything known only from the conversation must be stated in the prompt.
- Anything the sub-agent can gather itself (commit list, changed files, test/build output), which it
  should collect rather than have the orchestrator paste in.

The sub-agent loads `about-task-files`, edits the file, and reports back a concise summary of what
it wrote. The orchestrator spot-checks with a targeted diff, not a full re-read.

## What to Include

Update the task file with all of the following:

1. **Progress since last update** — what was completed, what is in progress, current status
2. **Decisions made** — technical approach chosen, alternatives considered and rejected
3. **Remaining work** — everything still needed, prioritized next steps, known dependencies
4. **Pending issues** — unresolved problems, blockers, questions needing answers
5. **Learnings** — insights, patterns discovered, things to remember
6. **Commits made** — commit IDs and brief description of each
7. **Testing URLs** — web URLs currently in use, database query results referenced
8. **Files changed** — absolute paths with line numbers, what was done and why
9. **Unresolved errors** — test failures, build errors, TypeScript errors — with paths and line numbers

## Checklist Management

- Mark completed items `[x]`
- Add `[ ]` for newly identified tasks
- Remove or condense sections no longer relevant

## Consistency Check

Scan the existing file for contradictions or outdated information. Correct before saving.

## After Update

**STOP immediately.** Do not:
- Continue working on the task
- Start new work
- Make additional changes

A sub-agent reports what it wrote and stops. The orchestrator then waits; the user will end the
session and start a new one.
