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
- **G10.** Config as desired state. Once the config is built, it holds everything sous needs to
  know what it should make true: the desired state, and the inputs used to compute it (such as the
  host's platform). Code that acts makes the project match the config. Which contributor set each
  value is recorded beside the config, not in it.

  > "once the config is built, it contains 100% of all information Sous needs to understand the
  > desired state and how it was arrived at."
  >
  >   -- **Luke Chavers** in an agent session (2026-11-16)

## Changes

- **2026-11-16: G10 added**, by Luke's ruling. Reason: the build already works this way (plugins
  add compilation targets to the config, and the compiler makes the project match them), and Luke
  wants it written down and kept as an ideal:

  > "'Config as desired state' is something we should document and maintain as a goal and ideal"
  >
  >   -- **Luke Chavers** in an agent session (2026-11-16)

  Law L8 (declarations as config) is the rule that serves this goal.
