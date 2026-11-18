# ADR 0033: Open content kinds, `$file`, and a literal `${`

**Status:** Accepted, 2026-11-18.

The design is [S12, Manifests as Config](../architecture/specifications/S12-manifests-as-config.md)
and the changes of 2026-11-18 in
[S5, Config Expressions](../architecture/specifications/S5-config-expressions.md).

## Context

A manifest's `contents` groups had a closed list of four kinds (`skills`, `memories`, `prompts`,
`config`). A coding tool's part of sous needs a kind of its own (a Claude Code plugin folder). Large
values in a declared edit (a list of permission rules) are awkward to write inline in YAML. And a
config value had no way to hold a literal `${...}` that belongs to another tool.

## Decision

### Content kinds are open

> "I think kinds _should_ be open. That follows our existing design patterns, I think."
>
> "I also think we should error when a recipe tries to provide a kind that does not exist."
>
>   -- **Luke Chavers** in an agent session (2026-11-17)

- An entity kind, `content-kind` (`{ id, description }`), defined by plugin-recipes, which
  registers the four existing kinds. A plugin adds a kind by adding an entity and responds to the
  `recipes.contents` entries of that kind.
- In a subscriber's project, an unregistered kind is a `ConfigError` judged once config building
  has finished (a plugin shipped in a recipe may register its kind in a later pass). It names the
  kind and the recipe, and says the plugin providing it may be missing from npm or may ship as part
  of a recipe.
- At release, Luke chose option 1 of 3: an error when the recipe has no `requires.plugins`, no
  `subscribes` and ships no plugin of its own; a warning otherwise.
- A failed npm install of a plugin named under `requires.plugins` ends with Luke's line: "Perhaps
  the required plugin ships as part of a recipe?"

### `$file`

> "`b with the general $include` is my answer."
>
> "Sure, we can use $file instead. Seems better, anyway."
>
> "if a file contains `.tpl.`, its processed as a liquid template. Otherwise, its not interpolated at
> all."
>
>   -- **Luke Chavers** in an agent session (2026-11-17)

An object whose only key is `$file` stands in for the file's value anywhere in a config file and in
a manifest. The path is relative to the containing file and interpolated for variables; JSON, JSONC
and YAML give a structured value, anything else a string; the file is an input to config building,
watched in watch mode. `$file` joins S5's exact list of reserved keys.

### A literal `${`

> "we will add a note that we should provide a way to escape variables in interpolation
> operations."
>
>   -- **Luke Chavers** in an agent session (2026-11-17)

The agent chose `$${`: `$${CLAUDE_PLUGIN_ROOT}` gives the literal `${CLAUDE_PLUGIN_ROOT}`. It is the
escape Docker Compose and Terraform use, and unlike a backslash it needs no escaping of its own in
JSON. A value read with `$file` from a file that is not a template has every `${` escaped this way,
so it reaches its reader as the file holds it.

## Consequences

- A typo in a kind is caught at release when nothing could provide the kind, and in every
  subscriber's build otherwise.
- `$file` also covers splitting a large config (gh-36's need).
- Text that legitimately starts with `$${` must now be written `$$${`.
