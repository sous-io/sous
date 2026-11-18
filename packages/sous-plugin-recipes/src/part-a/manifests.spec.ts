/**
 * Manifests as config: the `recipes.manifests` contributor adds each active recipe's `contents`
 * groups to `recipes.contents` and its `edits` to `editor.edits`, evaluating their expressions as
 * config; a kind no `content-kind` entity registers is an error once the config has settled.
 */

import { describe, expect, it } from "vitest";
import type { ConfigBuilder, JsonValue } from "@sous-io/sous-plugin-api";
import type { ActiveRecipeEntity } from "../types.js";
import { BUILT_IN_CONTENT_KINDS, contentsEntry, manifestsContributor, unknownKindsError } from "./manifests.js";

/** An active recipe with the given manifest parts. */
function recipe(id: string, parts: Partial<ActiveRecipeEntity["manifest"]>, kind: "subscribes" | "depends" = "subscribes"): ActiveRecipeEntity {
    const [namespace, name] = id.split("/") as [string, string];

    return {
        id,
        namespace,
        name,
        repo: "r",
        identity: "x/r",
        version: "1.0.0",
        hash: "sha256-aa",
        kind,
        requestedBy: ["project"],
        dir: `/store/${id}`,
        source: "store",
        manifest: { formatVersion: 1, namespace, name, version: "1.0.0", contents: [], ...parts },
    } as ActiveRecipeEntity;
}

/** A builder holding active recipes, recording what is appended where. */
function builder(recipes: ActiveRecipeEntity[]): { config: ConfigBuilder; appended: Record<string, unknown[]> } {
    const appended: Record<string, unknown[]> = {};
    const config = {
        entities: (kind: string) => (kind === "active-recipe" ? recipes : []),
        atPath: (path: string) => ({
            append: (item: unknown) => {
                (appended[path] ??= []).push(item);
            },
        }),
    };

    return { config: config as unknown as ConfigBuilder, appended };
}

/** Services with no expression evaluator, or with the one given. */
function services(evaluator?: unknown) {
    return { has: (name: string) => name === "expressions.evaluator" && evaluator !== undefined, get: () => evaluator } as never;
}

describe("the recipes.manifests contributor", () => {
    /**
     * contents:
     *   - { kind: skills, include: [skills/**], exclude: [skills/private/**] }
     * // recipes.contents -> [{ recipe: "acme/widget", dir: "/store/acme/widget", kind: "skills", include: [...], exclude: [...] }]
     */
    it("should add each contents group of a subscribed recipe to recipes.contents, in recipe-key order", () => {
        const { config, appended } = builder([
            recipe("acme/widget", { contents: [{ kind: "skills", include: ["skills/**"], exclude: ["skills/private/**"] }] }),
            recipe("acme/base", { contents: [{ kind: "memories", include: ["memories/*.md"] }] }),
            recipe("acme/library", { contents: [{ kind: "skills", include: ["skills/**"] }] }, "depends"),
        ]);

        manifestsContributor(services(), ["recipes.fetch"]).contribute(config);

        expect(appended["recipes.contents"]).toEqual([
            { recipe: "acme/base", dir: "/store/acme/base", kind: "memories", include: ["memories/*.md"] },
            { recipe: "acme/widget", dir: "/store/acme/widget", kind: "skills", include: ["skills/**"], exclude: ["skills/private/**"] },
        ]);
    });

    /**
     * edits:
     *   - file: .claude/settings.json
     *     ensureIncludes: { path: permissions.allow, items: ["Bash(git:*)"] }
     * // editor.edits -> [{ file: ".claude/settings.json", ensureIncludes: {...}, recipe: "acme/widget" }]
     */
    it("should append each edit to editor.edits with the recipe that declared it", () => {
        const edit = { file: ".claude/settings.json", ensureIncludes: { path: "permissions.allow", items: ["Bash(git:*)"] } };
        const { config, appended } = builder([recipe("acme/widget", { edits: [edit] })]);

        manifestsContributor(services(), []).contribute(config);

        expect(appended["editor.edits"]).toEqual([{ ...edit, recipe: "acme/widget" }]);
        expect(appended["recipes.contents"]).toBeUndefined();
    });

    /**
     * Expressions are evaluated by `expressions.evaluator`, as a recipe's config file, with paths
     * relative to the recipe's folder and the recipe's own answers in scope.
     */
    it("should evaluate expressions as config, in the recipe's own scope", () => {
        const calls: Array<{ data: JsonValue; options: Record<string, unknown> }> = [];
        const evaluator = {
            hasExpressions: () => true,
            evaluateLayer(data: JsonValue, options: Record<string, unknown>) {
                calls.push({ data, options });

                return { value: { contents: [{ kind: "skills", include: ["claude/**"] }], edits: [] } };
            },
        };
        const written = [{ $if: { expr: "harness.id == 'claude-code'", then: { kind: "skills", include: ["claude/**"] } } }];
        const { config, appended } = builder([recipe("acme/widget", { contents: written as never })]);

        manifestsContributor(services(evaluator), []).contribute(config);

        expect(calls[0]?.data).toEqual({ contents: written, edits: [] });
        expect(calls[0]?.options).toMatchObject({ file: "acme/widget/sous.recipe.yaml", fromRecipe: true, baseDir: "/store/acme/widget", scopeKey: "acme/widget" });
        expect(appended["recipes.contents"]).toEqual([{ recipe: "acme/widget", dir: "/store/acme/widget", kind: "skills", include: ["claude/**"] }]);
    });
});

describe("contentsEntry()", () => {
    /** An evaluated group is checked again: a pattern that escapes the recipe is an error naming it. */
    it("should refuse an evaluated group that is not valid", () => {
        expect(() => contentsEntry({ id: "acme/widget", dir: "/d" }, { kind: "skills", include: ["../x/**"] }, 2)).toThrow(/acme\/widget\/sous\.recipe\.yaml contents\[2\]/);
    });

    /** Inline content is kept as it is. */
    it("should keep inline content", () => {
        const inline = { $inline: "# Hi", path: "skills/hi/SKILL.md" };

        expect(contentsEntry({ id: "a/b", dir: "/d" }, { kind: "skills", include: [inline] }, 0).include).toEqual([inline]);
    });
});

describe("unknownKindsError()", () => {
    /** The four built-in kinds are known. */
    it("should accept every registered kind", () => {
        expect(unknownKindsError([{ recipe: "a/b", kind: "skills" }, { recipe: "a/b", kind: "config" }], BUILT_IN_CONTENT_KINDS)).toBeUndefined();
    });

    /**
     * ```text
     * The recipe acme/widget publishes content of the kind "claude-code-plugn", which no plugin registers.
     *   The plugin that provides the kind may be missing from npm ..., or may ship as part of a recipe ...
     * ```
     */
    it("should name the kind, the recipe and the hint", () => {
        const error = unknownKindsError([{ recipe: "acme/widget", kind: "claude-code-plugn" }], BUILT_IN_CONTENT_KINDS);

        expect(error?.message).toBe('The recipe acme/widget publishes content of the kind "claude-code-plugn", which no plugin registers.');
        expect(error?.details?.[0]).toContain("missing from npm");
        expect(error?.details?.[0]).toContain("ship as part of a recipe");
    });
});
