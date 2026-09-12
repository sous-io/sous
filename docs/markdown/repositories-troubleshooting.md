# Troubleshooting Repositories

The situations below are the ones people actually hit. Each gives the shape of the message, what
caused it, and what to do about it. For the model behind any of them read
[Repositories](repositories.md); for the schema of any file named here read
[Repository file formats](repositories-file-formats.md).

One habit saves time: read the indented lines under the first sentence of a failure, because that
is where the remedy is. A failure caused by a question sous could not ask also prints that
command's own help underneath itself; `sous help <command>` prints it on demand.

## A repository this project does not trust

```text
Error: No added repository publishes the recipe 'workflow/nope'.
  Repositories searched: qa-recipes, sous-recipes.
  Add the repository that publishes it with 'sous repo add <url>', then try again.
```

A qualified ref whose qualifier is unknown says `This project trusts no repository called
'acme'`. Either way the cause is the same: added equals trusted, and sous reads nothing from a
repository, not even its index, until the project's `repos` map names it. Add it:

```bash
sous repo add https://github.com/acme/recipes --name acme
```

If a dependency of something you are installing lives in a repository you have not added, sous
stops before fetching anything and asks about every such repository in one consolidated question,
listing each URL and the recipe that requires it. Declining any of them stops the whole install.

?> Trusting a repository trusts every namespace and recipe in it, including ones published later.
Trusting alone runs nothing; subscribing to something inside it can run scripts on this machine.

## A ref that names more than one thing

```text
'task-files' names a recipe in more than one repository this project trusts:
    sous-recipes:workflow/task-files
    acme:workflow/task-files
  Name the repository as well, as 'repository:task-files', to say which one you mean.
```

At a terminal sous offers the candidates as a list to choose from instead. Sous never picks a
winner on its own: a short name is a label your project chose, so two repositories may
legitimately use the same one. Three ways to settle it:

- Write the qualified ref, `acme:workflow/task-files`, which is the durable fix.
- Pass `--accept-first` to take the first candidate in the listing order printed above the error.
- Remove the repository you did not mean, with `sous repo remove <name>`.

## A question sous cannot ask

```text
Error: Sous has to ask whether to go ahead with subscribing to 'workflow/task-files', and it is
  not running where it can ask.
  Why: neither input nor output is a terminal.
  Answer it ahead of time: pass '--yes' (spelled '-y', '--force' or '--trust' if you prefer) to
    accept the plan above without being asked.
```

Three things take the terminal away, and the `Why:` line says which one applied: the global
`--non-interactive` flag, a truthy `CI` environment variable, or stdin or stdout not being a
terminal (which is what piping a command looks like from inside sous). Answer ahead of time:

| Question | Answer it ahead of time with |
|----------|------------------------------|
| Confirm this plan, or trust this repository | `--yes` (or `-y`, `--force`, `--trust`) |
| Which candidate did you mean | `--accept-first`, or write the fully qualified ref |
| What is the value of this recipe variable | `--answer name=value`, `--answers-file`, or the variable's environment variable |

Unanswered variables are covered in [Recipe variables](repositories-variables.md).

## A dependency written as a path

```text
Error: Invalid dependency 'local:///home/me/recipes/workflow/sat': a local repository is a
  consumer's convenience, not a published location, so a manifest cannot depend on one. Publish
  the recipe and depend on it by its published location.
```

A published manifest is read by other people on other machines, so it can only name locations
those machines can reach. Two neighbouring mistakes get their own messages: a `repo:` qualifier
is refused because a short name is a label only the consuming project knows, and an unknown
scheme is refused naming the providers sous ships. Write one of the two legal forms:

```yaml
depends:
  - workflow/sat                                       # a sibling in this repository
  - github://acme/recipes/workflow/sat@^1.1            # a recipe in another repository
```

While developing both sides, use `sous repo link` instead; it redirects resolution at a working
copy without changing anything you publish.

## A published version whose content changed

```text
Error: The content of github.com/acme/recipes:workflow/sat@1.2.0 does not match the hash it is
  pinned to.
  Expected: sha256-...
  Actual:   sha256-...
  Nothing was written to the store. Either the upstream files changed under a published version,
  or the download was corrupted.
```

A version is immutable. The lockfile records the content hash of every recipe it pins; a restore
fetches the locked tag and verifies what arrives against that hash before anything is written.

Retry once, in case the download was truncated. If it fails again, the tag upstream has been
moved or rewritten: tell the publisher, and do not work around it by editing the hash in your
lockfile. A related message appears when the store already holds that version with other content:

```text
Error: The store already holds github.com/acme/recipes:workflow/sat@1.2.0 with different content.
  A published version is immutable, so sous will not overwrite it. Remove the entry deliberately
  if the upstream version was genuinely republished.
```

## A sibling with no tag

Releasing a recipe that depends on another recipe in the same repository fails when that sibling
has never been published:

```text
it depends on 'workflow/sat', which has never been published: this repository carries no tag for
it. Release it first, which cuts the tag 'workflow/sat@1.0.0'.
```

Release the sibling first, or widen the scope so the same run publishes both; sous orders the
releases in a run so a sibling is tagged before whatever depends on it. A sibling that HAS been
tagged but has changed since is only a warning, and the release is still correct:

```text
'workflow/sat' has changes since 'workflow/sat@1.0.0' that are outside this release's scope;
'workflow/task-files@2.0.0' will depend on 'workflow/sat@1.0.0'.
```

If that is not what you want, include the sibling in the release scope.

## An index older than you expected

Sous re-checks a repository's index only once its freshness window has lapsed. The window
defaults to five minutes; set `store.freshnessSeconds` in your config to change it, and
`store.watchPollSeconds` for the interval watch mode polls at.

A check is due when the repository has never been checked, when the window has lapsed, or when
the last recorded check time is in the future (which means a clock moved under sous). To force
one now, add the repository again; re-adding an already-trusted repository refreshes its index
and changes nothing else:

```bash
sous repo add https://github.com/acme/recipes
# This project already trusted 'acme-recipes', so only its index was refreshed.
```

A failed check never breaks a build. Sous falls back to the copy it already has and says so:

```text
Sous could not check the repository 'acme-recipes' for updates, so it is using the copy of its
index that it already had.
```

The failed check is recorded too, so an unreachable host is not retried on every single build.

## A store entry that fails its hash

```text
The cached copy of github.com/sous-io/sous-recipes:core/sous-skills@0.2.0 did not match its
recorded content hash, so it was removed from the store and will be fetched again.
```

This is a warning, not an error, and the build carries on. Every store entry carries a marker
recording the hash of its own content; sous verifies the tree on every lookup and throws away
anything that no longer matches, so a store damaged by a crash, a partial copy or a stray edit
heals itself on the next run. An unreadable marker is treated the same way. Never edit files
inside `$SOUS_HOME/cache`; the edit is discarded, and `sous repo link` is the supported way to
work against a checkout. A warning that repeats every build points at the machine: a filesystem
that reorders writes, or two users sharing one store.

To reclaim space rather than repair, use `sous repo gc`, which evicts least-recently-used entries
this project's lockfile does not pin:

```bash
sous repo gc --dry-run
sous repo gc --max-bytes 268435456
```

## A lockfile written by an older sous

Older lockfiles recorded only a repository's URL; each entry now also carries the repository's
canonical identity, because that is what the machine-wide store is keyed by. Reading an old
lockfile is not an error: sous derives the identity from the URL exactly as the writer would
have, and the field fills itself in on the next write. It only fails when the URL belongs to no
provider sous knows:

```text
repos.acme.identity is missing, and sous could not work one out from the url
'svn://example.com/recipes' because no provider recognizes it. Add an 'identity' to this entry,
or remove the lockfile and subscribe again to have sous rebuild it.
```

The repair for any lockfile that has drifted from the config, whether from a hand edit, a bad
merge or a subscription removed by hand, is:

```bash
sous lock rebuild --dry-run   # see what would change
sous lock rebuild
```

It resolves every subscription the project declares against the cached indexes and replaces the
lockfile outright, downloading nothing, asking nothing and granting no trust; a subscription whose
repository is not added, or whose index has never been fetched, is reported by name.

## Core skills missing after a sous upgrade

Every project is subscribed to the `core` namespace, and the matching recipe ships inside the
sous package, so a first run on a machine with no network still gets it.

Right after a sous upgrade the official repository has usually not published the matching version
yet. Sous folds the packaged version into that repository's index in memory whenever the index
does not offer it. The cached index file is never touched, so it stays an honest record of what
upstream served, and the moment upstream publishes that version its own entry is used instead.
You should see nothing at all.

Seeding never fails a build. When it genuinely fails it says so and carries on:

```text
Sous could not seed the core recipe it ships with, so the skills in the 'core' namespace are
unavailable until this is fixed.
```

The cause is almost always a store that cannot be written: `$SOUS_HOME` pointing somewhere
read-only, a full disk, or a permissions problem left by running sous once under `sudo`.

## Every build says a repository is linked

```text
WARNING:
One repository is LINKED to a working copy on this machine.
Their recipes are read from those checkouts, so versions, the lockfile and
freshness checks do not apply to them.

acme-recipes -> /home/me/Projects/acme-recipes

Run 'sous repo unlink <name>' to go back to the published versions.
```

This is working as intended and cannot be suppressed. A link makes a build read a repository from
a working copy instead of a published version, so the build can produce something different from
what a colleague's build produces from the same commit; a silent change of that size would be far
worse than a noisy one.

Run `sous repo unlink <name>` when you are done editing. Links are never committed: they live in
`.sous/sous.links.json` (this project) or `$SOUS_HOME/sous.links.json` (every project on the
machine), and sous keeps both out of version control through the managed block it maintains in
`.sous/.gitignore`. A colleague seeing this warning is seeing their own machine's link.

## A variable pattern that runs out of time

```text
apiUrl could not be checked: the pattern ^(([a-z]+)+)+$, published by the recipe
workflow/task-files, took longer than 100 milliseconds to run, so sous stopped waiting for it.
The pattern is too slow to run, and the answer was not the problem; this needs to be reported to
whoever publishes the recipe.
```

Recipe variables may declare a validation pattern, and sous runs each one under a time budget (100
milliseconds by default) so a catastrophically backtracking regular expression cannot hang a
build. There is no answer you can type that a runaway pattern would finish on, so this is a bug
report for the recipe's publisher; until it is fixed, pin the recipe to a version published
before the pattern was introduced.

## A local repository named by a relative path

On the command line a relative path is fine: `sous repo add ../recipes` expands it, stores the
absolute result, and if nothing is there says so, naming both what you typed and the path it read
that as. Inside a config file a relative path is refused outright:

```text
Error: '../recipes' is not a local repository path that sous can read.
  A local repository is named by an absolute path, or by the same path in 'file:///...' form. A
  relative path is not accepted, because a repository entry is read from a config file that
  several working directories may run against.
```

Write the absolute path, or the same path as a `file:///...` URL. Letting `sous repo add` resolve
the path for you is the simplest way to get a correct entry.

## SOUS_HOME on a shared machine

`$SOUS_HOME` defaults to `~/.sous` and holds the recipe store, the machine-wide links map, and
globally linked checkouts. It is per-user state, not per-project state, and nothing in it is
locked against two people writing at once.

Do not point two accounts at one `SOUS_HOME`. Symptoms of a shared one are permission failures
writing the store, entries that keep failing their hash, `sous repo gc` evicting entries another
user's project was using (it keeps only what the lockfile in front of it pins), and machine-wide
links appearing in builds nobody on that project created.

`SOUS_HOME` is the one `SOUS_*` variable that may be set in an env file, because it does not
decide which project is active, so a project that needs its own store can say so in
`.sous/.env.local`:

```bash
SOUS_HOME=~/caches/sous-home
```

A bare or whitespace-only value counts as unset rather than as the current directory, and a
leading `~` expands. Compare [Discovery and overrides](config-discovery.md), where `SOUS_CONFIG`,
`SOUS_DIR` and `SOUS_CONFD` are read from the real environment only.

## See also

- [Repositories](repositories.md): the model, and what lives where
- [Consuming recipes](repositories-consuming.md): adding, subscribing, updating, removing
- [Recipe variables](repositories-variables.md): answers, env files, unanswered questions
- [Authoring a repository](repositories-authoring.md): publishing, linking, releasing
- [Repository file formats](repositories-file-formats.md) and the
  [command reference](commands.md): every schema, every command, every flag
