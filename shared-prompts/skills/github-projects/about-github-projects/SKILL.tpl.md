---
name: about-github-projects
description: >
  YOU MUST load this skill when working with GitHub Issues or the GitHub Project board; querying
  issues, creating issues, changing an issue's status, or any project-management operation.
user-invocable: false
license: Apache-2.0
compatibility:
  - claude
  - codex
metadata:
  version: 1.0.0
  tags: [github, projects, issues, project-management]
---

The project uses **GitHub Issues** for tickets and a **GitHub Projects (v2) board** for status
tracking. Issues live in the repository; the board tracks their status via a single-select
`Status` field.

## Key Values

- **User**: {{ userFullName }}
- **User GitHub login**: `{{ githubUserLogin }}`
- **Repository**: `{{ githubRepo }}`
- **Project owner**: `{{ githubProjectOwner }}`
- **Project number**: `{{ githubProjectNumber }}`
- **Project node ID**: `{{ githubProjectId }}`
- **Status field ID**: `{{ githubStatusFieldId }}`

## Ticket IDs and Branch Names

Outside of GitHub itself, issue numbers are always written with the `{{ ticketPrefix }}` prefix:
issue `#47` is ticket `{{ ticketPrefix }}47`. Branch names and task file names use this form
(e.g. branch `lc/{{ ticketPrefix }}47-fix-thing`); a bare number is too ambiguous to grep for.
Inside GitHub content (issue bodies, comments, PR descriptions), use the native `#47` form so
GitHub auto-links it.

## Who Executes What

Per the sub-agent delegation pattern (`~sous-shared/_partials/sub-agent-delegation.md`):

- The orchestrator drafts issue and comment bodies; the user approves them.
- An Opus sub-agent then executes the write with the exact approved text and reports back the
  issue number and link.
- Read-only queries (issue lists, issue views, board reads) can be delegated freely; Sonnet is
  sufficient.

## How We Work Issues

### Issue Intent vs Technical Implementation

Issues describe **intent**; what needs to be accomplished and why. Any technical implementation
details in an issue are **tentative**; they represent one possible approach, not a mandate. We
MUST satisfy the issue's intent, but the technical path is ours to determine, and we may deviate
sharply when we find a better approach.

**Backlog-status issues** are especially tentative; they have not been scoped, and the intent
itself may need research or clarification from the user before work begins.

### Parent Issues (Epics)

When the user specifies a **parent issue** (one with sub-issues) as the basis for work:

- Iterate through the sub-issues one at a time
- The task file is named after the parent issue's branch, not individual sub-issues
- After completing each sub-issue, present the remaining ones and ask the user which to tackle next
- Roll relevant context from one sub-issue to the next in the task file

When the user specifies a single ordinary issue, ignore any parent and work it normally.

### Picking Up an Issue

When starting work on an issue:

1. If **unassigned**, assign it to the user (`{{ githubUserLogin }}`)
2. If **assigned to someone else**, leave it alone and check with the user
3. Ensure the issue is **on the board** (see Board Operations below); issues are NOT added
   automatically
4. Set its status to **In Progress**

Delegate the assign/board/status sequence to a sub-agent; it reports the final state.

### Completing an Issue

- When the work is submitted (PR open or awaiting the user's verification), set status
  **In Review** and stop; the user decides when it is done.
- When the user confirms completion: set status **Done**, then close the issue with a brief
  comment linking the merged PR or the resolving commit.

Closing an issue does NOT update its board status, and setting status Done does NOT close the
issue; always do both. See [Workflow](references/workflow.md) for the full status semantics.

## Issue Display Format

When displaying issues, always use this format:

```
{{ ticketPrefix }}<number> | Rank: <rank> | Assigned To: <assignee> | Status: <status> | Labels: <labels>
**<title>**
<truncated-body>
<link-to-issue>
```

## GitHub CLI

All operations go through the `gh` CLI, which must be authenticated with the `project` scope
(see [Troubleshooting](references/troubleshooting.md) if a command reports missing scopes).

### Core Issue Commands

**List issues:**
```bash
gh issue list --repo {{ githubRepo }} --state open --limit 10
```
Add `--assignee {{ githubUserLogin }}`, `--label tech-debt`, or `--search "text"` to filter.
Add `--json number,title,assignees,labels,url` for parsable output.

**View an issue:**
```bash
gh issue view 47 --repo {{ githubRepo }} --comments
```

**Create an issue (pipe Markdown via heredoc):**
```bash
cat <<'MD' | gh issue create --repo {{ githubRepo }} \
  --title "Tech Debt: Refresh X" \
  --label tech-debt \
  --body-file -
High-level objective line.

## Background & Evidence
- Detail or links.

## Proposed Approach / Tasks
1. Step one
2. Step two
MD
```
`--title` is mandatory and is NOT supplied by `--body-file`; the heredoc feeds only the body.
The command prints the new issue's URL; the trailing number is the issue number.

**Edit an issue:**
```bash
gh issue edit 47 --repo {{ githubRepo }} --title "Updated title"
# or replace the body via stdin:
cat <<'MD' | gh issue edit 47 --repo {{ githubRepo }} --body-file -
New body.
MD
```

**Assign:**
```bash
gh issue edit 47 --repo {{ githubRepo }} --add-assignee {{ githubUserLogin }}
```

**Close / reopen:**
```bash
gh issue close 47 --repo {{ githubRepo }} --comment "Resolved by #<pr-number>."
gh issue reopen 47 --repo {{ githubRepo }}
```

### Board Operations

**Add an issue to the board** (required after creating; nothing is added automatically):
```bash
gh project item-add {{ githubProjectNumber }} --owner {{ githubProjectOwner }} \
  --url https://github.com/{{ githubRepo }}/issues/47 --format json
```
The JSON output's `id` is the board **item ID** needed for status changes.

**Find the item ID for an existing issue:**
```bash
gh project item-list {{ githubProjectNumber }} --owner {{ githubProjectOwner }} \
  --limit 200 --format json | jq -r '.items[] | select(.content.number == 47) | .id'
```

**Set status** (all three IDs are required; see [Workflow](references/workflow.md) for the
option IDs):
```bash
gh project item-edit --id <ITEM_ID> \
  --project-id {{ githubProjectId }} \
  --field-id {{ githubStatusFieldId }} \
  --single-select-option-id <STATUS_OPTION_ID>
```

**Read the board:**
```bash
gh project item-list {{ githubProjectNumber }} --owner {{ githubProjectOwner }} \
  --limit 200 --format json | jq -r '.items[] | "\(.content.number) | \(.status) | \(.title)"'
```
`item-list` defaults to 30 items; always pass `--limit`.

## Reference Docs

Each issue type has its own structure conventions:

- [Task / Tech Debt](references/task-tech-debt.md): engineering tasks, refactors, tech debt
- [Feature](references/feature.md): user-facing features and enhancements
- [Bug](references/bug.md): defects and regressions
- [Workflow](references/workflow.md): statuses, option IDs, and status-change recipes
- [Troubleshooting](references/troubleshooting.md): auth scopes, CLI gotchas

## See Also

- `pick-issue`: find and select an issue to work on next
- `create-issue`: full workflow for drafting and submitting a new issue

## Source for this Skill

This skill was compiled from a template and the output file should not be edited directly.

- Source Path: {{ sousTemplatePath }}
