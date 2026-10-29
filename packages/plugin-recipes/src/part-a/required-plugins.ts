/**
 * The npm plugins a recipe requires (S1, "Recipes that require npm plugins"). `subscription add`
 * refuses a recipe whose required plugin is missing or outside its range. Run interactively, it
 * offers to install the plugin; `--install-plugins` installs it without asking (L4). Installing is
 * plugin-update's `plugins.install` intent, run through `ctx.run`.
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

import { SousError, type Context } from "@sous-io/plugin-api";
import type {} from "@sous-io/plugin-update/types";
import semver from "semver";
import type { IntentFollowUp, ResolvedRecipe } from "../types.js";
import { ensureInStore } from "../part-b/fetch/restore.js";
import type { IndexCacheCore } from "../part-b/index-cache/index-cache.js";
import { trustedRepos } from "./project.js";
import { hasIntent } from "./util.js";

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
async function recipeDirectory(ctx: Context, recipe: ResolvedRecipe, download: boolean): Promise<string | undefined> {
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

    const core = (ctx.services.get("recipes.index-cache") as { core?: IndexCacheCore }).core;

    if (core === undefined) {
        return undefined;
    }

    try {
        const outcome = await ensureInStore(
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
                cache: core,
                hosts: ctx.entities.list("repository-host"),
                context: { plugin: ctx.plugin, config: ctx.config, services: ctx.services, entities: ctx.entities, project: ctx.project, env: ctx.env, cwd: ctx.cwd, reporter: ctx.reporter },
            },
        );

        return outcome.dir;
    } catch {
        return undefined;
    }
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
export async function ensureRequiredPlugins(ctx: Context, resolved: readonly ResolvedRecipe[], flags: RequirementFlags, ref: string): Promise<IntentFollowUp | undefined> {
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
            details: ["Nothing was written. Switch on @sous-io/plugin-update, or install the plugins yourself."],
        });
    }

    const result = await ctx.run(INSTALL_INTENT, { plugins: specs, yes: true });

    if (result.declined || (result.exitCode !== undefined && result.exitCode !== 0)) {
        throw new SousError(`Sous could not install ${specs.join(", ")}, so nothing was subscribed.`, {
            details: [result.declined ? "The install was declined." : `${[result.command.command, ...result.command.args].join(" ")} exited with code ${result.exitCode}.`],
        });
    }

    return { intent: INSTALL_INTENT, result };
}
