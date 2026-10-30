/**
 * The owners plugin-authoring works through, gathered once per intent run (L1): the git runner, the
 * format parsers, the recipe hash, the ref services, the recipe declarations, the variable names and
 * the repository hosts. Every module takes this bundle instead of reaching for `ctx`, so a test hands
 * in stand-ins for plugins that are not written yet.
 */

import path from "node:path";
import type { Context, EntityReader, Environment, Prompter, Reporter } from "@sous-io/plugin-api";
import type {
    FormatParser,
    FormatsManifests,
    FormatsRecipeHash,
    IndexFile,
    RecipeManifest,
    RepoManifest,
    WritableFormatParser,
} from "@sous-io/plugin-formats/types";
import type { GitRunner } from "@sous-io/plugin-git/types";
import type { RecipesDeclarations, RecipesLinks, RepositoryHostContext } from "@sous-io/plugin-recipes/types";
import type { RefsFormat, RefsLocations, RefsPicker, RefsResolver } from "@sous-io/plugin-refs/types";
import type { VariablesNames } from "@sous-io/plugin-variables/types";

/** Everything authoring uses from other plugins. */
/** The folder of a project's `.sous/` that `sous repo link` clones checkouts into. */
const PROJECT_REPOS_DIRNAME = "repos";

export interface AuthoringTools {
    readonly git: GitRunner;
    readonly manifests: FormatsManifests;
    readonly recipeManifest: FormatParser<RecipeManifest>;
    readonly repoManifest: FormatParser<RepoManifest>;
    readonly indexFile: WritableFormatParser<IndexFile>;
    readonly hash: FormatsRecipeHash;
    readonly refs: RefsResolver;
    readonly format: RefsFormat;
    readonly locations: RefsLocations;
    /** `undefined` when plugin-recipes is not active; the fold rule below is used then. */
    readonly declarations: RecipesDeclarations | undefined;
    readonly names: VariablesNames;
    readonly entities: EntityReader;
    readonly env: Environment;
    readonly reporter: Reporter;
    readonly prompter: Prompter;
    /** The sous version, written into an index as its generator. */
    readonly sousVersion: string;
    /** What a `repository-host` method gets. */
    hostContext(): RepositoryHostContext;
    /** The links service, when plugin-recipes is active and a project is open. */
    links(): RecipesLinks | undefined;
    /**
     * The directories `sous repo link` clones checkouts into: the project's, then the machine-wide
     * one. Either is left out when it cannot be worked out.
     */
    cloneDirectories(): string[];
    /** The ref picker, when plugin-refs is active. */
    picker(): RefsPicker | undefined;
}

/** Gathers the tools from a handler's context. Services are created on first use. */
export function toolsFrom(ctx: Context): AuthoringTools {
    const services = ctx.services;
    const lazy = <T>(get: () => T): (() => T) => {
        let value: T | undefined;
        let made = false;

        return () => {
            if (!made) {
                value = get();
                made = true;
            }

            return value as T;
        };
    };

    const git = lazy(() => services.get("git.runner"));
    const manifests = lazy(() => services.get("formats.manifests"));
    const recipeManifest = lazy(() => services.get("formats.recipe-manifest"));
    const repoManifest = lazy(() => services.get("formats.repo-manifest"));
    const indexFile = lazy(() => services.get("formats.index-file"));
    const hash = lazy(() => services.get("formats.recipe-hash"));
    const refs = lazy(() => services.get("refs.resolver"));
    const format = lazy(() => services.get("refs.format"));
    const locations = lazy(() => services.get("refs.locations"));
    const names = lazy(() => services.get("variables.names"));
    const declarations = lazy(() => (services.has("recipes.declarations") ? services.get("recipes.declarations") : undefined));

    return {
        get git() {
            return git();
        },
        get manifests() {
            return manifests();
        },
        get recipeManifest() {
            return recipeManifest();
        },
        get repoManifest() {
            return repoManifest();
        },
        get indexFile() {
            return indexFile();
        },
        get hash() {
            return hash();
        },
        get refs() {
            return refs();
        },
        get format() {
            return format();
        },
        get locations() {
            return locations();
        },
        get declarations() {
            return declarations();
        },
        get names() {
            return names();
        },
        entities: ctx.entities,
        env: ctx.env,
        reporter: ctx.reporter,
        prompter: ctx.prompter,
        sousVersion: ctx.engine.app.version,
        hostContext: () => ({
            plugin: ctx.plugin,
            config: ctx.config,
            services: ctx.services,
            entities: ctx.entities,
            project: ctx.project,
            env: ctx.env,
            reporter: ctx.reporter,
        }),
        links: () => (ctx.project !== undefined && services.has("recipes.links") ? services.get("recipes.links") : undefined),
        picker: () => (services.has("refs.picker") ? services.get("refs.picker") : undefined),
        cloneDirectories: () => {
            const directories: string[] = [];

            if (ctx.project !== undefined) {
                directories.push(path.join(ctx.project.sousDir, PROJECT_REPOS_DIRNAME));
            }

            if (services.has("host.sous-home")) {
                directories.push(services.get("host.sous-home").paths(ctx.env).repos);
            }

            return directories;
        },
    };
}
