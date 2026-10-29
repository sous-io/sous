/**
 * Stand-ins for the plugins plugin-memories depends on, until the real ones can be loaded in a
 * test: `host.globs` (with the `pointer-file` kind), the `active-recipe` entities plugin-recipes
 * adds, the `hash-name` kind plugin-refs defines, and the `compilation` key plugin-compiler owns.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { globSync } from "glob";
import { minimatch } from "minimatch";
import { BufferedReporter, definePlugin, jsonSchema, type PluginDefinition } from "@sous-io/plugin-api";
import { createEngine, type Engine } from "@sous-io/core";
import type { MemoryGlobs, MemoryRecipe } from "../src/listing.js";
import memoriesPlugin from "../src/index.js";

/** `host.globs`, as far as plugin-memories uses it. */
export const standInGlobs: MemoryGlobs = {
    matchSync(patterns, options) {
        const found = globSync(patterns as string | string[], {
            cwd: options.cwd,
            absolute: options.absolute ?? false,
            dot: options.dot ?? false,
            nodir: options.onlyFiles ?? true,
            ignore: [...(options.ignore ?? [])],
        });

        return found.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    },
    isMatch: (candidate, pattern) => [pattern].flat().some((one) => minimatch(candidate, one)),
    staticBase(pattern) {
        const parts: string[] = [];

        for (const part of pattern.split("/")) {
            if (/[*?{[]/.test(part)) break;
            parts.push(part);
        }

        if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();

        return parts.join("/") || "/";
    },
    compareBytewise: (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)),
    realPathInside(file, root) {
        try {
            const real = fs.realpathSync(file);
            const realRoot = fs.realpathSync(root);

            return real === realRoot || real.startsWith(realRoot + path.sep) ? real : undefined;
        } catch {
            return undefined;
        }
    },
    toPosix: (p) => p.split(path.sep).join("/"),
};

/** A temporary directory, removed by `cleanup()`. */
export function makeTmpDir(prefix = "sous-memories-"): { path: string; cleanup(): void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));

    return { path: dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** Writes a file under `root`, creating its directories. */
export function write(root: string, rel: string, contents: string): string {
    const file = path.join(root, rel);

    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents, "utf8");

    return file;
}

/** Options for a recipe fixture. */
export interface RecipeFixture {
    kind?: "subscribes" | "depends";
    requestedBy?: string[];
    files?: string[];
    include?: string[];
    exclude?: string[];
}

/** Creates a recipe directory with memory files under `root/store`, and returns it as an active recipe. */
export function recipe(root: string, key: string, options: RecipeFixture = {}): MemoryRecipe & Record<string, unknown> {
    const [namespace, name] = key.split("/") as [string, string];
    const dir = path.join(root, "store", namespace, name);

    for (const file of options.files ?? ["memories/m.md"]) {
        write(dir, file, key);
    }

    return {
        id: key,
        namespace,
        name,
        repo: "fixtures",
        identity: "example.com/fixtures",
        version: "1.0.0",
        hash: `sha256-${"a".repeat(64)}`,
        kind: options.kind ?? "subscribes",
        requestedBy: options.requestedBy ?? ["project"],
        dir,
        source: "store",
        manifest: {
            formatVersion: 1,
            namespace,
            name,
            version: "1.0.0",
            contents: [
                {
                    kind: "memories",
                    include: options.include ?? ["memories/*.md"],
                    ...(options.exclude ? { exclude: options.exclude } : {}),
                },
            ],
        },
    } as MemoryRecipe & Record<string, unknown>;
}

/** Stands in for plugin-host: `host.globs` and the `pointer-file` kind. */
export const hostStandIn = definePlugin({
    name: "@sous-io/plugin-host",
    version: "0.2.34",
    register(sous) {
        sous.services.add("host.globs", () => standInGlobs as never, { lifetime: "singleton" });
        sous.entities.define(
            "pointer-file",
            jsonSchema({ type: "object", required: ["id", "fileName"], properties: { id: { type: "string" }, fileName: { type: "string" } } }),
        );
    },
});

/** Stands in for plugin-refs: the `hash-name` kind. */
export const refsStandIn = definePlugin({
    name: "@sous-io/plugin-refs",
    version: "0.2.34",
    register(sous) {
        sous.entities.define("hash-name", jsonSchema({ type: "object", required: ["id"] }));
    },
});

/** Stands in for plugin-compiler: the `compilation` key. */
export const compilerStandIn = definePlugin({
    name: "@sous-io/plugin-compiler",
    version: "0.2.34",
    register(sous) {
        sous.entities.add("config-key", { id: "compilation", schema: jsonSchema({}) });
    },
});

/** Stands in for plugin-recipes: the `recipes` key, and `active-recipe` entities from a contributor. */
export function recipesStandIn(recipes: () => readonly Record<string, unknown>[]): PluginDefinition {
    return definePlugin({
        name: "@sous-io/plugin-recipes",
        version: "0.2.34",
        register(sous) {
            sous.entities.add("config-key", { id: "recipes", schema: jsonSchema({}) });
            sous.entities.define("active-recipe", jsonSchema({ type: "object", required: ["id"] }));
            sous.config.contribute({
                id: "recipes.fetch",
                contribute(config) {
                    for (const entry of recipes()) {
                        config.addEntity("active-recipe", entry as never);
                    }
                },
            });
        },
    });
}

/** An engine with plugin-memories, its stand-ins and any extra plugins, and a buffered reporter. */
export function makeEngine(
    recipes: readonly Record<string, unknown>[],
    extra: PluginDefinition[] = [],
): { engine: Engine; reporter: BufferedReporter } {
    const reporter = new BufferedReporter();
    const engine = createEngine({
        builtIns: [hostStandIn, refsStandIn, compilerStandIn, recipesStandIn(() => recipes), memoriesPlugin, ...extra],
        reporter,
    });

    return { engine, reporter };
}

/** A plugin from a register function. */
export function plugin(name: string, register: PluginDefinition["register"]): PluginDefinition {
    return definePlugin({ name, version: "1.0.0", register });
}
