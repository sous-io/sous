/**
 * Test helpers: a project in a temporary directory, recipes with handler files, and an engine
 * with sous-plugin-handlers, the real sous-plugin-host, and a stand-in for sous-plugin-recipes (the
 * `active-recipe` entities, the `repos` key, and the intents that write the lockfile, which fire
 * `recipes.locked`).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BufferedReporter, definePlugin, IntentOutputs, jsonSchema, type PluginDefinition, type ProjectInfo } from "@sous-io/sous-plugin-api";
import { createEngine, type Engine } from "@sous-io/sous-lib-core";
import { hostPlugin } from "@sous-io/sous-plugin-host";
import type { LockDiff } from "@sous-io/sous-plugin-recipes/types";
import { doctorPlugin } from "@sous-io/sous-plugin-doctor";
import handlersPlugin from "../src/index.js";
import packageJson from "../package.json" with { type: "json" };

/** A temporary directory, removed by `cleanup()`. Links are followed, so paths compare equal. */
export function makeTmpDir(prefix = "sous-handlers-"): { path: string; cleanup(): void } {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

    return { path: dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** Writes a file under `root`, creating its directories. */
export function write(root: string, rel: string, contents: string): string {
    const file = path.join(root, rel);

    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents, "utf8");

    return file;
}

/** A project in `root`. */
export function projectAt(root: string): ProjectInfo {
    const sousDir = path.join(root, ".sous");

    fs.mkdirSync(sousDir, { recursive: true });

    return { root, sousDir, configPath: undefined, confDir: path.join(sousDir, "conf.d") };
}

/** What a recipe fixture is given. */
export interface RecipeFixture {
    version?: string;
    kind?: "subscribes" | "depends";
    repo?: string;
    /** Files to write in the recipe, by path. */
    files?: Record<string, string>;
    /** The manifest's `handlers` block. */
    handlers?: Record<string, Array<{ file: string; handler: string }>>;
}

/** An `active-recipe` entity, its files written under `root/store/<key>/<version>`. */
export function recipe(root: string, key: string, options: RecipeFixture = {}): Record<string, unknown> & { id: string; version: string; dir: string } {
    const [namespace, name] = key.split("/") as [string, string];
    const version = options.version ?? "1.0.0";
    const dir = path.join(root, "store", namespace, name, version);

    fs.mkdirSync(dir, { recursive: true });

    for (const [file, text] of Object.entries(options.files ?? {})) {
        write(dir, file, text);
    }

    return {
        id: key,
        namespace,
        name,
        repo: options.repo ?? "fixtures",
        identity: "example.com/fixtures",
        version,
        hash: `sha256-${"a".repeat(64)}`,
        kind: options.kind ?? "subscribes",
        requestedBy: ["project"],
        dir,
        source: "store",
        manifest: {
            formatVersion: 1,
            namespace,
            name,
            version,
            contents: [],
            ...(options.handlers === undefined ? {} : { handlers: options.handlers }),
        },
    };
}

/** What the stand-in for sous-plugin-recipes serves; tests change it between builds. */
export interface RecipesState {
    recipes: Array<Record<string, unknown>>;
    /** The trusted repositories, by short name. */
    repos: Record<string, Record<string, unknown>>;
}

/** An empty lock diff, with some fields set. */
export function diff(changes: Partial<LockDiff>): LockDiff {
    return { added: [], removed: [], updated: [], changed: [], reposAdded: [], reposRemoved: [], unchanged: false, ...changes };
}

/**
 * Stands in for sous-plugin-recipes: the `active-recipe` entities and `repos`, from `state`, and three
 * intents that write the lockfile the way the real ones do: `subscription.update` (moves pins,
 * then rebuilds the config), `subscription.remove` (drops pins, then rebuilds) and
 * `subscription.add` (adds pins, then rebuilds). Each takes the diff and the next state as input
 * through `next`.
 */
export function recipesStandIn(state: RecipesState, next: { diff?: LockDiff; recipes?: Array<Record<string, unknown>> }): PluginDefinition {
    const lockWrite = async (input: { dryRun?: boolean }, ctx: { emit: (name: string, payload: unknown) => Promise<unknown>; configChanged(): void; refreshConfig(): Promise<unknown> }) => {
        // A dry run writes nothing, so the lockfile is not written and recipes.locked does not fire.
        if (input.dryRun === true) {
            return IntentOutputs.of({});
        }

        await ctx.emit("recipes.locked", { path: "sous.lock.json", diff: next.diff ?? diff({}) });

        if (next.recipes !== undefined) {
            state.recipes = next.recipes;
        }

        ctx.configChanged();
        await ctx.refreshConfig();

        return IntentOutputs.of({});
    };

    return definePlugin({
        name: "@sous-io/sous-plugin-recipes",
        // Every workspace package shares one version, and the handlers plugin needs this one or later.
        version: packageJson.version,
        register(sous) {
            sous.entities.add("config-key", { id: "recipes", schema: jsonSchema({}) });
            sous.entities.add("config-key", { id: "repos", schema: jsonSchema({}) });
            sous.entities.define("active-recipe", jsonSchema({ type: "object", required: ["id"] }));
            sous.config.contribute({
                id: "recipes.fetch",
                contribute(config) {
                    config.atPath("repos").merge(state.repos);

                    for (const entry of state.recipes) {
                        config.addEntity("active-recipe", entry as never);
                    }
                },
            });

            const input = jsonSchema({ type: "object", properties: { dryRun: { type: "boolean" }, noBuild: { type: "boolean" } } });

            for (const intent of ["subscription.update", "subscription.remove", "subscription.add"]) {
                sous.intents.add({ intent, input, handle: async (input, ctx) => lockWrite(input as never, ctx as never) as never });
            }
        },
    });
}

/** A plugin from a register function. */
export function plugin(name: string, register: PluginDefinition["register"]): PluginDefinition {
    return definePlugin({ name, version: "1.0.0", register });
}

/** An engine serving a project in `root`, with the handlers plugin, its stand-ins and `extra`. */
export function makeEngine(
    root: string,
    state: RecipesState,
    extra: PluginDefinition[] = [],
    next: { diff?: LockDiff; recipes?: Array<Record<string, unknown>> } = {},
): { engine: Engine; reporter: BufferedReporter; next: typeof next } {
    const reporter = new BufferedReporter();
    const engine = createEngine({
        project: projectAt(root),
        env: { PATH: process.env.PATH ?? "" },
        builtIns: [hostPlugin, recipesStandIn(state, next), doctorPlugin, handlersPlugin, ...extra],
        reporter,
    });

    return { engine, reporter, next };
}

/** Runs an intent and gives its result as plain data. */
export async function run<T>(engine: Engine, reporter: BufferedReporter, intent: string, input: Record<string, unknown> = {}): Promise<T> {
    const outputs = await engine.submit({ intent, input } as never, { reporter });

    return outputs.toPlain() as T;
}
