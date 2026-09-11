## Documentation and Sources of Truth

Three artifact types record how sous works, and each answers exactly one question:

- **The docs** (`docs/markdown/`) answer "how does it work right now?". They are the living
  record: updated whenever behavior changes, and they never carry history.
- **ADRs** (`docs/markdown/adrs/`) answer "what did we decide, and why?". They are append-only
  and immutable once finalized. The first ADR for a system records its full initial design;
  every later ADR records only the delta from the version before it.
- **GitHub issues** answer "what work happened, and how did we get there?". An issue is the
  process record, including mid-flight design changes.

Authority passes in a fixed sequence for every effort:

1. While an effort's issue is open, the ISSUE is the source of truth for that system's design;
   the design may still bend during implementation.
2. When the issue closes, its ADR is trued up to what was actually built and becomes the
   permanent decision record for that version.
3. The docs absorb the outcome and remain the answer to "right now".

Updating the docs and cutting the ADR are part of the DEFINITION OF DONE for any effort that
changes designed behavior; they are never optional follow-ups.
