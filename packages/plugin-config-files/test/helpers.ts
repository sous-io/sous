/**
 * Stand-ins for the plugins plugin-config-files depends on, and a project on disk to load.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEngine, type Engine } from "@sous-io/core";
import {
    BufferedReporter,
    definePlugin,
    type Environment,
    jsonSchema,
    type JsonValue,
    type PluginDefinition,
    type ProjectInfo,
} from "@sous-io/plugin-api";
import type { ExpressionsEvaluator } from "@sous-io/plugin-expressions/types";
import type { HostGlobs } from "@sous-io/plugin-host/types";

/** A temporary directory, removed by `cleanup`. */
export interface TmpDir {
    path: string;
    cleanup(): void;
}

/** Creates a unique temporary directory. */
export function makeTmpDir(prefix = "sous-test-"): TmpDir {
    const dirPath = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

    return { path: dirPath, cleanup: () => fs.rmSync(dirPath, { recursive: true, force: true }) };
}

/** A project on disk: `<root>/.sous`, with helpers to write files under it. */
export interface TestProject {
    readonly root: string;
    readonly sousDir: string;
    readonly confDir: string;
    /** Writes a file under `.sous/`, creating directories. Returns its path. */
    write(relative: string, text: string): string;
    /** The project, as the bin finds it. */
    info(): ProjectInfo;
    cleanup(): void;
}

/** Makes a project in a temporary directory. Marked ESM, so `.js` files import as modules. */
export function makeProject(): TestProject {
    const tmp = makeTmpDir("sous-config-files-");
    const sousDir = path.join(tmp.path, ".sous");

    fs.mkdirSync(sousDir, { recursive: true });
    fs.writeFileSync(path.join(tmp.path, "package.json"), JSON.stringify({ type: "module" }));

    return {
        root: tmp.path,
        sousDir,
        confDir: path.join(sousDir, "conf.d"),
        write(relative, text) {
            const full = path.join(sousDir, relative);

            fs.mkdirSync(path.dirname(full), { recursive: true });
            fs.writeFileSync(full, text, "utf8");

            return full;
        },
        info() {
            const main = ["sous.config.ts", "sous.config.mts", "sous.config.js", "sous.config.mjs", "sous.config.jsonc", "sous.config.json", "sous.config.yaml", "sous.config.yml"].find(
                (name) => fs.existsSync(path.join(sousDir, name)),
            );

            return { root: tmp.path, sousDir, configPath: main ? path.join(sousDir, main) : undefined, confDir: path.join(sousDir, "conf.d") };
        },
        cleanup: tmp.cleanup,
    };
}

/** Bytewise order, as plugin-host gives it. */
function compareBytewise(left: string, right: string): number {
    return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

/** A stand-in for `host.globs`: just what the config files use. */
export const standInGlobs: HostGlobs = {
    async match(patterns, options) {
        return standInGlobs.matchSync(patterns, options);
    },
    matchSync(patterns, options) {
        const list = typeof patterns === "string" ? [patterns] : [...patterns];
        const found = list.flatMap((pattern) => fs.globSync(pattern, { cwd: options.cwd }) as string[]);
        const files = found.filter((file) => fs.statSync(path.join(options.cwd, file)).isFile());

        return files.sort(compareBytewise).map((file) => (options.absolute ? path.join(options.cwd, file) : file));
    },
    isMatch: () => false,
    hasGlob: (text) => /[*?[{]/.test(text),
    staticBase(pattern) {
        const parts = pattern.split("/");
        const index = parts.findIndex((part) => /[*?[{]/.test(part));

        return index === -1 ? pattern : parts.slice(0, index).join("/") || "/";
    },
    compareBytewise,
    sortBytewise: (items) => [...items].sort(compareBytewise),
    isInside: () => false,
    realPathInside: () => undefined,
    toPosix: (file) => file.split(path.sep).join("/"),
};

/** A stand-in for plugin-host. */
export const standInHost: PluginDefinition = definePlugin({
    name: "@sous-io/plugin-host",
    version: "0.2.34",
    register(sous) {
        sous.services.add("host.globs", () => standInGlobs, { lifetime: "singleton" });
        sous.services.add(
            "host.package",
            () => ({ identity: () => ({ name: "@sous-io/sous", version: "9.9.9", root: "/opt/sous", realRoot: "/opt/sous", bin: undefined }) }),
            { lifetime: "singleton" },
        );
    },
});

/**
 * A stand-in for plugin-variables: owns `_vars` and `_env`.
 */
export const standInVariables: PluginDefinition = definePlugin({
    name: "@sous-io/plugin-variables",
    version: "0.2.34",
    register(sous) {
        sous.entities.add("config-key", { id: "_vars", schema: jsonSchema({ type: "object" }) });
        sous.entities.add("config-key", { id: "_env", schema: jsonSchema({ type: "object" }) });
    },
});

/**
 * A stand-in for plugin-expressions: an `$if` object with `expr: "<var> == '<value>'"`, reading
 * `_vars` through the builder so the file re-runs when the variable changes.
 */
export const standInExpressions: PluginDefinition = definePlugin({
    name: "@sous-io/plugin-expressions",
    version: "0.2.34",
    register(sous) {
        const isExpression = (value: unknown): boolean =>
            typeof value === "object" && value !== null && !Array.isArray(value) && "$if" in value;
        const has = (value: unknown): boolean =>
            isExpression(value) || (typeof value === "object" && value !== null && Object.values(value).some(has));

        const evaluator: ExpressionsEvaluator = {
            isExpressionObject: isExpression,
            hasExpressions: has,
            evaluations: () => [],
            unsettled: () => [],
            languages: () => ["liquid"],
            evaluateLayer(data, options) {
                const walk = (value: JsonValue): JsonValue | undefined => {
                    if (isExpression(value)) {
                        const spec = (value as { $if: { expr: string; then: JsonValue; else?: JsonValue } }).$if;
                        const [name, expected] = spec.expr.split("==").map((part) => part.trim().replace(/'/g, ""));
                        const seen = options.ownVars?.[name!] ?? options.config.atPath(["_vars", name!]).get();

                        return seen === expected ? spec.then : spec.else;
                    }

                    if (Array.isArray(value)) {
                        return value.map(walk).filter((item): item is JsonValue => item !== undefined);
                    }

                    if (typeof value === "object" && value !== null) {
                        const out: Record<string, JsonValue> = {};

                        for (const [key, inner] of Object.entries(value)) {
                            const result = walk(inner);

                            if (result !== undefined) {
                                out[key] = result;
                            }
                        }

                        return out;
                    }

                    return value;
                };

                return { value: walk(data), expressions: [], pending: false };
            },
        };

        sous.services.add("expressions.evaluator", () => evaluator, { lifetime: "singleton" });
    },
});

/** A plugin owning the given top-level keys, with schemas that accept anything. */
export function keysPlugin(...keys: string[]): PluginDefinition {
    return definePlugin({
        name: "test-keys",
        version: "1.0.0",
        register(sous) {
            for (const id of keys) {
                sous.entities.add("config-key", { id, schema: jsonSchema({}) });
            }
        },
    });
}

/** The keys the tests use. */
export const TEST_KEYS = ["compilation", "_aliases", "tools", "subscriptions", "repos", "fn", "when"];

/** An engine with the stand-ins, the given plugins and a buffered reporter. */
export function makeEngine(
    project: ProjectInfo | undefined,
    plugins: readonly PluginDefinition[],
    options: { env?: Environment; extra?: readonly PluginDefinition[] } = {},
): { engine: Engine; reporter: BufferedReporter } {
    const reporter = new BufferedReporter();
    const engine = createEngine({
        project,
        env: options.env ?? {},
        reporter,
        builtIns: [standInHost, standInVariables, standInExpressions, keysPlugin(...TEST_KEYS), ...plugins, ...(options.extra ?? [])],
    });

    return { engine, reporter };
}
