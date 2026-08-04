# Script Conventions

These rules are non-negotiable. A reviewer (or linter) should be able to reject a
script that violates them.

## Quality bar: bulletproof or it doesn't ship

A flaky script is a broken script. "Works most of the time" is failure. Write for
100% reliability across many consecutive and parallel runs from the first draft —
do not ship something that "usually works" and plan to harden later.

The single greatest source of flakiness is **guessing about timing instead of
waiting for facts**. Every wait must key off a concrete, observable condition that
*proves* the thing you need is ready. Spend the extra time to find that signal.
Arbitrary delays (`waitForTimeout`) are the enemy — see [Waits](#waits); they are
effectively banned.

Before writing a single wait or selector, **observe the real page.** Do not assume
DOM structure. Build your waits from what you actually see — selectors invented
from imagination are how you get a script that passes once and fails in CI.

`ctx.debug` exists for exactly this (full surface in `ctx-api.md`):

- `ctx.debug.dump()` — snapshot URL, title, text, screenshot, and HTML to disk.
- `ctx.debug.describe(selector)` / `ctx.debug.clickables()` — see whether a
  selector matches and what the real interactive elements are (often a
  click-handled `div`, not the `<a>`/`<button>` you assumed).
- `ctx.debug.findText(text)` — locate text and the clickable ancestor to target.
- `ctx.debug.watch(() => metric)` — sample a metric over time to find the *moment*
  the page is genuinely ready (this is how you discover that `networkidle` fired
  on an empty shell), then wait on that concrete signal.

On an unexpected throw, the harness auto-captures a failure snapshot
(`result.debugDir`) — check it first when a run fails. Remove file-writing debug
calls (`dump`/`screenshot`/`html`) once the script is solid; keep them out of hot
loops.

## Structure

`execute(ctx)` is a thin orchestrator that reads like a table of contents. All
real work lives in small, named step functions defined below `execute` in the
same file.

- One discrete action per step function (navigate, dismiss, extract, parse…).
- ≤ 30 lines per function; 10 or fewer is ideal.
- Module-level functions, not class methods.
- Generic patterns → `ctx.utils`. Site-specific patterns → step functions (which
  a project may later factor into shared libs it imports).

## Doc-blocks

EVERY function — `execute` included — has a proper JSDoc block: a description
line plus `@param` for every argument and `@returns`. Use
`@returns {Promise<void>}` for functions that return nothing. Single-line
`/** … */` comments are NOT sufficient.

## Destructuring

Each function destructures the members it needs off `ctx` (and off `params`) at
the top of its body, so the body never repeats `ctx.`/`params.` prefixes:

```js
async function navigateToRepo(ctx, baseUrl, repoId) {
  const { page, logger, timeout, checkAuth } = ctx;
  ...
}
```

## Params (`meta.params`)

The framework resolves and validates params before `execute` runs. Scripts never
validate their own params. Resolution priority (low → high):
`ctx.settings` < `meta.params[x].default` < explicit (CLI) params.

Each param spec:

| Field | Type | Meaning |
|-------|------|---------|
| `required` | boolean | Error if nothing resolves. |
| `default` | any | Fallback value. |
| `description` | string | Be genuinely descriptive: what it is, where to find it, how it's used, consequence of omitting. Shown in listings and errors. |
| `validate` | `RegExp` \| `Function` | See below. |
| `invalidMessage` | string | Error for a failing RegExp, or a `validate` fn returning `false`. |

`validate`:
- **RegExp** — resolved value (as string) must match.
- **Function** `(value, resolvedParams) => true | false | string` — `true` valid;
  a returned `string` is used as the error; `false` falls back to `invalidMessage`.
  The function gets all resolved params, enabling cross-param checks.

All failures across params are collected into one `ParamError`.

## Logging

Use `ctx.logger`, never `console.log`. Create a child per section:
`const log = ctx.logger.child('navigate')`. Output is
`[script-name:section] message`. Levels: `info`, `warn`, `error`.

## Return shape

Return a plain object. Common keys:

- `found: boolean` — whether the target content was located.
- `content: string` — extracted content (when found).
- `outputFile: string` — path for the runner to write `content` to.
- a URL key (e.g. `buildUrl`) — where content was found.
- `message: string` — human-readable explanation, especially on failure.

On `found: false`, include diagnostics (`pageTextPreview`, `message`).

## Verify every action

Do not assume an action took effect — prove it. After every navigation or click
that changes state, wait for a signal that confirms the *intended outcome*:

- After a navigation: `await page.waitForURL(/expected-path/)`, or wait for an
  element that only exists on the destination.
- After a click that should open a view: wait for that view's content, not just
  for the click to return.
- After triggering content load: wait for the content to be present AND non-empty
  (e.g. a `<pre>` whose text length exceeds a threshold), not merely attached.

A click with `{ force: true }` is fire-and-forget: it bypasses Playwright's
actionability checks (visible, stable, not covered) and reports success even when
it lands on nothing. Prefer a plain click — Playwright then auto-waits for the
element to be actionable, which naturally waits out overlays and transitions.
Reserve `force` for the rare element a component library wrongly reports as
disabled, and even then verify the outcome afterward.

## Error handling

Throw on unexpected failures; the harness catches and reports. Never
catch-and-continue to paper over a problem. Auth failures come from
`ctx.checkAuth()`; page-interaction failures (missing element, timeout) should
propagate naturally. Fix root causes, not symptoms.

**Auth resolves late in SPAs.** A single-page app often loads its shell, *then*
decides client-side that the session is invalid and redirects to a login page a
beat later. So:
- Do NOT call `ctx.checkAuth()` immediately after `goto` — the redirect may not
  have happened yet (false pass) and the URL may not have settled.
- Do NOT race the success signal against the login URL — a valid session can
  *transiently* touch a login-ish URL before bouncing back (false fail).
- DO wait for your success signal (the authenticated view's element). Only if that
  times out, *then* call `ctx.checkAuth()` — by then the URL has settled, so a
  login page is a real `AuthError` and anything else is a genuine render timeout.

## Naming

- Files: `verb-noun-qualifier.mjs` (e.g. `get-repo-ci-error.mjs`).
- Step functions: `verbNoun` camelCase (`navigateToRepo`, `dismissModals`).
- Log sections: short, lowercase, no spaces (`navigate`, `dismiss`, `extract`).

## Waits

Wait for **specific, verifiable things** — never for time. This is the rule that
makes scripts bulletproof.

### `waitForTimeout` is effectively banned

A fixed sleep is a bet that something will be ready by then. The bet loses
intermittently — that is precisely what flakiness *is*. Exhaust every avenue for a
condition-based wait before even considering a sleep:

1. Wait for an element/state that proves readiness (`locator.waitFor`,
   `page.waitForURL`, `expect(locator).toBeVisible()`).
2. Wait for a content predicate via `page.waitForFunction(() => …)` when readiness
   is "the data populated", not just "an element exists".
3. Wait for a network response (`page.waitForResponse`) when the DOM gives no
   signal but a known request does.
4. Install a handler for interrupting UI (`page.addLocatorHandler`, below) instead
   of sleeping to "let a modal pass".

Only if ALL of these are genuinely impossible may you fall back to
`page.waitForTimeout` — and then you must (a) keep it short, (b) write a comment
explaining what DOM-observable signal you searched for and why none exists, and
(c) feel bad about it. Treat each one as a defect to be removed later. A script
should aim for **zero** `waitForTimeout` calls.

### `networkidle` is NOT a readiness signal

`waitForLoadState('networkidle')` means "the network went quiet", which in a
modern SPA happens long before — or long after — the content you want renders.
A large SPA commonly hits network idle while the DOM is still an empty ~600-char
shell, with every real value still to be fetched and rendered client-side. Never
treat `networkidle` as "the page is ready". Wait for the *specific element or
text* you need instead. Use `domcontentloaded` for the initial `goto`, then a
concrete element wait.

### Pick a signal that proves the exact thing you need

- "Tab bar loaded" → wait for a specific named tab to be visible.
- "List rendered" → wait for a row's distinguishing text (e.g. a commit hash
  pattern), not a generic container that exists while empty.
- "Log loaded" → wait for the log element AND a length/content predicate, so an
  empty placeholder doesn't satisfy the wait.

### Virtualized lists/grids → set a tall viewport, don't scroll-accumulate

A virtualized list or grid renders only the rows within the scroll viewport (a
31-row table may put only ~17 rows in the DOM). A single DOM sweep then
silently returns a partial set. The cheap, robust fix is to enlarge the viewport
BEFORE navigating, so the grid materializes every row at once:

```js
await page.setViewportSize({ width: 1600, height: 20000 }); // then goto()
```

This overrides the harness's default 1920×1080 per-page and needs no harness change.
Prefer it over a scroll-accumulate loop: far less code, no timing loop. Then **verify
completeness** — extract the count the UI advertises (e.g. a "Properties 31" header
badge) and assert the extracted row count equals it, so a clipped read fails loud
instead of returning a silent subset. A tall viewport is not universal: a virtualizer
bounded by its own container's fixed CSS height can still clip regardless of window
size — the assertion is what catches that, and scroll-accumulate is the fallback.

### Unpredictable interrupting UI → `addLocatorHandler`, not sleeps

Modals/banners that appear at an unpredictable moment (welcome dialogs, "what's
new", cookie prompts) are a classic flake source: dismiss-then-continue races the
modal's appearance. Register a handler once; Playwright auto-runs it whenever that
element would block an action — fully timing-independent:

```js
await page.addLocatorHandler(
  page.getByRole('dialog').filter({ has: page.getByRole('button', { name: 'Close' }) }),
  async (dialog) => { await dialog.getByRole('button', { name: 'Close' }).click(); }
);
```

### Timeouts

Pass `ctx.timeout` to waits rather than hardcoding numbers, so a slow environment
can be accommodated centrally. A generous timeout on a *correct* condition is
fine — it only ever waits as long as it must, then proceeds the instant the
condition holds. That is the opposite of a fixed sleep.

### Prefer robust locators

Favor role/text/label locators (`getByRole`, `getByText`, `getByLabel`) and stable
attributes (`data-testid`) over brittle CSS/class chains — component-library class
names (`bp6-…`) change between versions. When the only distinguishing feature is
visible text, a text/regex locator is more durable than a guessed class.
