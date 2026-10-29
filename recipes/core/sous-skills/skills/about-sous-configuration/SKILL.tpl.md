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

The config is built in sous's own process by **contributors**. Each config file is one
contributor, and so is each plugin or subscribed recipe that changes the config. A contributor
records its changes as a patch; sous re-runs a contributor only when something it read changed,
until nothing changes. The primary config and the `conf.d/` files always re-run last, in file
order, so the project's own files win over any plugin or recipe.

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
  `configure()` contract; the builder API; patch files; the managed 5xx band
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
- The top-level `recipes` key says what the project does with each content kind its subscribed
  recipes publish. Skills go to every skill target an agent plugin adds (the built-in Claude Code
  plugin adds `.claude/skills`) and to every directory in `recipes.skills.outputs`; with neither,
  the build skips them and says why. `recipes.memories.first` and `recipes.memories.exclude`
  (globs over `namespace/recipe`, or `/regex/` strings) order and filter the recipe memories.
- The `plugins` key decides which Sous plugins load: `load` adds plugins `package.json` does not
  list, `disabled` stops any plugin loading (built-ins included), `options` holds each plugin's
  own options by plugin name, and `discover` (`"dependencies"` by default, or `"scan"`) says how
  sous looks for installed plugins. Run `sous plugins show` to see what loaded.
- A JSON, JSONC or YAML config value may be a config expression (`$if`, `$elseif`, `$else`,
  `$expr`), decided when sous builds the config, for example to switch a subscription off on one
  platform. A `conf.d/*.patch.json` or `*.patch.jsonl` file holds raw patch operations instead of
  config data; write one only if you know how the builder applies patches.
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
