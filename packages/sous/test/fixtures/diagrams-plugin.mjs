// A plugin as an outside author writes one: plain JavaScript, zod for the schema, and only
// definePlugin from @sous-io/plugin-api.
import { definePlugin } from "@sous-io/plugin-api";
import { z } from "zod";

export default definePlugin({
    name: "sous-plugin-diagrams",
    version: "1.0.0",
    dependsOn: { "@sous-io/plugin-cli": "*" },

    register(sous) {
        sous.entities.add("cli-group", { id: "diagrams", command: ["diagrams"], summary: "Render the project's diagrams" });

        sous.intents.add({
            intent: "diagrams.render",
            summary: "Render every diagram to SVG",
            input: z.object({
                only: z.string().optional().describe("Only diagrams whose name contains this"),
                scale: z.number().default(1).describe("How much to scale each diagram"),
                dryRun: z.boolean().default(false).describe("Print the plan and change nothing"),
            }),
            cli: { positional: ["only"], aliases: [["render"]] },
            handle: (input) => ({ rendered: input.only ? 1 : 3, scale: input.scale, dryRun: input.dryRun }),
        });
    },
});
