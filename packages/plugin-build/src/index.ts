/**
 * plugin-build: the build, compile, prune and clear intents, preparing for a build, watch mode, the
 * PID file and the runtime context file.
 *
 * S6, "Build: plugin-build". The contract other plugins code against is `./types.ts`. It only runs
 * other plugins' intents and services, by name: the compiler compiles, prunes and writes; the
 * recipes plugin locks and restores; recipe-answers says what is unanswered.
 */

import { definePlugin, type PluginDefinition, type ServiceReader } from "@sous-io/plugin-api";
import { isProcessAlive, PidFile } from "./pid.js";
import { RuntimeContextService } from "./runtime-context.js";
import {
    buildInputSchema,
    clearInputSchema,
    compileInputSchema,
    prepareInputSchema,
    pruneInputSchema,
    runtimeContextSchema,
    watchInputSchema,
    watchSettingsSchema,
} from "./schemas.js";
import type { SignalSource } from "./watch/intent.js";
import type { WatchSession } from "./watch/session.js";
import type { Timers, WatcherFactory } from "./watch/watcher.js";
import type { RuntimeContextSettings } from "./types.js";
import type {} from "@sous-io/plugin-git/types";
import type {} from "@sous-io/plugin-host/types";
import type {} from "@sous-io/plugin-variables/types";
import "./types.js";

/** The plugin's name. */
export const PLUGIN_NAME = "@sous-io/plugin-build";

/** The plugin's version. */
export const PLUGIN_VERSION = "0.2.34";

/** What can be swapped in {@link createBuildPlugin}, for tests and other hosts. */
export interface BuildPluginOptions {
    /** Starts a file watcher. Default: chokidar. */
    createWatcher?: WatcherFactory;
    /** Where stop signals come from. Default: the process. */
    signals?: SignalSource;
    /** The timers debouncing and polling use. Default: the process's. */
    timers?: Timers;
    /** Probes whether a PID is running. */
    isProcessAlive?: (pid: number) => boolean;
    /** Told about each watch session as it starts. */
    onWatchSession?: (session: WatchSession) => void;
    /** Where relative paths resolve with no project. Default: the chain's `ctx.cwd` (the engine's for services). */
    cwd?: () => string;
}

/** Builds the plugin. {@link buildPlugin} is the one sous ships. */
export function createBuildPlugin(options: BuildPluginOptions = {}): PluginDefinition {
    const cwd = options.cwd;

    return definePlugin({
        name: PLUGIN_NAME,
        version: PLUGIN_VERSION,
        description: "The build, compile, prune and clear intents, preparing for a build, watch mode, the PID file, the runtime context file.",
        dependsOn: {
            "@sous-io/plugin-compiler": "^0.2.34",
            "@sous-io/plugin-recipes": "^0.2.34",
            "@sous-io/plugin-recipe-answers": "^0.2.34",
            "@sous-io/plugin-git": "^0.2.34",
            "@sous-io/plugin-host": "^0.2.34",
            "@sous-io/plugin-variables": "^0.2.34",
        },

        register(sous) {
            sous.entities.add("config-key", {
                id: "watch",
                schema: watchSettingsSchema,
                description: "Watch mode: more paths that trigger a full rebuild, the debounce, and how often to check upstream.",
            });
            sous.entities.add("config-key", {
                id: "runtimeContext",
                schema: runtimeContextSchema,
                description: "The runtime context file a target with generateRuntimeContext includes: git branch and task file.",
            });

            sous.services.add(
                "build.pid",
                (_config, ctx) =>
                    new PidFile({
                        ...explicitPidPath(ctx.services),
                        project: ctx.project,
                        cwd: cwd?.() ?? ctx.cwd ?? ".",
                        isAlive: options.isProcessAlive ?? isProcessAlive,
                    }),
                { lifetime: "singleton" },
            );

            sous.services.add(
                "build.runtime-context",
                (config, ctx) =>
                    new RuntimeContextService({
                        settings: runtimeContextSettings(config.get("runtimeContext"), ctx.services),
                        git: () => ctx.services.get("git.runner"),
                        writer: () => ctx.services.get("compiler.writer"),
                        plugin: PLUGIN_NAME,
                    }),
                { lifetime: "config" },
            );

            sous.intents.add({
                intent: "build",
                requiresProject: true,
                summary: "Compile this project's outputs and remove the ones its config no longer produces",
                input: buildInputSchema,
                cli: {
                    examples: ["sous build", "sous build --no-prune", "sous build --rebuild", "sous build --dry-run"],
                    flags: { watch: { short: "w" }, changedFiles: { hidden: true } },
                },
                agent: {
                    usage: "Run after changing the config, a subscription or a template, to write every output again.",
                    whenNotToUse: "Not with watch: an agent cannot stop a watcher; build again instead.",
                },
                load: async () => (await import("./build.js")).build,
            });

            sous.intents.add({
                intent: "compile",
                requiresProject: true,
                summary: "Compile markdown templates into output files",
                description: "Compiles every target in the config without preparing recipes or pruning.",
                input: compileInputSchema,
                cli: {
                    examples: ["sous compile", "sous compile --rebuild", "sous compile --dry-run", "sous compile --strict"],
                    flags: { watch: { short: "w" }, changedFiles: { hidden: true } },
                },
                load: async () => (await import("./build.js")).compile,
            });

            sous.intents.add({
                intent: "build.prepare",
                requiresProject: true,
                summary: "Seed core, lock new subscriptions, restore the store and check upstream",
                input: prepareInputSchema,
                internal: true,
                load: async () => (await import("./prepare.js")).prepare,
            });

            sous.intents.add({
                intent: "prune",
                requiresProject: true,
                summary: "Remove output files that are no longer in the current config",
                input: pruneInputSchema,
                cli: { examples: ["sous prune", "sous prune --dry-run"] },
                load: async () => (await import("./build.js")).prune,
            });

            sous.intents.add({
                intent: "clear",
                requiresProject: true,
                summary: "Delete all files and directories written by Sous for a project",
                input: clearInputSchema,
                cli: {
                    examples: ["sous clear", "sous clear --force", "sous clear --yes"],
                    flags: { force: { short: "f", aliases: ["yes"] } },
                },
                agent: { usage: "Pass force: true; an agent cannot answer the confirmation." },
                load: async () => (await import("./build.js")).clear,
            });

            sous.intents.add({
                intent: "build.watch",
                requiresProject: true,
                summary: "Watch the sources and build on every change",
                input: watchInputSchema,
                background: true,
                cli: { hidden: true },
                agent: { hidden: true },
                async handle(input, ctx) {
                    const { chokidarWatcher } = await import("./watch/watcher.js");
                    const { createWatchHandler, processSignals } = await import("./watch/intent.js");
                    const handler = createWatchHandler({
                        createWatcher: options.createWatcher ?? chokidarWatcher,
                        signals: options.signals ?? processSignals,
                        cwd,
                        ...(options.timers ? { timers: options.timers } : {}),
                        ...(options.onWatchSession ? { onSession: options.onWatchSession } : {}),
                    });

                    return handler(input, ctx);
                },
            });
        },
    });
}

/** `_vars.pidFilePath`, resolved, when set. */
function explicitPidPath(services: ServiceReader): { explicitPath?: string } {
    if (!services.has("variables.resolver")) {
        return {};
    }

    const value = services.get("variables.resolver").scope()["pidFilePath"];

    return value ? { explicitPath: value } : {};
}

/** The `runtimeContext` settings with `${var}` substituted, or `undefined` when none are set. */
function runtimeContextSettings(raw: RuntimeContextSettings | undefined, services: ServiceReader): RuntimeContextSettings | undefined {
    if (!raw) {
        return undefined;
    }

    const resolver = services.get("variables.resolver");
    const scope = resolver.scope();
    const substitute = (value: string, field: string) => resolver.substituteStrict(value, scope, `runtimeContext.${field}`);

    return {
        gitRoot: substitute(raw.gitRoot, "gitRoot"),
        outputPath: substitute(raw.outputPath, "outputPath"),
        taskFileRoot: substitute(raw.taskFileRoot, "taskFileRoot"),
        ...(raw.branchPattern === undefined ? {} : { branchPattern: raw.branchPattern }),
    };
}

/** The plugin. */
export const buildPlugin: PluginDefinition = createBuildPlugin();

export default buildPlugin;

export type * from "./types.js";
export { renderRuntimeContext } from "./runtime-context.js";
export { skippedLine, unansweredMessage } from "./report.js";
