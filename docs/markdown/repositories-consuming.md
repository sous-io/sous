# Consuming Recipes

This is the task-oriented guide to using someone else's recipes in your project. It assumes you
have read [Repositories](repositories.md) for the model, and it points at
[Repository file formats](repositories-file-formats.md) for every schema rather than repeating
them.

## Add a repository

Adding a repository is how you trust it, so this is the one step that asks you a question:

```term
$ sous repo add https://github.com/sous-io/sous-recipes
// the trust question, then one small download
Repository:  sous-recipes
Location:    https://github.com/sous-io/sous-recipes
Provider:    github
Namespaces:  communication, core, tool-usage, workflow
Recipes:     6
```

Exactly one file is fetched: the repository's `sous.index.json`. That is everything sous needs
in order to resolve a ref, list versions and decide what to download later, so adding a
repository costs one small request and installs nothing.

| Flag | What it does |
|------|--------------|
| `--name <name>` | The short name refs will use. Defaults to the last segment of the URL |
| `--provider github\|gitlab\|local` | The provider that handles it, for a host the URL does not give away |
| `--trust` | Accept trust without being asked, for a run with no terminal |
| `--dry-run` | Print what would change without trusting or fetching anything |

The entry lands in `.sous/conf.d/500-repos.jsonc`, which is committed, so your colleagues inherit
both the repository and the trust decision. Sous edits that file by key, so anything you write in
it yourself, comments included, stays where you put it.

## Subscribe to a recipe

```bash
sous subscription add workflow/task-files
```

?> `sous subscribe` is the original spelling of this command and still works, as does
`sous unsubscribe` for `subscription remove`. Every topic also answers to both spellings of its
name, so `sous subscriptions add`, `sous repos list` and `sous var show` all work too.

The ref names a namespace, one recipe, or either with a version range. The whole dependency
closure is resolved before anything is downloaded, and only then is anything written; installs
are whole or not at all.

| Flag | What it does |
|------|--------------|
| `--yes`, `-y` | Accept the confirmation and subscribe without being asked |
| `--accept-first` | When a one-word ref matches several things, take the first one listed |
| `--prerelease` | Let prerelease versions take part in version range matching |
| `--always-pull` | Install a newer in-range version whenever one exists, rather than holding the locked one |
| `--trust` | Accept trust for every repository this command adds, without being asked |
| `--dry-run` | Print what would be installed without writing or downloading anything |

### One-word refs

You do not have to remember which namespace a recipe lives in. A ref of one word is looked for
as a namespace first, and as a recipe name second, across the cached index of every repository
the project trusts:

```term
$ sous subscribe task-files
  'task-files' resolves to sous-recipes:workflow/task-files  (the recipe 'task-files' in the
  namespace 'workflow' of the repository 'sous-recipes': keeps one task file per branch).
```

When the word means more than one thing, including the case where it is a namespace in one
repository and a recipe name in another, sous lists every candidate as a full ref and asks which
one you meant:

```term
$ sous subscribe formatter
? Which 'formatter' did you mean?
  > my-recipes:formatter  (the whole namespace 'formatter' in the repository 'my-recipes')
    sous-recipes:tooling/formatter  (the recipe 'formatter' in the namespace 'tooling' of the
    repository 'sous-recipes': formats what a recipe writes)
```

The order is stable and worth knowing, because `--accept-first` takes the first candidate without
asking: repositories come first in the order your config names them, with the built-in
`sous-recipes` ahead of them; then namespaces alphabetically; then, inside a namespace, the whole
namespace ahead of the recipes in it, which are alphabetical. A word that matches nothing is an
error naming every repository that was searched.

### The confirmation

Subscribing changes your project, so sous says what it is about to do and asks before doing any
of it. Nothing is downloaded and nothing is written until the question is answered:

```term
$ sous subscribe workflow/task-files

  Subscribing to 'sous-recipes:workflow/task-files' installs the recipe 'task-files' from the
  namespace 'workflow'.

  Here is what that does:

    The files it ships are compiled into this project on the next build, which writes them into
    this project's agent directories.
    Any scripts it ships can be run on this machine when an agent uses them. Sous does not run
    them itself, and it cannot vouch for what they do.
    The variables it publishes are asked about at the end of this command, and the answers are
    written into this project's env files.
    Its dependencies are fetched and pinned in this project's lockfile, at the exact versions
    resolved now.
    If a dependency turns out to live in a repository this project does not trust, sous stops and
    asks about that repository by name before fetching anything from it.

? Proceed? (y/N)
```

Answering no ends the command with nothing downloaded, no lockfile entry and no change to your
config. `--yes` accepts the plan without being asked, which is what a script or a Makefile wants.
`--dry-run` states the plan and then reports what would be installed, asking nothing, because
there is nothing to decline.

Three files change: `.sous/conf.d/510-subscriptions.jsonc` records the subscription,
`.sous/sous.lock.json` records the exact versions and hashes, and the machine-wide store under
`~/.sous/cache` gains the recipe's files. All three, apart from the store, are committed.

If the closure reaches a repository you have not added, sous stops and asks about it by name,
showing which recipe requires it. Declining aborts the whole install:

```term
$ sous subscription add workflow/needs-extras
// resolution reaches a repository this project has not added
One repository has to be trusted before this can continue.
  extras
    Location:  https://github.com/some-team/extras
    Required:  tooling/formatter, by 'workflow/needs-extras'
```

?> A subscription entry holds the range; the ref you type may carry one (`@^1.2.0`), and the
range is what gets recorded. The subscription key itself is never qualified and never carries a
range. See [Project configuration](repositories-file-formats.md#project-configuration).

## Build, and see what lands where

```bash
sous build
```

Nothing about a recipe's files is special once they are on disk: they compile exactly the way one
of your own `entryGlob` targets does, and the [`.tpl.` convention](configuration.md) applies
unchanged, so a `.tpl.md` file is rendered and loses `.tpl.` from its name while everything else
is copied verbatim.

Where each kind of content lands is your project's decision, under the `recipeOutputs` config
key:

```js
recipeOutputs: {
  skills: ["${projectRoot}/.claude/skills", "${projectRoot}/.codex/skills"],
  memories: ["${projectRoot}/.claude/memories"],
  prompts: ["${projectRoot}/prompts/recipes"],
},
```

Only `skills` has a default, `<project root>/.claude/skills`, because that is where every agent
looks. Nothing else does. A content kind with no destination is skipped and the build says so
once, naming the key:

```text
Some subscribed recipes contribute memories and prompts files, and this project has
nowhere to put them, so they were skipped.
Name a destination directory for each kind under the 'recipeOutputs' key of your
sous config, for example:
  recipeOutputs: { memories: ["${projectRoot}/memories"], prompts: ["${projectRoot}/prompts"] }
```

Recipe outputs are tracked like every other file sous writes, so `sous prune` removes what an
unsubscribed recipe used to write and `sous clear` removes all of it. Neither ever reaches into
a linked checkout or the machine-wide store.

?> Only recipes held through `subscribes` contribute files. A recipe pulled in through `depends`
is fetched, pinned, and addressable from the recipe that declared it, and its files never enter
your output.

## Recipes that configure your project

A recipe's `config` contents are not written anywhere. They are config layers, and they load
**after your primary config and before your own `conf.d/` drop-ins**:

```text
primary config  ->  recipe config layers  ->  your conf.d/ layers  ->  managed 5xx layers
```

So a recipe can supply defaults and your project always wins over them. Recipe layers are JSON
or YAML only; sous must be able to read everything a repository publishes without running any of
it, so an executable layer from a recipe is refused with a warning rather than loaded. Ordering
among recipe layers is by recipe key and then by path, which makes it the same on every machine.

A recipe layer may set only the keys that configure the recipe itself: `_vars`, `_aliases`,
`compilation`, `runtimeContext`, `recipeOutputs`, `store` and `varMappings`. Sous removes
anything else before merging and prints a warning naming the recipe and the key it removed.

!> Subscribing to a recipe is not a decision to let it decide what else you trust. A recipe
cannot add a repository to `repos:`, subscribe you to anything, point a `tools:` entry at a
program `sous launch` would run, map new environment variables in through `_env`, or rename your
project. Those decisions stay yours, and stay in your own config.

## Answer the variables a recipe needs

A recipe publishes variable **definitions**; you supply **answers**. Subscribing asks whatever
is unanswered, reports whatever it inherited from an answer already in scope, and never re-asks
something that already fits:

```text
Variables

Answers already in scope:
  apiUrl = https://api.example.com
    from the shared scope name SOUS_VAR_API_URL, from the .env file

Answers stored:
  taskFileRoot = .sous/tasks
    SOUS_VAR_TASK_FILE_ROOT in .env
```

In continuous integration there is no terminal, so an unanswered variable fails the run rather
than hanging on a prompt, and the failure names every environment variable that would satisfy it,
most specific first:

```text
One variable still needs an answer, and there is no terminal to ask on.

Set one of the environment variables listed under each variable, or run
'sous vars ask' from a terminal.

  apiUrl (workflow/task-files): Where does the API live?
    SOUS_VAR_WORKFLOW_TASK_FILES_API_URL  (recipe scope)
    SOUS_VAR_WORKFLOW_API_URL  (namespace scope)
    SOUS_VAR_API_URL  (shared scope)
```

Set any one of those names in the environment your pipeline runs in and the run proceeds.
[Recipe variables](repositories-variables.md) covers the ladder, the two env files, mapping
records and the `sous vars` commands in full.

## Look at what you have

```bash
sous repo list
sous subscription list
sous search task
sous repo search browser --limit 50
```

All three read only what is already on disk, so all three work offline and none of them downloads
anything. `repo list` shows each trusted repository with its location, provider, namespaces,
recipe count, and whether it is currently linked to a working copy. `subscription list` shows
every subscription the project declares, with the range it resolves within, the versions the
lockfile pins for it, where it came from, and whether it is on. `repo search`, which is also the
top-level `sous search`, matches text against recipe names, namespace names and descriptions
across every cached index. A repository whose index has never been fetched is reported as such
rather than silently left out; run `sous repo add` on it again to refresh the index.

## When sous cannot ask

Every question in sous is gated by one rule. Sous treats a run as non-interactive, and so asks
nothing at all, when any of these is true:

- the global `--non-interactive` flag is passed (every command accepts it);
- the `CI` environment variable is set to anything other than `0`, `false`, `no` or `off`, which
  is what every continuous integration runner does;
- stdin or stdout is not a terminal, which is what piping or scripting a command looks like.

A run like that fails rather than guessing, and the failure names the question that could not be
asked along with the flag that would have answered it ahead of time: `--yes` for the subscribe
confirmation, `--accept-first` for the choice between candidate refs, `--trust` for the trust
question, and the exact environment variables for a variable question. The command's own help is
printed underneath the error, so every other flag is in front of you:

```term
$ CI=true sous subscription add workflow/task-files
  Sous has to ask whether to go ahead with subscribing to
  'sous-recipes:workflow/task-files', and it is not running where it can ask.
    Why: the 'CI' environment variable is set to 'true'.
    Answer it ahead of time: pass '--yes' to accept the plan above without being asked.
```

?> The error and the help both go to stderr, so piping a command's output somewhere
(`sous config show | jq`) keeps working whether or not the run fails.

## Remove a subscription

```bash
sous subscription remove workflow/task-files
sous subscription remove workflow/task-files --dry-run
```

Removal is refcounted. Every lockfile entry records who holds it, so unsubscribing removes what
that subscription alone brought in and leaves anything another subscription or another recipe
still needs, reporting what stayed and why:

```text
What stayed, and why

Recipe             Still held by
tooling/formatter  workflow/needs-extras
```

The repositories those recipes came from stay trusted; withdrawing trust is a separate,
deliberate act. Run `sous build` afterwards to prune the files the subscription used to write.

## Restore a fresh clone

A clone has the lockfile and the subscriptions, and no store. `sous build` restores exactly what
the lockfile pins, with no prompts and no version drift, then compiles:

```term
$ git clone git@github.com:my-team/my-project.git
>> 100%
$ sous build
Restoring recipes
  restored: workflow/task-files
compiled 12 targets
```

If any variable the recipes need has no answer in the committed `.sous/.env` and none in the
environment, that is where the build stops, with the message shown above.

## Collect the store

```bash
sous repo gc
sous repo gc --dry-run
sous repo gc --max-bytes 268435456
```

The store is machine-wide and disposable: everything in it is re-fetchable from the pins in a
lockfile. `repo gc` collects it back down to its size cap, evicting the least recently used
entries first, and protects everything this project's lockfile pins whatever that does to the
total. Entries other projects on the machine pin are re-fetchable too, so a pass may evict them;
the next build that needs one downloads it again.

The cap is `store.maxBytes` in your config, one gigabyte by default, and `--max-bytes` overrides
it for one run.

## Opt out of `core`

The `core` namespace is auto-subscribed in every project, at the version matching the sous CLI
you are running, and seeded from inside the sous package so it works with no network. It carries
the skills that teach an agent what sous manages and why generated files must not be hand-edited,
which is why it arrives by default.

It is still an ordinary config entry, and one line removes it:

```yaml
subscriptions:
  core:
    enabled: false
```

`sous subscription remove core` writes exactly that line into the managed subscriptions layer for
you, because there is no entry to delete: the one sous provides comes back on the next run, so
only a recorded opt-out outlives it. `sous subscription add core` clears the opt-out again.
Either way the `sous-recipes` repository stays trusted and keeps appearing in `repo list` as
built in.

Disabling the built-in `sous-recipes` repository entry the same way switches off the auto-
subscription along with everything else that repository provides. Removing `core` means your
agents lose those instructions; if you remove it, make sure something else tells them not to edit
generated files.

## Use a repository on this machine

A repository does not have to be hosted. Give `sous repo add` a path, relative or absolute, or
the same path in `file:///` form, and sous reads it through the built-in `local` provider:

```bash
sous repo add /home/me/Projects/my-recipes --name my-recipes --trust
sous repo add ../my-recipes --name my-recipes --trust
```

A relative path is resolved against the working directory before anything else happens, and the
absolute form is what lands in the config; a repository on this machine is machine-specific
either way.

It is meant for local development and for tests: authoring a repository, trying a recipe before
publishing it, or running a whole workflow with no network at all. The index is read from the
working tree when the file is there, so an index you are still writing is picked up without a
commit. A recipe's files come from the version's tag in the local git repository; a directory
that is not a git repository has no versions to honor, so its working tree is copied instead.

!> A local path is trusted through the same ceremony as a hosted repository. Its recipes still
run on this machine, and "it is already on my disk" is not a reason to skip the question.

For editing a repository you are already subscribed to, reach for
[`sous repo link`](repositories-authoring.md#edit-a-repository-in-place) instead; it redirects
one repository's resolution at a working copy without changing what your project subscribes to.

## Where to go next

- [Recipe variables](repositories-variables.md): answers, the resolution ladder, `sous vars`
- [Authoring a repository](repositories-authoring.md): publishing recipes of your own
- [Repository file formats](repositories-file-formats.md): every schema, including
  [`recipeOutputs`](repositories-file-formats.md#recipeoutputs-where-the-files-land)
- [Command reference](commands.md): every command and flag
