# Architecture

The system has six framework modules (in this skill's `scripts/`) plus the
user's own scripts (in the project's configured scripts directory).

## Components

1. **`keyring.mjs`** — Reads Chrome's Safe Storage password from the OS keyring
   (GNOME keyring) via the D-Bus Secret Service API. Pure JS (`dbus-next`), no
   native deps, no Python. Exports `getChromeSafeStoragePassword()`.

2. **`chrome-state.mjs`** — Reads cookies from Chrome's `Cookies` SQLite DB
   (read-only; Chrome stays open), decrypts them with a PBKDF2 key derived from
   the keyring password, and builds a Playwright `storageState` object. Exports
   `extractCookies()`, `buildStorageState()`, `listProfiles()`.

3. **`logger.mjs`** — Plain prefixed-line logger. `createLogger(prefix)` returns
   `{ info, warn, error, child }`; `child(section)` extends the prefix.

4. **`utils.mjs`** — `createUtils(page, logger)` builds the `ctx.utils` toolkit,
   bound to the live page (modal dismissal, waits, text extraction, screenshot,
   retry, …). See `ctx-api.md`.

5. **`params.mjs`** — `resolveParams(meta, explicit, settings)` resolves params
   in priority order and validates them, throwing `ParamError` on failure.

6. **`harness.mjs`** — `runScript(script, params, options)`. Resolves/validates
   params, extracts cookies, launches headless Chromium with the injected
   storageState, builds `ctx`, runs `execute(ctx)` under an overall timeout, and
   returns a result envelope. Defines `AuthError` and `ctx.checkAuth()`.

7. **`run.mjs`** — CLI entry point. Parses `--key=value` args into harness
   options vs. script params, loads compiled `settings.mjs`, imports the target
   script by absolute path, prints resolved params, runs, reports, writes any
   `outputFile`.

## Data Flow

```
run.mjs
  ├─ parse args → { params, options }
  ├─ load settings.mjs → ctx.settings
  ├─ import <script>.mjs
  └─ runScript(script, params, { ...options, settings })
        ├─ resolveParams(meta, params, settings)   ← validation gate
        ├─ chrome-state.buildStorageState()
        │     └─ keyring.getChromeSafeStoragePassword()
        ├─ chromium.launch({ headless }) + newContext({ storageState })
        ├─ build ctx { page, params, settings, logger, utils, checkAuth, runChild }
        └─ script.execute(ctx) → result
  └─ report result, write outputFile
```

## Result Envelope

`runScript` always returns `{ success, ... }`:

- success → `{ success: true, data: <script return value> }`
- param failure → `{ success: false, error: 'params', message }`
- auth failure → `{ success: false, error: 'auth', message, url, indicators }`
- other failure → `{ success: false, error: 'script', message, stack }`
