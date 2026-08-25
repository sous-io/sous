---
name: create-issue
description: >
  YOU MUST load this skill when asked to create, open, or draft a new GitHub issue; including
  "open an issue", "file a bug", "create a tech debt issue", "write a feature request", or any
  request to add a new issue to the tracker.
license: Apache-2.0
compatibility:
  - claude
  - codex
metadata:
  version: 1.0.0
  tags: [github, issues, project-management]
---

The agent that executes GitHub commands MUST load `about-github-projects`; it covers the CLI
commands, board operations, and issue structure reference docs.

## Steps

### 1. Prepare

Confirm:
- Issue type via label (`tech-debt`, `enhancement`, `bug`, or none for a plain task)
- Parent issue, if this is a sub-issue of a larger effort
- Any additional labels
- Do any necessary code research before drafting

### 2. Gather Context

- **Orchestrator:** review this conversation for motivation and expected impact; sub-agents
  cannot see it
- **Delegate:** gathering evidence from the repo, PRs, commits, and prior issues, plus
  identifying the modules or files implicated. Run sub-agents in parallel when multiple areas
  are implicated.

### 3. Pick the Right Structure

Load the appropriate reference from `about-github-projects`:
- Task or Tech Debt → [references/task-tech-debt.md](../about-github-projects/references/task-tech-debt.md)
- Feature → [references/feature.md](../about-github-projects/references/feature.md)
- Bug → [references/bug.md](../about-github-projects/references/bug.md)

### 4. Shape the Issue

- Draft the title first; outcome-oriented, with any required prefix (e.g. `Tech Debt: `)
- Write the body in GitHub-flavored Markdown using the structure for the issue type
- Reference related issues and PRs as `#<number>` so GitHub auto-links them; verify any repo
  paths against the default branch

### 5. Create and Board

The orchestrator presents the draft and waits for the user's approval. An Opus sub-agent then:

1. Creates the issue with the exact approved Markdown (heredoc pattern in
   `about-github-projects`), capturing the issue number from the printed URL
2. Adds it to the board (`gh project item-add`)
3. Sets its status: Backlog by default, Ready if the draft is already fully scoped (confirm
   which with the orchestrator's prompt)
4. Returns the issue number, URL, and final status

### 6. Finalize

- Share the new ticket ID ({{ ticketPrefix }}<number>), title, and a brief positioning summary
  with the user
- If a task file exists for the current branch, delegate recording the new issue link to a
  sub-agent; it must load `about-task-files`
- Surface any open questions or risks

## Source for this Skill

This skill was compiled from a template and the output file should not be edited directly.

- Source Path: {{ sousTemplatePath }}
