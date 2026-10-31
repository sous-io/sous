# ADR 0021: Reporting as levels and styles

**Status:** Accepted, 2026-10-30. Designed by Luke.

How it works is described in [the engine specification](../architecture/specifications/S1-engine.md),
section "Reporting: levels and styles".

## Context

Plugins built their own output text (glyphs, indentation, aligned labels) and the CLI printed it as
given, so most output lost its color and the same layout was rebuilt by hand in many places. Command
results went through a second renderer, the plugin-cli views' `Printer`.

## Decision

1. **Every message is a level and a style.** A caller says how important a message is and what kind
   of entry it is, and passes the facts; each front end decides how each style looks. Styles are
   added as outputs need them.

   > "There may be many, many, different styles. We'll add a style every time we see the need for
   > one and each reporter will decide how to handle it."
   >
   >   -- **Luke Chavers** in an agent session (2026-10-30)

2. **Every reporting method is defined once, in `BaseReporter`**, and everything else (the
   `Reporter` type, every reporter, a mixin for other classes) is derived from it.

   > "I'm trying to avoid needing to define the convenience methods in more than one place."
   >
   >   -- **Luke Chavers** in an agent session (2026-10-30)

3. **Command results go through the reporter too**, so the terminal has one renderer per style.
4. **Progress and results go to standard output; warnings and errors to standard error.**

   > "3, our new "level" settings on output allow users to tune what output they see"
   >
   >   -- **Luke Chavers** in an agent session (2026-10-30), on progress
   >
   > "ok then, stderr is fine"
   >
   >   -- **Luke Chavers** in an agent session (2026-10-30), on warnings and errors

## Alternatives Not Chosen

- **Color the finished text in the CLI reporter.** It would have to guess what each line is from its
  characters (a line starting with `✓` is a written file), and MCP clients would still get text.
- **Keep the views' `Printer` beside the reporter.** Two renderers for the same shapes would drift.
- **Every level to standard output, as the old CLI did.** Both streams show in a terminal, so the
  choice matters only when output is piped or redirected; Luke kept warnings and errors on standard
  error.
