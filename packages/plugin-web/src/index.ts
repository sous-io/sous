import { definePlugin, jsonSchema, type PluginDefinition } from "@sous-io/plugin-api";
import { registerWebIntents } from "./intents/index.js";
import type { ServeInput } from "./server.js";
import "./types.js";
import packageJson from "../package.json" with { type: "json" };

export const PLUGIN_NAME = "@sous-io/plugin-web";

/**
 * A local web editor for a sous project (proof of concept). `sous serve` opens it; the browser runs
 * intents over one WebSocket, the same intents the CLI and MCP run.
 *
 * Turn it on in a project:
 *
 * ```yaml
 * plugins:
 *   load: ["@sous-io/plugin-web"]
 * ```
 *
 * or for one run: `SOUS_PLUGINS=<path to packages/plugin-web/dist/index.js> sous serve`.
 */
export const webPlugin: PluginDefinition = definePlugin({
    name: PLUGIN_NAME,
    version: packageJson.version,
    description: "A local web editor for this project's sources: sous serve.",

    register(sous) {
        sous.intents.add({
            intent: "web.serve",
            summary: "Open a local web editor for this project's sources",
            description:
                "Serves the web editor on 127.0.0.1 and opens it in the browser. The browser runs sous's intents over a " +
                "WebSocket, so anything the CLI or an agent can do, the editor can do.",
            input: jsonSchema<ServeInput>({
                type: "object",
                properties: {
                    port: { type: "integer", default: 4777, description: "The port to listen on; the next free one is used when it is taken." },
                    launch: { type: "boolean", default: true, description: "Open the editor in the browser; --no-launch only prints its URL." },
                },
            }),
            background: true,
            requiresProject: true,
            cli: { command: ["serve"], examples: ["sous serve", "sous serve --no-launch --port 5000"] },
            agent: { hidden: true },

            async load() {
                const { serveWeb } = await import("./server.js");

                return serveWeb;
            },
        });

        registerWebIntents(sous);
    },
});

export default webPlugin;
export type * from "./types.js";
export type * from "./protocol.js";
