/**
 * plugin-formats: One parser per on-disk format, reading manifests, and the recipe content hash.
 *
 * The contract other plugins code against is `./types.ts`.
 * Parsing is pure: a lockfile never gets an identity worked out here (`recipes.lock` does that after
 * parsing), and the only service `plugin-formats` reads is `refs.resolver`, for the refs in a manifest.
 */

import { definePlugin, SousError, type PluginDefinition, type ServiceContext } from "@sous-io/plugin-api";
import { createManifests } from "./manifests.js";
import {
  createRecipeManifestFormat,
  indexFileFormat,
  linksMapFormat,
  lockfileFormat,
  repoManifestFormat,
  storeEntryFormat,
  variableDefinitionFormat,
} from "./parsers.js";
import { recipeHash } from "./recipe-hash.js";
import "@sous-io/plugin-refs/types";
import "./types.js";
import packageJson from "../package.json" with { type: "json" };

/** The plugin's name. */
export const PLUGIN_NAME = "@sous-io/plugin-formats";

/**
 * Checks a manifest ref with `refs.resolver`, read when first needed. While the config is being
 * built (a recipe fetched by a contributor), `refs.resolver` cannot be made yet, so the check is
 * skipped there; the refs are read through `refs.resolver` again when they are used.
 */
function manifestRefChecker(ctx: ServiceContext): (ref: string) => void {
    return (ref) => {
        let resolver;

        try {
            resolver = ctx.services.get("refs.resolver");
        } catch (error) {
            if (error instanceof SousError && error.message.includes("cannot be used while the config is being built")) {
                return;
            }

            throw error;
        }

        resolver.parse(ref, "manifest");
    };
}

/** The plugin. */
export const formatsPlugin: PluginDefinition = definePlugin({
    name: PLUGIN_NAME,
    version: packageJson.version,
    description: "One parser per on-disk format, reading manifests, and the recipe content hash.",
    dependsOn: {
        "@sous-io/plugin-refs": `^${packageJson.version}`,
    },

    register(sous) {
        const once = { lifetime: "singleton" } as const;

        sous.services.add("formats.lockfile", () => lockfileFormat, once);
        sous.services.add("formats.repo-manifest", () => repoManifestFormat, once);
        sous.services.add("formats.index-file", () => indexFileFormat, once);
        sous.services.add("formats.links-map", () => linksMapFormat, once);
        sous.services.add("formats.store-entry", () => storeEntryFormat, once);
        sous.services.add("formats.variable-definition", () => variableDefinitionFormat, once);
        sous.services.add("formats.recipe-hash", () => recipeHash, once);
        sous.services.add("formats.recipe-manifest", (_config, ctx) => createRecipeManifestFormat(manifestRefChecker(ctx)), once);
        sous.services.add("formats.manifests", (_config, ctx) => createManifests({ checkRef: manifestRefChecker(ctx) }), once);
    },
});

export default formatsPlugin;

export { createManifests, parseManifestText, readManifestFile } from "./manifests.js";
export type { ManifestsDeps } from "./manifests.js";
export {
    createRecipeManifestFormat,
    indexFileFormat,
    linksMapFormat,
    lockfileFormat,
    repoManifestFormat,
    storeEntryFormat,
    variableDefinitionFormat,
} from "./parsers.js";
export { hashDirectory, hashDirectorySync, hashesEqual, isContentHash, recipeHash } from "./recipe-hash.js";
export { mergeLinksMaps } from "./formats/links-map.js";
export { storeEntryKey } from "./formats/store-entry.js";
export {
    INDEX_CACHE_DIRNAME,
    INDEX_FILENAME,
    LINKS_FILENAME,
    LOCKFILE_FILENAME,
    MANIFEST_EXTENSIONS,
    RECIPE_MANIFEST_BASENAME,
    REPO_MANIFEST_BASENAME,
    STORE_ENTRY_FILENAME,
    CONTENT_HASH_PATTERN,
    KEBAB_NAME_PATTERN,
    RECIPE_KEY_PATTERN,
    REF_KEY_PATTERN,
    REPO_IDENTITY_PATTERN,
    VARIABLE_NAME_PATTERN,
    ENV_VAR_NAME_PATTERN,
} from "./formats/common.js";
export type { DependencyRefChecker } from "./formats/recipe-manifest.js";
export type * from "./types.js";
