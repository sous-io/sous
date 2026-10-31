# Goals of the Sous Refactor

Goals are what the refactor aims for. Every decision is weighed against them. Goals can pull against
each other; when a specification trades one goal for another, it says so. A goal never permits
breaking a [law](laws.md).

**Ranking:** [laws](laws.md), then goals, then [specifications](specifications/README.md), then
everything else (GitHub issues, ADRs, task files, notes outside `docs/markdown/architecture/`).

**Standing alone:** the files in `docs/markdown/architecture/` are the source of truth for the refactor. They never
cite anything outside `docs/markdown/architecture/`; whatever they rely on is copied in. Outside writings point here,
never the other way.

**Status:** Accepted on 2026-10-29. From now on, a goal
changes only under strong pressure and by a ruling from Luke, recorded under "Changes" with its
reason.

## Goals

- **G1.** We want strong encapsulation. Every concern should be centralized as best as it can be.
- **G2.** We want a plugin system.
- **G3.** Versatility, always: users and plugins should be able to do and change as much as
  possible, and every front end can do what any other can.
- **G4.** Sous should be predictable and observable. Users should always be able to inspect and
  understand every aspect of the things (such as the config) that drive its behavior, except the
  values of secrets.
- **G5.** Boundaries should be obvious and enforceable.
- **G6.** Every system should be designed for testability, and core systems should be thoroughly
  tested.
- **G7.** Our own tools within the monorepo can use any combination of Sous's parts. Outside the
  monorepo, the plugin interface is the only promise Sous makes.
- **G8.** Every core feature works without any particular agent tool. Features that only one tool
  supports are additions on top, never replacements.
- **G9.** Everything must be VERY fast.

## Changes

None yet.
