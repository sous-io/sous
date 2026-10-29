/**
 * Running a `.js` or `.ts` config file (S2, "No child process").
 *
 * A module file may export:
 *   - data: `config`, or a default export that is not a function;
 *   - a function: `configure`, or a default export that is a function;
 *   - both: the data merges first, then the function runs.
 *
 * The function is given the builder, like any contributor: `configure(config)`. It runs again
 * whenever its contributor re-runs, and must give the same result for the same input.
 *
 * Files written before the builder existed change a plain config object in place:
 * `configure(cfg, builder) { cfg.name = "x"; builder.merge({...}) }`. Those keep working (S2, "The
 * robustness principle"): the first argument also reads and writes a copy of the config as it
 * stands, the second is the old builder (`config`, `env()`, `merge()`, `loadConfig()`,
 * `loadConfigs()`, `sousDir`, `confDir`, `currentFile`), and when the function returns, what it
 * changed in the copy is recorded through the builder as ordinary patches.
 */

import { deepEqual, isJsonObject, toPlainJson } from "@sous-io/documents";
import { type ConfigBuilder, ConfigError, type DocumentNode, type JsonObject, type JsonValue } from "@sous-io/plugin-api";
import type { ConfigureFunction } from "./types.js";

/** The members of the builder; every other property of the first argument is a config key. */
const BUILDER_MEMBERS = new Set<string | symbol>([
    "root",
    "atPath",
    "entities",
    "entity",
    "addEntity",
    "previousPatches",
    "apply",
    "options",
    "log",
    "contributor",
    "project",
    "env",
]);

/** What a module file exports, sorted out. */
export interface ModuleExports {
    /** The data it exports, when it exports any. */
    readonly data: unknown;
    /** Its function, when it exports one. */
    readonly configure: ((...args: unknown[]) => unknown) | undefined;
}

/**
 * Sorts out a module's exports.
 *
 * @throws ConfigError when the module exports neither data nor a function.
 */
export function moduleExports(module: Record<string, unknown>, label: string): ModuleExports {
    let data: unknown;
    let configure: ((...args: unknown[]) => unknown) | undefined;

    if (module.config !== undefined) {
        data = module.config;
    } else if (module.default !== undefined && typeof module.default !== "function") {
        data = module.default;
    }

    if (typeof module.configure === "function") {
        configure = module.configure as (...args: unknown[]) => unknown;
    } else if (typeof module.default === "function") {
        configure = module.default as (...args: unknown[]) => unknown;
    }

    if (data === undefined && configure === undefined) {
        throw new ConfigError(`${label} exports neither config data nor a configure function.`, {
            details: ["Export `config` (or a default object) with the data, or `configure(config)` (or a default function)."],
        });
    }

    return { data, configure };
}

/** What running a module file needs from the loader. */
export interface ModuleRunHost {
    /** The file, for messages: `sous.config.js`. */
    readonly label: string;
    /** The file's absolute path. */
    readonly path: string;
    /** Applies data the way a data file is applied (expressions evaluated, one merge at the root). */
    mergeData(config: ConfigBuilder, data: unknown): void;
    /** The old builder's `loadConfig()` and `loadConfigs()`, which load files into the copy. */
    loadInto(draft: JsonObject, specifier: string, glob: boolean, run: LegacyRunner): Promise<void>;
    /** The `.sous/` and `conf.d` directories, for the old builder. */
    readonly sousDir: string | undefined;
    readonly confDir: string | undefined;
}

/** Runs a module's exports against the copy of the config, for files the old builder loads. */
export type LegacyRunner = (exports: ModuleExports, path: string) => Promise<void>;

/** Makes the function a module file is applied with. */
export function moduleConfigure(exports: ModuleExports, host: ModuleRunHost): ConfigureFunction {
    return async (config) => {
        if (exports.data !== undefined) {
            host.mergeData(config, exports.data);
        }

        if (exports.configure === undefined) {
            return;
        }

        const before = toPlainJson(config.root().get()) ?? {};
        const draft = (isJsonObject(before) ? structuredClone(before) : {}) as JsonObject;
        const first = configProxy(config, draft);
        let currentFile = host.path;

        const run: LegacyRunner = async (nested, nestedPath) => {
            const previousFile = currentFile;

            currentFile = nestedPath;

            try {
                if (nested.data !== undefined) {
                    mergeLegacy(draft, nested.data, nestedPath);
                }

                if (nested.configure !== undefined) {
                    await callConfigure(nested.configure, draft, first, legacy, nestedPath);
                }
            } finally {
                currentFile = previousFile;
            }
        };

        const legacy = {
            get config(): JsonObject {
                return first as JsonObject;
            },
            sousDir: host.sousDir,
            confDir: host.confDir,
            get currentFile(): string {
                return currentFile;
            },
            env(name: string, fallback?: string): string | undefined {
                return config.env[name] ?? fallback;
            },
            merge(data: unknown): void {
                mergeLegacy(draft, data, currentFile);
            },
            async loadConfig(specifier: string): Promise<void> {
                await host.loadInto(draft, specifier, false, run);
            },
            async loadConfigs(pattern: string): Promise<void> {
                await host.loadInto(draft, pattern, true, run);
            },
        };

        await callConfigure(exports.configure, draft, first, legacy, host.label);

        const after = toPlainJson(draft) ?? {};

        recordDifference(config.root(), before, after);
    };
}

async function callConfigure(
    configure: (...args: unknown[]) => unknown,
    draft: JsonObject,
    first: unknown,
    legacy: unknown,
    where: string,
): Promise<void> {
    const returned = await configure(first, legacy);

    // A function may change the config in place and return it for chaining; merging it onto
    // itself would double every array, so only a distinct object is merged.
    if (returned !== undefined && returned !== null && returned !== first && returned !== draft) {
        mergeLegacy(draft, returned, where);
    }
}

/**
 * The first argument a module's function gets: the builder's members, and every other property
 * read from and written to the copy of the config.
 */
function configProxy(config: ConfigBuilder, draft: JsonObject): ConfigBuilder & JsonObject {
    return new Proxy(draft, {
        get(target, property) {
            if (BUILDER_MEMBERS.has(property)) {
                const member = (config as unknown as Record<string | symbol, unknown>)[property];

                return typeof member === "function" ? (member as (...args: unknown[]) => unknown).bind(config) : member;
            }

            return Reflect.get(target, property);
        },
        set(target, property, value) {
            return Reflect.set(target, property, value);
        },
    }) as ConfigBuilder & JsonObject;
}

/**
 * Merges data into the copy the way the old loader did: objects key by key, arrays joined, anything
 * else replaced. Keys that would change object prototypes are skipped.
 */
export function mergeLegacy(target: JsonObject, data: unknown, where: string): void {
    const plain = toPlainJson(data);

    if (!isJsonObject(plain)) {
        throw new ConfigError(`${where} did not produce a plain object (got ${Array.isArray(plain) ? "an array" : typeof plain}).`);
    }

    mergeInto(target, plain);
}

function mergeInto(target: JsonObject, source: JsonObject): void {
    for (const [key, value] of Object.entries(source)) {
        if (key === "__proto__" || key === "constructor" || key === "prototype") {
            continue;
        }

        const existing = target[key];

        if (isJsonObject(existing) && isJsonObject(value)) {
            mergeInto(existing, value);
        } else if (Array.isArray(existing) && Array.isArray(value)) {
            target[key] = [...existing, ...value];
        } else {
            target[key] = value;
        }
    }
}

/**
 * Records, through a builder node, the change from one value to another as few primitives as
 * possible: objects key by key, an array that only grew as appends, anything else as a set.
 */
export function recordDifference(node: DocumentNode, before: JsonValue | undefined, after: JsonValue | undefined): void {
    if (deepEqual(before, after)) {
        return;
    }

    if (after === undefined) {
        node.delete();

        return;
    }

    if (isJsonObject(before) && isJsonObject(after)) {
        for (const key of Object.keys(before)) {
            if (!(key in after)) {
                node.atPath([key]).delete();
            }
        }

        for (const [key, value] of Object.entries(after)) {
            recordDifference(node.atPath([key]), before[key], value);
        }

        return;
    }

    if (Array.isArray(before) && Array.isArray(after) && after.length > before.length && before.every((item, i) => deepEqual(item, after[i]))) {
        for (const item of after.slice(before.length)) {
            node.append(item);
        }

        return;
    }

    node.set(after);
}
