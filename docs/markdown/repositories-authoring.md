# Authoring a Repository

The guide to publishing recipes of your own: creating a repository, writing a recipe, declaring the variables it
needs, cutting a release, editing a published repository in place, and proposing a change to somebody else's.
[Repository file formats](repositories-file-formats.md) holds the schemas; this page is the workflow.

?> A recipe repository is not a sous project. It has no `.sous/` directory, and `sous repo init`, `sous repo
release` and `sous repo submit` do not look for one. Run them from inside the repository itself.

## Create a repository

```term
$ sous repo init ./my-recipes --name my-recipes --namespace workflow
▶ Creating a recipe repository:

  wrote sous.repo.yaml
  wrote sous.index.json
  wrote recipes/workflow/example/sous.recipe.yaml
  wrote recipes/workflow/example/skills/example-skill/SKILL.md
  wrote README.md
  wrote .github/workflows/sous-release.yml
  wrote .gitignore
```

`--name` is the repository's short name (default: the directory's own name), `--namespace` the one namespace to
declare (default: the repository's name), `--force` overwrites a repository that already exists, and `--dry-run`
lists the files without writing them. The command asks nothing, and names are lowercase kebab-case, so `My-Recipes`
yields `my-recipes`. Every file is read back through the schemas sous uses on published repositories, so the
scaffold validates. The scaffold is files only: run `git init`, commit it, and add the remote you publish from
before releasing, since `sous repo release` reads and writes tags and fails in a directory git does not track.

?> `repo init --force` means overwrite, not "answer yes". It is unrelated to the confirmation flag other
commands spell `--yes`, `-y`, `--force` or `--trust`.

`sous.repo.yaml` says what the repository publishes, `sous.index.json` is the catalog that `sous repo release`
writes, and each recipe folder carries one `sous.recipe.yaml` beside the files it contributes. Nothing else is
fixed: recipe folders may live anywhere, and what makes a folder a recipe is that `sous.repo.yaml` lists its
path under `recipes`. Both hand-written manifests are YAML or JSON and never JavaScript, because a repository's
trust story rests on being readable without running any of its code.

## Write a recipe

Copy the example folder, edit its manifest, and add its path to the `recipes` list in `sous.repo.yaml`, which is a
plain list of folder paths (`recipes:`, then `- recipes/workflow/task-files` under it):

```yaml
formatVersion: 1
namespace: workflow
name: task-files
version: 0.1.0
description: >-
  Per-branch task files, with skills for starting and resuming work.
contents:
  - kind: skills
    include:
      - skills/**/*.md
```

`contents` groups are what a subscribing project receives, one group per kind, each with `include` glob patterns
relative to the recipe folder (and optional `exclude` patterns). The four kinds are `skills`, `memories`,
`prompts` and `config`; the kind decides where files land, which the subscriber maps with
[`recipeOutputs`](repositories-file-formats.md#configuration-keys). Field tables are in the
[recipe manifest](repositories-file-formats.md#sousrecipeyaml-the-recipe-manifest) reference, and recipe
metadata is the source of truth for the version: never edit `sous.index.json` by hand.

A recipe's files compile exactly the way a project's own `entryGlob` target does, so the `.tpl.` convention applies
unchanged inside a recipe: `note.tpl.md` is rendered through LiquidJS and lands as `note.md`, and a file without
`.tpl.` in its name is copied verbatim. A template may include a file from a recipe it depends on through the
reserved `~` sigil, naming the dependency's published identity then the path inside it, as in
`@~workflow/qa-helper/_partials/review-steps.md` on a line of its own. The `~` is required: a bare `@path` is
always a relative path or a declared alias, so an include line can never quietly stop meaning a file on disk.
Inside a recipe, `~<namespace>` resolves only against that recipe's own `depends` and `subscribes` at their pinned
versions, and the path after the recipe name may not be absolute or contain `.` or `..` segments.

## Declare the variables a recipe needs

A recipe that needs a value from the project asks through a **definition**: a published specification, never a
value. Sous asks the question only when a subscribed recipe needs the variable and no valid answer is in scope.

```yaml
variables:
  - name: qaTaskRoot
    type: path
    prompt: Where should the review notes be stored?
    description: >-
      This recipe writes one review note per branch, and this setting is the
      directory those notes are read from and written to. The default keeps them
      inside the project's .sous directory, which git already partly ignores.
      Any local path works, relative to the project root or absolute.
    example: ~/qa-notes
    default: .sous/qa-notes
    required: true
    scope: shared

  - name: qaServiceToken
    type: string
    env: QA_SERVICE_TOKEN
    prompt: What is this project's review service token?
    description: >-
      The review service is called once per run and authenticates with a token
      issued per project. There is no default, because a token belongs to one
      person on one machine; create one under Settings, then Tokens.
    example: qa_0123456789abcdef0123
    secret: true
    scope: local
    validate:
      minLength: 20
```

- **`name` is camelCase**, and it is how templates refer to the variable. `type` is `string`, `number`,
  `boolean`, `enum`, `path` or `url`. `required` defaults to true.
- **A description explains, a prompt asks.** Both `description` and `example` are required, and a manifest missing
  either is refused. Write the description in full sentences: what the setting is for, what the default does, and
  what else is acceptable; write the prompt as one plain question. It is also what `sous vars show <name>` prints.
- **An example is documentation, a default is a value.** Sous never stores an example and never offers it as
  the answer; it only shows it beside the question. Use `default` for a value a project should actually start
  with, and put the same text in both only when the sample answer is the right starting value.
- **`env` is the environment variable** an answer binds to. Omit it and the answer binds to the shared rung of
  the resolution ladder, derived from the name: `apiUrl` becomes `SOUS_VAR_API_URL`. Name it explicitly to reuse
  a value the environment already carries, such as `GITHUB_TOKEN`; `x-intentional: true` then silences the
  release warning about claiming a well-known name (`PATH`, `HOME`, `USER`, `SHELL`, `GITHUB_TOKEN`,
  `GITLAB_TOKEN`, `NPM_TOKEN`, or anything starting `AWS_` or `SOUS_`, except the `SOUS_VAR_` names sous
  derives itself). Two definitions of the same name may share one variable; two of **different** names
  claiming the same one is an error.
- **`secret: true`** hides the value everywhere sous prints it, and **`scope`** picks the file the answer is
  written to: `shared` for the committed `.sous/.env`, `local` for the gitignored `.sous/.env.local`. A secret
  is always stored locally, so a secret declared `shared` is rejected.
- **`validate`** carries `pattern`, `minLength`, `maxLength`, `min`, `max` and `enum`. A published `pattern` runs on
  a worker under a time budget, so one that backtracks forever fails validation rather than hanging the person
  answering, and the message names your pattern. Within a major version a schema may only LOOSEN: tightening a
  constraint is a major bump, and an upgrade re-validates stored answers, re-prompting only where an old one no
  longer fits.
- **Further reading:** [Recipe variables](repositories-variables.md) covers how an answer is found at build
  time; [Variable definitions](repositories-file-formats.md#variable-definitions) is the full field table.

## Declare dependencies and co-subscriptions

`depends` fetches and pins a recipe whose files stay OUT of a subscriber's output but are addressable from your
own templates. `subscribes` is a co-subscription: its questions run and its files DO enter the output, which is
how a curated bundle is built. Both hold plain strings naming their target by where it lives.

```yaml
depends:
  - workflow/qa-helper                                       # a sibling, released alongside me
  - workflow/qa-helper@^1.1                                  # a sibling with a range; uncommon
  - github://sous-io/sous-recipes/workflow/sat@^1.0          # another repository
  - gitlab://gitlab.example.com/group/subgroup/proj/qa/lint  # a self-hosted host, with subgroups
subscribes:
  - quality/code-review                                      # co-subscribed: its files land too
```

A **bare ref** is a sibling in this repository; with no range it means "the version released alongside me", since
one run cuts both tags and records the exact version in the index. A **locator URL** names another repository,
and its last two segments are always the namespace and the recipe, which is the recipe's published **identity and
never a path on disk**: a recipe stored at `recipes/shared/sat/` and published as `workflow/sat` is written
`github://owner/repo/workflow/sat`. Everything before them is the repository, a dotted first segment naming the
host. The optional range after `@` follows npm's rules. `local://` locators and `repo:` short names are refused:
a local repository is a consumer's convenience, and a short name is one project's private label. See
[Dependencies named by location](repositories-file-formats.md#dependencies-named-by-location).

## Cut a release

`sous repo release` publishes new versions: one run raises versions, regenerates `sous.index.json`, commits both,
and cuts the tags. Run it inside the repository, with your recipe changes committed.

```term
$ sous repo release
▶ The release this would make:

    workflow/qa-helper: 0.1.0 becomes 0.1.1 (a patch step; the tag would be
                        workflow/qa-helper@0.1.1)

  Left alone:
    workflow/qa-variables: its files have not changed since workflow/qa-variables@0.1.0.

  This run would:
    Raise the versions listed above, in the manifests that declare them.
    Regenerate sous.index.json, with each version's dependencies resolved.
    Commit the manifests and the index together.
    Cut one annotated tag per version, dependency-first.
    Push nothing; pass '--push' to push what it makes.

Publish these versions? yes

▶ Publishing:

  workflow/qa-helper: 0.1.0 becomes 0.1.1.
  Wrote sous.index.json.
  Committed: Release workflow/qa-helper@0.1.1
  Created the tag workflow/qa-helper@0.1.1.
```

That run leaves out the banner and the checking step, and prints how to push once it finishes. The plan comes first
and a run asks once before changing anything; `--yes` answers ahead of time and `--dry-run` prints the plan and
stops. Three facts about each recipe decide that plan and nothing else does: whether it is in scope, whether its
files changed since the tag that last published it, and whether its version was already raised past that tag. The
third case is what a merge looks like to continuous integration: the bump is done, so the run only publishes it.

`--namespace <ns>` and `--recipe <ns/name>` narrow the run and both repeat; `--bump <level>` is `patch` (the
default), `minor`, `major` or `prerelease`; `--no-bump` raises nothing; `--include-unchanged` releases every
recipe in scope, changed or not; `--check` only reads, validating and failing when the committed index is stale;
and `--ci` is the merge preset: never bump, accept the plan, never ask, fail on anything unbumped. Every flag
this command takes, `--tag`, `--push` and `--non-interactive` among them, is in the
[command reference](commands.md#sous-repo-release).

`--bump` and `--no-bump` contradict each other, and so do `--check` and `--ci`; sous refuses the combination and
says which one to keep. `--ci` implies `--no-bump` and `--yes`, accepting the plan it prints rather than asking,
but it deliberately does not imply `--push`, so what a workflow pushes stays visible in the workflow file. Under
either, a recipe whose files changed without a bump is an error naming its manifest and the colliding tag.

### The branch rule

The default branch is whatever `origin/HEAD` points at. On any other branch a release bumps and commits but cuts
no tags, and says why: tags are cut on the default branch, by continuous integration after the merge. Pass
`--tag` to cut them anyway, which is what a repository with no automation wants; a clone that was never told its
default branch (one with no remote) treats every branch as the default.

### The sibling rule

Tags are cut **dependency-first**, so a recipe is never published before something it depends on, and every
sibling it depends on must be a version that exists once the run's own tags are counted. A sibling **never
published** stops the run, naming the tag to cut. One that was published, has changed since, and sits **outside
this release's scope** is fine: the release depends on the last published version, and warns.

```text
   WARNING:
  recipes/workflow/qa-variables/sous.recipe.yaml:
  'workflow/qa-helper' has changes since 'workflow/qa-helper@0.1.0' that are outside this
    release's scope; 'workflow/qa-variables@0.1.1' will depend on 'workflow/qa-helper@0.1.0'.
```

Each version's resolved dependencies are written into the index, so a consumer installing that version gets what
it was published with rather than ranges re-resolved months later. A published version never changes: its content
hash is carried forward exactly as published, and a disagreement is an error telling you to bump rather than
republish. A version counts as published once its tag exists, and the tags are the backstop, so a tagged version
missing from the index is rebuilt from it whenever the index is regenerated, which only happens on a run that
publishes something. A bump edits the manifest in place, so comments, field order and layout survive; a folded
block of YAML prose may be re-wrapped and the space before a trailing comment collapsed to one.

!> A release commits the version bumps and the index, and nothing else. It refuses to run while anything else is
uncommitted, because a tag names one commit and the index records what each recipe folder holds right now. It also
refuses when git does not know who is committing: set `git config user.name` and `git config user.email` first, or
give that identity to the account a continuous integration job runs as (the scaffolded workflow already does).

### The scaffolded workflow

`sous repo init` writes `.github/workflows/sous-release.yml`, which runs the same command in its two presets,
calling the CLI from npm so nothing is installed into the repository. On a **pull request** it runs
`npx --yes @sous-io/sous repo release --check`, which only reads, so it is safe on an untrusted branch and
fails the pull request when a manifest is wrong or the committed index is stale. On a **push to `main`** it
runs `npx --yes @sous-io/sous repo release --ci --push --yes`; edit the workflow's `branches` list if your
default branch has another name. `--ci` accepts the plan on its own, the redundant `--yes` keeping the file
working with an older published sous. Both jobs check out with `fetch-depth: 0`, so existing tags are visible
and no version is cut twice; the release job also takes `contents: write` and sets a git identity for the commit.

## Edit a repository in place

This is also how a recipe you have not released yet is run: link the checkout into a project and build. Edits
happen in a real working copy, never in the machine-wide store. `sous repo link`, run inside a **project**,
points that project's resolution of one repository at a checkout:

```bash
sous repo link ~/Projects/my-recipes             # link the checkout that is already there
sous repo link my-recipes                        # clone it into .sous/repos/<owner>/<name>
sous repo link my-recipes ~/Projects/my-recipes  # link a checkout that already exists
sous repo link my-recipes --global               # one checkout shared by every project
```

A **path on its own** links the checkout already at that path; relative paths and `~` work, nothing is cloned, and
the repository is added to the project first if it has not been added yet, under the short name its own manifest
suggests. A **repository on its own** is cloned for you, into `.sous/repos/<owner>/<name>` or
`$SOUS_HOME/repos/<owner>/<name>` with `--global`; a directory already holding a checkout of the same remote is
reused, so running it twice is harmless, and one holding a different remote is an error. A **repository followed by
a path** links the checkout there and clones nothing; in every form the path must hold a repo manifest at its root,
and a path in both slots is an error.

Linking also maintains the ignore files that keep machine-local sous files out of your project's history: a
`.sous/repos/.gitignore` holding a single `*`, and a managed block inside `.sous/.gitignore` whose marked lines
are the only ones ever rewritten. A link bypasses versions, the lockfile and freshness checks, and those bypasses
belong to one machine rather than the team, so link and every later build say so loudly:

```text
The repository 'my-recipes' is now LINKED.
Its recipes are read from the checkout above, so versions, the lockfile
and freshness checks no longer apply to it. Builds say so every time.

Run 'sous repo unlink my-recipes' to go back to published versions.
```

`sous repo unlink` removes the map entry and nothing else: the checkout stays where it is, and its path is
printed so you can delete it. Unlinking a name linked in the other scope says which scope holds it.

## Contribute to someone else's repository

`sous repo submit` proposes your committed changes to a repository's maintainers; it never publishes and never
writes to a repository directly. It takes `--title`, `--body`, `--draft` and `--dry-run`, and runs three stages,
printing each step:

1. **Preflight.** An `origin` remote exists, sous recognizes its provider, that provider's command line tool
   (`gh` or `glab`) is installed and signed in, and everything is committed.
2. **Validation.** The repository validates and the committed index is current, so a proposal never fails the
   maintainer's own checks and wastes their review.
3. **Delegation.** Sous asks the provider whether you can push to the repository itself, forks it onto your
   account when you cannot, pushes the branch, and asks the provider to open the proposal. A change sitting on
   the default branch is moved to `sous/submit-<YYYYMMDD>-<HHMM>`.

Each step is the provider's own business, and what each one can do depends on the host; see
[Providers](repositories-providers.md#proposing-a-change). Sous sequences the steps and reports what came back. A
failure partway through says which steps completed, so a pushed branch with no proposal behind it is reported
rather than left for you to guess at, and a provider that cannot carry out a step says what to do by hand. When it
cannot open a proposal at all, sous prints the `contribute` pointer from the repository's `sous.repo.yaml`; set
that field in your own repository so a contributor is never left without a route.

## Where to go next

- [Repository file formats](repositories-file-formats.md): every manifest and index schema
- [Consuming recipes](repositories-consuming.md): the other side, from `repo add` to `build`
- [Command reference](commands.md): every command and flag
- [Providers](repositories-providers.md): what `gh` and `glab` can each do for a release and a submission
- [Recipe variables](repositories-variables.md): how the definitions declared here are answered at build time
