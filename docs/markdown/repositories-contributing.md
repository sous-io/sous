# Contributing a Recipe Change

This page takes you from "a recipe I use could be better" to "my project runs the released fix", for a recipe
published by someone else's repository. It is written for the person using the recipe, not the person who
maintains it; everything happens from inside your own project.

One command covers the lifecycle: `sous repo contribute` starts a contribution, and `sous repo contribute --finish`
ends it. Each step it takes is an ordinary sous command, named on this page, so you can also run the parts by
hand.

## Start

Name the repository, or any namespace or recipe it publishes:

```bash
sous repo contribute sous-recipes            # the repository itself
sous repo contribute workflow/task-files     # the repository that publishes this recipe
```

A namespace or recipe is resolved to the repository that publishes it, the same way every other command resolves
a reference; a name that matches in more than one trusted repository is a question, which `--accept-first`
answers by taking the first match.

Starting runs one step, `sous repo link <repo> --latest --generate-branch`:

- the repository is cloned into `.sous/repos/<owner>/<name>`, or the clone already there is reused;
- its default branch is brought up to upstream's (anything that would discard local work is listed and asked
  about first; `--yes` answers);
- a new branch named `sous/edit-<YYYYMMDD>-<HHMM>` is created from it, so the change never stacks on an old,
  already-merged branch;
- the project is pointed at the checkout, so builds read the repository from it instead of from a published
  version.

Name the branch yourself with `--create-branch <name>`, work on a branch that already exists with
`--branch <name>`, or start the new branch from another base with `--from <branch>`. `--global` links the
machine-wide checkout that every project on this machine shares. The link and its flags are described in full
under [Edit a repository in place](repositories-authoring.md#edit-a-repository-in-place).

`--dry-run` prints the step without running it.

## Edit, and see the change in your own build

Edit the recipe's files in the checkout the start step printed. While the repository is linked, every build in
your project reads its recipes from that checkout, so the next `sous build` shows your edit in your own agent's
files; there is nothing to publish first. Builds say the repository is linked every time, because a link
bypasses versions, the lockfile and freshness checks.

Commit your work on the branch as you go. What a proposal carries is commits.

## Propose the change

Finishing proposes whatever is not proposed yet, so you can go straight to [Finish](#finish). To open the proposal
now and keep working, run the submit step on its own:

```bash
sous repo submit sous-recipes --title "Clarify the resume steps" --body "The resume steps skipped the task file."
```

`sous repo submit` validates the repository, pushes the branch (through a fork on your own account when you
cannot push to the repository itself) and opens a pull request or merge request through the host's own command
line tool. Its body is your description followed by a changelog sous generates. Every step it takes is described
under [Contribute to someone else's repository](repositories-authoring.md#contribute-to-someone-elses-repository).

## Revise it

Review comments are answered with more commits on the same branch. Commit them, then run
`sous repo submit sous-recipes` again: it finds the open proposal for the branch and pushes the new commits into
it. A new `--title` or `--body` replaces the proposal's own. With nothing new to send, it reports where the
proposal stands (review, checks, and whether it can merge). `sous repo submit sous-recipes --status` only
reports.

## Finish

```bash
sous repo contribute sous-recipes --finish
```

Finishing first looks at the branch for work no proposal carries yet: uncommitted changes, commits that were never
pushed, or pushed commits with no open proposal behind them (that last one is looked up with the host's command
line tool). When it finds some, it asks whether to submit it; `--submit` or `--yes` submits without asking,
`--no-submit` finishes without submitting, and a run with no terminal fails naming those flags. When there is
nothing to submit, that part is skipped. The submit step passes `--title`, `--body`, `--draft`, `--commit` and
`--branch` through to `sous repo submit`.

Then it runs `sous repo unlink <repo> --update`:

- the project goes back to reading published versions, exactly the ones the lockfile pinned before the link;
- each pin the repository supplies moves to the newest published version its range allows;
- the project is rebuilt.

The checkout stays on disk, so an open proposal can still be revised from it later with `sous repo submit`. Pass
`--remove` to delete it as well; sous deletes only a checkout it cloned, and lists anything in it that exists
nowhere else before asking.

Every step prints as it runs, preceded by the command line that runs it. When a step fails, its own error comes
first, followed by the name of the step that failed and the steps that had already completed; nothing after the
failed step runs. `--dry-run` shows what finishing would do and runs none of it.

## Pick up the release

A contribution ships when the repository's maintainers merge it and the repository releases a new version. If
that happened before you finished, `--finish` already moved your pins to it. If it happens later, move them with

```bash
sous subscription update sous-recipes
```

which runs the same update `unlink --update` runs; with `--dry-run` it only shows what it would move. See
[Moving to newer versions](repositories-consuming.md#moving-to-newer-versions).

## What a contributor leaves alone

**Releases are the maintainers' business.** A contributor never runs `sous repo release`, and never edits
`sous.index.json`. The index is written by the repository's own release after a merge, from the manifests and the
tags; `sous repo submit` refuses a change that edits it, and says how to put it back.

**Versions depend on how the repository releases.** The release workflow `sous repo init` scaffolds, which
`sous-recipes` also runs, publishes on every merge to the default branch with `sous repo release --ci`, and that
raises no versions: the version a merge publishes is the one the merged change declares. A recipe whose files
changed while its `version` still equals its last release tag stops that release. So, unless the repository's
contribution guide says its maintainers raise versions themselves, raise the recipe's `version` in its
`sous.recipe.yaml` by hand as part of your change: a patch step for wording and fixes, a minor step for new files
or a new optional variable, and a major step for anything that breaks an existing subscriber (removing a file,
renaming a variable, or tightening a variable's validation). The changelog `sous repo submit` generates lists any
recipe your change touches without a version raise, so a missed one is visible in the proposal. The repository's
own guide is named by the `contribute` field of its `sous.repo.yaml`; for `sous-recipes` it is its
`CONTRIBUTING.md`.

**Core is edited in sous itself.** The `core` recipes in `sous-io/sous-recipes` are machine-written copies. Their
source is `recipes/core/sous-skills/` in `sous-io/sous`, and each sous release overwrites the copy, so an edit
merged into the copy would be lost. Their manifest says so with a
[`submissions`](repositories-file-formats.md#the-submissions-block) block: `sous repo submit` warns before
proposing a change that touches one and names where to send it instead, and the repository's own pull request
check refuses such a change. Propose core edits as a pull request to `sous-io/sous`.

## The commands this chains

| Part of the lifecycle | What `sous repo contribute` runs |
|-----------------------|----------------------------------|
| Start | `sous repo link <repo> --latest --generate-branch` (or the branch you named) |
| Propose, when finishing | `sous repo submit <repo>`, with the proposal flags passed through |
| Finish | `sous repo unlink <repo> --update`, plus `--remove` when given |

Every flag is listed in the [command reference](commands.md#sous-repo-contribute-ref).
