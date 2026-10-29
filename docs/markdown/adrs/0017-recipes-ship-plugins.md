# ADR 0017: Recipes may ship sous plugins

**Status:** Accepted, 2026-10-29.

This record supersedes [ADR 0012](0012-recipes-and-plugins.md) (recipes do not install Sous
plugins). It summarizes a decision of the 1.0 architecture; the source of truth is
[S1: The Engine](../architecture/specifications/S1-engine.md) ("Where plugins come from", "Recipes
that require npm plugins", "Types Across Plugins"), with the owner in
[S6: Concerns and Owners](../architecture/specifications/S6-concerns-and-owners.md) ("Recipes").
Where this record and those files disagree, they win.

## Context

ADR 0012 ruled that a recipe could not install a Sous plugin, and that every Sous plugin besides
the built-ins would come from npm. Under the 1.0 architecture almost everything sous does is a
plugin (ADR 0014), so a team that wants its own build step, Liquid filter or agent tool shared
across its projects would otherwise have to publish an npm package and add it to every project's
`package.json`. A recipe already reaches every subscribed project, pinned and trust-gated. The
maintainer reversed the earlier ruling:

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

- **Nothing inside a repository runs until the repository is trusted.** Trust (ADR 0001) is now the
  gate for code that extends sous, not only for content.
- **`plugin-recipes` downloads and loads recipe plugins during the config build** (ADR 0015), cached,
  so later passes find them already there. A recipe plugin's `.d.ts` is copied, from the locked
  version, into `.sous/types/`, so other plugins in the project get its types.
- **A recipe may require plugins from npm**, each with a version range:

    ```yaml
    # sous.recipe.yaml
    requires:
        plugins:
            sous-plugin-claude-code: "^1.0.0"
    ```

  `sous subscription add` refuses a recipe whose required plugin is missing or out of range; run
  interactively it offers to install the plugin through the project's package manager, and
  `--install-plugins` does the same without a prompt. A build fails when a subscribed recipe's
  requirement is broken, naming the plugin and the command that installs it.
- **A recipe may still install tool plugins** (for example a Claude Code plugin), as ordinary
  content.

## Consequences

- A user can add functionality, plugins included, through a project-level recipe.
- Subscribing to a recipe from a trusted repository can now run code that changes how sous builds,
  so trusting a repository carries more weight, and `sous plugins show` names every recipe plugin
  and what it registered.
- A recipe plugin can be written in TypeScript or JavaScript, but ships compiled into one file.
- How a recipe held only through `depends` treats its plugin is not settled by the architecture;
  ADR 0009's rule that a library registers nothing of its own is the standing expectation.
