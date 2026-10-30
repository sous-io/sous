/**
 * plugin-update: Updating sous itself, installing plugins a recipe requires, the package-manager entity, scanning for installed plugins.
 *
 * The contract other plugins code against is `./types.ts`.
 */

import { definePlugin, jsonSchema, type PluginDefinition } from "@sous-io/plugin-api";
import type {} from "@sous-io/plugin-host/types";
import { scanContributor } from "./scan.js";
import type { PackageManagerEntity, PluginsInstallInput, UpdateInput } from "./types.js";
import "./types.js";

/** The plugin's name. */
export const PLUGIN_NAME = "@sous-io/plugin-update";

/** The `package-manager` kind's schema. The methods are functions, which JSON Schema cannot describe. */
const packageManagerSchema = jsonSchema<PackageManagerEntity>({
    type: "object",
    required: ["id"],
    properties: {
        id: { type: "string", description: "What names the manager: `npm`, `pnpm`, `yarn`." },
        description: { type: "string" },
    },
});

const updateInput = jsonSchema<UpdateInput>({
    type: "object",
    properties: {
        major: { type: "boolean", default: false, description: "Install the newest published version, whatever its major version." },
        version: { type: "string", description: "Install this version, the newest version in this range, or the version this dist-tag names." },
        prerelease: { type: "boolean", description: "Count prerelease versions as candidates; on by default when the installed version is a prerelease." },
        global: { type: "boolean", default: false, description: "Update only the global install." },
        project: { type: "boolean", default: false, description: "Update only this project's own install." },
        yes: { type: "boolean", default: false, description: "Answer yes to every question." },
        dryRun: { type: "boolean", default: false, description: "Show every install's plan without installing anything." },
        noBuild: { type: "boolean", default: false, description: "Update the project install without building the project afterwards." },
    },
    additionalProperties: false,
});

const pluginsInstallInput = jsonSchema<PluginsInstallInput>({
    type: "object",
    required: ["plugins"],
    properties: {
        plugins: { type: "array", items: { type: "string" }, description: "Plugins to install, as `name` or `name@range`." },
        section: { enum: ["dependencies", "devDependencies"], default: "devDependencies", description: "The package.json section to add them to." },
        yes: { type: "boolean", default: false, description: "Install without asking." },
        dryRun: { type: "boolean", default: false, description: "Show the command without running it." },
    },
    additionalProperties: false,
});

/** The plugin. */
export const updatePlugin: PluginDefinition = definePlugin({
    name: PLUGIN_NAME,
    version: "0.2.34",
    description: "Updating sous itself, installing plugins a recipe requires, the package-manager entity, scanning for installed plugins.",
    dependsOn: {
        "@sous-io/plugin-host": "^0.2.34",
    },

    register(sous) {
        sous.entities.define("package-manager", packageManagerSchema, {
            description: "A package manager: detecting it, listing installed packages, planning installs.",
        });

        sous.config.contribute(scanContributor(sous));

        sous.intents.add({
            intent: "update",
            summary: "Update sous itself, globally and in this project, through the package manager that installed each copy",
            input: updateInput,
            // Updating sous is how a user repairs an install whose config no longer builds.
            toleratesConfigErrors: true,
            cli: {
                examples: ["sous update", "sous update --global", "sous update --major", "sous update --version 0.2.18", "sous update --version next", "sous update --dry-run"],
                flags: { yes: { short: "y", aliases: ["force"] }, prerelease: { aliases: ["pre"] } },
            },
            agent: {
                usage: "Move sous to a newer version. Pass yes so no question is asked; use dryRun first to see the plan.",
            },
            load: () => import("./update.js"),
        });

        sous.intents.add({
            intent: "plugins.install",
            summary: "Install npm plugins through the project's package manager",
            input: pluginsInstallInput,
            cli: {
                command: ["plugins", "install"],
                positional: ["plugins"],
                examples: ["sous plugins install sous-plugin-claude-code", "sous plugins install sous-plugin-x@^1.0.0 --yes"],
                flags: { yes: { short: "y", aliases: ["force"] } },
            },
            load: () => import("./plugins-install.js"),
        });
    },
});

export default updatePlugin;

export { scanContributor, SCAN_CONTRIBUTOR } from "./scan.js";
export type * from "./types.js";
