# ADR 0041: A target one harness's build holds reaches that harness

**Status:** Accepted, 2026-11-20.

This record supersedes the merge rule for compilation targets in
[ADR 0040](0040-one-config-build-per-harness.md). The design is in
[One Config Build per Harness](../architecture/specifications/S8-per-harness-config-builds.md),
"The Merge", rules 6 and 7. The issue is [gh-267](https://github.com/sous-io/sous/issues/267).

## Context

Sous builds the config once with no harness and once per harness, then merges the builds (ADR 0040).
The merge walked only the targets of the build with no harness:

> "A target only a harness's build holds is not carried, since targets are not a `harness-list`."
>
>   -- S8, "The Merge", rule 6 (before this record)

So a recipe skills folder excluded for every harness but Claude Code (`harness.id != 'claude-code'`)
reached no harness at all, Claude Code included. No document recorded a reason for the rule. The
user on it:

> "I don't understand that statement, at all. Why would that be desirable, ever?"
>
>   -- **the user** in an agent session (2026-11-20)

Asked whether a carried target should keep every output its harness's build gave it or only that
harness's own, the user chose option 1, only that harness's own outputs.

## Decision

- **A target only a harness's build holds is carried, with only its outputs marked with that
  harness.** Unmarked outputs (a `recipes.skills.outputs` directory) and other harnesses' outputs
  are not kept; a target left with no output is dropped. Carried targets go after the targets of
  the build with no harness, harnesses in id order.
- **A target whose outputs are all marked with one harness comes whole from that harness's build.**
  Its `content` and `_vars` are then that harness's, so a memory a condition on `harness.id` gives
  one harness reaches that harness's memories file. (Agent choice, found while testing the rule
  above; the user has not ruled on it.)
- **The compiler takes a carried target's files from its harness's listing** (`compilation.files`
  of that build), since the build with no harness never listed them.

## Consequences

- `exclude` and `include` items with a condition on `harness.id` work for skills and memories, as
  the authoring docs show.
- A target several harnesses' builds hold, and the build with no harness does not, is carried once
  per harness, each copy with that harness's outputs, under the same `id`.
- The other values of a harness's build (settings such as `compilation.includeSourceComments`) are
  still not merged; ADR 0040's rule for them stands.
