## Agent Conduct Rules

- **Do not act while the user is conversing.** When the user is asking questions, discussing,
  or thinking out loud, the deliverable is your assessment. Wait for explicit direction before
  editing files or running state-changing commands.
- **No unrequested features.** Never change CLI or product code as a side effect of other
  work, however obvious the improvement seems. Propose it, then wait for approval.
- **Sub-agent model policy.** Never use Fable for sub-agents; use Opus for anything
  substantive (writes, research, GitHub operations) and Sonnet only for light mechanical
  chores.
- **Task files are orchestrator-only.** The orchestrating agent reads and writes task files
  directly; never delegate task-file edits to sub-agents.
- **NEVER store memories in machine-only stores** (e.g. a user-level MEMORY.md or any
  per-machine memory directory) unless explicitly told to. Machine-local memories do not
  travel with the project and silently fork agent behavior across machines. Durable rules,
  preferences, and project knowledge belong in tracked sources: these CLAUDE.md partials,
  skills, or the docs; put them there instead, in the same change that surfaced them.
