# Frontmatter Reference

All fields are optional, though `description` is strongly recommended.
`name` defaults to the directory name if omitted.

| Field                      | Description |
|:---------------------------|:------------|
| `name`                     | Slash-command name. Lowercase letters, numbers, hyphens (max 64 chars). Defaults to directory name. |
| `description`              | When to invoke this skill. Used by the agent for auto-invocation. Falls back to first paragraph of content. |
| `argument-hint`            | Hint shown in autocomplete. Example: `[issue-number]` or `[filename] [format]`. |
| `disable-model-invocation` | `true` — user-only invocation. Description removed from the agent's context entirely. Use for side-effect workflows. Default: `false`. |
| `user-invocable`           | `false` — hides from `/` menu; only the agent can invoke. Use for background knowledge. Default: `true`. |
| `allowed-tools`            | Tools the agent may use without per-use approval when this skill is active. Example: `Read, Grep, Glob`. |
| `model`                    | Model to use when this skill is active. |
| `context`                  | `fork` — run the skill in an isolated subagent. Skill content becomes the subagent prompt. |
| `agent`                    | Subagent type when `context: fork` is set. Options: `Explore`, `Plan`, `general-purpose`, or any custom agent defined in the tool's agents directory. Defaults to `general-purpose`. |
| `hooks`                    | Hooks scoped to this skill's lifecycle. |

## Invocation Matrix

| Frontmatter                      | User can invoke | Agent can invoke  | When loaded into context                                      |
|:---------------------------------|:----------------|:------------------|:--------------------------------------------------------------|
| (default)                        | Yes             | Yes               | Description always in context; full skill loads on invocation |
| `disable-model-invocation: true` | Yes             | No                | Not in context at all; loads only when user invokes           |
| `user-invocable: false`          | No              | Yes               | Description always in context; full skill loads on invocation |
