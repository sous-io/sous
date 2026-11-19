/**
 * `recipes.contents`: which files recipes publish, read from the config key `recipes.contents`
 * (law L8, declarations as config). The `recipes.manifests` contributor adds one entry per
 * `contents` group of each active recipe held through `subscribes`; this service only reads those
 * entries and lists each one's files. It never reads a manifest.
 *
 * ```ts
 * const contents = services.get("recipes.contents");
 *
 * for (const content of contents.of(config, "skills")) {
 *     content.recipe;  // "acme/widget"
 *     content.files;   // [{ path: "skills/review/SKILL.md", file: "/store/.../SKILL.md", base: "/store/.../skills" }]
 * }
 * ```
 */

import fs from "node:fs";
import path from "node:path";
import type { ServiceReader } from "@sous-io/sous-plugin-api";
import type { ContentKind, InlineContent } from "@sous-io/sous-plugin-formats/types";
import type { ActiveRecipeContent, ContentsConfig, RecipeContentFile, RecipeContentsEntry, RecipesContents } from "../types.js";

/** The config key the entries live under. */
export const RECIPES_CONTENTS_KEY = "recipes.contents";

/** Reads a config path from a built config or through a contributor's builder. */
export function readConfig(config: ContentsConfig, key: string): unknown {
    return "atPath" in config ? config.atPath(key).get() : config.get(key);
}

/** Whether an include item is inline content. */
export function isInline(item: unknown): item is InlineContent {
    return typeof item === "object" && item !== null && typeof (item as InlineContent).$inline === "string" && typeof (item as InlineContent).path === "string";
}

/**
 * The text of inline content as a file would hold it. Inline content is never interpolated, like a
 * file's; an escaped `$${` (which a `$file` value carries) is written back as `${`.
 */
export function inlineText(item: InlineContent): string {
    return item.$inline.split("$${").join("${");
}

/**
 * The base of inline content: its path's first folder, as if it were matched by `<folder>/**`
 * (`skills/hi/SKILL.md` gives `<recipe>/skills`, so the skill is `hi`); the recipe's folder for a
 * path with no folder.
 */
export function inlineBase(dir: string, virtualPath: string): string {
    const [first, ...rest] = virtualPath.split("/");

    return rest.length === 0 ? dir : path.join(dir, first!);
}

/** Whether a value has the shape of a `recipes.contents` entry. */
function isEntry(value: unknown): value is RecipeContentsEntry {
    const entry = value as RecipeContentsEntry;

    return typeof value === "object" && value !== null && typeof entry.recipe === "string" && typeof entry.dir === "string" && typeof entry.kind === "string" && Array.isArray(entry.include);
}

/** `recipes.contents`. */
export class RecipeContents implements RecipesContents {
    constructor(private readonly services: Pick<ServiceReader, "get">) {}

    entries(config: ContentsConfig, kind: ContentKind): RecipeContentsEntry[] {
        const value = readConfig(config, RECIPES_CONTENTS_KEY);

        return Array.isArray(value) ? value.filter((entry): entry is RecipeContentsEntry => isEntry(entry) && entry.kind === kind) : [];
    }

    of(config: ContentsConfig, kind: ContentKind): ActiveRecipeContent[] {
        return this.entries(config, kind).map((entry) => ({ recipe: entry.recipe, kind: entry.kind, entry, files: this.files(entry) }));
    }

    files(entry: RecipeContentsEntry): RecipeContentFile[] {
        const globs = this.services.get("host.globs");
        const seen = new Set<string>();
        const files: RecipeContentFile[] = [];

        for (const include of entry.include) {
            if (isInline(include)) {
                const absolute = path.join(entry.dir, include.path);
                const excluded = (entry.exclude ?? []).some((pattern) => globs.isMatch(include.path, pattern, { dot: true }));

                if (!seen.has(absolute) && !excluded) {
                    seen.add(absolute);
                    files.push({ path: include.path, file: absolute, base: inlineBase(entry.dir, include.path), content: inlineText(include) });
                }

                continue;
            }

            const staticBase = globs.hasGlob(include) ? globs.staticBase(include) : path.posix.dirname(include);
            const base = path.join(entry.dir, staticBase === "/" ? "." : staticBase);
            const relative = globs.matchSync(include, { cwd: entry.dir, dot: true, ignore: [...(entry.exclude ?? [])] });

            for (const file of globs.sortBytewise(relative)) {
                const absolute = path.join(entry.dir, file);

                if (seen.has(absolute) || !isFile(absolute)) {
                    continue;
                }

                seen.add(absolute);
                files.push({ path: globs.toPosix(file), file: absolute, base });
            }
        }

        return files;
    }
}

function isFile(candidate: string): boolean {
    try {
        return fs.statSync(candidate).isFile();
    } catch {
        return false;
    }
}
