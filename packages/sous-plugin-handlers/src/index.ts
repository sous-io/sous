/**
 * sous-plugin-handlers: functions a recipe or a plugin provides for a purpose (`check`,
 * `configure`, `beforeBuild`, `afterBuild`, `uninstall`, `migrate`), the helpers they receive,
 * and the intents that run them.
 *
 * The contract other plugins code against is `./types.ts`.
 */

import { definePlugin, HANDLER_PURPOSES, jsonSchema, type Context, type HandlerPurpose, type PluginDefinition, type SousSchema } from "@sous-io/sous-plugin-api";
import type {} from "@sous-io/sous-plugin-host/types";
import type {} from "@sous-io/sous-plugin-recipes/types";
import { configureContributor } from "./configure.js";
import { checkHandlersCheck } from "./doctor-check.js";
import { registerLifecycle } from "./lifecycle.js";
import { recipeDeclarationsContributor, recipeHandlersContributor, RECIPE_HANDLERS_KEY } from "./recipes.js";
import { handlerOutputs, runHandlers } from "./run.js";
import { createHandlersSystem } from "./system.js";
import type { HandlerEntity, HandlerRunResult, HandlersIntentInput, HandlersMigrateInput, RecipeHandlerDeclaration } from "./types.js";
import "./types.js";
import packageJson from "../package.json" with { type: "json" };

/** The plugin's name. */
export const PLUGIN_NAME = "@sous-io/sous-plugin-handlers";

/** The `handler` entity kind. `handle` must be a function. */
export const handlerSchema: SousSchema<HandlerEntity, HandlerEntity> = (() => {
    const base = jsonSchema<HandlerEntity>({
        type: "object",
        required: ["id", "purpose"],
        properties: {
            id: { type: "string", description: "Names the handler in timings and reports." },
            purpose: { enum: [...HANDLER_PURPOSES], description: "What it is for." },
            order: { type: "number", description: "Lower runs earlier within the purpose. Default 500." },
            recipe: { type: "string", description: "The recipe that lists it, for a handler from a manifest." },
            plugin: { type: "string", description: "The plugin that added it, for a handler from a plugin." },
            source: { type: "string", description: "Where it came from: the file and export." },
        },
    });
    const standard = base["~standard"];

    return {
        "~standard": {
            ...standard,
            validate(value: unknown) {
                const result = standard.validate(value) as { value?: HandlerEntity; issues?: unknown };

                if (result.issues === undefined && typeof (value as { handle?: unknown } | null)?.handle !== "function") {
                    return { issues: [{ path: ["handle"], message: "Expected a function." }] };
                }

                return result;
            },
        },
    } as SousSchema<HandlerEntity, HandlerEntity>;
})();

/** The `recipes.handlers` config key: each handler a recipe's manifest lists, as values. */
export const recipeHandlersKeySchema: SousSchema<RecipeHandlerDeclaration[], RecipeHandlerDeclaration[]> = jsonSchema<RecipeHandlerDeclaration[]>({
    type: "array",
    items: {
        type: "object",
        required: ["recipe", "purpose", "file", "handler"],
        properties: {
            recipe: { type: "string" },
            purpose: { enum: [...HANDLER_PURPOSES] },
            file: { type: "string" },
            handler: { type: "string" },
        },
    },
});

/** The intent that runs one purpose's handlers: `handlers.check`, `handlers.beforeBuild`, ... */
export function handlersIntent<const P extends Exclude<HandlerPurpose, "configure">>(purpose: P): `handlers.${P}` {
    return `handlers.${purpose}`;
}

/**
 * Runs one purpose's handlers as an intent, so its timing, `.before` and `.after` events and
 * reports belong to the chain, and gives the result. This is what the `build` intent calls.
 *
 * ```ts
 * const checks = await runHandlerPurpose(ctx, "check", { ignoreFailedChecks: input.ignoreFailedChecks });
 *
 * if (checks.failed) {
 *     throw checksFailedError(checks);
 * }
 * ```
 */
export async function runHandlerPurpose(
    ctx: Pick<Context, "run">,
    purpose: "check" | "beforeBuild" | "afterBuild" | "uninstall",
    input: HandlersIntentInput = {},
): Promise<HandlerRunResult> {
    return (await ctx.run(handlersIntent(purpose), input)).toPlain() as unknown as HandlerRunResult;
}

const intentInputSchema = jsonSchema<HandlersIntentInput>({
    type: "object",
    properties: {
        recipes: { type: "array", items: { type: "string" }, description: "Only the handlers of these recipes" },
        ignoreFailedChecks: { type: "boolean", description: "Report errors from checks as warnings" },
    },
});

const migrateInputSchema = jsonSchema<HandlersMigrateInput>({
    type: "object",
    required: ["recipe", "from", "to"],
    properties: {
        recipe: { type: "string", description: "The recipe that moved: namespace/recipe" },
        from: { type: "string", description: "The version it moved from" },
        to: { type: "string", description: "The version it moved to" },
    },
});

const SUMMARIES: Record<Exclude<HandlerPurpose, "configure">, string> = {
    check: "Run the check handlers: prerequisites such as installed commands",
    beforeBuild: "Run the handlers that run before a build",
    afterBuild: "Run the handlers that run after a build",
    uninstall: "Run the uninstall handlers of recipes being removed",
    migrate: "Run a recipe's migrate handlers after it moved to a new version",
};

/** The plugin. */
export const handlersPlugin: PluginDefinition = definePlugin({
    name: PLUGIN_NAME,
    version: packageJson.version,
    description: "Handlers: functions a recipe or plugin provides for a purpose, the helpers they receive, and the intents that run them.",
    dependsOn: {
        "@sous-io/sous-plugin-host": `^${packageJson.version}`,
        "@sous-io/sous-plugin-recipes": `^${packageJson.version}`,
        "@sous-io/sous-plugin-doctor": `^${packageJson.version}`,
    },

    register(sous) {
        sous.entities.define("handler", handlerSchema, {
            description: "A function a recipe or plugin provides for a purpose: check, configure, beforeBuild, afterBuild, uninstall or migrate.",
        });

        sous.entities.add("config-key", {
            id: RECIPE_HANDLERS_KEY,
            schema: recipeHandlersKeySchema,
            description: "The handlers the active recipes' manifests list, one entry each.",
        });

        sous.services.add("handlers.system", (_config, ctx) => createHandlersSystem(() => ctx.services.get("host.processes"), ctx.env), {
            lifetime: "singleton",
        });

        sous.config.contribute(recipeDeclarationsContributor());
        sous.config.contribute(recipeHandlersContributor());
        sous.config.contribute(configureContributor(() => sous.services));

        for (const purpose of ["check", "beforeBuild", "afterBuild", "uninstall"] as const) {
            sous.intents.add({
                intent: handlersIntent(purpose),
                summary: SUMMARIES[purpose],
                input: intentInputSchema,
                requiresProject: true,
                internal: true,
                handle: async (given, ctx) => {
                    const input = given as HandlersIntentInput;

                    return handlerOutputs(
                        await runHandlers(ctx, purpose, {
                            ...(input.recipes === undefined ? {} : { recipes: input.recipes }),
                            ...(purpose === "check" && input.ignoreFailedChecks === true ? { ignoreFailedChecks: true } : {}),
                        }),
                    );
                },
            });
        }

        sous.intents.add({
            intent: "handlers.migrate",
            summary: SUMMARIES.migrate,
            input: migrateInputSchema,
            requiresProject: true,
            internal: true,
            handle: async (input, ctx) => handlerOutputs(await runHandlers(ctx, "migrate", { recipes: [input.recipe], input: { from: input.from, to: input.to } })),
        });

        registerLifecycle(sous);

        sous.entities.add("doctor-check", checkHandlersCheck);
    },
});

export default handlersPlugin;

export { checksFailedError, DEFAULT_ORDER, orderHandlers, runHandlers } from "./run.js";
export { createHandlersSystem, versionIn } from "./system.js";
export { recipeHandlerId, RECIPE_HANDLERS_KEY } from "./recipes.js";
export { recordMoves, runPendingMigrations } from "./lifecycle.js";
export { CONFIGURE_CONTRIBUTOR } from "./configure.js";
export { checkHandlers, checkHandlersCheck } from "./doctor-check.js";

export type * from "./types.js";
