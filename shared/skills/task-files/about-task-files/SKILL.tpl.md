---
name: about-task-files
description: YOU MUST load this skill when working with task files — including creating, reading, updating, or archiving a task file, or any time you need to know where task files live.
user-invocable: false
---

A **task file** is a Markdown document that tracks a unit of work across one or more chat sessions. It is the single source of truth for what has been done, what remains, and what decisions were made.

## Location and Naming

Task files live at:
```
{{ taskFileRoot }}/[branch-name].md
```

The filename mirrors the full git branch name — including any `/` separators as path separators:
- Branch `lc/PT-1060-some-feature` → `{{ taskFileRoot }}/lc/PT-1060-some-feature.md`

To find the current task file: run `git status`, take the branch name, construct the path above.

**If the file is not found:** run a fresh `git status` to confirm the branch name before concluding it doesn't exist.

## Archive Location

Completed task files are archived at:
```
{{ taskFileRoot }}/archive/[branch-name].md
```

The path structure mirrors the task file location — just under `archive/`.

## Completion Procedure

When the user confirms a task is 100% complete:
1. Update the task file with the final status
2. Move it to `{{ taskFileRoot }}/archive/[branch-name].md` (create subdirectories as needed)
3. Switch to the `develop` branch
4. Pull the latest changes from the remote
5. Run `pnpm run bootstrap:core` from the repo root

## File Format

```markdown
# Task: [Feature/Fix Description]

**Branch:** `lc/PT-XXXX-feature-name`
**Status:** In Progress - Phase 2 Complete
**Started:** YYYY-MM-DD
**Updated:** YYYY-MM-DD

## Overview
[Brief description of the task objective]

## Current Status
- Phase 1: Complete
- Phase 2: Complete
- Phase 3: In Progress

## Recent Progress
[What was accomplished in the most recent session]

## Decisions Made
[Technical and process decisions, with brief rationale]

## Remaining Work
- [ ] Task with context
- [ ] Another task

## Pending Issues
[Unresolved problems, blockers, open questions]

## Key Learnings
[Patterns, discoveries, gotchas worth remembering]

## Commits Made
- `abc123f` - description

## Files Modified
- /absolute/path/to/File.ts:45 - what changed and why

## Testing URLs
- http://localhost:5173/path/to/page

## Unresolved Errors
[Test failures, build errors, TypeScript errors — with paths and line numbers]
```

## Style Guidelines

- No emojis or emoticons
- Concise but not aggressively compressed — important information must not be lost
- Wrap long lines at 120 characters
- Absolute paths with line numbers for file references (not ranges)
- Use `file:/absolute/path/to/File.ts:45` format for clickable links (two slashes, not three)

## File Size

Task files must not exceed **1,000 lines**. When approaching the limit, condense:
- Completed phases (keep summary, drop detail)
- Historical context no longer relevant to upcoming work
- Information less important to immediate next steps

Always preserve in full: current active work, immediate next steps, unresolved issues, recent learnings, recently modified files.

## Task Plan Structure

When drafting a task plan, segregate work by layer in this order:
- `domain`
- `projection-sync`
- `rpc`
- `web`
- `cli`

(Not exhaustive — include any relevant layer.) Work one layer at a time and commit at least once per layer.

## Source for this Skill

This skill was pulled from the `sous` project's "shared skills" library. It was compiled from a template and
the output file should not be edited directly.

- Source Path: {{ sousTemplatePath }}
