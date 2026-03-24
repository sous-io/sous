# Commands Reference

A **command** is a user-invocable action skill that represents an intentional,
user-initiated workflow. The user explicitly triggers it with `/skill-name`.

## Key Properties

- Set `disable-model-invocation: true`. This removes the skill from the agent's context
  entirely — it loads only when the user invokes it. See `frontmatter.md` for the
  invocation matrix.
- Because the model never sees the description, write it for humans, not the agent.
  It appears in the `/` autocomplete menu. Plain, informative language is appropriate —
  strong trigger language ("YOU MUST") is unnecessary and out of place.
- Commands do not require an `# Abstract` section. Include one only if useful context
  is genuinely needed. Headings are optional in general — use them only if the content
  is complex enough to warrant structure.

## Arguments

Commands often accept arguments (e.g. `/deploy staging`). When they do:

1. Use `$ARGUMENTS` (or `$0`, `$1`, etc.) in the skill body where the arguments should
   be substituted. See `substitutions.md` for full syntax.
2. Add an `argument-hint` field to frontmatter — it appears in autocomplete next to the
   command name.

```yaml
---
name: deploy
description: Deploy the application to a target environment.
argument-hint: "[environment]"
disable-model-invocation: true
---

Deploy to the $0 environment.
```

If `$ARGUMENTS` is not present in the body but arguments are passed, the agent
appends them automatically as `ARGUMENTS: <value>`.

## When to Omit `disable-model-invocation`

Not every command needs `disable-model-invocation: true`. If it makes sense for the agent
to invoke the command autonomously on the user's behalf (e.g. a lightweight helper with
no side effects), omit the flag. Use judgement — the defining question is whether the
action should require explicit user intent.