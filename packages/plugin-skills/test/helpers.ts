import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEngine, type Engine } from "@sous-io/core";
import {
    BufferedReporter,
    definePlugin,
    jsonSchema,
    type PluginDefinition,
    type ProjectInfo,
    type Sous,
} from "@sous-io/plugin-api";
import type { ActiveRecipeEntity } from "@sous-io/plugin-recipes/types";
import "../src/types.js";

/** A temporary directory, removed by `cleanup`. */
export interface TmpDir {
    readonly path: string;
    cleanup(): void;
}

/** A unique directory under the system's temp directory. */
export function makeTmpDir(prefix = "sous-skills-"): TmpDir {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));

    return { path: dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** Writes a file, creating its parent directories. */
export function write(file: string, contents = ""): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents, "utf8");
}

/** A project rooted in a directory. */
export function projectIn(root: string): ProjectInfo {
    const sousDir = path.join(root, ".sous");

    return { root, sousDir, configPath: undefined, confDir: path.join(sousDir, "conf.d") };
}

/** An active recipe whose files are in `dir`, publishing `skills/**`. */
export function activeRecipe(dir: string, overrides: Partial<ActiveRecipeEntity> = {}): ActiveRecipeEntity {
    return {
        id: "workflow/task-files",
        namespace: "workflow",
        name: "task-files",
        repo: "fixtures",
        identity: "example.com/fixtures",
        version: "1.0.0",
        hash: `sha256-${"a".repeat(64)}` as ActiveRecipeEntity["hash"],
        kind: "subscribes",
        requestedBy: ["project"],
        dir,
        source: "store",
        manifest: {
            formatVersion: 1,
            namespace: "workflow",
            name: "task-files",
            version: "1.0.0",
            contents: [{ kind: "skills", include: ["skills/**"] }],
        } as ActiveRecipeEntity["manifest"],
        ...overrides,
    };
}

/** What a compile saw, from the stand-in compiler. */
export interface CompileLog {
    runs: number;
}

/**
 * A stand-in for plugin-compiler: the `compilation` key, the `compilation-transform` kind, and a
 * `compiler.compile` intent that compiles nothing.
 */
export function compilerStandIn(log: CompileLog = { runs: 0 }): PluginDefinition {
    return definePlugin({
        name: "@sous-io/plugin-compiler",
        version: "0.2.34",
        register(sous) {
            sous.entities.add("config-key", { id: "compilation", schema: jsonSchema({}) });
            sous.entities.define("compilation-transform", jsonSchema({ type: "object" }));
            sous.intents.add({
                intent: "compiler.compile",
                handle: async () => {
                    log.runs += 1;

                    return { ok: true, outputs: [], problems: [], durationMs: 0 };
                },
            });
        },
    });
}

/** A stand-in for plugin-recipes: the `active-recipe` kind, and a contributor adding the given recipes. */
export function recipesStandIn(recipes: readonly ActiveRecipeEntity[]): PluginDefinition {
    return definePlugin({
        name: "@sous-io/plugin-recipes",
        version: "0.2.34",
        register(sous) {
            sous.entities.define("active-recipe", jsonSchema({ type: "object" }));
            sous.config.contribute({
                id: "recipes.fetch",
                contribute(config) {
                    for (const recipe of recipes) {
                        config.addEntity("active-recipe", recipe);
                    }
                },
            });
        },
    });
}

/** A plugin from a register function. */
export function plugin(name: string, register: (sous: Sous) => void): PluginDefinition {
    return definePlugin({ name, version: "1.0.0", register });
}

/** A plugin that sets config values, as a user's config file would. */
export function userConfig(data: Record<string, unknown>): PluginDefinition {
    return plugin("test-user-config", (sous) => {
        sous.config.contribute({ id: "config-files.main", contribute: (config) => config.root().merge(data) });
    });
}

/** An engine with the stand-ins and the given plugins, and a buffered reporter. */
export function makeEngine(builtIns: PluginDefinition[], project?: ProjectInfo): { engine: Engine; reporter: BufferedReporter } {
    const reporter = new BufferedReporter();

    return { engine: createEngine({ builtIns, reporter, ...(project ? { project } : {}) }), reporter };
}
