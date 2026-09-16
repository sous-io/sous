# ADR 0005: Follow-ups from the first project on the hand-off

**Status:** Accepted, 2026-09-16.

This record amends [ADR 0003](0003-project-init.md) in one place (where `sous init` writes the
starter prompt, and what it does to a `package.json`) and [ADR 0004](0004-project-install-handoff.md)
in one (when the hand-off announces itself); everything else both say still holds. The living
answers are the `sous init` entry in the [command reference](../commands.md) and
[Installing](../README.md#installing); the process record is
[gh-10](https://github.com/sous-io/sous/issues/10).

## Context

The first real project to run under the hand-off surfaced four small gaps in one afternoon. A
hand-off between two copies of the same version was silent even when `--verbose` asked for
detail. An include written `@~/.devarch/DEVARCH.md` was tried literally, because a leading `~`
is the alias and namespace sigil and nothing expanded a bare `~/`. An include written
`@SHARED.md` failed because the file had since become `SHARED.tpl.md`, which is the ordinary
life of a file in a project that grows. And `sous init` wrote its starter prompt under
`.sous/prompts/`, while the thing it holds is a memory in the sense this project uses the word:
content composed into an agent's always-loaded instruction file. None of these needed a design;
each needed a decision.

## Decision

- **`--verbose` announces every hand-off.** The notice prints when the two versions differ, and
  on every hand-off when `SOUS_DEBUG` is set or `--verbose` is on the command line, in the full
  form either way. Asking for verbose output and being told nothing about a hand-off that
  happened was the wrong reading of "verbose".
- **A leading `~/` in an include is the home directory.** The sigil followed by nothing but a
  separator names no alias and no namespace, so the expansion is unambiguous, and it is the same
  expansion the config-locating flags already get. `~project` and `~namespace` are untouched.
- **Every include candidate is followed by its `.tpl.` twin.** `@shared.md` finds
  `shared.tpl.md`, and `@notes.tpl.md` finds `notes.md`. The literal spelling is tried first, and
  the twin comes right after it per candidate rather than after every other candidate, so an
  alias base still beats the relative fallback. A writer should never have to know whether an
  included file has been turned into a template or back. The twin's content is included as it
  is; whether Liquid inside it renders is still decided by the entry point being a `.tpl.` file.
- **`sous init` writes the starter prompt under `.sous/memories/`**, and its generated advice
  points there. ADR 0003 named `.sous/prompts/`; this supersedes that one path.
- **`sous init` adds `@sous-io/sous` to a project's `package.json`.** When the project has one
  and it does not already depend on sous in either section, the running version is added to
  `devDependencies` exactly, not as a range, because the point of a project install is to pin
  the version the templates were written against, and under a caret even a patch release moves
  the `core` pin in the committed lockfile. The file keeps its indentation and key order,
  `devDependencies` stays sorted the way npm keeps it, a package.json that is not JSON is
  refused by name before anything is written, and nothing is installed: sous does not guess
  which package manager a project uses, and says so in its summary.

## Consequences

- The hand-off notice is silent in the common case and complete when asked; the change is
  covered by the rules spec and the end-to-end test.
- Includes accept two more spellings, so an existing project loses nothing; a project that
  relied on `@x.md` NOT finding `x.tpl.md` beside a missing `x.md` would now include it, which is
  judged the right outcome. The integration test in `src/test/integration/compilation.test.ts`
  holds the literal-first order.
- A project set up by an older `sous init` keeps its `.sous/prompts/AGENTS.md`; nothing moves
  it, and the config it wrote still names it.
- A fresh `sous init` in a project with a `package.json` leaves the dependency to be installed;
  the summary's "Dependency" row says so. Until it is installed, the global sous keeps running
  the project, exactly as before.
