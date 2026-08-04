---
name: running-automated-browser-tasks
description: >
  YOU MUST load this skill when you need to run an existing headless browser
  automation script for the user — to execute a task, fetch data from a site, or
  verify a script you just wrote or changed.
---

# Run an Automated Browser Task

A thin action skill. The agent performing this work MUST load
`about-automated-browser-tasks` for the architecture and the meaning of `ctx`,
auth handling, and result shapes.

## Delegation

Per the sub-agent delegation pattern
(`~sous-shared/_partials/sub-agent-delegation.md`), a browser run is a slow, multi-step
execution: delegate it to a background sub-agent, which runs the command,
interprets the outcome below, and reports the result plus any link or actionable
message. Run a one-off script inline only when its result blocks the very next
step.

## Invocation

Run a script by its absolute path through the runner in this system's `scripts/`
directory:

```bash
node <scriptsDir>/run.mjs <absolute-path-to-script.mjs> [--param=value ...]
```

- Pass script params as `--paramName=value`.
- Harness options: `--profileName=<name>` (Chrome profile), `--timeout=<ms>`.
- The runner loads compiled project `settings.mjs` automatically and prints the
  resolved params (marking which came from defaults/settings) before running.

## Reading the outcome

- **Success** → `✓` and the result is printed; if the script returned an
  `outputFile` + `content`, the runner writes the file and reports the path.
- **`error: params`** → a required param was missing or failed validation. Fix the
  invocation; do not edit the script to bypass validation.
- **`error: auth`** → the session was redirected to a login page. The user must log
  in to the site in their Chrome profile, then the SAME command is re-run; no
  script change needed. A sub-agent cannot ask for this: return the actionable
  message and the link to the orchestrator, which relays them to the user and
  re-dispatches the run afterward.
- **`error: script`** → an unexpected failure with a stack. Inspect, then use
  `update-automated-browser-task` to fix the root cause and re-run.

Never silently swallow a failure or fake a result. Report what happened.

## Source for this Skill

This skill was pulled from the `sous` project's "shared skills" library. It was compiled from a template and
the output file should not be edited directly.

- Source Path: {{ sousTemplatePath }}
