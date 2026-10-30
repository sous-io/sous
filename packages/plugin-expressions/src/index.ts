/**
 * plugin-expressions: Config expressions and the expression languages plugins add.
 *
 * The contract other plugins code against is `./types.ts`.
 */

import { definePlugin, jsonSchema, type PluginDefinition } from "@sous-io/plugin-api";
import { createEvaluator } from "./evaluator.js";
import { createLiquidLanguage } from "./liquid-language.js";
import "./types.js";

/** The plugin's name. */
export const PLUGIN_NAME = "@sous-io/plugin-expressions";

/** The plugin. */
export const expressionsPlugin: PluginDefinition = definePlugin({
    name: PLUGIN_NAME,
    version: "0.2.34",
    description: "Config expressions and the expression languages plugins add.",
    dependsOn: {
        "@sous-io/plugin-liquid": "^0.2.34",
        "@sous-io/plugin-variables": "^0.2.34",
    },

    register(sous) {
        sous.entities.define(
            "expression-language",
            jsonSchema({
                type: "object",
                properties: { id: { type: "string" }, description: { type: "string" }, runsCode: { type: "boolean" } },
                required: ["id", "variables", "evaluate"],
            }),
            { description: "A language config expressions are written in, named after $expr: or expr:." },
        );
        sous.entities.add("expression-language", createLiquidLanguage());

        const evaluator = createEvaluator({
            services: sous.services,
            entities: sous.entities,
            // Read on each use: `sous init` sets a project up after the engine started without one.
            get project() {
                return sous.project;
            },
        });

        // A singleton: the config-file contributors use it while the config is built, when core
        // refuses every other lifetime.
        sous.services.add("expressions.evaluator", () => evaluator, { lifetime: "singleton" });

        // Once the config has settled, an expression still unknown is an error.
        sous.on("config.built", () => evaluator.settle());
    },
});

export default expressionsPlugin;

export { createEvaluator, isTruthy, toJson } from "./evaluator.js";
export type { Evaluator, EvaluatorDeps } from "./evaluator.js";
export { ExpressionError } from "./errors.js";
export { compareBytes, hasExpressions, isExpressionObject, isReservedKey, parseReservedKey } from "./keys.js";
export { createLiquidLanguage, LIQUID_LANGUAGE } from "./liquid-language.js";
export type * from "./types.js";
