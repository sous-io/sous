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

Sous reads one configuration per project from the project's `.sous/` directory: exactly ONE
primary config (`sous.config.js|mjs|json|yaml`), optionally extended by `conf.d/` drop-in
layers that deep-merge over it. One config describes one project; every setting lives at the
top level of a single flat object. There is no user-level config and no multi-project map.
Configs use `${var}` syntax, resolved by a fixpoint loop (declaration order never matters);
`sous*`-prefixed variable names are reserved auto-vars.

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
- `{{ sousRootPath }}/docs/markdown/config-layers.md`: merge semantics; the JS `configure()`
  contract; the builder API; the managed 5xx layer band
- `{{ sousRootPath }}/docs/markdown/config-variables.md`: the scope chain; auto-vars; fixpoint
  resolution; error anatomy; `stateFilePath`/`pidFilePath`
- `{{ sousRootPath }}/docs/markdown/config-inspection.md`: the validation pipeline; the JSON
  Schema artifact; the `xcv config` commands

These files match the INSTALLED sous version. The same content is published at
https://sous-io.github.io/sous/markdown/#/configuration, which tracks the latest release;
prefer the on-disk copies.

## Rules

- After editing any config file, run `xcv config validate`: it runs schema validation plus
  full variable resolution, surfacing cycles and undefined `${refs}`. Use
  `xcv config get <path> --layers` to see which file set a value.
- Hand-written config belongs in the primary file or your own `conf.d/` layers. Never
  hand-edit `conf.d/500-*` through `conf.d/599-*`; that band is reserved for layers the sous
  CLI writes.
- Any config problem halts sous with a ConfigError naming the offending file; fix the named
  file rather than working around it.
- Configs use `${var}`; template files use LiquidJS double-brace syntax. The two resolve at
  different stages and must not be mixed. YOU MUST load `about-liquid-templates` when writing
  or editing `.tpl.` files.
- YOU MUST load `about-sous` for which files in the project are compiled outputs that must
  never be edited directly.

## Source for this Skill

This skill was pulled from the `sous` project's "shared skills" library. It was compiled from a template and
the output file should not be edited directly.

- Source Path: {{ sousTemplatePath }}
