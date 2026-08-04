# Installation

## Runtime & platform

- Node.js ≥ 22.
- Linux with a GNOME-keyring-compatible Secret Service (the user's Chrome must
  have stored its Safe Storage key there — true after Chrome has run once on a
  desktop session with an unlocked keyring).
- Google Chrome installed with at least one profile the user has logged into.

macOS (Keychain) and Windows (DPAPI) are not yet supported by `keyring.mjs`.

## Dependencies

The runner and harness import these at runtime; the framework does not bundle
them. Install them **at the consuming project's root** — NOT globally.

Why not global: the scripts use ESM `import 'playwright'`. ESM resolves bare
imports by walking *up* the directory tree from the importing file looking for a
`node_modules`. The compiled runner lives at
`<projectRoot>/.claude/skills/about-automated-browser-tasks/scripts/run.mjs`, so a
`node_modules` at `<projectRoot>` is found by walking up; a global npm install is
never on that resolution path.

```bash
cd <projectRoot>        # the repo root that contains .claude/skills/
npm install playwright better-sqlite3 dbus-next
npx playwright install chromium
```

Add a `package.json` at `<projectRoot>` if none exists (`{"type":"module","private":true}`)
and gitignore `node_modules/`.

- `playwright` — headless browser automation.
- `better-sqlite3` — reads Chrome's `Cookies` SQLite DB.
- `dbus-next` — pure-JS D-Bus client for the keyring (no Python, no native build).

Tested with: Playwright 1.61, better-sqlite3 12.x, Node 22, Chrome cookie format
v11, Ubuntu 22.04.

## Project wiring (via sous)

A downstream project compiles this bundle into its skills directory and compiles
`settings.tpl.mjs` → `settings.mjs` (sibling of `run.mjs`) so scripts get
`ctx.settings`. Example compilation targets:

```js
compilation: {
  targets: [
    {
      // The skills (SKILL.tpl.md, references, examples, scripts) → skills dir
      entryGlob: "${sousRootPath}/shared-prompts/skills/automated-browser-tasks/**/*",
      outputs: [{ destinationDir: "${projectRoot}/.claude/skills" }],
    },
  ],
}
```

Define project values (`chromeProfile`, base URLs, resource IDs, …) in `_vars`. The
`{% exportScalarVarsJs %}` tag in `settings.tpl.mjs` emits all in-scope scalars
as the runtime settings module — no per-key wiring needed. Be sure to define
`browserAutomationScriptsDir` (the absolute path to the project's task scripts)
in `_vars` — both the runtime and the task manifest below rely on it.

## Task manifest in core memory

So the agent always knows which browser tasks exist (without relying on a skill
trigger firing), render the shared memory partial into the project's memory source
tree, then `@include` it from a core-memory file. It renders a live list of every
task script via `{% getFiles … import="meta" %}`, reading each script's `meta`.

`@include` does NOT substitute variables, so you cannot `@`-include the shared
`INDEX.tpl.md` by an absolute `${...}` path. Instead, add a compilation target that
renders it into your memory tree (exactly how `runtimeContext` emits
`session-context.md`):

```js
// A target that renders the shared manifest into the project's memory source.
const browserTaskManifest = {
  entryPoint: "${sousRootPath}/shared-prompts/memories/automated-browser-tasks/INDEX.tpl.md",
  outputs: [
    { destinationFile: "${memoryRoot}/tools/automated-browser-tasks.md" },
  ],
};
```

Order this target BEFORE the memories target that composes core memory. Then pull
it into a memory file (e.g. `tools/README.md`) with a plain relative Sous include:
put an `@`-prefixed line containing just the rendered filename
(`automated-browser-tasks.md`) on its own line in that file.

The manifest auto-rebuilds on every `xcv build`, so newly created tasks appear
automatically. It requires `browserAutomationScriptsDir` to be in scope (the
absolute path to the task scripts).

## Verifying

Run any example script by absolute path:

```bash
node <scriptsDir>/run.mjs <scriptsDir>/../examples/simple-fetch.mjs --url=https://example.com
```

A clean run prints extracted cookie counts, a browser-ready line, and the result.
