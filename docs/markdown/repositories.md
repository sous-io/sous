# Repositories

A **repository** publishes shared agent configuration that any project can subscribe to. It is
an ordinary git repository holding a few manifest files and some markdown, and sous reads it the
way a package manager reads a registry: an index says what exists, a project says what it wants,
and a lockfile records exactly what it got.

This page is the map: the vocabulary the system is built from, the official repository every
project starts with, how a single build fits them together, and where every file lands on disk.
The task-oriented guides are listed at the bottom.

## The vocabulary

### Repositories

A repository is the unit of distribution and the unit of trust; you add one to a project, and
everything else flows from that. Its root holds `sous.repo.yaml`, which names the repository,
describes its namespaces and lists where its recipes live.

```yaml
# sous.repo.yaml
formatVersion: 1
name: agent-recipes
namespaces:
  workflow:
    description: Recipes about how work moves through a project.
recipes:
  - recipes/workflow/task-files
```

### Namespaces

A namespace groups related recipes inside one repository. It is a plain name, it is never
versioned, and a project can subscribe to a whole namespace in one command.

```term
$ sous namespace list
▶ Namespaces in the repositories this project trusts:

  Namespace   Repository  Recipes  Subscribed  What it is
  ----------  ----------  -------  ----------  ------------------------------------------
  quality     qa                2  no          Recipes that exercise the edges.
  workflow    qa                2  no          Recipes about how work moves.
```

### Recipes

A recipe is the unit you subscribe to and the only thing that carries a version. It may hold
skills, memories, prompts, config layers and variable definitions in any mixture, and
subscribing to it gets all of them.

```yaml
# recipes/workflow/task-files/sous.recipe.yaml
formatVersion: 1
namespace: workflow
name: task-files
version: 1.0.2
contents:
  - kind: skills
    include:
      - skills/**/*.md
```

A recipe is named by a **ref**: `workflow` for a whole namespace, `workflow/task-files` for one
recipe, `workflow/task-files@^1.2.0` to constrain the version, and
`sous-recipes:workflow/task-files` when two trusted repositories publish the same ref and sous
needs to be told which one you meant. A one-word ref is a guess at a name, and sous works it out:
a namespace first, a recipe second, across every repository the project trusts. The full grammar
is in [Refs: how anything is named](repositories-file-formats.md#refs-how-anything-is-named).

### Subscriptions

A subscription is your project saying it wants a recipe or a namespace. It is recorded in a
config layer sous writes, `.sous/conf.d/510-subscriptions.jsonc`, so it is committed and travels
with the project.

```jsonc
{
  "subscriptions": {
    "workflow/task-files": {
      "addedAt": "2026-09-12T07:01:30.123Z",
      "addedBy": "user"
    }
  }
}
```

### Dependencies

A recipe manifest can declare two relationships to other recipes, and they differ in exactly one
respect: whose files end up in your project. `depends` fetches, pins and trust-gates the target
and makes it addressable while rendering, but keeps its files out of your output; `subscribes`
does all of that and lands the target's files in your project too, along with the variable
questions it publishes (see [Recipe variables](repositories-variables.md)).

```yaml
depends:
  - workflow/qa-helper                                       # a sibling in this repository
  - github://sous-io/sous-recipes/workflow/task-files@^1.0   # one in another repository
subscribes:
  - quality/code-review
```

Both name their targets by **location**, never by a short name a consuming project chose, and a
curated bundle is simply a recipe made mostly of `subscribes` entries. Because both lists are
declarative YAML rather than code, sous can read the whole dependency closure before fetching any
of it, which is what makes the trust decision answerable up front.

### The lockfile

`.sous/sous.lock.json` records the exact version, content hash and holder of everything the
project uses. It is committed, and a fresh clone rebuilds precisely what it describes.

```json
{
  "formatVersion": 1,
  "recipes": {
    "workflow/qa-helper": {
      "hash": "sha256-78660ab9889e707a38befd193ad565f7d76fbf017e049f1ae87372bb2c69698d",
      "kind": "subscribes",
      "repo": "qa",
      "requestedBy": ["project"],
      "version": "0.1.0"
    }
  },
  "repos": {
    "qa": { "identity": "localhost/home/me/projects/qa", "url": "/home/me/Projects/qa" }
  }
}
```

Restore decides nothing: it never resolves a range, never picks a newer version and never
prompts. Anything that would change what is installed changes the lockfile first, as a diff you
can read in review.

### The store

The store is one machine-wide cache of fetched recipes, at `~/.sous/cache`, keyed by the
repository's identity rather than by the short name any one project gave it. It is disposable:
every entry is re-fetchable from the pins in some project's lockfile, so deleting it costs a
download and nothing else.

```text
~/.sous/cache/github.com/sous-io/sous-recipes/core/sous-skills/0.2.0/
~/.sous/cache/_indexes/github.com/sous-io/sous-recipes.json
```

`sous repo gc` collects the store back to a size cap, least recently used first, never evicting
an entry the lockfile of the project you run it in still pins; entries another project pins may
go, because they are re-fetchable from that project's lockfile.

### Trust

Adding a repository **is** trusting it. There is no separate trust command and no
trusted-but-not-added state: until a repository is added, sous downloads nothing from it, not
even its index.

```term
$ sous repo add https://github.com/my-team/agent-recipes
// sous prints the repository, its location and what trusting it means
Do you trust this repository? (y/N)
```

Trusting a repository trusts every namespace and recipe in it, including recipes published later,
and it is the last gate before a recipe can run scripts on your machine; sous cannot tell you
whether one deserves that, and says so rather than implying otherwise. Where there is no terminal
to ask on, the run fails and names the repositories and the exact command that grants the trust:

```text
Error: One repository has to be trusted before this can continue, and sous is not
  running where it can ask.
  Why: the '--non-interactive' flag was passed.

  agent-recipes: https://github.com/my-team/agent-recipes
    agent-recipes (required by project)

  Trusting a repository trusts every namespace and recipe in it, and
  subscribing to something inside it can run scripts on this machine.
  Add each repository deliberately, with its URL:

    sous repo add https://github.com/my-team/agent-recipes --name agent-recipes --trust
```

!> Trust semantics do not soften for a repository already on your disk. A local path added
through the `local` provider goes through the same ceremony, because its recipes still run on
this machine.

## The official repository, and the built-in core

Sous publishes one official repository, [`sous-io/sous-recipes`](https://github.com/sous-io/sous-recipes).
Its namespaces are drawn from the canonical [skill categories](skill-categories.md), plus one
extra namespace called `core`.

`core` is the exception. It holds the skills that teach an agent what sous is, why generated files
must not be hand-edited and where the source of a managed file lives; without them an agent will
cheerfully edit a compiled `CLAUDE.md`. So the official repository is added and `core` is
subscribed in every project, pinned to the sous CLI version you are running, and its source ships
inside the package and seeds the store on first run, so a fresh install needs no network at all.

```term
$ sous subscription list
▶ Subscriptions:

  Subscription        Range        Pinned version            Origin    Enabled
  ------------------  -----------  ------------------------  --------  -------
  core                0.2.0        core/sous-skills 0.2.0    built in  yes
  workflow/qa-helper  any version  workflow/qa-helper 0.1.0  user      yes
```

Both wirings are ordinary config entries a person could have written by hand, and either can be
switched off: `sous subscription remove core` writes `subscriptions.core.enabled: false` for you,
and `sous subscription add core` clears it again. See
[Opt out of `core`](repositories-consuming.md#opt-out-of-core) for what you give up.

?> Subscribe to a whole namespace when it is one coherent set your team owns end to end. In the
official repository, prefer subscribing to recipes one at a time, so a recipe published later
does not arrive in your project unasked. `core` is the deliberate exception.

## One build, end to end

Four steps take a team repository from nothing to compiled skills.

**Add the repository**, which asks you to trust it and fetches its index, nothing more:

```term
$ sous repo add https://github.com/my-team/agent-recipes
▶ Adding a repository:
    Repository: agent-recipes
    Location  : https://github.com/my-team/agent-recipes
    Provider  : github
    Namespaces: quality, workflow
    Recipes   : 4
  This project now trusts 'agent-recipes'. Nothing from it has been installed.
```

**Subscribe to a recipe.** Sous resolves the dependency closure, shows what it will install,
asks about any repository a dependency needs that you have not trusted, records the subscription
and the pins, then builds:

```term
$ sous subscription add workflow/task-files
➔ What was installed:
  Recipe               Version  Repository     Why
  -------------------  -------  -------------  ----------------------
  workflow/task-files  1.0.2    agent-recipes  you subscribed to it
➔ Lockfile:
  Adding workflow/task-files version 1.0.2
```

**Answer the questions** the recipe publishes. A question is asked only when a subscribed recipe
needs a variable and no valid answer is already in scope, and the answers land in this project's
env files. See [Recipe variables](repositories-variables.md).

**Build.** Every later build reads the pins, restores anything missing from the store, then
compiles the recipe's files into your project's agent directories alongside your own templates:

```term
$ sous build
▶ Restoring recipes:
  This project's lockfile pins recipes that are not in the store on this machine,
    so they are being fetched at exactly the versions it records.
    restored: workflow/task-files
▶ Building:
▷ SKILL.tpl.md:
    Entry Point: ~/.sous/cache/github.com/my-team/agent-recipes/workflow/task-files/1.0.2/skills/start-task/SKILL.tpl.md
  ✓ /home/me/my-project/.claude/skills/start-task/SKILL.md (~1,996 tokens)
```

Skills default to `<project root>/.claude/skills`; every other content kind needs a destination in
the [`recipeOutputs`](repositories-file-formats.md#configuration-keys) block.

By default a build uses what the lockfile pins and does not talk to the network. Two things
change that: **always-pull**, which installs a newer in-range version whenever one exists, and
the **freshness window** (`store.freshnessSeconds`, five minutes by default), which decides how
often sous looks upstream at all. A failed check never breaks a build; the last good index stands
and the build says so. See
[Freshness, always-pull, and the store](repositories-consuming.md#freshness-always-pull-and-the-store).
A **linked** repository sits outside all of it: `sous repo link` points one repository's
resolution at a working copy on your machine, bypassing versions, the lockfile and freshness
checks, so every build announces it loudly. See
[Edit a repository in place](repositories-authoring.md#edit-a-repository-in-place).

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
`SOUS_DIR`, it does not decide which project is active, so it may be set in `.sous/.env.local` or
`.sous/.env` as well as in the shell.

The three files in the `500` to `599` band are written by sous, by key, so your comments and
formatting survive a write; you may edit them, and you may hand-write `repos:`, `subscriptions:`
and `varMappings:` in your primary config instead, which sous never touches. See
[Managed config layers](repositories-file-formats.md#managed-config-layers).

Every directory sous creates for its own bookkeeping explains itself: the first time it creates
one it writes a short `README.md` saying what the directory is, who writes to it, whether you may
edit it and whether it is committed, plus an `AGENTS.md` and a `CLAUDE.md` pointing at that
README. None is ever overwritten, and directories holding rendered output are left alone.

## Where to go next

- [Quickstart](repositories-quickstart.md): an empty project to a compiled skill, in order
- [Consuming recipes](repositories-consuming.md): adding, subscribing, building, removing
- [Authoring a repository](repositories-authoring.md): writing recipes, releasing, contributing
- [Recipe variables](repositories-variables.md): the resolution ladder and the question flow
- [Providers](repositories-providers.md): `github`, `gitlab` and `local`, and what each one can do
- [Repository file formats](repositories-file-formats.md): every manifest, index and schema
- [Command reference](commands.md): every command and flag
- [Troubleshooting](repositories-troubleshooting.md): what the errors mean and how to clear them
- [Skill categories](skill-categories.md): the category list the official repository uses
