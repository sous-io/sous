---
name: about-automated-browser-tasks
description: >
  YOU MUST load this skill when the user asks you to do anything that requires
  interacting with a web browser, or when no MCP server or API can accomplish a
  task and the only path forward is browser-based actions. Before telling the
  user to do something manually in a browser, check for an existing automation
  script and offer to run or write one. When browser work is needed, look for an
  existing script first; create one only if none exists.
user-invocable: false
---

# Automated Browser Tasks

This system lets you write, run, and reuse headless browser automation scripts
(Playwright) that authenticate as the user by borrowing their existing Chrome
session — no manual login, no visible browser, Chrome stays open.

When a task needs a browser and no API/MCP server can do it, this is the default
path. Do not instruct the user to click through a browser manually if the task
can be scripted.

## How It Works (cold-start orientation)

1. **Auth is automatic.** A harness reads cookies from the user's Chrome profile,
   decrypts them locally (via the OS keyring), and injects them into a fresh
   headless browser context. Scripts "just work" as the logged-in user.
2. **Scripts are small modules.** Each script file exports `meta` (name,
   description, params) and `execute(ctx)`. The harness resolves + validates
   params, builds `ctx`, and runs `execute`.
3. **You run scripts by absolute path** through the runner:
   ```bash
   node <scriptsDir>/run.mjs <absolute-path-to-script.mjs> [--param=value ...]
   ```
4. **Scripts return a result object**; the runner prints it and writes any
   `outputFile`. Auth failures are detected and reported with an actionable
   message telling the user to log in, then you retry.

The framework code (harness, chrome-state, keyring, logger, utils, params,
run) lives in this skill's `scripts/` directory. User scripts live in the
project's configured scripts directory and are invoked by path.

## The `ctx` Object

Every script's `execute(ctx)` receives:

- `ctx.page` — Playwright `Page`
- `ctx.context` / `ctx.browser` — Playwright context / browser
- `ctx.params` — fully resolved + validated params
- `ctx.settings` — compiled project settings (from `settings.mjs`)
- `ctx.timeout` — overall timeout (ms)
- `ctx.logger` — prefixed logger; `ctx.logger.child('section')` for sections
- `ctx.utils` — generic action helpers (modal dismissal, waits, text extraction, …)
- `ctx.debug` — exploration & debugging tools (dump, describe, findText, watch, …)
- `ctx.checkAuth()` — throws `AuthError` if redirected to a login page
- `ctx.runChild(script, params)` — run another script in the same browser context

Full details: [references/ctx-api.md](references/ctx-api.md).

## Writing Scripts — Non-Negotiable Conventions

- `execute()` is a thin orchestrator; logic lives in small named step functions.
- EVERY function (including `execute`) has a full JSDoc block (`@param`/`@returns`).
- Destructure what you need off `ctx`/`params` at the top of each function.
- Use `ctx.logger`, never `console.log`.
- Do NOT validate params in the script — declare rules in `meta.params`.
- Fail fast; do not catch-and-continue. Fix root causes, not symptoms.

Full conventions: [references/script-conventions.md](references/script-conventions.md).

## Reference Files

- [references/architecture.md](references/architecture.md) — components and data flow
- [references/ctx-api.md](references/ctx-api.md) — complete `ctx` and `ctx.utils` API
- [references/auth-and-sessions.md](references/auth-and-sessions.md) — how auth works, auth failures, retries
- [references/script-conventions.md](references/script-conventions.md) — full scriptwriting rules
- [references/installation.md](references/installation.md) — dependencies and setup

## Examples

- [examples/simple-fetch.mjs](examples/simple-fetch.mjs) — single-page data extraction
- [examples/chained-workflow.mjs](examples/chained-workflow.mjs) — a script calling another via `ctx.runChild`
- [examples/auth-failure-handling.mjs](examples/auth-failure-handling.mjs) — the auth-failure + retry pattern

# Other Skills

The agent performing the work MUST load `create-automated-browser-task` when
creating a new automation script, `update-automated-browser-task` when modifying an
existing script, and `running-automated-browser-tasks` when running a script.

Per the sub-agent delegation pattern
(`~sous-shared/_partials/sub-agent-delegation.md`), all three are delegated to a background
sub-agent, which loads the skills itself and reports back. Auth failures and other
user-facing messages go to the orchestrator to relay; sub-agents cannot talk to the
user.

## Source for this Skill

This skill was pulled from the `sous` project's "shared skills" library. It was compiled from a template and
the output file should not be edited directly.

- Source Path: {{ sousTemplatePath }}
