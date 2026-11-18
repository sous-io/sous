# Laws of the Sous Refactor

Laws are rules that every change in the refactor follows. A change either breaks a law or it does
not; there is no weighing. No agent breaks a law for any reason. If the work cannot go on without
breaking one, stop and ask Luke.

**Ranking:** laws, then [goals](goals.md), then [specifications](specifications/README.md), then
everything else (GitHub issues, ADRs, task files, notes outside `docs/markdown/architecture/`). Where any of those
disagrees with a law, the law wins and the other is wrong.

**Standing alone:** the files in `docs/markdown/architecture/` are the source of truth for the refactor. They never
cite anything outside `docs/markdown/architecture/`; whatever they rely on is copied in. Outside writings point here,
never the other way.

**Status:** Accepted on 2026-10-29. From now on, a law
changes only by an explicit ruling from Luke, recorded under "Changes" with its reason.

## Laws

- **L1.** Every concern has exactly one owner. Code that needs a concern uses its owner, and never
  reimplements the concern or reaches into the owner's data. Owners collaborate freely, and a
  concern may be made of smaller concerns, each with its own owner.
- **L2.** Each concern has one implementation. No old code path survives the refactor.
- **L3.** Services never print, prompt or exit the process. They return data and results, and
  report progress or ask questions only through interfaces the command layer supplies; only the
  command layer presents anything to the user.
- **L4.** Anything sous lets a user do through an interactive prompt can also be done without one,
  through a flag or argument, so an agent running sous can do what the user wants.
- **L5.** Every core stage, and every call into a plugin (contributors, intents, listeners and
  service methods), is timed, and each has a budget.
- **L6.** Sous never forbids something a user or a plugin may want to do, unless a law requires it.
  Where a choice is risky, sous identifies the problem, reports it, and lets it happen.

  > "I'm not especially interested in policing, only in identifying problems and reporting them,
  > and in versatility."
  >
  >   -- **Luke Chavers** in an agent session (2026-10-28)
- **L7.** When two approaches serve the goals equally, choose the one that gives users and plugins
  more versatility.
- **L8.** Declarations as config. Anything that declares what sous should do or produce (a recipe
  manifest, and every file like it added later) is added to the config as values, by a
  contributor, during config building. Other contributors respond to those values by adding more
  config. Code that acts reads the finished config, and never reads the declaration's source
  itself. All new code and every refactor of existing code follows this law.

  > "I want us to implement a rule, or law, that all new code and all refactors of existing code
  > should follow this concept, unless it is definitely impractical (which should lead to
  > discussion)."
  >
  >   -- **Luke Chavers** in an agent session (2026-11-16)

  Where following it looks impractical, the opening rule of this file applies: stop and ask Luke.

## Changes

- **2026-11-16: L8 added**, by Luke's ruling. Reason: a recipe manifest states what a recipe wants
  to exist in a project, yet its `contents` list was read from the manifest by a service and never
  became config values, so it had no key paths, no record of who set each value and no expression
  evaluation. Luke wants manifests, and everything like them added later, to work as the rest of
  the engine does: plugins add config, then intents act on it. Code written before this date that
  reads a declaration's source directly is brought in line when it is next refactored; the first
  such change is named "manifests as config" and moves a manifest's entries into the config.
