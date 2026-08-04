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

## Choosing the profile

The Chrome profile defaults to `Default`. Override per run with
`--profileName="Profile 1"`, or set a project default in settings
(`chromeProfile`) so it flows in via `ctx.settings`.

## Detecting auth failures

Cookies expire; SSO sessions lapse. After each navigation a script should call
`await ctx.checkAuth()`. It inspects the current URL for login indicators
(`/login`, `/sso`, `multipass`, `accounts.google.com`, etc.) and throws an
`AuthError` if found.

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
