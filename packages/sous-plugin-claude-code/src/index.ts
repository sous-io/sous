/**
 * sous-plugin-claude-code: Everything sous knows about Claude Code: its harness, skill and memory
 * targets, its content kinds (`claude-code-plugin`, `claude-code-agent`), the `/reload-plugins`
 * line, and its migrations.
 *
 * The contract other plugins code against is `./types.ts`.
 */

import { definePlugin, type PluginDefinition } from "@sous-io/plugin-api";
import type {} from "@sous-io/sous-plugin-host/types";
import type {} from "@sous-io/sous-plugin-migrations/types";
import { claudeHarness } from "./harness.js";
import { CONTENT_KINDS, kindsContributor } from "./kinds.js";
import { registerMigrations } from "./migrations/index.js";
import { registerReloadLine } from "./reload.js";
import { targetsContributor } from "./targets.js";
import "./types.js";
import packageJson from "../package.json" with { type: "json" };

/** The plugin's name. */
export const PLUGIN_NAME = "@sous-io/sous-plugin-claude-code";

/** The plugin. */
export const claudeCodePlugin: PluginDefinition = definePlugin({
    name: PLUGIN_NAME,
    version: packageJson.version,
    description: "Everything sous knows about Claude Code: its harness, skill and memory targets, its content kinds, and its migrations.",
    dependsOn: {
        "@sous-io/sous-plugin-skills": `^${packageJson.version}`,
        "@sous-io/sous-plugin-memories": `^${packageJson.version}`,
        "@sous-io/sous-plugin-harnesses": `^${packageJson.version}`,
        "@sous-io/sous-plugin-host": `^${packageJson.version}`,
        "@sous-io/sous-plugin-recipes": `^${packageJson.version}`,
        "@sous-io/sous-plugin-compiler": `^${packageJson.version}`,
        "@sous-io/sous-plugin-migrations": `^${packageJson.version}`,
    },

    register(sous) {
        const services = sous.services;

        sous.entities.add("harness", claudeHarness);
        sous.config.contribute(targetsContributor);

        for (const kind of CONTENT_KINDS) {
            sous.entities.add("content-kind", { ...kind });
        }

        sous.config.contribute({
            ...kindsContributor(PLUGIN_NAME, services),
            // Only for speed: the active recipes are usually known by then, which saves a pass.
            after: ["@sous-io/sous-plugin-recipes"],
        });

        registerReloadLine(sous);
        registerMigrations(sous);
    },
});

export default claudeCodePlugin;

export type * from "./types.js";

export { claudeHarness } from "./harness.js";
export { AGENT_KIND, AGENTS_DIRECTORY, contentTargets, PLUGIN_KIND } from "./kinds.js";
export { MIGRATIONS_VERSION } from "./migrations/index.js";
export { memoriesMigration, migrateMemories } from "./migrations/memories.js";
export { migrateToolsKey, toolsKeyMigration } from "./migrations/tools.js";
export { pluginFolderOf, reloadLine } from "./reload.js";
export { contributeTargets, MEMORIES_OUTPUT_PATH, outputDirectory, POINTER_FILE, SKILLS_DIRECTORY } from "./targets.js";
export { finalText, parseStream, transcriptEntries } from "./transcript.js";
