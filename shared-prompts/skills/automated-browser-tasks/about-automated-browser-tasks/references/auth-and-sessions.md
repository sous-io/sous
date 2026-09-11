# Auth & Sessions

Scripts run as the logged-in user without any manual login step, and without
closing or controlling the user's running Chrome.

## How auth works

1. The harness reads the user's Chrome `Cookies` SQLite DB **read-only** — Chrome
   can stay open; there is no lock conflict.
2. Cookie values are encrypted. The harness fetches Chrome's "Safe Storage"
   password from the OS keyring (GNOME keyring) over the D-Bus Secret Service
   API, derives an AES key (PBKDF2, salt `saltysalt`, 1 iteration, SHA1, 16
   bytes), and decrypts each cookie.
   - **v10**: AES-128-CBC, IV = 16 spaces.
   - **v11**: AES-128-CBC, IV embedded in bytes 3–18; strip a 16-byte random
     prefix from the decrypted plaintext.
3. Decrypted cookies become a Playwright `storageState`, injected into a fresh
   headless context. The browser is now authenticated as the user.

This is all local. Nothing leaves the machine. No Python; pure JS via
`dbus-next`, `better-sqlite3`, and Node's `crypto`.

## !important Only COOKIES cross over — app-side draft state does NOT

The harness injects a `storageState` built from cookies into a **fresh** headless context. It
does not clone the user's tab, its memory, or any server-side per-session scratch space. Two
consequences that shape how multi-step work has to be designed:

**1. Every run starts with an empty app-side edit buffer.** An editor that accumulates uncommitted
changes (Foundry's Ontology Manager is the reference case) will be **clean** at the start of each
run, and any buffer a run leaves uncommitted **dies with the session**. So:

- A "make one edit, save, retry, repeat" loop over separate runs **cannot terminate** when the
  server validates the whole document and rejects it for an unrelated reason. Each run's lone edit
  is rejected, then discarded.
- A multi-edit repair needs **ONE task that composes the others inside a single session**. The
  pattern: delegate each edit to the existing single-edit task with `save=false` via
  `ctx.runChild`, assert the buffer grew by exactly one per step, then delegate one commit to the
  save task. The composing task should click nothing itself.
- `save=false` is therefore **not a dry run you can inspect afterwards** — it throws the work away.

**2. A "buffer is clean" check is scoped to a fresh session.** It cannot see uncommitted work
sitting in the user's own open tab. Say so when reporting it; "clean" means "nothing uncommitted
visible to a new session", not "the user has no unsaved work".

## Choosing the profile

The Chrome profile defaults to `Default`. Override per run with
`--profileName="Profile 1"`, or set a project default in settings
(`chromeProfile`) so it flows in via `ctx.settings`.

## Detecting auth failures

Cookies expire; SSO sessions lapse. After each navigation a script should call
`await ctx.checkAuth()`. It throws an `AuthError` when the current URL is a login
screen. The check is **path-aware, not substring-based**: identity providers are
matched by host (`accounts.google.com`, `login.microsoftonline.com`), and login
routes by pathname, either exactly or as a `/`-delimited prefix (`/multipass/login`
for Foundry, plus `/login`, `/signin`, `/sso`). It deliberately does NOT match a
bare `multipass` (that would hit every `ri.multipass..organization.<uuid>` RID in a
Control Panel URL) or a bare `/auth/` (`/auth/callback` is where an OAuth sign-in
SUCCEEDS).

The harness catches `AuthError` and returns:

```
{ success: false, error: 'auth', message, url, indicators }
```

The `message` is actionable and meant to reach the user verbatim. A sub-agent
returns it to the orchestrator, which relays it:

> Authentication required... Log in to the target site in your Chrome browser
> (profile: "Default"), then retry this script.

## The retry contract

There is no mid-script recovery. On an auth failure:

1. The message reaches the user, who logs into the site in their Chrome profile.
2. Re-run the **same** command. The harness re-reads the now-valid cookies.

A sub-agent cannot wait for a login, so it stops at step 1 and reports; the
orchestrator relays the message and dispatches the re-run.

Never attempt to script the login itself, and never weaken `checkAuth` to get
past a login wall.

## Scope cookie extraction

Extraction can be limited to domain substrings for speed/privacy. The harness
`domains` option (and `extractCookies(profile, domains)`) filters
`host_key LIKE '%domain%'`. Leave null to extract all cookies.
