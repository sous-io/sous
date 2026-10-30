# @sous-io/core

The sous engine. It knows nothing about recipes, templates or commands; it only builds the config and runs plugins. Everything sous does comes from a plugin.

What it does:

- Loads plugins and builds the config: each plugin's config contributors add changes in order, and a contributor re-runs when something it read changes.
- Runs intents (named steps a user or plugin asks for) in chains, in series or in parallel.
- Keeps the registries plugins fill in: services, entities (typed lists other plugins read), and event listeners.
- Times everything and warns when a timing goes over its budget.

## Using it from code

Front ends and tests start the engine, build the config, then hand control to a front end. Plugins never import this package; they use `@sous-io/plugin-api`.

```ts
import { createEngine } from "@sous-io/core";

const engine = createEngine({ builtIns: [myPlugin], cwd: process.cwd(), env: process.env });
await engine.buildConfig();
await engine.frontEnd("cli").start(["config", "show"]);
```

`createEngine`'s options are documented on its type in `src/engine.ts`.

## Where things are

- `src/engine.ts`: `createEngine`, the object everything hangs from.
- `src/config/`: the config building loop, contributor ordering and stages, schema validation.
- `src/scheduler/`: chains of intents.
- `src/plugins/`: loading plugins, and the `sous` object each plugin's `register` receives.
- `src/intents/`, `src/events/`, `src/services/`, `src/entities/`: the registries.
- `src/timing/`: timers and default budgets. `src/limits.ts`: the loop and depth limits.
- Design: `docs/markdown/architecture/` in the repository root (start with `laws.md`).

## Testing

```bash
pnpm --filter @sous-io/core test
```
