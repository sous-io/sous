# Consuming Recipes

The task guide to using someone else's recipes. [Repositories](repositories.md) explains the model
and [Repository file formats](repositories-file-formats.md) holds every schema.

## Add a repository

Adding a repository is how you trust it, so it is the one step that asks a question, and what that
decision covers is [Trust](repositories.md#trust). Exactly one file is fetched, its
`sous.index.json`, which is all sous needs to resolve refs and list versions:

```term
$ sous repo add https://github.com/sous-io/sous-recipes
// the trust question, then one small download
▶ Adding a repository:
    Repository: sous-recipes
    Location  : https://github.com/sous-io/sous-recipes
    Provider  : github
    Namespaces: communication, core, tool-usage, workflow
    Recipes   : 6
  This project now trusts 'sous-recipes'. Nothing from it has been installed.
```

`--name` sets the short name refs will use (it defaults to the last segment of the URL; `sous repo
link` on a path instead takes the name that checkout's own manifest suggests, so see
[Edit a repository in place](repositories-authoring.md#edit-a-repository-in-place) before you name
the same repository twice), and
`--provider github|gitlab|local` names the [provider](repositories-providers.md#how-a-url-is-matched)
for a host the URL does not give away. `--dry-run` prints what would change without trusting or
fetching anything, and `-y` accepts trust without being asked; its other spellings are under
[Flags that answer questions](commands.md#flags-that-answer-questions). The entry lands in the
committed `.sous/conf.d/500-repos.jsonc`, so colleagues inherit the repository and the trust
decision with it; sous edits that file by key, so your comments and key order survive.

A repository need not be hosted: `sous repo add ../my-recipes --name my-recipes` reads a path
through the built-in `local` provider, which resolves it against your working directory and stores
the absolute form; [The local provider](repositories-providers.md#the-local-provider) covers how it
reads the working tree and honors a version's tag.

!> A local path goes through the same trust question as a hosted one; see
[Trust](repositories.md#trust). To edit a repository you already subscribe to, use
[`sous repo link`](repositories-authoring.md#edit-a-repository-in-place).

## Find a recipe

These commands read the cached indexes and the lockfile; all work offline and download nothing:

```bash
sous search qa                 # names and descriptions everywhere; --limit defaults to 25
sous namespace list            # every namespace, its recipe count, whether you subscribe
sous namespace show workflow   # one namespace and the recipes in it
sous recipe list               # every recipe, latest version, pinned version, subscribed
```

Read `sous recipe show` before subscribing: every published version, what it depends on (as
declared, beside the version the index resolved it to), and its questions and files once it has
them here.

```term
$ sous recipe show workflow/qa-variables
    Latest version : 0.1.0
    Pinned version : this project pins none
    Subscribed     : no
  Dependency          Declared as                     Resolved to  Repository       Kind
  ------------------  ------------------------------  -----------  ---------------  ----------------
  workflow/qa-helper  not declared in the manifest    0.1.0        this repository  unknown
  The recipe's own files are not on this machine, so the questions it asks and the files it
    publishes are not known here. Subscribing to it fetches them.
```

## Subscribe to a recipe

```bash
sous subscription add workflow/qa-variables
sous subscription add workflow/qa-variables@^1.2.0
sous subscription add workflow          # a whole namespace
```

The whole dependency closure resolves before anything is downloaded, and only then is anything
written; an install is whole or not at all.

| Flag | What it does |
|------|--------------|
| `-y, --yes` | Answer yes to both questions this command can ask: the subscribe confirmation, and the trust question for a repository it has to add |
| `--accept-first` | When a one-word ref matches several things, take the first one listed |
| `--answer <name>=<value>` | Answer one question ahead of time. Repeat it per answer, or read a whole file of them with `--answers-file <path>` |
| `--always-pull` | Install a newer in-range version whenever one exists, rather than holding the locked one |
| `--dry-run` | Print what would be installed, writing and downloading nothing |
| `--no-build` | Record the subscription without rebuilding the project |
| `--prerelease` | Let prerelease versions take part in version range matching |
| `--non-interactive` | Never ask; fail instead, naming the flag that would have answered |

?> `sous subscribe` and `sous unsubscribe` are accepted spellings of these two commands, and every
topic answers to both spellings of its name (`sous subscriptions add`, `sous repos list`).

### One-word refs

A bare word is looked for as a repository, a namespace and a recipe name across every cached index,
so you need not remember which namespace a recipe lives in. A single match is announced
(`Resolved to: qa-recipes:quality/qa-pattern`); a word matching nothing is an error naming every
repository searched. When it means more than one thing, sous lists every candidate as a full ref
and asks which you meant. That order is the contract, because `--accept-first` takes the first one:
candidates sort by how qualified the matching spelling was, then by kind (repository, namespace,
recipe, variable, environment variable), then by repository in search order, then alphabetically.

### The plan, and the confirmation

Sous says what it will do and asks first; nothing is downloaded or written until you answer.

```term
$ sous subscription add workflow/qa-variables
  Subscribing to 'workflow/qa-variables' installs the recipe 'qa-variables' from the namespace
    'workflow'.
  Here is what that does:

  • The files it ships are compiled into this project on the next build, which writes them
    into this project's agent directories.
  • Any scripts it ships can be run on this machine when an agent uses them. Sous does not
    run them itself, and it cannot vouch for what they do.
// two more bullets: the variables it publishes are asked about at the end of the command and
// written into this project's env files, and its dependencies are pinned in the lockfile
  • If a dependency turns out to live in a repository this project does not trust, sous stops
    and asks about that repository by name before fetching anything from it.
? Proceed? (y/N) y
  Recipe                 Version  Repository  Why
  ---------------------  -------  ----------  ------------------------------------------------------
  workflow/qa-helper     0.1.0    qa-recipes  needed by workflow/qa-variables
  workflow/qa-variables  0.1.0    qa-recipes  you subscribed to it
```

Answering no ends the command with nothing downloaded and no change to your config. Three things
change when you say yes: `.sous/conf.d/510-subscriptions.jsonc` records the subscription,
`.sous/sous.lock.json` records the exact versions and hashes, and the machine-wide store under
`~/.sous/cache` gains the files (the first two are committed; the store is not). It then builds, so
the new skills are on disk when it returns; `--no-build` defers that, and a failed build keeps it.

?> Only a recipe a manifest lists under `subscribes` contributes files; one listed under `depends`,
like `workflow/qa-helper` above, is fetched and pinned but stays out of your output. See
[Dependencies](repositories.md#dependencies).

## Choose where the files land

Recipe files compile the way one of your own `entryGlob` targets does, under the
[`.tpl.` convention](configuration.md#templates-and-the-tpl-convention): a file with `.tpl.` in its
name is rendered through LiquidJS and loses `.tpl.` on the way out, and anything else is copied
verbatim. Where each content kind lands is your project's decision, under the
[`recipeOutputs`](repositories-file-formats.md#recipeoutputs-where-the-files-land) config key, which takes a list of
directories for each of `skills`, `memories` and `prompts`; for example
`recipeOutputs: { skills: ["${projectRoot}/.claude/skills", "${projectRoot}/.codex/skills"] }`.
Only `skills` has a default, `<project root>/.claude/skills`, because that is where every agent
looks; a kind with no destination is skipped and the build says so once, naming the key. Recipe
outputs are tracked like every other file sous writes, so `sous prune` removes what an unsubscribed
recipe used to write and `sous clear` removes all of it; neither reaches into a linked checkout.

## Answer the questions

A recipe publishes variable definitions; you supply answers. Subscribing asks whatever is
unanswered, reports whatever it inherited from an answer already in scope, and never re-asks
something that already fits. [Recipe variables](repositories-variables.md#answer-the-questions)
covers the question screen, the advanced view and the ladder; what follows is what a subscribe
needs.

### Answering questions ahead of time

List the questions with a dry run, which installs nothing, then supply them all in one command:

```bash
sous subscription add workflow/qa-variables --dry-run --non-interactive
sous subscription add workflow/qa-variables --yes --answer qaAgentName=QA \
  --answer qaReviewDepth=thorough
```

Every answer is checked before anything is installed, so a run stores all of them or none:

```text
  Error: The answer given for 'qaReviewDepth' does not fit the definition workflow/qa-variables
    publishes.
    qaReviewDepth must be one of: light, standard, thorough.
    For example: thorough
    The answer given with --answer <name>=<value> was: deep
    Nothing was written; fix the answer and run the command again.
```

A name no recipe declares fails the run and lists every variable in play, so a typo cannot become a
stored value nothing reads. Names are camelCase, as the recipe declares them; the full
`namespace/recipe.name` key works too when two recipes publish the same name, and everything after
the first `=` is the answer. `--answers-file answers.yaml` reads a YAML or JSON file of them.

?> A dry run downloads nothing, so a recipe your machine does not hold yet has no manifest to read
and its questions cannot be listed; the run still succeeds and names them.

## See what you have

```term
$ sous subscription list
  Subscription           Range        Pinned version                               Origin    Enabled
  ---------------------  -----------  -------------------------------------------  --------  -------
  core                   0.2.0        core/sous-skills 0.2.0                       built in  yes
  workflow/qa-variables  any version  workflow/qa-variables 0.1.0                  user      yes
```

A namespace subscription names every recipe it holds, each with the version the lockfile pins. A
subscription that has never been built has nothing pinned yet, and its cell reads `pinned on first
build` instead.

`sous repo list` shows each trusted repository with its provider, origin, whether it is linked, its
recipe count and its URL; `--verbose` adds a `Namespaces:` line under each row. `sous lock show`
prints the other half: every version your lockfile pins, where it came from and who holds it. When
that file has drifted, `sous lock rebuild` recomputes it from your subscriptions.

## Remove a subscription

`sous subscription remove workflow/qa-variables` takes `--dry-run` and `--no-build` too, and it
removes only what that subscription alone brought in. Anything another subscription or recipe still
needs stays, under a `What stayed, and why` heading naming each recipe and what holds it. Like
adding one, it finishes by building, so the files it used to write are pruned before it returns.

### Stop trusting a repository

Removing a repository withdraws the trust that adding it granted, and everything held through it
goes too. Before writing anything, the command says exactly what that means here:

```term
$ sous repo remove qa-recipes --dry-run
  The entry for 'qa-recipes' at https://github.com/example/qa-recipes is removed from this
  project's repositories layer, so sous stops reading anything from it.
  Here is what goes with it:
    One subscription resolves into it and is removed: workflow/qa-variables.
    2 locked recipes are held only through those subscriptions, and they leave the lockfile:
      workflow/qa-helper, workflow/qa-variables.
    2 files those recipes compiled are pruned by the build that follows:
      .claude/skills/qa-variables/SKILL.md
      .claude/skills/qa-variables/references/note-template.md
```

Then it asks once, and `--yes` answers ahead for a run with no terminal. Each subscription is
checked the same way, so a recipe something else still needs stays and is reported with whoever
holds it. A link is removed but its checkout stays on disk, and a subscription written in your own
config file rather than the managed layer is named and left alone.

## Opt out of `core`

The `core` subscription is an ordinary config entry, explained under
[the built-in core](repositories.md#the-official-repository-and-the-built-in-core); writing
`subscriptions: { core: { enabled: false } }` into your config removes it.

`sous subscription remove core` writes exactly that into the managed subscriptions layer, because
there is no entry to delete: the one sous provides comes back on the next run, so only a recorded
opt-out outlives it. `sous subscription add core` clears it again. If you remove `core`, make sure
something else tells your agents not to edit generated files.

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

A variable with no answer in the committed `.sous/.env` and none in the environment renders empty
rather than stopping the build; run `sous vars ask` from a terminal to fill it in.

## Control freshness and the store

A build holds the versions the lockfile pins and does not talk to the network on every run. Sous
asks a repository for a newer index only when it has never asked, when the freshness window has
lapsed (`store.freshnessSeconds`, five minutes by default), or when a command forces it; a failed
check never breaks a build, because the cached index is used instead. Always-pull changes what
happens after that check, not how often it happens: a repository or subscription marked
`alwaysPull` takes a newer in-range version rather than the locked one; set it with
`--always-pull`, or on either entry in the config.

The store is machine-wide and disposable, because everything in it is re-fetchable from a
lockfile's pins. `sous repo gc` collects it back to its size cap, evicting least recently used
entries first, and protects everything this project's lockfile pins whatever that does to the
total. The cap is `store.maxBytes`, one gigabyte by default; `--max-bytes 268435456` (256
megabytes) overrides it for one run, and `--dry-run` reports what would go.

## Run sous in CI, or from an agent

### When sous cannot ask

Sous treats a run as non-interactive, and asks nothing at all, when any of these is true:

- `--non-interactive` is passed (every command that works on a project accepts it);
- the `CI` environment variable is set to anything but an empty value, `0`, `false`, `no` or `off`
  (case and surrounding spaces are ignored);
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

An unanswered variable fails the same way, naming every environment variable that answers it:

```text
  Error: One variable still needs an answer, and there is no terminal to ask on.
  Set one of the environment variables listed under each variable, or run
  'sous vars ask' from a terminal.
    qaAgentName (workflow/qa-variables): What name should agents sign their review notes with?
      SOUS_VAR_WORKFLOW_QA_VARIABLES_QA_AGENT_NAME (recipe scope)
      SOUS_VAR_WORKFLOW_QA_AGENT_NAME (namespace scope)
      SOUS_VAR_QA_AGENT_NAME (shared scope)
```

So a pipeline or an agent needs three things and nothing else: `--yes` for the confirmations,
`--accept-first` for an ambiguous one-word ref, and either `--answer` or those environment
variables. The command's help prints under the error, on stderr, and the error itself on stdout.

## Where to go next

- [Troubleshooting](repositories-troubleshooting.md): what a failed add, subscribe or build is
  telling you
- [Recipe variables](repositories-variables.md): answers, the ladder, `sous vars`
- [Providers](repositories-providers.md): how a URL is matched, and reading a path on this machine
- [Authoring a repository](repositories-authoring.md): publishing recipes of your own
- [Repository file formats](repositories-file-formats.md): every schema
- [Command reference](commands.md): every command and flag
