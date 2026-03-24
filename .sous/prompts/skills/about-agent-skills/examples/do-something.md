# Example: Action Skill (Command)

```markdown
---
name: deploy
description: >
  YOU MUST use this skill when deploying the application. Do not use for rollbacks —
  those follow a different process.
disable-model-invocation: true
---

# Abstract

This "action skill" (command) performs a specific operation: deploying the application
to a target environment.

A deployment publishes the built application to a hosting environment. This project
supports three environments: `staging`, `production`, and `preview`.

## Deploying

You MUST load `about-deployments` before proceeding. Then run the deploy script for
the target environment:

```bash
bash ${CLAUDE_SKILL_DIR}/../../deploy/scripts/deploy.sh $ARGUMENTS
```

# Related Skills

You MUST load `about-deployments` for environment config, required env vars, and
access requirements.
```
