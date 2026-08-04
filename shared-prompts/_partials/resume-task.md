The agent performing this work MUST load `about-task-files`.

## Delegation

Per the sub-agent delegation pattern (`~sous-shared/_partials/sub-agent-delegation.md`), the
orchestrator delegates steps 1 and 2 (find and read the task file, extract status) to a background
sub-agent, which reports back a concise summary. Step 3 is orchestrator-only.

## Steps

### 1. Find the Task File

Run `git status` to get the current branch name. Look for the task file at:
```
{{ taskFileRoot }}/[branch-name].md
```

If not found, run a fresh `git status` to confirm the branch before concluding the file doesn't exist. If it truly doesn't exist, report that back; the orchestrator asks the user whether to create one (load `start-task`).

### 2. Read and Analyze

Read the entire task file. Identify:
- Overall objective
- What has been completed (checked items, status markers)
- What remains (unchecked items, TODOs)
- Any blockers or pending issues
- Recent decisions and learnings

### 3. Present Status and Next Steps

Orchestrator-only; sub-agents cannot talk to the user. A sub-agent doing steps 1 and 2 returns its
summary to the orchestrator, which presents:

```
Based on the task file, here's where we are:

**Current Status:**
[Brief summary of completed phases and where work stopped]

**Recommended Next Steps:**
1. [First thing to do]
2. [Second thing]
3. [etc.]

Would you like me to:
- A) Proceed with these next steps?
- B) Focus on something specific?
- C) Something else?
```

**Do not begin work until the user confirms.** If the task file has contradictions or outdated information, point them out before proceeding.
