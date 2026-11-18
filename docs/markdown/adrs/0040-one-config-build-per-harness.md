# ADR 0040: One config build per harness

**Status:** Accepted, 2026-11-16. Built 2026-11-18.

This record summarizes a decision of the 1.0 architecture. The details are in
[One Config Build per Harness](../architecture/specifications/S8-per-harness-config-builds.md). Where
this record and that file disagree, it wins.

## Context

"Harness" is the word Sous's code uses for a coding tool (Claude Code, Codex). A recipe author must
be able to write a condition on it, for example "leave this plugin out for every tool but Claude
Code". Nothing a recipe or a project writes could read it:

> "Sous has no internal understanding of the tool it is rendering for and cannot provide
> conditionals, anywhere, on the basis of tool/harness."
>
>   -- **Luke Chavers** in an agent session (2026-11-16)

## Decision

- **The config is built once with no harness, then once more for every registered harness.**
  `harness.id` is `""` in the first build and the harness's id in each other. A harness build may
  register another harness, which gets its own build; no harness is built twice.

  > "If we count the default run as `no-harness`, it could continue to run with `harness=undefined`
  > (or whatever)."
  >
  > "When anything adds a new and unique harness, a config build for that harness also kicks off, in
  > parallel"
  >
  >   -- **Luke Chavers** in an agent session (2026-11-16)

- **The harness is the only thing built this way.**

  > "something needs a variant only when one build, on one machine, must hold more than one value
  > of it at the same time AND we expect that value to be available in config conditionals."
  >
  >   -- **Luke Chavers** in an agent session (2026-11-16)

- **Intents read one merged config.** It is the build with no harness, with every list entry that
  belongs to one harness taken from that harness's build: compile outputs marked
  `harness: "<id>"`, and entries of `editor.edits` and `recipes.contents` that only a harness's build
  holds. Variables are never merged; an output brings the `_vars` written on it.
- **Every harness's full config stays reachable** (`ctx.config.forHarness(id)`), so a condition on a
  value that is not merged can still be acted on by code working for that harness.

  > "By defining everything that can vary based on harness, we potentially close doors to future
  > config dynamics based on harness and some harnesses are _very_ different than Codex and Claude.
  > As you know, I always favor versatility."
  >
  >   -- **Luke Chavers** in an agent session (2026-11-16)

- **Set aside:** running each intent once per harness. Pinned as workable with more decisions, not
  rejected.

## Consequences

- Config expressions, contributors and `.js` config files can branch on the harness:

    ```jsonc
    {
        "compilation": {
            "includeSourceComments": { "$if": "harness.id == 'codex'" }
        }
    }
    ```

- Each registered harness adds one full config build to every command that builds the config
  (117 ms of 436 ms on this repository with one harness, measured 2026-11-18). A project with no
  harness pays nothing.
- `sous config show --harness <id>` and `sous config get <path> --harness <id>` show one harness's
  build; `--layers` names the build of each change; `--timings` shows each harness build and the
  merge.
- A setting with a harness condition that is not a merged list entry, such as
  `compilation.includeSourceComments`, has its no-harness value in the merged config until the code
  that uses it reads the harness's own config.
