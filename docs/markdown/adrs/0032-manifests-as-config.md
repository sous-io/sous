# ADR 0032: A recipe's manifest is added to the config

**Status:** Accepted, 2026-11-18.

The design is [S12, Manifests as Config](../architecture/specifications/S12-manifests-as-config.md);
this record summarizes the ruling.

## Context

A recipe's manifest lists what the recipe publishes under `contents`. Until now the
`active-recipe` entity carried the whole parsed manifest, and the `recipes.contents` service read
`contents` from it directly. So a manifest had no key paths, no record of who set each value, and
no expression evaluation: a recipe could not publish a skill to one coding tool only, or leave out
a skill when a subscriber answered "no" to a question.

On 2026-11-16 Luke made this a law (L8, declarations as config):

> "I want us to implement a rule, or law, that all new code and all refactors of existing code
> should follow this concept, unless it is definitely impractical (which should lead to
> discussion)."
>
>   -- **Luke Chavers** in an agent session (2026-11-16)

And for manifests in particular:

> "I'm trying to re-orient manifests (and, ideally, everything like them that we introduce in the
> future) into this same approach. One plugin, perhaps `plugin-recipes`, adds every manifest to the
> config. Then, another plugin, or another configurer in the same plugin, or, something, idk,
> responds to those new entries."
>
>   -- **Luke Chavers** in an agent session (2026-11-16)

## Decision

- A contributor in plugin-recipes, `recipes.manifests`, adds each active recipe's `contents`
  groups to the config key `recipes.contents` (one entry per group: `recipe`, `dir`, `kind`,
  `include`, `exclude`), and appends each entry of the manifest's new top-level `edits` list to
  `editor.edits`, with `recipe` naming who declared it.
- These are fixed places. Luke: "They just have pre-determined injection points (i.e. they could
  not override a root key)."
- Expressions in `contents` and `edits` are evaluated by the machinery that evaluates them in
  config files, in the recipe's own answer scope, and can read `host.platform` and `harness.id`.
  `sous config show recipes.contents` shows the result.
- plugin-skills, plugin-memories and the recipe config layers read `recipes.contents`. The
  `recipes.contents` service stays as a reader of that key.
- A recipe's name, version, dependencies and variables stay fixed values, because sous reads them
  before any project is involved. `sous repo release` and the index accept an expression where
  they expected a string in `contents`.
- `contents` accepts inline content: `{ $inline: "...", path: "virtual/path.md" }`. Luke:
  "$inline can require a `path`, forcing implementers to define a virtual path."

## Consequences

- Any plugin can respond to a manifest's declarations by reading config, with the reads recorded,
  so a changed answer re-runs exactly what depends on it.
- `sous config get recipes.contents --layers` explains why a group is or is not there.
- The editor plugin receives recipe edits as ordinary `editor.edits` entries; it alone checks
  operations.
- A manifest's `handlers` (another piece of the same build) go into the config the same way.
