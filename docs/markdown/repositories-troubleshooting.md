# Troubleshooting Repositories

The situations below are the ones people actually hit. Each gives the shape of the message, what
caused it, and what to do about it. For the model behind any of them read
[Repositories](repositories.md); for the schema of any file named here read
[Repository file formats](repositories-file-formats.md). One habit saves time: read the indented
lines under the first sentence of a failure, because that is where the remedy is.

## A repository this project does not trust

```text
Error: No added repository publishes the recipe 'workflow/nope'.
  Repositories searched: qa-recipes, sous-recipes.
  Add the repository that publishes it with 'sous repo add <url>', then try again.
```

A browsing command given a qualified ref whose qualifier is unknown says `This project trusts no
repository called 'acme'`; a subscribe says `Sous does not know where the repository 'acme' lives,
so it cannot add it for you`, and prints the `sous repo add <url> --name acme` line to run. Either
way, added equals trusted: sous reads nothing from a repository, not even its index, until the
project's `repos` map names it.

If a dependency of what you are installing lives in a repository you have not added, sous stops
before fetching anything and asks about all of them in one question, listing each URL and the recipe
that requires it; declining any of them stops the whole install.

!> Trusting a repository trusts every namespace and recipe in it, including ones published later.
Trusting alone runs nothing; subscribing to something inside it can run scripts on this machine.
See [Trust](repositories.md#trust).

## A ref that names more than one thing

```text
Error: Sous has to ask which 'task-files' you meant, and it is not running where it can ask.
  Why: neither input nor output is a terminal.
  'task-files' matched 2 things:
    acme:workflow/task-files  (the recipe 'task-files' in the namespace 'workflow' of the
      repository 'acme')
    sous-recipes:workflow/task-files  (the recipe 'task-files' in the namespace 'workflow' of
      the repository 'sous-recipes')
  Answer it ahead of time: write the full reference (for example 'acme:workflow/task-files'), or
    pass '--accept-first' to take the first candidate listed above.
```

At a terminal that same list is offered as a choice instead; sous never picks a winner on its own,
because a short name is a label your project chose. Three ways to settle it:

- Write the qualified ref, `acme:workflow/task-files`, which is the durable fix.
- Pass `--accept-first` to take the first candidate in the listing order printed above the error.
- Remove the repository you did not mean, with `sous repo remove <name>`.

The browsing commands, `sous recipe show` and `sous namespace show`, offer no choice and have no
`--accept-first`; they stop with `'task-files' names a recipe in more than one repository this
project trusts`, so there the qualified ref is the only fix.

## A version range nothing satisfies

```text
Error: No published version of 'workflow/qa-helper' satisfies what was asked for.
  Version range asked for:
    ^2 (required by project)
  Versions this repository publishes: 0.1.0.
  Prerelease versions were not considered. A subscription may opt into them with
  'prerelease: true', and 'sous subscribe' with '--prerelease'.
```

The range comes from your own subscription or from a dependency of the recipe you asked for, and the
parenthetical says which: `required by project` is your subscription, anything else names the recipe
that asked. Widen or correct the range, or opt into prereleases with `prerelease: true` on the
subscription or `--prerelease` on the command.

## A question sous cannot ask

```text
Error: Sous has to ask whether to go ahead with subscribing to 'workflow/task-files', and it is
  not running where it can ask.
  Why: neither input nor output is a terminal.
  Answer it ahead of time: pass '--yes' (spelled '-y', '--force' or '--trust' if you prefer) to
    accept the plan above without being asked.
```

The `Why:` line says which of the three non-interactive conditions applied; they are listed under
[In CI, and for agents](repositories-consuming.md#in-ci-and-for-agents). Answer ahead of time:

| Question | Answer it ahead of time with |
|----------|------------------------------|
| Confirm this plan, or trust this repository | `--yes` (or `-y`, `--force`, `--trust`) |
| Which candidate did you mean | `--accept-first`, or write the fully qualified ref |
| What is the value of this recipe variable | `--answer name=value`, `--answers-file`, or the variable's environment variable |

Unanswered variables have their own page, [Recipe variables](repositories-variables.md).

## A dependency written as a path

```text
Error: Invalid dependency 'local:///home/me/recipes/workflow/sat': a local repository is a
  consumer's convenience, not a published location, so a manifest cannot depend on one. Publish
  the recipe and depend on it by its published location.
```

A published manifest is read on other machines, so it can only name locations those machines can
reach. Two neighboring mistakes get their own messages: a `repo:` qualifier is refused, because a
short name is a label only the consuming project knows, and an unknown scheme is refused with the
providers sous ships named (see [Providers](repositories-providers.md)). The legal forms:

```yaml
depends:
  - workflow/sat                                       # a sibling in this repository
  - github://acme/recipes/workflow/sat@^1.1            # a recipe in another repository
```

While developing both sides, use
[`sous repo link`](repositories-authoring.md#edit-a-repository-in-place); it redirects resolution
at a working copy without changing what you publish.

## A published version whose content changed

```text
Error: The content of github.com/acme/recipes:workflow/sat@1.2.0 does not match the hash it is
  pinned to.
  Expected: sha256-...
  Actual:   sha256-...
  Nothing was written to the store. Either the upstream files changed under a published version,
  or the download was corrupted.
```

A version is immutable: the lockfile pins each recipe's content hash, and a restore verifies what
arrives against it before anything is written. Retry once, in case the download was truncated; if it
fails again, the tag upstream has moved, so tell the publisher rather than editing the hash in your
lockfile. A related message appears when the store already holds that version with other content:

```text
Error: The store already holds github.com/acme/recipes:workflow/sat@1.2.0 with different content.
  Stored:   sha256-...
  Incoming: sha256-...
  A published version is immutable, so sous will not overwrite it. Remove the entry deliberately
  if the upstream version was genuinely republished.
```

## A sibling with no tag

Releasing a recipe whose sibling in the same repository has never been published fails:

```text
Error: recipes/workflow/task-files/sous.recipe.yaml:
  it depends on 'workflow/sat', which has never been published: this repository carries no tag
  for it. Release it first, which cuts the tag 'workflow/sat@1.0.0'.
```

Every problem is printed with the manifest it was found in, and the run ends with
`Error: This repository cannot be released yet: 1 problem is listed above.` Release the sibling
first, or widen the scope so one run publishes both; sous tags a sibling before whatever depends on
it. A sibling that HAS been tagged but has changed since is only a warning:

```text
WARNING:
recipes/workflow/task-files/sous.recipe.yaml:
'workflow/sat' has changes since 'workflow/sat@1.0.0' that are outside this release's scope;
'workflow/task-files@2.0.0' will depend on 'workflow/sat@1.0.0'.
```

If that is not what you want, include the sibling in the release scope.

## A release with no git identity

```text
Error: Cannot release: git does not know who is making the commit.
```

A release commits the version bumps and the index, and cuts an annotated tag for every version it
publishes; git refuses to do either without an author identity. The check runs after the plan is
accepted and before anything is committed or tagged, so a run that stops here has written nothing.
Set `git config user.name` and `git config user.email` and run the command again; in a continuous
integration job, configure the identity of the account the release runs as, which the workflow
`sous repo init` scaffolds already does.

## An index older than you expected

Sous re-checks a repository's index only once its freshness window has lapsed; the window and its
default are described under
[Freshness, always-pull, and the store](repositories-consuming.md#freshness-always-pull-and-the-store).
A check is due when the repository has never been checked, when the window has lapsed, or when the
last recorded check time is in the future (a clock moved under sous). Re-adding an already-trusted
repository forces one; it refreshes the index and changes nothing else:

```term
$ sous repo add https://github.com/acme/recipes --name acme-recipes
    Repository: acme-recipes
    Namespaces: workflow

  This project already trusted 'acme-recipes', so only its index was refreshed.
```

A failed check never breaks a build. Sous falls back to the copy it already has, says so, and
records the failure, so an unreachable host is not retried on every single build:

```text
Sous could not check the repository 'acme-recipes' for updates, so it is using the copy of its
index that it already had.
fatal: unable to access 'https://github.com/acme/recipes/': Could not resolve host github.com
```

## A store entry that fails its hash

```text
The cached copy of github.com/sous-io/sous-recipes:core/sous-skills@0.2.0 did not match its
recorded content hash, so it was removed from the store and will be fetched again.
```

This is a warning, not an error, and the build carries on. Every store entry records the hash of its
own content and sous verifies the tree on every lookup, so a store damaged by a crash, a partial copy
or a stray edit heals itself on the next run. Never edit files inside `$SOUS_HOME/cache`; the edit is
discarded, and `sous repo link` is the supported way to work against a checkout. A warning on every
build points at the machine: a filesystem that reorders writes, or two accounts sharing one store.

To reclaim space rather than repair, run `sous repo gc --dry-run` to see what would go, then
`sous repo gc`; what it evicts, and what it protects, is described under
[Freshness, always-pull, and the store](repositories-consuming.md#freshness-always-pull-and-the-store).

## A lockfile written by an older sous

Older lockfiles recorded only a repository's URL; each entry now also carries the canonical identity
the machine-wide store is keyed by. Reading an old lockfile is not an error: sous derives the
identity from the URL, and the field fills itself in on the next write. It fails only when the URL
belongs to no provider sous knows:

```text
repos.acme.identity is missing, and sous could not work one out from the url
'svn://example.com/recipes' because no provider recognizes it. Add an 'identity' to this entry,
or remove the lockfile and subscribe again to have sous rebuild it.
```

The repair for a lockfile that has drifted from the config, whether from a hand edit, a bad merge or
a subscription removed by hand, is `sous lock rebuild`, with `--dry-run` first. It resolves every
subscription against the cached indexes and replaces the lockfile outright, downloading nothing,
asking nothing and granting no trust; a subscription whose repository is not added, or whose index is
missing, is reported by name.

## Core skills missing after a sous upgrade

Every project is subscribed to the `core` namespace, and the matching recipe ships inside the sous
package, so a first run with no network still gets it. Right after an upgrade the official
repository has usually not published the matching version yet, so sous folds the packaged version
into that repository's index in memory and leaves the cached file untouched; see
[The official repository](repositories.md#the-official-repository-and-the-built-in-core). Seeding
never fails a build, and when it genuinely fails it says so and carries on:

```text
Sous could not seed the core recipe it ships with, so the skills in the 'core' namespace are
unavailable until this is fixed.
EACCES: permission denied, mkdir '/home/me/.sous/cache'
```

The second line is the underlying failure, and it is nearly always a store that cannot be written:
`$SOUS_HOME` pointing somewhere read-only, a full disk, or a permissions problem left by running sous
once under `sudo`.

## Every build says a repository is linked

```text
WARNING:
One repository is LINKED to a working copy on this machine.
Their recipes are read from those checkouts, so versions, the lockfile and
freshness checks do not apply to them.

acme-recipes -> /home/me/Projects/acme-recipes

Run 'sous repo unlink <name>' to go back to the published versions.
```

This is working as intended and cannot be suppressed. A link makes a build read a repository from a
working copy instead of a published version, so it can produce something different from what a
colleague's build produces from the same commit, and a silent change of that size would be worse than
a noisy one. Run `sous repo unlink <name>` when you are done editing; a colleague seeing this warning
is seeing a link on their own machine. Links are never committed: they live in
`.sous/sous.links.json` (this project) or `$SOUS_HOME/sous.links.json` (every project on the machine),
and sous keeps the project's own map out of version control through the managed block it maintains in
`.sous/.gitignore`; the machine-wide map lives outside any working copy.

## A variable pattern that runs out of time

```text
apiUrl could not be checked: the pattern ^(([a-z]+)+)+$, published by the recipe
workflow/task-files, took longer than 100 milliseconds to run, so sous stopped waiting for it.
The pattern is too slow to run, and the answer was not the problem; this needs to be reported to
whoever publishes the recipe.
```

Recipe variables may declare a validation pattern, and sous runs each under a time budget (100
milliseconds by default) so a backtracking regular expression cannot hang a build. No answer you can
type would finish a runaway pattern, so this is a bug report for the publisher; until it is fixed,
pin the recipe to a version published before the pattern arrived.

## A local repository named by a relative path

On the command line a relative path is fine; `sous repo add ../recipes` expands it and stores the
absolute result (see [The local provider](repositories-providers.md#the-local-provider) for what a
bad path prints). Inside a config file a bare relative path never reaches a provider: config
validation rejects it first, as `repos.acme.url: Invalid input` inside the `Invalid sous config at
<path>:` block. An entry that does name the local provider, through a `file://` URL or
`provider: local`, gets the fuller explanation; either way, write the absolute path:

```text
Error: 'file://../recipes' is not a local repository path that sous can read.
  A local repository is named by an absolute path, or by the same path in 'file:///...' form. A
  relative path is not accepted, because a repository entry is read from a config file that
  several working directories may run against.
```

## A store two accounts share

Permission failures writing the store, entries that keep failing their hash, `sous repo gc`
evicting entries another user's project was using (it keeps only what the lockfile in front of it
pins), and machine-wide links nobody on that project created all point at one cause: two accounts
sharing a `SOUS_HOME`.

`$SOUS_HOME` defaults to `~/.sous`, and what it holds is laid out under
[`.sous.entry.json` and the store](repositories-file-formats.md#sousentryjson-and-the-store). It is
per-user state, and nothing in it is locked against two people writing at once. It is also the one
`SOUS_*` variable that may be set in an env file, because it does not decide which project is
active, so a project needing its own store can say `SOUS_HOME=~/caches/sous-home` in
`.sous/.env.local`. A bare or whitespace-only value counts as unset, and a leading `~` expands;
compare [Discovery and overrides](config-discovery.md), where `SOUS_CONFIG`, `SOUS_DIR` and
`SOUS_CONFD` are read from the real environment only.

## Where to go next

- [Quickstart](repositories-quickstart.md): the shortest path from an empty project to a skill
- [Repositories](repositories.md): the model, and what lives where
- [Consuming recipes](repositories-consuming.md): adding, subscribing, updating, removing
- [Recipe variables](repositories-variables.md): answers, env files, unanswered questions
- [Authoring a repository](repositories-authoring.md): publishing, linking, releasing
- [Providers](repositories-providers.md): which URLs sous recognizes, and what `local` can do
- [Repository file formats](repositories-file-formats.md) and the
  [command reference](commands.md): every schema, every command, every flag
