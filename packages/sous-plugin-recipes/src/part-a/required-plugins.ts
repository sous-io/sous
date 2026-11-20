/**
 * The npm plugins a recipe requires. `subscription add`
 * refuses a recipe whose required plugin is missing or outside its range. Run interactively, it
 * offers to install the plugin; `--install-plugins` installs it without asking, so an agent can too. Installing is
 * sous-plugin-update's `plugins.install` intent, run through `ctx.run`.
 *
 * ```yaml
 * # sous.recipe.yaml
 * requires:
 *     plugins:
 *         sous-plugin-claude-code: "^1.0.0"
 * ```
 *
 * The index does not publish `requires`, so each newly resolved recipe is put in the store first
 * (the same download a build would make) and its manifest read from there.
 */

import { SousError, type Context } from "@sous-io/sous-plugin-api";
import type {} from "@sous-io/sous-plugin-update/types";
import semver from "semver";
import type { ResolvedRecipe } from "../types.js";
import type { RanFollowUp } from "./outputs.js";
import { trustedRepos } from "./project.js";
import { describeError, hasIntent, resolvedAtPin } from "./util.js";

/**
 * The line added when installing a plugin named under `requires.plugins` fails: a plugin that
 * ships inside a recipe has no npm name to match, so this is the most sous can say.
 */
export const REQUIRED_PLUGIN_HINT = "Perhaps the required plugin ships as part of a recipe?";

/** The intent that installs plugins. */
export const INSTALL_INTENT = "plugins.install";

/** One requirement the loaded plugins do not meet. */
export interface UnmetRequirement {
    /** The recipe that requires it. */
    readonly recipe: string;
    readonly plugin: string;
    readonly range: string;
    /** The version loaded now, when one is, outside the range. */
    readonly installed?: string;
}

/** What the flags of `subscription add` say about installing. */
export interface RequirementFlags {
    readonly installPlugins?: boolean;
    readonly dryRun?: boolean;
}

/** What a requirement says, in a sentence. */
export function describeUnmet(unmet: UnmetRequirement): string {
    return unmet.installed === undefined
        ? `'${unmet.recipe}' requires the plugin ${unmet.plugin} ${unmet.range}, which is not installed.`
        : `'${unmet.recipe}' requires the plugin ${unmet.plugin} ${unmet.range}, and version ${unmet.installed} is installed.`;
}

/** The `name@range` specs to install. */
function specsOf(unmet: readonly UnmetRequirement[]): string[] {
    return [...new Set(unmet.map((entry) => `${entry.plugin}@${entry.range}`))];
}

/** The requirements of some manifests the loaded plugins do not meet. */
export function unmetRequirements(
    required: ReadonlyArray<{ readonly recipe: string; readonly plugins: Readonly<Record<string, string>> }>,
    loaded: ReadonlyArray<{ readonly name: string; readonly version: string | undefined }>,
): UnmetRequirement[] {
    const unmet: UnmetRequirement[] = [];

    for (const { recipe, plugins } of required) {
        for (const [plugin, range] of Object.entries(plugins)) {
            const found = loaded.find((entry) => entry.name === plugin);
            const version = found?.version;

            if (found !== undefined && (version === undefined || semver.satisfies(version, range, { includePrerelease: true }))) {
                continue;
            }

            unmet.push({ recipe, plugin, range, ...(found === undefined || version === undefined ? {} : { installed: version }) });
        }
    }

    return unmet;
}

/**
 * The directory a resolved recipe's files are in, downloading it into the store when it is not
 * there yet. `undefined` when it cannot be had; the build that follows reports that.
 */
export async function recipeDirectory(ctx: Context, recipe: ResolvedRecipe, download: boolean): Promise<string | undefined> {
    const entry = trustedRepos(ctx.config)[recipe.repo];

    if (entry === undefined || !ctx.services.has("recipes.store") || !ctx.services.has("recipes.index-cache")) {
        return undefined;
    }

    if (!download) {
        try {
            const hit = await ctx.services.get("recipes.store").get({ identity: recipe.identity, namespace: recipe.namespace, name: recipe.name, version: recipe.version });

            return hit?.dir;
        } catch {
            return undefined;
        }
    }

    try {
        return await ensureRecipeFiles(ctx, recipe, entry);
    } catch {
        return undefined;
    }
}

/** Downloads one resolved recipe into the store when it is not there yet; returns its directory, or throws why it cannot be had. */
async function ensureRecipeFiles(ctx: Context, recipe: ResolvedRecipe, entry: { url: string; provider?: string }): Promise<string> {
    const outcome = await ctx.services.get("recipes.index-cache").ensureInStore(
        {
            key: recipe.key,
            entry: { repo: recipe.repo, version: recipe.version, hash: recipe.hash, requestedBy: recipe.requestedBy, kind: recipe.kind },
            repo: recipe.repo,
            url: entry.url,
            identity: recipe.identity,
            ...(entry.provider === undefined ? {} : { provider: entry.provider }),
        },
        {
            store: ctx.services.get("recipes.store"),
            hosts: ctx.entities.list("repository-host"),
            context: { plugin: ctx.plugin, config: ctx.config, services: ctx.services, entities: ctx.entities, project: ctx.project, env: ctx.env, cwd: ctx.cwd, reporter: ctx.reporter },
        },
    );

    return outcome.dir;
}

/**
 * Downloads every version of the resolved recipes that the store lacks (the shared version, then
 * each version pinned for one holder alone), so a command can find out before writing anything that
 * its recipes can be had. Returns each version that could not be downloaded, and why; empty when
 * every one is here now. Without the store, nothing is checked.
 */
export async function downloadRecipes(ctx: Context, resolved: readonly ResolvedRecipe[]): Promise<Array<{ key: string; version: string; reason: string }>> {
    if (!ctx.services.has("recipes.store") || !ctx.services.has("recipes.index-cache")) {
        return [];
    }

    const trusted = trustedRepos(ctx.config);
    const failed: Array<{ key: string; version: string; reason: string }> = [];

    for (const recipe of resolved) {
        const entry = trusted[recipe.repo];

        for (const version of [recipe, ...(recipe.pins ?? []).map((pin) => resolvedAtPin(recipe, pin))]) {
            if (entry === undefined) {
                failed.push({ key: recipe.key, version: version.version, reason: `the repository '${recipe.repo}' is not trusted in this project` });
                continue;
            }

            try {
                await ensureRecipeFiles(ctx, version, entry);
            } catch (error) {
                failed.push({ key: recipe.key, version: version.version, reason: describeError(error) });
            }
        }
    }

    return failed;
}

/** What each resolved recipe requires, read from its manifest; `download: false` reads only what the store holds already. */
export async function requiredPlugins(ctx: Context, resolved: readonly ResolvedRecipe[], download = true): Promise<Array<{ recipe: string; plugins: Record<string, string> }>> {
    if (!ctx.services.has("formats.manifests")) {
        return [];
    }

    const manifests = ctx.services.get("formats.manifests");
    const required: Array<{ recipe: string; plugins: Record<string, string> }> = [];

    for (const recipe of resolved) {
        const dir = await recipeDirectory(ctx, recipe, download);

        if (dir === undefined) {
            continue;
        }

        let plugins: Record<string, string> | undefined;

        try {
            plugins = (await manifests.readRecipe(dir))?.manifest.requires?.plugins;
        } catch {
            plugins = undefined;
        }

        if (plugins !== undefined && Object.keys(plugins).length > 0) {
            required.push({ recipe: recipe.key, plugins });
        }
    }

    return required;
}

/**
 * Checks what the resolved recipes require before anything is written. Unmet requirements are
 * installed through `plugins.install` when `--install-plugins` is given or the person agrees;
 * otherwise subscribing is refused. Returns the install follow-up, or `undefined` when nothing
 * was needed.
 */
export async function ensureRequiredPlugins(ctx: Context, resolved: readonly ResolvedRecipe[], flags: RequirementFlags, ref: string): Promise<RanFollowUp | undefined> {
    // A dry run downloads nothing, so it checks only the recipes already in the store.
    const required = await requiredPlugins(ctx, resolved, flags.dryRun !== true);
    const unmet = required.length === 0 ? [] : unmetRequirements(required, ctx.engine.plugins());

    if (unmet.length === 0) {
        return undefined;
    }

    const specs = specsOf(unmet);

    for (const entry of unmet) {
        ctx.reporter.note(describeUnmet(entry));
    }

    if (flags.dryRun === true) {
        return { intent: INSTALL_INTENT, skipped: "--dry-run" };
    }

    let install = flags.installPlugins === true;

    if (!install && ctx.prompter.interactive) {
        install = await ctx.prompter.confirm({ message: `Install ${specs.join(", ")} now?`, answeredBy: "--install-plugins", default: true });
    }

    if (!install) {
        throw new SousError(unmet.length === 1 ? describeUnmet(unmet[0]!) : `'${ref}' requires plugins that are not installed: ${specs.join(", ")}.`, {
            details: [
                "Nothing was written.",
                `Run 'sous subscription add ${ref} --install-plugins' to install ${unmet.length === 1 ? "it" : "them"} through this project's package manager, or install ${unmet.length === 1 ? "it" : "them"} yourself (for example, 'npm install --save-dev ${specs.join(" ")}').`,
            ],
        });
    }

    if (!hasIntent(ctx, INSTALL_INTENT)) {
        throw new SousError(`'${ref}' requires ${specs.join(", ")}, and no plugin provides '${INSTALL_INTENT}' to install ${unmet.length === 1 ? "it" : "them"}.`, {
            details: ["Nothing was written. Switch on @sous-io/sous-plugin-update, or install the plugins yourself."],
        });
    }

    const outputs = await ctx.run(INSTALL_INTENT, { plugins: specs, yes: true });
    const result = outputs.toPlain();

    if (result.declined || (result.exitCode !== undefined && result.exitCode !== 0)) {
        throw new SousError(`Sous could not install ${specs.join(", ")}, so nothing was subscribed.`, {
            details: result.declined
                ? ["The install was declined."]
                : [`${[result.command.command, ...result.command.args].join(" ")} exited with code ${result.exitCode}.`, REQUIRED_PLUGIN_HINT],
        });
    }

    return { intent: INSTALL_INTENT, result, outputs };
}
