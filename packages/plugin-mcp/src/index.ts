/**
 * plugin-mcp: The sous mcp front end: tools generated from intents, MCP logging and elicitation.
 *
 * S6, "Front ends: plugin-cli, plugin-mcp". The contract other plugins code against is `./types.ts`.
 */

import { definePlugin, type PluginDefinition } from "@sous-io/plugin-api";
import "./types.js";

/** The plugin's name. */
export const PLUGIN_NAME = "@sous-io/plugin-mcp";

/** The plugin. */
export const mcpPlugin: PluginDefinition = definePlugin({
    name: PLUGIN_NAME,
    version: "0.2.34",
    description: "The sous mcp front end: tools generated from intents, MCP logging and elicitation.",
    dependsOn: {},

    register(sous) {
        // TODO(plugin-mcp): a stub until the plugin is written. It must register:
        //   - intent: mcp.serve (background): tools from intents, McpReporter, ElicitationPrompter
        //   - service: mcp.tools (config)
        //   - event: mcp.called
        //   - config-key entity: mcp
        void sous;
    },
});

export default mcpPlugin;

export type * from "./types.js";
