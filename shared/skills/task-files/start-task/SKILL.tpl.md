---
name: start-task
description: YOU MUST load this skill when the user wants to start work on a new task — including "start a new task", "let's work on PT-XXXX", "begin a new task", "create a task file", or any request to begin fresh work on a ticket.
---

YOU MUST load `about-task-files` and `about-jira` before proceeding.

## Steps

### 1. Identify the Ticket

Look for a `PT-XXXX` ticket number in the user's message. If none is provided:
- Ask the user to specify one, or offer to help them pick via `pick-jira-ticket`
- Once a ticket number is confirmed, proceed

### 2. Pull Ticket Info

Fetch basic ticket info from Jira:
```bash
./.codex/scripts/bash/jira/jira.sh issue view PT-#### --plain --comments 0
```

- If the ticket doesn't exist, go back to step 1
- If unassigned, ask the user if they want to assign it to themselves
- If status is "To Do", ask the user if they want to mark it "In Progress"

### 3. Check for an Existing Branch

Look for local branches starting with `lc/` that include the ticket number:
```bash
git branch | grep PT-####
```

If found, confirm it's the right branch with the user (there may be multiple), then:
```bash
git checkout [branch-name]
git pull origin [branch-name]
pnpm run bootstrap:core
```
Then go to step 4.

### 3a. Create a New Branch

If no existing branch is found:

1. Switch to `develop` and pull latest:
   ```bash
   git checkout develop && git pull origin develop
   ```
2. Resolve branch name: `lc/PT-[ticket-number]-[short-description]` derived from the ticket title. **Confirm with the user before creating.**
3. Create and switch to the branch, then bootstrap:
   ```bash
   git checkout -b [branch-name]
   pnpm run bootstrap:core
   ```

### 4. Load or Create the Task File

Check for an existing task file at `{{ taskFileRoot }}/[branch-name].md`.

- **Found**: read it, note what's already captured, and continue to step 5
- **Not found**: collect full ticket info from Jira (summary, description, status, assignee, related issues, comments, story points, sub-tasks, any linked MRs or commits), then create the task file using the format in `about-task-files`. Include relevant testing URLs — query `mcp-postgres` to get real record IDs so URLs are actually clickable. Use `file:/absolute/path:line` format for source file links.

### 5. Plan and Start

Draft a task plan, organized by layer (see `about-task-files` for layer ordering). Update the task file with the plan. Then ask the user if they want to begin work.

## Source for this Skill

This skill was pulled from the `sous` project's "shared skills" library. It was compiled from a template and
the output file should not be edited directly.

- Source Path: {{ sousTemplatePath }}
