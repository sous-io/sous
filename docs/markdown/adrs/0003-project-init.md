# ADR 0003: Project setup with `sous init`

**Status:** Accepted, 2026-09-15.

This record stands on its own; it amends nothing in [ADR 0001](0001-repositories.md) or
[ADR 0002](0002-recipe-answers-in-templates.md), and everything both say still holds. The living
answer to "how does it work right now?" is the `sous init` entry in the
[command reference](../commands.md) and [Discovery and overrides](../config-discovery.md); the
process record is [gh-7](https://github.com/sous-io/sous/issues/7).

## Context

A project had no path into sous except failure. Running any command without a config printed
the "No sous config found" block, which asked the reader to create `.sous/sous.config.js` by hand
from a sample inlined in the error. Everything else a real setup needs was documented only in
prose: the ignore entries for the state file and the local answers file, the two env files, the
`$schema` binding for a JSON config, and the fact that a first build seeds and pins the `core`
recipe. As sous is published for colleagues and outside users, first-run setup had to become one
command.

Two facts about the code shaped the design. Every command that works on a project extends
`BaseCommand`, whose `init()` discovers the config and fails when there is none, with no opt-out.
And the step a build runs before compiling (seed the core recipe, lock subscriptions, restore the
store, check upstream) was a private method on the build command, so no other command could run
"the same build".

## Decision

### One command writes the whole setup

- `sous init [directory]` writes a project's `.sous/` directory: a commented primary config, a
  starter prompt at `.sous/prompts/AGENTS.md` that the config compiles to `AGENTS.md` at the
  project root, `.sous/.env` and `.sous/.env.local.example`, and the sous-managed block in
  `.sous/.gitignore`. It then runs the first build, which seeds and pins `core` in the lockfile.
  `--no-build` skips the build and `--dry-run` writes nothing.
- The scaffolded config carries a `recipeOutputs` block naming only `skills`, at the built-in
  default. Memories and prompts are shown commented out: a blank destination would warn on every
  build, and sous cannot guess where a project wants either.
- `--format` chooses `js` (the default) or `json`. The JSON config carries `$schema` bound to the
  schema artifact published on GitHub for the running version. The top-level config schema is
  strict and has no comment key, so the JSON config carries no comment naming the package-local
  copy; the documentation does.
- The config is plain string builders, not templates. A scaffold is read by a person before it
  is read by a machine, and the comments are what make a first config legible.

### Refuse an existing setup, ask about a nested one

- A `.sous/` that already holds a primary config is refused, and so is any other file the scaffold
  would write, so a refused run has changed nothing. The one file init merges rather than
  replaces is `.sous/.gitignore`, through the same managed-block writer `sous repo link` uses, so
  the block is written once however many times it is applied.
- A target directory inside a project that is already set up is a question, not a refusal. The
  facts are stated (which config encloses it, and which config each directory's commands will
  find), and the run asks once; `--yes` answers ahead of time and a run with no terminal fails
  naming that flag. A subproject with its own instructions is a legitimate choice, and sous
  informs rather than prevents.
- After writing, the config is loaded back through the same loader every command uses, so a
  scaffold sous itself cannot read is never reported as a success.

### The base command gains one opt-out, not a second path

- `BaseCommand` carries a static `requiresConfig`, true everywhere except on `init`. Discovery
  still runs, so `--sous-dir` and `SOUS_DIR` decide where init writes, but finding nothing
  returns instead of failing. The steps after discovery (env files, the second layer enumeration,
  loading settings) move into `adoptConfig`, which `init()` calls for the config it found and
  `sous init` calls for the config it has just written. Extending oclif's `Command` directly, as
  the three authoring commands do, was rejected because it would have meant a second copy of
  discovery and of the settings load.
- The preparation step a build runs before compiling, and everything it reports, moves out of
  the build command into `src/lib/build-preparation.ts`, so init's first build is the same build
  `sous build` runs and the two say the same things about the same events.

### The error message points, and no longer copies

- The "No sous config found" block names `sous init` as the first fix and `--config` as the
  second, and no longer prints a config to copy. The issue proposed sharing one source between
  the inlined sample and the scaffold so they could not drift; once init writes the config there
  is nothing left to keep in step, so the sample was removed instead.

### The managed ignore block covers the local answers file

- `.env.local` joins the entries of the sous-managed block in `.sous/.gitignore`, beside the links
  map, the state file, the PID file and the linked checkouts directory. Every machine-local file
  under `.sous/` now has one home. An existing project picks the entry up on its next link or
  init.

## Consequences

- A new project's first run is `sous init`, and the next `sous build` succeeds with the core
  skills compiled and pinned. The integration test in `src/test/integration/init-command.test.ts`
  holds that promise offline.
- `requiresConfig` is a narrow seam: it exists for one command, and a future command that runs
  without a config should have as clear a reason as creating one.
- Existing projects see one new line appear inside their managed ignore block the next time sous
  writes it. That is a change to a tracked file, and it is deliberate.
