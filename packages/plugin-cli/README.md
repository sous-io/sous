# @sous-io/plugin-cli

The sous command line. Every command, flag, help page and shell completion is generated from the intents plugins register, so a plugin gets a command by adding an intent and nothing else.

What it does:

- Turns intents into a command tree (`sous config show`), with aliases, positional arguments and flags generated from each intent's input schema.
- Parses `argv`, submits the intent to the engine, and shows the `IntentOutputs` it returns: under `--json`, `outputs.toPlain()` on standard output; otherwise `reporter.result(outputs)`. The exit code is `outputs.exitCode`. A background intent prints nothing.
- Provides the terminal `Reporter` (`TerminalReporter`: draws every report style with colors, glyphs, aligned blocks and tables; a command's result (`ReportEntryStyle.Result`) goes to standard output and every other message, at every level, to standard error; under `--json` everything goes to standard error; call `finish()` when a command's output is done) and `Prompter` (questions; with no terminal it fails naming the flag that answers each one).
- Draws what an intent returns: each output in order (`title` as a heading, `summary` as a paragraph, then the `result` payload by its `kind`: `VariableSet`, `Table`, `ItemList`, `Tree`, `TextBlock`, `DataValue`, or plugin-cli's own `HelpPage`). A payload passed as a message while an intent runs (`reporter.variables(...)`, `reporter.table(...)`) is drawn the same way, from the payload's own fields.
- Shows an error with its chain of causes (`Error: ...`, then `Caused by: ...` for each cause, with `SousError` details under each).

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
- `src/views/show.ts`: `showOutputs`, the `--json` / reporter switch. There are no per-intent views: an intent builds its own outputs. `src/views/` also holds the shared drawing helpers (tables, colors, text wrapping).
- `src/help-page.ts`: `HelpPage`, the payload the `help` intent and `--help` return; the reporter paints it, `toText()` gives it plain.
- `src/terminal/`: the layout and the per-style rendering `TerminalReporter` uses (`render-entry.ts` draws results, payloads and errors).
- `src/terminal-reporter.ts`, `src/terminal-prompter.ts`, `src/errors.ts`: output, questions, exit codes.

## Testing

```bash
pnpm --filter @sous-io/plugin-cli test
```
