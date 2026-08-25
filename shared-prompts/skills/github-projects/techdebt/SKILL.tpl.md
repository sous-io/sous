---
name: techdebt
description: Create a tech debt GitHub issue.
disable-model-invocation: true
argument-hint: "[description of the debt]"
license: Apache-2.0
compatibility:
  - claude
  - codex
metadata:
  version: 1.0.0
  tags: [github, issues, project-management]
---

Create a tech debt issue in `{{ githubRepo }}`. Treat any text provided after `/techdebt` as
guidance on what the issue is for.

Per the sub-agent delegation pattern (`~sous-shared/_partials/sub-agent-delegation.md`): the
orchestrator drafts the issue from
[references/task-tech-debt.md](../about-github-projects/references/task-tech-debt.md) (issue
structure and conventions) and gets the user's approval. Creation is then executed by an Opus
sub-agent, which loads `about-github-projects` and `create-issue` itself and returns the ticket
ID ({{ ticketPrefix }}<number>) and URL. The sub-agent also adds the issue to the board with
status Backlog, per `create-issue` step 5.

## Source for this Skill

This skill was compiled from a template and the output file should not be edited directly.

- Source Path: {{ sousTemplatePath }}
