import { definePlugin, jsonSchema, LOG_LEVELS, type PluginDefinition } from "@sous-io/plugin-api";
import { CommandTree, type CommandPicks } from "./command-tree.js";
import { viewError } from "./errors.js";
import { runCommandLine } from "./front-end.js";
import { BUILT_IN_GROUPS } from "./groups.js";
import { helpIntent } from "./help-intent.js";
import { type CliIo, processIo } from "./io.js";
import { canPrompt } from "./terminal-prompter.js";
import { BUILT_IN_VIEWS } from "./views/built-ins.js";
import type { CliGlobalArgumentEntity, CliGroupEntity } from "./types.js";

/** The plugin's name. */
export const CLI_PLUGIN_NAME = "@sous-io/plugin-cli";

/** Options for {@link createCliPlugin}. */
export interface CliPluginOptions {
    /** Where the CLI reads and writes. Default: the process's streams. */
    io?: () => CliIo;
}

/** The global arguments plugin-cli adds itself (S1, "Log levels"; C61, C52). */
export const BUILT_IN_GLOBAL_ARGUMENTS: readonly CliGlobalArgumentEntity[] = [
    {
        id: "config",
        short: "c",
        schema: jsonSchema<string>({ type: "string" }),
        description: "Path to a sous config file (or a directory containing one). Overrides .sous/ discovery.",
        valueName: "path",
    },
    {
        id: "sous-config",
        schema: jsonSchema<string>({ type: "string" }),
        description: "Alias of --config: path to a sous config file (or a directory containing one).",
        valueName: "path",
    },
    {
        id: "sous-dir",
        schema: jsonSchema<string>({ type: "string" }),
        description: "Path to the .sous directory to use (overrides walk-up discovery).",
        valueName: "path",
    },
    {
        id: "sous-confd",
        schema: jsonSchema<string>({ type: "string" }),
        description: "Path to the conf.d drop-in layer directory (overrides <sousDir>/conf.d).",
        valueName: "path",
    },
    {
        id: "debug",
        schema: jsonSchema<boolean>({ type: "boolean", default: false }),
        description: "Show every message, debug ones included (the same as --log-level debug).",
    },
    {
        id: "log-level",
        schema: jsonSchema<string>({ type: "string", enum: [...LOG_LEVELS] }),
        description: "Show messages at this level and above.",
        valueName: "level",
    },
    {
        id: "timings",
        schema: jsonSchema<boolean>({ type: "boolean", default: false }),
        description: "Print every timing when the command finishes.",
    },
    {
        id: "json",
        schema: jsonSchema<boolean>({ type: "boolean", default: false }),
        description: "Print the result as JSON instead of the formatted view.",
    },
    {
        id: "non-interactive",
        schema: jsonSchema<boolean>({ type: "boolean", default: false }),
        description: "Never ask a question; fail with the flag that answers it instead.",
    },
];

/**
 * The CLI front end (S6, `plugin-cli`): commands generated from every intent's declaration, on
 * Node's `util.parseArgs` (S1, "The CLI foundation"), with terminal output and prompts.
 */
export function createCliPlugin(options: CliPluginOptions = {}): PluginDefinition {
    const io = options.io ?? processIo;

    return definePlugin({
        name: CLI_PLUGIN_NAME,
        version: "0.2.34",
        description: "The command-line front end, generated from intents.",

        register(sous) {
            sous.entities.define(
                "cli-global-argument",
                jsonSchema({
                    type: "object",
                    properties: { id: { type: "string" }, description: { type: "string" }, short: { type: "string" }, valueName: { type: "string" }, hidden: { type: "boolean" } },
                    required: ["id", "schema", "description"],
                }),
                { description: "An argument every command accepts." },
            );
            sous.entities.define(
                "cli-group",
                jsonSchema({
                    type: "object",
                    properties: {
                        id: { type: "string" },
                        command: { type: "array", items: { type: "string" } },
                        summary: { type: "string" },
                        description: { type: "string" },
                        hidden: { type: "boolean" },
                    },
                    required: ["id", "command", "summary"],
                }),
                { description: "The help of a command group." },
            );

            sous.entities.define(
                "cli-view",
                jsonSchema({ type: "object", properties: { id: { type: "string" } }, required: ["id", "render"] }),
                { description: "How the CLI shows one intent's result; the id is the intent's name." },
            );

            for (const argument of BUILT_IN_GLOBAL_ARGUMENTS) {
                sous.entities.add("cli-global-argument", argument);
            }

            sous.entities.add("config-key", {
                id: "cli",
                description: "CLI settings: cli.pick.\"<command words>\": \"<plugin>\" picks between two commands claiming the same words.",
                schema: jsonSchema({ type: "object", properties: { pick: { type: "object", additionalProperties: { type: "string" }, default: {} } } }),
            });

            for (const group of BUILT_IN_GROUPS) {
                sous.entities.add("cli-group", group);
            }

            for (const view of BUILT_IN_VIEWS) {
                sous.entities.add("cli-view", view);
            }

            sous.services.add(
                "cli.commands",
                (config, ctx) =>
                    CommandTree.build(
                        sous.engine.intents.list(),
                        ctx.entities.list("cli-group") as CliGroupEntity[],
                        (config.get("cli.pick") ?? {}) as CommandPicks,
                    ),
                { lifetime: "config" },
            );
            sous.services.add("cli.interactivity", () => ({ canPrompt: (globals) => canPrompt(io(), sous.env, globals) }), {
                lifetime: "singleton",
            });
            sous.services.add("cli.errors", () => ({ view: (error, viewOptions) => viewError(error, viewOptions) }), {
                lifetime: "singleton",
            });

            sous.intents.add(helpIntent);
            sous.intents.add({
                intent: "version",
                summary: "Print the version",
                input: jsonSchema<{ verbose?: boolean }>({
                    type: "object",
                    properties: { verbose: { type: "boolean", default: false, description: "Also print the application name." } },
                }),
                parallel: true,
                agent: { tool: "sous_version", usage: "Call this to learn which sous version serves this project." },
                handle: (input, ctx) => {
                    const { name, version } = ctx.engine.app;

                    return input.verbose ? { name, version } : version;
                },
            });

            sous.frontEnds.add({
                id: "cli",
                start: (engine, argv) => runCommandLine(engine, argv, { io: io(), env: sous.env, cwd: process.cwd() }),
            });
        },
    });
}

/** The plugin, using the process's own streams. */
export const cliPlugin: PluginDefinition = createCliPlugin();
