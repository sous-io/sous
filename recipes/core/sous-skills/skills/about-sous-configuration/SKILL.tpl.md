---
name: about-sous-configuration
description: >
  YOU MUST load this skill when creating or editing a sous config file (sous.config.* or a
  conf.d layer), defining or debugging ${var} config variables, deciding where a setting
  belongs, using SOUS_* env vars or --sous-* flags, or when sous fails to load with a
  ConfigError.
user-invocable: false
license: Apache-2.0
compatibility:
  - claude
  - codex
metadata:
  version: 2.0.0
  tags: [sous, configuration]
---

# About Sous Configuration

Sous builds one configuration per project, from the project's `.sous/` directory: exactly ONE
primary config (`sous.config.js|mjs|json|yaml`), optionally extended by `conf.d/` drop-in files.
One config describes one project; every setting lives at the top level of a single flat object.
There is no user-level config, no multi-project map and no separate bootstrap config.

Plugins and subscribed recipes may change the config too. The primary config and the `conf.d/`
files are always applied after them, in file order, so the project's own files win over any plugin
or recipe. Sous may apply a file more than once while it builds the config, so a JS config's
`configure()` MUST give the same result every time it runs for the same input (no counters, no
writes to disk).

Configs use `${var}` syntax, resolved until every value settles (declaration order never
matters); `sous*`-prefixed names and `projectRoot` are auto-variables sous sets itself.
`projectRoot` is the directory holding `.sous/`; setting it in any `_vars` is an error.

## This Project's Configuration

Resolved at compile time for the project this skill was compiled into:

- Primary config: `{{ sousConfigPath }}`
- Discovered `.sous/` directory: `{{ sousDir }}`
- Drop-in layer directory: `{{ sousConfDir }}`

## The Documentation Is the Reference

The full configuration reference ships inside the installed sous package as plain markdown.
Read these files for anything beyond this page; do not guess and do not search the web:

- `{{ sousRootPath }}/docs/markdown/configuration.md`: the config file, its shape, composition
- `{{ sousRootPath }}/docs/markdown/config-discovery.md`: how sous finds the config; flag/env
  precedence; env-file layering; discovery errors
- `{{ sousRootPath }}/docs/markdown/config-layers.md`: how the files combine; the JS
  `configure()` contract; the builder API; patch files; the 5xx band the sous CLI writes
- `{{ sousRootPath }}/docs/markdown/config-variables.md`: the scope chain; auto-vars; how values
  settle; error anatomy; `stateFilePath`/`pidFilePath`
- `{{ sousRootPath }}/docs/markdown/config-inspection.md`: the validation pipeline; the JSON
  Schema artifact; the `sous config` commands

These files match the INSTALLED sous version. The same content is published at
https://sous.io/markdown/#/configuration, which tracks the latest release;
prefer the on-disk copies.

## Rules

- After editing any config file, run `sous config validate`: it runs schema validation plus
  full variable resolution, surfacing cycles and undefined `${refs}`. Use
  `sous config get <path> --layers` to see which file or plugin changed a value, in order.
- Hand-written config belongs in the primary file or your own `conf.d/` layers. Never
  hand-edit `conf.d/500-*` through `conf.d/599-*`; that band is reserved for layers the sous
  CLI writes.
- The top-level `recipes` key says what the project does with each kind of content its
  subscribed recipes publish. Skills go to every skills directory an agent plugin adds (the
  built-in Claude Code plugin adds `.claude/skills`) and to every directory listed in
  `recipes.skills.outputs`; with neither, the build skips the skills and says why.
  `recipes.memories.first` and `recipes.memories.exclude` (globs over `namespace/recipe`, or
  `/regex/` strings) order and filter the recipe memories.
- The `plugins` key decides which Sous plugins (packages that extend sous itself) load, beyond
  the built-ins and those listed in the project's `package.json`, and holds each plugin's own
  options. `configuration.md` above documents its fields. Run `sous plugins show` to see which
  plugins loaded and what each added.
- A value in a JSON, JSONC or YAML config may be a config expression (`$if`, `$elseif`, `$else`,
  `$expr`), worked out when sous builds the config, for example to switch a subscription off on
  one platform. See `configuration.md` above for the syntax.
- A `conf.d/*.patch.json` or `*.patch.jsonl` file holds raw edit operations (for example, remove
  an array item) instead of config data. Read the "Patch files" section of `config-layers.md`
  above before writing one: an array index in a patch file is NEVER recomputed, so it can hit the
  wrong item if anything else changes that array.
- Any config problem halts sous with a ConfigError naming the offending file; fix the named
  file rather than working around it.
- Configs use `${var}`; template files use LiquidJS double-brace syntax. The two resolve at
  different stages and must not be mixed. YOU MUST load `about-liquid-templates` when writing
  or editing `.tpl.` files.
- YOU MUST load `about-sous` for which files in the project are compiled outputs that must
  never be edited directly.

## Source for this Skill

This skill comes from the `core/sous-skills` recipe, installed by sous from a recipe
repository. It was compiled from a template, so edit the source, never this output file.

- Source Path: {{ sousTemplatePath }}
