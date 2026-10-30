import { definePlugin, jsonSchema } from "@sous-io/plugin-api";
import { z } from "zod";

/** The example: `namespace.list` with aliases across groups and a positional argument. */
export const namespacesPlugin = definePlugin({
    name: "sous-plugin-namespaces",
    version: "1.0.0",

    register(sous) {
        sous.intents.add({
            intent: "namespace.list",
            summary: "List the namespaces in your subscribed repositories",
            input: z.object({
                repository: z.string().optional().describe("Only this repository"),
                json: z.boolean().default(false).describe("Print JSON"),
            }),
            cli: {
                command: ["namespace", "list"],
                aliases: [["namespaces", "list"], ["ns", "list"], ["list", "namespaces"]],
                positional: ["repository"],
                examples: ["sous ns list github.com/sous-io/sous-recipes"],
            },
            agent: { tool: "namespace_list", usage: "Call this before subscribing." },
            handle: (input) => ({ listed: input.repository ?? "all", json: input.json }),
        });

        sous.entities.add("cli-group", { id: "namespace", command: ["namespace"], summary: "Browse the namespaces the trusted repositories publish" });
    },
});

/** Nested groups (`sous repo add alternate`), every kind of flag, and an internal and a hidden intent. */
export const reposPlugin = definePlugin({
    name: "sous-plugin-repos",
    version: "1.0.0",

    register(sous) {
        sous.intents.add({
            intent: "repo.add",
            summary: "Add a recipe repository",
            input: z.object({
                url: z.string().describe("The repository's location"),
                name: z.string().optional().describe("A name for it"),
                priority: z.number().int().default(10).describe("Its priority"),
                tags: z.array(z.string()).default([]).describe("Tags to give it"),
                mode: z.enum(["trusted", "untrusted"]).default("trusted").describe("Whether to trust it"),
                yes: z.boolean().default(false).describe("Add it without asking"),
            }),
            cli: { positional: ["url"], flags: { yes: { short: "y" }, name: { aliases: ["as"] } } },
            handle: (input) => input,
        });

        sous.intents.add({
            intent: "repo.add.alternate",
            summary: "Add an alternate location for a repository",
            input: z.object({ repo: z.string(), urls: z.array(z.string()).describe("The other locations") }),
            cli: { command: ["repo", "add", "alternate"], positional: ["repo", "urls"] },
            handle: (input) => input,
        });

        sous.intents.add({ intent: "repo.secret", summary: "Hidden", cli: { hidden: true }, handle: () => "hidden ran" });
        sous.intents.add({ intent: "repo.internal", summary: "Internal", internal: true, handle: () => "internal ran" });

        sous.entities.add("cli-group", { id: "repo", command: ["repo"], summary: "Manage the recipe repositories this project trusts" });
        sous.entities.add("cli-group", { id: "repo add", command: ["repo", "add"], summary: "Add a recipe repository, or an alternate location" });
    },
});

/** A plugin adding its own global argument, read back through ctx.globals. */
export const verbosePlugin = definePlugin({
    name: "sous-plugin-verbose",

    register(sous) {
        sous.entities.add("cli-global-argument", {
            id: "verbose",
            schema: jsonSchema({ type: "boolean", default: false }),
            description: "Print more detail",
        });
        sous.intents.add({
            intent: "show.globals",
            summary: "Show the global arguments",
            handle: (_input, ctx) => ({ verbose: ctx.globals.verbose ?? false, debug: ctx.globals.debug ?? false }),
        });
    },
});

/** An intent that reports at every level, for `--log-level` and `--debug`. */
export const loudPlugin = definePlugin({
    name: "sous-plugin-loud",

    register(sous) {
        sous.intents.add({
            intent: "loud",
            summary: "Report at every level",
            handle: (_input, ctx) => {
                for (const level of ["debug", "info", "notice", "warning", "error", "critical", "alert", "emergency"] as const) {
                    ctx.reporter.log(level, `a ${level} message`);
                }
            },
        });
    },
});

/** An intent that asks a question, answerable by a flag. */
export const askingPlugin = definePlugin({
    name: "sous-plugin-asking",

    register(sous) {
        sous.intents.add({
            intent: "prune",
            summary: "Remove files sous no longer writes",
            input: z.object({ yes: z.boolean().default(false).describe("Remove them without asking") }),
            handle: async (input, ctx) => {
                const go = input.yes || (await ctx.prompter.confirm({ message: "Remove the 3 files listed above?", answeredBy: "--yes" }));

                return go ? "removed" : "kept";
            },
        });
    },
});
