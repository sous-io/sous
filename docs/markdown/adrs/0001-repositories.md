# ADR 0001: Repositories

**Status:** Accepted, 2026-09-10.

This is the permanent decision record for the initial version of the repositories system. It
records what was decided and why; the living answer to "how does it work right now?" is the
[Repositories](repositories.md) documentation, and the process record, including the
mid-flight design changes, is [gh-4](https://github.com/sous-io/sous/issues/4).

## Context

Sous compiles agent configuration only from locations reachable on the local filesystem: the
CLI's own `shared-prompts/` directory and whatever paths a project's config points at. There is
no first-class way to consume shared content from a remote source, no versioning of shared
content beyond whatever checkout happens to be present, and no distribution story across teams
or projects other than shipping content inside the sous package itself.

Helm's chart-repository model was studied as prior art (index over dumb transport, manifest
ranges with lockfile pins, immutable published versions, git as authoring rather than
distribution). Helm informed several choices below but was deliberately not treated as a
template; every requirement derives from sous's own use cases.

## Decision

### Model and terminology

- **Repositories** ("repos") publish **recipes**, grouped into **namespaces**. Repositories
  replace the older shared-prompts "bundles" concept entirely.
- A recipe can contain anything sous consumes: skills, memories, prompts, config, variable
  definitions. Subscribing to a recipe gets everything in it; a subscription can also target a
  whole namespace, which means all of its recipes, including recipes added later.
- A **repo manifest** declares the repo's namespaces and recipes. A **recipe manifest** declares
  the recipe's contents, dependencies, and variables. Both are hand-written, both are YAML or
  JSON and never JavaScript, and both carry a format-version field from day one so the formats
  can evolve.
- A repo-level **index file** (recipes, namespaces, versions, a content hash per version) is the
  portable contract across providers.
- Every file in the system is named concretely and carries `formatVersion: 1`, so an older sous
  refuses a file it would otherwise misread rather than guessing:

  | File | Where | Written by |
  |------|-------|-----------|
  | `sous.repo.yaml` | repository root | the author |
  | `sous.recipe.yaml` | each recipe folder | the author |
  | `sous.index.json` | repository root | `sous repo release` |
  | `sous.lock.json` | the project's `.sous/` | sous, committed |
  | `.sous.entry.json` | each store entry | sous |
  | `sous.links.json` | `.sous/` or `$SOUS_HOME` | `sous repo link`, never committed |

  Variable definitions live in a `variables:` section inside the recipe manifest rather than in a
  file of their own; splitting a large manifest across files is deferred to a future manifest
  include mechanism.

### Dependencies

Recipe manifests support two distinct, declarative relationships:

- **`depends`** (build dependency, the default): the dependency is fetched, pinned, and
  trust-gated, and its files are addressable from the declaring recipe's own files, but its
  files do not enter the project's output. This covers shared partials and shared variable
  definitions.
- **`subscribes`** (co-subscription): subscribing to this recipe also subscribes the project to
  the listed targets with full semantics; their question flows run and their files enter the
  output. A curated bundle is simply a recipe consisting mostly of `subscribes` entries; there
  is no special bundle type.

Both relationships stay declarative so the entire dependency closure is readable from manifests
alone; that property is what the trust flow depends on. Plugin code that subscribes at config
time was rejected for this reason. Depending on a namespace makes the namespace addressable and
its repo required; version constraints always apply per recipe, since namespaces are not
versioned. Removal is refcounted: dropping a bundle drops its co-subscriptions unless something
else still holds them.

### Referencing

- Bare refs have no prefix: one segment is a namespace, two segments are `namespace/recipe`, and
  `@` introduces a version range only (`misc/stuff@^1.2`).
- A repo qualifier, needed only on conflict, is the repo's configured name plus a colon:
  `sous-recipes:misc/stuff`.
- Refs resolve apt-style across the cached indexes of all added repos; genuine conflicts are an
  error demanding the qualified form, never first-match-wins.
- Inside template includes, a raw namespace ref requires the reserved `~` sigil
  (`@~misc/file.md`); a bare `@path` in an include always stays a relative path or declared
  alias, with no namespace fallback, so include lines never masquerade as filesystem paths.
- Every declared dependency is automatically addressable as `~<namespace>` within the declaring
  recipe's files; an explicit alias is optional sugar. Inside a recipe's files these names
  resolve only against that recipe's declared dependencies at their pinned versions; in the
  project's own templates they resolve against the project's subscriptions.

### Providers

- Repo providers are plugins registering protocol handlers. Version one ships GitHub and GitLab
  as built-in plugins delegating their write paths to the `gh` and `glab` CLIs respectively,
  plus a **`file`** provider for a repository on the local filesystem. The provider interface is
  internal for now.
- The `file` provider was added during implementation for local development and for tests:
  authoring a repository, trying a recipe before publishing it, or running the whole workflow
  with no network. It reads the index from the working tree when one is there and a recipe's
  files from the version's git tag, falling back to the working tree in a directory that is not
  a git repository. Its trust semantics are identical to a hosted repository's, deliberately:
  the recipes still run on this machine.
- Providers expose a features list; `submit` is one such capability and each provider defines
  what it means. A plain-HTTP-server provider path is deliberately kept open; sous will not
  invent a write protocol for providers that lack one.
- `submit` universally means "propose a change to this repo for its maintainers to review"; it
  is never publish and never direct write. Owners publishing their own repos use the authoring
  workflow instead. Repo manifests may carry a contribution pointer that is surfaced when
  submit is unsupported.
- Requirement gradient: consuming public repos needs nothing but a network connection; consuming
  private repos needs some form of auth (a token in CI, an available CLI token, git
  credentials); contributing may require the provider's CLI. Feature-specific requirements are
  per-plugin design choices; the standing principle is that plugins stay as frictionless as
  possible.

### Trust

- Added equals trusted: attached repos and trusted repos are the same thing, stored in the same
  managed config layer. Trusting adds the repo entry; untrusting removes it.
- Untrusted means no download, including the index; there is no peeking before trusting. The
  trust decision rests on the URL and the publisher's reputation, inspected outside sous.
- `sous repo add` is the trust ceremony and asks inline, with strong wording: trusting a repo
  automatically trusts all of its namespaces and recipes, and while trusting alone executes
  nothing, subscribing to anything within it can and probably will; repo trust is the last gate
  between the user and those scripts.
- Dependency resolution is iterative with one consolidated prompt per round, each new repo shown
  with provenance (which recipe requires it). Any refusal aborts the install. Machine-added
  entries record their provenance. Non-interactive runs fail hard, naming exactly which repos
  need trust and the command that grants it.
- `--trust` is the non-interactive acknowledgment, on both `sous repo add` and `sous subscribe`:
  "I accept trust for every repository this command adds." It is the only way to add a
  repository without answering the question.
- Trust is project-level (colleagues inherit it with the repo). The combination of trust plus
  the lockfile is the supply-chain defense: nothing new enters a project except through an
  explicit, visible change.

### Versioning and release

- Versions are SemVer, resolved with npm's `semver` package; ranges behave exactly as they do in
  npm. Prereleases are excluded from range matching unless a subscription opts in, which it does
  with `prerelease: true` on the subscription entry or `--prerelease` on `sous subscribe`.
- Recipe metadata is the source of truth for versions; git tags (in the shape
  `namespace/recipe@1.2.3`) are convenience refs and the cheap enumeration path. Tag-to-metadata
  consistency is machine-verified; a missing or wrong tag must never silently hide a version.
- **A version is published when its tag exists.** A version declared in a manifest with no tag
  yet is left out of the generated index and reported as pending, because every index entry names
  the tag it was published from. Merging a manifest is therefore not publishing; tagging is.
- Sous writes files and creates tags, and never commits on an author's behalf. `sous repo
  release` validates, regenerates the index and proposes the release by default; `--check` is the
  read-only form a pull request runs, `--bump` raises a version in place while preserving the
  manifest's comments and layout, and `--tag` (optionally `--push`) publishes once everything is
  committed. `sous repo init` scaffolds a repo, including release automation that runs `--check`
  on a pull request and `--tag --push` on a merge.
- A deprecate/yank affordance belongs in recipe metadata eventually; pinned hashes keep yanked
  content restorable for projects that already lock it.

### Fetching, cache, and lockfile

- Adding a repo fetches only its index. Subscribing fetches eagerly, and only the recipe's
  subtree, never the whole repo. Contribution workflows may use full clones.
- A lockfile records the exact resolved version and content hash of everything in use, and
  restores are deterministic; a fresh clone rebuilds exactly what the lock describes, without
  prompts.
- The user-level sous directory is **`~/.sous`**, overridable with **`SOUS_HOME`**. Unlike
  `SOUS_CONFIG` and `SOUS_DIR`, `SOUS_HOME` does not decide which project is active, so it is
  settable from an env file as well as from the shell. The machine-wide store lives at
  `$SOUS_HOME/cache`, one folder per recipe-version, verified against the locked hash. The store
  is disposable by design: everything in it is re-fetchable from pins, which enables automatic
  size-capped GC plus a manual `sous repo gc`.
- Builds read inputs directly from the store; outputs are rendered or copied per-project. Sous
  never symlinks store content into projects and store content is never edited in place.
- An **always-pull** flag, settable per repo or per subscription, skips the lock and installs
  whenever a newer in-range version exists. The lock is still continuously regenerated so it
  always records what the last build used. Watch mode polls upstream cheaply at a configurable
  interval; non-watch builds check only when a configurable freshness window (default five
  minutes) has lapsed. A failed check never breaks a build.
- The consumer surface lives in four top-level config keys, `repos`, `subscriptions`, `store` and
  `recipeOutputs`, plus `varMappings` for variable answers. Sous writes three of them into the
  `conf.d/` band reserved for machine-written layers, each replaced in full whenever it changes so
  that a removal actually removes something: `500-repos.json`, `510-subscriptions.json` and
  `520-var-mappings.json`. `recipeOutputs` is always the project's own to write. Sous never edits
  a hand-written config file, and a user may hand-write any of these keys in the primary config,
  where they merge with the managed layers like anything else.

### The official repo and seeding

- There is one official public repo, the literal GitHub repository
  **`sous-io/sous-recipes`**. Its **core namespace** is auto-subscribed in every project with
  opt-out semantics; everything else in it is opt-in.
- The core namespace's source lives inside the sous package itself and seeds the machine store on
  first run, along with a seed index, so a fresh setup works entirely offline. The sous release
  pipeline pushes the core namespace to the public repo versioned to match the sous application
  version; the core namespace in the public repo is machine-written distribution output, and core
  recipes resolve by default to the version matching the installed CLI. Deploy parity is
  implemented as a `publish-recipes.yml` workflow in the sous repository, authenticating with a
  write deploy key held as a repository secret.
- The opt-out is an ordinary config entry, not a special mechanism: `enabled: false` on the
  `subscriptions.core` entry removes the auto-subscription, and the same field on the
  `repos.sous-recipes` entry removes the built-in repository altogether.
- The official repository's namespaces are the canonical [skill
  categories](skill-categories.md) plus `core`, and it publishes six recipes:
  `core/sous-skills`, `workflow/task-files`, `workflow/github-projects`,
  `workflow/sub-agent-delegation`, `communication/control-flow` and
  `tool-usage/automated-browser-tasks`. The sixth, `workflow/sub-agent-delegation`, was
  identified during migration: the shared sub-agent delegation partial was depended on by four
  of the other recipes and needed a home of its own rather than a copy in each.
- Namespace subscriptions are a first-class feature, and the expected way to consume a coherent
  namespace on somebody's team repository. They are not the expected way to consume the official
  repository: any arrangement of its content yields either one-recipe namespaces or namespaces of
  unrelated recipes, so subscribers to the official repo are expected to subscribe per recipe,
  with `core` the deliberate exception. The documentation says so plainly.

### Variables and questions

- Recipes declare **variable definitions**: published specs (name, schema, validators, prompt
  text, env var name). Definitions are inert; a prompt fires only when a subscribed recipe needs
  a variable that has no valid answer in scope. An **answer** is the stored value; a "question"
  is only the interactive moment. Project-level variables keep the existing zero-ceremony system;
  definitions are a publishing formality.
- Definitions ship inside recipes and therefore version, resolve, pin, and trust like everything
  else. Within a major version a schema may only loosen; tightening is a major bump, and
  upgrades re-validate stored answers, re-prompting only where an old answer no longer fits.
- Answers are stored in the project's env files: committed for team-shared answers, gitignored
  for machine-local ones. Sous edits these files itself, preserving comments and order, and
  writes a plain-language generated header comment above each managed entry. Comments are
  explanatory output only, never parsed.
- Each definition carries its env var name; authors may choose any name, including bare existing
  names like `GITHUB_TOKEN` to bind values already present in the environment. Release
  validation derives a default name when omitted, fails on collisions between definitions of
  different names within a repo, and warns when a definition claims a well-known system
  variable unless the definition says the claim was intentional.
- Resolution walks a fixed ladder, most specific first: an explicit mapping record (an arbitrary
  env var bound to a fully qualified variable ref; the universal conflict resolver), then the
  recipe-scoped name, the namespace-scoped name, the shared `SOUS_VAR_` form, and finally the
  bare declared name. Within a rung, the real environment beats the machine-local env file,
  which beats the committed one. Candidate names are only ever generated and looked up, never
  parsed.
- When an existing value validates for an incoming question, sous offers it with its scope and
  source shown; inherited answers are always listed visibly in install output. On a genuine
  conflict, sous offers to write the mapping record, and writes one by default where there is no
  terminal, because overwriting a value something else already uses is the worse guess.
- The command surface is the `sous vars` family: `sous vars` lists every variable in play,
  `sous vars <name>` shows one in full including every name on the ladder, and `sous vars ask`
  answers what is unanswered, with `--all` to re-ask everything, `--file` to read a standalone
  definitions file, and `--dry-run`. This family absorbs
  [gh-12](https://github.com/sous-io/sous/issues/12) (Questions and Answers) entirely: that
  issue's separate `sous questions` commands and conf.d answer store are superseded by the env
  file storage and the ladder described here.
- Exactly two environment variables can never come from env files, because they decide which
  project is active and therefore where the env files are; both are ignored with a visible
  warning if a file sets them. Everything else, including all behavior knobs, is file-settable.

### Editing and contribution workflow

- Edits happen in a real working copy of a repo, never in the store. `sous repo link` points a
  project's resolution of a repo at a local working copy; with no path argument it clones the
  owning repo first, so "ready to edit" is one command. The clone lands in `.sous/repos/<owner>/
  <name>`, or in `$SOUS_HOME/repos/<owner>/<name>` with `--global`, where several projects share
  one checkout. `sous repo unlink` removes the redirect and leaves the checkout on disk, printing
  its path, because a directory that may hold uncommitted work is not a command's to delete.
- The redirect is recorded in `sous.links.json`, in the project's `.sous/` or in `$SOUS_HOME`;
  both maps are read and the project's wins on conflict. Link state is machine-local and never
  committed. Linked repos are announced loudly in build output, since they bypass versions, lock,
  and freshness.
- Linking maintains the ignore hygiene that keeps machine-local sous files out of a project's
  history: a `.gitignore` holding `*` inside `.sous/repos/`, and a delimited managed block inside
  `.sous/.gitignore` covering the links map, the state file, the PID file and the checkout
  directory. Only the lines between the markers are ever rewritten. `sous prune` and `sous clear`
  never reach into `.sous/repos/` or into the store.
- An earlier draft reached working copies through a `SOUS_PATH` environment variable. That was
  **dropped**: an environment variable is invisible in a project, cannot be scoped to one
  repository, and gives a build no way to say what it is actually reading. The links maps say
  both, on disk, where a build can report them.
- `sous repo submit` ships in version one as the validate-then-propose convenience: it runs the
  publish-side validation before anything is sent, then delegates the fork/branch/PR mechanics
  to the provider CLI, with preflight checks and honest reporting of partial state on failure.

### Command surface

`sous repo add | list | search | init | link | unlink | release | submit | gc`, plus
`sous subscribe`, `sous unsubscribe`, `sous vars` and `sous vars ask`. CLI output follows the
project's output standard: polished, colored, padded, plain language.

The CLI binary is named **`sous`**. It was renamed from `xcv` as the first step of this effort,
before any of the surface above was written, because every command, message and document here
names it and a later rename would have touched all of them.

`sous repo init`, `sous repo release` and `sous repo submit` run inside a recipe repository
rather than inside a sous project, and therefore perform no config discovery: a recipe repository
has no `.sous/` directory, and requiring one would mean those commands only worked from inside an
unrelated project.

## Consequences

- Shared-prompts bundles migrate into the official repo as recipes, and the documented
  "variables required by the shared prompts" convention becomes published variable definitions.
  Building the official repo is the migration, and the first real content milestone. Sous itself
  becomes a consumer of its own recipes, which is the strongest available test of the system.
- Projects gain deterministic, reviewable supply: everything remote is pinned, hashed, and
  trust-gated, and a fresh clone reproduces the last locked state without interaction.
- Always-pull projects accept routine lockfile diffs as the record of what changed.
- No-peek-before-trust means discovery of unknown repos happens outside sous; the docs must say
  so plainly.
- Two setup steps cannot be automated and must be performed by hand. `sous-io/sous-recipes` is
  created private and stays private until its owner flips it public; until then the built-in seed
  is the only working source of the core namespace for anyone but its owner. And the deploy key
  the parity pipeline authenticates with must be generated, added to `sous-io/sous-recipes` as a
  write deploy key, and stored as a secret in `sous-io/sous` by hand, because sous agents do not
  install credentials on a user's account.
- The user-level configuration LAYER that several features above would otherwise assume is not
  part of this decision; it is designed separately in
  [gh-20](https://github.com/sous-io/sous/issues/20). This version therefore ships the user-level
  DIRECTORY only. User-scope always-pull flags and user-scope variable mapping records are
  deferred with it; the project-scope versions of both ship here.
- Two questions are deliberately left open, each because nothing yet forces an answer: how
  finer-than-repo trust granularity is expressed on a repo entry, and the shape of
  deprecate/yank metadata. Both are recorded on gh-4 and neither blocks anything in this version.
