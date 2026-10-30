/**
 * `repo.init`: scaffolds a new recipe repository, modeled on `sous-io/sous-recipes`: a repository
 * manifest, one example recipe with a placeholder skill, an empty but valid index, a README, a
 * `CONTRIBUTING.md`, a `CLAUDE.md` and an `AGENTS.md`, and a `.gitignore`. The CI workflow and any other
 * host files come from the `repository-host` entity (`scaffoldFiles`), so nothing host-specific lives
 * here.
 *
 * The scaffold is planned in memory, written, and read back with the very parsers sous reads a real
 * repository with; a scaffold sous cannot read is reported against the file it just wrote.
 */

import fs from "node:fs";
import path from "node:path";
import { ConfigError, type Context } from "@sous-io/plugin-api";
import type { RepositoryHostEntity, ScaffoldFile } from "@sous-io/plugin-recipes/types";
import type { RepoInitInput, RepoInitResult } from "../types.js";
import { toolsFrom, type AuthoringTools } from "../tools.js";
import { INDEX_FILE, RECIPE_MANIFEST_FILE, REPO_MANIFEST_FILE } from "../shared/repository.js";
import { hostForUrl } from "../submit/submit.js";
import {
    buildAgentsMd,
    buildClaudeMd,
    buildContributing,
    buildExampleSkill,
    buildGitignore,
    buildIndex,
    buildReadme,
    buildRecipeManifest,
    buildRepoManifest,
    exampleRecipePath,
    type ScaffoldContext,
} from "./templates.js";

/** The one example recipe every scaffold writes. */
export const EXAMPLE_RECIPE_NAME = "example";

/** Where and when a scaffold runs: the chain's working directory (`ctx.cwd`), or a test's. */
export interface ScaffoldOptions {
    readonly cwd: string;
    readonly now?: Date;
}

/** The intent's handler. */
export async function handleInit(input: RepoInitInput, ctx: Context): Promise<RepoInitResult> {
    return scaffoldRepo(toolsFrom(ctx), input, { cwd: ctx.cwd });
}

/** Creates a recipe repository in a directory. */
export async function scaffoldRepo(tools: AuthoringTools, input: RepoInitInput, options: ScaffoldOptions): Promise<RepoInitResult> {
    const directory = path.resolve(options.cwd, input.directory ?? ".");
    const name = normalizeName(input.name ?? path.basename(directory), "--name");
    const namespace = normalizeName(input.namespace ?? name, "--namespace");
    const dryRun = input.dryRun === true;
    const reporter = tools.reporter;

    reporter.variables([
        { label: "Directory", value: directory },
        { label: "Name", value: input.name ?? "(from the directory name)" },
        { label: "Namespace", value: input.namespace ?? "(same as the repository name)" },
    ]);

    assertNoExistingRepo(tools, directory, input.force === true);

    const host = await chooseHost(tools, directory, input.host);
    const hostFiles = host?.scaffoldFiles?.({ name, namespace, sousVersion: tools.sousVersion }) ?? [];
    const workflow = hostFiles.find((file) => /workflow|ci/i.test(file.path))?.path ?? hostFiles[0]?.path;
    const context: ScaffoldContext = {
        name,
        namespace,
        recipe: EXAMPLE_RECIPE_NAME,
        sousVersion: tools.sousVersion,
        generatedAt: (options.now ?? new Date()).toISOString(),
        ...(workflow === undefined ? {} : { workflow }),
        ...(host?.proposalNoun === undefined ? {} : { proposalNoun: host.proposalNoun }),
    };
    const files = [...planFiles(tools, context), ...hostFiles];

    reporter.operationStart("Creating a recipe repository");

    if (!dryRun) {
        for (const file of files) {
            const target = path.join(directory, file.path);

            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, file.content, "utf8");

            if (file.executable === true) {
                fs.chmodSync(target, 0o755);
            }
        }

        await verifyScaffold(tools, directory, context);
    }

    for (const file of files) {
        reporter.operation(dryRun ? "would-write" : "written", path.join(directory, file.path));
    }

    if (host === undefined) {
        reporter.note(
            "No repository host was named or found from a git remote, and no plugin adds GitHub's, so no CI workflow was " +
                "written. Pass '--host <id>' (such as 'gitlab') to add the one your host runs.",
        );
    }

    reporter.operationStart("What to do next");
    reporter.variables([
        { label: "Repository", value: name },
        { label: "Namespace", value: namespace },
        { label: "Example recipe", value: path.join("recipes", namespace, EXAMPLE_RECIPE_NAME, RECIPE_MANIFEST_FILE) },
    ]);
    reporter.note(
        "Edit the example recipe, or copy its folder to start another one. " +
            `Every recipe folder must also be listed under 'recipes' in ${REPO_MANIFEST_FILE}. ` +
            "Commit the repository and push it, then add it to a project with 'sous repo add <url>'. Adding a repository is what trusts it.",
    );

    return {
        directory,
        name,
        namespace,
        ...(host === undefined ? {} : { host: host.id }),
        files: files.map((file) => file.path),
        dryRun,
    };
}

/** Every file the scaffold writes itself, in order. */
function planFiles(tools: AuthoringTools, context: ScaffoldContext): ScaffoldFile[] {
    const recipeDir = exampleRecipePath(context);

    return [
        { path: REPO_MANIFEST_FILE, content: buildRepoManifest(context) },
        { path: INDEX_FILE, content: tools.indexFile.stringify(buildIndex(context)) },
        { path: `${recipeDir}/${RECIPE_MANIFEST_FILE}`, content: buildRecipeManifest(context) },
        { path: `${recipeDir}/skills/example-skill/SKILL.tpl.md`, content: buildExampleSkill(context) },
        { path: "README.md", content: buildReadme(context) },
        { path: "CONTRIBUTING.md", content: buildContributing(context) },
        { path: "CLAUDE.md", content: buildClaudeMd(context) },
        { path: "AGENTS.md", content: buildAgentsMd() },
        { path: ".gitignore", content: buildGitignore() },
    ];
}

/** The host a scaffold writes CI for when none is named or found: today's command always wrote GitHub's. */
const DEFAULT_HOST = "github";

/**
 * The host whose files the scaffold gets: the one named, else the one reading the directory's
 * `origin` remote, else GitHub when a plugin adds it, else none.
 */
async function chooseHost(tools: AuthoringTools, directory: string, named: string | undefined): Promise<RepositoryHostEntity | undefined> {
    if (named !== undefined) {
        const host = tools.entities.get("repository-host", named);

        if (host === undefined) {
            const known = tools.entities.list("repository-host").map((entry) => entry.id);

            throw new ConfigError(
                `No repository host is called '${named}'.\n  ${known.length === 0 ? "No plugin adds a repository host." : `The hosts are: ${known.join(", ")}.`}`,
            );
        }

        return host;
    }

    const url = fs.existsSync(directory) ? await tools.git.remoteUrl(directory, "origin").catch(() => undefined) : undefined;
    const found = url === undefined ? undefined : hostForUrl(tools, url);

    return found ?? tools.entities.get("repository-host", DEFAULT_HOST);
}

/** Refuses to scaffold over an existing repository unless asked; any other directory is fine. */
function assertNoExistingRepo(tools: AuthoringTools, directory: string, force: boolean): void {
    if (force || !fs.existsSync(directory)) {
        return;
    }

    const existing = tools.manifests.find(directory, "repo");

    if (existing !== undefined) {
        throw new ConfigError(
            `${directory} is already a sous repository.\n` +
                `  It holds ${path.basename(existing)}, which sous will not overwrite.\n` +
                `  Pass --force to write the scaffold over it, or choose another directory.`,
        );
    }
}

/** Reads back every file that has to parse, with the parsers that read a published repository. */
async function verifyScaffold(tools: AuthoringTools, directory: string, context: ScaffoldContext): Promise<void> {
    const manifestPath = path.join(directory, REPO_MANIFEST_FILE);
    const manifest = tools.repoManifest.parse(await tools.manifests.readFile(manifestPath), manifestPath);
    const indexPath = path.join(directory, INDEX_FILE);

    tools.indexFile.parse(JSON.parse(fs.readFileSync(indexPath, "utf8")), indexPath);

    for (const recipePath of manifest.recipes) {
        const recipeManifestPath = path.join(directory, recipePath, RECIPE_MANIFEST_FILE);
        const recipe = tools.recipeManifest.parse(await tools.manifests.readFile(recipeManifestPath), recipeManifestPath);

        if (!Object.hasOwn(manifest.namespaces, recipe.namespace)) {
            throw new ConfigError(
                `The scaffold in ${directory} is inconsistent.\n` +
                    `  The recipe at ${recipePath} declares the namespace '${recipe.namespace}', which ${REPO_MANIFEST_FILE} does not declare.\n` +
                    `  This is a bug in sous; please report it.`,
            );
        }
    }

    if (manifest.name !== context.name) {
        throw new ConfigError(
            `The scaffold in ${directory} is inconsistent: the repo manifest names it '${manifest.name}' rather than '${context.name}'.\n` +
                `  This is a bug in sous; please report it.`,
        );
    }
}

/**
 * A name the manifests accept: lowercase kebab case. Lower-cases first, so a directory called
 * `My-Recipes` gives `my-recipes`.
 */
export function normalizeName(value: string, flagName: string): string {
    const normalized = value.trim().toLowerCase();

    if (!/^[a-z][a-z0-9-]*$/.test(normalized)) {
        throw new ConfigError(
            `'${value}' cannot be used as a name here.\n` +
                `  A repository name and a namespace name are lowercase kebab-case: a letter, then letters, digits or ` +
                `hyphens (for example 'sous-recipes').\n` +
                `  Pass ${flagName} to choose one, or run the command in a directory whose own name fits.`,
        );
    }

    return normalized;
}
