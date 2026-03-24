YOU MUST load `about-task-files` before proceeding.

## Steps

### 1. Find the Task File

Run `git status` to get the current branch name. Look for the task file at:
```
{{ taskFilePath }}/[branch-name].md
```

If not found, run a fresh `git status` to confirm the branch before concluding the file doesn't exist. If it truly doesn't exist, inform the user and ask if they'd like to create one (load `start-task`).

### 2. Read and Analyze

Read the entire task file. Identify:
- Overall objective
- What has been completed (checked items, status markers)
- What remains (unchecked items, TODOs)
- Any blockers or pending issues
- Recent decisions and learnings

### 3. Present Status and Next Steps

Summarize to the user:

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
