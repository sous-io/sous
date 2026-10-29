/**
 * plugin-variables: ${var} substitution, _vars resolution, auto-variables, variable names and secrets.
 *
 * S6, "Shared building blocks (variables.*, variable-source)". The contract other plugins code against is `./types.ts`.
 */

import { definePlugin, type PluginDefinition } from "@sous-io/plugin-api";
import { isAutoVariable } from "./auto.js";
import { variablesNames } from "./names.js";
import { Resolver } from "./resolver.js";
import { CONFIG_KEYS, VARIABLE_SOURCE_SCHEMA } from "./schemas.js";
import { Secrets } from "./secrets.js";
import type { VariableSourceEntity } from "./types.js";
import type {} from "@sous-io/plugin-host/types";
import "./types.js";

/** The plugin's name. */
export const PLUGIN_NAME = "@sous-io/plugin-variables";

/** The id of the contributor that warns about `_vars` names in the reserved `sous*` namespace. */
export const RESERVED_NAMES_CONTRIBUTOR = "variables/reserved-names";

/** The plugin. */
export const variablesPlugin: PluginDefinition = definePlugin({
    name: PLUGIN_NAME,
    version: "0.2.34",
    description: "${var} substitution, _vars resolution, auto-variables, variable names and secrets.",
    dependsOn: {
        "@sous-io/plugin-host": "^0.2.34",
    },

    register(sous) {
        // A singleton, not a `config` service: contributors (the config files, the expressions in
        // them) need scopes while the config is built, and only singletons can be used then.
        sous.services.add(
            "variables.resolver",
            (_config, ctx) => new Resolver({ services: sous.services, engine: sous.engine, env: ctx.env, project: ctx.project }),
            { lifetime: "singleton" },
        );
        sous.services.add("variables.names", () => variablesNames, { lifetime: "singleton" });
        sous.services.add(
            "variables.secrets",
            (config, ctx) =>
                new Secrets(
                    () => ctx.entities.list("variable-source") as VariableSourceEntity[],
                    () => ({ project: ctx.project, env: ctx.env, config }),
                ),
            { lifetime: "config" },
        );

        sous.entities.define("variable-source", VARIABLE_SOURCE_SCHEMA, {
            description: "An extra source of config variables, such as recipe answers.",
        });

        for (const key of CONFIG_KEYS) {
            sous.entities.add("config-key", key);
        }

        // Names starting with `sous` may clash with auto-variables added later: say so, never refuse (L6).
        sous.config.contribute({
            id: RESERVED_NAMES_CONTRIBUTOR,
            contribute(config) {
                const vars = config.atPath("_vars");

                for (const name of vars.isObject() ? vars.keys() : []) {
                    if (name.startsWith("sous") && !isAutoVariable(name)) {
                        config.log(
                            "warning",
                            `The variable "${name}" uses the reserved "sous*" namespace and may clash with a variable sous sets.`,
                        );
                    }
                }
            },
        });
    },
});

export default variablesPlugin;

export type * from "./types.js";
