---
name: about-sous-recipes
description: >
  YOU MUST load this skill when creating or changing a sous recipe: its sous.recipe.yaml, its
  version, the variables it asks for, the files it publishes, its depends or subscribes lists,
  or a partial or @~ include inside it.
user-invocable: false
license: Apache-2.0
compatibility:
  - claude
  - codex
---

# About Sous Recipes

A **recipe** is a versioned bundle of agent instructions that sous installs into every project
subscribed to it. It is one folder in a recipe repository, holding a `sous.recipe.yaml` manifest
beside the files it publishes. For the repository around it (the repo manifest, the index,
releasing and proposing), YOU MUST load `about-sous-repos`. For writing a skill inside it, YOU MUST
load `about-agent-skills`.

## The Manifest

The manifest is YAML or JSON, never JavaScript, and unknown keys are refused except extension keys
starting with `x-`. A typical one:

```yaml
formatVersion: 1
namespace: review
name: checklist
version: 1.2.0
description: >-
  A pre-merge review checklist, with a command that walks a change through it.
depends:
  - review/wording
contents:
  - kind: skills
    include:
      - skills/**/*
```

The fields in that example:

- `formatVersion` is always `1`.
- `namespace` MUST be declared in the repo manifest, and `name` is unique inside it. Both are
  lowercase kebab-case, and together (`review/checklist`) they are the recipe's identity.
- `version` is an exact semantic version (see "Raising the Version").
- `description` is optional; it is copied into the index, and shown by `sous recipe list` and
  `sous repo search`.
- `contents` is what a subscriber receives: one group per kind (`skills`, `memories`, `prompts` or
  `config`), each with `include` globs and optional `exclude` globs, relative to the recipe folder.
  The subscribing project decides where skills, memories and prompts land. A `config` file becomes
  a config layer in the project, loaded under the project's own config so the project always wins;
  it MUST be `.json`, `.jsonc`, `.yaml` or `.yml`, and every key outside `_aliases`, `_vars`,
  `compilation`, `recipeOutputs`, `runtimeContext`, `store` and `varMappings` is dropped with a
  warning. A recipe that only bundles others may leave `contents` out.
- `depends`, `subscribes` and `variables` are described below; `submissions` is in
  `about-sous-repos`.

A file whose name contains `.tpl.` is rendered through LiquidJS and loses the `.tpl.`; every other
file is copied as it is. YOU MUST load `about-liquid-templates` before deciding which a file needs.

## Raising the Version

Every change to a published recipe raises its version, in the same change. Versions are semantic:

- **patch** for wording and fixes;
- **minor** for new files or a new optional variable;
- **major** for anything that breaks an existing subscriber: removing or renaming a file, renaming or
  removing a variable, or tightening a variable's validation.

The version rises once per release. When several changes to one recipe travel together, it rises
once, by the largest step any of them needs. A version already raised past the recipe's last tag
is left alone by every later release run.

A contributor proposing a change edits `version` by hand. A maintainer releasing from the
repository itself may instead commit the change and run
`sous repo release --recipe <namespace>/<recipe> --bump <level>` (`patch` by default, `minor`,
`major` or `prerelease`), which raises every changed recipe in scope whose version still equals its
last tag and commits the raise together with the regenerated index. A proposal MUST NOT carry that
index change, because `sous repo submit` refuses one that edits `sous.index.json`;
`about-sous-repos` describes the rest of that run.

Example: `review/checklist` is at `1.2.0`, its last tag. One pull request fixes a typo (a patch) and
adds a command (a minor). The manifest goes to `1.3.0`, once.

## Variables

A recipe that needs a value from the project declares a **definition**; the project stores the
answer in its env files, and a `.tpl.` file renders it by the definition's name.

```yaml
variables:
  - name: reviewNotesDir
    type: path
    prompt: Where should review notes be kept?
    description: >-
      The checklist command writes one note per branch into this directory. The
      default keeps them inside the project's .sous directory. Any path works,
      relative to the project root or absolute.
    example: docs/review-notes
    default: .sous/review-notes
    scope: shared
```

The fields in that example, and the ones it leaves out:

- `name` is camelCase. `type` is `string`, `number`, `boolean`, `enum`, `path` or `url`; an `enum`
  MUST list its options under `validate.enum`. `required` defaults to true.
- `description` and `example` are REQUIRED; a manifest missing either is refused. The description
  says, in full sentences, what the setting is for, what the default does, and what else is
  acceptable; the `prompt` is one plain question. An example is only shown beside the question,
  never stored or offered as an answer; a `default` is the answer of last resort. Both MUST fit the
  declared type.
- Every variable MUST provide a conservative default: the answer that does the least harm when the
  project never chose one. For example, a setting for whether the agent may merge pull requests on
  its own defaults to "only when asked", never to "always".
- `scope: local` stores the answer in the gitignored `.sous/.env.local`; use it for anything that
  belongs to one person or one machine. `scope: shared`, the default, stores it in the committed
  `.sous/.env`.
- `secret: true` hides the value wherever sous prints it. A secret MUST also set `scope: local`
  explicitly; a secret left at the default scope is refused.
- `env` names the environment variable the answer binds to, for example to reuse a `GITHUB_TOKEN`
  the environment already carries. Left out, it is `SOUS_VAR_` plus the name in upper snake case
  (`reviewNotesDir` becomes `SOUS_VAR_REVIEW_NOTES_DIR`). Two definitions of different names MUST
  NOT claim the same environment variable.
- `validate` takes `pattern`, `minLength`, `maxLength`, `min`, `max` and `enum`. Within a major
  version a definition MAY only loosen; tightening is a major bump, because an upgrade re-checks the
  answers already stored.

## Depends and Subscribes

Both lists name other recipes, and they do different things:

- `depends` makes the other recipe a **library** for this one. It is fetched and pinned, and its
  files can be included from this recipe's templates, but its files never reach the subscriber's
  output.
- `subscribes` is a **co-subscription**. The other recipe's files land and its questions are asked,
  as if the project had subscribed to it too.

Each entry names its target by where it lives, in one of two forms:

- a bare `namespace/recipe` for a sibling in the same repository. With no range it means the
  version released alongside this one; an `@` range (npm's rules) is allowed but uncommon.
- a locator URL for a recipe in another repository, such as
  `github://example-org/team-recipes/review/wording@^1.0`. The scheme is the provider, and the last
  two segments are always the recipe's namespace and name, never a path on disk.

`local://` locators and `repo:` short names are refused: both are one project's private view of a
repository, and a published manifest is read everywhere.

## Includes and Partials

A line holding only `@~<namespace>/<recipe>/<path>.md`, starting at the first column, includes that
file from a recipe at its pinned version. Inside a recipe it resolves only against the recipe
itself and the recipes it lists under `depends` or `subscribes`; the path may not be absolute or
contain `.` or `..` segments, and it MUST end in `.md` (`notes.md` also finds `notes.tpl.md`). A
line inside a fenced code block is never an include.

A **partial** is a short piece of text several skills share, kept in the recipe's `_partials/`
folder beside `skills/`. As long as no `contents` glob covers `_partials/`, it is never installed on
its own; it reaches a project only inside the skills that include it:

```markdown
What to review: $ARGUMENTS

@~review/checklist/_partials/review-rules.md
```

The included text is pasted in before rendering, so any Liquid inside a partial renders only when
the including file is a `.tpl.` file, and then with that file's variables. A partial SHOULD
therefore hold no template variables.

## Source for this Skill

This skill comes from the `core/sous-skills` recipe, installed by sous from a recipe
repository. It was compiled from a template, so edit the source, never this output file.

- Source Path: {{ sousTemplatePath }}
