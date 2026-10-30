/**
 * Browsing namespaces and recipes (S6, `catalog.list`, `catalog.show`; the contract names them
 * `namespace.list`, `namespace.show`, `recipe.list` and `recipe.show`, the commands users type).
 * Each returns plain data; `plugin-cli` shows it. Nothing is downloaded unless `--latest` is given.
 */

import { SousError, type Context, type Sous } from "@sous-io/plugin-api";
import semver from "semver";
import type { BrowsingFlags, CatalogShowInput, NamespaceDetail, NamespaceListing, RecipeDetail, RecipeListing } from "../../types.js";
import { describedLocation, describeNamespace, describeRecipe, findInCatalog, listNamespaces, listRecipes, unknownRefError } from "../catalog.js";
import { loadCatalog, readPublishedManifest, readingsOf, resolveInCatalog, type CatalogContext } from "../catalog-context.js";
import { PROJECT_HOLDER } from "../lock-holds.js";
import { planQuestions } from "../questions.js";
import { describeError } from "../util.js";
import { acceptFirst, browsing, inputSchema, latestFlag } from "./schema.js";

const browsingCli = { flags: { latest: latestFlag } };

/** Reports the repositories that could not be read, so an empty listing is never a mystery. */
export function reportUnread(ctx: Pick<Context, "reporter">, catalog: Pick<CatalogContext, "notFetched" | "notChecked">): void {
    if (catalog.notFetched.length > 0) {
        ctx.reporter.note(`These repositories are trusted and their index has not been fetched yet, so nothing in them is listed: ${catalog.notFetched.join(", ")}.`);
    }

    if (catalog.notChecked.length > 0) {
        ctx.reporter.note(
            `These repositories could not be reached, so they are shown from the cache and were not checked: ${catalog.notChecked.map((entry) => entry.repo).join(", ")}.`,
        );

        for (const entry of catalog.notChecked) {
            ctx.reporter.log("debug", `${entry.repo}: ${entry.reason}`);
        }
    }
}

/** `namespace.show`: one namespace in full. */
export async function showNamespace(input: CatalogShowInput, ctx: Context): Promise<NamespaceDetail> {
    const catalog = await loadCatalog(ctx, input);

    reportUnread(ctx, catalog);
    const readings = readingsOf(ctx, input.ref);

    if (readings.every((reading) => reading.kind === "recipe" && reading.namespace !== undefined)) {
        const recipe = findInCatalog(catalog.inputs, readings, ["recipe"])[0];

        if (recipe !== undefined) {
            throw new SousError(`'${input.ref}' names the recipe '${recipe.key}', not a namespace.`, {
                details: [`The namespace it belongs to is '${recipe.key.split("/")[0]}'.`],
            });
        }
    }

    const found = await resolveInCatalog(ctx, catalog, input.ref, ["namespace"], input.acceptFirst, () => {
        const asRecipe = findInCatalog(catalog.inputs, readings, ["recipe"]);

        if (input.installed !== true && asRecipe.length > 0 && !readings.some((reading) => reading.kind === "namespace" && reading.repo !== undefined)) {
            return new SousError(`No repository this project trusts publishes a namespace called '${input.ref}'.`, {
                details: ["It is the name of a recipe:", ...asRecipe.map((match) => `  ${match.repo.name}:${match.key}`)],
            });
        }

        return installedError(input, "namespace") ?? unknownRefError(catalog.inputs, input.ref, "namespace", catalog.notFetched);
    });

    return describeNamespace(catalog.inputs, { repo: found.repo, namespace: found.key });
}

/** `recipe.show`: one recipe in full. */
export async function showRecipe(input: CatalogShowInput, ctx: Context): Promise<RecipeDetail> {
    const catalog = await loadCatalog(ctx, input);

    reportUnread(ctx, catalog);
    const found = await resolveInCatalog(ctx, catalog, input.ref, ["recipe"], input.acceptFirst, () => {
        const asNamespace = findInCatalog(catalog.inputs, readingsOf(ctx, input.ref), ["namespace"]);

        if (asNamespace.length > 0) {
            return new SousError(`No repository this project trusts publishes a recipe called '${input.ref}'.`, {
                details: ["It is the name of a namespace:", ...asNamespace.map((match) => `  ${match.repo.name}:${match.key}`)],
            });
        }

        return installedError(input, "recipe") ?? unknownRefError(catalog.inputs, input.ref, "recipe", catalog.notFetched);
    });
    const location = describedLocation(catalog.inputs, { repo: found.repo, key: found.key });
    const manifest = location === undefined ? undefined : await readPublishedManifest(ctx, catalog.inputs, location);
    const detail = describeRecipe(catalog.inputs, { repo: found.repo, key: found.key }, manifest);

    return { ...detail, ...(await previewSubscription(ctx, catalog, detail)) };
}

/**
 * What subscribing to the described version would install and ask, resolved against the indexes
 * already read, downloading nothing.
 */
async function previewSubscription(ctx: Context, catalog: CatalogContext, detail: RecipeDetail): Promise<Pick<RecipeDetail, "installs" | "installsNeed" | "installsProblem" | "questions">> {
    if (detail.describing === undefined) {
        return {};
    }

    const prerelease = semver.prerelease(detail.describing) !== null;

    try {
        const result = await ctx.services.get("recipes.resolver").resolve(
            [
                {
                    ref: ctx.services.get("refs.format").recipeRef(detail.namespace, detail.name, { repo: detail.repo, range: detail.describing }),
                    range: detail.describing,
                    requestedBy: PROJECT_HOLDER,
                    kind: "subscribes",
                    ...(prerelease ? { prerelease: true } : {}),
                },
            ],
            { indexes: new Map(catalog.inputs.repos.map((repo) => [repo.name, repo.index])), ...(prerelease ? { prerelease: true } : {}) },
        );

        return {
            installs: result.resolved.map((recipe) => ({ key: recipe.key, version: recipe.version, kind: recipe.kind, requestedBy: recipe.requestedBy })),
            installsNeed: result.missingRepos,
            questions: await planQuestions(ctx, result.resolved),
        };
    } catch (error) {
        return { installsProblem: `Sous could not work out what subscribing to version ${detail.describing} would install. ${describeError(error)}` };
    }
}

function installedError(input: CatalogShowInput, what: "namespace" | "recipe"): SousError | undefined {
    if (input.installed !== true) {
        return undefined;
    }

    return new SousError(
        what === "namespace"
            ? `This project has installed no recipe from the namespace '${input.ref}', so there is nothing to show with '--installed'.`
            : `This project has not installed the recipe '${input.ref}', so there is nothing to show with '--installed'.`,
    );
}

/** Registers the four browsing intents. */
export function registerCatalogIntents(sous: Sous): void {
    sous.intents.add({
        intent: "namespace.list",
        requiresProject: true,
        summary: "List the namespaces in the repositories this project trusts",
        input: inputSchema<BrowsingFlags>(browsing),
        parallel: true,
        cli: { aliases: [["namespaces", "list"]], ...browsingCli },
        agent: { usage: "Call this before subscribing, to find which namespaces exist." },
        handle: async (input, ctx): Promise<NamespaceListing[]> => {
            const catalog = await loadCatalog(ctx, input);

            reportUnread(ctx, catalog);

            return listNamespaces(catalog.inputs);
        },
    });

    sous.intents.add({
        intent: "namespace.show",
        requiresProject: true,
        summary: "Show one namespace and every recipe in it",
        input: inputSchema<CatalogShowInput>({ ref: { type: "string", description: "The namespace, optionally as repository:namespace" }, ...browsing, acceptFirst }, ["ref"]),
        parallel: true,
        cli: { aliases: [["namespaces", "show"]], positional: ["ref"], ...browsingCli },
        handle: showNamespace,
    });

    sous.intents.add({
        intent: "recipe.list",
        requiresProject: true,
        summary: "List the recipes in the repositories this project trusts",
        input: inputSchema<BrowsingFlags>(browsing),
        parallel: true,
        cli: { aliases: [["recipes", "list"]], ...browsingCli },
        handle: async (input, ctx): Promise<RecipeListing[]> => {
            const catalog = await loadCatalog(ctx, input);

            reportUnread(ctx, catalog);

            return listRecipes(catalog.inputs);
        },
    });

    sous.intents.add({
        intent: "recipe.show",
        requiresProject: true,
        summary: "Show one recipe: its versions, dependencies, contents and questions",
        input: inputSchema<CatalogShowInput>(
            { ref: { type: "string", description: "The recipe: namespace/recipe, a bare name, or either as repository:ref" }, ...browsing, acceptFirst },
            ["ref"],
        ),
        parallel: true,
        cli: { aliases: [["recipes", "show"]], positional: ["ref"], ...browsingCli },
        handle: showRecipe,
    });
}
