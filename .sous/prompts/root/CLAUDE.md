# Sous CLI: Agent Configuration Manager

> **GENERATED FILE. DO NOT EDIT the repo-root `CLAUDE.md` DIRECTLY.**
> It is compiled by sous (`npm run sous:build`) from
> `.sous/prompts/root/CLAUDE.md`. Edit that source, then rebuild. The compiled
> copy is gitignored; the source is tracked.

Sous is a TypeScript CLI tool that compiles markdown templates and manages output files for LLM/AI coding agents 
(Claude, Codex, etc.). The binary is named `sous`. Published on npm as `@sous-io/sous`.
The binary was called `xcv` in earlier releases; the name is now `sous` everywhere, with no alias.

@${sousDir}/prompts/memories/agent-conduct.md

@${sousDir}/prompts/memories/writing-standards.md

@${sousDir}/prompts/memories/cli-conventions.md

## Build & Development

```bash
npm run build    # compile TypeScript → dist/ (type-check; dist is NOT what ships or runs)
npm run clean    # rm -rf dist/
```

The CLI always runs from TypeScript source via tsx, in the repo AND in the published
package. `bin/run.js` (the published bin) registers tsx via `tsx/esm/api` then hands off
to oclif; `bin/sous` is a thin bash wrapper over it for the repo's npm scripts. tsx is
resolved by module resolution (never a hardcoded `node_modules` path) so hoisted installs
(`npx`, local deps) work; same trick in `loadSettings` (`settings.ts`) for the config
subprocess. `run.js` sets oclif `settings.enableAutoTranspile = false`; tsx already
handles `.ts` imports, and leaving it on makes installs without the `typescript` devDep
warn on every run.

Run directly from source during development:
```bash
./bin/sous <command>
```

TypeScript: strict mode, ES2022 target, Node16 module resolution. `dist/` output exists
for type-checking only.

## Publishing (npm)

Published as `@sous-io/sous` (npm org `sous-io`), public access, Apache-2.0. The
package ships `bin/run.js`, `src/` (minus tests), `recipes/` (the core recipe seed), and the
documentation markdown (`docs/markdown/*.md`; agent-readable reference matching the installed
version, pointed to by the distributed `about-sous` skill; the web shell around it stays out).
See the `files` allowlist in `package.json` (an allowlist, so there is no `.npmignore`;
`bin/sous` and everything else stays out by default). `repository.url` must keep matching the
GitHub repo exactly; npm's trusted publishing validates it at publish time.

**Every merge to main publishes.** There is no release ritual and nothing to remember.
`.github/workflows/publish.yml` runs on every push to `main` and on `workflow_dispatch`,
as three jobs in sequence:

1. `version` works out the version, writes it, commits and tags it.
2. `publish` checks out that tag and publishes to npm.
3. `recipes` pushes the matching core recipe to `sous-io/sous-recipes`.

The version job follows the **already versioned** rule: if `package.json` names a version
that has no `v<version>` tag yet, somebody set it deliberately in the merged pull request
and it is published as it stands; otherwise that version already shipped, so the merge
takes the next PATCH. So a minor or a major release is a version edit inside an ordinary
pull request, and everything else is a patch. The job applies the version to
`package.json`, `package-lock.json` and `recipes/core/sous-skills/sous.recipe.yaml`
(`npm run version:sync`), commits it as `chore: release v<version> [skip ci]` under a bot
identity, and creates the annotated tag. **The tag is a record of what was published;
nothing triggers on it.** The job needs `contents: write` to push the commit and the tag.

The **loop guard** is that release commit's own message: this workflow pushes to `main`,
so the version job stands down when the head commit message contains `[skip ci]` or
`chore: release`. Never write either phrase into an ordinary commit to main, or that merge
will not release.

Publishing goes through trusted publishing (OIDC, tokenless), so the `publish` job needs
`id-token: write` and npm >= 11.5.1, and there is no local `npm publish` and no GitHub
Release to cut (the `gh` CLI is not assumed to exist). The trusted publisher is configured
on npmjs.com (package Settings, then Trusted publishing: org `sous-io`, repo `sous`,
workflow `publish.yml`), and it is bound to that **workflow file name**: renaming
`publish.yml` breaks publishing until the npm setting is changed by hand. The `name:` field
inside the file is free.

`workflow_dispatch` takes an optional `tag` input. Given a tag, the version job is skipped
and `publish` and `recipes` run again for that existing tag, which is how a run that failed
after tagging is finished off. Left empty, it releases whatever `main` holds, exactly as a
merge would. A `concurrency` group serializes releases so two merges cannot race for the
patch number.

**Core recipe parity.** The `core` namespace exists in two places and they must never
disagree: `recipes/core/sous-skills/` inside this package (the source of truth, and the
offline seed) and `core/sous-skills` in `sous-io/sous-recipes` (machine-written distribution
output). The packaged recipe's version is always exactly the package's version, because every
project's implicit `core` subscription asks for exactly the running sous version.
`src/lib/repos/core-recipe.spec.ts` fails the build when the two version numbers drift, and
`npm run version:sync` (`scripts/sync-core-version.mts`, built on `setRecipeVersion` in
`src/lib/repos/release/bump.ts`) is what puts them back in step. It is idempotent: a recipe
already at the package version is not rewritten, so a hand-written manifest is never
reflowed.

The `recipes` job in `publish.yml` keeps the published copy in step. It runs only after the
npm publish it `needs`, re-checks version parity, copies the packaged recipe over the
repository's copy and COMMITS that copy (a release refuses to run against a dirty tree),
waits for the new version to be installable, then runs
`npx @sous-io/sous@<version> repo release --ci --push` inside the checkout, which
regenerates the index, commits it, tags each version and pushes. The job holds
`contents: read` and no `id-token`, so the recipe repository's write key and the npm
publishing token never sit in the same job. It needs one repository secret, installed BY
HAND: `SOUS_RECIPES_DEPLOY_KEY`, the private half of an SSH key whose public half is a
write-enabled deploy key on `sous-io/sous-recipes`.

## Project Structure

```
src/
  base-command.ts          # oclif BaseCommand; discovers config, loads env files + settings
  config-command.ts        # BaseCommand subclass for `config *`; routes header/errors to stderr
  commands/
    build.ts               # compile + prune (main workflow command)
    compile.ts             # compile only
    prune.ts               # remove stale output files
    clear.ts               # delete all Sous-written files for a project
    launch.ts              # build + spawn a coding agent tool
    namespace/
      list.ts              # every namespace the trusted repos publish, and your coverage of it
      show.ts              # one namespace, and every recipe in it
    recipe/
      list.ts              # every recipe the trusted repos publish, with latest and pinned
      show.ts              # one recipe: versions, dependencies, variables, where files land
    lock/
      show.ts              # what the lockfile pins, and who holds each entry
      rebuild.ts           # recompute the lockfile from the subscriptions and cached indexes
    subscription/
      list.ts              # what the project subscribes to, with ranges, pins and origin
      add.ts               # subscribe to a namespace or recipe; installs the whole closure
      remove.ts            # remove a subscription and whatever only it brought in
    repo/
      add.ts               # add (and thereby trust) a repository; fetches only its index
      remove.ts            # stop trusting a repository, and remove everything it brought in
      list.ts              # list the trusted repositories and what they publish
      search.ts            # search the cached indexes by name and description
      gc.ts                # collect the machine-wide store, protecting locked entries
      init.ts              # scaffold a new recipe repository (no project config needed)
      link.ts              # point a repo at a working copy; clone, or link a given path
      unlink.ts            # drop the link and leave the checkout on disk
      release.ts           # validate a recipe repo, regenerate its index, cut the tags
      submit.ts            # propose this recipe repo's committed changes to its maintainers
    vars/
      index.ts             # bare `sous vars` and `sous vars <name>`: the hidden shorthand
      list.ts              # `sous vars list`: every variable, its answer and its source
      show.ts              # `sous vars show <name>`: one variable, and every rung of its ladder
      ask.ts               # `sous vars ask`: answer what is unanswered, into the env files
                           #   (--answer / --answers-file answer ahead of the questions)
    config/
      show.ts              # print the merged config as JSON
      get.ts               # print one value by dot-path (--layers for provenance)
      validate.ts          # schema + full variable resolution check
  lib/
    config-discovery.ts    # walk-up .sous/ discovery; --config/--sous-* + conf.d layer enumeration
    config-kernel.mjs      # single loader subprocess: merges every layer into one JSON config
    config-schema.ts       # zod schema for the merged config; validateSettings; JSON Schema source
    config-inspect.ts      # dot-path lookup + JSON rendering helpers for `config show/get`
    errors.ts              # ConfigError + isConfigError (own module to avoid an import cycle)
    interactive.ts         # the one rule for whether sous may ask a question, and the
                           #   error a prompt that cannot be shown raises
    env-local.ts           # parses .sous/.env.local and .sous/.env into process.env
    sous-home.ts           # the user-level sous dir (~/.sous or $SOUS_HOME) and its subpaths
    env-file.ts            # line-preserving WRITER for those same two files
    settings.ts            # config loader (spawns the kernel), var resolution, scope chain
    markdown-compiler.ts   # CompilationService; @-include, LiquidJS rendering
    include-resolver.ts    # @-include alias/${var}/relative path resolution
    build-service.ts       # orchestrates compile + prune; BuildService
    state.ts               # StateService; tracks written files/dirs per project
    watch-service.ts       # chokidar watcher with debounce; WatchService
    watch-loop.ts          # shared build/compile --watch reload loop (config + template edits)
    pid-service.ts         # PidService; single-instance watcher enforcement via PID files
    repos/                 # the Repositories layer: on-disk formats, loaders, ref parser
      identity.ts          # canonical repository identity; keys everything machine-wide
      index.ts             # barrel; import the whole layer from here
      ref.ts               # parses/formats refs (repo qualifier, namespace/recipe, @range)
      load-manifest.ts     # YAML + permissive-JSON manifest reading; exactly-one discovery
      formats/             # one module per on-disk format, each with schema, type, parseX()
      store/               # the machine-wide recipe store under $SOUS_HOME/cache
        contract.ts        # the store interface every filler and reader is written against
        hash.ts            # hashDirectory: the canonical sha256-<hex> content hash
        recipe-store.ts    # RecipeStore: put/get/has/remove/list/gc, atomic and verified
        settings.ts        # the store's tunables and the defaults sous ships
      links.ts             # the links maps, their merged view, and the .gitignore hygiene
      git-clone.ts         # the injectable git layer `repo link` clones and inspects with
      scaffold/            # string builders + scaffoldRepo(), what `repo init` writes
      release/             # the publish side: `repo release` and `repo submit`
        validate.ts        # findRepoRoot + validateRepo; every publish-side consistency rule
        tags.ts            # release tag naming, listing, reading and creating
        git-state.ts       # what git says about the working tree, branches and remotes
        index-builder.ts   # buildIndex: regenerates sous.index.json from manifests + tags
        plan.ts            # buildReleasePlan: scope, what changed, bumps, tag order
        bump.ts            # raises a recipe version in place, keeping comments
        submit-service.ts  # the whole submit flow, behind the injectable command runner
      ref-search.ts        # which repositories a ref search covered, for the not-found error
      catalog.ts           # pure reads over the cached indexes, the lockfile and the subs
      catalog-inputs.ts    # wires a running command to the catalog; also locates recipe files
      catalog-display.ts   # the shared wording and recipe table the browsing commands print
      subscription-service.ts  # the workflow: add, subscribe, unsubscribe, restore, check
      locked-recipes.ts    # where each locked recipe's files are (a link beats the store)
      locked-namespace-resolver.ts # the real NamespaceResolver, built from the lockfile
      recipe-targets.ts    # subscribed recipe contents -> compile targets; recipeOutputs
      recipe-config-layers.ts  # a recipe's `config` contents, as config layers
    refs/                  # what a word on the command line names; every command resolves
                           #   a reference through this one module
      scopes.ts            # SousScope: repository, namespace, recipe, variable, env var name
      find.ts              # findReference + the per-scope wrappers; the matching and ordering rules
      pick.ts              # pickReference: one match, a question, --accept-first, or the
                           #   shared non-interactive failure
    vars/                  # recipe variable definitions, answers and the resolution ladder
      index.ts             # barrel; import the whole layer from here
      definition-source.ts # where definitions come from; the one wiring seam
      names.ts             # generates the candidate env var names (never parses one)
      ladder.ts            # walks the five rungs and says which name answered
      mappings.ts          # mapping records; writes conf.d/520-var-mappings.jsonc
      validate.ts          # the JSON constraint vocabulary, checked with zod
      ask.ts               # asks what is missing and stores the answers
      preanswers.ts        # answers supplied with --answer / --answers-file, before any question
      question-plan.ts     # what a dry run says a subscription would ask, and where it would go
      resolver.ts          # apt-style ref lookup across every added repo; dependency closure
      trust.ts             # TrustService; added equals trusted, one consolidated question
      managed-layer.ts     # the machine-written conf.d/5xx .jsonc layers; key-path edits
      lock-service.ts      # LockService; read/write/apply/diff the lock, restore the store
      freshness.ts         # when to look upstream; always-pull's in-range lookup
      providers/           # GitHub, GitLab and local: read and write paths, plus the index cache
  templating/
    init-liquid-engine.ts  # LiquidJS engine factory (createLiquidEngine)
    tags/                  # custom Liquid tags: showVars, exportScalarVarsJs, getFiles, listFiles
    filters/               # custom Liquid filters: bulletList
    lib/                   # shared tag helpers: glob-files.ts, tag-args.ts
  utils/
    formatting.ts          # console output helpers (palette, showVariables, paragraph, wrapText, etc.)
    table.ts               # renderTable: the responsive table every listing prints through
    command-help.ts        # printCommandHelpToStderr: a command's own help under an error
    command-errors.ts      # reportCommandError: every failure as a message, traces behind SOUS_DEBUG
    prompts.ts
    sous-directory.ts      # ensureSousDirectory: creates a directory sous owns and writes its
                           #   README.md + AGENTS.md/CLAUDE.md pointers, never overwriting them;
                           #   plus the per-directory wording (conf.d, repos, cache, _indexes,
                           #   $SOUS_HOME). NOT for rendered output directories.
    value-prompt.ts        # the Tab-aware value question used by `sous vars ask`
recipes/                   # the recipes that SHIP INSIDE the package; see "Skills System"
  core/
    sous-skills/           # the core recipe: the offline seed, version-locked to the package
      sous.recipe.yaml     # its manifest; `version` must equal package.json's `version`
      skills/              # about-sous, about-sous-configuration, about-agent-skills,
                           #   about-liquid-templates, create-skill
bin/
  run.js                   # published bin (`sous`): registers tsx, hands off to oclif
  sous                     # bash dev wrapper over run.js, used by the repo's npm scripts
scripts/
  build-schema.mts         # emits sous.config.schema.json from the zod schema (npm run schema:build)
sous.config.schema.json    # committed JSON Schema artifact; shipped in the npm files allowlist
.github/workflows/
  test.yml                 # install, type-check and run the suite on Node 20 and 22
  publish.yml              # the whole release: version, npm publish (OIDC), core recipe
                           #   (the file name is bound to npm's trusted publisher)
docs/                      # the GitHub Pages site (sous-io.github.io/sous)
  index.html               # the animated GSAP presentation page
  markdown/                # the documentation shell (docsify, client-side markdown render)
  css/main.css             # site design system (--sous-* design tokens)
  CLAUDE.md                # GENERATED site instructions (gitignored output); the site's
                           #   full documentation lives there, not here
.sous/                     # THIS repo's own sous config; sous configures itself
  sous.config.js           # the primary config: subscriptions, recipeOutputs, and three targets
  sous.lock.json           # COMMITTED; pins every recipe version this repo builds with
  conf.d/                  # optional drop-in layer dir (*.js|mjs|json|yaml); merged after the primary config
  skills/                  # this repo's OWN skills (skillsRoot); not published as recipes
  prompts/
    root/CLAUDE.md         # tracked SOURCE of the repo-root CLAUDE.md
    docs-site/CLAUDE.md    # tracked SOURCE of docs/CLAUDE.md
    memories/              # memory fragments composed into both of the above
  tasks/                   # per-branch task files (taskFileRoot), gitignored
  .env.local.example       # documents the machine-specific env layer (.env.local); .env holds shared defaults
deprecated/                # archived, gitignored
docs/notes/                # planning docs and TODOs, gitignored
```

### The Repositories layer (`src/lib/repos/`)

Every on-disk format of the Repositories system lives in `src/lib/repos/formats/`, one module
per format, each exporting its zod schema, the inferred TypeScript type and a `parseX(value,
sourceLabel)` helper that throws a `ConfigError` naming the file and the path of every bad
field. `formats/patterns.ts` holds the shared regular expressions and imports nothing, so
`config-schema.ts` can reuse them; `formats/common.ts` composes them into the primitives the
formats share. `ref.ts` parses BOTH grammars, `identity.ts` derives canonical repository
identity, `load-manifest.ts` reads manifests off disk
(YAML, or JSON with comments and trailing commas; never JavaScript, because repo trust rests
on reading a repository without running its code), and `index.ts` is the barrel every later
phase imports from. Hand-written formats reject unknown keys except a reserved `x-` extension
namespace; machine-written formats reject them outright and serialize with sorted keys.

**Two ways of naming a repository, and they are not interchangeable.** A SHORT NAME
(`sous-recipes`) is one project's own label: it keys `repos:` in a config and in a lockfile, and
it is what sous prints. A CANONICAL IDENTITY (`github.com/sous-io/sous-recipes`, from
`repoIdentity()` in `identity.ts`) keys everything shared between projects on a machine: the
store layout, the store entry marker's `repo` field, the index cache, and each lockfile
`repos:` entry's `identity`. Anything machine-wide that a short name keys is a bug; nothing
migrates an old store, it is simply re-fetched. That lockfile `identity` is OPTIONAL ON READ
and required on the written shape: `lockedRepoSchema` in `formats/lockfile.ts` derives a missing
one from the entry's `url` through `requireProvider(url).canonicalize(url)`, so a lockfile
written before the store was re-keyed still loads and fills the field in on its next write. `ref.ts` also holds `parseDependencyRef`, the
manifest-side grammar: a bare sibling ref, or a locator URL whose scheme is the provider id and
whose last two path segments are ALWAYS the namespace and recipe (a first segment with a dot is
the host, otherwise the provider's default). `local://` and `repo:` are both refused there.

`store/` holds the machine-wide recipe store: one immutable directory per recipe version at
`<storeRoot>/<identity>/<namespace>/<recipe>/<version>/`, with the `.sous.entry.json` marker
INSIDE it. The identity is several segments, so `list()` walks for markers rather than counting
directory levels. `RecipeStore` (`store/recipe-store.ts`) stages a write in a temporary sibling
directory, hashes it, verifies it against the caller's expected hash and renames it into
place, so a crash leaves either the old entry or the new one; `get()` re-verifies the hash on
every call, removes an entry that no longer matches and reports it as absent through the
`onWarning` sink. `hashDirectory` (`store/hash.ts`) is the canonical content hash: files in
bytewise path order, each contributing path, byte length and bytes, with `.git`, the marker
and file modes excluded. SYMLINKS ARE SKIPPED by the hash AND by `copyTree` in
`recipe-store.ts`, and so is anything under a linked directory: the two must agree, or a
consumer's `put()` computes a hash the index does not carry and every install fails. A link
points at bytes the repository does not own, so following one made a published version hash
differently per machine; `release/validate.ts` refuses to publish a recipe folder containing
one. `resolveStoreSettings` (`store/settings.ts`) applies the defaults for
the optional top-level `store:` config block.

The store lives under the USER-LEVEL sous directory, resolved by `src/lib/sous-home.ts`:
`~/.sous`, or `$SOUS_HOME`. `SOUS_HOME` does NOT decide which project is active, so unlike
`SOUS_CONFIG`, `SOUS_DIR` and `SOUS_CONFD` it is file-settable from `.sous/.env.local` and
`.sous/.env`; every resolver there reads `process.env` at CALL time and nothing may capture
the value at import time. Nothing under `$SOUS_HOME` is configuration: the user-level config
layer is a separate effort.

The formats themselves, field by field, are documented in
`docs/markdown/repositories-file-formats.md`; that page is the reference (including the store
layout), and this file only points at it.

**Editable checkouts.** A LINK redirects one repository away from the store and at a real
working copy, which is how a maintainer edits recipes. `links.ts` reads the project's
`.sous/sous.links.json` and the machine-wide `$SOUS_HOME/sous.links.json` and merges them with
the project's entries winning; `describeLinkedRepos()` returns the lines a build prints so a
link is never a silent change to what a build produces. Cloning and checkout inspection go
through `git-clone.ts`, which shells out to the user's own `git` (so their credentials and
configuration apply) behind an injectable runner, so nothing in the tests needs git or a
network. `resolveSousHomeDir()` in `links.ts` is a private stand-in for the shared
`resolveSousHome`, marked with a TODO for the swap.

**Publishing (`repos/release/`).** A recipe's METADATA is the source of truth for its
version; a git tag shaped `namespace/recipe@1.2.3` is a convenience ref, and the two must
agree. `validateRepo` (`release/validate.ts`) checks everything that can be checked without
git: each listed recipe folder exists and holds a manifest, each recipe is in a declared
namespace, no two recipes share a key, and no two variable definitions of DIFFERENT names
claim one environment variable (two definitions of the SAME name may, since that is the shared
rung of the ladder doing its job). Claiming a well-known system or secret name warns unless
the definition carries `x-intentional: true`, which is read from the RAW manifest because the
schema drops every `x-` key before validation. `buildIndex` (`release/index-builder.ts`)
regenerates `sous.index.json` under three rules: a published version is immutable, so its hash
is carried forward and a disagreement is an error; a version is published only when a tag
carries it, so an untagged version is left OUT of the index (the schema requires a tag on
every entry) and reported as pending instead; and every tagged version missing from the index
is rebuilt from its tag, so a lost index regenerates whole. Reading a tagged tree goes through
`withTaggedTree` (`release/tags.ts`), which adds a linked git worktree rather than piping
`git archive`, because the injectable command runner captures output as text and an archive's
bytes would not survive that. Every git call in this directory takes the runner from
`providers/git.ts`, so no test needs a network.

**Ignore hygiene.** `ensureReposIgnoreFiles(sousDir)` writes `.sous/repos/.gitignore` holding a
single `*` (which covers the ignore file itself, so the directory contributes nothing to the
project's repository) and maintains a delimited managed block inside `.sous/.gitignore` listing
`sous.links.json`, `sous.state.json`, `sous.pid` and `repos/`. Only the lines between the
markers are ever rewritten; anything above or below them is left alone, and an opening marker
with no closing partner is a hard `ConfigError` rather than a guess. Both files are written
only when their contents would change, so linking repeatedly never produces a diff.

**Self-describing directories.** Every directory sous creates for its OWN bookkeeping is created
through `ensureSousDirectory(dir, readme)` in `src/utils/sous-directory.ts`, which writes a
`README.md` explaining the directory plus an `AGENTS.md` and a `CLAUDE.md` holding one pointer
line each, and never overwrites any of the three. The named wrappers in that module own the
wording for `conf.d/`, project and global `repos/`, the store root, `_indexes/` and `$SOUS_HOME`
itself; a new sous-owned directory gets a wrapper there rather than a bare `mkdirSync`.
Directories a compilation target RENDERS INTO are excluded, and so is `.sous/` itself: what is
there belongs to the user.

### Variables and answers (`src/lib/vars/`)

Recipes publish variable DEFINITIONS (specifications); a project's env files hold the
ANSWERS. `definition-source.ts` is the only place that knows where definitions come from:
`loadProjectDefinitions(settings, sousDir)` is the seam the subscription resolver replaces,
`FileDefinitionSource` reads a standalone definitions file for `sous vars ask --file`, and
`StaticDefinitionSource` backs the tests. `names.ts` GENERATES candidate environment
variable names and nothing ever parses one back into scopes (`_` is both delimiter and
identifier character, so no parse would be trustworthy). `ladder.ts` walks five rungs, most
specific first: a mapping record, the recipe-scoped name, the namespace-scoped name, the
shared name, then the definition's own declared name; inside a rung the real shell
environment beats `.sous/.env.local` beats `.sous/.env`. That is why `BaseCommand` snapshots
`process.env` into `this.shellEnv` BEFORE `loadEnvFiles` injects the files: afterwards the
layers are indistinguishable. `mappings.ts` binds an arbitrary env var name to one fully
qualified variable under the top-level `varMappings` config key, writing sous's own records
into the managed `conf.d/520-var-mappings.jsonc` layer (one key-path edit per record, through
`updateManagedLayer`). `ask.ts` keeps and reports the answers already in scope, asks for
the rest, stores each through `src/lib/env-file.ts`, and fails a run with no terminal by
naming the env vars that would answer. It decides everything BEFORE printing anything, so it
can open with how many answers each recipe needs; questions then run per recipe, the
subscribed one first (a subscribe calls it only after the closure resolved and every new
repository was trusted, never interleaved). Each question prints a basic view (whose last line
is the hint from `questionHint`, which says what Enter does for THIS kind of question) and then
one of the three custom prompts, all built on `createPrompt` from `@inquirer/core`, a DIRECT
dependency for exactly this: `value-prompt.ts` for a typed answer, `choice-prompt.ts` for an
enum, `confirm-prompt.ts` for a boolean or a confirmation. All three answer the same way, so
Enter answers and Tab resolves with `{ kind: "advanced" }` from EVERY kind of question, opening
the advanced view, whose menu changes the storage file or the stored env var name and can save
or discard. A secret may still be pointed at the committed
file, after a warning and a confirmation; informed consent, not prevention. The labeled facts
block (`@default`, `@example`, `@required-by`, `@defined-by`, `@storage-path`, `@stored-as`,
`@constraints`) is ONE renderer in `display.ts`, used by the basic view (narrowed to
`BASIC_FACT_LABELS` via `selectFacts`), the advanced view and `sous vars show`, so neither the
vocabulary nor the indentation can drift; `renderFacts` indents the block itself, so no caller
adds its own. `env-file.ts` is the write
half of `env-local.ts`: it parses a line model, rewrites exactly one value line or appends
one under a generated header comment, and writes atomically, so comments, order and quoting
survive. Comments are output only and are never read back.

`preanswers.ts` is the other way a question gets answered: `--answer <name>=<value>` (split
on the FIRST `=` only) and `--answers-file <path>` (a YAML or permissive-JSON map, laid under
the flags), on both `sous subscription add` and `sous vars ask`. `validateProvidedAnswers`
runs before anything is installed or written, so a value that does not fit its definition or
a name no recipe declares fails the whole run; `applyProvidedAnswers` then stores what is
left the way the interactive flow would, overwriting an existing answer WHERE IT LIVES rather
than under a name a lower rung would shadow, and `askForMissing` skips those keys through its
`skip` option. `question-plan.ts` is what `subscription add --dry-run` prints after the plan:
every variable the closure declares, grouped by recipe, through the same `renderFacts`
renderer. A dry run downloads nothing, so a recipe the store does not hold yet has no manifest
to read; that is reported (`SubscribeOutcome.unreadable`) rather than being fatal.

The ladder, the env files, the mapping records and the `sous vars` commands are documented
in `docs/markdown/repositories-variables.md`.

Above the formats sit the read-path services. `providers/` holds the internal provider
interface plus the GitHub and GitLab built-ins: an index is one raw HTTPS GET (with a bearer
token from the environment, or from `gh` / `glab` when either is installed and signed in), and
a recipe is a shallow, blobless, sparse checkout of its own folder, never a whole repository.
Every network and subprocess seam is injectable, so no test in this layer touches either.

The interface has two sides, and BOTH are the only place a host-specific fact may live.
Read: `matches`, `canonicalize`, `fetchIndex`, `fetchRecipeTree`. Write: the optional `cli`
descriptor and `proposalNoun`, plus `authStatus`, `canPush` (undefined means unknowable, which
is not `false`), `fork` and `proposeChange`; each returns plain data and takes the injectable
runner through `ProviderOptions` (which also carries `cwd`). `features` is what callers
consult, never a provider id; `supportsSubmit()` narrows a provider to one that answers the
whole write path. A new provider is ONE file: a class extending `ProviderBase`
(`providers/base.ts`), which owns the shared subprocess, token and URL helpers and answers
every write call a provider did not override with a ConfigError naming the provider and the
feature, plus a line in `builtInProviders()`. No service above `providers/` may name a host,
spawn a host tool, or build its arguments.
`providers/index-cache.ts` keeps one index per repository under the store root's `_indexes/`
directory, filed by canonical identity (so the path is nested), and falls back to the copy it
already holds when a check fails; its messages take a `label` so a person still reads their own
short name. `resolver.ts` looks a bare ref up across every added repo at once and refuses an
ambiguous one instead of picking a winner. A manifest's dependency is different: a SIBLING
resolves inside the declaring recipe's own repository, and a LOCATOR matches an added repository
by identity whatever short name it has there. A dependency naming a repository the project has
not added is returned as a `MissingRepo` carrying its URL, identity and provider, so the trust
round can offer to add it; when the parent's index records resolved dependencies, those exact
versions are asked for instead of the declared ranges. Because the walk resolves refs in the order it meets them, a
recipe can be walked at one version and again at a lower one once a second holder narrows it;
`keepOnlyReachable` then re-walks the settled closure and drops whatever only the replaced
version reached, trimming each survivor's `requestedBy`, `ranges` and `kind` to what still
declares it. It never re-picks a version, since trimming only removes constraints and
re-picking could undo the narrowing. `trust.ts` asks about those in one consolidated question and
fails hard without a terminal unless the confirmation flag was passed, writing accepted repos through
`managed-layer.ts`. `lock-service.ts` applies a resolution to the lockfile, refcounts removal,
and restores the store to exactly what the lock pins without prompting or changing a version;
`freshness.ts` decides when sous looks upstream at all.

`providers/local.ts` is the third built-in provider, id `local`: a repository that lives on
this machine, named by a path or by the same path in `file:///...` form. It exists for local
development and for tests, and its trust semantics are IDENTICAL to a hosted one; a local
path is added, and therefore trusted, through the same ceremony, because the recipes in it
still run here. A relative path typed at `sous repo add` or `sous repo link` is expanded
(`~` included) and resolved against the working directory by `resolveRepoArgument` BEFORE
provider detection, and the absolute form is what is stored; a path that does not exist, or
holds no repo manifest, gets an error about the path itself rather than about providers.
An explicit `--provider` that contradicts the URL (naming `github` for a path, say) is
refused whenever a different provider does recognize it, while an unrecognized host with a
named provider is still honored, which is what a self-hosted instance needs. It reads the index from the working tree when there is one (so an index
being authored is picked up) and from `git show HEAD:sous.index.json` otherwise, and fetches
a recipe by cloning the local path at the version's tag, falling back to a copy for a
directory that is not a git repository. It is what makes an end-to-end CLI test possible
with no network at all.

**The consumer surface.** `subscription-service.ts` is the one place that puts the parts
above in the right order, and the order IS the design: nothing is fetched from a repository
before it is trusted; resolution is iterative, with one consolidated trust question per
round; the store is filled only after a version is settled; and a subscription is not
finished until the variables its recipes publish have been answered. `SubscriptionService`
takes every collaborator as an injectable option, and `subscriptionServiceFor({
configContext, settings, shellEnv })` builds one from what a running command already has.
Its methods are `addRepo`, `subscribe`, `unsubscribe`, `listSubscriptions`, `restore`,
`checkUpstream`, `needsRestore` and `prepareForBuild`. Two steps run inside `subscribe` BEFORE anything is
fetched or written, on the cached indexes alone: a one-word ref is resolved to a fully
qualified one through `src/lib/refs/` (over the namespace and recipe scopes; several
matches ask, `--accept-first` takes the first), and then the plan is printed and confirmed (the confirmation flag skips the question,
a dry run states the plan and never asks, declining aborts with nothing written). Keep
that order: the confirmation is worthless once a manifest has been fetched to read it,
which is why the plan names untrusted dependency repositories only as far as what is
already on disk knows, and leaves the real answer to the trust ceremony during resolution.
Unsubscribing drops the project's own
hold on the recipes one subscription pulled in and lets the lockfile's refcounting decide
what actually goes. A subscription sous provides itself has no entry to delete, so removing
one writes `{ enabled: false }` into the managed 510 layer instead; every reader of the
project's subscriptions drops a switched-off entry, and subscribing again replaces it.

**Always-pull never widens a range.** `checkUpstream` asks
`effectiveRangeForHolders` (`freshness.ts`) what range each locked entry may move within,
and passes the answer to `findNewerInRange`. The range comes from the entry's HOLDERS: the
`project` holder means the subscription's range, and a recipe holder means the range that
recipe's manifest declares in `depends`, re-derived from the manifest because no
subscription carries it. Several holders are ANDed into one range. When any holder's
declaration cannot be read, the answer is `undefined` and the entry does not move; never
fall back to `*` here, since that is exactly how a `depends`-held recipe used to escape the
constraint its parent declared. `applyResolution` in `lock-service.ts` merges holders rather
than replacing them, for the same refcounting reason.

**Where a locked recipe's files are.** `locked-recipes.ts` answers that once, for everyone
who needs it: a LINKED repository is read from its working copy (a link is a deliberate
instruction to bypass versions and the lockfile), and everything else from its immutable
store entry at the pinned version. A recipe the store does not hold yet comes back with
`present: false` rather than an error, so a fresh clone can be restored instead of refused.
`locked-namespace-resolver.ts` builds the real `NamespaceResolver` from that plus each
recipe's declared `depends` and `subscribes`; `vars/definition-source.ts` reads the same
list for `sous vars`; `recipe-targets.ts` turns it into compile targets.

**Recipe outputs.** `recipe-targets.ts` turns each subscribed recipe's manifest `contents`
into ordinary `entryGlob`-style compile targets: the recipe directory is the glob root, the
static part of each include pattern is the base the output tree mirrors, and the `.tpl.`
convention applies unchanged. Only recipes held through `subscribes` contribute files; a
recipe held only through `depends` is fetched, pinned and addressable from the recipe that
declared it, and its files never enter the output. Destinations come from the top-level
`recipeOutputs` config key (`{ skills?: string[], memories?: string[], prompts?: string[] }`,
each `${var}`-substituted). Only `skills` has a default, `<project root>/.claude/skills`;
a kind with no destination is skipped with ONE warning naming the key, because sous cannot
guess where a project wants its memories or its prompts. `BuildService` appends these
targets to the project's own, so compile, prune and clear all see them, and prune counts
them file by file rather than by their shared destination directory (every recipe writes
into the same one, so a directory prefix would leave an unsubscribed recipe's files behind
forever). `resolveOutputPath` in `markdown-compiler.ts` is the one definition of where a
target's output lands, shared by the compiler and prune.

**What a build does with all this.** `sous build` announces every linked repository loudly
before it compiles (`describeLinkedRepos`), restores whatever the store is missing, and asks
upstream for the repositories that prefer a newer in-range version; a failed check is warned
about and the last good answer stands. Watch mode watches every linked checkout (they are in
`fullRebuildPaths`) and polls upstream on `store.watchPollSeconds`. Prune and clear never
reach into a linked checkout or the store: `protectedRepoPaths` names the three roots and
`StateService.deleteTrackedFiles` refuses to touch anything under them, whatever the state
file claims.

## Config Discovery

There is no user-level config LAYER; no configuration is read from the user-level sous
directory (`~/.sous`, or `$SOUS_HOME`), which holds only machine-wide state such as the
recipe store. Every command locates its config the same way, in `BaseCommand.init()` (see
`config-discovery.ts`).

**Locating the primary config.** Precedence, highest first (flag beats env; both beat
walk-up):

1. `--config <path>` (`-c`), or its alias `--sous-config <path>`.
2. `SOUS_CONFIG` env var.
3. `--sous-dir <path>` flag.
4. `SOUS_DIR` env var.
5. Walk UP from cwd for the first `.sous/` directory holding a primary config. A `.sous/`
   without one does not stop the walk.

Every flag/env value resolves with the same rules: it may point at a config file, a
directory holding one, or a directory whose `.sous/` child holds one (so `--config .`
works from a project root). The `SOUS_*` env vars are read from the REAL environment
ONLY, never from `.env.local`; they decide where `.env.local` itself lives, so they must
be resolved first. An empty or whitespace-only value (e.g. a bare `export SOUS_CONFIG=`)
is treated as unset, not as a path (`blankToUndefined` in `base-command.ts`). Error
messages name the source the user actually set (`--sous-dir`, `SOUS_CONFIG`, etc.), not
always `--config`.

**One primary config, exactly one.** A `.sous/` may hold exactly one of
`sous.config.js`, `sous.config.mjs`, `sous.config.json`, `sous.config.jsonc`,
`sous.config.yaml`. Two or more
is a hard `ConfigError` (`findConfigInSousDir`); sous never silently first-match-wins.

**The `conf.d/` layer directory.** Every `*.{js,mjs,json,jsonc,yaml}` file directly inside
`<sousDir>/conf.d/` (non-recursive) is a config layer, loaded AFTER the primary config and
deep-merged over it. Layers are ordered by a bytewise (locale-independent, per-machine
stable) filename sort, NOT numeric: `10-x.json` sorts BEFORE `2-x.json`, so zero-pad
numeric prefixes (`02-`, `10-`) if ordering matters. Override the directory with
`--sous-confd <path>` or `SOUS_CONFD` (flag > env > `<sousDir>/conf.d`); an empty value is
unset. Every loaded layer (the primary config plus all `conf.d/` layers) must have a
unique baseName once its FINAL extension is stripped: `500-repos.json` and
`500-repos.jsonc` collide and are a `ConfigError` (`assertUniqueLayerBaseNames`), since
their merge order would otherwise hinge on extension; that rule is also what keeps a layer
mid-migration to `.jsonc` from loading twice.

**`.jsonc` is accepted everywhere `.json` is**: a primary `sous.config.jsonc`, any
`conf.d/` layer, a config layer a recipe contributes, and a repo or recipe manifest. It is
JSON plus line comments, block comments and trailing commas, parsed with `jsonc-parser`
(the kernel imports it directly, being plain `.mjs`). `.json` itself stays strict.

**Config layers from recipes.** A subscribed recipe may contribute `config` content, and
those files are config layers too. They load AFTER the primary config and BEFORE the
`conf.d/` layers, so a recipe supplies defaults and the project always wins over them.
`listRecipeConfigLayers` (`repos/recipe-config-layers.ts`) enumerates them from the
lockfile, the links map and the store alone, because this has to work before the settings
exist. Only `.json`, `.jsonc`, `.yaml` and `.yml` are accepted from a recipe: the kernel would happily
import a `.js` layer, and the whole trust story rests on sous reading what a repository
publishes without running any of it, so an executable layer from a recipe is refused with a
warning.

A recipe layer is READ by `listRecipeConfigLayers` and filtered to
`RECIPE_CONFIG_ALLOWED_KEYS` (`filterRecipeConfigLayer`) before anything merges; the
already-parsed, already-filtered object is handed to the kernel as an inline
`{ path, config }` source, so the kernel never opens a recipe's layer file. A recipe may
set only keys that configure the recipe itself, and every other key is dropped with a
warning naming the recipe and the key. Subscribing to a recipe is not a decision to let it
choose what the project trusts or what sous runs, so `repos`, `subscriptions`, `tools` and
`_env` in particular can never come from one. Change the allowlist only in
`recipe-config-layers.ts`, and keep `docs/markdown/repositories-consuming.md` and
`docs/markdown/repositories-file-formats.md` in step with it.

Recipe layers are deliberately left out of the duplicate-baseName check; that check exists
so a person never has to guess which of two files THEY wrote merges last, and a recipe's
file names are not theirs to rename. `BaseCommand.init()` enumerates them twice: once
during discovery, and again through `refreshDiscoveredConfig` after the env files load,
because `SOUS_HOME` is file-settable and it decides where the store is.

**Env files.** Before any variable resolves, sous loads `<sousDir>/.env.local` then
`<sousDir>/.env` into `process.env` (`env-local.ts`). Precedence, highest first: real
shell environment > `.env.local` (gitignored, machine-specific/secret) > `.env`
(committed, shared team defaults). No load ever overwrites an already-set value, so the
first writer wins and `FOO=bar sous build` beats both files. Syntax is small and
deliberately not a shell: `KEY=value`, `#` comments, optional `export ` prefix,
single/double-quoted values (`\n`/`\t` expand inside double quotes), inline `# comment`
stripped from unquoted values; lines without `=` are ignored.

**The config kernel.** All layers are loaded by ONE subprocess, `src/lib/config-kernel.mjs`
(spawned by `loadSettings` in `settings.ts`; plain `.mjs` so it runs under bare Node and
under the tsx loader alike). Two spawn attempts are made in order (plain `node`, then
`tsx --import` so a config may use TypeScript syntax); the subprocess avoids the
require(esm) cycle a direct `import()` would trigger. The kernel loads each layer in
order, JSON-forces it, and deep-merges it into one live cumulative config:

- `.json` → `JSON.parse`; `.yaml` → the `yaml` package.
- `.js`/`.mjs` → dynamic import (see the JS contract below).
- Every layer object is forced through a JSON round-trip BEFORE merging, so functions,
  RegExp, Date and `undefined` drop at the layer boundary; the final config is round-
  tripped once more on the way out.
- **Deep merge** (`deepMerge`): plain object + plain object → recurse; array + array →
  concatenate (target then source, NO dedupe); anything else → source replaces. An OWN
  `__proto__` / `constructor` / `prototype` key that survives the JSON round-trip is
  skipped (prototype-pollution guard).
- Any layer failure (parse/import error, `configure()` throw, cycle, old multi-project
  schema) names the exact layer file on stderr and exits non-zero; the parent wraps it in
  a `ConfigError`.

**Validation.** After the kernel merges everything, the merged config is checked by
`assertFlatConfig` (rejects the removed `projects:`/`defaultProject` schema with a
migration message) and then by the zod schema in `config-schema.ts` (`validateSettings`).

One config = one project. The config is flat: `version`, `$schema`, `name`, `_env`,
`_vars`, `_aliases`, `compilation`, `runtimeContext`, `tools`, `repos`, `subscriptions`,
`store`, `recipeOutputs` and `varMappings` all live at the top level. The last five belong
to the Repositories system; see `docs/markdown/repositories-file-formats.md` for their
shape. There is no `$comment` key: the machine-written layers are `.jsonc` and carry a real
header comment instead (`repos/managed-layer.ts`, `vars/mappings.ts`).

**The entries sous provides itself.** Two config entries are laid UNDER whatever the layers
produced, after the kernel merges and before the schema validates (`applyRepoDefaults` in
`repos/defaults.ts`): the repository `sous-recipes`, and a `core` namespace subscription whose
range is exactly the running sous version. They are ordinary entries, so `sous config show`
prints them and `sous repo list` marks the repository "built in" (their `addedBy` is `sous`).
The merge is per FIELD, which is what makes the shortest opt-out a complete entry:

```js
subscriptions: { core: { enabled: false } }      // keep the repository, drop the skills
repos: { "sous-recipes": { enabled: false } }    // drop the repository entirely
```

`enabled` defaults to true on both `repos` and `subscriptions` entries. A disabled entry stays
in the config, so the opt-out is legible, and takes part in nothing; `enabledRepos` and
`enabledSubscriptions` are what every read path calls. Switching the repository off also
withdraws the core subscription, since it could not resolve without it.

State and PID files default into the discovered `.sous/`: `sous.state.json` and `sous.pid`
(unprefixed; one config is one project). Override with the `stateFilePath` / `pidFilePath`
config vars.

### Sous Configures Itself

This repo has its own `.sous/sous.config.js`, and it gets its skills the way any other
project does: it subscribes to recipes published by `sous-io/sous-recipes` and pins them in
the COMMITTED `.sous/sous.lock.json`. Three sources feed `.claude/skills/`:

- `core/sous-skills`, which every project gets without asking. It is not listed in the config
  at all; sous provides that subscription itself, and `recipes/core/sous-skills/` at the root
  of this repository is its source.
- The subscriptions the config declares: `workflow/task-files`, `workflow/github-projects` and
  `communication/control-flow`, written into `recipeOutputs.skills`.
- This repository's own skills in `.sous/skills/`, compiled by the `projectSkills` target.

`tool-usage/automated-browser-tasks` is deliberately NOT subscribed to: it needs
`browserAutomationScriptsDir` pointing at a real script directory, and sous has none.

The config also generates two instruction files from tracked sources under `.sous/prompts/`:

- `.sous/prompts/root/CLAUDE.md` -> `/CLAUDE.md` (this file)
- `.sous/prompts/docs-site/CLAUDE.md` -> `/docs/CLAUDE.md` (the website doc)

The fragments both sources `@`-include live in `.sous/prompts/memories/`. In this project a
MEMORY is a fragment composed into an agent's always-loaded instruction file; a PARTIAL is a
fragment that other content includes. These are memories, so that is what the directory is
called; add a new one there and include it from every instruction file it belongs in.

`sous-recipes` needs no `repos:` entry here; it is built in. The lockfile IS committed, and it
is the point: a colleague, a fresh clone or CI builds this repository from exactly the recipe
versions it records, with no prompts.

**Sous's own task management:** tickets are GitHub issues in `sous-io/sous`, tracked on
the "Sous" GitHub Projects v2 board (https://github.com/orgs/sous-io/projects/1, statuses
Backlog → Ready → In Progress → In Review → Done). Ticket IDs are written `gh-<number>`
(issue `#47` → ticket `gh-47`, branch `lc/gh-47-short-desc`); the `gh-` prefix keeps them
greppable in branch names. Per-branch task files live in `.sous/tasks/` (gitignored). The
board, Status field and option IDs are recorded as `github*` vars in `.sous/sous.config.js`
and compiled into the skills.

Both compiled CLAUDE.md files are gitignored OUTPUTS (`/CLAUDE.md` and `/docs/CLAUDE.md`
in `.gitignore`); only the sources in `.sous/prompts/` are tracked. Never edit the
compiled copies; edit the sources and run `npm run sous:build`. A fresh clone has no
root CLAUDE.md until the first build (`npm run claude` builds before launching).

`.claude/`, `.codex/`, `.sous/sous.state.json`, `/CLAUDE.md` and `/docs/CLAUDE.md` are
gitignored build output.

## Project Settings File

A `.js`, `.mjs`, `.json` or `.yaml` file in a project's `.sous/` directory, optionally
layered by `conf.d/` drop-ins (see Config Discovery). One config describes one project;
everything is at the top level. Example shape:

```js
export const config = {
  version: 1,                          // optional; when present must be 1
  name: "My Project",                  // optional display name
  _env: { userHome: "HOME" },          // map config vars to env vars (top-level only)
  _vars: {
    codeBase: "${userHome}/Projects/my-project",
    // ${sousDir} is the discovered .sous/ dir, so this needs nothing machine-specific.
    projectRoot: "${sousDir}/..",
  },
  compilation: {
    targets: [
      {
        entryPoint: "${projectRoot}/prompts/AGENTS.md",
        generateRuntimeContext: true,
        outputs: [{ destinationFile: "${projectRoot}/AGENTS.md" }],
      },
      {
        entryGlob: "${projectRoot}/configs/skills/**/*.md",
        outputs: [{ destinationDir: "${projectRoot}/.claude/skills" }],
      },
    ],
  },
  tools: {
    claude: { command: "claude", promptFile: "${projectRoot}/CLAUDE.md" },
  },
};
```

A JSON config may set `"$schema": "..."` (accepted and ignored by sous) to bind itself to
the shipped `sous.config.schema.json` for editor autocompletion and external validation.

### JS/MJS Config Contract

A `.js`/`.mjs` layer may export a config object, a `configure` function, or both:

- **Object**: `export const config = {...}`, or a `default` export that is a non-function
  object. Merged into the cumulative config first.
- **Function**: `export function configure(currentConfig, builder)`, or a `default`
  export that is a function. Runs AFTER the object (if any) merges, and is awaited (it may
  be async). It can mutate `currentConfig` by reference freely; a returned object is merged
  after it resolves, UNLESS the return value IS `currentConfig` itself (the
  mutate-and-return-for-chaining idiom), which is skipped so arrays are not duplicated.

The `builder` passed to `configure` exposes: `builder.config` (the live cumulative
config), `builder.sousDir`, `builder.confDir`, `builder.currentFile`, `builder.env(name,
fallback)`, `builder.merge(obj)`, and the async sub-loaders `builder.loadConfig(path)` /
`builder.loadConfigs(globPattern)`. Builder paths resolve BEFORE variable resolution, so
user `_vars` do not exist yet: only the auto-vars `${sousDir}`, `${sousConfDir}`,
`${sousRootPath}` and `${sousVersion}` may appear in them (any other `${var}` is fatal);
relative paths resolve against the layer file that used them. Sub-load cycles are detected
and named.

### Managed 5xx layer convention

`conf.d/500-*` through `conf.d/599-*` is a band reserved for layers the sous CLI writes
for you (`sous repo add` writes `conf.d/500-repos.jsonc`, `sous subscription add` writes
`conf.d/510-subscriptions.jsonc`, and `sous vars ask` writes
`conf.d/520-var-mappings.jsonc`). They are `.jsonc`, each opening with a header comment
stating the policy: sous edits these files by key; you may edit them too. Writes go through
`updateManagedLayer` (`repos/managed-layer.ts`), which applies key-path edits with
`jsonc-parser`'s `modify` + `applyEdits`, so a user's comments, key order and formatting
survive; new keys are inserted sorted, and the write is atomic (staged, then renamed). A
layer still under its old `.json` name is read as a fallback and migrated (the `.jsonc` is
written, the `.json` removed) by the first write. Sous never edits a user's hand-written
primary config or non-5xx layers. Where a comment property is ever unavoidable in a strict
JSON file, the convention is a `//` key, ignored everywhere; nothing writes one today.

## Variable Scoping

Resolution order (later overrides earlier):

```
auto-vars  →  _env scope  →  _vars  →  compilation _vars  →  target _vars  →  output _vars
```

- `_vars` blocks use `${varName}` syntax (resolved by Sous internally by a fixpoint loop)
- Template files use `{{ varName }}` syntax (resolved by LiquidJS at render time)
- `_env` is top-level only; maps `configVarName: "ENV_VAR_NAME"`
- Reserved `sous*` namespace: do not define vars starting with `sous`

**Fixpoint resolution.** Each `_vars` block resolves by a fixpoint loop (`resolveScope` in
`settings.ts`), not a one-pass topological sort: every round re-scans every still-
unresolved entry and finalizes any whose `${refs}` all resolve, repeating until a round
finalizes nothing. Declaration order therefore does NOT matter; `{ file: "${root}/x",
root: "/data" }` resolves as readily as the reverse. When the loop stops with entries still
unresolved, that is a hard `ConfigError` (never a silent literal `${var}`): the message
names each stuck entry and separates reference CYCLES (entries depending on each other)
from UNDEFINED references (names defined nowhere), then lists the variables that ARE in
scope. Every value Sous acts on (entry points, destinations, prompt files) also goes
through `substituteVarsStrict`, which raises a `ConfigError` on any leftover `${var}`.

Auto-injected vars always available:
- `sousRootPath`: absolute path to the Sous CLI install directory
- `sousVersion`: current CLI version
- `sousDir`: the discovered `.sous/` directory holding the active config
- `sousConfDir`: the `conf.d/` drop-in directory for the active config
- `sousConfigPath`: absolute path to the active (primary) config file
- `sousHome`: the user-level sous directory (`~/.sous`, or `$SOUS_HOME`); holds the
  machine-wide recipe store and globally linked checkouts. Resolved from `process.env` on
  every call, because `SOUS_HOME` is file-settable (see `src/lib/sous-home.ts`)
- `sousTemplatePath`: absolute path to the `.tpl.` file currently being rendered (render-time only)
- `sousTemplateDir`: directory of the `.tpl.` file currently being rendered (render-time only)

Absolute `entryPoint`, `globBase`, `destinationFile` and `destinationDir` values are
normalized after substitution (`normalizeConfigPath` in `settings.ts`), so `${sousDir}/..`
collapses to the parent directory. This is required, not cosmetic: Sous writes files via
`path.join` (already normalized) while prune decides what is current by string-prefixing
tracked destinations against `destinationDir`. An un-normalized `destinationDir` matched
nothing and prune deleted everything compile had just written.

### Variables a Recipe Needs

Sous no longer keeps a hand-maintained list of the variables its prompts want; a recipe
PUBLISHES its own variable definitions in its manifest, and `sous vars list` lists every one
in play for the current project, with its environment variable, its value, where that value
came from, and what is still unanswered. `sous vars show <name>` shows one in full and
`sous vars ask` answers what is missing. Read the definitions, not a table here.

Two systems meet in a template, and it is worth knowing which is which. A recipe's variable
DEFINITIONS are answered in the project's env files and resolved through the five-rung ladder
in `src/lib/vars/`; a project's own `_vars` and `_env` are the zero-ceremony system, and they
are what a `{{ variable }}` in a template renders from. The engine runs with
`strictVariables: false`, so an undefined variable renders as an empty string: nothing fails,
the output just silently loses the value (a path becomes `/[branch-name].md`). So define, in
`_vars`, every variable the recipes you subscribe to name; `sous vars list` is how you find out
which those are.

## The `.tpl.` Convention

- Files **without** `.tpl.` in their name are copied verbatim (no LiquidJS processing)
- Files **with** `.tpl.` are rendered through LiquidJS; `.tpl.` is stripped from output filename
  - e.g., `agent.tpl.md` → `agent.md`
- The `.tpl.` convention applies to both `entryPoint` and `entryGlob`/`destinationDir` targets

## Include Syntax (Markdown Compiler)

In any source `.md` file, `@path/to/file.md` on its own line includes that file's content:

```markdown
@sections/context.md
@../shared/intro.md
@${projectRoot}/prompts/x.md
@~project/prompts/intro.md
@~workflow/task-files/_partials/resume.md
@myAlias/doc.md
```

Lines inside fenced code blocks (``` or ~~~) are NOT processed as includes; they are
left verbatim, which is what allows this very section to document the syntax in a
compiled file. Guarded by the fence tests in `src/test/integration/compilation.test.ts`.

Resolution is handled by `src/lib/include-resolver.ts` (`resolveInclude` /
`resolveIncludeCandidates` + `buildAliasMap`), wired into
`CompilationService.processIncludes` and the `{% render %}` engine FS (so aliases and
namespaces work in both). A `@`-path may be:
- **relative** to the including file,
- **`${var}`-substituted** (settings-scope vars; an absolute result is used directly),
- **aliased**: the first segment (up to `/` or `:`; both separators work) names an alias,
- **namespaced**: a first segment carrying the reserved `~` sigil names a recipe
  namespace (see below).

**Aliases.** There is exactly ONE built-in, reserved and `~`-prefixed: `~project`, the
project root (see `buildBuiltInAliases` in `settings.ts`). Everything sous once reached
through a built-in alias into its own package is published as a recipe now, and a recipe's
files are addressed by namespace instead. Projects add their own aliases via the top-level
`_aliases` block (string or array values, `${var}`-substituted); user names may not start with
`~`. Precedence: built-ins, then `_aliases`, where the user block **prepends** (user bases
tried first, falling through to built-in bases of the same name). Resolved by
`resolveAliases(settings, scope)`.

**Recipe namespaces (the `~` sigil).** A first segment written `~<namespace>` addresses a
recipe namespace rather than the filesystem; everything after it starts with the recipe
name and continues with the path inside that recipe, so
`@~workflow/task-files/_partials/resume.md` means the file `_partials/resume.md` in recipe
`workflow/task-files`. A bare `@path` (no `~`) never falls through to a namespace; it stays
a relative path or a declared alias. Scoping is enforced by the resolver: inside a recipe's
own files a namespace resolves only against that recipe's declared dependencies (`depends`
plus `subscribes`) at their pinned versions, while a project's own templates resolve
against the project's subscriptions. The inner path may not contain `.` or `..` segments and
may not be absolute, and the resolved candidate is `path.relative`-checked against the recipe
directory; a reference that leaves it returns `{ kind: "escapes-recipe" }` rather than a path,
because otherwise a recipe file could render anything on the machine into a project's output.
The contract lives in
`src/lib/repos/namespace-resolver.ts` (`NamespaceResolver`, plus the in-memory
`StaticNamespaceResolver` used by tests); a resolver is injected through the
`namespaceResolver` option on `CompilationService` and `BuildService`, and when none is
supplied the `~` sigil only ever means an alias.

**Candidate order.** Each alias base in order, then the namespace resolver's candidates
(only for a `~` first segment, and only when a resolver was supplied), then the path
resolved relative to the including file (full path incl. the first segment, so an alias
can *augment* a real local dir). Aliases therefore always beat a namespace of the same
name, which keeps `~project` stable. First candidate that exists wins;
none → error naming the including file, listing every path tried, and explaining the
namespace lookup when one was attempted (unknown namespace, unknown recipe, or a recipe the
including recipe must add to its `depends`). Circular includes are detected and reported,
including cycles that run through namespace references.

## Skills System

A skill is a directory holding a `SKILL.md` or `SKILL.tpl.md` plus optional `scripts/`,
`references/` and `examples/`. Sous compiles skills into a project's agent skill directories
(`.claude/skills/`, `.codex/skills/`), and there are exactly three places a skill can come
from. Knowing which one you are editing is the whole point of this section, because the blast
radius of each is completely different.

1. **`recipes/core/sous-skills/skills/` in THIS repository.** The core skills that teach an
   agent what sous is: `about-sous`, `about-sous-configuration`, `about-agent-skills`,
   `about-liquid-templates` and `create-skill`. This is the SOURCE for every project in the
   world that installs sous, so an edit here reaches all of them at the next release. The
   published copy in `sous-io/sous-recipes` is distribution output; edit it here.
2. **A recipe in `sous-io/sous-recipes`.** Everything else sous publishes lives there and is
   edited there, in a real checkout. `sous repo link sous-recipes` points this project at one
   so an edit is visible in a build immediately, without a release.
3. **`.sous/skills/` in THIS repository (`skillsRoot`).** Skills about developing sous
   itself. They are not published, not distributed, and reach nobody else. A skill that is
   only useful to someone working ON sous belongs here; anything worth sharing belongs in a
   recipe.

`skillsRoot` is what a compiled skill renders when it tells an agent where "this project's
skills" live, and in this repository it points at `.sous/skills/`. So when `create-skill`
says to write a skill into this project, that is category 3 above. The compiled
`about-sous` and `about-agent-skills` "never edit them" rule refers to the compiled copies
inside a consuming project, which are build output; it is not about any of these sources.

The `SKILL.md` frontmatter spec lives in the `about-agent-skills` skill
(`recipes/core/sous-skills/skills/about-agent-skills/`), which is the authoritative reference
for skill structure and naming.

Two skill types:
- **Topic skills**: reference material and shared scripts for a concept
- **Action skills**: lean, action-specific; reference their parent topic skill

## State Files

Sous tracks every file and directory it writes in a state file (default: `<sousDir>/sous.state.json`; override with the `stateFilePath` config var). 
This enables `sous prune` (remove stale outputs) and `sous clear` (delete all outputs) to work precisely.

## Key Commands

| Command | Description |
|---------|-------------|
| `sous build` | Compile + prune (main workflow) |
| `sous compile` | Compile only |
| `sous prune` | Remove output files no longer in config |
| `sous clear` | Delete all Sous-written files for a project (`--force` / `-f`, also `--yes` / `-y`) |
| `sous help [topic] [command]` | Print the same screen `--help` and `-h` print, for the CLI, a topic or a command |
| `sous launch <tool>` | Build then spawn agent (e.g., `sous launch claude`) |
| `sous config show` | Print the merged config (all layers merged, before var resolution) as JSON |
| `sous config get <path>` | Print one value by dot-path (e.g. `compilation.targets[0].entryPoint`); `--layers` shows per-layer provenance |
| `sous config validate` | Validate the merged config: schema, then full variable resolution |
| `sous repo add <url>` | Add a repository, which is also how you trust it, then fetch only its index (`--name`, `--provider`, `--yes` / `-y` / `--trust`, `--dry-run`) |
| `sous repo remove <name>` | Stop trusting a repository: print the entry, the subscriptions that resolve into it, the recipes they alone hold, the outputs the build will prune and any link, ask once, then remove all of it and build (`--yes` / `-y` / `--force`, `--dry-run`, `--no-build`) |
| `sous repo list` | List the trusted repositories: name, location, provider, namespaces, recipe count, and whether it is linked |
| `sous repo search <text>` | Search the cached indexes by namespace, recipe name and description (`--limit`); also the top-level `sous search <text>` |
| `sous repo gc` | Collect the machine-wide store back to its size cap, protecting everything the lockfile pins (`--max-bytes`, `--dry-run`) |
| `sous namespace list` | List every namespace the trusted repositories publish, with its recipe count and how much of it the project subscribes to |
| `sous namespace show <ref>` | Show one namespace and every recipe in it, with each recipe's latest version, pinned version and subscription state |
| `sous recipe list` | List every recipe the trusted repositories publish: latest version, pinned version, subscribed, description |
| `sous recipe show <ref>` | Show one recipe in full: every published version, its dependencies as declared and as the index resolved them, the variables it declares, and where its files land |
| `sous lock show` | Print what the lockfile pins: recipe, version, repository, and who holds it |
| `sous lock rebuild` | Recompute the lockfile from the declared subscriptions and the cached indexes, dropping what nothing holds (`--dry-run`) |
| `sous subscription list` | List what the project subscribes to: range, the versions the lockfile pins, origin, and whether it is on |
| `sous subscription add <ref>` | Subscribe to a namespace or a recipe, install the whole closure, answer the variables it publishes, then build the project (`--yes` / `-y` / `--trust`, `--accept-first`, `--prerelease`, `--always-pull`, `--answer <name>=<value>`, `--answers-file <path>`, `--dry-run`, which also prints every question the closure would ask, `--no-build`); also `sous subscribe` |
| `sous subscription remove <ref>` | Remove a subscription and everything only it brought in, refcounted, then build the project so its files are pruned (`--dry-run`, `--no-build`); also `sous unsubscribe` |
| `sous repo init [dir]` | Scaffold a new recipe repository (`--name`, `--namespace`, `--force`) |
| `sous repo link <repo\|path> [path]` | Read a repository from a working copy: link the checkout a path names in place, clone a repository named on its own, or link the checkout a second argument names (`--global`, `--yes` / `-y` / `--trust`) |
| `sous repo unlink <repo>` | Drop the link and go back to published versions; the checkout stays (`--global`) |
| `sous repo release` | Publish new versions of a recipe repository: plan, ask once, then bump, regenerate the index, commit and tag (`--namespace`, `--recipe`, `--bump`, `--no-bump`, `--include-unchanged`, `--tag`, `--push`, `--yes`, `--check`, `--ci`, `--dry-run`) |
| `sous repo submit` | Propose this repository's committed changes to its maintainers (`--title`, `--body`, `--draft`, `--dry-run`) |
| `sous vars list` | List every recipe variable in play: its answer, the env var that supplied it, and the source |
| `sous vars show <name>` | Show one variable in full, with every candidate env var name and the rung that answered |
| `sous vars ask [name]` | Answer what is unanswered, or everything the name covers: a variable, an environment variable name in use that answers one, a recipe, a namespace or a repository, resolved through `src/lib/refs/` (`--repo`, `--namespace`, `--var` narrow the same way, `--accept-first` settles an ambiguous name, `--all` re-asks everything); `--file` reads a standalone definitions file, `--answer <name>=<value>` and `--answers-file <path>` answer ahead of the questions, `--dry-run` writes nothing |

Every topic answers to both spellings of its name (`repo`/`repos`, `subscription`/
`subscriptions`, `namespace`/`namespaces`, `recipe`/`recipes`, `lock`/`locks`, `var`/`vars`,
`config`/`configs`), implemented as oclif `aliases` on each
command plus a `hidden: true` topic entry in the `oclif.topics` block of `package.json`;
that block is also where each topic's one-sentence description lives. `subscribe` and
`unsubscribe` stay as `hiddenAliases` of `subscription add` and `subscription remove`, and
`search` is a visible alias of `repo search`. A name listed in BOTH `aliases` and
`hiddenAliases` is registered visible first and never hidden, so each alternate name goes in
exactly one of the two lists. Bare `sous vars` is a hidden command carrying the optional
name argument, so the top-level listing names `vars` once, as a topic.

`subscription add` and `subscription remove` end by rebuilding the project, because changing
what it subscribes to changes what it compiles. Both reload the discovered config first (the
subscription lives in a managed `conf.d/` layer written moments earlier) and then call
`buildProjectOutputs` in `build-service.ts`, which runs `BuildService.build` with every option
at its default: the same compile and prune `sous build` does, recipe targets and namespace
resolver included. `--no-build` skips it, a dry run never reaches it, and a failed build leaves
the subscription change in place (it is already written and locked) and says so.

The `sous config` namespace inspects the merged config. `show` and `get` emit machine-
readable stdout (`config show | jq` works): they extend `ConfigCommand`, which routes the
decorative header and any error block to stderr so a broken config never corrupts a piped
stream. `get` prints scalars raw and objects/arrays as pretty JSON, colorized only for a
TTY; `--layers` walks the trace-mode snapshots and prints one `old -> new` line per layer
that changed the value. `validate` runs the resolvers (fixpoint + substitution) that
schema validation alone cannot, surfacing cycles and undefined `${vars}`.

The `repo` namespace manages repositories. `repo add` is the trust ceremony, and adding IS
trusting: nothing is downloaded from a repository before the question is answered, and once
it is, exactly one file is fetched (`sous.index.json`). `repo remove` is its reverse and lives in
`SubscriptionService.removeRepo`: it states every consequence first (the layer entry, the
subscriptions that resolve into the repository, the recipes those alone hold, the output files the
build will prune, and any link), asks once, then removes each subscription through the ordinary
refcounted `unsubscribe` path, drops the project's link entry, and writes the repositories layer.
A machine-wide link is left alone, since other projects share it; the checkout is never deleted.
The built-in `sous-recipes` entry cannot be deleted (it is recreated from the package every run),
so removing it records `enabled: false` through `TrustService.disableRepo`, the same shape the
`core` subscription opt-out uses. A repository written in the user's own config is refused, because
sous never edits a config file a person wrote. `repo list` and `repo search` read
only what is already cached, so both work offline; a repository whose index has never been
fetched is named rather than silently left out. `repo gc` protects everything this project's
lockfile pins, whatever that does to the total, since a cache that is too large is a
nuisance while evicting a pinned entry breaks a build. `repo init` does not extend
`BaseCommand`: it creates a repository, which is not a sous project and usually has no
`.sous/` above it, so config discovery would only get in its way. `repo link` is written three
ways, and only one of them clones. A configured short name on its own clones into
`.sous/repos/<owner>/<name>` (or `$SOUS_HOME/repos/...` with `--global`), reuses a checkout of
the same remote rather than re-cloning, and refuses a checkout of a different one. A local
directory path in the REPO slot (`checkoutInRepoSlot` in `link.ts`) links that checkout where
it is, with `origin: "path"` and the short name its repo manifest suggests; a configured short
name always wins over a directory of the same name in the working directory, and a path in both
argument slots is refused. A second argument links the checkout it names. `repo unlink` removes
the map entry and never touches the checkout. A `repo link` argument that is a URL or a path
rather than a configured short name goes through `SubscriptionService.addRepo`, so it runs
the SAME trust ceremony `repo add` runs (and gets `addRepo`'s short-name collision check) before
anything is linked or cloned; linking reads recipes with no version, lockfile or hash check, so
there is no path by which sous reads a repository the project has not trusted. Both maintain the managed
`.gitignore` block described above, so `.sous/repos/` and the links map stay out of version
control. Prune and clear only ever touch paths recorded in the state file, so nothing in
`.sous/repos/` is at risk from them.

`repo release` and `repo submit` do not extend `BaseCommand` either, and for the same reason
as `repo init`: they run INSIDE a recipe repository. `repo release` is ONE plan-then-execute
flow (`release/plan.ts` decides, `src/commands/repo/release.ts` carries it out): within the
scope (`--namespace` / `--recipe`, repeatable; the whole repository by default) it releases only
recipes whose content changed since their last tag, patch-bumping any whose version still equals
that tag, regenerating the index with each version's dependencies resolved, committing the
manifests and the index together, then cutting annotated tags dependency-first. It prints the
plan and asks once (`--yes` skips, `--dry-run` stops), and pushes only with `--push`. This is
the ONE place sous commits for an author, and it stages nothing but its own bumps and index;
it refuses while anything else is uncommitted. `--check` is the read-only pull-request form,
`--ci` is the merge preset (implies `--no-bump`, never asks, does NOT imply `--push`), and on a
branch other than the default one tagging is skipped unless `--tag` says otherwise. `repo submit` is validate-then-propose: it checks the tooling and the working
tree, then the recipes and the index, and only then pushes and proposes. `submit-service.ts`
is a SEQUENCER and nothing more: it names no provider, spawns no host tool, and builds no
command arguments; every host-specific answer comes from the provider interface as plain data.
Every step prints before it runs, and a failure names the steps that already completed. A
provider that does not advertise the `submit` feature prints the repo manifest's own
`contribute` pointer instead.

This `config` namespace is a fresh design, distinct from the old `configure` /
`config *` commands and the `~/.sous` profile layer that were removed when walk-up
`.sous/` discovery replaced them. That removed source stays archived under
`docs/notes/removed-xcv-config/` (see its `MANIFEST.md`) and on the `preserve/xcv-config`
branch, as history only; do not resurrect it.

The zod schema in `config-schema.ts` also drives `npm run schema:build` (`tsx
scripts/build-schema.mts`), which emits the committed `sous.config.schema.json` artifact
via `z.toJSONSchema`. Re-run it whenever the schema changes; it ships in the package.json
`files` allowlist.

Common config-locating flags on every command: `--config <path>` / `-c` (alias
`--sous-config`), plus `--sous-dir` and `--sous-confd` (env equivalents `SOUS_CONFIG`,
`SOUS_DIR`, `SOUS_CONFD`). `SOUS_DEBUG` is the other environment variable every command
reads: set it to anything but `0`/`false`/`no`/`off` and a failed run prints its stack
trace to stderr (and puts oclif itself back in debug mode). There is no `--project` / `-p` flag; one config describes one
project. Every command that carries those flags also carries `--non-interactive`; the three
that run inside a recipe repository carry neither, because they extend `Command` rather than
`BaseCommand`. Also: `--rebuild`, `--dry-run`,
`--strict`, `--watch` / `-w` (build/compile), `--no-prune` / `--no-compile` (build),
`--no-build` / `--continuous` (launch), `--accept-first` (subscribe).

**One confirmation flag.** Every yes-or-no question a command would ask is answered by one
shared boolean, built by `confirmationFlag()` in `src/utils/flags.ts`: `--yes` / `-y`, with
`--force` / `-f` as oclif flag aliases, plus `--trust` on the commands that run the trust
ceremony (`repo add`, `repo link`, `subscription add`). `clear` files it under `force`
instead (`confirmationFlag({ primary: "force" })`), so `--force` stays its primary spelling
and `--yes` / `-y` are aliases there. Aliases are never separate flags: the factory appends
a dim "(also -f, --force)" suffix generated from the alias list, so help lists the flag
once. `repo init --force` is NOT this flag; there `--force` means overwrite. A new command
that asks a confirmation uses the factory rather than declaring its own boolean.

**Help in four forms.** `--help`, `-h` (registered through `oclif.additionalHelpFlags` in
`package.json`), and the `help` command (`src/commands/help.ts`: `sous help`, `sous help
<command>`, `sous help <topic>`, `sous help <topic> <command>`) all draw the same screen,
because all of them go through `loadHelpClass`. `@oclif/plugin-help` is deliberately not
installed. `src/commands/help.ts` extends `Command`, not `BaseCommand`: reading help must
work where no config can be discovered.

**One interactivity rule.** `src/lib/interactive.ts` owns it, and every prompt in sous is
gated by it; do not reintroduce an ad hoc `process.stdin.isTTY` check anywhere.
`isInteractive()` is false when `--non-interactive` is on the command line (scanning stops
at a bare `--`), when `CI` is set to anything but `0`/`false`/`no`/`off`, or when stdin or
stdout is not a TTY; every input is injectable for tests. A prompt that cannot be shown
throws a `NonInteractiveError` (a `ConfigError` carrying `showHelp`), whose message names
the question, why sous could not ask it, and the flag or env vars that would have answered
it; the error reporter (below) then prints the command's own help underneath. The flag
itself is defined once as `nonInteractiveFlag()` in `utils/flags.ts`:
`BaseCommand.baseFlags` takes it, and so do the three authoring commands (`repo init`,
`repo release`, `repo submit`), which extend oclif `Command` rather than `BaseCommand` and
would otherwise reject it as unknown.

**One way to report an error.** `reportCommandError` in `utils/command-errors.ts` renders
every command failure, and `BaseCommand.catch` plus the three authoring commands' own
`catch` handlers are its only callers. Expected failures print their message and nothing
else: a `ConfigError`, an oclif parse error (missing argument, unknown flag, value outside
a flag's options), a blocked prompt. Usage mistakes and blocked prompts also get the
command's own help underneath, drawn by `printCommandHelpToStderr` in
`utils/command-help.ts` through oclif's `loadHelpClass` (sous does not install the help
plugin, so there is no `help` COMMAND to run) with `process.stdout.write` pointed at
stderr for the duration, so a piped stdout stays machine-readable. An error sous did not
expect keeps its message and gains one sentence naming `SOUS_DEBUG`. Nothing prints a
stack trace unless `SOUS_DEBUG` asks for one, which is also why `bin/run.js` passes
oclif's `development` mode (it sets oclif's own `debug` setting, which turns every error
oclif prints into a raw stack) only when that variable is set. An oclif exit code survives
(a parse error still exits 2); `this.exit()` and a JSON-rendering command fall through to
oclif untouched. Guarded by `src/utils/command-errors.spec.ts` and the error cases in
`src/test/integration/help-and-flags.test.ts`.

**Launch pass-through:** any argument `launch` does not recognize is forwarded to the
tool, after the config-defined `tools.<name>.args` and before the `promptFile` content
(e.g. `sous launch claude --resume`). Flags that collide with sous's own (claude's `-c`
vs sous's `--config` shorthand) go after a bare `--`, which
forwards everything following it verbatim: `sous launch claude -- -c`. Implementation:
`launch.ts` sets oclif `strict = false` plus `"--" = false` (oclif rejects unknown
flags even in non-strict mode otherwise) and splits argv at the first `--` itself;
`readConfigFlagFromArgv` in `base-command.ts` also stops scanning at `--`. Guarded by
`src/test/integration/launch-passthrough.test.ts`.

## Important Patterns

- Every command that works on a PROJECT extends `BaseCommand`, which discovers the config,
  loads `.env.local`, and loads settings on every run. Discovery is required for those; there
  is no opt-out. The exceptions extend `Command` directly and are listed with their reasons
  under Key Commands: the three that run inside a recipe repository, and `help`.
- `CompilationService` (alias `MarkdownCompiler`) is the core compiler class
- `BuildService` orchestrates `CompilationService` + prune in one step
- Watch mode uses `WatchService` (chokidar + debounce, 300ms); ignores `*.sous.state.json` files
- `build --watch` and `compile --watch` share the reload loop in `watch-loop.ts`: a change
  to the primary config, the `conf.d/` directory, or the templating dir triggers a full
  reload (`reloadDiscoveredConfig` in `base-command.ts` re-enumerates conf.d layers, re-runs
  the duplicate-baseName check, and commits only on a clean load; last-good semantics)
- `resolveScope()` in `settings.ts` performs topological sort for intra-block var dependencies
- `resolveRootScope(settings, context?)` builds THE settings scope (auto-vars → `_env` → `_vars`);
  the other resolvers take it directly: `resolveCompilation(settings, scope)`,
  `resolveTools(settings, scope)`, `resolveWatchConfig(settings, scope)`,
  `resolveAliases(settings, scope)`
- LiquidJS engine is built by `createLiquidEngine()` in `src/templating/init-liquid-engine.ts`;
  custom tags/filters self-register via the arrays in `tags/index.ts` and `filters/index.ts`
- Every command that prints a table calls `renderTable(columns, rows, options)` in
  `src/utils/table.ts` and never pads columns by hand. A column spec says what it holds
  (`kind`), whether a long cell wraps or is cut (`overflow`, `truncate`), how much slack it
  takes (`flex`), how narrow it may get (`minWidth`) and how willingly it is hidden
  (`priority`). Widths are measured with `displayWidth()` (ANSI-safe) from `formatting.ts`.
  Columns are hidden only when the output is a real terminal too narrow to hold them; piped
  output is laid out at `DEFAULT_WRAP_COLUMNS` and keeps every column

## Custom Liquid Tags & Filters

Registered automatically by `createLiquidEngine()`:

| Name | Kind | Purpose |
|------|------|---------|
| `{% showVars %}` | tag | Dump all in-scope vars as a fenced JSON block (dev aid) |
| `{% exportScalarVarsJs %}` | tag | Emit in-scope scalars (string/finite-number/boolean) as `export default {...};`, keys sorted. For compiling a `settings.tpl.mjs` that runtime code imports. Skips objects, arrays, null, functions, NaN/Infinity. |
| `{% getFiles <var> root="..." include="..." exclude="..." import="..." %}` | tag | Glob files under `root`; assign `[{path,dir,relPath,name}]` to `<var>` (renders nothing; use a `{% for %}`). `include`/`exclude` are comma-separated globs; attrs accept quoted strings or scope vars. Optional `import="<export>"` dynamically imports each file and attaches that export (e.g. `import="meta"` → `file.meta`); files that fail to import or lack the export are dropped. Requires the async render path. |
| `{% listFiles root="..." include="..." exclude="..." relative="true" %}` | tag | Convenience counterpart to `getFiles`: globs and renders a markdown bullet list of file names (or relative paths) inline. Glob-only. |
| `bulletList` | filter | Convert an array to a markdown bullet list |

The glob core (`globFiles`, `parseGlobList`) lives in `src/templating/lib/glob-files.ts`
and is shared by both file tags; it uses the `glob` package (matching `entryGlob`).
`getFiles import=` uses `importNamedExport` in `src/templating/lib/import-export.ts`.

**Async render:** the compiler renders via `engine.parseAndRender` (async); see
`renderContent`/`compileTarget` in `markdown-compiler.ts`. This is required so tags
like `getFiles import=` can `import()` files. Do not revert to `parseAndRenderSync`;
`src/test/integration/get-files-tag.test.ts` guards this.

To add a tag: create `src/templating/tags/<name>.ts` exporting a `register<Name>Tag(engine)`
function, then add it to the array in `src/templating/tags/index.ts`. Filters follow the
same pattern under `filters/`.

@${sousDir}/prompts/memories/sources-of-truth.md

## Important!

When working on `sous`, keep this document accurate, but remember it is GENERATED:
edit the tracked source at `.sous/prompts/root/CLAUDE.md` (never the compiled root
`CLAUDE.md`) immediately after any change to sous, its code, its configuration, or its
usage, then run `npm run sous:build`. It is VITAL that this file ALWAYS describes `sous`
ACCURATELY. The same rule applies to the website doc: `.sous/prompts/docs-site/CLAUDE.md`
is the source of `docs/CLAUDE.md`.
