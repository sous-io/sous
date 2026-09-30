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
| `submissions` | no | Whether the repository's recipes take proposed changes; see [The submissions block](#the-submissions-block) |

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
| `submissions` | no | Whether this recipe takes proposed changes, winning over the repository's block; see [The submissions block](#the-submissions-block) |

`contents[].kind` is `skills`, `memories`, `prompts` or `config`. The first three are written to the
destinations named by [`recipeOutputs`](#recipeoutputs-where-the-files-land); `config` entries become config
layers instead. `include` needs at least one glob, and both lists are recipe-relative.

### The submissions block

Both manifests accept a `submissions` block. On `sous.repo.yaml` it covers every recipe in the repository; on
`sous.recipe.yaml` it covers that recipe, and wins over the repository's.

```yaml
submissions:
  allowed: false                    # defaults to true
  instead: Propose changes in sous-io/sous, under recipes/core/sous-skills/.
```

It exists for a recipe whose files are copied in from somewhere else: an edit merged into the copy is
overwritten by the next copy, and a version it tagged can collide with the one the real source publishes.
`sous repo submit` warns before proposing a change that touches such a recipe, prints the `instead` text, and
proposes it if the contributor carries on. `sous repo release --check` fails a pull request that changes one,
because a pull request can be opened without `submit`, and the check is the one gate every change passes. A
release itself is never restricted, so whatever publishes the recipe still releases it.

### Dependencies named by location

`depends` and `subscribes` name their targets by where they live: `workflow/qa-helper` is a sibling in this
same repository, and `github://sous-io/sous-recipes/workflow/sub-agent-delegation@^1.0` is a recipe in
another one. Every spelling in [Ref forms](#ref-forms) that names a namespace or a recipe is accepted here,
except a `repo:` qualifier (one project's private name for a repository), a local path or `local://`
locator (a convenience, not a published location), and a location naming a whole repository with nothing
inside it. Names are recorded lowercase.

A ref is stored and printed as its published identity (namespace and recipe), never as a folder path. Any
spelling that settles to one identity is accepted, including a folder path or a pasted browser URL. Two
spellings need the other repository's index to settle: a GitLab URL with nested groups, which does not say
where the project path ends (`gitlab.com/a/b/c/d` may be project `a/b` naming the recipe `c/d`, or project
`a/b/c` naming the namespace `d`), and a browser URL, which names a folder. `sous repo release` settles each
by fetching the index of every candidate repository and keeping the reading whose index publishes what was
named, then records the repository it settled on in the index, beside each key the dependency reached. A
consumer reads that record and never probes. A network failure fails the release rather than guessing, and
two readings that both publish what is named fail it too, naming the spellings that read one way:
`gitlab://a/b/c/-/d/*` for the namespace, `gitlab://a/b/-/c/d` for the recipe.

### Ref forms

Every place a ref is written reads it with one parser, told where the ref came from. These forms are
recognized everywhere; the table after them says which each place allows. A refused form is an error saying
what to write there instead.

| Form | Example | Names |
| --- | --- | --- |
| A bare name | `workflow` | a namespace (on the command line, also a recipe or anything else by that name) |
| Namespace and recipe | `workflow/alpha` | a recipe |
| Namespace, spelled out | `workflow/*` | a namespace |
| Repository-qualified | `sous-recipes:workflow/alpha` | a recipe in the repository this project calls `sous-recipes` |
| With a range | `workflow/alpha@^1.2` | a recipe, within an npm-style range |
| Provider-scheme locator | `github://owner/repo/workflow`, `.../workflow/*`, `.../workflow/alpha` | a namespace or a recipe in that repository |
| A host other than the provider's own | `gitlab://gitlab.example.com/group/proj/-/workflow/alpha` | the same, on a self-hosted instance |
| HTTPS URL | `https://github.com/owner/repo/workflow/alpha` | the same as the locator |
| URL with no scheme | `github.com/owner/repo/workflow/alpha` | the same |
| SSH remote | `git@github.com:owner/repo.git`, `ssh://git@github.com/owner/repo.git/workflow` | the repository, or something inside it |
| Browser URL | `https://github.com/owner/repo/tree/main/recipes/workflow/alpha` | the recipe whose index `path` holds that folder (or a file in it); a folder holding one namespace's recipes names the namespace |
| GitLab separator | `https://gitlab.com/group/sub/proj/-/tree/main/recipes/workflow/alpha` | the same, with `/-/` marking where the project path ends |
| GitLab nested group | `gitlab://group/sub/proj/workflow/alpha` | every reading the path allows, settled as described above |

A `.git` suffix on the repository is dropped in every URL form. GitLab's canonical locator always marks the
end of the project path with `/-/`, so it reads one way.

| Place | Allows |
| --- | --- |
| The command line | every form; names in any case |
| A config file's subscription keys | `namespace` or `namespace/recipe`, lowercase; the repository is recorded in the lockfile and a range in the entry's `range` field |
| A recipe manifest's `depends` and `subscribes` | every form naming a namespace or a recipe, except `repo:` and a local location |
| A key sous stores (the lockfile, the index, the store) | `namespace` or `namespace/recipe`, lowercase |

Matching tries the exact spelling first, then ignores case; a name that still matches several things is a
question, answered by `--accept-first` or by choosing. What sous writes (config layers, the lockfile, the
index) and prints is always the canonical form: `namespace/recipe`, qualified with the repository's short
name where one is needed.

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
      "dependencies": {
        "workflow/qa-helper": { "version": "0.1.0", "declared": "workflow", "kind": "subscribes" },
        "workflow/sub-agent-delegation": { "range": "^1.0", "repo": "github.com/sous-io/sous-recipes",
          "declared": "github://sous-io/sous-recipes/workflow/sub-agent-delegation@^1.0",
          "kind": "depends" } },
      "depends": [ "github://sous-io/sous-recipes/workflow/sub-agent-delegation@^1.0" ],
      "subscribes": [ "workflow" ],
      "variables": [ { "name": "qaNotesDir", "type": "path", "prompt": "Where should notes go?",
        "description": "The directory QA notes are written to.", "example": "docs/qa",
        "default": ".sous/qa-notes", "required": true, "secret": false, "scope": "shared" } ],
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
| `dependencies` | per version | What the version was released against, keyed `namespace/recipe`; see below |
| `variables` | per version | The version's variable definitions, exactly as its manifest publishes them (see [Variable definitions](#variable-definitions)), with `required`, `secret` and `scope` filled in; `[]` when it asks nothing |
| `depends`, `subscribes` | per version | The version's manifest lists, exactly as written; `[]` when empty |

Dependencies are resolved at release time and keyed `namespace/recipe`. An entry carries `version` (a
sibling, resolved exactly) or `range` plus `repo` (the identity of the repository publishing it, whose own
index resolves the range); at least one is required. Installing a version installs these rather than
re-resolving the manifest's ranges.

**Each version describes itself.** So that a recipe can be described before anything is fetched, every
version a release records carries more than its dependencies. Each dependency records `declared`, the
manifest entry that brings it in exactly as written (a recipe such as `workflow/qa-helper@^1.0`, a whole
namespace such as `workflow`, or a locator), and `kind`: `subscribes` for a co-subscription, whose files
land and whose questions are asked, or `depends` for a build dependency. When several entries cover one
recipe, an entry naming it wins over a namespace, and it is a co-subscription when any entry covering it is
one. The version records `variables`, its manifest's definitions, and `depends` and `subscribes`, its
manifest's lists as written; the lists are what a consumer walks, because a namespace of another repository
has no recipe key to record it under. All of them are written even when empty (`"dependencies": {}`,
`"variables": []`), so "none" reads differently from "not recorded". From these, `sous recipe show` and
`sous subscription add --dry-run` list everything a subscription installs and every question it asks, and
the resolver walks a recipe whose files are not on the machine from its index entry just as it would walk
its manifest. A version recorded before a release wrote these fields keeps its entry as it is; its questions
are known only once its files are fetched, and the dry run names it as such.

**A published version's entry is frozen.** Its dependencies are resolved once, when the version is first
recorded, and every later release carries the entry forward exactly as published, like its hash; releasing
other recipes, adding a recipe to a namespace it subscribes to, or raising a sibling it names changes nothing
in it. A release still checks the recorded list against the version's manifest: a recipe the manifest names
that the list lacks, a recipe in the list the manifest does not declare, a sibling outside its declared
range, or another repository's entry with a different repository or range is an error naming the recipe, the
version and each difference; restore the entry if the index was edited, or bump the version to publish
different dependencies. A version rebuilt from its tag, when the index lost it, has its dependencies resolved
against the repository as it stood at that tag, then frozen the same way. An entry written before sous
recorded dependencies carries none, stays that way, and installs by resolving its manifest's ranges.

**Fields this sous does not know are kept, not refused.** A later sous may add fields to the index, at any
level, recorded variable definitions included. This one reads such an index, validates every field it
defines as strictly as before, and ignores the rest; a release it runs carries a published version's entry
forward with those fields intact.

!> A sous older than 0.2.26, the first to tolerate unknown fields, refuses the whole index of any
repository released with `declared`, `kind`, `variables`, `depends` or `subscribes` in it, the official
one included. A project pinned to such a sous fails to read that index until it moves to 0.2.26 or later.

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
pointed at an existing checkout. Unlinking removes the entry and leaves the checkout in place, unless
`sous repo unlink --remove` is asked to delete one sous cloned; it never deletes a `path` checkout. Both the
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
