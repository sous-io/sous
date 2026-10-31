# ADR 0016: Intents, front ends as plugins, and our own CLI foundation

**Status:** Accepted, 2026-10-29.

This record summarizes a decision of the 1.0 architecture. The details are in
[the engine specification](../architecture/specifications/S1-engine.md) (its sections on intents,
chains and front ends), with the plugins that own each front end in
[Concerns and Owners](../architecture/specifications/S6-concerns-and-owners.md). Where this record
and those files disagree, they win. It amends [ADR 0003](0003-project-init.md) and
[ADR 0011](0011-self-update.md), whose command-class settings go away with the command classes.

## Context

Before 1.0, every operation a user runs is an oclif command class, and much of the logic lives
inside those classes. An MCP server, a web GUI or an agent could only reach an operation by
repeating its code. `sous --help` loads every command module, a large part of why it took about a
second.

The maintainer described the shape he wanted:

> "sous builds a config then enters into a mode of processing intents. For most CLI commands, this
> will be a single intent. For some CLI commands, this will be a series of intents, or a chain of
> intents that may have some intents processing in parallel. For the MCP server, this will be
> asynchronous intents coming in throughout the lifetime of the connection, etc."
>
>   -- **Luke Chavers** in an agent session (2026-10-25)

## Decision

- **Every operation is written once, as an intent**: a name, a typed input and one handler that
  returns a result. An intent can start other intents, may be internal, and any plugin may wrap it
  or listen for the events sent before it runs, after it runs and when it fails.
- **Chains run one at a time by default.** A chain is one intent asked for from outside, plus every
  intent it starts. A chain may declare that it can run alongside others when it writes nothing
  other chains could see. After a chain that changed the config, the config is rebuilt before the
  next chain starts.
- **Front ends are plugins.** The CLI, the MCP server (`sous mcp`) and a web GUI all ask for the
  same intents, each supplying its own way to show output and ask questions, so a chain's output
  and questions go back to whoever asked. Every front end can do anything another can. Servers and
  watch mode are long-running intents that start chains as requests arrive.
- **Commands, flags and MCP tools are generated from each intent's declaration.** Every input is a
  flag, so every question sous can ask has a flag that answers it ahead of time. An intent may add
  CLI details (command name, aliases, examples) and details for agents (tool name, when to use it).
- **Our own CLI foundation replaces oclif**, built on Node's `util.parseArgs`. oclif expects one
  class per command in its own file, which generated commands could reach only through its
  internals, and it loads every command for `--help`, which works against the goal of `--help` and
  shell completion taking under 150ms. A command's code loads only when it runs.
- **Every command and flag users type today keeps working**, since each becomes part of an
  intent's declaration. A few options, such as the log level and `--timings`, are added to every
  command.

## Consequences

- `BaseCommand`, `src/commands/` and their per-command settings are removed; what those settings
  decided becomes part of the intents.
- An agent using `sous mcp` gets every operation the CLI has, and questions such as those of
  `sous vars ask` reach it through MCP.
- A plugin adds a command by adding an intent.
- Two intents claiming the same command or alias is an error naming both plugins, unless the config
  picks the winner.
