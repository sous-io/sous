# Repository File Formats

The reference for every file and config key in the Repositories system. For how to use them, see
[Consuming recipes](repositories-consuming.md), [Recipe variables](repositories-variables.md) and
[Authoring a repository](repositories-authoring.md).

| File | Where | Written by | Holds |
|------|-------|-----------|-------|
| `sous.repo.yaml` | repository root | you | The repository's namespaces and where its recipe folders are |
| `sous.recipe.yaml` | each recipe folder | you | One recipe: version, dependencies, contents, variables |
| `sous.index.json` | repository root | `sous repo release` | Every published version, with hashes, tags and resolved dependencies |
| `sous.lock.json` | the project's `.sous/` | sous | The exact versions this project resolved to, and who holds each |
| `.sous.entry.json` | each store entry | sous | What a cached recipe version is, and when it was last used |
| `sous.links.json` | `.sous/` or `$SOUS_HOME` | `sous repo link` | Repositories redirected at a working copy on this machine |

Every one carries `formatVersion: 1`; a future incompatible change raises that number, so an older
sous refuses a file it would otherwise misread.

?> Hand-written manifests are YAML or JSON, never JavaScript: `sous.repo.yaml`, `.yml`, `.json` or
`.jsonc` (both JSON forms allow comments and trailing commas). Two in one directory is an error, not
a first-match win, and unknown keys are rejected except those starting with `x-`.

## Refs: how anything is named

```
ref := [ repo ":" ] namespace [ "/" recipe [ "@" range ] ]
```

So `workflow` is a whole namespace, `workflow/task-files@^1.2.0` one recipe constrained to a range
(npm's range rules; namespaces are not versioned), and `sous-recipes:workflow/task-files` the same
recipe in a named repository; a published manifest may not carry the `repo:` qualifier, which is a
consuming project's own label. Repository short names, namespaces and recipe names are lowercase
kebab-case, a recipe key is always both segments, and a repository identity is the host then the
path it lives at, lowercased. Variable names are camelCase, environment variable names upper snake
case, content hashes `sha256-` and 64 lowercase hex characters, timestamps ISO 8601.

## `sous.repo.yaml`

```yaml
formatVersion: 1                    # every format on this page carries it
name: qa-recipes                    # suggested short name; a project records its own
namespaces:
  workflow:
    description: Recipes about how work moves through a project.
recipes:                            # every recipe folder, relative to the repository root
  - recipes/workflow/qa-variables
```

| Field | Required | Notes |
|-------|----------|-------|
| `name` | yes | A suggestion only; `sous repo add --name` decides what a project calls it |
| `description`, `contribute` | no | A summary for anyone reading the repository, and where to send a contribution when a provider cannot support `sous repo submit` |
| `namespaces` | yes | Keyed by namespace name; each entry takes an optional `description` |
| `recipes` | yes | Relative paths, each holding a recipe manifest; a path listed twice is an error |

Every path in either manifest is checked: absolute paths, backslashes, `.` or `..` segments, empty
segments and trailing slashes are refused.

## `sous.recipe.yaml`

```yaml
formatVersion: 1
namespace: quality
name: qa-remote-dep
version: 0.1.0
depends:                            # fetched and pinned, but their files stay out of the project
  - workflow/qa-helper
  - github://sous-io/sous-recipes/workflow/sub-agent-delegation@^1.0
contents:                           # 'subscribes' takes the same two spellings as 'depends'
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

`contents[].kind` is `skills`, `memories`, `prompts` or `config`. The first three are written into
the project at the destinations [`recipeOutputs`](#configuration-keys) names; `config` entries are
loaded as config layers instead. `include` needs at least one glob; both lists are recipe-relative.

### Dependencies named by location

`depends` and `subscribes` share one grammar in two spellings: `workflow/qa-helper` is a sibling in
this same repository, and `github://sous-io/sous-recipes/workflow/sub-agent-delegation@^1.0` is a
recipe in another one.

The parsing rule for a locator URL: the scheme is the provider's own identifier (`github` and
`gitlab` ship today), and the path is read from the RIGHT. The last two segments are always the
namespace and the recipe; everything before them names the repository, whose first segment is the
host when it carries a dot and otherwise the provider's public host, so
`gitlab://gitlab.example.com/group/subgroup/project/workflow/task-files` resolves too. A trailing
`.git` is dropped; at most one `@` range may follow.

A manifest may not write a `repo:` qualifier, a `local://` locator (a local repository is a
convenience, not a published location), or a filesystem path such as `../qa-helper`.

### Variable definitions

A definition is a specification, not a value; [Recipe variables](repositories-variables.md) covers
how an answer is found and stored.

| Field | Required | Notes |
|-------|----------|-------|
| `name` | yes | camelCase, as templates refer to it |
| `type` | yes | `string`, `number`, `boolean`, `enum`, `path` or `url` |
| `prompt`, `description` | yes | The one-line question, and the paragraph explaining the variable; both are shown when sous asks and by `sous vars <name>` |
| `example` | yes | A realistic sample answer; documentation only, never stored and never a fallback. Use `default` for the value offered when nothing else is in scope |
| `env` | no | The environment variable an answer binds to; `sous repo release` derives an upper snake case default when it is omitted |
| `required`, `secret` | no | Default to `true` and `false`; a secret is always written to the gitignored `.sous/.env.local` |
| `scope` | no | `shared` (the committed `.sous/.env`) or `local` (the gitignored `.sous/.env.local`); defaults to `shared` |
| `validate` | no | `pattern`, `minLength`, `maxLength`, `min`, `max`, `enum` |

Publish-time checks: a `type: enum` variable must list its options under `validate.enum`;
`minLength` may not exceed `maxLength`, nor `min` exceed `max`; `default` and `example` must match
the declared type and, for an enum, be one of the options; `secret: true` with `scope: shared` is
refused, because the committed env file would leak it.

## `sous.index.json`

Machine-written by `sous repo release` and committed beside the recipes it describes. Adding a
repository fetches only this file; nothing else is downloaded until a project subscribes.

```json
{
  "formatVersion": 1, "name": "qa-recipes",
  "generatedAt": "2026-09-12T07:06:33.236Z", "generator": "0.2.0",
  "namespaces": { "quality": { "description": "Recipes that exercise the edges." } },
  "recipes": {
    "quality/qa-remote-dep": {
      "path": "recipes/quality/qa-remote-dep",
      "versions": {
        "0.1.0": {
          "dependencies": {
            "workflow/qa-helper": { "version": "0.1.0" },
            "workflow/sub-agent-delegation": { "range": "^1.0", "repo": "github.com/sous-io/sous-recipes" }
          },
          "hash": "sha256-46e75442aeb368116c8830ad382707759f1ecd03974c4b5d42a5fabffce0324f",
          "prerelease": false, "releasedAt": "2026-09-12T07:06:33.236Z",
          "tag": "quality/qa-remote-dep@0.1.0"
        }
      }
    }
  }
}
```

| Field | Where | Notes |
|-------|-------|-------|
| `$comment` | top level | Free text, since JSON has no comments; ignored, except as the marker on sous's own seed index |
| `generatedAt`, `generator`, `name`, `namespaces` | top level | When the index was generated and by which sous version, then the name and namespaces copied from the repository manifest |
| `recipes` | top level | Keyed `namespace/recipe`; a recipe whose namespace is not declared is an error. Each entry carries `path` (the recipe folder), `description`, and `versions`, keyed by exact version |
| `hash`, `tag` | per version | The content hash verified after every fetch, and the tag, which must be exactly `namespace/recipe@version` so a version can never point at a branch |
| `prerelease`, `releasedAt`, `seeded` | per version | Whether ranges skip it unless a subscription opts in, when it was released, and whether it is the copy sous folds in from its own package |
| `dependencies` | per version | Resolved at release time, keyed `namespace/recipe` |

A dependency entry carries `version` (a sibling, resolved exactly) or `range` plus `repo` (the
identity of the repository publishing it, whose own index resolves the range); at least one is
required. Installing a version installs these rather than re-resolving the manifest's ranges.

**The `seeded` field.** Sous ships the `core` recipe inside its own npm package, so a project can
build before it has ever reached the network. That copy is folded into the official repository's
index in memory, marked `seeded: true`, and resolved like anything else; if the repository publishes
that version already, the published one wins. Sous never writes `seeded` onto a fetched index.

## `.sous/sous.lock.json`

Machine-written, committed, and the reason a fresh clone restores with no prompts and no drift.

```json
{
  "formatVersion": 1,
  "recipes": {
    "quality/qa-remote-dep": {
      "hash": "sha256-46e75442aeb368116c8830ad382707759f1ecd03974c4b5d42a5fabffce0324f",
      "kind": "subscribes", "repo": "qa-recipes", "requestedBy": ["project"], "version": "0.1.0"
    },
    "workflow/qa-helper": {
      "hash": "sha256-78660ab9889e707a38befd193ad565f7d76fbf017e049f1ae87372bb2c69698d",
      "kind": "depends", "repo": "qa-recipes", "requestedBy": ["quality/qa-remote-dep"], "version": "0.1.0"
    }
  },
  "repos": {
    "qa-recipes": { "identity": "localhost/home/me/projects/qa", "url": "/home/me/Projects/qa" }
  }
}
```

| Field | Notes |
|-------|-------|
| `repos.<name>.url`, `.identity` | Where the repository lives, as recorded when it was added, and the canonical identity the store and index cache file it under. `identity` is optional on read only, for older lockfiles; it is derived from the URL and filled in on the next write |
| `repos.<name>.indexHash` | Hash of the index this lock was resolved against, when known |
| `recipes.<key>.repo` | The project's short name for the repository; must appear under `repos` |
| `recipes.<key>.version`, `.hash` | The version resolved, and the hash verified against the store after every fetch |
| `recipes.<key>.requestedBy`, `.kind` | Who holds the entry, the literal `project` or the key of a recipe that requires it, and whether that holder is a `subscribes` or a `depends` |

A repository appears under two names on purpose: the key is the project's own short name, which
every message uses, while `identity` is what the store is keyed by, so two projects with different
labels share one cached copy. `requestedBy` makes removal safe; the entry goes when its last holder
does.

## `.sous.entry.json` and the store

The store is machine-wide, immutable per version, and disposable (everything in it is re-fetchable
from a lockfile's pins). It lives under `$SOUS_HOME`, which defaults to `~/.sous`.

```
$SOUS_HOME/
  cache/<repository identity>/<namespace>/<name>/<version>/   .sous.entry.json, then the files
  cache/_indexes/github.com/sous-io/sous-recipes.json         the cached index
  cache/_indexes/github.com/sous-io/sous-recipes.meta.json    etag, fetchedAt, lastCheckedAt, ref
  repos/            checkouts cloned by 'sous repo link --global'
  sous.links.json   the machine-wide links map
```

The marker makes an entry self-describing, so the store is sweepable without consulting a project:

```json
{
  "formatVersion": 1, "repo": "github.com/sous-io/sous-recipes", "namespace": "workflow",
  "name": "sub-agent-delegation", "version": "1.0.0", "sizeBytes": 3032,
  "hash": "sha256-6841b6f61a9a62d84152bc0fcfe246af35b7f75001527d6addf55e51068f8387",
  "fetchedAt": "2026-09-12T07:06:57.123Z", "lastAccessAt": "2026-09-12T07:06:57.292Z"
}
```

`hash` is checked against the lockfile before the entry is used; `sizeBytes` and `lastAccessAt`
drive the size-capped, least-recently-used collection `sous repo gc` performs. The hash is SHA-256
over each file's path and bytes in a canonical order, with `.git`, the marker and anything reached
through a symlink excluded, so a version hashes the same on every machine.

## `sous.links.json`

A link redirects a repository away from the store and at a real working copy, which is how a
maintainer edits recipes. It is machine-local and never committed, because a link bypasses
versions, the lockfile and freshness checks.

```json
{ "formatVersion": 1, "links": {
  "qa-recipes": { "path": "/home/me/Projects/qa", "origin": "path",
    "linkedAt": "2026-09-12T07:07:42.800Z" } } }
```

Entries are keyed by the repository's configured short name. `path` is absolute; `origin` is `clone`
when sous cloned the working copy itself and `path` when it was pointed at an existing checkout, and
unlinking removes the entry while leaving either in place. Both the project's
`.sous/sous.links.json` and `$SOUS_HOME/sous.links.json` are read, and the project's entries win.

## Configuration keys

These live at the top level of the merged config; see [The config file](configuration.md) for the
rest of it.

```yaml
repos:
  sous-recipes:
    url: https://github.com/sous-io/sous-recipes
    provider: github       # inferred from the URL when omitted; github, gitlab or local
    enabled: true          # false opts out of a repository sous provides itself
    alwaysPull: false      # install a newer in-range version rather than holding the lock
    addedAt: "2026-09-12T07:06:45.468Z"   # provenance; addedBy is "user", or the ref of
    addedBy: user                         # the recipe whose dependency pulled it in
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
| `repos` | the short name refs use | Adding a repository IS trusting it, and removing the entry withdraws that trust. `url` may be a URL or an absolute path to a repository on this machine, which the `local` provider reads with identical trust semantics |
| `subscriptions` | a ref key | A bare namespace (every recipe in it, including ones published later) or `namespace/recipe`. No repo qualifier and no range in the key |
| `enabled: false` | either of the two above | The opt-out for the entries sous provides itself, the `sous-recipes` repository and the `core` subscription. A hand-written entry under either key replaces sous's default outright |
| `store` | fixed fields | Plain numbers, all optional; the values sous ships are defaults, not assumptions |
| `recipeOutputs` | content kind | Destination directories, each `${var}` substituted like any other config path. Only `skills` has a default, `<project root>/.claude/skills`; a kind with no destination is skipped, with one warning naming this key. A recipe's `config` contents are loaded as layers rather than written, so they are not listed here |
| `varMappings` | environment variable name | Binds one name to one recipe variable, written `namespace/recipe/variableName` with an optional `repo:` qualifier |

## Managed config layers

Three files in a project's `conf.d/` are written by sous rather than by a person, in the `500` to
`599` band reserved for machine-written layers; a hand-written config or non-5xx layer is never
touched.

| Layer | Holds | Written by |
|-------|-------|-----------|
| `500-repos.jsonc` | `repos` | `sous repo add`, `sous repo remove` |
| `510-subscriptions.jsonc` | `subscriptions` | `sous subscription add`, `sous subscription remove` |
| `520-var-mappings.jsonc` | `varMappings` | `sous vars ask` |

They are `.jsonc` so they can carry real comments, and each opens with a header saying what it is:

```jsonc
// This file is managed by sous. Sous edits these files by key; you may edit
// them too, and your comments, key order and formatting are kept.
//
// It records the repositories this project trusts. The 'sous repo add' and
// 'sous repo remove' commands write the entries under 'repos'.
{ "repos": { "qa-recipes": { "url": "/home/me/Projects/qa", "addedBy": "user" } } }
```

**Edit by key.** Sous rewrites only the bytes of the entry it is changing, staging the result to a
temporary name and renaming it over the file, so your comments, key order and formatting survive
and an interrupted write leaves the previous layer rather than a truncated one.

A layer still carrying its old `.json` name is read as a fallback and migrates on the next write:
the `.jsonc` file is written and the `.json` one removed, so a project never ends up with both (two
layers whose names match once the final extension is stripped are a hard config error; see [Layers
and merging](config-layers.md)).
