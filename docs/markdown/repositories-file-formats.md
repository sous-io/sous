# Repository File Formats

The reference for every file and config key in the Repositories system; the pages explaining how to use them
are listed at the end. You write the repository manifest and one recipe manifest per recipe; sous writes the
rest: the published index, a project's lockfile, the marker on a store entry, and the links map.

Every one carries `formatVersion: 1`; a future incompatible change raises that number, so an older sous
refuses a file it would otherwise misread.

?> Both hand-written manifests are YAML or JSON, never JavaScript: `.yaml`, `.yml`, `.json` or `.jsonc`
(both JSON forms allow comments and trailing commas). Two in one directory is an error, not a first-match
win. Unknown keys are rejected except extension keys starting with `x-`, carried through untouched; [the one
sous reads](repositories-authoring.md#declare-the-variables-a-recipe-needs) is `x-intentional`. Every path
in a manifest is checked: absolute paths, backslashes, `.` or `..` segments, empty segments and trailing
slashes are refused.

## Refs: how anything is named

```text
ref := [ repo ":" ] namespace [ "/" recipe [ "@" range ] ]
```

So `workflow` is a whole namespace, `workflow/task-files@^1.2.0` one recipe constrained to a range (npm's
rules; namespaces are not versioned), and `sous-recipes:workflow/task-files` that recipe in a named
repository. Only a consuming project writes the `repo:` qualifier; it is that project's own label.

| Thing | Shape |
|-------|-------|
| Repository short name, namespace, recipe name | lowercase kebab-case |
| Recipe key | always both segments, `namespace/recipe` |
| Repository identity | the host, then the path it lives at, lowercased |
| Variable name, environment variable name | camelCase, and upper snake case |
| Content hash | `sha256-` and 64 lowercase hex characters |
| Timestamp | ISO 8601 |

## `sous.repo.yaml`: the repository manifest

```yaml
formatVersion: 1                    # every format on this page carries it
name: qa-recipes                    # suggested short name; a project records its own
namespaces:
  workflow:
    description: Recipes about how work moves through a project.
  quality:
    description: Recipes that exercise the edges.
recipes:                            # every recipe folder, relative to the repository root
  - recipes/workflow/qa-variables
  - recipes/quality/qa-remote-dep
```

| Field | Required | Notes |
|-------|----------|-------|
| `name` | yes | A suggestion only; `sous repo add --name` decides what a project calls it |
| `description`, `contribute` | no | A summary for anyone reading the repository, and where to send a contribution when a provider cannot support `sous repo submit` |
| `namespaces` | yes | Keyed by namespace name; each entry takes an optional `description` |
| `recipes` | yes | Relative paths, each holding a recipe manifest; a path listed twice is an error |

## `sous.recipe.yaml`: the recipe manifest

```yaml
formatVersion: 1
namespace: quality
name: qa-remote-dep
version: 0.1.0
depends:                            # 'subscribes' takes the same two spellings
  - workflow/qa-helper
  - github://sous-io/sous-recipes/workflow/sub-agent-delegation@^1.0
contents:                           # what a subscriber actually receives
  - kind: skills
    include: [skills/**/*.md]       # 'exclude' is the optional counterpart
```

| Field | Required | Notes |
|-------|----------|-------|
| `namespace`, `name` | yes | The namespace must be declared by the repository manifest; the name is unique within it |
| `version` | yes | An exact semantic version; the manifest is the source of truth and the git tag follows it |
| `description` | no | Copied into the index at release time; shown by `sous recipe list` and `sous repo search` |
| `depends`, `subscribes` | no | Build dependencies and co-subscriptions; within either list, no entry may repeat |
| `contents`, `variables` | no | Contents default to an empty list, which is what a curated bundle publishes; a duplicated variable name, or two definitions claiming one `env`, is an error |

`contents[].kind` is `skills`, `memories`, `prompts` or `config`. The first three are written to the
destinations named by [`recipeOutputs`](#recipeoutputs-where-the-files-land); `config` entries become config
layers instead. `include` needs at least one glob, and both lists are recipe-relative.

### Dependencies named by location

`depends` and `subscribes` share one grammar in two spellings: `workflow/qa-helper` is a sibling in this
same repository, and `github://sous-io/sous-recipes/workflow/sub-agent-delegation@^1.0` is a recipe in
another one. A locator URL's scheme is the provider's identifier (`github` and `gitlab` ship today), and its
path is read from the RIGHT: the last two segments are the namespace and the recipe, and everything before
them names the repository, whose first segment is the host when it carries a dot and otherwise the
provider's public host, so `gitlab://gitlab.example.com/group/subgroup/project/workflow/task-files`
resolves. A trailing `.git` is dropped and at most one `@` range may follow. A manifest may write no `repo:`
qualifier, no `local://` locator (a local repository is a convenience, not a published location) and no
filesystem path such as `../qa-helper`.

### Variable definitions

A definition is a specification, not a value; [Recipe variables](repositories-variables.md) covers how an
answer is found and stored, and a worked pair of definitions, including a secret, is in [Declare the
variables a recipe needs](repositories-authoring.md#declare-the-variables-a-recipe-needs).

```yaml
variables:
  - name: qaTaskRoot
    type: path
    prompt: Where should the review notes be stored?
    description: One review note per branch is read from and written to this directory.
    example: ~/qa-notes
    default: .sous/qa-notes
```

| Field | Required | Notes |
|-------|----------|-------|
| `name`, `type` | yes | camelCase, as templates refer to it; one of `string`, `number`, `boolean`, `enum`, `path` or `url` |
| `prompt`, `description` | yes | The one-line question, and the paragraph explaining the variable; both are shown when sous asks and by `sous vars show <name>` |
| `example` | yes | A realistic sample answer; documentation only, never stored and never a fallback. Use `default` for the value offered when nothing else is in scope |
| `env` | no | The environment variable an answer binds to; omitted, it is `SOUS_VAR_` plus the upper snake case form of the variable's own name, so `qaScratchDir` binds to `SOUS_VAR_QA_SCRATCH_DIR` |
| `required`, `secret` | no | Default to `true` and `false`; a secret is always written to the gitignored `.sous/.env.local` |
| `scope` | no | `shared` (the committed `.sous/.env`) or `local` (the gitignored `.sous/.env.local`); defaults to `shared` |
| `validate` | no | `pattern`, `minLength`, `maxLength`, `min`, `max`, `enum` |

At publish time: a `type: enum` variable must list its options under `validate.enum`; `minLength` cannot
exceed `maxLength`, nor `min` exceed `max`; `default` and `example` must match the type and, for an enum, be
one of its options; `secret: true` with `scope: shared` is refused; the committed env file would leak it.

## `sous.index.json`

Machine-written by `sous repo release` and committed beside the recipes it describes. Adding a repository
fetches only this file; nothing more is downloaded until a project subscribes.

```json
{
  "formatVersion": 1, "name": "qa-recipes", "generator": "0.2.0",
  "generatedAt": "2026-09-12T07:06:33.236Z",
  "namespaces": { "quality": { "description": "Recipes that exercise the edges." } },
  "recipes": { "quality/qa-remote-dep": { "path": "recipes/quality/qa-remote-dep",
    "versions": { "0.1.0": {
      "dependencies": { "workflow/qa-helper": { "version": "0.1.0" },
        "workflow/sub-agent-delegation": { "range": "^1.0", "repo": "github.com/sous-io/sous-recipes" } },
      "hash": "sha256-46e75442aeb368116c8830ad382707759f1ecd03974c4b5d42a5fabffce0324f",
      "prerelease": false, "releasedAt": "2026-09-12T07:06:33.236Z",
      "tag": "quality/qa-remote-dep@0.1.0"
    } } } }
}
```

| Field | Where | Notes |
|-------|-------|-------|
| `generatedAt`, `generator`, `name`, `namespaces` | top level | When the index was generated and by which sous version, then the name and namespaces copied from the repository manifest. `$comment` is free text, since JSON has no comments, and is ignored on a published index |
| `recipes` | top level | Keyed `namespace/recipe`; a recipe whose namespace is not declared is an error. Each entry carries `path` (the recipe folder), `description`, and `versions`, keyed by exact version |
| `hash`, `tag` | per version | The content hash verified after every fetch, and the tag, which must be exactly `namespace/recipe@version` so a version can never point at a branch |
| `prerelease`, `releasedAt`, `seeded` | per version | Whether ranges skip it unless a subscription opts in, when it was released, and whether it is the copy sous folds in from its own package |

Dependencies are resolved at release time and keyed `namespace/recipe`. An entry carries `version` (a
sibling, resolved exactly) or `range` plus `repo` (the identity of the repository publishing it, whose own
index resolves the range); at least one is required. Installing a version installs these rather than
re-resolving the manifest's ranges.

**The `seeded` field.** Sous ships the `core` recipe in its own npm package, so a project can build before
reaching the network. That copy is folded into the official repository's index in memory and resolved like
any other, marked `seeded: true`; if the repository already publishes it, the published copy wins. Sous
never writes `seeded` onto a fetched index, and when it writes the placeholder into the index cache it
stamps a fixed `$comment`, so a later run can tell its own placeholder from a real index and replace it.

## `.sous/sous.lock.json`

Machine-written, committed, and the reason a fresh clone restores with no prompts and no drift.

```json
{
  "formatVersion": 1,
  "recipes": {
    "quality/qa-remote-dep": { "kind": "subscribes", "repo": "qa-recipes", "version": "0.1.0",
      "requestedBy": ["project"], "hash": "sha256-46e75442aeb368116c8830ad38...ffce0324f" },
    "workflow/qa-helper": { "kind": "depends", "repo": "qa-recipes", "version": "0.1.0",
      "requestedBy": ["quality/qa-remote-dep"], "hash": "sha256-78660ab9889e707a38be...b2c69698d" }
  },
  "repos": { "qa-recipes": { "identity": "localhost/home/me/projects/qa", "url": "/home/me/Projects/qa" } }
}
```

| Field | Notes |
|-------|-------|
| `repos.<name>.url`, `.identity`, `.indexHash` | Where the repository lives, as recorded when it was added; the canonical identity the store and index cache file it under; and the hash of the index this lock was resolved against, when known |
| `recipes.<key>.repo`, `.version`, `.hash` | The project's short name for the repository, which must appear under `repos`; the version resolved; and the hash verified against the store after every fetch |
| `recipes.<key>.requestedBy`, `.kind` | Who holds the entry, the literal `project` or the key of a recipe that requires it, and whether that holder is a `subscribes` or a `depends` |

A repository appears under two names on purpose: the key is the project's own short name, which every
message uses, while `identity` is what the store is keyed by, so two projects with different labels share
one cached copy. `identity` is optional on read only, for older lockfiles, and is derived from the URL on
the next write. `requestedBy` makes removal safe; an entry goes when its last holder does.

## The store on disk

The store is machine-wide, immutable per version, and disposable (everything is re-fetchable from a
lockfile's pins); every entry carries a `.sous.entry.json` marker. It sits under `$SOUS_HOME`, default
`~/.sous`.

```text
$SOUS_HOME/
  cache/<repository identity>/<namespace>/<name>/<version>/   .sous.entry.json, then the files
  cache/_indexes/<repository identity>.json                   the cached index
  cache/_indexes/<repository identity>.meta.json              etag, fetchedAt, lastCheckedAt, ref
  repos/            checkouts cloned by 'sous repo link --global'
  sous.links.json   the machine-wide links map
```

The marker makes an entry self-describing, so the store is sweepable without consulting a project:

```json
{ "formatVersion": 1, "repo": "github.com/sous-io/sous-recipes", "namespace": "workflow",
  "name": "sub-agent-delegation", "version": "1.0.0", "sizeBytes": 3032,
  "hash": "sha256-6841b6f61a9a62d84152bc0fcfe246af35b7f75001527d6addf55e51068f8387",
  "fetchedAt": "2026-09-12T07:06:57.123Z", "lastAccessAt": "2026-09-12T07:06:57.292Z" }
```

`hash` is checked against the lockfile before the entry is used, and `sizeBytes` and `lastAccessAt` drive
the size-capped, least-recently-used collection `sous repo gc` performs. The hash is SHA-256 over each
file's path and bytes in a canonical order, with `.git`, the marker and anything behind a symlink excluded,
so a version hashes the same on every machine.

## `sous.links.json`

A link redirects a repository away from the store and at a real working copy, which is how a maintainer
edits recipes. It is machine-local and never committed, because a link bypasses versions, the lockfile and
freshness checks; entries are keyed by the repository's configured short name.

```json
{ "formatVersion": 1, "links": {
  "qa-recipes": { "path": "/home/me/Projects/qa", "origin": "path", "linkedAt": "2026-09-12T07:07:42.800Z" } } }
```

`path` is absolute; `origin` is `clone` when sous cloned the working copy itself and `path` when it was
pointed at an existing checkout, and unlinking removes the entry while leaving either in place. Both the
project's `.sous/sous.links.json` and `$SOUS_HOME/sous.links.json` are read, and the project's entries win.

## Configuration keys

These live at the top level of the merged config; [The config file](configuration.md) covers the rest.

```yaml
repos:
  sous-recipes:
    url: https://github.com/sous-io/sous-recipes
    provider: github       # inferred from the URL when omitted; github, gitlab or local
    enabled: true          # false opts out of a repository sous provides itself
    alwaysPull: false      # install a newer in-range version rather than holding the lock
    addedBy: sous          # provenance; "user", "sous" for an entry sous provides itself, or the
                           # ref of the recipe that pulled it in; one you add records 'addedAt' too
subscriptions:
  workflow/task-files:
    range: "^1.2.0"        # defaults to "*"; prerelease, enabled, alwaysPull, addedAt
    prerelease: false      # and addedBy work as they do above
store:                     # every value is a default you can change
  maxBytes: 1073741824     # one gigabyte; past it, 'sous repo gc' evicts unpinned entries
  freshnessSeconds: 300    # how long a fetched index stays fresh
  watchPollSeconds: 300    # how often watch mode polls upstream
recipeOutputs:             # 'memories' and 'prompts' take the same list-of-paths shape
  skills: ["${projectRoot}/.claude/skills", "${projectRoot}/.codex/skills"]
varMappings:
  QA_SERVICE_TOKEN: workflow/qa-variables/qaServiceToken
```

| Key | Keyed by | Notes |
|-----|----------|-------|
| `repos` | the short name refs use | Adding a repository IS trusting it, and removing the entry withdraws that trust |
| `subscriptions` | a ref key | A bare namespace (every recipe in it, including ones published later) or `namespace/recipe`. No repo qualifier and no range in the key |
| `enabled: false` | either of the two above | The opt-out for the entries sous provides itself, the `sous-recipes` repository and the `core` subscription |
| `store` | fixed fields | Plain numbers, all optional; the values sous ships are defaults, not assumptions |
| `recipeOutputs` | content kind | Destination directories per kind; see [recipeOutputs: where the files land](#recipeoutputs-where-the-files-land) |
| `varMappings` | environment variable name | Binds one name to one recipe variable, written `namespace/recipe/variableName` with an optional `repo:` qualifier |

A repository's `url` may be a URL or an absolute path to one on this machine, read by the `local` provider
with identical trust. A hand-written entry is laid over sous's default field by field, so an entry holding
`{ enabled: false }` is a complete opt-out, and a written `url` repoints the repository while the rest of
the default stands.

### recipeOutputs: where the files land

Where each content kind lands, `${var}` substituted as in any config path. Only `skills` has a default,
`<project root>/.claude/skills`; sous cannot guess where memories or prompts go, so a kind with no
destination is skipped and one warning names this key. A recipe's `config` contents become layers, not files.

## Managed config layers

Three files in a project's `conf.d/` are written by sous rather than by a person, in the machine-written
`500` to `599` band described under [Layers and merging](config-layers.md#the-managed-5xx-layer-band). They
are `.jsonc` so they can carry real comments, and each opens with a header saying what it is:

| Layer | Holds | Written by |
|-------|-------|-----------|
| `500-repos.jsonc` | `repos` | `sous repo add`, `sous repo remove` |
| `510-subscriptions.jsonc` | `subscriptions` | `sous subscription add`, `sous subscription remove` |
| `520-var-mappings.jsonc` | `varMappings` | `sous vars ask` |

```jsonc
// This file is managed by sous. Sous edits these files by key; you may edit
// them too, and your comments, key order and formatting are kept.
//
// It records the repositories this project trusts. The 'sous repo add' and
// 'sous repo remove' commands write the entries under 'repos'.
//
// It is JSON with comments (.jsonc): line comments, block comments and trailing
// commas are all allowed here.
{ "repos": { "qa-recipes": { "url": "/home/me/Projects/qa", "addedBy": "user" } } }
```

A write rewrites only the bytes of the entry that changes, staging the result and renaming it over the file,
so an interrupted write leaves the previous layer rather than a truncated one. A layer still carrying its
old `.json` name is read as a fallback and migrates on the next write: the `.jsonc` file is written and the
`.json` one removed, so a project never ends up with both, which would be a hard config error.

## Where to go next

- [Repositories](repositories.md): the model, trust, and the lockfile
- [Consuming recipes](repositories-consuming.md): adding, subscribing and building
- [Authoring a repository](repositories-authoring.md): writing and releasing recipes
- [Providers](repositories-providers.md): how a URL becomes a repository identity
- [Troubleshooting repositories](repositories-troubleshooting.md): what each error means
