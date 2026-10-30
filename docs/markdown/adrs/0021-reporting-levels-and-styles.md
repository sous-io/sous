# ADR 0021: Reporting as levels and styles

**Status:** Draft, 2026-10-30. Designed by Luke; built by the agent while Luke was away, awaiting
his review.

This record summarizes a decision of the 1.0 architecture. The details are in
[the engine specification](../architecture/specifications/S1-engine.md), section "Reporting: levels
and styles". Where this record and that file disagree, it wins.

## Context

Plugins reported through a `Reporter` with `log(level, message)`, `note()`, `warning()` and
`progress()`. Each caller built finished text: glyphs (`✓`, `▶`), indentation, hand-aligned
`Label : value` lines. The CLI's reporter could only print that text as it came, so everything a
command printed while it ran (all of `sous build`'s output, every warning) lost its color, and the
same layout was rebuilt by hand in dozens of places. Command results were printed by a separate
path, the plugin-cli views and their `Printer`, so the terminal had two sets of renderers.

## Decision

- **One method carries every message:**
  `log(level: LogLevel, message: string, details?: ReportDetails, style?: ReportEntryStyle)`. The
  level says how important it is; the style says what kind of entry it is; `details` carries its
  facts. A style is added whenever an output needs one, and each reporter decides how it looks.

  > "There may be many, many, different styles. We'll add a style every time we see the need for one
  > and each reporter will decide how to handle it."
  >
  >   -- **Luke Chavers** in an agent session (2026-10-30)

- **Level methods** on top of it: `debug`, `info`, `notice`, `warning` (and `warn`), `error`,
  `critical`, `alert`, `emergency` (and `emerg`), each `(message, details?, style?)`. A notice is not
  a note: `note()` is the Note style's method.
- **Style methods** on top of those: typed parameters turned into `message` and `details`, a default
  level the last parameter overrides, always their own style (`operationStart(operationName, level =
  LogLevel.Notice)`). Some have partners (`operationEnd`), as the thing they report needs.
- **Defined once.** Every method lives in `BaseReporter` in plugin-api; `Reporter` is derived from
  it; every reporter extends it; the `Reporting` mixin copies the methods onto any other class.

  > "I'm trying to avoid needing to define the convenience methods in more than one place."
  >
  >   -- **Luke Chavers** in an agent session (2026-10-30)

- **Progress is a style too.** The CLI draws one progress bar at a time and redraws it under other
  messages.
- **The views show results through the same reporter**, so the terminal has one renderer per style
  and `Printer` is gone.
- **Streams follow the level:** `debug`, `info` and `notice` go to standard output, `warning` and
  above to standard error; under `--json` only the JSON result goes to standard output.

  > "3, our new "level" settings on output allow users to tune what output they see"
  >
  >   -- **Luke Chavers** in an agent session (2026-10-30), choosing progress on standard output

## Consequences

- Plugin code never formats output; the CLI's look (colors, glyphs, alignment, wrapping) is decided
  in `TerminalReporter`, and MCP clients get the facts as data.
- A plugin written before this change calls `reporter.note(...)` and builds text; it must move to the
  level and style methods.
- `--log-level` now also decides what a command prints to standard output, since results and progress
  are messages with levels.
