---
name: pick-issue
description: >
  YOU MUST load this skill when the user needs help choosing a GitHub issue to work on, or says
  "what should I work on next?", "find me an issue", "show me available issues", "help me pick a
  task", or "what's in the backlog?".
license: Apache-2.0
compatibility:
  - claude
  - codex
metadata:
  version: 1.0.0
  tags: [github, issues, project-management]
---

The agent running the searches MUST load `about-github-projects`.

Show no more than 5 issues at a time, sorted by Rank descending (highest first).

## Search Strategy

Delegate the whole escalation sweep below to one Sonnet sub-agent. It returns the issues from
the first non-empty level, already formatted (see the display format in `about-github-projects`)
and ranked. The orchestrator presents them and asks the user to choose.

Fetch the board once and filter locally, rather than one call per level:

```bash
gh project item-list {{ githubProjectNumber }} --owner {{ githubProjectOwner }} \
  --limit 200 --format json > /tmp/board.json
```

Inspect the item shape with `jq '.items[0]' /tmp/board.json` if a filter matches nothing
unexpectedly.

Work through the levels below in order. After each level:
- **Zero results** → broaden to the next level without asking
- **One or more results** → list them and ask the user to choose
  - User chooses → workflow complete
  - User doesn't choose → broaden to the next level without asking

### Level 1: In Flight

Issues assigned to the user with status In Progress or In Review (work already underway):

```bash
jq -r '.items[] | select((.status == "In Progress" or .status == "In Review")
  and (.assignees // [] | index("{{ githubUserLogin }}")))
  | "{{ ticketPrefix }}\(.content.number) | \(.status) | \(.title)"' /tmp/board.json
```

### Level 2: Assigned and Ready

Issues assigned to the user with status Ready:

```bash
jq -r '.items[] | select(.status == "Ready"
  and (.assignees // [] | index("{{ githubUserLogin }}")))
  | "{{ ticketPrefix }}\(.content.number) | \(.status) | \(.title)"' /tmp/board.json
```

### Level 3: Unassigned and Ready

```bash
jq -r '.items[] | select(.status == "Ready" and ((.assignees // []) | length == 0))
  | "{{ ticketPrefix }}\(.content.number) | \(.status) | \(.title)"' /tmp/board.json
```

### Level 4: Backlog

Anything with status Backlog; these need scoping before work starts, so flag that when
presenting them:

```bash
jq -r '.items[] | select(.status == "Backlog")
  | "{{ ticketPrefix }}\(.content.number) | \(.status) | \(.title)"' /tmp/board.json
```

### Level 5: Off the Board

Open issues that were never added to the board:

```bash
comm -23 \
  <(gh issue list --repo {{ githubRepo }} --state open --limit 200 --json number \
      | jq -r '.[].number' | sort -n) \
  <(jq -r '.items[].content.number' /tmp/board.json | sort -n)
```

Offer to add chosen ones to the board (see Board Operations in `about-github-projects`).

## Rank

"Rank" is a relative score used only to compare issues against each other. Issues found at
earlier levels start with a higher rank. Within the same level, increase rank for the following
factors (ordered greatest to least impact):

- Issue is In Progress
- Issue is assigned to the user
- Issue is Ready
- Issue is unassigned
- Issue is labeled `bug`
- Issue seems easy and touches few modules

## Source for this Skill

This skill was compiled from a template and the output file should not be edited directly.

- Source Path: {{ sousTemplatePath }}
