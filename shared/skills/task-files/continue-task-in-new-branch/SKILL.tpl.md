---
name: continue-task-in-new-branch
description: YOU MUST load this skill when an MR has been merged and remaining work needs to continue in a new branch — including "continue this work in a new branch", "create a follow-up branch", "split this into another MR", "move remaining work to a new branch".
---

YOU MUST load `about-task-files` before proceeding.

## Steps

### 1. Prepare for Branch Transition

Before switching branches, ensure:
- Current branch is fully pushed to the remote
- All important context is documented in the current task file (load `update-task-file` if needed)
- The MR has been merged or is ready to close

### 2. Create the New Branch

Name the new branch using the original name plus a letter suffix (`-b`, `-c`, etc.):
```bash
git checkout develop
git pull origin develop
git checkout -b lc/PT-XXXX-description-b
pnpm run bootstrap:core
```

### 3. Create the New Task File

Create `{{ taskFileRoot }}/lc/PT-XXXX-description-b.md` with:
- **Task Overview**: brief description and connection to the previous MR
- **Remaining Work**: clear list of unfinished tasks with enough context to understand each item independently
- **Key Patterns and Learnings**: essential patterns from the previous branch worth carrying forward
- **Important Notes**: critical gotchas, blockers, or dependencies

Do NOT include: completed tasks (unless essential context), resolved MR comments, detailed change history.

### 4. Update the Old Task File

Add a "Work Continuation" section to the old task file before archiving:

```markdown
## Work Continuation
Remaining work has been moved to:
- **Branch**: lc/PT-XXXX-description-b
- **Task File**: {{ taskFileRoot }}/lc/PT-XXXX-description-b.md
- **Scope**: [brief description of remaining work]

This task file is now archived — work in the associated MR has been completed and merged.
```

### 5. Archive the Old Task File

```bash
mv {{ taskFileRoot }}/lc/PT-XXXX-description-a.md \
   {{ taskFileRoot }}/archive/lc/PT-XXXX-description-a.md
```

Create the archive subdirectory if it doesn't exist.

### 6. Clean Up

```bash
# Delete the old local branch
git branch -D lc/PT-XXXX-description-a
```

## Source for this Skill

This skill was pulled from the `sous` project's "shared skills" library. It was compiled from a template and
the output file should not be edited directly.

- Source Path: {{ sousTemplatePath }}
