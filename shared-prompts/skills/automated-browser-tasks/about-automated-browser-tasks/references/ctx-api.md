# The `ctx` API

Every script's `execute(ctx)` receives a single context object. Destructure what
you need at the top of each function.

## Core members

| Member | Type | Description |
|--------|------|-------------|
| `ctx.page` | `Page` | Playwright page. Primary interaction surface. |
| `ctx.context` | `BrowserContext` | The browser context (cookies already injected). |
| `ctx.browser` | `Browser` | The Chromium instance. |
| `ctx.params` | object | Fully resolved + validated params. |
| `ctx.settings` | object | Compiled project settings (from `settings.mjs`). |
| `ctx.timeout` | number | Overall timeout (ms); use for `goto`/wait calls. |
| `ctx.logger` | Logger | Prefixed logger (see below). |
| `ctx.utils` | object | Generic action helpers (see below). |
| `ctx.debug` | object | Exploration & debugging tools (see below). |
| `ctx.checkAuth()` | fn | Throws `AuthError` if the current URL looks like a login page. Call after every navigation. |
| `ctx.runChild(script, params)` | fn | Run another script module in the same browser context; returns its result. Child gets its own resolved params, logger, and utils. |

## `ctx.logger`

Plain prefixed lines. `info` → stdout; `warn`/`error` → stderr, tagged.

```js
const log = ctx.logger.child('navigate');   // prefix: [script-name:navigate]
log.info('Loading repo');                    // [script-name:navigate] Loading repo
log.warn('modal not found, using Escape');   // [script-name:navigate] WARN ...
```

## `ctx.utils`

Built per-run, bound to the live `page` and the script's logger. All are async
unless noted.

| Helper | Signature | Description |
|--------|-----------|-------------|
| `autoDismiss` | `(triggerLocator, dismiss)` | **Preferred** modal handling: register a `page.addLocatorHandler` so `dismiss` runs whenever `triggerLocator` blocks an action. Timing-independent — no sleeps, no races. Use for any modal/banner that may appear asynchronously. |
| `dismissModals` | `(selectors, { timeout? })` | One-shot best-effort dismissal of modals KNOWN to be present already. Clicks the first of each candidate selector that currently exists; no fixed delays. For async modals, use `autoDismiss`. |
| `clickByText` | `(text, { force?, timeout? })` | Wait for and click the first element matching `text` (RegExp or string). `force` defaults **false** (auto-waits for actionability). |
| `waitForText` | `(text, { timeout? })` | Wait for text to appear; does not click. |
| `extractLongestText` | `(selectors, { minLength? })` | Longest `textContent` across candidate selectors meeting `minLength`, or null. |
| `extractTextByPattern` | `(pattern, { source?, group? })` | First regex match from page body (or supplied `source`); returns trimmed match or null. |
| `screenshot` | `(path, { fullPage? })` | Save a debug screenshot. Failures are logged, never thrown. |
| `scrollIntoView` | `(selector)` | Scroll matching element into view; returns boolean found. |
| `retry` | `(fn, { attempts?, delay?, label? })` | Retry an async fn; throws the last error if exhausted. |

### On `force` clicks

Non-forced clicks are the resilient default: Playwright auto-waits for the element
to be visible, stable, and not covered before clicking — which naturally waits out
overlays and transitions. `force: true` bypasses those checks and is fire-and-forget
(it can "succeed" while landing on nothing), so reserve it for the rare element a
component library (e.g. Blueprint.js) wrongly reports as disabled — and verify the
outcome with a follow-up wait. There is no `waitForSPA` helper: do not wait on
`networkidle` as a readiness signal (see `script-conventions.md` → Waits); wait for
the specific element/text you need instead.

## `ctx.debug`

Tools for **observing the real page** so you build waits and selectors from facts,
not guesses. Conventions require observing a page before automating it
(`script-conventions.md` → "observe the real page"); these are how. Built per-run,
bound to the live `page`/`logger`. All are async and none throw (a debug aid must
never break a run). Artifacts are written under `ctx.debug.dir` (a unique per-run
directory under the OS temp dir, created lazily on first write).

| Tool | Signature | Description |
|------|-----------|-------------|
| `screenshot` | `(name?, { fullPage? })` | Save a PNG; returns its path (or null). |
| `html` | `(name?)` | Save the current page HTML; returns its path. |
| `dump` | `(name?)` | Full snapshot — URL, title, visible text, screenshot, HTML — to the debug dir; returns `{ dir, url, title, files, textPreview }`. The go-to "what does this page look like right now?" tool. |
| `describe` | `(selector, { limit? })` | What a CSS selector matches: `{ count, elements[] }` with tag/role/id/classes/text/visibility/href. Fastest way to check a selector is right. |
| `count` | `(selector)` | Number of matches. |
| `clickables` | `({ limit? })` | List visible interactive elements (anchors, buttons, role buttons/tabs/links, onclick). Use when the obvious `<a>`/button doesn't exist and the real control is a click-handled div. |
| `findText` | `(pattern, { limit? })` | Where does this text live? For each match, the owning element AND its clickable ancestor — i.e. *what to click* to act on that text. Matches text on an element's own text nodes (works even when the element also has icon/element children). |
| `watch` | `(fn, { samples?, intervalMs?, label? })` | Sample a browser-side metric over time and log how it evolves. Answers "WHEN is this ready?" — e.g. `watch(() => document.body.innerText.length)` exposes that `networkidle` fired on an empty shell. Returns `[{ t, value }]`. |
| `dir` | getter | Absolute path to this run's artifact directory. |

### Auto-capture on failure

When a script throws an unexpected error, the harness automatically runs
`debug.dump('failure')` before closing the browser and reports the directory in the
result (`result.debugDir`, printed by the runner). So a failed run leaves a
screenshot, HTML, and text snapshot of the exact failing state with no extra code.

### The intended workflow

1. Stuck on a selector or timing? `await ctx.debug.dump()` and look at the files.
2. Selector returning nothing? `describe(it)` / `clickables()` / `findText(text)`
   to discover the real element (and its clickable ancestor).
3. Wait firing too early/never? `watch(() => <metric>)` to find the moment the
   page is genuinely ready, then wait on that concrete signal.
4. Remove debug calls (or leave a couple of cheap ones) once the script is solid;
   `dump`/`screenshot`/`html` write files, so don't leave those in hot loops.
