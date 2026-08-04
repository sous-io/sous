# Advanced Patterns

## Dynamic Context Injection

The `` !`command` `` syntax runs a shell command before skill content is sent to Claude.
The output replaces the placeholder — Claude receives the rendered result, not the command.

```yaml
---
name: pr-summary
context: fork
agent: Explore
allowed-tools: Bash(gh *)
---

## Pull request context
- Diff: !`gh pr diff`
- Comments: !`gh pr view --comments`
- Changed files: !`gh pr diff --name-only`

## Task
Summarize this pull request...
```

Execution order: each `` !`command` `` runs first, output is inserted, then Claude sees
the fully-rendered prompt. This is preprocessing, not something Claude executes.

## Subagent Execution (`context: fork`)

Add `context: fork` to run the skill in an isolated subagent. The skill content becomes
the subagent's prompt. It does not have access to the current conversation history.

```yaml
---
name: deep-research
context: fork
agent: Explore
---

Research $ARGUMENTS thoroughly:
1. Find relevant files using Glob and Grep
2. Read and analyze the code
3. Summarize findings with specific file references
```

The `agent` field selects the subagent configuration:
- `Explore` — read-only tools optimized for codebase exploration
- `Plan` — planning-oriented execution
- `general-purpose` — default; full tool access
- Any custom agent defined in `.claude/agents/`

Results are summarized and returned to the main conversation.

> Only use `context: fork` for skills with explicit task instructions. Skills containing
> only reference guidelines (e.g. "use these conventions") will return without meaningful
> output — the subagent has no actionable task.

## Restricting Tool Access (`allowed-tools`)

Limit which tools Claude can use when a skill is active. Granted without per-use approval.

```yaml
---
name: safe-reader
allowed-tools: Read, Grep, Glob
---
```

Syntax supports wildcards: `Bash(gh *)` permits only `gh` subcommands via Bash.

## Supporting Files

Keep `SKILL.md` under ~500 lines. Move detailed reference material to separate files
and reference them from the skill body so Claude knows when to load them.

```
my-skill/
├── SKILL.md             # Overview, navigation, fundamental instructions
├── references/          # Deep-dive docs — loaded when needed, not always
│   └── api-spec.md
├── examples/            # Example outputs showing expected format
└── scripts/             # Executable scripts; referenced via $CLAUDE_SKILL_DIR
    └── validate.sh
```

Scripts are executed, not read into context. Reference them in `SKILL.md` with the
full path using `${CLAUDE_SKILL_DIR}/scripts/validate.sh`.
