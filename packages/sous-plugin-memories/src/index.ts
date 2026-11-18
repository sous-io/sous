/**
 * sous-plugin-memories: Memories: selecting them, the memory-target entity, the compilation targets for them, the #memories name.
 *
 * The contract other plugins code against is `./types.ts`.
 */

import { definePlugin, type PluginDefinition } from "@sous-io/plugin-api";
import type {} from "@sous-io/sous-plugin-host/types";
import type {} from "@sous-io/sous-plugin-recipes/types";
import type {} from "@sous-io/sous-plugin-refs/types";
import { memoriesHashName } from "./hash-name.js";
import { memoriesSettingsSchema, memoryTargetSchema } from "./schemas.js";
import { MemoriesSelectionService } from "./selection.js";
import { skipEmptyTransform, targetsContributor } from "./targets.js";
import "./types.js";
import packageJson from "../package.json" with { type: "json" };

/** The plugin's name. */
export const PLUGIN_NAME = "@sous-io/sous-plugin-memories";

/** The plugin. */
export const memoriesPlugin: PluginDefinition = definePlugin({
    name: PLUGIN_NAME,
    version: packageJson.version,
    description: "Memories: selecting them, the memory-target entity, the compilation targets for them, the #memories name.",
    dependsOn: {
        "@sous-io/sous-plugin-compiler": `^${packageJson.version}`,
        "@sous-io/sous-plugin-recipes": `^${packageJson.version}`,
        "@sous-io/sous-plugin-refs": `^${packageJson.version}`,
        "@sous-io/sous-plugin-host": `^${packageJson.version}`,
    },

    register(sous) {
        sous.entities.define("memory-target", memoryTargetSchema, {
            description: "The one file a harness reads into every session, compiled from .sous/MEMORIES.tpl.md or the default memories source.",
        });

        sous.entities.add("config-key", {
            id: "recipes.memories",
            schema: memoriesSettingsSchema,
            description: "Which recipe memories go to memory targets and the #memories view, and in what order.",
        });

        sous.entities.add("hash-name", memoriesHashName);

        sous.entities.add("compilation-transform", skipEmptyTransform);

        sous.services.add("memories.selection", (config, ctx) => new MemoriesSelectionService(config, ctx), {
            lifetime: "config",
        });

        sous.config.contribute(targetsContributor(PLUGIN_NAME, sous.services));
    },
});

export default memoriesPlugin;

export { compileRecipeKeyMatcher, isRegexSpelling } from "./key-matcher.js";
export { dependencyOrder, recipeMemories, selectMemories, viewPath } from "./listing.js";
export type { ExcludedMemory, MemoryGlobs, MemoryRecipe, MemorySelectionResult } from "./listing.js";
export {
    compilationTargetId,
    configPath,
    DEFAULT_SOURCE_LINES,
    defaultFormat,
    MEMORIES_SOURCE,
    memoriesContent,
    PROJECT_MEMORIES_DIR,
    SKIP_EMPTY_TRANSFORM,
    TARGETS_CONTRIBUTOR,
} from "./targets.js";

export type * from "./types.js";
