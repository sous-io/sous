# ADR 0012: Recipes do not install Sous plugins

**Status:** Accepted, 2026-09-29.

This record stands on its own; it amends nothing in [ADR 0001](0001-repositories.md) through
[ADR 0011](0011-self-update.md), and everything they say still holds. There is no living
documentation for plugins yet; the process records are [gh-9](https://github.com/sous-io/sous/issues/9)
and [gh-64](https://github.com/sous-io/sous/issues/64), under the goal
[gh-54](https://github.com/sous-io/sous/issues/54).

## Context

Two kinds of plugin meet in a sous project, and they are easy to confuse. A SOUS plugin extends sous
itself, through the plugin host that [gh-54](https://github.com/sous-io/sous/issues/54) ("Small core,
everything a plugin") works toward and whose design record is
[gh-64](https://github.com/sous-io/sous/issues/64). A TOOL plugin extends a coding agent tool that sous
configures, such as a Claude Code plugin. Recipes already carry content into a project, and the plugin
host needed a ruling on whether a recipe could also carry a Sous plugin into one, before it is designed.

The sous maintainer ruled:

> "recipes will not be allowed to install _Sous_ plugins. All Sous plugins, besides any built-ins that ship with Sous, itself, will come from a NPM repo (or similar) as modules. Recipes _will_ be allowed to install tool plugins (e.g. Claude Code Plugins)."
>
>   -- **Luke Chavers** in an agent session (2026-09-29)

## Decision

- **A recipe cannot install a Sous plugin.** Nothing a recipe publishes (its files, its manifest, its
  `depends` or its `subscribes`) adds code that extends sous.
- **A Sous plugin is a built-in or a module.** It either ships inside sous itself, or comes from npm
  (or a registry like it) as a module.
- **A recipe may install tool plugins.** A plugin for a coding agent tool, such as a Claude Code
  plugin, is ordinary recipe content.
- **A recipe's config layers are not Sous plugins.** A config layer a recipe ships, executable or
  not, is configuration; this ruling does not decide how such layers load, which
  [gh-110](https://github.com/sous-io/sous/issues/110) covers.

### Not decided here

The maintainer's tentative ideas for how plugins are managed are tracked in the issues above and are
not part of this decision:

> "We will also, probably, add some conveniences for plugin management via something like `sous plugin add` (etc). Plugins will probably be required to have a prefix in their name, such as `sous-plugin-` so that Sous can auto-detect them from the project or global node_modules and load them _before_ the config apparatus starts up."

## Consequences

- The plugin host design ([gh-64](https://github.com/sous-io/sous/issues/64)) starts from two sources
  of Sous plugins, built-ins and modules, and needs no path from a recipe.
- Subscribing to a recipe can still bring a tool plugin into a project, so the repository trust
  ceremony in ADR 0001 remains the gate for that content.
- The repository providers ADR 0001 calls built-in plugins are built-ins in this sense, and are
  unaffected.
