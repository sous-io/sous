# Sub-Agent Delegation

Several shared skills say work is "delegated" and cite the sub-agent delegation pattern. This is
that pattern. Include this partial in a project's core memory (`@~sous-shared/_partials/sub-agent-delegation.md`)
if the project wants the agent to follow it by default.

The main chat session is an **orchestrator**: it does the reasoning, the decisions, and all
interaction with the user, and it delegates execution to sub-agents. The orchestrator usually runs
an expensive model, so pushing execution down to cheaper sub-agents cuts cost and, because
sub-agents run in parallel, finishes sooner.

**Orchestrator-only:** planning, decisions, anything that needs the user (questions, approvals,
drafts), and very small actions where delegating costs more than doing it (a quick file read, a
one-line edit).

**Delegated:** anything with real work in it, including research, code changes, doc and task file
writing, and multi-step lookups.

**Rules:**

- Run sub-agents in the background and in parallel by default; batch independent dispatches into one
  message. Go synchronous only when the result blocks the very next step.
- Prompts must be self-contained. Sub-agents start with fresh context and cannot see the
  conversation, so state every fact, path, ID, and decision they need, and name the skills they
  should load. Anything the sub-agent can gather itself (branch name, commits, test output) should
  be left to it.
- Sub-agents cannot talk to the user. Questions and user-facing messages go back to the orchestrator
  to relay.
- Every sub-agent reports a concise summary of what it did or found, not a file dump.
- The orchestrator spot-checks load-bearing results (task files, code diffs, outward-facing writes)
  in a cheap, targeted way; it does not re-read everything.
- Never fabricate or predict a pending sub-agent's result. Wait for it.
