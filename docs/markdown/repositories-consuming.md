# Consuming Recipes

The task guide to using someone else's recipes. [Repositories](repositories.md) explains the model;
[Repository file formats](repositories-file-formats.md) holds every schema, so this page points at
it rather than repeating one.

## Add a repository

Adding a repository is how you trust it, so it is the one step that asks a question. Exactly one
file is fetched, its `sous.index.json`, which is all sous needs to resolve refs and list versions:

```term
$ sous repo add https://github.com/sous-io/sous-recipes
// the trust question, then one small download
    Repository: sous-recipes
    Provider  : github
    Namespaces: communication, core, tool-usage, workflow
    Recipes   : 6
  This project now trusts 'sous-recipes'. Nothing from it has been installed.
```

`--name` sets the short name refs will use (it defaults to the last segment of the URL) and
`--provider github|gitlab|local` names the provider for a host the URL does not give away.
`--dry-run` prints what would change without trusting or fetching anything, and `-y` accepts trust
without being asked (`--yes`, `-f`, `--force` and `--trust` are the same flag). The entry lands in
`.sous/conf.d/500-repos.jsonc`, which is committed, so colleagues inherit the repository and the
trust decision with it; sous edits that file by key, so your comments and key order survive.

A repository need not be hosted: `sous repo add ../my-recipes --name my-recipes` reads a path
through the built-in `local` provider. A relative path resolves against the working directory, and
the absolute form lands in the config. The index is read from the working tree, so one you are
still writing is picked up without a commit; a version's files come from that version's git tag,
and a non-git directory has its working tree copied.

!> A local path goes through the same trust question as a hosted one. To edit a repository you
already subscribe to, use [`sous repo link`](repositories-authoring.md#edit-a-repository-in-place).

## Find a recipe

These commands read the cached indexes and the lockfile; all work offline and download nothing:

```bash
sous search qa                 # names and descriptions everywhere; --limit defaults to 25
sous namespace list            # every namespace, its recipe count, whether you subscribe
sous namespace show workflow   # one namespace and the recipes in it
sous recipe list               # every recipe, latest version, pinned version, subscribed
```

`sous recipe show` is the one to read before subscribing. It describes a recipe from what sous
holds: every published version, what it depends on (as the manifest declares it, beside the version
the index resolved that to), and, once the files are here, its questions and its files.

```term
$ sous recipe show workflow/qa-variables
    Latest version : 0.1.0
    Pinned version : this project pins none
    Subscribed     : no
  Dependency          Declared as  Resolved to  Repository       Kind
  workflow/qa-helper  ^0.1.0       0.1.0        this repository  depends
  The recipe's own files are not on this machine, so the questions it asks and the files it
    publishes are not known here. Subscribing to it fetches them.
```

A repository whose index has never been fetched is named as such in every listing rather than
quietly left out, so "the name is wrong" never reads like "nothing is there".

## Subscribe to a recipe

```bash
sous subscription add workflow/qa-variables
sous subscription add workflow/qa-variables@^1.2.0
sous subscription add workflow          # a whole namespace
```

The whole dependency closure resolves before anything is downloaded, and only then is anything
written; an install is whole or not at all, and `--prerelease` lets prereleases match a range.

| Flag | What it does |
|------|--------------|
| `-y, --yes` | Answer yes to both questions this command can ask: the subscribe confirmation, and the trust question for a repository it has to add |
| `--accept-first` | When a one-word ref matches several things, take the first one listed |
| `--answer <name>=<value>` | Answer one question ahead of time. Repeat it per answer, or read a whole file of them with `--answers-file <path>` |
| `--always-pull` | Install a newer in-range version whenever one exists, rather than holding the locked one |
| `--dry-run` | Print what would be installed, writing and downloading nothing |
| `--no-build` | Record the subscription without rebuilding the project |

?> `sous subscribe` is the original spelling and still works, as does `sous unsubscribe`. Every
topic answers to both spellings of its name, so `sous subscriptions add` and `sous repos list`
work too.

### One-word refs

You do not have to remember which namespace a recipe lives in. A bare word is looked for as a
repository, a namespace and a recipe name across every cached index; a single match is announced
(`Resolved to: qa-recipes:quality/qa-pattern`) rather than silently assumed, and a word matching
nothing is an error naming every repository searched and every trusted one whose index could not be
read. When the word means more than one thing, sous lists every candidate as a full ref and asks
which you meant. The listing order is the contract, because `--accept-first` takes the first one:
candidates sort by how qualified the spelling that matched was, then by kind (repository,
namespace, recipe, variable, environment variable), then by repository in search order, then
alphabetically.

### The plan, and the confirmation

Subscribing changes your project, so sous says what it is about to do and asks first; nothing is
downloaded or written until the question is answered.

```term
$ sous subscription add workflow/qa-variables
  Subscribing to 'qa-recipes:workflow/qa-variables' installs the recipe 'qa-variables' from
    the namespace 'workflow'. Here is what that does:

  • The files it ships are compiled into this project on the next build, which writes them
    into this project's agent directories.
  • Any scripts it ships can be run on this machine when an agent uses them. Sous does not
    run them itself, and it cannot vouch for what they do.
  • The variables it publishes are asked about at the end of this command, and the answers
    are written into this project's env files.
  • Its dependencies are fetched and pinned in this project's lockfile, at the exact
    versions resolved now.
  • If a dependency lives in a repository this project does not trust, sous stops and asks
    about that repository by name before fetching anything from it.
? Proceed? (y/N) y
  Recipe                 Version  Repository  Why
  workflow/qa-helper     0.1.0    qa-recipes  needed by workflow/qa-variables
  workflow/qa-variables  0.1.0    qa-recipes  you subscribed to it
```

Answering no ends the command with nothing downloaded and no change to your config. Three things
change when you say yes: `.sous/conf.d/510-subscriptions.jsonc` records the subscription,
`.sous/sous.lock.json` records the exact versions and hashes, and the machine-wide store under
`~/.sous/cache` gains the files (the first two are committed; the store is not). The command then
finishes by building, the same compile and prune `sous build` runs, so the new skills are on disk
when it returns; `--no-build` leaves that for the next `sous build`, and a failed build does not
undo the subscription.

?> Only recipes held through `subscribes` contribute files. One pulled in through `depends`, like
`workflow/qa-helper` above, is fetched, pinned and addressable from the recipe that declared it,
but its own files never enter your output.

## Where the files land

Recipe files compile the way one of your own `entryGlob` targets does, so the
[`.tpl.` convention](configuration.md) applies unchanged. Where each content kind lands is your
project's decision, under the
[`recipeOutputs`](repositories-file-formats.md#recipeoutputs-where-the-files-land) config key,
which takes a list of directories for each of `skills`, `memories` and `prompts`. Only `skills` has
a default, `<project root>/.claude/skills`, because that is where every agent looks; a kind with no
destination is skipped and the build says so once, naming the key. Recipe outputs are tracked like
every other file sous writes, so `sous prune` removes what an unsubscribed recipe used to write and
`sous clear` removes all of it; neither ever reaches into a linked checkout or the store.

## Answer the questions

A recipe publishes variable definitions; you supply answers. Subscribing asks whatever is
unanswered, reports whatever it inherited from an answer already in scope, and never re-asks
something that already fits. A question shows the description and four facts (`default`, `example`,
`stored-as`, `storage-path`); Tab opens the advanced view, where you can change which env file the
answer lands in and which environment variable name holds it. To answer ahead of time, list the
questions with a dry run, which installs nothing, then supply them all in one command:

```bash
sous subscription add workflow/qa-variables --dry-run --non-interactive
sous subscription add workflow/qa-variables --yes --answer qaAgentName=QA \
  --answer qaReviewDepth=thorough
```

Every answer is checked against its definition before anything is installed, so a run stores all of
them or none:

```text
  Error: The answer given for 'qaReviewDepth' does not fit the definition workflow/qa-variables
    publishes.
    qaReviewDepth must be one of: light, standard, thorough.
    For example: thorough
    Nothing was written; fix the answer and run the command again.
```

A name no recipe declares fails the run and lists every variable in play, so a typo cannot become a
stored value under a name nothing reads. Names are spelled in camelCase, as the recipe declares
them; the full `namespace/recipe.name` key works too, for when two recipes publish the same name,
and everything after the first `=` is the answer. `--answers-file answers.yaml` reads the same
names from a YAML or JSON file of `name: value` pairs.

?> A dry run downloads nothing, so a recipe your machine does not hold yet has no manifest to read
and its questions cannot be listed; the run still succeeds and names them.
[Recipe variables](repositories-variables.md) covers the ladder, the env files and `sous vars`.

## See what you have

```term
$ sous subscription list
  Subscription           Range        Pinned version               Origin    Enabled
  core                   0.2.0        pinned on first build        built in  yes
  workflow/qa-variables  any version  workflow/qa-variables 0.1.0  user      yes
```

`sous repo list` shows each trusted repository with its provider, origin, whether it is linked, its
recipe count and its URL, and `--verbose` adds a `Namespaces:` line under each row. `sous lock show`
prints the other half: every version your lockfile pins, where it came from, and who holds it
(`this project` for a subscription, the recipe key for a dependency). When that file has drifted
through a hand edit or a bad merge, `sous lock rebuild` recomputes it from your subscriptions.

## Remove a subscription

`sous subscription remove workflow/qa-variables` is refcounted, and takes `--dry-run` and
`--no-build` too. Every lockfile entry records who holds it, so unsubscribing removes what that
subscription alone brought in and leaves anything another subscription or recipe still needs, under
a `What stayed, and why` heading naming each recipe and what holds it. Like adding one, it finishes
by building, so the files it used to write are pruned before it returns.

### Stop trusting a repository

Removing a repository withdraws the trust that adding it granted, and everything held through it
goes too. Before writing anything, the command says exactly what that means here:

```term
$ sous repo remove qa-recipes --dry-run
  The entry for 'qa-recipes' is removed from this project's repositories layer, so sous stops
  reading anything from it. Here is what goes with it:
    One subscription resolves into it and is removed: workflow/qa-variables.
    2 locked recipes are held only through those subscriptions, and they leave the lockfile:
      workflow/qa-helper, workflow/qa-variables.
    2 files those recipes compiled are pruned by the build that follows:
      .claude/skills/qa-variables/SKILL.md
```

Then it asks once, and `--yes` answers ahead for a run with no terminal. Each subscription goes
through the same refcounted path, so a recipe something else still needs stays and is reported with
whoever holds it. A link is removed, but the checkout stays on disk, because it is a working copy
sous did not necessarily put there, and a subscription written in your own config file rather than
the managed layer is named and left alone.

## Opt out of `core`

The `core` namespace is auto-subscribed in every project, at the version matching the sous CLI you
are running, and seeded from inside the sous package so it works with no network. It carries the
skills that teach an agent what sous manages and why generated files must not be hand-edited. It is
an ordinary config entry, and `subscriptions: { core: { enabled: false } }` removes it.

`sous subscription remove core` writes exactly that into the managed subscriptions layer, because
there is no entry to delete: the one sous provides comes back on the next run, so only a recorded
opt-out outlives it. `sous subscription add core` clears it again, and disabling the `sous-recipes`
repository the same way switches off the auto-subscription with everything else that repository
provides. If you remove `core`, make sure something else tells your agents not to edit generated
files.

## Restore a fresh clone

A clone has the lockfile and the subscriptions, and no store. `sous build` restores what the
lockfile pins, with no prompts and no version drift, then compiles:

```term
$ sous build
▶ Restoring recipes:
  This project's lockfile pins recipes that are not in the store on this machine, so they are
    being fetched at exactly the versions it records.
    restored: workflow/qa-helper
    restored: workflow/qa-variables
```

If a variable the recipes need has no answer in the committed `.sous/.env` and none in the
environment, the build stops there with the message shown below.

## Freshness, always-pull, and the store

A build holds the versions the lockfile pins and does not talk to the network on every run. Sous
asks a repository for a newer index only when it has never asked, when the freshness window has
lapsed (`store.freshnessSeconds`, five minutes by default), or when a command forces it; a failed
check never breaks a build, because the cached index is used instead. Always-pull changes what
happens after that check, not how often it happens: a repository or subscription marked
`alwaysPull` takes a newer in-range version rather than the locked one. Set it per subscription
with `--always-pull`, or on either entry in the config.

The store is machine-wide and disposable, because everything in it is re-fetchable from a
lockfile's pins. `sous repo gc` collects it back to its size cap, evicting least recently used
entries first, and protects everything this project's lockfile pins whatever that does to the
total. The cap is `store.maxBytes`, one gigabyte by default; `--max-bytes 268435456` overrides it
for one run and `--dry-run` reports what would go.

## In CI, and for agents

Sous treats a run as non-interactive, and asks nothing at all, when any of these is true:

- `--non-interactive` is passed (every command that works on a project accepts it);
- the `CI` environment variable is set to anything but `0`, `false`, `no` or `off`;
- stdin or stdout is not a terminal, which is what piping or scripting looks like.

Such a run fails rather than guessing, naming both the question and the flag that answers it:

```term
$ CI=true sous subscription add quality/qa-pattern
  Error: Sous has to ask whether to go ahead with subscribing to 'quality/qa-pattern', and it is
    not running where it can ask.
    Why: the 'CI' environment variable is set to 'true'.
    Answer it ahead of time: pass '--yes' (spelled '-y', '--force' or '--trust' if you prefer) to
      accept the plan above without being asked.
```

An unanswered variable fails the same way, naming every environment variable that answers it, most
specific first:

```text
  Error: 1 variable still needs an answer, and there is no terminal to ask on.
    qaAgentName (workflow/qa-variables): What name should agents sign their review notes with?
      SOUS_VAR_WORKFLOW_QA_VARIABLES_QA_AGENT_NAME (recipe scope)
      SOUS_VAR_WORKFLOW_QA_AGENT_NAME (namespace scope)
      SOUS_VAR_QA_AGENT_NAME (shared scope)
```

So a pipeline or an agent needs three things and nothing else: `--yes` for the confirmations,
`--accept-first` for an ambiguous one-word ref, and either `--answer` or those environment
variables for the questions. The command's own help prints under the error, and both go to stderr.

## Where to go next

- [Recipe variables](repositories-variables.md): answers, the ladder, `sous vars`
- [Authoring a repository](repositories-authoring.md): publishing recipes of your own
- [Repository file formats](repositories-file-formats.md): every schema
- [Command reference](commands.md): every command and flag
