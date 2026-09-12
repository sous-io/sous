# Repositories Quickstart

Ten minutes, twelve commands, from an empty directory to a project whose agent skills come from
the official repository and from a repository you wrote yourself, with a lockfile a colleague can
restore from.

This page is the guided tour; [Repositories](repositories.md) explains the model behind it, and
[Consuming recipes](repositories-consuming.md) and
[Authoring a repository](repositories-authoring.md) are the reference guides for each half. You
need sous on your path (`npm install -g @sous-io/sous`), git, and a network connection for the two
steps that reach GitHub. Output below is trimmed: sous prints absolute paths and a banner that are
left out here.

## 1. Create a project

A sous project is a directory with a `.sous/` directory in it holding one config file. One line is
a valid config:

```bash
mkdir -p ~/projects/my-project/.sous
cd ~/projects/my-project
echo 'name: my-project' > .sous/sous.config.yaml
```

Everything else has a default: skills compile into `<project root>/.claude/skills`, and the
lockfile, the state file and the config layers sous writes land under `.sous/`. See
[The config file](configuration.md) for the keys you will want later.

## 2. Build once

```term
$ sous build
▶ Locking subscribed recipes:
    pinned: core/sous-skills at version 0.2.0.
  The lockfile has been updated. Commit it, so everyone building this project
    gets exactly these versions.
▶ Building:
  ✓ .claude/skills/about-sous/SKILL.md (~782 tokens)
  ✓ .claude/skills/about-agent-skills/SKILL.md (~1,937 tokens)
✓ Done.
```

You subscribed to nothing and five skills appeared. That is the `core` namespace, which every
project is auto-subscribed to at the version matching the CLI you are running. It carries the
skills that teach an agent what sous manages and why it must not hand-edit a generated file.

?> `core` ships inside the sous package and seeds the machine-wide store on first run, so this
step works with no network at all. It is an ordinary subscription and
[one line switches it off](repositories-consuming.md#opt-out-of-core).

## 3. See what is on offer

```bash
sous recipe list
```

```text
  Recipe                      Repository    Latest  Pinned  Subscribed  What it is
  --------------------------  ------------  ------  ------  ----------  ------------------
  communication/control-flow  sous-recipes  1.0.0           no          Generic interaction
  core/sous-skills            sous-recipes  0.2.0   0.2.0   yes         The skills that
  workflow/task-files         sous-recipes  1.0.2           no          Per-branch task
```

This reads the cached index of every repository the project trusts, so it works offline and
downloads nothing. The official repository, `sous-recipes`, is trusted out of the box.

Before subscribing to something, read it:

```bash
sous recipe show workflow/task-files
```

```text
    Repository     : sous-recipes
    Latest version : 1.0.2
    Subscribed     : no

➔ What it asks you:
  Variable         Type    Environment variable  Required  What it asks
  ---------------  ------  --------------------  --------  --------------------------------
  taskFileRoot     path    TASK_FILE_ROOT        yes       Where should task files be stored?
  ticketIdExample  string  TICKET_ID_EXAMPLE     yes       What does one of your ticket IDs
```

The full output also lists every published version and every dependency, each declared range shown
beside the exact version the index resolved it to.

## 4. Subscribe to a recipe

```bash
sous subscription add workflow/task-files
```

Sous states what subscribing does, asks once, resolves the whole dependency closure, downloads it,
then asks the questions the recipe publishes. Answering the confirmation and the two questions:

```text
➔ What was installed:
  Recipe                         Version  Repository    Why
  -----------------------------  -------  ------------  --------------------------
  workflow/sub-agent-delegation  1.0.0    sous-recipes  needed by workflow/task-files
  workflow/task-files            1.0.2    sous-recipes  you subscribed to it

➔ Variables:
  Answers stored:
      taskFileRoot       : .sous/tasks TASK_FILE_ROOT in .env
      ticketIdExample    : PROJ-1234 TICKET_ID_EXAMPLE in .env

  Left unanswered:
      ticketPrefix       : no answer yet, and this variable is optional
```

A script, a pipeline or a coding agent has no terminal to answer on, so it passes the answers in:

```bash
sous subscription add workflow/task-files --yes \
  --answer taskFileRoot=.sous/tasks \
  --answer ticketIdExample=PROJ-1234
```

The answers land in `.sous/.env`, which is committed; a definition marked secret goes to the
gitignored `.sous/.env.local`. [Recipe variables](repositories-variables.md) covers the rest.

## 5. Look at what landed

`sous subscription add` finishes by building, so the files are already on disk. `ls .claude/skills`
now lists the five `core` skills plus the seven this recipe ships, among them `about-task-files`,
`start-task` and `resume-task`. The build dependency contributes nothing: a recipe held through
`depends` is fetched and pinned, and its files stay out of your output.

Recipe files compile the way your own targets do, including the
[`.tpl.` convention](configuration.md), and are tracked like every other file sous writes, so
`sous prune` removes them when you unsubscribe. Where each kind lands is your project's decision,
under [`recipeOutputs`](repositories-file-formats.md#recipeoutputs-where-the-files-land).

## 6. Start a repository of your own

A recipe repository is not a sous project; it has no `.sous/` directory, and the three commands
that work inside one do not look for a config. Run this outside your project:

```bash
sous repo init ~/projects/my-recipes --name my-recipes --namespace workflow
```

```text
▶ Creating a recipe repository:
  wrote sous.repo.yaml
  wrote sous.index.json
  wrote recipes/workflow/example/sous.recipe.yaml
  wrote recipes/workflow/example/skills/example-skill/SKILL.md
  wrote README.md
  wrote .github/workflows/sous-release.yml
  wrote .gitignore
```

The scaffold validates as written, and every file it leaves is heavily commented. `sous.repo.yaml`
declares the namespaces and lists every recipe folder; each folder's `sous.recipe.yaml` is one
recipe, with its own version.

## 7. Put something in the recipe

Edit `recipes/workflow/example/skills/example-skill/SKILL.md` into a real skill, then name the
recipe in its manifest:

```yaml
formatVersion: 1
namespace: workflow
name: example
version: 0.1.0
description: One paragraph saying what a project gets by subscribing to it.

contents:
  - kind: skills
    include:
      - skills/**/*.md
```

`contents` is what a subscriber receives, one group per kind (`skills`, `memories`, `prompts` or
`config`), each with globs relative to the recipe folder. Copying the folder is how you start a
second recipe; its path goes in the `recipes` list at the root.

## 8. Release it

Releasing reads versions from the recipe manifests, regenerates the index, commits and tags, so
the repository has to be a git repository with your work committed:

```bash
cd ~/projects/my-recipes
git init -b main . && git add -A && git commit -m "First recipe"
sous repo release
```

```text
▶ Publishing:
  workflow/example: publishing version 0.1.0.
  Wrote sous.index.json.
  Committed: Release workflow/example@0.1.0
  Created the tag workflow/example@0.1.0.
```

Add `--push` to push the commit and the tags in the same run. Never edit `sous.index.json` by
hand; the recipe manifests are the source of truth for versions, and this command regenerates the
catalog from them. `sous repo release --check` validates without publishing, which is what the
scaffolded GitHub Actions workflow runs on a pull request.

## 9. Add your repository to the project

Adding a repository is how you trust it, so this is the step that asks a question. A path works
as well as a URL; sous reads a path through the built-in `local` provider:

```term
$ cd ~/projects/my-project
$ sous repo add ../my-recipes --name my-recipes
One repository has to be trusted before this can continue.
  my-recipes
    Location: /home/you/projects/my-recipes
    Required: my-recipes (required by this project)
// then what trusting means, and the question
? Do you trust this repository? (y/N) y
    Repository: my-recipes
    Provider  : local
    Namespaces: workflow
    Recipes   : 1
  This project now trusts 'my-recipes'. Nothing from it has been installed.
```

One file is fetched, the repository's `sous.index.json`, and nothing is installed. The entry lands
in `.sous/conf.d/500-repos.jsonc`, which is committed, so a colleague inherits the repository and
the trust decision together.

!> A repository on your own disk goes through the same question as a hosted one; its recipes still
run on this machine. A local path is machine-specific, so a colleague cloning your project needs
that path to exist, or needs the repository pushed somewhere they can reach. To edit a repository
your project already subscribes to, use
[`sous repo link`](repositories-authoring.md#edit-a-repository-in-place) instead.

## 10. Subscribe to your own recipe

```bash
sous subscription add workflow/example
```

```text
➔ What was installed:
  Recipe            Version  Repository  Why
  ----------------  -------  ----------  --------------------
  workflow/example  0.1.0    my-recipes  you subscribed to it
```

Your skill is now in `.claude/skills/` beside the ones from the official repository. Nothing about
a recipe's files is special once they are on disk, and nothing distinguishes yours from anyone
else's.

## 11. Commit the lockfile

```bash
sous subscription list
```

```text
  Subscription         Range        Pinned version             Origin    Enabled
  -------------------  -----------  -------------------------  --------  -------
  core                 0.2.0        core/sous-skills 0.2.0     built in  yes
  workflow/example     any version  workflow/example 0.1.0     user      yes
  workflow/task-files  any version  workflow/task-files 1.0.2  user      yes
```

Five files carry all of that, and all five are committed:

| File | Holds |
|------|-------|
| `.sous/sous.config.yaml` | your project's own config |
| `.sous/sous.lock.json` | the exact version and content hash of every recipe in use |
| `.sous/conf.d/500-repos.jsonc` | the repositories the project trusts |
| `.sous/conf.d/510-subscriptions.jsonc` | what the project subscribes to |
| `.sous/.env` | the answers to the recipes' questions, minus the secret ones |

Gitignore the rest: `.claude/` and any other compiled output, `.sous/sous.state.json`, and the
secrets file `.sous/.env.local`. The store on your machine is not in the project at all.

```bash
git add .sous && git commit -m "Subscribe to task-files and my own example recipe"
```

## 12. Restore on a second machine

A clone has the lockfile and the subscriptions and no store at all. `sous build` restores exactly
what the lockfile pins, asking nothing:

```term
$ git clone git@github.com:my-team/my-project.git
>> 100%
$ cd my-project
$ sous build
▶ Restoring recipes:
  This project's lockfile pins recipes that are not in the store on this machine,
    so they are being fetched at exactly the versions it records.
    restored: workflow/example
    restored: workflow/sub-agent-delegation
    restored: workflow/task-files
▶ Building:
  ✓ .claude/skills/about-task-files/SKILL.md (~942 tokens)
✓ Done.
```

Restore decides nothing: it never resolves a range, never picks a newer version and never prompts.
Anything that would change what is installed changes the lockfile first, as a diff you can read in
review.

?> The store those recipes were restored into, `~/.sous/cache`, is machine-wide and disposable;
everything in it is re-fetchable from a lockfile pin. `SOUS_HOME` moves it, which is how a
throwaway walkthrough like this one keeps its own.

## Where to go next

- [Consuming recipes](repositories-consuming.md): dry runs, one-word refs, removal, `repo gc`
- [Authoring a repository](repositories-authoring.md): variables, editing in place, contributing
- [Recipe variables](repositories-variables.md): the resolution ladder and the `sous vars` commands
- [Repositories](repositories.md): trust, providers, freshness, and what lives where
