# Repositories

A **repository** publishes shared agent configuration that any project can subscribe to. It is
an ordinary git repository holding a few manifest files and some markdown, and sous reads it
the way a package manager reads a registry: an index says what exists, a project says what it
wants, and a lockfile records exactly what it got.

This page explains the model and the guarantees. The task-oriented guides are
[Consuming recipes](repositories-consuming.md) and
[Authoring a repository](repositories-authoring.md), and every file schema lives in
[Repository file formats](repositories-file-formats.md).

## Repositories, namespaces, recipes

Three nouns carry the whole system.

- A **repository** is the unit of trust and the unit of distribution. You add one to a project,
  which is also how you trust it, and everything else flows from that.
- A **namespace** groups related recipes inside a repository. It is a plain name, it is not
  versioned, and a project can subscribe to a whole namespace at once.
- A **recipe** is the unit you subscribe to and the unit that carries a version. It may hold
  skills, memories, prompts, config layers, variable definitions, or any mixture of them.
  Subscribing to a recipe gets everything in it.

```text
repository            github.com/sous-io/sous-recipes
  namespace           workflow
    recipe            task-files          1.2.0
    recipe            github-projects     1.0.0
  namespace           communication
    recipe            control-flow        1.0.0
```

A recipe is named by a **ref**: `workflow` for a whole namespace, `workflow/task-files` for one
recipe, `workflow/task-files@^1.2.0` to constrain the version, and
`sous-recipes:workflow/task-files` when two added repositories publish the same ref and sous
needs to be told which one you meant. Refs resolve across the cached indexes of every repository
the project has added; a genuine conflict is an error asking for the qualified form, never a
silent first match. The full grammar is in
[Refs: how anything is named](repositories-file-formats.md#refs-how-anything-is-named).

A ref of one word is a guess at a name, and sous works out what it meant: it looks for a
namespace with that name first, and for a recipe with that name second, across every repository
the project trusts. One match is used and reported by its full ref; several are a question. See
[Subscribe to a recipe](repositories-consuming.md#subscribe-to-a-recipe).

## Trust

Adding a repository **is** trusting it. There is no separate trust command, no trusted-but-not-
added state, and no way to look inside a repository before deciding: until a repository is added,
sous downloads nothing from it, not even its index. That is deliberate. A trust decision made
by browsing content sous fetched from an untrusted source is not really a trust decision; the
decision rests on the URL and on who publishes it, and both of those are things you inspect
outside sous. Trusting a repository trusts every namespace and every recipe in it, including
recipes published later. Trusting alone executes nothing, but subscribing to something inside a
trusted repository can and probably will run scripts on your machine, so the trust question is
the last gate before that happens. Sous cannot tell you whether a repository deserves trust,
and it says so rather than implying otherwise.

`sous repo add` asks that question inline, with that wording. Resolution can also turn up a
repository a recipe depends on that your project has not added; those are asked about in one
consolidated question per round, each shown with its URL and the recipe that requires it. Any
refusal aborts the whole install, because sous installs a dependency closure whole or not at all.

```term
$ sous repo add https://github.com/sous-io/sous-recipes
// sous prints the repository, its location and what trusting it means
Do you trust this repository? (y/N)
```

Where there is no terminal to ask on, such as continuous integration, the run fails and names
both the repositories and the exact command that grants the trust. `--trust` acknowledges
without being asked, and is the flag a script uses; it is one spelling of the shared
confirmation flag, alongside `-y`, `--yes`, `-f` and `--force`:

```bash
sous repo add https://github.com/sous-io/sous-recipes --trust
```

Trust is project-level and lives in your project's config, so a colleague who clones the project
inherits it along with everything else. Trust plus the lockfile is the supply-chain defense:
nothing new enters a project except through an explicit, visible change to files under version
control.

!> Trust semantics do not soften for a repository that is already on your disk. A local path
added through the `local` provider goes through the same ceremony, because its recipes still run
on this machine.

## The official repository, and `core`

Sous publishes one official repository, [`sous-io/sous-recipes`](https://github.com/sous-io/sous-recipes).
Its namespaces are drawn from the canonical [skill categories](skill-categories.md), plus one
extra namespace called `core`.

`core` is the exception to everything else on this page. It holds the skills that teach an agent
what sous is, why generated files must not be edited by hand, and where the source of a managed
file lives; without them an agent will cheerfully edit a compiled `CLAUDE.md` and wonder why the
change keeps disappearing. So `core` is auto-subscribed in every project, at the version that
matches the sous CLI you are running, and its source ships inside the sous package itself and
seeds the machine-wide store on first run. A fresh install therefore works with no network at
all, and the release pipeline pushes the same content to the official repository under the same
version number, so the built-in copy and the published copy are the same bytes.

Both wirings are ordinary config entries, and both can be switched off:

```yaml
subscriptions:
  core:
    enabled: false
```

Everything else in the official repository is opt-in, one `sous subscription add` at a time, and
`sous subscription remove core` records that opt-out for you.

?> Namespace subscriptions are a first-class feature and are worth reaching for on other
repositories, especially a team repository whose namespace is genuinely one coherent set. In the
official repository they are not what you want: any arrangement of its content yields either
one-recipe namespaces or a namespace of unrelated recipes, so subscribe to official recipes one
at a time. `core` is the deliberate exception.

## `depends` versus `subscribes`

A recipe manifest can declare two different relationships to other recipes, and the difference
is exactly one thing: whose files end up in your project.

| Relationship | Fetched and pinned | Trust-gated | Addressable from the declaring recipe | Files enter your project |
|--------------|--------------------|-------------|---------------------------------------|--------------------------|
| `depends` | yes | yes | yes | no |
| `subscribes` | yes | yes | yes | yes |

`depends` is a build dependency: shared partials, shared variable definitions, anything a recipe
reads while rendering its own files. `subscribes` is a co-subscription: subscribing to the recipe
subscribes your project to the listed targets with full semantics, so their questions run and
their files land in your output. A curated bundle is simply a recipe made mostly of `subscribes`
entries; there is no special bundle type.

Both are declarative, and that is load-bearing rather than stylistic. Because the entire
dependency closure is readable from manifests alone, sous can show you every repository an
install would reach before it fetches any of them. Configuration that could subscribe by running
code would break that, which is why manifests are YAML or JSON and never JavaScript.

Removal is refcounted. Unsubscribing removes what that subscription alone brought in and leaves
anything another subscription or another recipe still holds, and says which of those holders
kept it.

## The lockfile

`.sous/sous.lock.json` records the exact version and content hash of everything the project uses,
along with who holds each entry. It is committed. A fresh clone with no store on the machine
rebuilds precisely what the lockfile describes, fetching those versions and no others, and asking
nothing:

```term
$ git clone git@github.com:my-team/my-project.git
>> 100%
$ sous build
Restoring recipes
  This project's lockfile pins recipes that are not in the store on this machine,
  so they are being fetched at exactly the versions it records.
  restored: workflow/task-files
```

Restore decides nothing. It never resolves a range, never picks a newer version, and never
prompts. Anything that would change what is installed changes the lockfile first, as a diff you
can read in review.

## Providers

A provider is everything sous knows about one kind of repository host, and it is the only place
a host-specific fact is allowed to live. Sous ships three: `github`, `gitlab` and `local`.

A provider has two sides:

- **The read side**, which every provider answers: recognize a repository URL, take it apart into
  host, owner and name, hand back the repository's `sous.index.json`, and fetch one recipe's
  subtree at one tag. Nothing here clones a whole repository.
- **The write side**, which only a provider that can propose a change answers: report whether its
  command line tool is installed and signed in, say whether you can push to the repository
  itself, fork it onto your account, and open the proposal. Each call answers with plain data, so
  the command driving it never learns what tool ran.

Each provider declares the features it really has, `fetch` and `submit`, and sous consults that
list rather than a provider's name. `local` declares `fetch` only: a repository on your own disk
is edited directly, so asking sous to propose a change to it is refused with a message naming the
provider and the feature. A provider that supports a feature only partly says so plainly rather
than guessing; GitLab, for instance, reports that it cannot tell whether you may push instead of
sending you down a fork path it cannot finish.

?> Adding a provider is one file. A class extending `ProviderBase` inherits the subprocess, token
and refusal plumbing, implements the read path, declares its features, and overrides the write
calls it supports; adding it to the built-in list is the only other change. The interface is
internal for now, not a published plugin API.

## Where everything lives

| Location | Holds | Committed |
|----------|-------|-----------|
| `.sous/sous.lock.json` | the exact versions and hashes in use | yes |
| `.sous/conf.d/500-repos.jsonc` | the repositories the project trusts | yes |
| `.sous/conf.d/510-subscriptions.jsonc` | what the project subscribes to | yes |
| `.sous/conf.d/520-var-mappings.jsonc` | environment variable mapping records | yes |
| `.sous/sous.links.json` | this project's linked working copies | no |
| `.sous/repos/` | working copies cloned by `sous repo link` | no |
| `~/.sous/cache/` | the machine-wide recipe store | not in a project at all |
| `~/.sous/repos/` | working copies linked with `--global` | not in a project at all |
| `~/.sous/sous.links.json` | the machine-wide links map | not in a project at all |

The user-level directory is `~/.sous`, and `SOUS_HOME` moves it. Unlike `SOUS_CONFIG` and
`SOUS_DIR`, `SOUS_HOME` does not decide which project is active, so it may be set in
`.sous/.env.local` or `.sous/.env` as well as in the shell.

The three files in the `500` to `599` band are written by sous, replaced in full whenever they
change, and are not yours to hand-edit; the band exists precisely so that machine-written layers
never collide with the config you wrote. Sous never edits your primary config. You may
hand-write `repos:`, `subscriptions:` and `varMappings:` there yourself, and by the time anything
reads them the two are one merged map. See
[Managed config layers](repositories-file-formats.md#managed-config-layers).

The store is disposable by design. Every entry in it is re-fetchable from the pins in some
project's lockfile, so deleting `~/.sous/cache` costs a download and nothing else. `sous repo gc`
collects it back to a size cap, least recently used first, and never evicts an entry this
project's lockfile still pins.

## Including recipe files in your own templates

A recipe's files are addressable from a template through the reserved `~` include sigil:

```markdown
@~workflow/task-files/partials/shared.md
```

The `~` is required. A bare `@path` in an include is always a relative path or a declared alias,
with no namespace fallback, so an include line can never quietly stop meaning a file on disk and
start meaning a recipe. Inside a recipe's own files, `~<namespace>` resolves against that
recipe's declared dependencies at their pinned versions; in your project's templates it resolves
against your project's subscriptions.

A `~namespace` reference addresses a recipe's own files and nothing else, so the path after the
recipe name may not contain `.` or `..` segments and may not be absolute. One that tries to leave
the recipe directory is refused with an error saying so, exactly as every other path sous reads
refuses `..`.

## Freshness, always-pull, and links

By default a build uses what the lockfile pins and does not talk to the network. Two things
change that.

**Always-pull** installs a newer in-range version whenever one exists, rather than holding the
locked one. It is set per repository or per subscription, or asked for once with
`sous subscription add --always-pull`. It never widens the range a subscription or a dependency
declared; it re-resolves within it. The lockfile is still regenerated every time, so it always
records what the last build actually used, and a project using always-pull simply accepts
routine lockfile diffs as the record of what changed.

**The freshness window** decides how often sous bothers to look upstream at all: five minutes by
default, configurable as `store.freshnessSeconds`, with `store.watchPollSeconds` doing the same
job for watch mode. A check that fails never breaks a build. The last good index stands, the
build says what happened, and it carries on.

A **linked** repository sits outside all of this. `sous repo link` points one repository's
resolution at a working copy on your machine, which is how a maintainer edits recipes; edits
happen in a checkout, never in the store. A link bypasses versions, the lockfile and freshness
checks, and those bypasses belong to one person's machine rather than to the team, so every
build announces a linked repository loudly:

```text
One repository is LINKED to a working copy on this machine.
Their recipes are read from those checkouts, so versions, the lockfile and
freshness checks do not apply to them.
```

## Where to go next

- [Consuming recipes](repositories-consuming.md): adding, subscribing, building, and what lands
  where
- [Authoring a repository](repositories-authoring.md): `sous repo init`, writing recipes,
  releasing, and contributing
- [Recipe variables](repositories-variables.md): the resolution ladder, answers, and the
  `sous vars` commands
- [Repository file formats](repositories-file-formats.md): every manifest, index and lockfile
  schema
- [Skill categories](skill-categories.md): the canonical category list the official repository
  uses as namespaces
- [Command reference](commands.md): every command and flag
