# S12: Manifests as Config

**Status:** Accepted on 2026-11-18, from Luke's rulings of 2026-11-16 and 2026-11-17. From now on, a
change to this specification is recorded under "Changes".

**Serves:** G10 (config as desired state), G3 (versatility, always), G4 (predictable and
observable).

**Related:** S2 (config building), S5 (config expressions, which gains `$file` and the `$${` escape
here), S6 (concerns and owners: sous-plugin-recipes, sous-plugin-skills, sous-plugin-memories).

## What This Specifies

A recipe's manifest (`sous.recipe.yaml`) declares what the recipe publishes (`contents`) and what it
changes in files it does not own (`edits`). Before this specification the `recipes.contents`
service read `contents` straight from the parsed manifest, so a manifest had no key paths, no record
of who set each value, and no expression evaluation. This specification makes a manifest's
declarations config values, as law L8 requires:

> "Anything that declares what sous should do or produce (a recipe manifest, and every file like it
> added later) is added to the config as values, by a contributor, during config building. Other
> contributors respond to those values by adding more config. Code that acts reads the finished
> config, and never reads the declaration's source itself."
>
>   -- Law L8, approved by **Luke Chavers** (2026-11-16)

It also specifies the pieces that came with it: open content kinds, `$file`, `$inline`, the `$${`
escape, and booleans in Liquid.

## The Contributor: `recipes.manifests`

One contributor in sous-plugin-recipes, `recipes.manifests`, runs after `recipes.fetch` and reads every
`active-recipe` entity. For each recipe, in recipe-key order (bytewise):

1. It evaluates the manifest's `contents` and `edits` with `expressions.evaluator`, exactly as a
   recipe's config file is evaluated: as data from a recipe (no language that runs code), in the
   recipe's own variable scope (`scopeKey` is the recipe key, so the recipe's own answers win), with a
   relative `$file` path resolved against the recipe's folder. The file is named
   `<namespace>/<recipe>/sous.recipe.yaml` in errors and in `sous config get --layers`.
2. For a recipe held through `subscribes`, it checks each evaluated `contents` group again (a pattern
   may not escape the recipe folder) and appends one entry per group to `recipes.contents`.
3. For any active recipe, it appends each evaluated `edits` entry to `editor.edits`, with the field
   `recipe` naming the recipe that declared it.

These are the only places a manifest writes to. Luke: "They just have pre-determined injection
points (i.e. they could not override a root key)." A recipe's name, version, dependencies and
variables stay fixed values, because sous reads them before any project exists (the repository
index, `sous repo release`).

### The shape of a `recipes.contents` entry

```jsonc
{
    "recipes": {
        "contents": [
            {
                "recipe": "acme/widget",
                "dir": "/home/me/.sous/store/github.com/acme/recipes/acme/widget/1.2.0",
                "kind": "skills",
                "include": [
                    "skills/**",
                    { "$inline": "# Hello\n", "path": "skills/hello/SKILL.md" }
                ],
                "exclude": ["skills/private/**"]
            }
        ]
    }
}
```

`include` and `exclude` are relative to `dir`. A recipe held only through `depends` adds no entry:
its files never enter the project's output.

### The shape of a recipe's `editor.edits` entry

The entry as the manifest wrote it, its expressions evaluated, plus `recipe`. A relative `file` is
relative to the project root, as every relative `file` in `editor.edits` is; the editor plugin
substitutes `${name}` variables and checks the operations.

```jsonc
{
    "editor": {
        "edits": [
            {
                "file": ".claude/settings.json",
                "ensureIncludes": { "path": "permissions.allow", "items": ["Bash(git-commit.sh:*)"] },
                "recipe": "voltagrid/session-harness"
            }
        ]
    }
}
```

The manifest's schema checks only the outer shape of `edits`: a list of objects, each holding an
operation, with or without `file` (a file-less operation such as `ensureDirectoryExists`). The
editor plugin owns the operations and their validation.

### Who responds

| Entries | Responder | What it adds |
| --- | --- | --- |
| `recipes.contents`, kind `skills` | sous-plugin-skills, `skills.targets` | compilation targets |
| `recipes.contents`, kind `memories` | sous-plugin-memories, `memories.targets` | a compilation target per memory target |
| `recipes.contents`, kind `config` | sous-plugin-recipes, `recipes.config-layers` | config values, limited to the keys a recipe may set |
| `editor.edits` | the editor plugin | (acts in its intent) |

The `recipes.contents` service stays, as a reader of the config: `entries(config, kind)` gives the
entries of a kind, `files(entry)` lists an entry's files (dot files count, `exclude` applies, links
whose target is not a file are left out), and `of(config, kind)` does both. Given a contributor's
builder, its reads are recorded, so a change to an entry re-runs the responder. It never reads a
manifest.

```ts
// A plugin that consumes its own kind
sous.entities.add("content-kind", { id: "claude-code-plugin", description: "A Claude Code plugin folder." });

sous.config.contribute({
    id: "claude-code.plugins",
    contribute(config) {
        for (const content of services.get("recipes.contents").of(config, "claude-code-plugin")) {
            for (const file of content.files) {
                // file.path, file.file, file.base; file.content for inline content
            }
        }
    },
});
```

## Expressions in a Manifest

Expressions (S5) may appear on any value of `contents` and `edits`: a whole group, a group's
`kind`, the whole `exclude` list, any item of `include` or `exclude`, a whole `edits` entry, or any
value inside one. They can read `host.platform`, `harness.id` (the empty string in the build with
no harness), `env.<NAME>` and recipe answers. An item whose expression gives `undefined` is dropped.

```yaml
contents:
  - kind: skills
    include:
      - skills/**/*
    exclude:
      - $if:
          expr: "harness.id != 'claude-code'"
          then: skills/session-harness/**/*
      - $if:
          expr: "jiraEnabled != true"
          then: skills/session-harness/skills/jira-*/**/*
```

`sous config show recipes.contents` shows the result, and `sous config get recipes.contents --layers`
shows each expression, what it read and what it gave.

`sous repo release` and the index builder parse manifests with the same schema, which accepts an
expression object wherever `contents` takes a value.

## Open Content Kinds

Luke: "I think kinds _should_ be open. That follows our existing design patterns, I think." And: "I
also think we should error when a recipe tries to provide a kind that does not exist."

- The entity kind `content-kind` (`{ id, description }`) is defined by sous-plugin-recipes, which
  registers `skills`, `memories`, `prompts` and `config`. A plugin adds a kind by adding an entity,
  and its contributor responds to the `recipes.contents` entries of that kind.
- The manifest schema accepts any kind name (lowercase words joined by hyphens).
- **In a subscriber's project**, an entry whose kind no entity registers is a `ConfigError`, judged
  when `config.built` fires (a plugin a recipe ships may register its kind in a later pass than the
  one that first read the manifest). It names the kind and the recipe, with the hint that the plugin
  providing the kind may be missing from npm or may ship as part of a recipe.
- **At release** (`sous repo release`), every kind a manifest could publish, literal or in any branch
  of an expression, is checked against the kinds registered in the repository. Luke chose: an ERROR
  when the recipe has no `requires.plugins`, no `subscribes` and ships no plugin of its own (nothing
  could ever register it, so it is a typo); a WARNING otherwise. Rejected: always a warning; always
  an error.
- When subscribing installs a plugin named under `requires.plugins` and the install fails, the error
  ends with Luke's line: "Perhaps the required plugin ships as part of a recipe?"

## `$file`

An object whose only key is `$file` stands in for a value, anywhere in a JSON, JSONC or YAML config
file and in a manifest. `$file` is added to S5's exact list of reserved keys.

- The path is relative to the file that contains it: a config file's folder, a recipe's folder.
- The path is interpolated for `${name}` variables. A variable not known yet gives `undefined` for
  the pass, as an expression does.
- The file is parsed by its extension: `.json`, `.jsonc`, `.yaml` and `.yml` give a structured value;
  anything else gives its text as a string. A file whose name contains `.tpl.` is rendered as
  Liquid first (with the variables, `host`, `env` and `harness`).
- No other file's content is interpolated. Every `${` in what a `$file` gives is escaped as `$${`,
  so a reader that substitutes variables later gets the text exactly as the file holds it.
- Expressions inside the file are not evaluated; the file is a value.
- The file is an input to config building: every file read is listed by
  `expressions.evaluator.files()`, and watch mode rebuilds the config when one changes.
- It combines with `$if`: a `$file` in a branch not chosen is never read.

Luke: "`b with the general $include` is my answer", then "Sure, we can use $file instead. Seems
better, anyway."

## `$inline`

An `include` item of a `contents` group may be inline content instead of a file pattern:

```yaml
contents:
  - kind: skills
    include:
      - $inline: |
          ---
          name: hello
          ---
          Say hello.
        path: skills/hello/SKILL.md
```

`path` is required (Luke: "$inline can require a `path`, forcing implementers to define a virtual
path") and is the path the content is treated as having: `exclude` patterns apply to it, and its
base is the path's first folder (`skills/hello/SKILL.md` is the skill `hello`). Inline content is not
interpolated, like a file's; it is rendered as Liquid only when its path contains `.tpl.`. Skills
compile it from a `content` compilation target, memories write it in place of an `@` include, and a
`config` layer is parsed by its path's extension.

## Writing a Literal `${`

`$${name}` in a config value is the literal text `${name}`. The substitution that uses the value
turns `$${` into `${` and never treats it as a reference, so an unknown name is not an error, and a
`_vars` entry holding it resolves at once. The escape follows Docker Compose's and Terraform's
`$${`. Example: a hook command `bash "$${CLAUDE_PLUGIN_ROOT}/x.sh"` reaches the settings file as
`bash "${CLAUDE_PLUGIN_ROOT}/x.sh"`.

## Booleans in Liquid

A recipe variable of type `boolean` answered `false`, or defaulting to `false`, reached templates
and config expressions as the text `"false"`, which Liquid treats as true. The earlier rule was
"answers are laid in as stored", and it never considered booleans. Now:

- the answer is given as `"true"` or `"false"`, whatever word stored it (`yes`, `off`, `0`);
- a `variable-source` entity may name the variables it gives that are booleans (`booleans()`); the
  recipe-answers source names every boolean definition, and the `variables.booleans` service
  collects them;
- every Liquid engine sous-plugin-liquid builds, and the config expression evaluator, sees a declared
  boolean's `"true"` and `"false"` as `true` and `false`. `${name}` still gives the text.
- Only booleans change. A `number` answer stays text (the agent's choice; it was left open), and the
  reports (`sous vars list`, `sous config show`) still show the stored text.

## Changes

None yet.
