# ADR 0037: The harness id is `claude-code`, and Claude Code owns the kinds `claude-code-plugin` and `claude-code-agent`

**Status:** Accepted, 2026-11-18.

The design is specification [S15](../architecture/specifications/S15-claude-code.md), sections 1, 2, 4, 5 and
6.

## Context

Sous registered Claude Code's harness as `claude` but its skills directory as `claude-code`. A workflow framework
for Claude Code is more than skills: it has agents, hooks and scripts, which Claude Code loads as one unit when they
are packaged as a plugin, and agent files that only Claude Code reads. A recipe had no way to ship either for
Claude Code alone.

## Decision

> "its better to be overly verbose than regret inspecificity later."
>
>   -- **Luke Chavers** (2026-11-17)

- The harness id is `claude-code`. Its settings key is `tools.claude-code`; `sous launch claude-code` starts it.
  `sous launch claude` is not kept as an alias (agent's choice, following the ruling above); an unknown tool name
  that starts a known id and a hyphen gets a "Did you mean" hint. A 1.0.20 migration renames `tools.claude` in a
  project's JSON, JSONC and YAML config files surgically, and names any code file that sets it.
- Every output written for Claude Code is marked `harness: "claude-code"`, so the merge of the per-harness config
  builds takes it from Claude Code's build.
- `@sous-io/plugin-claude-code` registers and consumes two content kinds:
  - `claude-code-plugin`. Luke: "ideally, Sous will allow either approach. Either a directly installed plugin, or a
    plugin provided by a skill." Each folder under the include pattern's fixed part is written to
    `.claude/skills/<folder>`.
  - `claude-code-agent`. Luke: "Sous should include a new `kind` for `claude-code-agent`. Those agent files are
    Claude-specific." Files go to `.claude/agents/` with their sub-folders.

  `.tpl.` files are rendered; others are written as they are. Only Claude Code's plugin consumes the kinds, so no
  harness condition is needed.
- When a build adds, changes or removes a file of any folder holding `.claude-plugin/plugin.json`, the build ends
  with one line saying to run `/reload-plugins` in any open Claude Code session. Luke ruled it in; he ruled out a
  notice about a plugin's hooks ("trust is trust. we dont need a notice.") and anything beyond this line that
  recognising a plugin could drive.

Rejected by Luke: a generic plugin kind owned by Claude Code's plugin; a generic kind with a `harness` key; a
`harness` key on a `contents` group; a shorter spelling converted into the harness condition.

## Consequences

- A recipe can ship a Claude Code plugin either as a `claude-code-plugin` group or among its `skills` with an
  `exclude` carrying `harness.id != 'claude-code'`; both get the reload line.
- Projects with `tools.claude` in a config file sous cannot edit must rename the key by hand; the migration says
  which file.
- `plugin-claude-code` now depends on `plugin-recipes`, `plugin-compiler` and `sous-plugin-migrations`.
