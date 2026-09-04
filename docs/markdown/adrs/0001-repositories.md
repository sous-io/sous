# ADR 0001: Repositories

**Status:** Draft. While [gh-4](https://github.com/sous-io/sous/issues/4) is open, that issue is
the source of truth for this design; this ADR is a snapshot and will be trued up to what is
actually built when the issue closes, at which point it becomes the permanent decision record
for the initial version of the repositories system.

!> This document is a draft of a design in progress. Implementation may change any part of it;
consult [gh-4](https://github.com/sous-io/sous/issues/4) for the current state.

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
- A recipe can contain anything sous consumes: skills, memories, config, variable definitions,
  question flows. Subscribing to a recipe gets everything in it; a subscription can also target
  a whole namespace, which means all of its recipes, including recipes added later.
- A **repo manifest** declares the repo's namespaces and recipes. A **recipe manifest** declares
  the recipe's contents, dependencies, and variables. Both carry a format-version field from day
  one so the formats can evolve.
- A repo-level **index file** (recipes, namespaces, versions, a content hash per version) is the
  portable contract across providers.

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
  `sous-public:misc/stuff`.
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

- Repo providers are plugins registering protocol handlers. Version one ships exactly two,
  GitHub and GitLab, as built-in plugins delegating their write paths to the `gh` and `glab`
  CLIs respectively. The provider interface is internal for now.
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
- Trust is project-level (colleagues inherit it with the repo). The combination of trust plus
  the lockfile is the supply-chain defense: nothing new enters a project except through an
  explicit, visible change.

### Versioning and release

- Versions are SemVer, resolved with npm's `semver` package; ranges behave exactly as they do in
  npm. Prereleases are excluded from range matching unless a subscription opts in.
- Recipe metadata is the source of truth for versions; git tags (in the shape
  `namespace/recipe@1.2.3`) are convenience refs and the cheap enumeration path. Tag-to-metadata
  consistency is machine-verified; a missing or wrong tag must never silently hide a version.
- `sous repo release` automates releasing: it bumps and validates metadata, regenerates the
  repo index, and either proposes the release for review or, for solo repos, commits and tags
  directly. `sous repo init` scaffolds a repo, including the release automation.
- A deprecate/yank affordance belongs in recipe metadata eventually; pinned hashes keep yanked
  content restorable for projects that already lock it.

### Fetching, cache, and lockfile

- Adding a repo fetches only its index. Subscribing fetches eagerly, and only the recipe's
  subtree, never the whole repo. Contribution workflows may use full clones.
- A lockfile records the exact resolved version and content hash of everything in use, and
  restores are deterministic; a fresh clone rebuilds exactly what the lock describes, without
  prompts.
- The machine-wide store lives under the user-level sous directory, one folder per
  recipe-version, verified against the locked hash. The store is disposable by design:
  everything in it is re-fetchable from pins, which enables automatic size-capped GC plus a
  manual `sous repo gc`.
- Builds read inputs directly from the store; outputs are rendered or copied per-project. Sous
  never symlinks store content into projects and store content is never edited in place.
- An **always-pull** flag, settable per repo, namespace, or recipe at project or user level,
  skips the lock and installs whenever a newer in-range version exists. The lock is still
  continuously regenerated so it always records what the last build used. Watch mode polls
  upstream cheaply at a configurable interval; non-watch builds check only when a configurable
  freshness window (default five minutes) has lapsed. A failed check never breaks a build.

### The official repos and seeding

- There is one official public repo, a literal GitHub repository. Its **core namespace** is
  auto-subscribed in every project with opt-out semantics; everything else in it is opt-in.
- The core namespace's source lives inside the sous package itself and seeds the machine store
  on first run, so a fresh setup works offline. The sous release pipeline pushes the core
  namespace to the public repo versioned to match the sous application version; the core
  namespace in the public repo is machine-written distribution output.

### Variables and questions

- Recipes declare **variable definitions**: published specs (name, schema, validators, prompt
  text, env var name). Definitions are inert; a prompt fires only when a subscribed recipe needs
  a variable that has no valid answer in scope. An **answer** is the stored value; a "question"
  is only the interactive moment. Project-level variables keep the existing zero-ceremony
  system; definitions are a publishing formality.
- Definitions ship inside recipes and therefore version, resolve, pin, and trust like everything
  else. Within a major version a schema may only loosen; tightening is a major bump, and
  upgrades re-validate stored answers, re-prompting only where an old answer no longer fits.
- Answers are stored in the project's env files: committed for team-shared answers, gitignored
  for machine-local ones. Sous edits these files itself, preserving comments and order, and
  writes a plain-language generated header comment above each managed entry. Comments are
  explanatory output only, never parsed.
- Each definition carries its env var name; authors may choose any name, including bare existing
  names like `GITHUB_TOKEN` to bind values already present in the environment. Release
  validation derives a default name when omitted, fails on collisions within a repo, and warns
  when a definition claims a well-known system variable.
- Resolution walks a fixed ladder, most specific first: an explicit mapping record (an arbitrary
  env var bound to a fully qualified variable ref; the universal conflict resolver), then the
  recipe-scoped name, the namespace-scoped name, the shared `SOUS_VAR_` form, and finally the
  bare declared name. Within a rung, the real environment beats the machine-local env file,
  which beats the committed one. Candidate names are only ever generated and looked up, never
  parsed.
- When an existing value validates for an incoming question, sous offers it with its scope and
  source shown; inherited answers are always listed visibly in install output. On a genuine
  conflict, sous offers to write the mapping record. A vars-listing command shows every variable
  in play, its env var, its value, and its source.
- Exactly two environment variables can never come from env files, because they decide which
  project is active and therefore where the env files are; both are ignored with a visible
  warning if a file sets them. Everything else, including all behavior knobs, is file-settable.

### Editing and contribution workflow

- Edits happen in a real working copy of a repo, never in the store. `sous repo link` points a
  project's resolution of a repo at a local working copy; with no path argument it clones the
  owning repo to an auto path first, so "ready to edit" is one command. Link state is
  machine-local and linked repos are announced loudly in build output, since they bypass
  versions, lock, and freshness.
- `sous repo submit` ships in version one as the validate-then-propose convenience: it runs the
  publish-side validation before anything is sent, then delegates the fork/branch/PR mechanics
  to the provider CLI, with preflight checks and honest reporting of partial state on failure.

### Command surface

`sous repo add | list | search | init | link | submit | release | gc`, plus `sous subscribe`,
`sous unsubscribe`, and a vars-listing command. CLI output follows the project's output
standard: polished, colored, padded, plain language.

## Consequences

- Shared-prompts bundles migrate into the official repo as recipes, and the documented
  "variables required by the shared prompts" convention becomes published variable definitions.
  Building the official repo is the migration, and the first real content milestone.
- Projects gain deterministic, reviewable supply: everything remote is pinned, hashed, and
  trust-gated, and a fresh clone reproduces the last locked state without interaction.
- Always-pull projects accept routine lockfile diffs as the record of what changed.
- No-peek-before-trust means discovery of unknown repos happens outside sous; the docs must say
  so plainly.
- The user-level configuration layer that several features above assume (user-scope always-pull
  flags, user-scope mappings) is designed separately in
  [gh-20](https://github.com/sous-io/sous/issues/20).
