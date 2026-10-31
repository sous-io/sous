/**
 * Reading and checking a recipe repository before a release or a submission does anything: every
 * folder the repository manifest lists exists and holds a recipe manifest, every recipe belongs to a
 * declared namespace, no two recipes share a key, no recipe publishes a symbolic link, and no two
 * variable definitions quietly claim the same environment variable.
 *
 * Nothing here runs git or touches the network; it reads files and reports.
 */

import fs from "node:fs";
import path from "node:path";
import { ConfigError } from "@sous-io/plugin-api";
import type { RecipeManifest, RepoManifest } from "@sous-io/plugin-formats/types";
import type { ReleaseProblem } from "../types.js";
import type { AuthoringTools } from "../tools.js";
import { describeError } from "./problems.js";

/** The file name of a repository manifest, as messages name it. */
export const REPO_MANIFEST_FILE = "sous.repo.yaml";

/** The file name of a recipe manifest, as messages name it. */
export const RECIPE_MANIFEST_FILE = "sous.recipe.yaml";

/** The index file at a repository's root. */
export const INDEX_FILE = "sous.index.json";

/** Every name a manifest may have, in the order they are looked for. */
export const MANIFEST_EXTENSIONS = [".yaml", ".yml", ".json", ".jsonc"] as const;

/** One recipe folder that was found, read and checked. */
export interface ValidatedRecipe {
    /** The folder, relative to the repository root, as the repository manifest lists it. */
    readonly path: string;
    /** The folder, absolute. */
    readonly dir: string;
    /** The recipe manifest inside it, absolute. */
    readonly manifestPath: string;
    readonly manifest: RecipeManifest;
    /** `namespace/name`. */
    readonly key: string;
    /** The manifest exactly as it was parsed, `x-` keys included. */
    readonly raw: unknown;
}

/** Everything one pass over a repository found. */
export interface RepoValidation {
    readonly rootDir: string;
    readonly manifestPath: string;
    readonly manifest: RepoManifest;
    /** Every recipe that could be read, in the order the repository manifest lists them. */
    readonly recipes: ValidatedRecipe[];
    /** Errors and warnings together. */
    readonly problems: ReleaseProblem[];
}

/**
 * Names an operating system, a shell or a well-known tool already owns. Claiming one is legal and
 * occasionally right (binding an existing `GITHUB_TOKEN`), so it is a warning, silenced by
 * `x-intentional: true` on the definition.
 */
export const WELL_KNOWN_ENV_NAMES: readonly string[] = ["PATH", "HOME", "USER", "SHELL", "GITHUB_TOKEN", "GITLAB_TOKEN", "NPM_TOKEN"];

/** Prefixes treated the same way. `SOUS_VAR_` is exempt: every name sous derives starts with it. */
export const WELL_KNOWN_ENV_PREFIXES: readonly string[] = ["AWS_", "SOUS_"];

/** The extension key that silences the well-known name warning. */
export const INTENTIONAL_EXTENSION_KEY = "x-intentional";

/**
 * The repository root around a directory: the first directory at or above it holding a repository
 * manifest.
 *
 * @throws ConfigError when no directory above holds one.
 */
export function findRepoRoot(tools: AuthoringTools, startDir: string): string {
    const found = repoRootAround(tools, startDir);

    if (found !== undefined) {
        return found;
    }

    throw new ConfigError(
        `${path.resolve(startDir)} is not inside a sous recipe repository.\n` +
            `  A recipe repository has a '${REPO_MANIFEST_FILE}' file at its root, and sous looked in that ` +
            `directory and in every directory above it.\n` +
            `  Run the command from inside a repository, or create one with 'sous repo init'.`,
    );
}

/** The repository root around a directory, or `undefined`. */
export function repoRootAround(tools: AuthoringTools, startDir: string): string | undefined {
    let current = path.resolve(startDir);

    for (;;) {
        if (tools.manifests.find(current, "repo") !== undefined) {
            return current;
        }

        const parent = path.dirname(current);

        if (parent === current) {
            return undefined;
        }

        current = parent;
    }
}

/**
 * Reads and checks a whole recipe repository. The repository manifest itself must parse, since
 * there is nothing to report against without it; everything below it is collected into `problems`.
 */
export async function validateRepo(tools: AuthoringTools, rootDir: string): Promise<RepoValidation> {
    const manifestPath = tools.manifests.find(rootDir, "repo");

    if (manifestPath === undefined) {
        throw new ConfigError(`${rootDir} holds no '${REPO_MANIFEST_FILE}', so it is not a sous recipe repository.`);
    }

    const manifest = tools.repoManifest.parse(await tools.manifests.readFile(manifestPath), manifestPath);
    const problems: ReleaseProblem[] = [];
    const recipes: ValidatedRecipe[] = [];
    const seenKeys = new Map<string, string>();
    const manifestName = path.basename(manifestPath);

    for (const recipePath of manifest.recipes) {
        const dir = path.join(rootDir, recipePath);
        const found = await readRecipe(tools, rootDir, recipePath, dir, manifestName, problems);

        if (found === undefined) {
            continue;
        }

        if (!Object.hasOwn(manifest.namespaces, found.manifest.namespace)) {
            problems.push({
                level: "error",
                recipe: found.key,
                where: `${relative(rootDir, found.manifestPath)} namespace`,
                message:
                    `the recipe is in the namespace '${found.manifest.namespace}', which ${manifestName} does not ` +
                    `declare under 'namespaces'. Declare the namespace, or move the recipe into one that exists.`,
            });
        }

        const firstPath = seenKeys.get(found.key);

        if (firstPath !== undefined) {
            problems.push({
                level: "error",
                recipe: found.key,
                where: relative(rootDir, found.manifestPath),
                message:
                    `the recipe '${found.key}' is also published by ${firstPath}. A namespace and a name together ` +
                    `name exactly one recipe, so rename one of the two.`,
            });
        } else {
            seenKeys.set(found.key, relative(rootDir, found.manifestPath));
        }

        problems.push(...checkSymlinks(recipePath, dir));
        recipes.push(found);
    }

    problems.push(...checkVariableEnvNames(tools, rootDir, recipes));

    return { rootDir, manifestPath, manifest, recipes, problems };
}

/** Why an environment variable name deserves a warning, or `undefined` for an ordinary one. */
export function wellKnownEnvReason(envName: string): string | undefined {
    if (WELL_KNOWN_ENV_NAMES.includes(envName)) {
        return `'${envName}' is a well-known name that the system or another tool already uses`;
    }

    if (envName.startsWith("SOUS_VAR_")) {
        return undefined;
    }

    for (const prefix of WELL_KNOWN_ENV_PREFIXES) {
        if (envName.startsWith(prefix)) {
            return `'${envName}' starts with '${prefix}', a prefix reserved by the system or by another tool`;
        }
    }

    return undefined;
}

/** A path relative to the repository root, with forward slashes. */
export function relative(rootDir: string, target: string): string {
    return path.relative(rootDir, target).split(path.sep).join("/");
}

/** A path with forward slashes, which is what git speaks. */
export function toPosix(value: string): string {
    return value.split(path.sep).join("/");
}

async function readRecipe(
    tools: AuthoringTools,
    rootDir: string,
    recipePath: string,
    dir: string,
    manifestName: string,
    problems: ReleaseProblem[],
): Promise<ValidatedRecipe | undefined> {
    if (!isDirectory(dir)) {
        problems.push({
            level: "error",
            where: recipePath,
            message:
                `${manifestName} lists this recipe folder, but there is no directory there. Create it, or remove the ` +
                `path from the 'recipes' list.`,
        });

        return undefined;
    }

    let manifestPath: string | undefined;

    try {
        manifestPath = tools.manifests.find(dir, "recipe");
    } catch (error) {
        problems.push({ level: "error", where: recipePath, message: describeError(error) });

        return undefined;
    }

    if (manifestPath === undefined) {
        problems.push({
            level: "error",
            where: recipePath,
            message: `there is no recipe manifest in this folder. Every folder listed under 'recipes' holds one '${RECIPE_MANIFEST_FILE}'.`,
        });

        return undefined;
    }

    try {
        const raw = await tools.manifests.readFile(manifestPath);
        const manifest = tools.recipeManifest.parse(raw, manifestPath);

        return {
            path: recipePath,
            dir,
            manifestPath,
            manifest,
            key: `${manifest.namespace}/${manifest.name}`,
            raw,
        };
    } catch (error) {
        problems.push({ level: "error", where: relative(rootDir, manifestPath), message: describeError(error) });

        return undefined;
    }
}

interface EnvClaim {
    envName: string;
    variableName: string;
    where: string;
}

/**
 * Two definitions of the same variable may share an environment variable: that is how one answer
 * serves every recipe asking the same question. Two different variables sharing one is a collision.
 */
function checkVariableEnvNames(tools: AuthoringTools, rootDir: string, recipes: readonly ValidatedRecipe[]): ReleaseProblem[] {
    const problems: ReleaseProblem[] = [];
    const byEnvName = new Map<string, EnvClaim>();
    const byVariableName = new Map<string, EnvClaim>();

    for (const recipe of recipes) {
        (recipe.manifest.variables ?? []).forEach((definition, index) => {
            const envName = tools.names.bareName(definition);
            const where = `${relative(rootDir, recipe.manifestPath)} variables[${index}] ('${definition.name}')`;
            const claim: EnvClaim = { envName, variableName: definition.name, where };
            const byEnv = byEnvName.get(envName);

            if (byEnv !== undefined && byEnv.variableName !== definition.name) {
                problems.push({
                    level: "error",
                    recipe: recipe.key,
                    where,
                    message:
                        `claims the environment variable '${envName}', which ${byEnv.where} already claims for the ` +
                        `different variable '${byEnv.variableName}'. Two definitions cannot share one environment ` +
                        `variable; set 'env' explicitly on one of them.`,
                });
            } else if (byEnv === undefined) {
                byEnvName.set(envName, claim);
            }

            const byName = byVariableName.get(definition.name);

            if (byName !== undefined && byName.envName !== envName) {
                problems.push({
                    level: "warning",
                    recipe: recipe.key,
                    where,
                    message:
                        `binds to '${envName}', while ${byName.where} binds the same variable name to ` +
                        `'${byName.envName}'. One answer will not serve both; give them one 'env' value if they are ` +
                        `meant to be the same question.`,
                });
            } else if (byName === undefined) {
                byVariableName.set(definition.name, claim);
            }

            const reason = wellKnownEnvReason(envName);

            if (reason !== undefined && !isIntentional(recipe.raw, index)) {
                problems.push({
                    level: "warning",
                    recipe: recipe.key,
                    where,
                    message:
                        `${reason}. An answer written there is visible to every process this project starts. If that ` +
                        `is what you meant, set '${INTENTIONAL_EXTENSION_KEY}: true' on the definition to say so.`,
                });
            }
        });
    }

    return problems;
}

/** Whether the raw manifest marks the definition at `index` as an intentional claim. */
function isIntentional(raw: unknown, index: number): boolean {
    if (typeof raw !== "object" || raw === null) {
        return false;
    }

    const variables = (raw as Record<string, unknown>).variables;

    if (!Array.isArray(variables)) {
        return false;
    }

    const entry: unknown = variables[index];

    return typeof entry === "object" && entry !== null && (entry as Record<string, unknown>)[INTENTIONAL_EXTENSION_KEY] === true;
}

function isDirectory(candidate: string): boolean {
    try {
        return fs.statSync(candidate).isDirectory();
    } catch {
        return false;
    }
}

/**
 * Every symbolic link inside a recipe folder, as an error. A version's hash covers the folder
 * itself, and sous neither hashes nor installs what a link points at, so the file would be missing
 * for everyone who installs the recipe.
 */
function checkSymlinks(recipePath: string, dir: string): ReleaseProblem[] {
    const problems: ReleaseProblem[] = [];

    const walk = (current: string, prefix: string): void => {
        let entries: fs.Dirent[];

        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        } catch {
            return;
        }

        for (const entry of entries) {
            if (entry.name === ".git") {
                continue;
            }

            const relativePath = prefix.length > 0 ? `${prefix}/${entry.name}` : entry.name;

            if (entry.isSymbolicLink()) {
                problems.push({
                    level: "error",
                    where: `${recipePath}/${relativePath}`,
                    message:
                        "this is a symbolic link, and a recipe may not publish one. A published version's content hash " +
                        "covers the recipe folder itself, so sous neither hashes nor installs what a link points at; the " +
                        "file would simply be missing for everyone who installs the recipe. Replace the link with the " +
                        "file itself.",
                });
                continue;
            }

            if (entry.isDirectory()) {
                walk(path.join(current, entry.name), relativePath);
            }
        }
    };

    walk(dir, "");

    return problems;
}
