# ADR 0017: Recipes may ship sous plugins

**Status:** Accepted, 2026-10-29.

This record supersedes [ADR 0012](0012-recipes-and-plugins.md) (recipes do not install sous
plugins). It summarizes a decision of the 1.0 architecture; the details are in
[the engine specification](../architecture/specifications/S1-engine.md) (its sections on where
plugins come from and on recipes that require npm plugins). Where this record and that file
disagree, it wins.

## Context

ADR 0012 ruled that a recipe could not install a sous plugin, and that every plugin besides the
built-in ones would come from npm. Under the 1.0 architecture almost everything sous does is a
plugin ([ADR 0014](0014-plugin-engine.md)). A team that wants its own build step, Liquid filter or
agent tool in all its projects would otherwise have to publish an npm package and add it to every
project. A recipe already reaches every subscribed project, at a pinned version, and only from a
repository the user trusts. The maintainer reversed the earlier ruling:

> "recipes can provide sous plugins."
>
>   -- **Luke Chavers** in an agent session (2026-10-25)

and kept one rule above it:

> "The rule is: we never execute anything inside of a repo until we trust it."
>
>   -- **Luke Chavers** in an agent session (2026-10-25)

## Decision

- **A recipe may ship a sous plugin**, declared in its manifest:

    ```yaml
    # sous.recipe.yaml
    plugin:
        bundle: plugin/index.js
        types: plugin/index.d.ts      # optional
    ```

- **Anything in a recipe that runs is one self-contained bundle**: plugins, helper scripts and
  hooks alike. Sous never runs `npm install` for a recipe.

    > "Anything in a recipe must be a bundle because Sous will never manage a `npm install`; this
    > applies to helper scripts of all kinds, and there are many kinds."
    >
    >   -- **Luke Chavers** in an agent session (2026-10-25)

- **Nothing inside a repository runs until the repository is trusted.** Trust
  ([ADR 0001](0001-repositories.md)) now gates code that extends sous, not only content.
- **Recipe plugins are downloaded and loaded while the config is built**
  ([ADR 0015](0015-config-from-contributors.md)), and cached. A recipe plugin's types are copied
  into the project, so other plugins there can use them.
- **A recipe may require plugins from npm**, each with a version range:

    ```yaml
    # sous.recipe.yaml
    requires:
        plugins:
            sous-plugin-claude-code: "^1.0.0"
    ```

  `sous subscription add` refuses a recipe whose required plugin is missing or out of range, and
  offers to install it (or installs it with `--install-plugins`). A build fails when a subscribed
  recipe's requirement is not met, naming the plugin and the command that installs it.
- **A recipe may still install plugins for agent tools** (a Claude Code plugin, for example), as
  ordinary content.

## Consequences

- A user can add functionality to sous, plugins included, through a recipe.
- Subscribing to a recipe from a trusted repository can now run code that changes how sous builds,
  so trusting a repository carries more weight. `sous plugins show` names every recipe plugin and
  what it added.
- A recipe plugin can be written in TypeScript or JavaScript, but ships compiled into one file.
- The architecture does not settle what happens to the plugin of a recipe used only as a build
  dependency (listed under `depends`). The expectation is [ADR 0009](0009-whole-build-everywhere.md)'s
  rule that such a recipe adds nothing of its own to the project.
