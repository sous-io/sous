/**
 * plugin-refs: parsing and resolving refs, picking among matches, `#` names, repository locations
 * and identity.
 *
 * The contract other plugins code against is
 * `./types.ts`. Hosts come from the `repository-host` entities, a kind plugin-recipes defines; an
 * entity read needs no dependency, so this plugin depends on nothing above it.
 */

import { definePlugin, jsonSchema, type PluginDefinition } from "@sous-io/plugin-api";
import { createRefsFormat } from "./format.js";
import { hashNameSchema, projectHashName } from "./hash-names.js";
import { createRefsLocations } from "./locations/locations.js";
import { locationSplitter } from "./parser/location-splitter.js";
import { namePathSplitter } from "./parser/name-path-splitter.js";
import { createRefsParser } from "./parser/parser.js";
import { envVarSplitter, querySplitter, rangeSplitter, repoQualifierSplitter } from "./parser/splitters.js";
import { createRefsPicker } from "./picker.js";
import { BUILT_IN_PRUNERS } from "./pruners/pruners.js";
import { createRefsResolver } from "./resolver.js";
import "./types.js";
import packageJson from "../package.json" with { type: "json" };

/** The plugin's name. */
export const PLUGIN_NAME = "@sous-io/plugin-refs";

/** The built-in splitters, in their order. */
export const BUILT_IN_SPLITTERS = [querySplitter, rangeSplitter, locationSplitter, repoQualifierSplitter, envVarSplitter, namePathSplitter] as const;

/** The plugin. */
export const refsPlugin: PluginDefinition = definePlugin({
    name: PLUGIN_NAME,
    version: packageJson.version,
    description: "Parsing and resolving refs, picking among matches, # names, repository locations and identity.",
    dependsOn: {
        "@sous-io/plugin-host": `^${packageJson.version}`,
    },

    register(sous) {
        sous.entities.define(
            "ref-splitter",
            jsonSchema({ type: "object", properties: { id: { type: "string" }, order: { type: "number" } }, required: ["id", "order", "split"] }),
            { description: "One step of the ref parser: reads part of a written ref, every way it can be read." },
        );
        sous.entities.define(
            "ref-pruner",
            jsonSchema({
                type: "object",
                properties: { id: { type: "string" }, source: { type: "string" }, place: { type: "string" } },
                required: ["id", "source", "place", "prune"],
            }),
            { description: "Which readings of a ref count in one place it is written." },
        );
        sous.entities.define(
            "ref-lookup",
            jsonSchema({
                type: "object",
                properties: {
                    id: { type: "string" },
                    description: { type: "string" },
                    kinds: { type: "array", items: { type: "string" } },
                    tags: { type: "array", items: { type: "string" } },
                    optIn: { type: "boolean" },
                },
                required: ["id", "find"],
            }),
            { description: "What exists, for narrowing the readings of a ref." },
        );
        sous.entities.define("hash-name", hashNameSchema, { description: "A '#' name, such as '#project', and what it stands for." });

        for (const splitter of BUILT_IN_SPLITTERS) {
            sous.entities.add("ref-splitter", splitter);
        }

        for (const pruner of BUILT_IN_PRUNERS) {
            sous.entities.add("ref-pruner", pruner);
        }

        sous.entities.add("hash-name", projectHashName);

        // Every service reads entities, so each lives as long as one build's config.
        sous.services.add("refs.locations", (_config, ctx) => createRefsLocations(ctx.entities), { lifetime: "config" });
        sous.services.add("refs.parser", (_config, ctx) => createRefsParser(ctx), { lifetime: "config" });
        sous.services.add("refs.resolver", (_config, ctx) => createRefsResolver(ctx), { lifetime: "config" });
        sous.services.add("refs.format", (_config, ctx) => createRefsFormat(ctx), { lifetime: "config" });
        sous.services.add("refs.picker", (_config, ctx) => createRefsPicker(() => ctx.services.get("refs.locations")), { lifetime: "config" });
    },
});

export default refsPlugin;

export { ACCEPT_FIRST_FLAG, resolvedRefFacts } from "./picker.js";
export { finishRef, splitter } from "./parser/partial-ref.js";
export { describeDropped, rulePruner, SOURCE_LABELS } from "./pruners/rules.js";
export type { RefPruneAction, RefPruneRule, RefRuleText, RulePrunerOptions } from "./pruners/rules.js";
export {
    buildCanonicalRepository,
    defaultLocator,
    normalizeRepoUrl,
    readingsAfterRepository,
    splitRepoUrl,
    withoutGitSuffix,
} from "./locations/host-helpers.js";
export { identitySegments, repositoryIdentity, sameRepositoryIdentity, shortNameFromIdentity } from "./locations/identity.js";
export { isGlobName, splitSegments } from "./names.js";
export { KIND_LABELS, locationOf, namesOf, namespaceOf, qualificationOf, rangeOf, recipeOf, REF_KINDS, repoOf, shortKey } from "./parts.js";

export type * from "./types.js";
