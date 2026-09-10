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
    prompt: Where should task files live?
    description: One file per git branch is written here.
    default: .sous/tasks
    required: true
    scope: shared

  - name: serviceToken
    type: string
    env: SERVICE_TOKEN
    prompt: What is the service token for this project?
    secret: true
    scope: local
    validate:
      minLength: 20
```

The rules worth knowing while you write one:

- **`name` is camelCase**, and it is how templates refer to the variable.
- **`env` names the environment variable** an answer binds to. Omit it and `sous repo release`
  derives one from the name: `apiUrl` becomes `SOUS_VAR_API_URL`. Naming it explicitly is how a
  recipe reuses a value the environment already carries, such as `GITHUB_TOKEN`.
- **`secret: true`** stores the answer in the gitignored `.sous/.env.local` and hides the value
  everywhere sous prints it.
- **`scope`** picks the file the answer is written to: `shared` for the committed `.sous/.env`,
  `local` for the gitignored `.sous/.env.local`. A secret declared as `shared` is rejected,
  because that combination would commit the secret.
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

`sous repo release` validates the repository, regenerates `sous.index.json`, and cuts the git
tags that publish new versions. Run it from inside the repository.

| Invocation | What it does |
|------------|--------------|
| `sous repo release` | Validates, regenerates the index, and prints what a release would publish. Nothing is committed or tagged |
| `sous repo release --check` | Reads only. Exits non-zero when anything is wrong or the committed index is out of date. This is what a pull request runs |
| `sous repo release --bump <level>` | Raises a recipe's version in place: `patch`, `minor`, `major` or `prerelease` |
| `sous repo release --recipe <ns/name>` | Which recipe `--bump` applies to. Required when the repository publishes more than one |
| `sous repo release --tag` | Creates the annotated tag for every version that has none, then rewrites the index to record them |
| `sous repo release --tag --push` | The same, and pushes exactly those tags to `origin`. Nothing else is pushed |
| `sous repo release --dry-run` | Works with all of the above and changes nothing |

`--check` cannot be combined with `--tag` or `--bump`, and `--push` only has an effect alongside
`--tag`; sous says so rather than guessing which one you meant.

A normal release looks like this:

```term
$ sous repo release --bump minor --recipe workflow/task-files
  workflow/task-files: 1.1.0 becomes 1.2.0
  Wrote sous.index.json.
$ git commit -am "Release task-files 1.2.0"
$ sous repo release --tag --push
  Created the tag workflow/task-files@1.2.0.
  Pushed 1 tag to origin.
```

Three rules keep metadata, tags and the index in step:

- **A published version never changes.** Its content hash is carried forward exactly as
  published, and a disagreement is an error telling you to bump the version rather than
  republish it.
- **A version is published when its tag exists.** A version whose tag has not been cut yet is
  left out of the index and reported as **pending** instead, because every index entry names its
  tag. Merging the manifest is not publishing; tagging is.
- **The tags are the backstop.** A tagged version missing from the index is rebuilt from its tag,
  so deleting `sous.index.json` and regenerating it restores the same catalog.

!> Sous writes files and creates tags; it never commits for you. `--tag` refuses to run while the
working tree has uncommitted changes or while the committed index is out of date, and every
command tells you what to commit instead.

A `--bump` edits the manifest in place, so its comments, its field order and its layout all
survive. Two small normalizations happen in a YAML manifest: a folded block of prose may be
re-wrapped, and the spacing before a trailing comment is collapsed to one space.

### The scaffolded workflow

`sous repo init` writes `.github/workflows/sous-release.yml`, which runs the same two commands
you would run by hand. It calls the sous CLI straight from npm, so nothing has to be installed
into the repository:

- On a **pull request**, `sous repo release --check`. It only reads, so it is safe on an
  untrusted branch, and it fails the pull request when a manifest is wrong or the committed index
  is stale.
- On a **push to `main`**, `sous repo release --tag --push`, followed by a step that commits the
  regenerated index when tagging changed it. The checkout uses `fetch-depth: 0` so existing tags
  are visible and a published version is never cut a second time.

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
3. **Delegation.** The fork, branch and pull request mechanics go to the provider's own CLI,
   which already holds your credentials. On GitHub, sous asks whether you can push to the
   repository itself and forks it onto your account if you cannot. A change sitting on the
   default branch is moved to a branch named `sous/submit-<date>-<time>` first.

`--title` defaults to your last commit's subject and `--body` to a summary sous writes. A failure
partway through says exactly which steps completed: a pushed branch with no proposal behind it is
a normal outcome of a network failure, and you are told about it rather than left guessing.

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
