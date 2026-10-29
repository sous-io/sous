# @sous-io/plugin-variables

${var} substitution, _vars resolution, auto-variables, variable names and secrets.

- **Specified in:** S6, "Shared building blocks (variables.*, variable-source)".
- **Capabilities (S7):** none of its own; S2 "Variable scopes".
- **Depends on:** `plugin-host` (`host.package`, `host.sous-home` for the auto-variables).
- **Contract:** `src/types.ts` declares every service, intent, event, entity kind and config key this
  plugin owns. Other plugins import it type-only: `import type {} from "@sous-io/plugin-variables/types";`.

## What it registers

| Name | Kind | Notes |
| --- | --- | --- |
| `variables.resolver` | service, singleton | A singleton so contributors can use it while the config is built |
| `variables.names` | service, singleton | |
| `variables.secrets` | service, config | Declared names come from `variable-source` entities |
| `variable-source` | entity kind | Values between the auto-variables and `_env` |
| `_vars`, `_env` | `config-key` entities | Auto-variable names are refused |
| `variables/reserved-names` | contributor | Warns about `_vars` names starting with `sous` |

## Reading variables while the config is built

Pass the contributor's builder itself, so every read is recorded and the contributor re-runs when a
variable it read changes (S2, "Config expressions are part of the same loop"):

```ts
sous.config.contribute({
    id: "my-plugin/defaults",

    contribute(config) {
        const vars = sous.services.get("variables.resolver").scopeIn(config, { level: "root" });

        // A variable not known yet in this pass is undefined, never an error.
        if (vars.machineRole === "laptop") {
            config.atPath("my.enabled").set(true);
        }
    },
});
```

After the build, `scope({ level: "output", target: 1, output: 0 })` gives a level of the built config,
and is strict: an unresolved value or an unset `_env` variable is a `ConfigError`.
