# Sous CLI (xcv) — Agent Configuration Manager

> **GENERATED FILE — DO NOT EDIT the repo-root `CLAUDE.md` DIRECTLY.**
> It is compiled by sous (`npm run sous:build`) from
> `.sous/prompts/root/CLAUDE.md`. Edit that source, then rebuild. The compiled
> copy is gitignored; the source is tracked.

Sous is a TypeScript CLI tool that compiles markdown templates and manages output files for LLM/AI coding agents 
(Claude, Codex, etc.). The binary is named `xcv`. Published on npm as `@sous-io/sous`.

## Build & Development

```bash
npm run build    # compile TypeScript → dist/ (type-check; dist is NOT what ships or runs)
npm run clean    # rm -rf dist/
```

The CLI always runs from TypeScript source via tsx — in the repo AND in the published
package. `bin/run.js` (the published bin) registers tsx via `tsx/esm/api` then hands off
to oclif; `bin/xcv` is a thin bash wrapper over it for the repo's npm scripts. tsx is
resolved by module resolution (never a hardcoded `node_modules` path) so hoisted installs
(`npx`, local deps) work; same trick in `loadSettings` (`settings.ts`) for the config
subprocess. `run.js` sets oclif `settings.enableAutoTranspile = false` — tsx already
handles `.ts` imports, and leaving it on makes installs without the `typescript` devDep
warn on every run.

Run directly from source during development:
```bash
./bin/xcv <command>
```

TypeScript: strict mode, ES2022 target, Node16 module resolution. `dist/` output exists
for type-checking only.

## Publishing (npm)

Published as `@sous-io/sous` (npm org `sous-io`), public access, Apache-2.0. The
package ships `bin/run.js`, `src/` (minus tests), `shared-prompts/`, and the documentation
markdown (`docs/markdown/*.md`; agent-readable reference matching the installed version, pointed
to by the distributed `about-sous` skill; the web shell around it stays out) — see the `files`
allowlist in `package.json` (an allowlist, so there is no `.npmignore`; `bin/xcv` and
everything else stays out by default). `repository.url` must keep matching the GitHub repo
exactly; npm's trusted publishing validates it at publish time.

Releases go through trusted publishing (OIDC, tokenless): pushing a `v*` tag triggers
`.github/workflows/publish.yml`, which needs `id-token: write` and npm ≥ 11.5.1. The
trusted publisher is configured on npmjs.com (package Settings → Trusted publishing:
org `sous-io`, repo `sous`, workflow `publish.yml`). To release: bump `version` in
`package.json`, sync the lockfile (`npm install --package-lock-only`), commit, push,
then `git tag v<version> && git push origin v<version>`. No local `npm publish`, and
no GitHub Releases required (the `gh` CLI is not assumed to exist).

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
    env-local.ts           # parses .sous/.env.local and .sous/.env into process.env
    settings.ts            # config loader (spawns the kernel), var resolution, scope chain
    markdown-compiler.ts   # CompilationService; @-include, LiquidJS rendering
    include-resolver.ts    # @-include alias/${var}/relative path resolution
    build-service.ts       # orchestrates compile + prune; BuildService
    state.ts               # StateService; tracks written files/dirs per project
    watch-service.ts       # chokidar watcher with debounce; WatchService
    watch-loop.ts          # shared build/compile --watch reload loop (config + template edits)
    pid-service.ts         # PidService; single-instance watcher enforcement via PID files
  templating/
    init-liquid-engine.ts  # LiquidJS engine factory (createLiquidEngine)
    tags/                  # custom Liquid tags: showVars, exportScalarVarsJs, getFiles, listFiles
    filters/               # custom Liquid filters: bulletList
    lib/                   # shared tag helpers: glob-files.ts, tag-args.ts
  utils/
    formatting.ts          # console output helpers (heading, showVar, sortObjectKeys, etc.)
    prompts.ts
shared-prompts/
  memories/                # shared memory partials composed into downstream core memory files
    automated-browser-tasks/  # INDEX.tpl.md — getFiles-driven task manifest
  skills/                  # shared skill bundles; each subdirectory is a bundle
    sous-skills/           # built-in sous bundle, compiled + distributed to downstream projects
      about-sous/          # teaches downstream agents what Sous manages (never-edit rule)
      about-sous-configuration/ # thin router: orientation + rules; the config reference
                           #   itself lives in docs/markdown/config*.md (single source of
                           #   truth, shipped in the npm package)
      about-agent-skills/  # foundational skill knowledge for downstream agents
      about-liquid-templates/ # .tpl. convention + LiquidJS syntax for downstream agents
      create-skill/        # action skill: creating a skill in skillsRoot
    control-flow/          # generic interaction skills: approve, opine, repeat, research
    task-files/            # per-branch task file workflow (needs taskFileRoot etc.)
    github-projects/       # GitHub Issues + Projects v2 workflow (about-github-projects,
                           #   create-issue, pick-issue, /techdebt)
    automated-browser-tasks/  # headless Chrome task authoring + running (Linux only)
bin/
  run.js                   # published bin (`xcv`): registers tsx, hands off to oclif
  xcv                      # bash dev wrapper over run.js, used by the repo's npm scripts
scripts/
  build-schema.mts         # emits sous.config.schema.json from the zod schema (npm run schema:build)
sous.config.schema.json    # committed JSON Schema artifact; shipped in the npm files allowlist
.github/workflows/
  publish.yml              # npm trusted publishing on GitHub Release (OIDC, tokenless)
docs/                      # the GitHub Pages site (sous-io.github.io/sous)
  index.html               # the animated GSAP presentation page
  markdown/                # the documentation shell (docsify, client-side markdown render)
  css/main.css             # site design system (--sous-* design tokens)
  CLAUDE.md                # GENERATED site instructions (gitignored output); the site's
                           #   full documentation lives there, not here
.sous/                     # THIS repo's own sous config — sous configures itself
  sous.config.js           # the primary config; compiles skills into .claude/skills/ + both CLAUDE.md files
  conf.d/                  # optional drop-in layer dir (*.js|mjs|json|yaml); merged after the primary config
  prompts/
    root/CLAUDE.md         # tracked SOURCE of the repo-root CLAUDE.md
    docs-site/CLAUDE.md    # tracked SOURCE of docs/CLAUDE.md
  .env.local.example       # documents the machine-specific env layer (.env.local); .env holds shared defaults
deprecated/                # archived, gitignored
docs/notes/                # planning docs and TODOs, gitignored
```

## Config Discovery

There is no user-level config; nothing is read from `~/.sous`. Every command locates its
config the same way, in `BaseCommand.init()` (see `config-discovery.ts`).

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
`sous.config.js`, `sous.config.mjs`, `sous.config.json`, `sous.config.yaml`. Two or more
is a hard `ConfigError` (`findConfigInSousDir`); sous never silently first-match-wins.

**The `conf.d/` layer directory.** Every `*.{js,mjs,json,yaml}` file directly inside
`<sousDir>/conf.d/` (non-recursive) is a config layer, loaded AFTER the primary config and
deep-merged over it. Layers are ordered by a bytewise (locale-independent, per-machine
stable) filename sort, NOT numeric: `10-x.json` sorts BEFORE `2-x.json`, so zero-pad
numeric prefixes (`02-`, `10-`) if ordering matters. Override the directory with
`--sous-confd <path>` or `SOUS_CONFD` (flag > env > `<sousDir>/conf.d`); an empty value is
unset. Every loaded layer (the primary config plus all `conf.d/` layers) must have a
unique baseName once its FINAL extension is stripped: `500-repos.json` and
`500-repos.yaml` collide and are a `ConfigError` (`assertUniqueLayerBaseNames`), since
their merge order would otherwise hinge on extension.

**Env files.** Before any variable resolves, sous loads `<sousDir>/.env.local` then
`<sousDir>/.env` into `process.env` (`env-local.ts`). Precedence, highest first: real
shell environment > `.env.local` (gitignored, machine-specific/secret) > `.env`
(committed, shared team defaults). No load ever overwrites an already-set value, so the
first writer wins and `FOO=bar xcv build` beats both files. Syntax is small and
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
`_vars`, `_aliases`, `compilation`, `runtimeContext`, and `tools` all live at the top
level.

State and PID files default into the discovered `.sous/`: `sous.state.json` and `sous.pid`
(unprefixed; one config is one project). Override with the `stateFilePath` / `pidFilePath`
config vars.

### Sous Configures Itself

This repo has its own `.sous/sous.config.js`, which compiles the `sous-skills`,
`control-flow`, `task-files` and `github-projects` bundles into `.claude/skills/`, and
generates two instruction files from tracked sources under `.sous/prompts/`:

- `.sous/prompts/root/CLAUDE.md` → `/CLAUDE.md` (this file)
- `.sous/prompts/docs-site/CLAUDE.md` → `/docs/CLAUDE.md` (the website doc)

`automated-browser-tasks` is deliberately excluded: it needs
`browserAutomationScriptsDir` pointing at a real script directory, and sous has none.

**Sous's own task management:** tickets are GitHub issues in `sous-io/sous`, tracked on
the "Sous" GitHub Projects v2 board (https://github.com/orgs/sous-io/projects/1, statuses
Backlog → Ready → In Progress → In Review → Done). Ticket IDs are written `gh-<number>`
(issue `#47` → ticket `gh-47`, branch `lc/gh-47-short-desc`); the `gh-` prefix keeps them
greppable in branch names. Per-branch task files live in `.sous/tasks/` (gitignored). The
board, Status field and option IDs are recorded as `github*` vars in `.sous/sous.config.js`
and compiled into the skills.

Both compiled CLAUDE.md files are gitignored OUTPUTS (`/CLAUDE.md` and `/docs/CLAUDE.md`
in `.gitignore`); only the sources in `.sous/prompts/` are tracked. Never edit the
compiled copies — edit the sources and run `npm run sous:build`. A fresh clone has no
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

`conf.d/500-*` through `conf.d/599-*` is a band reserved for layers a future sous CLI
writes for you (e.g. a `sous repo add` writing `conf.d/500-repos.json`). Machine-written
layers are stable, pretty-printed JSON (minimal VCS diffs), and sous never edits a user's
hand-written primary config or non-5xx layers. There are no such write commands yet; the
convention is established now so the band stays clear.

## Variable Scoping

Resolution order (later overrides earlier):

```
auto-vars  →  _env scope  →  _vars  →  compilation _vars  →  target _vars  →  output _vars
```

- `_vars` blocks use `${varName}` syntax (resolved by Sous internally by a fixpoint loop)
- Template files use `{{ varName }}` syntax (resolved by LiquidJS at render time)
- `_env` is top-level only; maps `configVarName: "ENV_VAR_NAME"`
- Reserved `sous*` namespace — do not define vars starting with `sous`

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
- `sousRootPath` — absolute path to the Sous CLI install directory
- `sousVersion` — current CLI version
- `sousDir` — the discovered `.sous/` directory holding the active config
- `sousConfDir`: the `conf.d/` drop-in directory for the active config
- `sousConfigPath`: absolute path to the active (primary) config file
- `sousTemplatePath` — absolute path to the `.tpl.` file currently being rendered (render-time only)
- `sousTemplateDir` — directory of the `.tpl.` file currently being rendered (render-time only)

Absolute `entryPoint`, `globBase`, `destinationFile` and `destinationDir` values are
normalized after substitution (`normalizeConfigPath` in `settings.ts`), so `${sousDir}/..`
collapses to the parent directory. This is required, not cosmetic: Sous writes files via
`path.join` (already normalized) while prune decides what is current by string-prefixing
tracked destinations against `destinationDir`. An un-normalized `destinationDir` matched
nothing and prune deleted everything compile had just written.

### Variables Required by the Shared Prompts

The bundles in `shared-prompts/` reference project variables that Sous does not provide. A
consuming project must define these in `_vars` for the bundles it uses. The engine runs with
`strictVariables: false`, so an undefined variable renders as an empty string; nothing fails, the
output just silently loses the value (e.g. a path becomes `/[branch-name].md`). Define every
variable for the bundles you compile.

| Variable | Purpose | Example | Needed by |
|----------|---------|---------|-----------|
| `taskFileRoot` | Directory holding task files, one per git branch | `.claude/tasks` | `task-files` bundle, `_partials/resume-task.md`, `_partials/update-task-file.md` |
| `ticketIdExample` | A sample ticket ID, used in skill trigger phrases and example branch/file names | `PROJ-1234` | `task-files` bundle |
| `featureBranchPrefix` | Prefix for new feature branch names (include the trailing separator, or leave empty) | `luke/` | `task-files` bundle |
| `ticketPrefix` | Ticket key prefix used when composing a branch name from a ticket number | `PROJ-` | `task-files/start-task` |
| `skillsRoot` | Where the project's own skill sources live (not the compiled `.claude/skills/`) | `prompts/skills` | `sous-skills` bundle (`about-sous`, `about-agent-skills`, `create-skill`) |
| `userFullName` | The user's display name | `Luke Chavers` | `github-projects` bundle |
| `githubUserLogin` | The user's GitHub login, used for assignment | `vmadman` | `github-projects` bundle |
| `githubRepo` | The `owner/repo` slug issues live in | `sous-io/sous` | `github-projects` bundle |
| `githubProjectOwner` | Org or user that owns the Projects v2 board | `sous-io` | `github-projects` bundle |
| `githubProjectNumber` | The board's project number | `1` | `github-projects` bundle |
| `githubProjectId` | The board's GraphQL node ID (`gh project view --format json`) | `PVT_...` | `github-projects` bundle |
| `githubStatusFieldId` | Node ID of the board's `Status` field (`gh project field-list`) | `PVTSSF_...` | `github-projects` bundle |
| `githubStatusBacklogId`, `githubStatusReadyId`, `githubStatusInProgressId`, `githubStatusInReviewId`, `githubStatusDoneId` | Option IDs of the five `Status` values (`gh project field-list`) | `e3a82f26` | `github-projects/about-github-projects/references/workflow` |
| `browserAutomationScriptsDir` | Absolute path to the project's browser task scripts; the runtime and the task manifest both read it | `/home/me/proj/browser-tasks` | `automated-browser-tasks` bundle, `memories/automated-browser-tasks/INDEX.tpl.md` |
| `chromeProfile` | Default Chrome profile name for browser tasks (defaults to `Default` at runtime if unset) | `Profile 1` | `automated-browser-tasks` bundle (optional) |

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
@${sousRootPath}/shared-prompts/x.md
@~sous-shared/_partials/resume-task.md
@myAlias/doc.md
```

Lines inside fenced code blocks (``` or ~~~) are NOT processed as includes — they are
left verbatim, which is what allows this very section to document the syntax in a
compiled file. Guarded by the fence tests in `src/test/integration/compilation.test.ts`.

Resolution is handled by `src/lib/include-resolver.ts` (`resolveIncludeCandidates` +
`buildAliasMap`), wired into `CompilationService.processIncludes` and the
`{% render %}` engine FS (so aliases work in both). A `@`-path may be:
- **relative** to the including file,
- **`${var}`-substituted** (settings-scope vars; an absolute result is used directly),
- **aliased** — the first segment (up to `/` or `:`; both separators work) names an alias.

**Aliases.** Built-ins are reserved and `~`-prefixed: `~sous-shared` → the CLI's
`shared-prompts` dir, `~project` → the project root (see `buildBuiltInAliases` in
`settings.ts`). Projects add their own via the top-level `_aliases` block (string or
array values, `${var}`-substituted); user names may not start with `~`. Precedence:
built-ins → `_aliases`, where the user block **prepends** (user bases tried first,
falling through to built-in bases of the same name). Resolved by
`resolveAliases(settings, scope)`.

**Candidate order.** Each alias base in order, then the path resolved relative to the
including file (full path incl. the alias segment — so an alias can *augment* a real
local dir). First candidate that exists wins; none → error listing all tried. Circular
includes are detected and reported.

## Skills System

This repo's own shared skills live in `shared-prompts/skills/<bundle>/<skill-name>/`: a
`SKILL.md` or `SKILL.tpl.md` plus optional `scripts/`, `references/`, and `examples/`. A
consuming project points an `entryGlob` target at a bundle and Sous compiles it into that
project's agent skill directories (`.claude/skills/`, `.codex/skills/`).

A downstream project's own skills live wherever its config sets `skillsRoot`; the shared
`create-skill` skill writes there.

**In THIS repo, `skillsRoot` IS the shared bundle root** (`shared-prompts/skills/`). So when
a compiled skill tells you to edit "this project's skills", that means editing the
distributed bundle sources consumed by every downstream project — treat those edits with
that blast radius in mind. Skills that are specific to developing sous itself and must NOT
be distributed go in `.sous/skills/` instead (see the `projectSkills` target in
`.sous/sous.config.js`). The compiled `about-sous`/`about-agent-skills` "never edit them"
rule refers to compiled copies in consuming projects, not to these sources.

The `SKILL.md` frontmatter spec lives in the `about-agent-skills` skill
(`shared-prompts/skills/sous-skills/about-agent-skills/`), which is the authoritative reference
for skill structure and naming.

Two skill types:
- **Topic skills** — reference material and shared scripts for a concept
- **Action skills** — lean, action-specific; reference their parent topic skill

## State Files

Sous tracks every file and directory it writes in a state file (default: `<sousDir>/sous.state.json`; override with the `stateFilePath` config var). 
This enables `xcv prune` (remove stale outputs) and `xcv clear` (delete all outputs) to work precisely.

## Key Commands

| Command | Description |
|---------|-------------|
| `xcv build` | Compile + prune (main workflow) |
| `xcv compile` | Compile only |
| `xcv prune` | Remove output files no longer in config |
| `xcv clear` | Delete all Sous-written files for a project |
| `xcv launch <tool>` | Build then spawn agent (e.g., `xcv launch claude`) |
| `xcv config show` | Print the merged config (all layers merged, before var resolution) as JSON |
| `xcv config get <path>` | Print one value by dot-path (e.g. `compilation.targets[0].entryPoint`); `--layers` shows per-layer provenance |
| `xcv config validate` | Validate the merged config: schema, then full variable resolution |

The `xcv config` namespace inspects the merged config. `show` and `get` emit machine-
readable stdout (`config show | jq` works): they extend `ConfigCommand`, which routes the
decorative header and any error block to stderr so a broken config never corrupts a piped
stream. `get` prints scalars raw and objects/arrays as pretty JSON, colorized only for a
TTY; `--layers` walks the trace-mode snapshots and prints one `old -> new` line per layer
that changed the value. `validate` runs the resolvers (fixpoint + substitution) that
schema validation alone cannot, surfacing cycles and undefined `${vars}`.

This `config` namespace is a fresh design, distinct from the old `xcv configure` /
`xcv config *` commands and the `~/.sous` profile layer that were removed when walk-up
`.sous/` discovery replaced them. That removed source stays archived under
`docs/notes/removed-xcv-config/` (see its `MANIFEST.md`) and on the `preserve/xcv-config`
branch, as history only; do not resurrect it.

The zod schema in `config-schema.ts` also drives `npm run schema:build` (`tsx
scripts/build-schema.mts`), which emits the committed `sous.config.schema.json` artifact
via `z.toJSONSchema`. Re-run it whenever the schema changes; it ships in the package.json
`files` allowlist.

Common config-locating flags on every command: `--config <path>` / `-c` (alias
`--sous-config`), plus `--sous-dir` and `--sous-confd` (env equivalents `SOUS_CONFIG`,
`SOUS_DIR`, `SOUS_CONFD`). There is no `--project` / `-p` flag; one config describes one
project. Also: `--rebuild`, `--dry-run`, `--strict`, `--watch` / `-w` (build/compile),
`--no-prune` / `--no-compile` (build), `--force` / `-f` (clear),
`--no-build` / `--continuous` (launch).

**Launch pass-through:** any argument `launch` does not recognize is forwarded to the
tool, after the config-defined `tools.<name>.args` and before the `promptFile` content
(e.g. `xcv launch claude --resume`). Flags that collide with sous's own (claude's `-c`
vs sous's `--config` shorthand) go after a bare `--`, which
forwards everything following it verbatim: `xcv launch claude -- -c`. Implementation:
`launch.ts` sets oclif `strict = false` plus `"--" = false` (oclif rejects unknown
flags even in non-strict mode otherwise) and splits argv at the first `--` itself;
`readConfigFlagFromArgv` in `base-command.ts` also stops scanning at `--`. Guarded by
`src/test/integration/launch-passthrough.test.ts`.

## Important Patterns

- All commands extend `BaseCommand`, which discovers the config, loads `.env.local`, and
  loads settings on every run. Discovery is required — there is no opt-out.
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

## Custom Liquid Tags & Filters

Registered automatically by `createLiquidEngine()`:

| Name | Kind | Purpose |
|------|------|---------|
| `{% showVars %}` | tag | Dump all in-scope vars as a fenced JSON block (dev aid) |
| `{% exportScalarVarsJs %}` | tag | Emit in-scope scalars (string/finite-number/boolean) as `export default {...};`, keys sorted. For compiling a `settings.tpl.mjs` that runtime code imports. Skips objects, arrays, null, functions, NaN/Infinity. |
| `{% getFiles <var> root="..." include="..." exclude="..." import="..." %}` | tag | Glob files under `root`; assign `[{path,dir,relPath,name}]` to `<var>` (renders nothing — use a `{% for %}`). `include`/`exclude` are comma-separated globs; attrs accept quoted strings or scope vars. Optional `import="<export>"` dynamically imports each file and attaches that export (e.g. `import="meta"` → `file.meta`); files that fail to import or lack the export are dropped. Requires the async render path. |
| `{% listFiles root="..." include="..." exclude="..." relative="true" %}` | tag | Convenience counterpart to `getFiles`: globs and renders a markdown bullet list of file names (or relative paths) inline. Glob-only. |
| `bulletList` | filter | Convert an array to a markdown bullet list |

The glob core (`globFiles`, `parseGlobList`) lives in `src/templating/lib/glob-files.ts`
and is shared by both file tags; it uses the `glob` package (matching `entryGlob`).
`getFiles import=` uses `importNamedExport` in `src/templating/lib/import-export.ts`.

**Async render:** the compiler renders via `engine.parseAndRender` (async) — see
`renderContent`/`compileTarget` in `markdown-compiler.ts`. This is required so tags
like `getFiles import=` can `import()` files. Do not revert to `parseAndRenderSync`;
`src/test/integration/get-files-tag.test.ts` guards this.

To add a tag: create `src/templating/tags/<name>.ts` exporting a `register<Name>Tag(engine)`
function, then add it to the array in `src/templating/tags/index.ts`. Filters follow the
same pattern under `filters/`.

@${sousDir}/prompts/_partials/sources-of-truth.md

## Important!

When working on `sous`, keep this document accurate — but remember it is GENERATED:
edit the tracked source at `.sous/prompts/root/CLAUDE.md` (never the compiled root
`CLAUDE.md`) immediately after any change to sous, its code, its configuration, or its
usage, then run `npm run sous:build`. It is VITAL that this file ALWAYS describes `sous`
ACCURATELY. The same rule applies to the website doc: `.sous/prompts/docs-site/CLAUDE.md`
is the source of `docs/CLAUDE.md`.
