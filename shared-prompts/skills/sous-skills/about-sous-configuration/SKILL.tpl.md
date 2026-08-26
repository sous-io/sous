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
  version: 1.0.0
  tags: [sous, configuration]
---

# About Sous Configuration

Sous reads one configuration per project from the project's `.sous/` directory. One config
describes one project: every setting lives at the top level of a single flat object. There
is no user-level config (nothing is read from `~/.sous`) and no multi-project map; a config
containing the legacy `projects:` or `defaultProject` keys is a hard error with a migration
message.

## This Project's Configuration

Resolved at compile time for the project this skill was compiled into:

- Primary config: `{{ sousConfigPath }}`
- Discovered `.sous/` directory: `{{ sousDir }}`
- Drop-in layer directory: `{{ sousConfDir }}`

## Config Sources and Merging

- Exactly ONE primary config: `sous.config.js`, `.mjs`, `.json`, or `.yaml` inside `.sous/`.
  Two or more candidates is an error, never a silent first-match.
- Optional drop-in layers: every `*.js|mjs|json|yaml` file directly inside `conf.d/`
  (non-recursive), loaded AFTER the primary and merged over it. Layers sort bytewise by
  filename, not numerically: `10-x.json` loads BEFORE `2-x.json`, so zero-pad numeric
  prefixes. Two loaded files sharing a baseName (`500-repos.json` + `500-repos.yaml`) is
  an error.
- Every layer is forced to plain JSON, then deep-merged in load order: objects merge key
  by key, scalars later-wins, arrays CONCATENATE (no dedupe). Functions, RegExp and
  `undefined` do not survive the JSON forcing.
- Sous finds `.sous/` by walking up from the working directory; `--config`/`--sous-dir`
  flags and `SOUS_CONFIG`/`SOUS_DIR`/`SOUS_CONFD` env vars override discovery
  (flag beats env; env beats walk-up). Deep dive:
  [references/discovery-and-overrides.md](references/discovery-and-overrides.md).

## The Shape of a Config

```js
export const config = {
  version: 1,                          // optional; must be 1 when present
  name: "My Project",                  // optional display name
  _env: { userHome: "HOME" },          // map config vars from env vars (top-level only)
  _vars: {
    projectRoot: "${sousDir}/..",      // ${sousDir} is the discovered .sous/ dir
    docsDir: "${projectRoot}/docs",    // declaration order never matters
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

A JSON config may set `"$schema"` to bind the `sous.config.schema.json` artifact shipped
with sous for editor autocompletion; sous accepts and ignores the key.

Configs use `${var}` syntax. Template files use LiquidJS double-brace syntax instead;
the two are resolved at different stages and must not be mixed. YOU MUST load
`about-liquid-templates` when writing or editing `.tpl.` files.

## Variables

`_vars` entries may reference each other with `${name}` in any order: resolution is a
fixpoint loop, not top-to-bottom. A reference that can never resolve (a cycle, or a name
defined nowhere) is a hard ConfigError naming the entries involved and listing the
variables that ARE in scope. `_env` (top-level only) maps config vars from environment
variables, which may come from the shell, `.sous/.env.local` (gitignored, machine-local)
or `.sous/.env` (committed team defaults). Auto-vars are always available: `sousDir`,
`sousConfDir`, `sousConfigPath`, `sousRootPath`, `sousVersion`. Never define vars starting
with `sous`; the namespace is reserved. Deep dive:
[references/variables.md](references/variables.md).

## Programmatic Configs

A `.js`/`.mjs` config or layer may export a plain `config` object, a
`configure(currentConfig, builder)` function, or both (the object merges first). The
function may be async, may mutate `currentConfig` by reference, and may return an object
to merge. The `builder` provides `env()`, `merge()`, `loadConfig()` and `loadConfigs()`
for composing further files with plain JavaScript. Deep dive:
[references/layers-and-configure.md](references/layers-and-configure.md).

## Validation and Inspection

Every load validates the merged config against a strict schema: unknown keys (typos) fail
with the offending path. Inspect a live config with `xcv config show` (merged JSON),
`xcv config get <path>` (one value; `--layers` shows which file set it), and
`xcv config validate` (schema plus full variable resolution). Deep dive:
[references/inspecting-and-validating.md](references/inspecting-and-validating.md).

## Rules

- Hand-written config belongs in the primary file or your own `conf.d/` layers. The
  `conf.d/500-*` through `conf.d/599-*` band is reserved for layers the sous CLI itself
  writes; do not hand-edit files in that band.
- Any config problem halts sous with a ConfigError; there is no warn-and-continue. Fix the
  named file rather than working around it.
- YOU MUST load `about-sous` for which files in the project are compiled outputs that must
  never be edited directly.

## Reference Files

- [discovery-and-overrides.md](references/discovery-and-overrides.md): how sous locates
  the config; flag/env precedence; env-file layering; discovery errors
- [layers-and-configure.md](references/layers-and-configure.md): merge semantics in
  detail; the JS config contract; the builder API; the managed 5xx layer band
- [variables.md](references/variables.md): the scope chain; fixpoint resolution; auto-vars;
  error anatomy; special vars like stateFilePath
- [inspecting-and-validating.md](references/inspecting-and-validating.md): the validation
  pipeline; the JSON Schema artifact; the xcv config commands

## Source for this Skill

This skill was pulled from the `sous` project's "shared skills" library. It was compiled from a template and
the output file should not be edited directly.

- Source Path: {{ sousTemplatePath }}
