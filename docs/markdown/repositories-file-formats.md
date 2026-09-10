# Repository File Formats

Repositories publish versioned **recipes**, grouped into **namespaces**, and projects subscribe
to them. Six files carry the whole system on disk. Three of them you write by hand; three sous
writes for you.

| File | Where | Written by | Purpose |
|------|-------|-----------|---------|
| `sous.repo.yaml` | repository root | you | Declares the repository: its namespaces and where its recipes live |
| `sous.recipe.yaml` | each recipe folder | you | Declares one recipe: version, dependencies, contents, variables |
| `sous.index.json` | repository root | `sous repo release` | Every namespace, recipe and published version, with content hashes |
| `sous.lock.json` | a project's `.sous/` | sous | What the project actually resolved to |
| `.sous.entry.json` | each store entry | sous | Makes a cached recipe version self-describing |
| `sous.links.json` | `.sous/` or `$SOUS_HOME` | `sous repo link` | Redirects a repository at a local working copy |

Every one of them carries `formatVersion: 1`. A future incompatible change bumps that number, so
an older sous refuses a file it would otherwise misread.

?> Hand-written manifests are YAML or JSON, never JavaScript. Repository trust rests on being
able to read a repository's whole surface without running any of its code, and a manifest that
could execute would break that guarantee.

## Refs: how anything is named

A **ref** names a namespace or a recipe. The same grammar works on the command line, in a
project's subscriptions and in a recipe's dependency lists.

```
ref := [ repo ":" ] namespace [ "/" recipe [ "@" range ] ]
```

| Ref | Means |
|-----|-------|
| `workflow` | The whole `workflow` namespace, including recipes published later |
| `workflow/task-files` | One recipe, any published version |
| `workflow/task-files@^1.2.0` | One recipe, constrained to a semantic version range |
| `sous-recipes:workflow/task-files@^1.2.0` | The same recipe, in a named repository |

The rules behind the grammar:

- **No prefix.** A ref is written bare. `@` introduces a version range and nothing else; `~` is
  the template include sigil and never appears in a ref.
- **The repo qualifier is optional.** Refs resolve across the cached indexes of every added
  repository. You only need `repo:` when the same ref genuinely resolves in more than one, and in
  that case sous reports the conflict and asks for the qualified form rather than picking a
  winner.
- **A version range applies to a recipe.** Namespaces are not versioned, so `workflow@^1.0.0` is
  an error.
- **Ranges follow npm's rules.** `^1.2.0`, `~2.1`, `>=1.0.0 <2.0.0`, `1.x` and `*` all behave
  exactly as they do in npm, because sous resolves them with npm's own `semver` package.
  Prerelease versions sit out of range matching unless a subscription opts in.

Namespace names, recipe names and repository short names are lowercase kebab-case: a letter,
then letters, digits or hyphens.

## `sous.repo.yaml`: the repository manifest

The entry point sous reads to learn what a repository publishes. It lives at the repository root
and may be written as `sous.repo.yaml`, `sous.repo.yml` or `sous.repo.json`. Exactly one of
those, never two.

```yaml
formatVersion: 1

# A suggested short name. A project records the name it actually uses when the
# repository is added, so two repositories suggesting the same name never collide.
name: sous-recipes

description: The official sous recipe repository.

# Surfaced when a provider cannot support `sous repo submit`, so a contributor is
# never left without a route. A URL or plain prose.
contribute: https://github.com/sous-io/sous-recipes/blob/main/CONTRIBUTING.md

namespaces:
  core:
    description: Skills that teach agents about sous itself.
  workflow:
    description: Task tracking and branch workflow.

# Each path holds a sous.recipe.yaml. Paths are relative to the repository root.
recipes:
  - recipes/core/sous-skills
  - recipes/workflow/task-files
```

| Field | Required | Type | Notes |
|-------|----------|------|-------|
| `formatVersion` | yes | `1` | The on-disk format version |
| `name` | yes | kebab-case string | Suggested short name for the repository |
| `description` | no | string | Shown by `sous repo list` and `sous repo search` |
| `contribute` | no | string | URL or prose describing how to contribute |
| `namespaces` | yes | map of name to `{ description? }` | Every namespace the repository publishes |
| `recipes` | yes | list of relative paths | Every recipe folder, each holding a recipe manifest |

Recipe paths stay inside the repository: an absolute path, a backslash, a `..` segment or a
trailing slash is rejected.

## `sous.recipe.yaml`: the recipe manifest

One recipe, complete. It lives in the recipe's own folder, as `sous.recipe.yaml`,
`sous.recipe.yml` or `sous.recipe.json`.

```yaml
formatVersion: 1
namespace: workflow
name: task-files
version: 1.2.0
description: Per-branch task files, with skills for starting and resuming work.

# Build dependencies. Fetched, pinned and trust-gated, and addressable from this
# recipe's own files, but their files do NOT enter a subscriber's output.
depends:
  - core/sous-skills@^1.0.0

# Co-subscriptions. Subscribing to this recipe subscribes the project to these too,
# with full semantics: their questions run and their files DO enter the output.
# A curated bundle is simply a recipe made mostly of these.
subscribes:
  - communication/control-flow@^2.0.0

# The files this recipe contributes. Patterns are relative to the recipe folder.
contents:
  - kind: skills
    include:
      - skills/**/*.md
    exclude:
      - skills/**/draft-*.md
  - kind: memories
    include:
      - memories/*.md
  - kind: config
    include:
      - config/510-task-files.json

# Published specifications, not values. A question is asked only when a subscribed
# recipe needs the variable and no valid answer is already in scope.
variables:
  - name: taskFileRoot
    env: SOUS_VAR_TASK_FILE_ROOT
    type: path
    prompt: Where should task files live?
    description: One file per git branch is written here.
    default: .sous/tasks
    required: true
    scope: shared

  - name: ticketSystem
    type: enum
    prompt: Which ticket system do you use?
    default: github
    validate:
      enum: [github, jira, linear]
```

### Top-level fields

| Field | Required | Type | Notes |
|-------|----------|------|-------|
| `formatVersion` | yes | `1` | The on-disk format version |
| `namespace` | yes | kebab-case string | Must be declared by the repository manifest |
| `name` | yes | kebab-case string | Unique within its namespace |
| `version` | yes | exact semantic version | Never a range; `1.2.0`, or `2.0.0-beta.1` for a prerelease |
| `description` | no | string | Shown by `sous repo search` and `sous repo list` |
| `depends` | no | list of refs | Build dependencies |
| `subscribes` | no | list of refs | Co-subscriptions |
| `contents` | no | list of content groups | Defaults to an empty list, which is what a curated bundle wants |
| `variables` | no | list of variable definitions | Published specifications |

Recipe metadata is the source of truth for versions. A git tag shaped
`namespace/recipe@1.2.3` is a convenience ref that `sous repo release` keeps consistent with the
`version` field; a missing or wrong tag is reported rather than silently hiding a version.

### Content groups

| Field | Required | Type | Notes |
|-------|----------|------|-------|
| `kind` | yes | `skills`, `memories`, `prompts` or `config` | Decides where the files land in a subscribing project |
| `include` | yes | list of glob patterns | At least one; relative to the recipe folder |
| `exclude` | no | list of glob patterns | Removed from the include set |

`config` entries name config layer files that are merged into the subscriber's config. Like
recipe paths, include and exclude patterns may not escape the recipe folder.

### Variable definitions

| Field | Required | Type | Notes |
|-------|----------|------|-------|
| `name` | yes | camelCase string | How templates refer to the variable |
| `env` | no | upper snake case string | The environment variable an answer binds to. `sous repo release` derives a default when it is omitted; the runtime never derives one |
| `type` | yes | `string`, `number`, `boolean`, `enum`, `path` or `url` | How the answer is validated and prompted for |
| `prompt` | yes | string | The question text |
| `description` | no | string | Shown alongside the question and by `sous vars` |
| `default` | no | string, number or boolean | Must match the declared type, and for an enum must be one of the options |
| `required` | no | boolean, default `true` | Whether a build needs an answer |
| `secret` | no | boolean, default `false` | A secret is always stored in the gitignored `.sous/.env.local` |
| `scope` | no | `shared` or `local`, default `shared` | Which env file the answer is written to |
| `validate` | no | object | Constraints, below |

`scope: shared` writes to `.sous/.env`, which is committed and shared with the team.
`scope: local` writes to `.sous/.env.local`, which is gitignored and machine-specific. A secret
declared as shared is rejected, because that combination would commit the secret.

Constraints under `validate`:

| Field | Type | Applies to |
|-------|------|-----------|
| `pattern` | string holding a regular expression | String-like answers |
| `minLength`, `maxLength` | whole numbers | String-like answers |
| `min`, `max` | numbers | Numeric answers |
| `enum` | list of strings | Required when `type` is `enum` |

!> A schema may only LOOSEN within a major version. Tightening a constraint is a major bump,
and an upgrade re-validates stored answers, re-prompting only where an old answer no longer
fits.

### Unknown keys

Both hand-written manifests reject an unknown key and report it as a likely typo, naming the
file and the field's path. The one exception is the reserved `x-` namespace: a key such as
`x-team` is accepted and ignored, so a repository can carry metadata sous knows nothing about.

### JSON manifests

A `.json` manifest is read with a permissive parser: line comments, block comments and trailing
commas are all allowed, so a manifest can explain itself.

```json
{
  // the only format version sous understands
  "formatVersion": 1,
  "namespace": "workflow",
  "name": "task-files",
  "version": "1.2.0",
  "contents": [
    { "kind": "skills", "include": ["skills/**/*.md"] },
  ]
}
```

## `sous.index.json`: the repository index

Machine-written by `sous repo release` and committed alongside the recipes it describes. The
index is the portable contract across providers: whatever a provider's API looks like, it can
hand back this one file, and it is all sous needs to resolve a ref, enumerate published versions
and check whether a cached copy is current.

Adding a repository fetches only this file. Nothing else is downloaded until a project
subscribes to something inside it.

```json
{
  "formatVersion": 1,
  "name": "sous-recipes",
  "generatedAt": "2026-09-09T14:03:11.482Z",
  "generator": "0.2.0",
  "namespaces": {
    "core": { "description": "Skills that teach agents about sous itself." },
    "workflow": { "description": "Task tracking and branch workflow." }
  },
  "recipes": {
    "workflow/task-files": {
      "path": "recipes/workflow/task-files",
      "description": "Per-branch task files.",
      "versions": {
        "1.0.0": {
          "hash": "sha256-3b1f...c9",
          "tag": "workflow/task-files@1.0.0",
          "prerelease": false,
          "releasedAt": "2026-08-01T09:00:00.000Z"
        },
        "1.1.0-beta.1": {
          "hash": "sha256-77ad...20",
          "tag": "workflow/task-files@1.1.0-beta.1",
          "prerelease": true
        }
      }
    }
  }
}
```

| Field | Required | Type | Notes |
|-------|----------|------|-------|
| `formatVersion` | yes | `1` | The on-disk format version |
| `name` | yes | kebab-case string | The repository's suggested short name |
| `generatedAt` | yes | ISO 8601 timestamp | When the index was generated |
| `generator` | yes | exact semantic version | The version of sous that generated it |
| `namespaces` | yes | map of name to `{ description? }` | Copied from the repository manifest |
| `recipes` | yes | map of `namespace/recipe` to a recipe entry | Every recipe published |
| `$comment` | no | string | A note about where this copy came from. JSON has no comment syntax, and an index is machine-written, so this is the one place a writer can say something to whoever opens the file. Sous ignores it, with one exception: the seed index below |

A recipe entry holds `path`, an optional `description`, and `versions`: a map from an exact
version to `{ hash, tag, prerelease, releasedAt? }`. Every recipe needs at least one version,
and its namespace must be one the index declares.

Content hashes are written as `sha256-` followed by 64 lowercase hexadecimal characters. The
hash of a version is checked after every fetch, and against the lockfile before a cached copy is
used.

### The seed index

One index is not published by any repository: sous writes a stand-in index for its own
`sous-recipes` entry, into the index cache, when nothing real has ever been fetched from it. It
lists exactly one recipe, `core/sous-skills`, at the version of the running sous, with the hash
of the copy that was just seeded out of the installed package. That is what lets a project
resolve the core namespace on a machine that has never had a network connection.

The stand-in says so in its `$comment`, which is how a later run recognizes its own placeholder
and is willing to replace it; an index a repository actually published is never overwritten. No
freshness sidecar is written beside it, so the very first command that does have a network
fetches the real index rather than waiting out a window the stand-in never earned. When there is
still no network, sous reports that it could not check and uses the stand-in, which is the same
last-good behavior every repository gets.

## `sous.lock.json`: the project lockfile

Machine-written into the project's `.sous/` directory, and committed. The lockfile records the
exact version and content hash of everything the project currently uses, so a fresh clone
restores deterministically with no prompts and no version drift. Together with repository trust
it is the supply-chain defense: nothing new enters a project except through an explicit, visible
change to these files.

```json
{
  "formatVersion": 1,
  "repos": {
    "sous-recipes": {
      "url": "https://github.com/sous-io/sous-recipes",
      "indexHash": "sha256-91cc...4e"
    }
  },
  "recipes": {
    "core/sous-skills": {
      "repo": "sous-recipes",
      "version": "0.2.0",
      "hash": "sha256-4d20...af",
      "requestedBy": ["workflow/task-files"],
      "kind": "depends"
    },
    "workflow/task-files": {
      "repo": "sous-recipes",
      "version": "1.2.0",
      "hash": "sha256-3b1f...c9",
      "requestedBy": ["project"],
      "kind": "subscribes"
    }
  }
}
```

| Field | Required | Type | Notes |
|-------|----------|------|-------|
| `formatVersion` | yes | `1` | The on-disk format version |
| `repos` | yes | map of short name to `{ url, indexHash? }` | Every repository the locked recipes came from |
| `recipes` | yes | map of `namespace/recipe` to a locked entry | Everything currently in use |

A locked entry holds `repo` (which must appear under `repos`), the exact `version` resolved, its
`hash`, a `requestedBy` list and a `kind` of `subscribes` or `depends`.

`requestedBy` is what makes removal safe. Every entry lists who holds it: the literal string
`project` for something the project subscribed to directly, or a recipe key for something pulled
in as a dependency. Unsubscribing removes one holder, and the entry itself goes only when the
last holder does.

Every key is written sorted, so a regenerated lockfile changes only when its content genuinely
does.

## `.sous.entry.json`: the store entry marker

The machine-wide store lives under the user-level sous directory, one folder per recipe version:
`$SOUS_HOME/cache/<repo>/<namespace>/<recipe>/<version>/`. A marker beside each one makes the
entry self-describing, so the store can be verified and swept without consulting any project.

```json
{
  "formatVersion": 1,
  "repo": "sous-recipes",
  "namespace": "workflow",
  "name": "task-files",
  "version": "1.2.0",
  "hash": "sha256-3b1f...c9",
  "fetchedAt": "2026-09-01T10:00:00.000Z",
  "lastAccessAt": "2026-09-09T14:03:11.482Z",
  "sizeBytes": 20480
}
```

Every field is required. `hash` is checked against the lockfile before the entry is used;
`sizeBytes` and `lastAccessAt` drive the size-capped, least-recently-used collection that
`sous repo gc` performs.

The store is disposable by design: everything in it is re-fetchable from the pins in a project's
lockfile. Builds read inputs from the store and render or copy outputs into the project; sous
does not symlink store content into a project, and store content is never edited in place.

## The store on disk

The store is a plain directory tree under the user-level sous directory, which is `~/.sous`
unless `SOUS_HOME` says otherwise. Unlike `SOUS_CONFIG` and `SOUS_DIR`, `SOUS_HOME` does not
decide which project is active, so it may be set in an env file (`.sous/.env.local` or
`.sous/.env`) as well as in the shell. The same directory holds globally linked checkouts
(`repos/`) and the machine-wide links map.

```text
$SOUS_HOME/
  cache/                                   the store root
    <repo>/<namespace>/<recipe>/<version>/
      .sous.entry.json                     the marker for this entry
      ...                                  the recipe's files, exactly as fetched
  repos/<owner>/<repo>/                    checkouts linked with --global
  sous.links.json                          the machine-wide links map
```

An entry is written atomically: sous copies the fetched files into a temporary directory
beside the entry's final home, hashes them, checks the hash against the pin it was given,
writes the marker, and only then renames the directory into place. A published version is
immutable, so re-storing one is allowed only when the content hashes the same; different
content under a version already in the store is an error rather than a silent overwrite.

The content hash is SHA-256 over a canonical serialization of the folder: files in bytewise
order of their relative paths, each contributing its path, its byte length and its bytes.
File modes, owners and timestamps are excluded, so the same recipe hashes the same after a
copy, a clone or an archive round-trip. `.git` and the entry's own `.sous.entry.json` are
skipped, which is what lets sous touch the marker without invalidating the entry. Every read
re-verifies the hash; an entry that no longer matches is removed and re-fetched, and the
build says so.

Symbolic links are skipped entirely, by the hash and by the copy into the store alike, and so
is anything under a linked directory. A link points at bytes the repository does not own, so
following one would make the same published version hash differently on the publisher's
machine and the consumer's, and every install would then fail against its own pin.
`sous repo release` refuses to publish a recipe folder containing a link, naming it, so this
is caught where it can be fixed rather than at install time. A recipe that needs a file ships
the file.

Collection is size-capped and least-recently-used. `store.maxBytes` sets the cap (one
gigabyte by default) and `lastAccessAt` in each marker sets the order; entries a lockfile
still pins are never evicted, even when honoring the cap would require it. Everything in
the store is re-fetchable from those pins, so deleting the whole directory costs a download
and nothing else.

## `sous.links.json`: the links map

A link redirects a repository's resolution away from the store and at a real working copy, which
is how a maintainer edits recipes: edits happen in a checkout, never in the store.

```json
{
  "formatVersion": 1,
  "links": {
    "sous-recipes": {
      "path": "/home/me/Projects/sous-recipes",
      "linkedAt": "2026-09-09T14:03:11.482Z",
      "origin": "clone"
    }
  }
}
```

| Field | Required | Type | Notes |
|-------|----------|------|-------|
| `formatVersion` | yes | `1` | The on-disk format version |
| `links` | yes | map of repository short name to a link entry | Everything currently linked |

A link entry holds an absolute `path`, a `linkedAt` timestamp, and an `origin` of `clone` (sous
cloned the working copy itself) or `path` (sous was pointed at an existing checkout). Unlinking
removes the entry and leaves the checkout on disk.

Two maps are read: the project's `.sous/sous.links.json` and the machine-wide
`$SOUS_HOME/sous.links.json`, with the project map winning on conflict. The file is never
committed. A link bypasses versions, the lockfile and freshness checks, and those bypasses
belong to one person's machine rather than to the team, so builds announce a linked repository
loudly.

### Where a linked checkout lives

`sous repo link <repo>` with no path clones the repository for you. The working copy lands in
`.sous/repos/<owner>/<name>`, or in `$SOUS_HOME/repos/<owner>/<name>` with `--global`, where
every project on the machine shares one checkout. A directory that is already a checkout of the
same remote is reused rather than cloned again, so running the command twice is harmless; one
holding a different remote is an error, because reading the wrong recipes silently would be
worse than stopping.

`sous repo link <repo> <path>` links a checkout that already exists and clones nothing. The path
must hold a repo manifest at its root, since a directory without one is not a repository.

`<repo>` is normally the short name of a repository this project has already added. A URL is
accepted, but it is not a way around adding one: a linked repository's recipes are read with no
version, no lockfile and no hash check, so a URL the project has not added runs the same trust
ceremony `sous repo add` runs before anything is cloned or linked. It asks inline, `--trust`
acknowledges instead for a run with no terminal, and a URL whose short name already belongs to a
different repository is refused outright.

`sous repo unlink <repo>` removes the map entry and nothing else. The checkout stays where it
is, and its path is printed so you can delete it yourself if you want to.

### Ignore hygiene

Everything sous keeps under `.sous/` for one machine is kept out of the project's repository,
and linking maintains both files that do it:

- `.sous/repos/.gitignore` holds a single `*`. That covers the ignore file itself, so a cloned
  checkout underneath it contributes nothing at all to the project's repository.
- `.sous/.gitignore` carries a delimited managed block:

```
# >>> sous managed (do not edit between these markers)
sous.links.json
sous.state.json
sous.pid
repos/
# <<< sous managed
```

Only the lines between the markers are ever rewritten. Anything you put above or below them is
left exactly as it was, and both files are written only when their contents would change, so
linking repeatedly never produces a diff. An opening marker with no closing partner stops the
command with an error rather than a guess about where the block ends.

`sous prune` and `sous clear` only ever touch paths recorded in the state file, so nothing in
`.sous/repos/` is at risk from either of them.

## Project configuration

Four optional top-level keys in a project's sous config carry the consumer side. `sous repo add`
and `sous subscribe` write the first two into machine-managed `conf.d/` layers, and you may also
hand-write them in the primary config; the layers merge like anything else. The fourth,
`recipeOutputs`, is always yours to write and is covered under
[Consuming recipes](#consuming-recipes).

```yaml
# Trusted repositories, keyed by the short name refs use. Adding a repository IS
# trusting it, and removing the entry withdraws that trust.
repos:
  team-recipes:
    url: https://github.com/example-org/team-recipes
    provider: github        # inferred from the URL when omitted
    enabled: true           # defaults to true; false takes it out of play entirely
    alwaysPull: false
    addedAt: 2026-09-09T14:03:11.482Z
    addedBy: user           # "user", "sous", or the ref of the recipe that required it

# What the project subscribes to, keyed by ref key.
subscriptions:
  workflow/task-files:
    range: ^1.2.0
    enabled: true           # defaults to true
    prerelease: false
    alwaysPull: false

# Knobs for the machine-wide store. Every number here is configurable; the values
# sous ships are defaults, not assumptions.
store:
  maxBytes: 1073741824      # one gigabyte
  freshnessSeconds: 300     # five minutes
  watchPollSeconds: 300     # five minutes
```

A subscription key is a ref key: a namespace, or a namespace and a recipe. It never carries a
repository qualifier or a version range, because the range belongs in the entry.

### The entries sous provides itself

Two entries are there without you writing them. Sous lays them UNDER whatever your config
layers produced, so `sous config show` prints them and `sous repo list` marks the repository
"built in":

- the repository `sous-recipes`, pointing at `https://github.com/sous-io/sous-recipes`, and
- a `core` subscription, whose range is exactly the version of sous you are running.

The `core` namespace holds the skills that teach an agent what sous is and how it works, and a
copy of it ships inside the sous package, so a brand new project builds with those skills even
with no network. Trust is not a question here: sous itself ships the recipe and pins the
version to its own.

The range being the exact running version is deliberate. Core is published in lockstep with the
CLI, so upgrading sous upgrades core with it, and a build re-pins core the first time it notices
that the locked version no longer satisfies the range.

### Switching either one off

`enabled` is an ordinary field on any `repos` or `subscriptions` entry. It defaults to true, and
setting it to false takes that entry out of play entirely: nothing resolves through it, nothing
is fetched for it, and nothing it publishes is compiled. The entry stays in your config, so the
opt-out is legible to whoever reads it next.

The two entries above are what it is mostly for:

```yaml
# Keep the repository, but do not install the core skills.
subscriptions:
  core:
    enabled: false

# Or drop the repository entirely, which withdraws the core subscription with it.
repos:
  sous-recipes:
    enabled: false
```

Those two lines are complete entries on their own. Sous merges your fields over its own field by
field, so `{ enabled: false }` inherits the URL and provider underneath it; writing a `url`
repoints the repository and changes nothing else.

`alwaysPull` installs a newer in-range version whenever one exists rather than holding the
locked one. It never widens the range a subscription or a dependency declared, and the lockfile
is still regenerated continuously so it records what the last build actually used. A freshness
check that fails never breaks a build; the last good answer stands.

## Managed config layers

Sous writes two of those keys itself, into the `conf.d/` band reserved for machine-written
layers:

| File | Holds | Written by |
|------|-------|------------|
| `conf.d/500-repos.json` | the `repos:` map | `sous repo add`, `sous repo remove` |
| `conf.d/510-subscriptions.json` | the `subscriptions:` map | `sous subscribe`, `sous unsubscribe` |

Both are ordinary config layers: they load in filename order after your primary config and merge
into it, so a repository you hand-write in your own config and one sous added are the same thing
by the time anything reads them. Sous never edits your primary config, and never edits a layer
outside the `500` through `599` band.

Each file is replaced **in full** every time it changes. Config layers deep-merge, and the merge
concatenates arrays rather than matching their entries up, so a managed layer only ever holds
maps keyed by name, and rewriting the whole file is the only way a removal actually removes
something. Keys are sorted and the JSON is pretty-printed, so a change to one repository shows up
as a change to one repository in your version control history.

JSON has no comment syntax, so each file says what it is in a `$comment` key instead:

```json
{
  "$comment": "This file is written by sous. It is replaced in full whenever it changes, so hand-written edits are lost. Repositories and subscriptions can be changed with the 'sous repo' and 'sous subscribe' commands, or written by hand in your primary config, which sous never edits.",
  "repos": {
    "sous-recipes": {
      "url": "https://github.com/sous-io/sous-recipes",
      "addedAt": "2026-09-09T14:03:11.482Z",
      "addedBy": "user"
    }
  }
}
```

Sous accepts and ignores `$comment` at the top level of any config file, exactly as it does
`$schema`.

## Consuming recipes

Subscribing pins a recipe; building is what turns it into files in your project. A recipe's
`contents` block says what it contributes and of what kind, and each kind lands somewhere your
config decides.

### `recipeOutputs`: where the files land

```yaml
# Where the files subscribed recipes contribute are written, per content kind.
# Every path is ${var} substituted like any other config path, and a kind may
# name several destinations so one recipe feeds more than one agent directory.
recipeOutputs:
  skills:
    - ${projectRoot}/.claude/skills
    - ${projectRoot}/.codex/skills
  memories:
    - ${projectRoot}/.claude/memories
  prompts:
    - ${projectRoot}/prompts/recipes
```

Only `skills` has a default: `<project root>/.claude/skills`, the project root being the parent
of your `.sous/` directory. That is where every agent looks, so it is worth defaulting. Nothing
else is: a kind with no destination is skipped, and sous says so once, naming this key. It will
not guess where you want your memories or your prompts.

Files are written the same way an `entryGlob` target of your own writes them. The static part of
each include pattern is the base the output tree mirrors, so a recipe publishing
`skills/task-files/SKILL.md` under `include: ["skills/**/*.md"]` writes
`<destination>/task-files/SKILL.md`. The [`.tpl.` convention](configuration.md) applies
unchanged: a `.tpl.md` file is rendered and loses the `.tpl.` from its name, and everything else
is copied verbatim.

?> Only recipes you are subscribed to contribute files. A recipe pulled in through `depends` is
fetched, pinned and addressable from the recipe that declared it, and its files never enter your
output. That is the whole difference between the two dependency kinds.

Recipe outputs are tracked like every other file sous writes, so `sous prune` removes what an
unsubscribed recipe used to write, and `sous clear` removes all of it. Neither ever reaches into
a linked checkout or the machine-wide store; both hold work that is not a project's to delete.

### `config` contents: recipes that configure

A recipe's `config` contents are not written anywhere. They are config layers, and they load
after your primary config and before your own `conf.d/` layers, so a recipe can supply defaults
and your project always wins over them.

A recipe's config layer is JSON or YAML only (`.json`, `.yaml` or `.yml`). Sous must be able to
read everything a repository publishes without running any of it, so an executable layer from a
recipe is refused with a warning rather than loaded, exactly as manifests are.

A recipe's config layer may set only these top-level keys:

| Key | What a recipe uses it for |
|-----|---------------------------|
| `_vars` | Default values for the variables its templates read |
| `_aliases` | Include aliases pointing at the files it ships |
| `compilation` | Targets that compile what it ships |
| `runtimeContext` | Runtime context for the templates it ships |
| `recipeOutputs` | Where the files it contributes are written |
| `store` | Knobs for the machine-wide store |
| `varMappings` | Bindings from an environment variable name to one of its variables |

Every other key is removed before the layer is merged, and sous prints a warning naming the
recipe and the key it removed. In particular a recipe may not set `repos`, `subscriptions`,
`tools`, `_env`, `version`, `name` or `$schema`, and it may not set a key sous does not
recognise. Subscribing to a recipe is not a decision to let it choose which repositories this
project trusts, what else it subscribes to, or which programs `sous launch` runs; those stay
yours. Sous reads the layer itself and applies this filter before the config kernel merges
anything, so the kernel never opens a recipe's layer file at all.

### The `file` provider: repositories on this machine

A repository does not have to be hosted. Name one by an absolute path, or by the same path in
`file:///...` form, and sous reads it through the built-in `file` provider:

```bash
sous repo add /home/me/Projects/my-recipes --name my-recipes
```

It is meant for local development and for tests: authoring a repository, trying a recipe before
publishing it, or running a whole workflow with no network at all. The index is read from the
working tree when the file is there, so an index you are still writing is picked up without a
commit, and from the committed copy otherwise. A recipe's files come from the version's tag in
the local git repository; a directory that is not a git repository has no versions to honour, so
its working tree is copied instead.

!> Trust semantics are identical to a hosted repository. A local path is added, and therefore
trusted, through the same ceremony, because the recipes in it still run on this machine. "It is
already on my disk" is not a reason to skip the question.

For editing a repository you are already subscribed to, reach for `sous repo link` instead: it
redirects one repository's resolution at a working copy without changing what your project
subscribes to.

## Variables and answers

A variable **definition** is a published specification; an **answer** is the stored value. A
question is asked only when a subscribed recipe needs a variable and nothing in scope answers
it, or when the answer in scope no longer fits the definition.

### Where answers live

Answers are stored in the project's own env files, and sous edits them the way a careful person
would: exactly one value line is rewritten or appended, and comments, blank lines, ordering and
quoting all survive. A newly added entry gets a short generated header comment above it saying
where the value came from. Comments are output only; sous never reads one back.

| File | Committed | Holds |
|------|-----------|-------|
| `.sous/.env` | yes | Shared answers (`scope: shared`), the team's defaults |
| `.sous/.env.local` | no, gitignored | Machine-specific answers (`scope: local`) and every secret |

### The resolution ladder

For each variable sous generates a list of environment variable names and tries them in order,
most specific first. Within a rung, the real shell environment wins, then `.sous/.env.local`,
then `.sous/.env`.

| Rung | Name | Example |
|------|------|---------|
| 1. mapping record | whatever the record names | `TEAM_API_URL` |
| 2. recipe scope | `SOUS_VAR_<NAMESPACE>_<RECIPE>_<VARIABLE>` | `SOUS_VAR_MISC_STUFF_API_URL` |
| 3. namespace scope | `SOUS_VAR_<NAMESPACE>_<VARIABLE>` | `SOUS_VAR_MISC_API_URL` |
| 4. shared scope | `SOUS_VAR_<VARIABLE>` | `SOUS_VAR_API_URL` |
| 5. declared name | the definition's own `env` field | `GITHUB_TOKEN` |

!> Candidate names are only ever GENERATED and looked up, never parsed back into scopes. The
underscore is both the delimiter and a legal identifier character, so no parse of a name would
be trustworthy. When names collide, a mapping record settles it.

### Mapping records

A mapping record binds one environment variable, of any name, to one fully qualified variable.
It is the top rung of the ladder and the universal conflict resolver: two recipes wanting the
same name, or a name already meaning something else in your environment.

```json
{
  "$comment": "Written by sous. Each entry binds an environment variable to one recipe variable.",
  "varMappings": {
    "TEAM_API_URL": "sous-recipes:misc/stuff/apiUrl"
  }
}
```

A target is written `namespace/recipe/variableName`, optionally qualified as
`repo:namespace/recipe/variableName`. Records live under the top-level `varMappings` config key;
sous writes the ones it creates into the machine-managed `conf.d/520-var-mappings.json` layer,
replacing that file wholesale so each name has exactly one record, and you may hand-write
`varMappings` in the primary config too.

### The commands

| Command | What it does |
|---------|--------------|
| `sous vars` | Lists every variable in play: its recipe, the environment variable that answered it, the value (hidden for a secret) and the source |
| `sous vars <name>` | Shows one variable in full, including every environment variable on the ladder and which rung answered |
| `sous vars ask [name]` | Answers what is unanswered, or one named variable; `--all` asks everything again |
| `sous vars ask --file <path>` | Asks the definitions in a standalone file holding the same `variables:` array a recipe manifest carries |

`sous vars` and `sous vars ask` both accept `--file`, and `sous vars ask` accepts `--dry-run`.

Answers already in scope are listed visibly and never re-asked. Without a terminal, an
unanswered required variable fails the run and names the exact environment variables that would
satisfy it, most specific first, which is what a continuous integration log needs.

## Releasing and contributing

Two commands work inside a recipe repository rather than inside a project, so neither one looks
for a `.sous/` directory: `sous repo release` publishes, and `sous repo submit` proposes a change
to a repository someone else maintains. Both refuse to do anything until the repository describes
itself consistently.

### What is checked

Every run of either command checks the same things, and reports all of them at once rather than
stopping at the first:

- Every folder listed under `recipes` in `sous.repo.yaml` exists and holds exactly one recipe
  manifest.
- Every recipe belongs to a namespace the repository manifest declares, and no two recipes share
  a `namespace/name` key.
- Every `depends` and `subscribes` ref parses.
- No two variable definitions of DIFFERENT names claim the same environment variable. Two
  definitions of the SAME name may share one, because that is exactly what the shared rung of the
  resolution ladder is for.
- A tag exists for the version its recipe manifest declares, or that version is pending; when the
  tag does exist, the manifest carried by that tag declares the same version, and the folder's
  content still matches what the tag published.

Claiming a well-known name such as `PATH`, `HOME`, `GITHUB_TOKEN` or anything beginning `AWS_` or
`SOUS_` is a warning rather than an error. Binding an existing token is legitimate; it just
deserves saying out loud. Add `x-intentional: true` to the definition to say you meant it.

### Versions, tags and the index

Recipe metadata is the source of truth for versions. A tag shaped `namespace/recipe@1.2.3` is a
convenience ref that records which commit a version was published from, and `sous.index.json` is
the catalog subscribers read. The three are kept in step by three rules:

- **A published version never changes.** Its hash is carried forward exactly as published, and a
  disagreement is an error telling you to bump the version rather than republish it.
- **A version is published when its tag exists.** A version whose tag has not been cut yet is left
  out of the index and reported as pending instead, because every index entry names its tag.
- **The tags are the backstop.** A tagged version missing from the index is rebuilt from its tag,
  so deleting `sous.index.json` and regenerating it restores the same catalog.

!> Sous writes files and creates tags; it never commits for you. Every command here stops and
tells you what to commit instead, so nothing enters a repository's history without you asking.

### `sous repo release`

| Invocation | What it does |
|------------|--------------|
| `sous repo release` | Validates, regenerates `sous.index.json`, and prints what a release would publish. Nothing is committed or tagged. |
| `sous repo release --check` | Reads only. Exits non-zero when anything is wrong or the committed index is out of date, naming what is stale. This is what a pull request runs. |
| `sous repo release --bump <level>` | Raises a recipe's version in place (`patch`, `minor`, `major` or `prerelease`), then regenerates the index. Name the recipe with `--recipe namespace/name` when the repository publishes more than one. |
| `sous repo release --tag` | Creates the annotated tag for every version that has none, after confirming the working tree is clean and the committed index is current. Then it rewrites the index to record the new versions, for you to commit. |
| `sous repo release --tag --push` | The same, and pushes exactly those tags to `origin`. Nothing else is pushed. |

`--dry-run` works with all of them and changes nothing.

A version bump edits the manifest in place, so its comments, its field order and its layout
survive. Two small normalizations happen in a YAML manifest: a folded block of prose may be
re-wrapped, and the spacing before a trailing comment is collapsed to one space.

The workflow `sous repo init` scaffolds runs `--check` on every pull request and
`--tag --push` on a merge, with a step of its own that commits the regenerated index.

### `sous repo submit`

`submit` means "propose a change for maintainers to review". It never publishes and never writes
to a repository directly.

Sous validates first, because a proposal that fails the maintainer's own checks wastes their
review, and then hands the mechanics to the provider's own command line tool, which already holds
your credentials:

1. **Preflight.** An `origin` remote exists, sous recognizes its provider, that provider's CLI
   (`gh` or `glab`) is installed and signed in, and everything is committed.
2. **Validation.** The repository validates, and the committed index is current.
3. **Delegation.** On GitHub, sous asks whether you can push to the repository itself; if you
   cannot, it forks it onto your own account and proposes from there. The branch is pushed and a
   pull request (a merge request on GitLab) is opened. A change sitting on the default branch is
   moved to a branch named `sous/submit-<date>-<time>` first.

| Flag | What it does |
|------|--------------|
| `--title <text>` | The proposal's title. Defaults to your last commit's subject. |
| `--body <text>` | The proposal's body. Defaults to a summary sous writes, listing the recipes and the versions the change would publish. |
| `--draft` | Opens the proposal as a draft. |
| `--dry-run` | Runs the whole preflight and sends nothing. |

Every step prints before it runs, and a failure says exactly which steps completed. A pushed
branch with no proposal behind it is a normal outcome of a network failure, and you are told
about it rather than left guessing.

?> If a repository's provider cannot open a proposal for you, sous prints the `contribute` pointer
from its `sous.repo.yaml` instead, so you are never left without a route.
