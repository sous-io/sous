/**
 * Manifests as config (law L8, declarations as config): the `recipes.manifests` contributor adds
 * what each active recipe's manifest declares to the config, at fixed places a manifest may write
 * to, never a root key:
 *
 * - each `contents` group of a recipe held through `subscribes`, as one entry of `recipes.contents`;
 * - each `edits` entry, appended to `editor.edits` with the recipe that declared it.
 *
 * Expressions in them (`$if`, `$elseif`, `$else`, `$expr`, `$file`) are evaluated by
 * `expressions.evaluator`, the machinery that evaluates them in config files, so they can read
 * recipe answers (the recipe's own scope), `host.platform` and `harness.id`. A recipe's name,
 * version, dependencies and variables stay fixed values: they are read before any project exists.
 *
 * Plugins respond to the entries: plugin-skills to `skills`, plugin-memories to `memories`, the
 * recipe config layers to `config`, the editor to `editor.edits`. The `content-kind` entities say
 * which kinds exist; a kind nobody registered is an error once the config has settled.
 */

import { type ConfigBuilder, ConfigError, type ContributorDefinition, type JsonValue, type ServiceReader, type Sous, jsonSchema } from "@sous-io/plugin-api";
import { parseRecipeContentGroup } from "@sous-io/plugin-formats";
import type { ActiveRecipeEntity, ContentKindEntity, RecipeContentsEntry } from "../types.js";
import { RECIPES_CONTENTS_KEY } from "./contents.js";
import { compareBytewise } from "./util.js";

/** The contributor's id. */
export const MANIFESTS_CONTRIBUTOR = "recipes.manifests";

/** The config key the editor plugin applies; a recipe's `edits` are appended to it. */
export const EDITOR_EDITS_KEY = "editor.edits";

/** The entity kind for content kinds. */
export const CONTENT_KIND = "content-kind";

/** The kinds sous registers itself. */
export const BUILT_IN_CONTENT_KINDS: readonly ContentKindEntity[] = [
    { id: "skills", description: "Skill folders, compiled into every place a harness reads skills from (plugin-skills)." },
    { id: "memories", description: "Files read into every session, compiled into each memory file (plugin-memories)." },
    { id: "prompts", description: "Prompt files." },
    { id: "config", description: "Config layers merged into the subscriber's config, limited to the keys a recipe may set." },
];

/** The part of `expressions.evaluator` this file uses; plugin-recipes does not depend on plugin-expressions. */
interface ManifestEvaluator {
    hasExpressions(value: unknown): boolean;
    evaluateLayer(
        data: JsonValue,
        options: { file: string; config: ConfigBuilder; fromRecipe?: boolean; baseDir?: string; scopeKey?: string },
    ): { value: JsonValue | undefined };
}

/** Defines the `content-kind` entity kind and registers the built-in kinds. */
export function registerContentKinds(sous: Pick<Sous, "entities">): void {
    if (!sous.entities.kinds().includes(CONTENT_KIND)) {
        sous.entities.define(
            CONTENT_KIND,
            jsonSchema({ type: "object", properties: { id: { type: "string" }, description: { type: "string" } }, required: ["id", "description"] }),
            { description: "A kind of content a recipe's manifest may publish under contents; the plugin that adds it responds to recipes.contents entries of that kind." },
        );
    }

    for (const kind of BUILT_IN_CONTENT_KINDS) {
        sous.entities.add(CONTENT_KIND, { ...kind });
    }
}

/** How a manifest is named in messages and in `sous config get --layers`: `acme/widget/sous.recipe.yaml`. */
export function manifestLabel(recipe: Pick<ActiveRecipeEntity, "id">): string {
    return `${recipe.id}/sous.recipe.yaml`;
}

/** The `recipes.manifests` contributor. */
export function manifestsContributor(services: Pick<ServiceReader, "get" | "has">, after: readonly string[]): ContributorDefinition {
    return {
        id: MANIFESTS_CONTRIBUTOR,
        after: [...after],

        contribute(config) {
            const evaluator = services.has("expressions.evaluator") ? (services.get("expressions.evaluator") as unknown as ManifestEvaluator) : undefined;
            const recipes = [...config.entities("active-recipe")].sort((left, right) => compareBytewise(left.id, right.id));

            for (const recipe of recipes) {
                const declared = evaluateManifest(recipe, config, evaluator);

                if (recipe.kind === "subscribes") {
                    declared.contents.forEach((group, index) => {
                        config.atPath(RECIPES_CONTENTS_KEY).append(contentsEntry(recipe, group, index));
                    });
                }

                for (const edit of declared.edits) {
                    config.atPath(EDITOR_EDITS_KEY).append(editEntry(recipe, edit));
                }
            }
        },
    };
}

/** What one manifest declares, its expressions evaluated. */
export interface DeclaredValues {
    readonly contents: unknown[];
    readonly edits: unknown[];
}

/** Evaluates a manifest's `contents` and `edits` as config, in the recipe's own variable scope. */
export function evaluateManifest(recipe: ActiveRecipeEntity, config: ConfigBuilder, evaluator: ManifestEvaluator | undefined): DeclaredValues {
    const data = { contents: recipe.manifest.contents ?? [], edits: recipe.manifest.edits ?? [] } as unknown as JsonValue;

    if (evaluator === undefined || !evaluator.hasExpressions(data)) {
        return data as unknown as DeclaredValues;
    }

    const value = evaluator.evaluateLayer(data, { file: manifestLabel(recipe), config, fromRecipe: true, baseDir: recipe.dir, scopeKey: recipe.id }).value as
        | Partial<DeclaredValues>
        | undefined;

    return { contents: value?.contents ?? [], edits: value?.edits ?? [] };
}

/** One `recipes.contents` entry, checked after its expressions were evaluated. */
export function contentsEntry(recipe: Pick<ActiveRecipeEntity, "id" | "dir">, group: unknown, index: number): RecipeContentsEntry {
    const checked = parseRecipeContentGroup(group, `${manifestLabel(recipe)} contents[${index}]`);

    return {
        recipe: recipe.id,
        dir: recipe.dir,
        kind: checked.kind,
        include: checked.include,
        ...(checked.exclude === undefined ? {} : { exclude: checked.exclude }),
    };
}

/**
 * One `editor.edits` entry: the manifest's entry as written (its expressions evaluated), with the
 * recipe that declared it. A relative `file` stays relative: the editor reads it from the project
 * root, as every relative `file` in `editor.edits`.
 */
export function editEntry(recipe: Pick<ActiveRecipeEntity, "id">, edit: unknown): Record<string, unknown> {
    if (typeof edit !== "object" || edit === null || Array.isArray(edit)) {
        throw new ConfigError(`${manifestLabel(recipe)} declares an edit that is not an object, after its expressions were evaluated.`);
    }

    return { ...(edit as Record<string, unknown>), recipe: recipe.id };
}

/**
 * The error for `recipes.contents` entries whose kind no `content-kind` entity registers, judged
 * once the config has settled (a plugin a recipe ships may register its kind in a later pass), or
 * `undefined` when every kind is known.
 *
 * ```text
 * The recipe acme/widget publishes content of the kind "claude-code-plugn", which no plugin registers.
 *   The plugin that provides it may be missing from npm (see the recipe's requires.plugins), or may ship as part of a recipe the project does not subscribe to.
 * ```
 */
export function unknownKindsError(entries: unknown, kinds: readonly ContentKindEntity[]): ConfigError | undefined {
    if (!Array.isArray(entries)) {
        return undefined;
    }

    const known = new Set(kinds.map((kind) => kind.id));
    const unknown = (entries as RecipeContentsEntry[]).filter((entry) => typeof entry?.kind === "string" && !known.has(entry.kind));

    if (unknown.length === 0) {
        return undefined;
    }

    const lines = [...new Set(unknown.map((entry) => `The recipe ${entry.recipe} publishes content of the kind "${entry.kind}", which no plugin registers.`))];

    return new ConfigError(lines.join("\n"), {
        details: [
            "The plugin that provides the kind may be missing from npm (a plugin the recipe names under requires.plugins), or may ship as part of a recipe the project does not subscribe to.",
            `Kinds registered here: ${[...known].sort(compareBytewise).join(", ") || "none"}.`,
        ],
    });
}

/** The `recipes.contents` config key. */
export const recipesContentsConfigKey = {
    id: RECIPES_CONTENTS_KEY,
    description: "What each active recipe's manifest publishes, one entry per contents group, added by plugin-recipes (read-only in practice).",
    schema: jsonSchema({
        type: "array",
        default: [],
        items: {
            type: "object",
            required: ["recipe", "dir", "kind", "include"],
            properties: {
                recipe: { type: "string" },
                dir: { type: "string" },
                kind: { type: "string" },
                include: { type: "array" },
                exclude: { type: "array", items: { type: "string" } },
            },
        },
    }),
};
