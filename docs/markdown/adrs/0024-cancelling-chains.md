# ADR 0024: Front ends can cancel a chain

**Status:** Accepted, 2026-11-03, by Luke's approval of the web GUI's changes: "I'm ok with even
large changes to the existing code to not only make the web UI work, but make it work effectively
and efficiently" (Luke, in an agent session, 2026-11-02).

How it works is described in [the engine specification](../architecture/specifications/S1-engine.md),
section "Front Ends", rule 7.

## Context

A chain could not be stopped once submitted. A web GUI starts many chains the user abandons (a
preview replaced by the next keystroke, a long build the user cancels), and each kept running to
the end.

## Decision

1. `SubmitOptions.signal` takes an `AbortSignal`; `ctx.signal` gives it to every step of the chain,
   nested `ctx.run` calls included. Without one, `ctx.signal` never aborts, so code never checks for
   its absence.
2. The engine checks it before each intent starts and throws `CancelledError`; a long step checks it
   itself or passes it on (to `fetch`, a child process).

## Alternatives

- **A `cancel(chainId)` method on the engine.** A front end would have to track chain ids, and a
  step could not pass it to `fetch` or a child process, which already take an `AbortSignal`.
