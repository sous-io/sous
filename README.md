<p align="center">
  <a href="https://sous.io">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/sous-io/sous/main/docs/img/logo-on-dark-sm.png">
      <img src="https://raw.githubusercontent.com/sous-io/sous/main/docs/img/logo-on-white-sm.png" alt="Sous" height="180">
    </picture>
  </a>
</p>

# sous

sous compiles AI coding agent configuration from templates. You write skills, memories, and
instructions once as LiquidJS templates in layered sources, then sous renders them into the
formats agents actually read: `.claude/` plus `CLAUDE.md` for Claude Code, `.codex/` plus
`AGENTS.md` for Codex. The CLI binary is named `xcv`.

**New to sous? Watch the animated introduction at [sous.io](https://sous.io).**

## Why

- Share one set of agent configs across every project you work in, and with teammates.
- Write a rule once as a template with variables; each project gets its own rendered copy.
- Compile the same source to more than one agent's format.
- Keep machine-specific values (absolute paths, tokens) in an untracked env file, out of git,
  with shared team defaults in a committed one.

## Quickstart

Install the CLI:

```bash
npm install -g @sous-io/sous
```

Or run it from a clone (useful when developing sous itself):

```bash
git clone git@github.com:sous-io/sous.git
cd sous
npm install
npm link
```

Then set up a project. A project needs a `.sous/` directory holding a config file, named
`sous.config.js`, `sous.config.mjs`, `sous.config.json`, or `sous.config.yaml`:

```bash
cd /path/to/your/project
mkdir .sous
$EDITOR .sous/sous.config.js
```

A config that compiles one file:

```js
export const config = {
  name: "My Project",
  _vars: { projectRoot: "${sousDir}/.." },
  compilation: {
    targets: [
      {
        entryPoint: "${sousDir}/AGENTS.md",
        outputs: [{ destinationFile: "${projectRoot}/CLAUDE.md" }],
      },
    ],
  },
};
```

`${sousDir}` is the `.sous/` directory sous found, so a config can name paths relative to
itself without hardcoding anything machine-specific. One config describes one project. Then
build:

```bash
xcv build
```

`xcv build` compiles every configured target and prunes outputs that are no longer in the
config. Config discovery walks up from the current directory until it finds a `.sous/`
directory holding a config, so you can run it from anywhere inside the project. Pass
`--config <path>` to point at one explicitly instead.

Values reach the config through its top-level `_env` block, which maps a config variable
to an environment variable. Both env files use `KEY=value` lines and are loaded before
anything resolves. There are two layers:

- `.sous/.env` is committed. Put shared team defaults here, never secrets.
- `.sous/.env.local` is gitignored. Put machine-specific values and secrets here.

Precedence, highest first: your shell environment, then `.env.local`, then `.env`. So
`FOO=bar xcv build` beats both files, and `.env.local` beats `.env` per key. This repo
ships `.sous/.env.local.example` documenting the layer.

Useful commands:

| Command | What it does |
|---|---|
| `xcv build` | Compile, then prune stale outputs |
| `xcv build --watch` | Rebuild on source changes |
| `xcv compile` | Compile only |
| `xcv prune` | Remove outputs no longer in the config |
| `xcv clear` | Delete every file sous wrote for the project |
| `xcv launch claude` | Build, then start the agent |
| `xcv config show` | Print the merged config (all layers) as JSON |
| `xcv config get <path>` | Read one value by dot-path; `--layers` shows which file set it |
| `xcv config validate` | Validate the merged config: schema, then variable resolution |

## How it works

Sources are markdown files. A file with `.tpl.` in its name is rendered through LiquidJS and
the `.tpl.` is dropped from the output name (`skill.tpl.md` becomes `skill.md`). Files without
`.tpl.` are copied verbatim. Any line of the form `@path/to/file.md` pulls in another file, so
one instruction block can be composed into several outputs.

Config lists targets. Each target names an entry point or a glob, plus one or more outputs, and
each level can define variables:

```js
// One entry point to one file.
{
  entryPoint: "${sousDir}/memory/MEMORY.root.tpl.md",
  outputs: [{ destinationFile: "${projectRoot}/CLAUDE.md" }],
}

// One glob to a directory, mirroring the source tree under it.
{
  entryGlob: "${sousDir}/skills/**/*",
  outputs: [{ destinationDir: "${projectRoot}/.claude/skills" }],
}
```

Variables resolve later-wins across scopes: auto-injected, env, config, compilation,
target, output. Templates read them as `{{ varName }}`; config files reference them as `${varName}`.
The auto-injected ones include `${sousDir}` and `${sousConfigPath}` for the discovered
config, and `${sousTemplatePath}` for the template being rendered.

Sources come in three tiers, each able to build on the one above it:

1. **Built-in** shared prompts that ship with sous, covering skill authoring, templating, and
   the sous conventions themselves.
2. **Team-shared**, a repo your team owns, holding the configs everyone should get.
3. **Per-project**, the project's own `.sous/` directory, for anything specific to it.

The built-in tier is reachable without knowing where sous is installed. `@include` paths
accept aliases, and two are always defined: `~sous-shared` for the shared prompts that ship
with sous, and `~project` for the project root. So `@~sous-shared/_partials/sub-agent-delegation.md`
composes a built-in block into your own instruction file, and an `entryGlob` can point at a
built-in skill bundle to compile it into your project. Define your own aliases with an
`_aliases` block to do the same for a team-shared repo.

Sous records every file and directory it writes in a state file, `.sous/sous.state.json` by
default, which is what lets `prune` and `clear` clean up precisely instead of guessing.

## Composing config from layers

One config can grow large, so sous lets you split it. Alongside the primary
`sous.config.*`, any file matching `.sous/conf.d/*.{js,mjs,json,yaml}` is a layer. Sous loads
the primary first, then the `conf.d/` files sorted bytewise-lexicographically (identical order
on every machine), and merges them into one config: objects deep-merge key by key, scalars are
later-wins, and arrays concatenate in load order. Every layer is forced back to plain JSON
before merging, so functions, `RegExp`, `Date`, and `undefined` do not survive a layer.

```
.sous/
  sous.config.js          # base config
  conf.d/
    100-tools.json        # adds or overrides tools
    200-skills.yaml       # adds compilation targets
```

For anything JSON cannot express, a `.js`/`.mjs` layer may export a `configure` function
instead of (or alongside) a `config` object. Sous calls it with the cumulative config so far
and a small builder, and merges the result:

```js
export function configure(currentConfig, builder) {
  // currentConfig is the live merged config; mutate it by reference, or return
  // an object to merge. builder.env(name, fallback), builder.loadConfig(path),
  // builder.loadConfigs(glob), and builder.merge(obj) are available.
  currentConfig._vars.apiBase = builder.env("API_BASE", "https://example.com");
}
```

`configure` may be async. Builder paths (`loadConfig`/`loadConfigs`) run before variable
resolution, so they accept only the auto-vars `${sousDir}`, `${sousConfDir}`, `${sousRootPath}`,
and `${sousVersion}`; any other `${var}` in a builder path is an error.

## Locating the config

By default sous walks up from the current directory to find the `.sous/` holding a config.
You can point it elsewhere with an environment variable or a flag; every command accepts these:

| Flag | Env var | What it overrides |
|---|---|---|
| `--config` / `-c` / `--sous-config` | `SOUS_CONFIG` | The exact primary config file |
| `--sous-dir` | `SOUS_DIR` | The `.sous/` directory to use |
| `--sous-confd` | `SOUS_CONFD` | The `conf.d/` directory (defaults to `<sousDir>/conf.d`) |

Precedence, highest first: flag, then env var, then walk-up discovery. These location inputs
are read from the real environment only, never from `.env` or `.env.local` (those files are
found by discovery, so they cannot decide where discovery looks).

## Validating and inspecting config

`xcv config validate` runs the full pipeline: it merges every layer, checks it against the
schema, then resolves variables, reporting the first failure with a readable message.
`xcv config show` prints the merged config as JSON, and `xcv config get <dot.path>` reads a
single value; add `--layers` to see which layer file set it and to what.

Config is validated against a JSON Schema on every load. A config may declare a `version`
field; omit it or set it to `1`. JSON layers can point an editor at the shipped schema with a
`"$schema"` key for autocompletion and inline validation:

```json
{
  "$schema": "./sous.config.schema.json",
  "version": 1
}
```

## Platform support

- **Ubuntu** is where sous is developed and tested.
- **macOS** should work for the core CLI, but is not tested yet. Reports welcome.
- **Windows** is not supported.
- The browser-automation skill bundle is **Linux only**. It depends on Linux Chrome paths and
  the GNOME keyring.

Node 22 is required; the version is pinned in `.nvmrc`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Note the licensing terms for contributions.

## License

Apache License 2.0. See [LICENSE](LICENSE).
