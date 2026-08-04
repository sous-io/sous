# Example: Topical Skill (`about-*`)

```markdown
---
name: about-deployments
description: >
  YOU MUST load this skill when working with deployments, deployment config, or when
  the user mentions "deploy". Covers what a deployment is, how they work in this
  project, and where deployment configuration lives.
user-invocable: false
---

# Abstract

This "topical skill" provides information about a specific concept: deployments.

## About Deployments

A deployment is the process of publishing a built application to a target environment.
In this project, deployments are managed via the `deploy/` directory and driven by
scripts in `deploy/scripts/`.

Deployments target three environments: `staging`, `production`, and `preview`. Each
has its own configuration file under `deploy/config/`.

## Reference Files

- [references/environments.md](references/environments.md) — per-environment config
  options, required env vars, and access requirements
- [references/rollback.md](references/rollback.md) — rollback procedures and known
  failure modes

# Other Skills

## Action Skills

Action skills for deployments will have "deploy" in their name. Find the appropriate
action skill for what you want to do. If no appropriate action skill exists, ask the
user whether one should be created before continuing.

## Related Skills

You MUST load `about-infrastructure` for network and hosting context relevant to
deployments.
```
