---
name: create-automated-browser-task
description: >
  YOU MUST load this skill when you need to create a new headless browser
  automation script — i.e. a browser task is required and no existing script
  performs it. Produces a convention-compliant script in the project's
  automation scripts directory.
---

# Create an Automated Browser Task

A thin action skill. The architecture, `ctx` API, and full conventions live in
the parent topic skill; the agent performing this work MUST load
`about-automated-browser-tasks`.

## Delegation

Per the sub-agent delegation pattern
(`~sous-shared/_partials/sub-agent-delegation.md`), writing and iterating on a script is
delegated work: one Opus sub-agent writes it, runs it, and iterates against the
real page until it works, then reports the script path and result. Give it the
target URL, the data to extract, and the params wanted.

## Steps

1. **Confirm none exists.** Search the project's automation scripts directory for
   a script that already does this. If one is close, prefer
   `update-automated-browser-task` instead.
2. **Name the file** `verb-noun-qualifier.mjs` (e.g. `get-repo-ci-error.mjs`).
3. **Declare `meta`** — `name`, a descriptive `description`, and `params`. For each
   param set `required`, `default`, a genuinely descriptive `description`, and a
   `validate` rule (RegExp or function) with an `invalidMessage`. Pull shared
   values (URLs, resource IDs, profile) from `ctx.settings` rather than hardcoding.
4. **Write `execute(ctx)`** as a thin orchestrator that calls small, named step
   functions. Destructure off `ctx`/`params` at the top. Use `ctx.logger`, never
   `console.log`. Use `ctx.utils` for generic patterns; keep site-specific logic
   in step functions. Give EVERY function a full JSDoc block.
5. **Return a result object** (`found`, `content`, `outputFile`, a URL, `message`).
6. **Run it** to verify — see `running-automated-browser-tasks`. Iterate on the
   real page; do not guess selectors.

## Reference

The exact param spec, `ctx.utils` surface, return shape, and worked examples are
in the topic skill's references and `examples/`. Read them — do not improvise.

## Source for this Skill

This skill was pulled from the `sous` project's "shared skills" library. It was compiled from a template and
the output file should not be edited directly.

- Source Path: {{ sousTemplatePath }}
