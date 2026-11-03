# ADR 0023: Chains can run against a "what if" config

**Status:** Accepted, 2026-11-03, by Luke's approval of the web GUI's changes: "I'm ok with even
large changes to the existing code to not only make the web UI work, but make it work effectively
and efficiently" (Luke, in an agent session, 2026-11-02).

How it works is described in [the engine specification](../architecture/specifications/S1-engine.md),
section "Front Ends", rule 6.

## Context

The engine could build a "what if" config (`engine.buildConfig({ extraContributors })`), but no
chain could run against one: `engine.submit` always used the current config. The web GUI previews
almost everything it shows (another value for a variable, an edit not yet saved, a recipe update) by
asking what a build would produce under a changed config.

## Decision

1. `SubmitOptions.config` takes a what-if config. The chain's `ctx.config`, `ctx.services`,
   `ctx.entities` and nested `ctx.run` calls all see it.
2. A what-if chain only reads: an intent declaring `changesConfig` fails, `ctx.refreshConfig()`
   fails, and background intents refuse the option. A config that is not a what-if one is refused.

## Alternatives

- **Each preview reimplements the build against a changed config.** Breaks L1 (one owner).
- **Let the what-if chain write.** A write made under a config that is not the real one could leave
  the project in a state no real build produces.
