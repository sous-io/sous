# Authoring a Repository

This is the guide to publishing recipes of your own: creating a repository, writing a recipe,
editing one that is already published, cutting a release, and proposing a change to someone
else's repository. [Repository file formats](repositories-file-formats.md) holds every schema
these commands read and write; this page is about the workflow.

?> A recipe repository is not a sous project. It has no `.sous/` directory, and `sous repo init`,
`sous repo release` and `sous repo submit` do not look for one. Run them from inside the
repository itself.

## Create a repository

```term
$ sous repo init ./my-recipes --name my-recipes --namespace workflow
  wrote sous.repo.yaml
  wrote sous.index.json
  wrote recipes/workflow/example/sous.recipe.yaml
  wrote recipes/workflow/example/skills/example-skill/SKILL.md
  wrote README.md
  wrote .github/workflows/sous-release.yml
  wrote .gitignore
```

| Flag | What it does |
|------|--------------|
| `--name <name>` | Short name for the repository. Defaults to the directory's own name |
| `--namespace <name>` | The one namespace to declare. Defaults to the repository's name |
| `--force` | Write the scaffold over a repository that already exists |
| `--dry-run` | Print the files that would be written without writing them |

Names are lowercase kebab-case, and a name given in any other case is lowercased for you, so a
directory called `My-Recipes` yields `my-recipes`. `repo init` refuses to write over a directory
that already holds a repo manifest unless you pass `--force`, and it reads every manifest back
after writing it, so the scaffold it leaves behind is one that validates.

?> `repo init --force` means overwrite, not "answer yes". It is unrelated to the shared
confirmation flag other commands spell `--yes`, `-y`, `--force` or `--trust`, and `repo init`
does not accept those other spellings.

## The layout

```text
my-recipes/
  sous.repo.yaml                 what this repository publishes
  sous.index.json                the catalog, written by 'sous repo release'
  recipes/
    workflow/
      example/
        sous.recipe.yaml         one recipe, with its own version
        skills/
          example-skill/
            SKILL.md
  .github/workflows/sous-release.yml
  .gitignore
  README.md
```

Nothing in that tree is fixed except the two manifest filenames and the index at the root.
Recipe folders may live anywhere; what makes a folder a recipe is that `sous.repo.yaml` lists its
path under `recipes`, and that the folder holds exactly one recipe manifest.

Both hand-written manifests are YAML or JSON and never JavaScript. A repository's whole trust
story rests on being readable without running any of its code, and a manifest that could execute
would break that guarantee.

## Write a recipe

Copy the example folder, edit its manifest, and add the new path to the `recipes` list in
`sous.repo.yaml`. A minimal recipe:

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

`contents` groups are what a subscriber's project actually receives, one group per kind
(`skills`, `memories`, `prompts` or `config`), each with `include` glob patterns relative to the
recipe folder. Two more optional lists say what else the recipe needs: `depends` for build
dependencies whose files stay out of a subscriber's output, and `subscribes` for co-subscriptions
whose files go in. Full field tables are in
[`sous.recipe.yaml`](repositories-file-formats.md#sousrecipeyaml-the-recipe-manifest).

Recipe metadata is the source of truth for the version. Never edit `sous.index.json` by hand;
`sous repo release` regenerates it.

## Declare the variables a recipe needs

A recipe that needs a value from the project asks for it through a **definition**: a published
specification, never a value. Sous asks the question only when a subscribed recipe needs the
variable and no valid answer is already in scope.

```yaml
variables:
  - name: taskFileRoot
    type: path
    prompt: Where should task files be stored?
    description: >-
      This recipe mandates the creation of task files that are stored locally
      and, in general, should not be committed. This setting dictates the path in
      which agents will store and search for your task files. The default value
      stores task files in the project's .sous directory, but you can specify any
      local path, either relative to the project root or absolute.
    example: ~/my-task-files
    default: .sous/tasks
    required: true
    scope: shared

  - name: serviceToken
    type: string
    env: SERVICE_TOKEN
    prompt: What is this project's service token?
    description: >-
      This recipe authenticates every call it makes with a service token, which
      is issued per project and is not shared between them. Create one under
      Settings, then Tokens, and give it read access to the project you are
      configuring. There is no default; a token is always specific to you, and it
      is stored in the gitignored env file so it never reaches git.
    example: svc_0123456789abcdef0123
    secret: true
    scope: local
    validate:
      minLength: 20
```

The rules worth knowing while you write one:

- **`name` is camelCase**, and it is how templates refer to the variable.
- **`description` and `example` are both required.** The one-line `prompt` is rarely enough on its
  own, and the person answering it cannot read your mind. The description is the paragraph shown
  above the question and by `sous vars show <name>`; the example is a realistic sample answer,
  shown with the question.
- **A description explains, a prompt asks.** Write the description in full sentences, and cover
  three things: what the setting is for, what the default does, and what else is acceptable. Write
  the prompt as one plain question and nothing else. The pair above is the model:
  "This recipe mandates the creation of task files that are stored locally and, in general, should
  not be committed. This setting dictates the path in which agents will store and search for your
  task files. The default value stores task files in the project's .sous directory, but you can
  specify any local path, either relative to the project root or absolute." asked as
  "Where should task files be stored?". A description that only restates the prompt, or a prompt
  that tries to carry the explanation, both make the question harder to answer.
- **An example is documentation, a default is a value.** Sous never stores an example and never
  offers it as the answer; it only ever shows it. Use `default` for a value a project should
  actually start with. The same text may appear in both when the sample answer really is the right
  starting value.
- **`env` names the environment variable** an answer binds to. Omit it and `sous repo release`
  derives one from the name: `apiUrl` becomes `SOUS_VAR_API_URL`. Naming it explicitly is how a
  recipe reuses a value the environment already carries, such as `GITHUB_TOKEN`.
- **`secret: true`** stores the answer in the gitignored `.sous/.env.local` and hides the value
  everywhere sous prints it.
- **`scope`** picks the file the answer is written to: `shared` for the committed `.sous/.env`,
  `local` for the gitignored `.sous/.env.local`. A secret declared as `shared` is rejected,
  because that combination would commit the secret.
- **`validate.pattern` runs under a time budget.** Sous runs a published pattern on a worker and
  stops waiting after a fixed budget, so a pattern that backtracks forever cannot hang the person
  answering; it fails validation instead, and the message names your pattern. Keep patterns simple.
- **`x-intentional: true`** silences the release warning about claiming a well-known environment
  variable name. `PATH`, `HOME`, `USER`, `SHELL`, `GITHUB_TOKEN`, `GITLAB_TOKEN`, `NPM_TOKEN` and
  anything starting `AWS_` or `SOUS_` draw that warning; binding an existing token is legitimate,
  it just deserves saying out loud.

Two definitions of the same name may share one environment variable, because that is exactly
what the shared rung of the resolution ladder is for. Two definitions of **different** names
claiming the same environment variable is an error. See
[Recipe variables](repositories-variables.md) for how an answer is found at build time.

!> Within a major version a schema may only LOOSEN. Tightening a constraint is a major bump, and
an upgrade re-validates stored answers, re-prompting only where an old answer no longer fits.

## Edit a repository in place

Edits happen in a real working copy, never in the machine-wide store. `sous repo link`, run
inside a project, points that project's resolution of one repository at a checkout:

```bash
sous repo link my-recipes                        # clone it into .sous/repos/<owner>/<name>
sous repo link my-recipes ~/Projects/my-recipes  # link a checkout that already exists
sous repo link my-recipes --global               # one checkout shared by every project
sous repo unlink my-recipes
```

With no path, sous clones the repository for you, into `.sous/repos/<owner>/<name>` or into
`$SOUS_HOME/repos/<owner>/<name>` with `--global`. A directory that is already a checkout of the
same remote is reused rather than cloned again, so running the command twice is harmless; one
holding a different remote is an error, because reading the wrong recipes silently would be
worse than stopping. With a path, an existing checkout is linked in place and nothing is cloned;
that path must hold a repo manifest at its root.

Linking also maintains the two ignore files that keep machine-local sous files out of your
project's history: a `.sous/repos/.gitignore` holding a single `*`, and a delimited managed block
inside `.sous/.gitignore`. Only the lines between the markers are ever rewritten, and both files
are written only when their contents would change. `sous prune` and `sous clear` never reach
into `.sous/repos/`.

Because a link bypasses versions, the lockfile and freshness checks, and because those bypasses
belong to one person's machine rather than to the team, both the link command and every
subsequent build say so loudly:

```text
The repository 'my-recipes' is now LINKED.
Its recipes are read from the checkout above, so versions, the lockfile
and freshness checks no longer apply to it. Builds say so every time.
```

`sous repo unlink` removes the map entry and nothing else. The checkout stays exactly where it
is, and its path is printed so you can delete it yourself if you want to. Getting the scope wrong
is the easy mistake here, so unlinking a name that is linked in the other scope tells you which
scope holds it and which flag removes it.

## Release

`sous repo release` publishes new versions of this repository's recipes. One run does the whole
job: it raises versions, regenerates `sous.index.json`, commits both, and cuts the tags that
publish them. Run it from inside the repository, with your recipe changes already committed.

```term
$ sous repo release
  The release this would make:
    workflow/task-files : 1.1.0 becomes 1.1.1  (a patch step; the tag would be workflow/task-files@1.1.1)

  Left alone:
    workflow/sat: its files have not changed since workflow/sat@1.4.0.

  This run would:
    Raise the versions listed above, in the manifests that declare them.
    Regenerate sous.index.json, with each version's dependencies resolved.
    Commit the manifests and the index together.
    Cut one annotated tag per version, dependency-first.
    Push nothing; pass '--push' to push what it makes.

Publish these versions? yes
  workflow/task-files: 1.1.0 becomes 1.1.1.
  Wrote sous.index.json.
  Committed: Release workflow/task-files@1.1.1
  Created the tag workflow/task-files@1.1.1.
```

The plan is always printed first, and a run asks once before it changes anything. `--yes` answers
that question ahead of time, and `--dry-run` prints the plan and stops.

### What a run decides

Three facts about each recipe decide everything, and nothing else does:

1. **Is it in scope?** Every recipe is, unless `--namespace` or `--recipe` narrows the run.
2. **Have its files changed since the tag that last published it?** A recipe nobody touched is
   not re-released; a published version that says the same thing as the one before it is noise.
   `--include-unchanged` releases everything in scope anyway.
3. **Has its version already been raised past that tag?** If so, the bump has been done and this
   run only publishes it. That is what a merge looks like to the continuous integration run.

### The flags

| Invocation | What it does |
|------------|--------------|
| `sous repo release` | Plan, ask once, then bump, regenerate, commit and tag |
| `sous repo release --dry-run` | Print the plan and stop |
| `sous repo release --yes` | Skip the question; everything else is the same |
| `sous repo release --namespace <ns>` | Release only that namespace. Repeatable |
| `sous repo release --recipe <ns/name>` | Release only that recipe. Repeatable |
| `sous repo release --bump <level>` | `patch` (the default), `minor`, `major` or `prerelease` |
| `sous repo release --no-bump` | Raise nothing; a changed recipe nobody raised is an error |
| `sous repo release --include-unchanged` | Release everything in scope, changed or not |
| `sous repo release --tag` | Cut the tags even on a branch other than the default one |
| `sous repo release --push` | Push the commit, and the tags this run created, to `origin` |
| `sous repo release --check` | Read only: validate, and fail when the committed index is out of date |
| `sous repo release --ci` | The merge preset: never bump, never ask, fail on anything unbumped |

### The branch rule

On a branch other than the default one, a release bumps and commits but cuts no tags, and says
why: tags are cut on the default branch, by continuous integration after the merge. Pass `--tag`
to cut them anyway, which is what a repository with no automation wants.

### Dependencies and the sibling rule

Tags are cut **dependency-first**, so a recipe is never published before something it depends on.
Everything a released recipe depends on inside this repository has to be a version that exists
once the run's own tags are counted, and there are exactly two ways that fails:

- The sibling has **never been published**. Nothing can depend on it, so the run stops and names
  the tag that has to be cut.
- The sibling has been published, has changed since, and sits **outside this release's scope**.
  That is fine: the release goes ahead depending on the last published version, and warns with
  facts you can check.

```term
  recipes/workflow/task-files/sous.recipe.yaml:
  'workflow/sat' has changes since 'workflow/sat@1.4.0' that are outside this release's scope;
  'workflow/task-files@1.1.1' will depend on 'workflow/sat@1.4.0'.
```

Each version's resolved dependencies are written into the index, so a consumer installing that
version installs what it was published with rather than re-resolving its ranges months later.

### Three rules that keep metadata, tags and the index in step

- **A published version never changes.** Its content hash is carried forward exactly as
  published, and a disagreement is an error telling you to bump the version rather than
  republish it.
- **A version is published when its tag exists.** The one moment an index records a version
  without a tag is the release commit itself: the index is committed and the tag is cut on that
  commit. Any older version missing its tag is an error.
- **The tags are the backstop.** A tagged version missing from the index is rebuilt from its tag,
  so deleting `sous.index.json` and regenerating it restores the same catalog.

!> A release commits the version bumps and the index, and nothing else. It refuses to run while
anything else is uncommitted, because a tag names one commit and the index it writes records
what each recipe folder holds right now.

A bump edits the manifest in place, so its comments, its field order and its layout all survive.
Two small normalizations happen in a YAML manifest: a folded block of prose may be re-wrapped,
and the spacing before a trailing comment is collapsed to one space.

### The scaffolded workflow

`sous repo init` writes `.github/workflows/sous-release.yml`, which runs the same command in its
two presets. It calls the sous CLI straight from npm, so nothing has to be installed into the
repository:

- On a **pull request**, `sous repo release --check`. It only reads, so it is safe on an
  untrusted branch, and it fails the pull request when a manifest is wrong or the committed index
  (including the dependencies it records) is stale.
- On a **push to the default branch**, `sous repo release --ci --push`. `--ci` raises no versions
  and asks no questions: the version bump belongs in the change being merged, so a recipe that
  changed without one fails here rather than being given a version nobody reviewed. Both
  checkouts use `fetch-depth: 0`, so existing tags are visible and a published version is never
  cut a second time.

## Contribute to someone else's repository

`sous repo submit` proposes your committed changes to a repository's maintainers. It never
publishes and never writes to a repository directly.

```bash
sous repo submit
sous repo submit --title "Add a linting recipe"
sous repo submit --draft
sous repo submit --dry-run
```

It runs in three stages, printing each step before it runs:

1. **Preflight.** An `origin` remote exists, sous recognizes its provider, that provider's
   command line tool (`gh` or `glab`) is installed and signed in, and everything is committed.
2. **Validation.** The repository validates and the committed index is current, so a proposal
   never fails the maintainer's own checks and wastes their review.
3. **Delegation.** Sous asks the provider whether you can push to the repository itself, forks
   it onto your account when you cannot, pushes the branch, and asks the provider to open the
   proposal. Every one of those is the provider's own business; sous only sequences them and
   reports what came back. A change sitting on the default branch is moved to a branch named
   `sous/submit-<date>-<time>` first.

`--title` defaults to your last commit's subject and `--body` to a summary sous writes. A failure
partway through says exactly which steps completed: a pushed branch with no proposal behind it is
a normal outcome of a network failure, and you are told about it rather than left guessing.

### What each provider supports

Providers differ, and sous says so rather than pretending otherwise:

| Provider | Command line tool | Push permission | Forking | Proposal |
|---|---|---|---|---|
| GitHub | `gh` | Read from GitHub, so a contributor without it is forked automatically | `gh repo fork`, with a `fork` remote added for you | Pull request |
| GitLab | `glab` | Sous cannot tell, so it pushes to `origin` and says so | Not done for you; fork the project yourself and push your branch there | Merge request |
| Local | none | Not applicable | Not applicable | Not applicable; a repository on your own disk is edited directly |

When a provider cannot carry out a step, it says what to do by hand instead of stopping halfway
through. A local repository never submits at all: it declares no submit support, so sous points
you at the repository's `contribute` field instead.

?> When a repository's provider cannot open a proposal for you, sous prints the `contribute`
pointer from its `sous.repo.yaml` instead, so you are never left without a route. Set that field
in your own repository for the same reason.

## Where to go next

- [Repository file formats](repositories-file-formats.md): every manifest and index schema
- [Recipe variables](repositories-variables.md): what a definition turns into on a subscriber's
  machine
- [Skill categories](skill-categories.md): the canonical categories, and how the official
  repository uses them as namespaces
- [Command reference](commands.md): every command and flag
