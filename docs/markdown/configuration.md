# Configuration

Sous reads one configuration per project from the project's `.sous/` directory. One config
describes one project: every setting lives at the top level of a single flat object. There is no
user-level config (nothing is read from `~/.sous`) and no multi-project map.

## The config file

Exactly one primary config lives inside `.sous/`: `sous.config.js`, `sous.config.mjs`,
`sous.config.ts`, `sous.config.json`, `sous.config.jsonc`, or `sous.config.yaml`. Two or more candidates is an
error, never a silent first-match. A typical config:

```js
export const config = {
  version: 1,                          // optional; must be 1 when present
  name: "My Project",                  // optional display name
  _env: { userHome: "HOME" },          // map config vars from env vars (top-level only)
  _vars: {
    docsDir: "${projectRoot}/docs",    // projectRoot is set by sous; order never matters
  },
  _aliases: { myDocs: "${docsDir}" },  // extra @include bases (optional)
  compilation: {
    targets: [
      {
        entryPoint: "${projectRoot}/prompts/AGENTS.md",
        outputs: [{ destinationFile: "${projectRoot}/AGENTS.md" }],
      },
      {
        entryGlob: "${projectRoot}/prompts/skills/**/*.md",
        outputs: [{ destinationDir: "${projectRoot}/.claude/skills" }],
      },
    ],
  },
  tools: {
    claude: { command: "claude", promptFile: "${projectRoot}/CLAUDE.md" },
  },
};
```

`${projectRoot}` is the directory that holds `.sous/`. Sous sets it, and setting `projectRoot` in any
`_vars` block is an error; see [Variables](config-variables.md#auto-vars).

The `.claude/skills` target above compiles the project's own skills. Skills from subscribed recipes
need no target of their own: the built-in Claude Code plugin sends them to `.claude/skills`, and
`recipes.skills.outputs` adds destinations of your own (see
[Consuming recipes](repositories-consuming.md)).

A JSON config may set `"$schema"` to bind the `sous.config.schema.json` artifact shipped with
sous for editor autocompletion; sous accepts and ignores the key. `sous init --format json`
writes one already bound to the copy of that artifact published for the running version.

?> Configs use `${var}` syntax. Template files use LiquidJS double-brace syntax instead; the two
are resolved at different stages and never mix.

## Templates and the `.tpl.` convention

A file's own name decides whether sous renders it, every time. A file with `.tpl.` in its name is rendered
through LiquidJS and lands with that segment stripped, so `SKILL.tpl.md` compiles to `SKILL.md`; a file
without it is never rendered, however much it looks like a template, even when a template includes it. A
`.tpl.` file included from a plain file still renders, by its own name, before its text is placed. The
convention applies to `entryPoint` and `entryGlob` targets alike, and to the files a recipe brings into your
project.

## Include syntax

A line holding only `@path` includes that file's content. A path may be:

- relative to the including file (`@sections/context.md`);
- `${var}` substituted (`@${projectRoot}/prompts/x.md`);
- home-relative (`@~/notes/private.md`);
- an alias from `_aliases`, by its first segment (`@myAlias/doc.md`);
- a name sous or a plugin registers, written with the `#` sigil: `#project` is the project root
  (`@#project/prompts/intro.md`);
- a recipe file, written with the `~` sigil and the recipe's namespace (`@~workflow/task-files/_partials/resume.md`);
- a view: `@#memories/**/*.md` includes every active recipe's memories (see
  [Recipe memories](repositories-consuming.md#recipe-memories)).

A path may use glob syntax (`*`, `**`, `?`, `[..]`, `{a,b}`) and then includes every file it matches, in bytewise
path order. The same file may be included in more than one place; a circular include is an error, as is a line
that looks like an include (`@docs/notes.txt`, `@~workflow/missing`) but cannot be resolved, which fails the
build naming the file and the line. A line inside a fenced code block is left as written. An alias name may not
start with `~` or `#`. [Including recipe files in your own templates](repositories.md#including-recipe-files-in-your-own-templates)
has the namespace rules.

## Composition

The primary config is optionally extended by drop-in files: every `*.js|mjs|ts|json|jsonc|yaml`
file directly inside `.sous/conf.d/` is applied after the primary config, in filename order, and
merged over it. Recipes and plugins can change the config too, and your own files are always
applied again after them, so a value you set wins. A
`.js`, `.mjs` or `.ts` file can also change the config through a `configure()` function, and a
`.patch.json` or `.patch.jsonl` file holds raw edits. [Layers and merging](config-layers.md) covers
the full semantics.

## Config expressions

A value in a JSON, JSONC or YAML config file may be an expression object, decided when sous builds
the config instead of when the file is written. The reserved keys are `$expr`, `$if`, `$elseif` and
`$else` (each `$if` and `$elseif` may carry a `:<name>` qualifier, and `$expr` a `:<language>` one).
Liquid is the expression language. An expression can read `host.platform`, `env.<NAME>`, variables
by their bare name, and recipe answers (except under `subscriptions` and `repos`).

A subscription switched off on a Mac only:

```jsonc
// conf.d/610-mac.jsonc
{
    "subscriptions": {
        "tool-usage/automated-browser-tasks": {
            "enabled": {
                "$if": {
                    "expr": "host.platform == 'darwin'",
                    "then": false
                }
            }
        }
    }
}
```

On a Mac, `enabled` is `false`. Elsewhere the condition is false and there is no `$else`, so the key
is dropped and the subscription stays on. An expression may appear at any depth, including inside
arrays. An object mixing a reserved key with any other key is an error, so a typo such as `"$iff"`
never passes through as config. The full rules are in
[the design of config expressions](architecture/specifications/S5-config-expressions.md).

## Plugins

Sous is a small engine plus plugins; the CLI, recipes, the compiler, skills, memories, Claude Code
support and the package-manager and repository-host integrations are all built-in plugins. Which
plugins load is an ordinary config key, so it may be set in any config file, a recipe's included.
There is no separate bootstrap config and no `"sous"` key in `package.json`.

- `plugins.discover` (`"dependencies" | "scan" = "dependencies"`): `"dependencies"` loads the
  built-ins, the plugins in the project's `package.json` dependencies (and the workspace root's) and
  those under `load`; `"scan"` also looks for installed plugins through the package managers.
- `plugins.load` (`string[]`): plugins to load though `package.json` does not list them.
- `plugins.disabled` (`string[]`): plugins never to load, built-ins included.
- `plugins.options` (`Record<string, object>`): each plugin's own options, keyed by plugin name.

```jsonc
// .sous/sous.config.jsonc
{
    "plugins": {
        "load": [
            "sous-plugin-bun"
        ],
        "disabled": [
            "sous-plugin-old-thing"
        ],
        "options": {
            "sous-plugin-claude-code": {
                "model": "opus"
            }
        }
    }
}
```

Two more keys settle what plugins do:

- `services.replace` picks the winner when two plugins both take over the same piece of sous's
  work. Each piece has a name, such as `git.runner` (how sous runs git), and two plugins replacing
  the same one stops sous with an error until you choose one:
  `"services": { "replace": { "git.runner": "sous-plugin-fast-git" } }`. Sous then warns on every
  run that the other plugin may not work as expected.
- `budgets` changes how long a step may take before sous warns that it is slow; a budget set to
  `false` turns that warning off. `--timings` on any command prints how long every step took.

`sous plugins show` lists every plugin and what it adds. Recipes may ship plugins too; see
[where plugins come from](architecture/specifications/S1-engine.md#where-plugins-come-from).

## Where to go next

- [Discovery and overrides](config-discovery.md): how sous finds the config, and the flags and
  environment variables that override it
- [Layers and merging](config-layers.md): the order files apply in, how values merge, the
  `configure()` function, patch files
- [Variables](config-variables.md): where `${var}` values come from, the variables sous sets
  (`projectRoot` among them), and variables that refer to other variables
- [Inspecting and validating](config-inspection.md): the `sous config` commands and the
  validation pipeline

## Rules of the road

- Hand-written config belongs in the primary file or your own `conf.d/` files. The
  `conf.d/500-*` through `conf.d/599-*` band is reserved for files the sous CLI itself writes.
  Sous edits those by key, so you may edit them too and your comments, key order and formatting
  survive; put a file of your own outside the band.
- Any config problem halts sous with a `ConfigError` naming the offending file; there is no
  warn-and-continue.
