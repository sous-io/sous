---
name: about-commands
description: >
  YOU MUST load this skill when creating, editing, auditing, or converting command skills — action skills invoked explicitly by the user with /skill-name. Covers what commands are, how they differ from other action skills, description conventions, arguments, and when to omit disable-model-invocation.
user-invocable: false
---

# About Commands

A **command** is a user-invocable action skill that represents an intentional, user-initiated workflow. The user explicitly triggers it with `/skill-name`.

Commands are a sub-category of action skills. The full action skill architecture is covered in `about-agent-skills` — you MUST load it when working on any skill, including commands.

## Key Properties

```yaml
---
name: my-command
description: Deploy the application to a target environment.
disable-model-invocation: true
---
```

**`disable-model-invocation: true`** is the defining property of a command. It removes the skill from the agent's context entirely — it loads only when the user explicitly invokes it. See the invocation matrix in `about-agent-skills/references/frontmatter.md`.

**Descriptions are written for humans, not the agent.** Because `disable-model-invocation: true` removes the skill from the agent's context, the description is never seen by the agent — it appears only in the `/` autocomplete menu. Strong trigger language ("YOU MUST") is unnecessary and out of place. Plain, informative language is appropriate.

**No `# Abstract` is required.** Include one only if genuinely useful context is needed. Headings are optional — use them only if the content is complex enough to warrant structure.

## Arguments

Commands can accept arguments (e.g. `/deploy staging`).

1. Use `$ARGUMENTS` in the skill body where the arguments should be inserted. Use `$0`, `$1`, etc. for positional access.
2. Add `argument-hint` to frontmatter — it appears in autocomplete next to the command name.

```yaml
---
name: deploy
description: Deploy the application to a target environment.
argument-hint: "[environment]"
disable-model-invocation: true
---

Deploy to the $0 environment.
```

If `$ARGUMENTS` is not present in the body but arguments are passed, Claude Code appends them automatically as `ARGUMENTS: <value>`. Full substitution syntax is in `about-agent-skills/references/substitutions.md`.

## When to Omit `disable-model-invocation`

Not every command needs it. If it makes sense for the agent to invoke the command on the user's behalf — for example, a lightweight helper with no side effects — omit the flag. The deciding question is: **does this action require explicit user intent?** If yes, set it. If no, omit it.

# Related Skills

YOU MUST load `about-agent-skills` for skill structure, frontmatter, and architecture principles.

## Source for this Skill

This is a local skill for the `sous` project. Since `sous` uses its CLI to compile its own LLM configs, you cannot
edit the skill output directly. Instead, you need to edit the template.

- Source Path: /home/luke/Projects/puravida/infra/sous/.sous/prompts/skills/about-commands/SKILL.tpl.md