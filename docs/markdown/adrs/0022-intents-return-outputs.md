# ADR 0022: Intents return outputs; the CLI has no views

**Status:** Accepted, 2026-10-30, without review: "skip my review and go straight into building"
(Luke, in an agent session). Designed by Luke; the details listed as the agent's under "Decision"
are not ruled.

How it works is described in [the engine specification](../architecture/specifications/S1-engine.md),
sections "What an intent returns" and "Reporting: levels and styles". It changes
[ADR 0021](0021-reporting-levels-and-styles.md): results no longer go through views, and only
results go to standard output.

## Context

An intent returned plain data, and plugin-cli held a "view" for every intent that turned that data
into output. So the CLI had to know every plugin's result types, a plugin could not say how its own
result is shown, and nothing separated a command's result from the messages it printed while it ran.

> "having the CLI understand domains, or whatever the fuck we have going on right now, is stupid."
>
>   -- **Luke Chavers** in an agent session (2026-10-30)

## Decision

1. **A handler returns `IntentOutputs`**: ordered `IntentOutput`s, each with a title, a summary and a
   typed result (`VariableSet`, `Table`, ...) that the reporter knows how to show. Payload types
   convert to plain values (`toPlain()`, `toObject()`, ...); `IntentOutputs.toPlain()` returns the
   last output's plain object, never an array, so `--json`, MCP and calling intents get data.
2. **`message` is for people, `details` for machines**, and a style is only a hint.
3. **A failure that ends an operation is thrown** with its cause, and reported once, with the whole
   chain. A problem a component works around is reported and the work carries on.
4. **A command's result goes to standard output; everything else to standard error.**

   > "I'm fine following the convention that results go to stdout and everything else goes to
   > stderr."
   >
   >   -- **Luke Chavers** in an agent session (2026-10-30)

Filled in by the agent: an output's optional `data` (what machines get, so `--json` keeps domain data
rather than display text), `with()` for wrappers and events, `exitCode` on `IntentOutputs`, results
reported at `notice`, and a failure that ends a command at `critical`.

## Alternatives Not Chosen

- **Views moved into each plugin** (`present(result, reporter)` beside `handle`). It moves the code
  but keeps two steps, and the result is still untyped for the reporter.
- **A per-style flag marking result styles for standard output.** The same style is a result in one
  command and progress in another (`variables`, `table`, `list`).
