/**
 * Include resolution: aliases, `#` names, recipe references (`~`), globs,
 * `${var}` substitution and the ordered candidate search, for include lines and `{% render %}`.
 *
 * An include path (the part after `@`) resolves to ordered groups. The first group that names at
 * least one file wins, and gives every file in it; when none does, the error lists every path tried.
 *
 * For a path P:
 *
 * 1. `${vars}` in P are substituted, and a leading `~/` becomes the home directory. An absolute
 *    result is the only candidate (`@${sousRootPath}/x.md`).
 * 2. A `#name` that lists files (a view, such as `#memories`) selects among them.
 * 3. When the first segment (up to `/` or `:`) is an alias, each of its bases is tried in order. A
 *    `#name` that stands for directories (`#project`) is an alias too.
 * 4. When P starts with `~` and holds a `/`, and a namespace resolver is registered, the resolver
 *    reads it as `namespace/recipe/path`.
 * 5. Then the relative candidate: P under the including file's directory, first segment included,
 *    so an alias may add to a real directory of the same name.
 * 6. Every candidate that is not a glob is followed by its `.tpl.` twin.
 *
 * A glob names every file it matches, in bytewise order.
 */

import fs from "node:fs";
import path from "node:path";
import type { HashViewFile } from "@sous-io/plugin-refs/types";
import type { VarScope } from "@sous-io/plugin-variables/types";
import type { AliasMap } from "./aliases.js";
import { expandPattern, type Globs } from "./globs.js";
import { expandHome, isIncludeLine, looksLikeIncludeLine, splitAliasKey, splitIncludeQuery, withTemplateTwins } from "./paths.js";
import type {
    CompilerIncludes,
    DroppedRecipe,
    IncludeContext,
    IncludeGroup,
    IncludeResolution,
    NamespaceResolution,
    NamespaceResolver,
    RecipeRoot,
} from "./types.js";

/** The files each view lists, keyed by the name with its `#`. */
export type ViewMap = Record<string, readonly HashViewFile[]>;

/** What include resolution reads from. */
export interface IncludeEnvironment {
    readonly aliases: AliasMap;
    readonly views: ViewMap;
    readonly globs: Globs;
    readonly namespaceResolver?: NamespaceResolver | undefined;
    /** `${var}` substitution that leaves unknown names as written. */
    substitute(text: string, scope: VarScope): string;
    /** Whether a file exists. Default: `fs.existsSync`. */
    exists?(file: string): boolean;
    /** The home directory `~/` expands to. */
    home?: string;
}

/** A `~` reference that gave no usable candidates, kept for the error. */
export type NamespaceProblem = NonNullable<IncludeResolution["namespaceProblem"]>;

/** Every group an include path resolves to, before anything is read from disk. */
export interface IncludePlan {
    readonly groups: IncludeGroup[];
    readonly candidates: string[];
    readonly glob: boolean;
    readonly view: boolean;
    readonly namespaceProblem?: NamespaceProblem;
    readonly hashProblem?: string;
}

/** The group of one literal path followed by its `.tpl.` twin. */
function literalGroups(candidate: string, root?: RecipeRoot): IncludeGroup[] {
    return withTemplateTwins([candidate]).map((entry) => ({
        paths: [entry],
        glob: false,
        ...(root === undefined ? {} : { roots: [root] }),
    }));
}

/**
 * Resolves an include path to its ordered groups, reading nothing from disk.
 *
 * @param rawPath - The include path without its `@`.
 */
export function planInclude(rawPath: string, context: IncludeContext, env: IncludeEnvironment): IncludePlan {
    const baseDir = context.baseDir ?? path.dirname(context.fromFile);
    const withQuery = expandHome(env.substitute(rawPath, context.scope), env.home);
    const substituted = splitIncludeQuery(withQuery).path;
    const glob = env.globs.hasGlob(substituted);

    const finish = (
        groups: IncludeGroup[],
        extra: { namespaceProblem?: NamespaceProblem; hashProblem?: string; view?: boolean } = {},
    ): IncludePlan => ({
        groups,
        candidates: [...new Set(groups.flatMap((group) => group.paths))],
        glob,
        view: extra.view ?? false,
        ...(extra.namespaceProblem === undefined ? {} : { namespaceProblem: extra.namespaceProblem }),
        ...(extra.hashProblem === undefined ? {} : { hashProblem: extra.hashProblem }),
    });
    const single = (candidate: string): IncludeGroup[] => (glob ? [{ paths: [candidate], glob: true }] : literalGroups(candidate));

    if (path.isAbsolute(substituted)) {
        return finish(single(path.normalize(substituted)));
    }

    const { key, rest } = splitAliasKey(substituted);

    if (key.startsWith("#") && Object.prototype.hasOwnProperty.call(env.views, key)) {
        return planView(key, rest, glob, context, env, finish);
    }

    const groups: IncludeGroup[] = [];
    let namespaceProblem: NamespaceProblem | undefined;
    let hashProblem: string | undefined;

    if (key && Object.prototype.hasOwnProperty.call(env.aliases, key)) {
        for (const base of env.aliases[key]!) {
            groups.push(...single(path.resolve(base, rest)));
        }
    } else if (key.startsWith("#") && rest.length > 0) {
        const known = [...Object.keys(env.aliases), ...Object.keys(env.views)].filter((name) => name.startsWith("#"));

        hashProblem =
            `There is no built-in name "${key}" available here.\n` +
            (known.length > 0 ? `Available names: ${known.sort().join(", ")}.` : "No '#' names are available in this project.");
    }

    if (env.namespaceResolver && substituted.startsWith("~") && substituted.length > 1 && substituted.includes("/")) {
        const reference = withQuery.slice(1);
        const resolution = env.namespaceResolver.resolve({ reference, fromFile: context.fromFile });

        if (resolution.kind === "candidates" && resolution.glob === true) {
            groups.push({
                paths: [...resolution.candidates],
                glob: true,
                ...(resolution.roots === undefined ? {} : { roots: resolution.roots }),
            });
        } else if (resolution.kind === "candidates" && resolution.candidates.length > 0) {
            resolution.candidates.forEach((candidate, index) => {
                groups.push(...literalGroups(path.normalize(candidate), resolution.roots?.[index]));
            });
        } else if (resolution.kind !== "candidates") {
            namespaceProblem = { reference, fromFile: context.fromFile, resolution };
        }
    }

    groups.push(...single(path.resolve(baseDir, substituted)));

    return finish(groups, {
        ...(namespaceProblem === undefined ? {} : { namespaceProblem }),
        ...(hashProblem === undefined ? {} : { hashProblem }),
    });
}

/** A `#name/...` include of a view: selects among the files it lists. */
function planView(
    key: string,
    wanted: string,
    glob: boolean,
    context: IncludeContext,
    env: IncludeEnvironment,
    finish: (groups: IncludeGroup[], extra: { hashProblem?: string; view?: boolean }) => IncludePlan,
): IncludePlan {
    const includingRecipe = env.namespaceResolver?.includingRecipe?.(context.fromFile) ?? null;

    if (includingRecipe !== null) {
        return finish([], {
            view: true,
            hashProblem:
                `The recipe "${includingRecipe}" may not include "${key}", because a view lists other recipes' files.\n` +
                `A recipe includes another recipe's files with "@~namespace/recipe/..." and a ` +
                `dependency declared in its manifest ("depends" or "subscribes").`,
        });
    }

    const listed = env.views[key]!;
    const matched = listed.filter((entry) => (glob ? env.globs.isMatch(entry.path, wanted, { dot: true }) : entry.path === wanted));
    const problem =
        !glob && matched.length === 0
            ? `The view "${key}" lists no file at "${wanted}".\n` +
              (listed.length > 0
                  ? `It lists:\n${listed.map((entry) => `  ${key}/${entry.path}`).join("\n")}`
                  : "It lists no files in this project.")
            : undefined;

    return finish(matched.length > 0 ? [{ paths: [...new Set(matched.map((entry) => entry.file))], glob: false }] : [], {
        view: true,
        ...(problem === undefined ? {} : { hashProblem: problem }),
    });
}

/**
 * Resolves an include path to the files it names: the groups are tried in order and the first that
 * names any file gives all of them. A file a recipe reference reaches through a link that leaves
 * the recipe is refused.
 *
 * @param rawPath - The include path without its `@`.
 */
export function resolveIncludeFiles(rawPath: string, context: IncludeContext, env: IncludeEnvironment): IncludeResolution {
    const plan = planInclude(rawPath, context, env);
    const exists = env.exists ?? ((file: string) => fs.existsSync(file));
    const expand = (pattern: string) => expandPattern(env.globs, pattern, { dot: true });
    const base = {
        candidates: plan.candidates,
        glob: plan.glob,
        view: plan.view,
        ...(plan.namespaceProblem === undefined ? {} : { namespaceProblem: plan.namespaceProblem }),
        ...(plan.hashProblem === undefined ? {} : { hashProblem: plan.hashProblem }),
    };

    for (const group of plan.groups) {
        const found = group.glob ? group.paths.flatMap(expand) : group.paths.filter((candidate) => exists(candidate));

        if (group.roots !== undefined) {
            const roots = group.roots;
            const leaving = group.paths.flatMap((entry, index) => {
                const root = roots[index];

                if (root === undefined) {
                    return [];
                }

                const files = group.glob ? expand(entry) : exists(entry) ? [entry] : [];

                return files.filter((file) => !isRealPathInside(env.globs, file, root.dir)).map(() => root);
            });

            if (leaving.length > 0) {
                const reference = rawPath.replace(/^~/, "");

                return {
                    ...base,
                    files: [],
                    namespaceProblem: {
                        reference,
                        fromFile: context.fromFile,
                        resolution: { kind: "escapes-recipe", recipe: leaving[0]!.recipe, reference },
                    },
                };
            }
        }

        if (found.length > 0) {
            return { ...base, files: [...new Set(found)] };
        }
    }

    return { ...base, files: [] };
}

/** Whether a file's real path is inside a directory's real path, links followed. */
function isRealPathInside(globs: Globs, file: string, dir: string): boolean {
    return globs.realPathInside(file, dir) !== undefined;
}

/** The namespace of a `namespace/recipe` key. */
function namespaceOfKey(key: string): string {
    const slash = key.indexOf("/");

    return slash === -1 ? key : key.slice(0, slash);
}

/**
 * Describes a failed `~` include as indented lines for an error (`formatNamespaceProblem`); an
 * empty string when there is nothing to add.
 */
export function describeNamespaceProblem(problem: { fromFile: string; resolution: NamespaceResolution }): string {
    const resolution = problem.resolution;

    if (resolution.kind === "candidates") {
        return "";
    }

    if (resolution.kind === "invalid") {
        return [`in file: ${problem.fromFile}`, `reference: ~${resolution.reference}`, ...resolution.message.split("\n")]
            .map((line) => `  ${line}`)
            .join("\n");
    }

    const namespace = resolution.kind === "unknown-namespace" ? resolution.namespace : namespaceOfKey(resolution.recipe);
    const lines: string[] = [`in file: ${problem.fromFile}`, `namespace: ${namespace}`];

    if (resolution.kind === "unknown-namespace") {
        lines.push(`There is no recipe namespace named "${namespace}" available here.`);
        lines.push(
            resolution.known.length > 0 ? `Available namespaces: ${resolution.known.join(", ")}.` : "This project has no recipe namespaces available yet.",
        );

        if (resolution.dropped) {
            lines.push(...describeDropped(resolution.dropped, resolution.recipe));
        }
    } else if (resolution.kind === "unknown-recipe") {
        lines.push(`recipe: ${resolution.recipe}`);
        lines.push(`The namespace "${namespace}" holds no recipe named "${resolution.recipe}".`);
        lines.push(
            resolution.known.length > 0
                ? `Recipes in this namespace: ${resolution.known.join(", ")}.`
                : `The namespace "${namespace}" currently holds no recipes.`,
        );

        if (resolution.dropped) {
            lines.push(...describeDropped(resolution.dropped, resolution.recipe));
        }
    } else if (resolution.kind === "not-a-dependency") {
        lines.push(`recipe: ${resolution.recipe}`);

        if (resolution.includingRecipe) {
            lines.push(`The recipe "${resolution.includingRecipe}" does not declare "${resolution.recipe}" as a dependency.`);
            lines.push(`Add "${resolution.recipe}" to the "depends" list in that recipe's manifest before addressing it as "~${namespace}".`);
        } else {
            lines.push(`The project's own templates may not address "${resolution.recipe}".`);
        }
    } else if (resolution.kind === "escapes-recipe") {
        lines.push(`recipe: ${resolution.recipe}`);
        lines.push(`The reference "~${resolution.reference}" points outside the recipe "${resolution.recipe}".`);
        lines.push(
            `A "~namespace" reference addresses a recipe's own files, so it may not contain ` +
                `"." or ".." segments (also inside a { } alternative), may not be an absolute path, ` +
                `and may not reach a file through a link that leaves the recipe.`,
        );
        lines.push(`Write the path of a file inside the recipe, or include the other file by a relative path or a declared alias.`);
    }

    return lines.map((line) => `  ${line}`).join("\n");
}

/** The lines that say why a recipe a project template asked for is no longer pinned. */
function describeDropped(dropped: DroppedRecipe, recipe: string): string[] {
    if (dropped.by === "disabled-subscription") {
        return [
            `This project subscribes to "${dropped.subscription}", but that subscription is ` +
                `switched off ("enabled: false"), so the lockfile does not pin "${recipe}".`,
            `Switch the subscription back on, or remove the include.`,
        ];
    }

    const through = dropped.through === undefined || dropped.through.length === 0 ? "" : ` (through ${dropped.through.map((key) => `"${key}"`).join(", ")})`;

    return [
        `Version ${dropped.declaredAt} of "${dropped.recipe}" brought "${recipe}" in${through}, but ` +
            `the version this project pins, ${dropped.pinned}, does not, so the lockfile no longer pins it.`,
        `Subscribe to "${recipe}" directly to keep including it, or remove the include.`,
    ];
}

/** The `compiler.includes` service. */
export class IncludeService implements CompilerIncludes {
    constructor(private readonly env: IncludeEnvironment) {}

    isIncludeLine(line: string): boolean {
        return isIncludeLine(line);
    }

    looksLikeIncludeLine(line: string): boolean {
        return !isIncludeLine(line) && looksLikeIncludeLine(line);
    }

    resolve(rawPath: string, context: IncludeContext): IncludeResolution {
        return resolveIncludeFiles(rawPath.startsWith("@") ? rawPath.slice(1) : rawPath, context, this.env);
    }

    describeNamespaceProblem(problem: NamespaceProblem): string {
        return describeNamespaceProblem(problem);
    }
}
