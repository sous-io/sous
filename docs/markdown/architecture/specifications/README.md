# Specifications of the Sous Refactor

A specification describes one piece of work the refactor will do, and the outcome it expects. It is
official, but parts of it may change as the work shows the need. Every change must be known,
understood and intentional.

**Ranking:** [laws](../laws.md), then [goals](../goals.md), then specifications, then everything else
(GitHub issues, ADRs, task files, notes outside `docs/markdown/architecture/`).

**Standing alone:** the files in `docs/markdown/architecture/` are the source of truth for the refactor. They never
cite anything outside `docs/markdown/architecture/`; whatever they rely on is copied in. Outside writings point here,
never the other way.

**Status:** Accepted on 2026-10-29. Every change is recorded under each specification's "Changes".

## Rules for Every Specification

1. Its file is named `S<n>-<brief-title>.md`. A number is never reused, and a dropped specification
   keeps its file, marked dropped.
2. It cites at least one goal it serves, by ID (`G1`). A specification that serves no goal does not
   exist.
3. It obeys every law, cited or not. It names a law (`L1`) only where that law shaped its design.
4. When it trades one goal against another, it says which and why.
5. It cites nothing outside `docs/markdown/architecture/`. A rule, decision or fact it needs from an issue, an ADR or
   a note is written into the specification itself.
6. It ends with a "Changes" section. After the plan is accepted, every change gets one dated entry:
   what changed, why, and who approved it, quoted when the approval came from Luke.
