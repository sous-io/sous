# ADR 0016: Intents, front ends as plugins, and our own CLI foundation

**Status:** Accepted, 2026-10-29.

This record summarizes a decision of the 1.0 architecture. The source of truth is
[S1: The Engine](../architecture/specifications/S1-engine.md) ("The Shape", "Chains and the
Scheduler", "Intents", "Front Ends"), with the owners in
[S6: Concerns and Owners](../architecture/specifications/S6-concerns-and-owners.md) ("Front ends").
Where this record and those files disagree, they win. It amends ADR 0003 and ADR 0011, whose
`BaseCommand` statics go with `BaseCommand`.

## Context

Before 1.0, every user-facing operation is an oclif command class in `src/commands/`, extending
`BaseCommand`, and much of the logic lives inside those classes. An MCP server, a web GUI or an
agent could only reach an operation by repeating it. `sous --help` imports all 36 command modules,
which is a large part of why it took about a second.

The maintainer described the shape he wanted:

> "sous builds a config then enters into a mode of processing intents. For most CLI commands, this
> will be a single intent. For some CLI commands, this will be a series of intents, or a chain of
> intents that may have some intents processing in parallel. For the MCP server, this will be
> asynchronous intents coming in throughout the lifetime of the connection, etc."
>
>   -- **Luke Chavers** in an agent session (2026-10-25)

## Decision

- **Every user-facing operation is written once, as an intent**: a name, a typed input schema and
  one handler that returns a result. `sous config show` is an intent too, run after the config is
  built. A handler starts other intents with `ctx.run`; an intent may be internal, and any plugin may
  wrap it or listen to its `before`, `after` and `error` events.
- **Chains run in series by default.** A chain is one submitted intent and everything it starts. A
  chain may declare itself parallel when it writes nothing other chains could see. After a series
  chain that changed the config, the config is rebuilt before the next chain starts.
- **Front ends are plugins.** The CLI (`plugin-cli`), the MCP server (`plugin-mcp`, `sous mcp`) and a
  web GUI submit the same intents, each handing over its own `Reporter` and `Prompter`, so each
  chain's output and questions go back to whoever asked. Every front end can do anything another
  can. Servers and watch mode are background intents that submit chains as requests arrive.
- **Commands, flags and MCP tools are generated from each intent's declaration.** Every input is a
  flag, so every prompt has a flag that answers it. An intent may add a `cli` section (command path,
  aliases, positional arguments, examples, hidden) and an `agent` section (tool name, usage, when
  not to use it, hidden).
- **Our own CLI foundation replaces oclif**, built on Node's `util.parseArgs`. oclif expects one
  class per command in its own files, which commands generated from intents would only reach
  through its internals, and loading every command for `--help` works against the 150ms budget for
  `--help` and shell completion. A command's code loads only when it runs.
- **Every command and flag users type today survives**, since they become intents' declarations.
  Every command also accepts `--log-level <level>` (the eight syslog levels), `--debug` and
  `--timings`.

## Consequences

- `BaseCommand`, `src/commands/` and their statics (`requiresConfig`, `toleratesConfigErrors`) are
  removed; what they decided becomes part of the intents.
- An agent using `sous mcp` gets every operation the CLI has, and `sous vars ask` works there through
  MCP elicitation.
- A plugin adds a command by adding an intent; it adds an argument every command accepts, or a
  command group's help, by adding a `cli-global-argument` or `cli-group` entity.
- Two intents claiming the same command or alias is an error naming both plugins, unless the config
  picks the winner.
