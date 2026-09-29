# ADR 0006: `sous repo init` follows `sous-recipes`

**Status:** Accepted, 2026-09-29.

This record amends [ADR 0001](0001-repositories.md) in one place: what `sous repo init` scaffolds.
Everything else it says about the command still holds. The living answer is
[Create a repository](../repositories-authoring.md#create-a-repository).

## Context

`sous-io/sous-recipes` gained a `CONTRIBUTING.md`, a root `CLAUDE.md` and a README "Contributing"
section, all written for agents, and a fresh `sous repo init` wrote none of them. The sous
maintainers asked for the two to stay together:

> "Basically `sous repo init` should produce a repo that is basically as good as and complete as
> `sous-recipes`, minus the content, itself. Conversely, any improvements we make to `sous-recipes`
> should, very often, end up in the `sous repo init`."
>
> Luke Chavers, sous maintainer, 2026-09-29

Separately, sous's own convention is that every markdown file sous compiles is named `*.tpl.md`,
and every skill ends with a footer whose source path only a render fills in.

## Decision

- **`sous-recipes` is the model a scaffold follows.** A new repository is as complete as it, minus
  its recipes. An improvement to a root-level file of either SHOULD reach the other; the instruction
  lives in `sous-recipes`' own `CLAUDE.md`, and nothing checks the two against each other
  mechanically.
- **The scaffold writes `CONTRIBUTING.md`, `CLAUDE.md` and `AGENTS.md`.** `CONTRIBUTING.md` is
  `sous-recipes`' own, word for word apart from the name. `CLAUDE.md` follows `sous-recipes`', minus
  what is only true there, and ends by naming the repository it was modeled on. `AGENTS.md` is one
  line pointing at `CLAUDE.md`, for agents that read only `AGENTS.md`. Both point at the sous core
  skills, online on `main`, rather than restating them, because the core skills are the source of
  truth for how a recipe repository works.
- **The README gains "Contributing" and "License".** "Contributing" is `sous-recipes`' section, word
  for word. "License" says the repository has none yet; the scaffold does not choose a license for
  its author.
- **The placeholder skill is `SKILL.tpl.md`** and ends with the recipe footer naming the example
  recipe. Repository documents sous never compiles (`README.md`, `CONTRIBUTING.md`, `CLAUDE.md`,
  `AGENTS.md`) keep their names.
- **The commented `contribute:` line in `sous.repo.yaml`** points at the repository's own
  `CONTRIBUTING.md` instead of a placeholder host.

## Consequences

- A repository scaffolded by an older sous keeps what it was given; nothing adds the new files to
  it.
- The scaffolded `CLAUDE.md` links to the core skills on `main`, so it describes the newest sous,
  which can be newer than the one that made it.
- `src/lib/repos/scaffold/index.spec.ts` holds the new files, the placeholder skill's footer, and a
  check that no scaffolded file contains an em-dash.
