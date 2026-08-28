# Configuration

Sous reads one configuration per project from the project's `.sous/` directory. One config
describes one project: every setting lives at the top level of a single flat object. There is no
user-level config (nothing is read from `~/.sous`) and no multi-project map.

## The config file

Exactly one primary config lives inside `.sous/`: `sous.config.js`, `sous.config.mjs`,
`sous.config.json`, or `sous.config.yaml`. Two or more candidates is an error, never a silent
first-match. A typical config:

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

A JSON config may set `"$schema"` to bind the `sous.config.schema.json` artifact shipped with
sous for editor autocompletion; sous accepts and ignores the key.

?> Configs use `${var}` syntax. Template files use LiquidJS double-brace syntax instead; the two
are resolved at different stages and never mix.

## Composition

The primary config is optionally extended by drop-in layers: every `*.js|mjs|json|yaml` file
directly inside `.sous/conf.d/` is loaded after the primary config and deep-merged over it. A
`.js`/`.mjs` config or layer can also compose programmatically through a `configure()` function.
[Layers and merging](config-layers.md) covers the full semantics.

## Where to go next

- [Discovery and overrides](config-discovery.md): how sous finds the config, and the flags and
  environment variables that override it
- [Layers and merging](config-layers.md): `conf.d/` ordering, merge semantics, the JS
  `configure()` contract
- [Variables](config-variables.md): the `${var}` scope chain, auto-vars, fixpoint resolution
- [Inspecting and validating](config-inspection.md): the `xcv config` commands and the
  validation pipeline

## Rules of the road

- Hand-written config belongs in the primary file or your own `conf.d/` layers. The
  `conf.d/500-*` through `conf.d/599-*` band is reserved for layers the sous CLI itself writes;
  do not hand-edit files in that band.
- Any config problem halts sous with a `ConfigError` naming the offending file; there is no
  warn-and-continue.
