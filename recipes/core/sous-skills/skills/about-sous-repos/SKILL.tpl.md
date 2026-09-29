---
name: about-sous-repos
description: >
  YOU MUST load this skill when working inside a sous recipe repository (one with a
  sous.repo.yaml at its root), adding a namespace or a recipe to one, running sous repo
  release, sous repo submit, sous repo link, sous repo contribute or sous repo init, or
  deciding what happens to a change when it is proposed, merged or released.
user-invocable: false
license: Apache-2.0
compatibility:
  - claude
  - codex
metadata:
  version: 1.0.0
  tags: [sous, recipes, repositories]
---

# About Sous Recipe Repositories

A **recipe** is a versioned bundle of agent instructions (skills, memories, prompts and config
layers) that sous installs into every project subscribed to it. A **recipe repository** is a git
repository that publishes recipes. It is not a sous project and needs no `.sous/` directory; the
commands that work on it (`sous repo release`, `sous repo submit`) run from anywhere inside it,
and find its root by walking up to the first directory holding a repo manifest.

Everything here holds for every recipe repository, the official `sous-io/sous-recipes` included.
For one recipe (its manifest, version, variables, contents and dependencies), YOU MUST load
`about-sous-recipes`.

## The Files

A recipe repository holds three kinds of file that sous reads:

- `sous.repo.yaml`, the **repo manifest**, written by hand: the repository's suggested short name,
  an optional description, its namespaces, and the list of recipe folders it publishes. A folder
  is a recipe because this list names it; a new recipe folder MUST be added to the list, or it is
  not published. Every recipe MUST belong to a namespace declared here.
- `sous.recipe.yaml`, one **recipe manifest** in each recipe folder; see `about-sous-recipes`.
- `sous.index.json`, the **index**: the catalog projects read, written only by `sous repo release`.
  NEVER edit it by hand.

Manifests are YAML (`.yaml`, `.yml`) or JSON (`.json`, `.jsonc`, both allowing comments and
trailing commas), never JavaScript: sous reads them before anyone has trusted the repository, so
nothing in them may run. Unknown keys are refused, except extension keys starting with `x-`. A
recipe folder MUST NOT contain a symbolic link; the release refuses one.

```yaml
formatVersion: 1
name: team-recipes
description: >-
  Review and release recipes for the Harbor Labs engineering team.
namespaces:
  review:
    description: Recipes about reviewing code.
recipes:
  - recipes/review/checklist
contribute: https://github.com/harbor-labs/team-recipes/blob/main/CONTRIBUTING.md
```

`contribute` is optional: a URL or a sentence saying how changes are sent, printed by
`sous repo submit` when the repository's host cannot open a proposal for the contributor.

## Versions, Tags and the Index

A recipe's version lives in its manifest, which is the source of truth. A version is **published**
once a git tag shaped `namespace/recipe@version` exists for it (for example
`review/checklist@1.2.0`). The index records each published version with its content hash, its
tag and the exact versions of its dependencies at release time; for the length of one release
commit it also records the version each manifest declares, whose tag that release cuts next. A
published version never changes: new files need a new version, and a release refuses to publish
different content under a version already tagged. A lost index is rebuilt from the tags.

## Releasing

`sous repo release` publishes. It refuses to run while anything is uncommitted, or while git
cannot say who is committing. In one run it:

1. validates every manifest;
2. finds the recipes whose files changed since the tag that last published them (a recipe never
   tagged is released at the version its manifest declares);
3. raises the version of each changed recipe whose version still equals that tag (a patch step by
   default; `--bump minor` or `--bump major` for more);
4. regenerates `sous.index.json`;
5. commits the manifests and the index together;
6. cuts one annotated tag per new version, dependencies first.

It prints that plan and asks once. `--yes` answers ahead, `--dry-run` stops after the plan, and
`--push` pushes the commit and the tags. `--namespace` and `--recipe` narrow the scope, and
`--include-unchanged` releases unchanged recipes too. On a branch other than the default one it
raises and commits but cuts no tags, because tags are cut after the merge; `--tag` overrides that.
Two presets matter most:

- `--check` only reads. It validates every manifest, reports how a merge would rewrite the index
  (as information, never as a failure), lists the versions that publish on merge, and fails a
  change to a recipe whose `submissions` block refuses proposals.
- `--ci` is for automation after a merge. It raises no versions, accepts the plan without asking,
  and fails on any changed recipe whose version still equals its last tag. It does NOT push; pass
  `--push` for that.

## What Happens to a Change

A repository made by `sous repo init` carries `.github/workflows/sous-release.yml`, which runs:

- on every pull request, `sous repo release --check`;
- on every push to `main`, `sous repo release --ci --push --yes`, which tags every version that has
  no tag yet, commits the regenerated index when it changed, and pushes both.

So a change to a recipe MUST raise that recipe's version in the pull request itself, by editing
`version` in its `sous.recipe.yaml`: after the merge, `--ci` refuses a recipe whose files changed
while its version stayed the same. A contributor NEVER runs `sous repo release` on a proposal
branch (`--check` and `--dry-run` excepted), because it commits a regenerated index and
`sous repo submit` refuses a change that edits the index.

Example: a contributor fixes a typo in `review/checklist`, which is at `1.2.0`, its last tag. The
pull request changes the skill file and sets `version: 1.2.1`; `--check` passes and lists
`review/checklist@1.2.1` as publishing on merge; after the merge, `--ci` regenerates the index,
commits it and cuts the tag `review/checklist@1.2.1`.

## Proposing a Change

`sous repo submit` proposes a change to a repository's maintainers and follows the proposal through
its life: it opens one, pushes new commits to an open one (replacing its title or description when
new ones are given), reports on one (`--status` only reports), or moves to a new branch once one
was merged. It runs in the repository's checkout, or from a project that links it (`sous repo
submit <repo>`). Run on the default branch, it first creates a branch named
`sous/submit-<date>-<time>`; `--branch` names another.

Before sending anything it checks that everything is committed (`--commit` commits it, after
listing the changes and asking once), validates the repository, and confirms the change leaves
`sous.index.json` alone. It pushes through a fork on the contributor's own account when the
contributor cannot push to the repository, and NEVER forces a push. The title and the description
come from the user (`--title` and `--body`, or asked); sous never borrows a commit message, and
adds a changelog it builds by comparing the manifests with the default branch.

Either manifest can carry a `submissions` block, for recipes whose files are copied in from
somewhere else; a recipe's own block wins over the repository's:

```yaml
submissions:
  allowed: false
  instead: Propose changes in harbor-labs/tooling, under recipes/review/.
```

`submit` warns, prints the `instead` text and asks before going on; `release --check` fails such
a pull request. The release itself is never restricted.

## Editing From a Project

`sous repo link <repo>`, run in a project, points that project at a working copy of the
repository, cloning it into `.sous/repos/<owner>/<name>` when needed (`--global` uses the
machine-wide checkout under the user-level sous directory), so an edit shows in the project's next
build with no release. A path in place of `<repo>` links that checkout where it is. A link never
changes a checkout on its own: `--branch`, `--create-branch` and `--generate-branch` choose the
branch, `--from` sets the base of a new one, and `--latest` brings it up to upstream after listing
anything that would be discarded.

`sous repo unlink <repo>` drops the link and goes back to the pinned versions; `--update` also
moves the pins to the newest released versions their ranges allow, and `--remove` deletes a
checkout sous cloned. `sous repo contribute <ref>` chains the three commands: it links on a new
branch (`sous/edit-<date>-<time>`), and with `--finish` it submits whatever no proposal carries
yet, then unlinks with `--update`.

## Creating a Repository

`sous repo init [dir]` writes a new recipe repository into the directory (the current one by
default): the repo manifest, an empty index, one example recipe with its manifest and a
placeholder skill, a README, `CONTRIBUTING.md`, `CLAUDE.md` and `AGENTS.md` for agents, the release
workflow and a `.gitignore`. `sous-io/sous-recipes` is the model a scaffold follows: a new repository
is as complete as it, minus its recipes. It does not run git: run `git init`, commit, and add a
remote before the first release, because `sous repo release` reads and writes tags. Every new recipe folder is then listed under `recipes` in `sous.repo.yaml`.

## Source for this Skill

This skill comes from the `core/sous-skills` recipe, installed by sous from a recipe
repository. It was compiled from a template, so edit the source, never this output file.

- Source Path: {{ sousTemplatePath }}
