# @sous-io/plugin-api

The interface for writing a sous plugin, and the one package of sous that outside plugins depend on. It holds `definePlugin`, the types, the `Reporter` and `Prompter` interfaces and the error classes. It has no dependencies.

## Write your first plugin

A plugin is a module whose default export is `definePlugin({...})`. Its `register(sous)` runs once, when the plugin loads. Everything below goes inside it.

```ts
import { definePlugin } from "@sous-io/plugin-api";

export default definePlugin({
    name: "sous-plugin-diagrams",
    version: "1.0.0",
    dependsOn: { "@sous-io/plugin-skills": "^1.0.0" },

    register(sous) {
        // 1. A config contributor: adds to the config while it is built.
        sous.config.contribute({
            id: "diagrams",
            contribute(config) {
                if (config.atPath("diagrams.enabled").valueOr(true)) {
                    config.atPath("compilation.targets").appendValue({ id: "diagrams" });
                }
            },
        });

        // 2. An intent: a step with typed input. The CLI command and the MCP tool are generated from it.
        sous.intents.add({
            intent: "diagrams.render",
            summary: "Render every diagram",
            handle: async (input, ctx) => {
                ctx.reporter.info("Rendering");
                return { rendered: 0 };
            },
        });

        // 3. A listener: runs when an event fires.
        sous.on("config.built", (event, ctx) => {
            ctx.reporter.debug("Config built");
        });
    },
});
```

A contributor re-runs when something it read changes, so it must give the same result for the same input.

### Which contributor wins

When two contributors set the same key, the one whose patch applies last wins. Patches apply by `applyOrder`, a whole number from 0 to 99999 (default 2000): lower numbers apply first, and equal numbers apply in id order. The user's config files use 89900 and up, so they apply after every plugin and win.

`before` and `after` name contributors, plugins or wildcards (`"*"` means every other contributor). They win over the number: a contributor declared `after` another is moved to one past it, and the move is logged at the `debug` level. `sous config show --layers` shows each contributor's number, and the one it moved to.

```ts
sous.config.contribute({
    id: "diagrams/fixups",
    applyOrder: 3000,                   // after plugins left at the default (2000)
    after: ["@sous-io/plugin-skills"],  // and after every contributor of plugin-skills, whatever its number
    contribute(config) {
        config.atPath("diagrams.enabled").setValue(true);
    },
});
```

## Typed access to another plugin

Add your plugin's names to the interfaces in this package (declaration merging), and another plugin gets them typed. To use a plugin's names, import its types file with no runtime cost and list it in `dependsOn`:

```ts
// In sous-plugin-diagrams: describe what it provides.
declare module "@sous-io/plugin-api" {
    interface SousIntents {
        "diagrams.render": { input: { only?: string }; result: { rendered: number } };
    }
}

// In another plugin: the intent is now typed.
import type {} from "sous-plugin-diagrams/types";

const { rendered } = await ctx.run("diagrams.render", { only: "intro" });
```

`SousServices`, `SousEvents`, `SousEntities` and `SousConfig` work the same way, for `sous.services.get(name)`, event payloads, entity kinds and config keys.

## Where things are

- `src/plugin.ts`: `definePlugin` and the `sous` object `register` receives (everything a plugin can add).
- `src/config.ts`: contributors and the config builder they use.
- `src/intents.ts`, `src/events.ts`, `src/services.ts`, `src/entities.ts`: what each registry takes.
- `src/registry.ts`: the interfaces plugins add types to.
- `src/errors.ts`, `src/reporter.ts`, `src/prompter.ts`: the error classes, and how a plugin reports and asks.
- Real examples: any `packages/plugin-*` directory, for instance `packages/plugin-inspect`.

## Testing

```bash
pnpm --filter @sous-io/plugin-api test
```
