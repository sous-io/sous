---
name: update-automated-browser-task
description: >
  YOU MUST load this skill when you need to modify, fix, or extend an existing
  headless browser automation script — for example when a script breaks because
  a site's markup changed, or a new param/behavior is needed.
---

# Update an Automated Browser Task

A thin action skill. The agent performing this work MUST load
`about-automated-browser-tasks` for the architecture, `ctx` API, and full
conventions.

## Delegation

Per the sub-agent delegation pattern
(`~sous-shared/_partials/sub-agent-delegation.md`), the fix-and-re-run loop below
is delegated to one Opus sub-agent, which reports what broke, what it changed, and the verified
result. Give it the script path and the failing run output.

## Steps

1. **Read the script** and the run output. Identify the failing step from the
   logger prefixes (`[script:section]`) in the output.
2. **Reproduce** by running it (see `running-automated-browser-tasks`). For
   selector/markup failures, inspect the live page — use `ctx.utils.screenshot`
   or widen selectors; do not guess.
3. **Make the smallest correct change.** Fix the root cause, not the symptom. Keep
   the existing decomposition: edit the relevant step function, add a new one if a
   new discrete action is needed.
4. **Preserve conventions.** Maintain JSDoc blocks, `ctx`/`params` destructuring,
   `ctx.logger` usage, and `meta.params` validation. If you add a param, give it a
   description and a `validate` rule.
5. **Re-run to verify** the fix end-to-end.

## When NOT to update

If the change amounts to a different task, create a new script instead
(`create-automated-browser-task`). Keep each script focused on one job.

## Source for this Skill

This skill was pulled from the `sous` project's "shared skills" library. It was compiled from a template and
the output file should not be edited directly.

- Source Path: {{ sousTemplatePath }}
