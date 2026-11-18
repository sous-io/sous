# Configuration

Sous reads one configuration per project from the project's `.sous/` directory. One config
describes one project: every setting lives at the top level of a single flat object. There is no
user-level config (nothing is read from `~/.sous`) and no multi-project map.

## The config file

Exactly one primary config lives inside `.sous/`: `sous.config.js`, `sous.config.mjs`,
`sous.config.ts`, `sous.config.json`, `sous.config.jsonc`, or `sous.config.yaml`. Two or more candidates is an
error, never a silent first-match. `sous init` writes `sous.config.jsonc`: JSON with comments, which
`sous config set` can change in place, keeping the comments, as it cannot a code config. A config
written by hand may use any of the formats. A typical config, as JavaScript:

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
    "claude-code": { command: "claude", args: ["--model", "opus"] },
  },
};
```

`${projectRoot}` is the directory that holds `.sous/`. Sous sets it, and setting `projectRoot` in any
`_vars` block is an error; see [Variables](config-variables.md#auto-vars).

The `.claude/skills` target above compiles the project's own skills. Skills from subscribed recipes
need no target of their own: the built-in Claude Code plugin sends them to `.claude/skills`, and
`recipes.skills.outputs` adds destinations of your own (see
[Consuming recipes](repositories-consuming.md)).

A target in your config wins over a plugin's or a recipe's target that would write the same file. A
project that compiles its own memories file replaces the one the Claude Code plugin would build; the
config `sous init` writes compiles none, and leaves the memories to the plugin. A project skill with the same name as a recipe skill
replaces it too, and the build warns that the recipe's copy was not written.

### The memories file

Each coding tool's plugin compiles one memories file, the file that tool reads into every session.
For Claude Code it is `.claude/rules/SOUS-MEMORIES.md`, which Claude Code loads beside any `CLAUDE.md`
the project has, so Sous never writes over the project's own instructions. Its source is
`.sous/MEMORIES.tpl.md` when that file exists (`sous init` creates it). Otherwise the source is
these two lines, read as if they were written in a file inside `.sous/`:

```markdown
@memories/**/*.md
@#memories/**/*.md
```

The first line includes the project's own files under `.sous/memories/`, the second the memories of
every recipe the project subscribes to. Remove a line to leave that part out; move a line to change
the order. When the result is empty, no file is written, and a copy an earlier build wrote is
removed. Sous creates the `.claude/rules/` folder.

The Claude Code plugin's options move the file or switch it off:

```jsonc
{
    "plugins": {
        "options": {
            "@sous-io/sous-plugin-claude-code": {
                // Where the memories file goes. Default: ${projectRoot}/.claude/rules/SOUS-MEMORIES.md
                "memoriesOutputPath": "${projectRoot}/CLAUDE.md",
                // false writes no memories file for Claude Code at all.
                "memories": true
            }
        }
    }
}
```

A file Sous did not write that is already at `memoriesOutputPath` is backed up to `.sous/backups/`,
with a warning, and replaced.

?> Before version 1.0.20 the recipes' memories went into the root `CLAUDE.md`. A project upgraded
from then is asked once, by `sous doctor` or `sous upgrade`, whether to move them to the new file
(the default) or keep them in `CLAUDE.md` (`--answer claude-code.memories=keep`).

A JSON config may set `"$schema"` to bind the `sous.config.schema.json` artifact shipped with
sous for editor autocompletion; sous accepts and ignores the key.

?> Configs use `${var}` syntax. Template files use LiquidJS double-brace syntax instead; the two
are resolved at different stages and never mix.

## Templates and the `.tpl.` convention

A file's own name decides whether sous renders it, every time. A file with `.tpl.` in its name is rendered
through LiquidJS and lands with that segment stripped, so `SKILL.tpl.md` compiles to `SKILL.md`; a file
without it is never rendered, however much it looks like a template, even when a template includes it. A
`.tpl.` file included from a plain file still renders, by its own name, before its text is placed. The
convention applies to `entryPoint` and `entryGlob` targets alike, and to the files a recipe brings into your
project.

A file that is not a template and includes nothing is copied byte for byte, so an image or any other binary
file reaches the project unchanged. A source file that is executable gives an executable output, templated or
not (`probe-info.tpl.py` as well as `run.sh`).

## Outputs and the files a build writes

Each output of a target writes one file per source: `destinationFile` names it, or `destinationDir` mirrors
the source's path under the glob's base (or `globBase`) inside it. An output may also say which harness it
belongs to, with `harness` (`"claude-code"`, `"codex"`); a template reads it as `harness.id`. The plugins that
write a harness's skills and memories set it.

Sous lists every file a build writes while it builds the config, matching each `entryGlob` against the disk
then, and keeps the list under `compilation.files`, one entry per output of each source. The compiler writes
exactly what that list holds, so `sous config get compilation.files` shows what a build will write, and
`--layers` names the `compiler.files` contributor that listed them:

```jsonc
// sous config get compilation.files (excerpt)
[
    {
        "target": "1",
        "targetIndex": 1,
        "source": "/home/me/app/prompts/skills/review/SKILL.tpl.md",
        "output": 0,
        "destination": "/home/me/app/.claude/skills/review/SKILL.md"
    }
]
```

Sous sets `compilation.files` and `compilation.listing` (what went wrong listing them, such as a glob that
matched nothing, reported when a build runs); anything written there in a config file is replaced. A file
added or removed under a glob target's folder is picked up by the next command, and `sous build --watch`
rebuilds the config when it sees one.

To write an output only under a condition, put a [config expression](#config-expressions) on the output
itself. The output setting `_if` was removed; a config that still uses it is refused with the `$if` to write
instead. `sous doctor` (and `sous upgrade`) runs a migration that rewrites it for you in a `.json`, `.jsonc` or
`.yaml` config file, changing only that output; for a config written as JavaScript or TypeScript it lists each
`_if` with its line and the expression to write. An `_if` on a variable named `env` or `host` is left for you,
since an expression reads those names as sous's own values:

```jsonc
"outputs": [
    {
        "$if": {
            "expr": "stage == 'prod'",
            "then": { "destinationFile": "${projectRoot}/prod.md" }
        }
    }
]
```

### Variables by output path

`compilation.varOverrides` sets variables for every output whose path matches a pattern, including outputs a
plugin or a recipe adds. Each rule has `match`, an optional `exclude`, and `_vars`. `match` and `exclude` each
take one entry or a list, and an entry is a glob, or a regular expression when written between two slashes
(the convention `recipes.memories.first` uses):

```js
compilation: {
    varOverrides: [
        {
            match: "${projectRoot}/.claude/**",
            exclude: [
                "${projectRoot}/.claude/desktop.md",
                "/\\.local\\./",
            ],
            _vars: { tool: "claude" },
        },
        {
            match: "${projectRoot}/.codex/**",
            _vars: { tool: "codex" },
        },
    ],
},
```

- A rule's variables win over the output's own `_vars`, so a project can change a variable on outputs it did
  not write.
- When several rules match one output, a later rule wins for a variable both set; a variable only one rule
  sets is kept. Your own config files apply after plugins and recipes, so your rules win over theirs.
- A rule matches the path Sous planned to write. A transform (a function a plugin attaches to an output) runs
  after rendering and may rename the file; the rule still matched the path from before it.
- A glob is matched against the absolute path, and a relative one is relative to the project root. A regular
  expression is tested against the absolute path, written with `/`.

The variables a rule set show on each matching entry of `compilation.files`, as its `_vars`.

## Include syntax

Sous reads `@path` the way Claude Code reads an import, and puts the file's text where the name stands. An
`@path` counts anywhere in a line of Markdown text when the `@` starts the line or follows a space:

```markdown
@sections/context.md
- @sections/rules.md
See @docs/guide.md for details.
```

A name alone on a line is replaced by the file's whole text. A name inside a line is replaced by the file's text
with its leading and trailing whitespace trimmed, so `See @docs/guide.md for details.` reads as one sentence.

A plain path may be:

- relative to the including file (`@sections/context.md`, `@../shared/rules.md`);
- home-relative (`@~/notes/private.md`) or absolute (`@/srv/notes.md`);
- an alias from `_aliases`, by its first segment (`@myAlias/doc.md`).

The path ends at the first space (write `@my\ file.md` for a space in a name) and at the first `#`
(`@guide.md#setup` includes `guide.md`). Punctuation right after it is part of the path, so `see @guide.md.` names
a file called `guide.md.`, which does not exist. The file may be of any text type Claude Code imports (`.md`,
`.txt`, `.json`, `.yaml`, `.sh`, `.py` and about a hundred more, in any case) or have no extension (`@README`).

**A plain path that names no file is left as written, with no message**, as Claude Code does, so a mention such as
`@alice` or `@scope/package` stays text. A typo in a file name therefore does not fail the build; the text simply
does not appear.

Sous's own forms count only on a line that holds nothing else, and are checked before the plain path:

- `${var}` substituted (`@${projectRoot}/prompts/x.md`);
- a name sous or a plugin registers, written with the `#` sigil: `#project` is the project root
  (`@#project/prompts/intro.md`);
- a recipe file, written with the `~` sigil and the recipe's namespace (`@~workflow/task-files/_partials/resume.md`);
- a view: `@#memories/**/*.md` includes every active recipe's memories (see
  [Recipe memories](repositories-consuming.md#recipe-memories));
- glob syntax (`*`, `**`, `?`, `[..]`, `{a,b}`), which includes every text file it matches;
- a `?name=value` query after the path (`@part.md?mood=calm`).

One of these forms that cannot be resolved fails the build, naming the file and the line. A glob that matches
nothing does nothing: its line is removed from the output, with no message. A glob's files come in this order: at
each folder its own files first, then its sub-folders, with the same rule inside each; names are compared one
character at a time ignoring case, with `_` before every other character and digits before letters, so
`_intro.md`, `0002-setup.md`, `0010-setup.md`, `10-setup.md`, `2-setup.md`, `apple.md`, `Zebra.md`, then
`api/routes.md`.

The frontmatter of every included file is removed; the including file keeps its own. The same file may be
included in more than one place; a circular include is an error. An alias name may not start with `~` or `#`.
[Including recipe files in your own templates](repositories.md#including-recipe-files-in-your-own-templates) has
the namespace rules.

To write an `@path` as text, escape it the way you would for Claude Code: put it in backticks (`` `@docs/x.md` ``)
or put a backslash before the `@` (`\@docs/x.md`). Sous also leaves alone a name in a fenced or indented code
block, an HTML block or comment, the frontmatter at the top of the file, a link's destination or an image's text,
and an `@` that follows anything but a space (`(@x.md)`, `"@x.md"`, `name@x.md`). Sous does not escape text it
leaves in its output: a name Sous left as text is read again by Claude Code, from the output file's folder.

## Composition

The primary config is optionally extended by drop-in files: every `*.js|mjs|ts|json|jsonc|yaml`
file directly inside `.sous/conf.d/` is applied after the primary config, in the order of the
number its name starts with (`500-repos.jsonc` before `610-mac.jsonc`), and merged into it. Recipes and plugins can change the config too, and your own files are always
applied again after them, so a value you set wins. A
`.js`, `.mjs` or `.ts` file can also change the config through a `configure()` function, and a
`.patch.json` or `.patch.jsonl` file holds raw edits. [Layers and merging](config-layers.md) covers
the full semantics.

## Config expressions

A value in a JSON, JSONC or YAML config file may be an expression object, decided when sous builds
the config instead of when the file is written. The reserved keys are `$expr`, `$if`, `$elseif`,
`$else` and `$file` (each `$if` and `$elseif` may carry a `:<name>` qualifier, and `$expr` a `:<language>` one).
Liquid is the expression language. An expression can read `host.platform`, `harness.id`,
`env.<NAME>`, variables by their bare name, and recipe answers (except under `subscriptions` and
`repos`).

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

### Conditions on the harness

A "harness" is a coding tool sous writes files for, such as Claude Code or Codex; each one is
registered by the plugin that knows it. Sous builds the config once with no harness, then once more
for every registered harness. `harness.id` is the harness of the build: `""` (the empty string) in
the build with no harness, and the harness's id in its own build. It is never `undefined`, so a
condition on it never fails as an unknown variable.

The config every command reads is the build with no harness, plus what belongs to each harness taken
from that harness's build:

- a compilation output marked with a harness (`"harness": "codex"`) comes from that harness's build,
  with the `_vars` written on it;
- an entry of `editor.edits` or `recipes.contents` that only a harness's build holds (a condition on
  `harness.id` put it there) is added, marked with that harness;
- everything else keeps the value of the build with no harness.

So a condition on `harness.id` takes effect in the merged config only for those lists. A setting
such as this one is `true` only in the `codex` build, which plugins acting for Codex can read, while
the merged config keeps `false`:

```jsonc
{
    "compilation": {
        "includeSourceComments": { "$if": "harness.id == 'codex'" }
    }
}
```

`sous config show --harness codex` prints the `codex` build itself. With no harness registered,
sous builds the config once, as before. The design is in
[One config build per harness](architecture/specifications/S8-per-harness-config-builds.md).

### Values from a file: `$file`

An object whose only key is `$file` stands in for the value a file holds, anywhere a value may go:

```jsonc
// conf.d/700-rules.jsonc
{
    "_vars": {
        "banner": { "$file": "banner.txt" }
    },
    "recipes": {
        "skills": {
            "outputs": { "$file": "${projectRoot}/shared/skill-outputs.json" }
        }
    }
}
```

The path is relative to the file that holds it, and `${name}` variables in it are filled in. A `.json`,
`.jsonc`, `.yaml` or `.yml` file gives its structured value; any other file gives its text. A file whose name
contains `.tpl.` is rendered as a Liquid template first; no other file's content is interpolated, so
`${CLAUDE_PLUGIN_ROOT}` in it arrives as it is written. Watch mode rebuilds when the file changes.

### Writing a literal `${`

Write `$${name}` where a value must hold the text `${name}` for another tool to fill in:

```jsonc
{
    "_vars": {
        "startHook": "bash \"$${CLAUDE_PLUGIN_ROOT}/scripts/start.sh\""
    }
}
```

`${startHook}` gives `bash "${CLAUDE_PLUGIN_ROOT}/scripts/start.sh"`.

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
- `budgets` changes how long a step may take before sous reports that it is slow (at the `debug`
  level, so only with `--debug`); a budget set to `false` turns that report off. `--timings` on any
  command prints how long every step took.

`sous plugins show` lists every plugin and what it adds. Recipes may ship plugins too; see
[where plugins come from](architecture/specifications/S1-engine.md#where-plugins-come-from).

## Outputs, the state file and backups

Sous records every file it writes in the state file, `.sous/sous.state.json` by default
(`compilation.stateFile` moves it), along with a hash of the content it wrote. `prune` and `clear` read
it to know which files are sous's to remove.

When a target's output already exists and sous did not write it, sous overwrites it and takes it
over by default. Set `compilation.overwriteUntracked: false` to have sous leave such a file alone
and warn instead.

Sous never destroys content it did not produce. Before it overwrites or removes a file that it did
not write, or one that was edited by hand since sous wrote it, it copies the file to
`.sous/backups/<YYYY-MM-DD>/<HHMM-SS>/<path relative to the project root>` and lists the backup in
the command's output. See [Backups before overwriting or
removing](commands.md#backups-before-overwriting-or-removing) for the details.

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
