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

## Changes

None yet.
