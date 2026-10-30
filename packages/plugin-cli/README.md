# @sous-io/plugin-cli

The sous command line. Every command, flag, help page and shell completion is generated from the intents plugins register, so a plugin gets a command by adding an intent and nothing else.

What it does:

- Turns intents into a command tree (`sous config show`), with aliases, positional arguments and flags generated from each intent's input schema.
- Parses `argv`, submits the intent to the engine, and prints the result.
- Provides the terminal `Reporter` (log levels, `--debug`) and `Prompter` (questions; with no terminal it fails naming the flag that answers each one).
- Turns errors into messages and exit codes.

## Using it from code

The `sous` package loads it as a built-in plugin. A test can run it against an engine:

```ts
import { createEngine } from "@sous-io/core";
import { cliPlugin } from "@sous-io/plugin-cli";

const engine = createEngine({ builtIns: [cliPlugin, ...otherPlugins], cwd, env });
await engine.buildConfig();
await engine.frontEnd("cli").start(["config", "show"]);
```

## Where things are

- `src/plugin.ts`, `src/front-end.ts`: the plugin and the front end that takes over after the config is built.
- `src/command-tree.ts`, `src/flags.ts`, `src/parse.ts`: command tree, flags from schemas, argument parsing.
- `src/help.ts`, `src/completion.ts`: help pages and completions.
- `src/views.ts`, `src/views/`: how each intent's result is printed.
- `src/terminal-reporter.ts`, `src/terminal-prompter.ts`, `src/errors.ts`: output, questions, exit codes.

## Testing

```bash
pnpm --filter @sous-io/plugin-cli test
```
