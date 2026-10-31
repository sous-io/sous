/**
 * `config-files.loader`: reading one config file in-process, and applying
 * it through a builder. `.json`, `.jsonc` and `.yaml` files are parsed; `.js` and `.ts` files are
 * imported; `.patch.json` and `.patch.jsonl` files hold raw patches.
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isJsonObject, parseDocument, parsePatchFile } from "@sous-io/documents";
import {
    type ConfigBuilder,
    ConfigError,
    isSousError,
    type JsonObject,
    type JsonValue,
    type Patch,
    type ProjectInfo,
} from "@sous-io/plugin-api";
import type { ExpressionsEvaluator } from "@sous-io/plugin-expressions/types";
import type { HostGlobs } from "@sous-io/plugin-host/types";
import { type LegacyRunner, mergeLegacy, moduleConfigure, moduleExports } from "./module-file.js";
import { formatOf, MAIN_CONFIG_BASE_NAME, MAIN_CONFIG_FILE_NAMES } from "./names.js";
import type { ConfigFileFormat, ConfigFilesLoader, ContributeOptions, LoadedConfigFile } from "./types.js";

/** What the loader needs from the engine; each is looked up when used. */
export interface LoaderHost {
    /** The project, for file labels and the old builder's directories. */
    readonly project: ProjectInfo | undefined;
    /** Bytewise order and glob matching. */
    globs(): HostGlobs;
    /** The expression evaluator, when a plugin provides one. */
    evaluator(): ExpressionsEvaluator | undefined;
    /** Values the old builder's paths may use: `${sousDir}`, `${sousConfDir}`, `${sousRootPath}`, `${sousVersion}`. */
    pathVariables(): Readonly<Record<string, string>>;
    /** Imports a module by URL. Default: `import()` (Node strips TypeScript types itself). */
    importModule?(url: string, path: string): Promise<Record<string, unknown>>;
}

/** How a module file was imported last: what it looked like, and the URL version used. */
interface ModuleStamp {
    stamp: string;
    version: number;
}

/** Reads and applies config files. One per process (singleton): each file is read once per build. */
export class ConfigFilesLoaderImpl implements ConfigFilesLoader {
    private readonly cache = new Map<string, LoadedConfigFile>();
    private readonly stamps = new Map<string, ModuleStamp>();

    constructor(private readonly host: LoaderHost) {}

    formatOf(fileName: string): ConfigFileFormat | undefined {
        return formatOf(fileName);
    }

    findMain(sousDir: string): string | undefined {
        return mainCandidates(sousDir)[0];
    }

    findPatches(directory: string, baseName: string = MAIN_CONFIG_BASE_NAME): string[] {
        let names: string[];

        try {
            names = fs.readdirSync(directory);
        } catch {
            return [];
        }

        const matches = names.filter((name) => {
            const format = formatOf(name);

            return (
                (format === "patch-json" || format === "patch-jsonl")
                && name.startsWith(`${baseName}.`)
                && isFile(path.join(directory, name))
            );
        });

        return this.host.globs().sortBytewise(matches).map((name) => path.join(directory, name));
    }

    forget(file?: string): void {
        if (file === undefined) {
            this.cache.clear();
        } else {
            this.cache.delete(path.resolve(file));
        }
    }

    async load(file: string): Promise<LoadedConfigFile> {
        const resolved = path.resolve(file);
        const cached = this.cache.get(resolved);

        if (cached !== undefined) {
            return cached;
        }

        const loaded = await this.read(resolved);

        this.cache.set(resolved, loaded);

        return loaded;
    }

    async contribute(file: LoadedConfigFile, config: ConfigBuilder, options: ContributeOptions = {}): Promise<void> {
        const label = options.label ?? this.label(file.path);

        try {
            switch (file.kind) {
                case "data":
                    this.mergeData(config, file.data, label, options.fromRecipe === true);
                    break;
                case "patch":
                    config.apply(file.patches as readonly Patch[]);
                    break;
                case "module":
                    await file.configure(config);
                    break;
            }
        } catch (error) {
            throw namingFile(error, label, file.path);
        }
    }

    /** A file's name for messages: relative to `.sous/` when it lies inside it. */
    label(file: string): string {
        const sousDir = this.host.project?.sousDir;

        if (sousDir !== undefined) {
            const relative = path.relative(sousDir, file);

            if (relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)) {
                return relative.split(path.sep).join("/");
            }
        }

        return file;
    }

    /** Applies data as one merge at the root, its expressions evaluated first. */
    mergeData(config: ConfigBuilder, data: unknown, label: string, fromRecipe = false): void {
        const evaluated = this.evaluate(config, data as JsonValue, label, fromRecipe);

        if (evaluated === undefined || evaluated === null) {
            return;
        }

        if (!isJsonObject(evaluated)) {
            throw new ConfigError(`${label} did not produce a plain object (got ${Array.isArray(evaluated) ? "an array" : typeof evaluated}).`);
        }

        assertNotOldSchema(evaluated, label);
        config.root().merge(evaluated);
    }

    private evaluate(config: ConfigBuilder, data: JsonValue, label: string, fromRecipe: boolean): JsonValue | undefined {
        const evaluator = this.host.evaluator();

        if (evaluator === undefined || !evaluator.hasExpressions(data)) {
            return data;
        }

        return evaluator.evaluateLayer(data, { file: label, config, ownVars: ownVars(data), fromRecipe }).value;
    }

    private async read(file: string): Promise<LoadedConfigFile> {
        const label = this.label(file);
        const format = formatOf(path.basename(file));

        if (format === undefined) {
            throw new ConfigError(`${label} is not a kind of file sous reads as config.`, {
                details: ["Config files end in .json, .jsonc, .yaml, .yml, .js, .mjs, .ts, .patch.json or .patch.jsonl."],
            });
        }

        let text: string;

        try {
            text = fs.readFileSync(file, "utf8");
        } catch (error) {
            throw new ConfigError(`Could not read the config file ${label}.`, { cause: error, details: [(error as Error).message] });
        }

        try {
            switch (format) {
                case "json":
                case "jsonc":
                case "yaml": {
                    const data = parseDocument(text, format).value() ?? {};

                    return { kind: "data", path: file, format, data, text };
                }
                case "patch-json":
                case "patch-jsonl": {
                    const set = parsePatchFile(text, format === "patch-json" ? "json" : "jsonl", label);

                    return { kind: "patch", path: file, format, patches: set.patches, text };
                }
                case "js":
                case "ts": {
                    const exports = moduleExports(await this.importFile(file, format), label);
                    const configure = moduleConfigure(exports, {
                        label,
                        path: file,
                        sousDir: this.host.project?.sousDir,
                        confDir: this.host.project?.confDir,
                        mergeData: (config, data) => this.mergeData(config, data, label),
                        loadInto: (draft, specifier, glob, run) => this.loadInto(draft, specifier, glob, run, file),
                    });

                    return { kind: "module", path: file, format, configure, text };
                }
            }
        } catch (error) {
            throw namingFile(error, label, file);
        }
    }

    /**
     * Imports a module file. Node keeps every module it imports, so a file changed on disk is
     * imported again under a new URL; the old copy stays in memory.
     */
    private async importFile(file: string, format: "js" | "ts"): Promise<Record<string, unknown>> {
        const stat = fs.statSync(file);
        const stamp = `${stat.mtimeMs}:${stat.size}`;
        const previous = this.stamps.get(file);
        const version = previous === undefined ? 0 : previous.stamp === stamp ? previous.version : previous.version + 1;

        this.stamps.set(file, { stamp, version });

        const base = pathToFileURL(file).href;
        const url = version === 0 ? base : `${base}?sous-reload=${version}`;

        if (this.host.importModule !== undefined) {
            return this.host.importModule(url, file);
        }

        try {
            return (await import(url)) as Record<string, unknown>;
        } catch (error) {
            // Node strips TypeScript's types itself (22.18 and later); sous ships no TypeScript compiler.
            if (format === "ts" && needsTypeStripping(error)) {
                throw new ConfigError(`${this.label(file)} is TypeScript that this Node.js (${process.version}) cannot run.`, {
                    details: [
                        "Node 22.18 or later runs TypeScript whose types can simply be removed; enums, namespaces and parameter properties need a compiler.",
                        "Use a newer Node, write the config without those, or write it as sous.config.js.",
                    ],
                });
            }

            throw error;
        }
    }

    /** The old builder's `loadConfig()` and `loadConfigs()`: files merged into the copy of the config. */
    private async loadInto(draft: JsonObject, specifier: string, glob: boolean, run: LegacyRunner, from: string): Promise<void> {
        const where = `${glob ? "loadConfigs" : "loadConfig"}(${JSON.stringify(specifier)}) in ${this.label(from)}`;
        const variables = this.host.pathVariables();
        const substituted = String(specifier).replace(/\$\{([^}]+)\}/g, (_match, name: string) => {
            const value = variables[name];

            if (value === undefined) {
                throw new ConfigError(`${where}: \${${name}} cannot be used in a builder path.`, {
                    details: [
                        "Builder paths are read before variables are resolved, so only these can be used:",
                        Object.keys(variables).map((key) => `\${${key}}`).join(", "),
                    ],
                });
            }

            return value;
        });
        const resolved = path.isAbsolute(substituted) ? path.normalize(substituted) : path.resolve(path.dirname(from), substituted);
        const files = glob ? this.matchFiles(resolved) : [resolved];

        for (const file of files) {
            if (!isFile(file)) {
                throw new ConfigError(`${where}: no config file at ${file}.`);
            }

            const loaded = await this.load(file);

            switch (loaded.kind) {
                case "data":
                    mergeLegacy(draft, loaded.data, this.label(file));
                    break;
                case "module": {
                    const exports = moduleExports(await this.importFile(file, loaded.format), this.label(file));

                    await run(exports, file);
                    break;
                }
                case "patch":
                    throw new ConfigError(`${where}: ${this.label(file)} is a patch file; list it in conf.d instead.`);
            }
        }
    }

    /** The files an absolute glob matches, bytewise. */
    private matchFiles(pattern: string): string[] {
        const globs = this.host.globs();
        const posix = globs.toPosix(pattern);
        const base = globs.staticBase(posix);

        return globs.matchSync(path.posix.relative(base, posix), { cwd: base, absolute: true });
    }
}

/** Every `sous.config.*` file in a `.sous/` directory, in the order they are tried. */
export function mainCandidates(sousDir: string): string[] {
    return MAIN_CONFIG_FILE_NAMES.map((name) => path.join(sousDir, name)).filter(isFile);
}

/** The plain string `_vars` of a file's root, which its own expressions also see. */
function ownVars(data: JsonValue): Record<string, string> | undefined {
    if (!isJsonObject(data) || !isJsonObject(data._vars)) {
        return undefined;
    }

    const result: Record<string, string> = {};

    for (const [key, value] of Object.entries(data._vars)) {
        if (typeof value === "string") {
            result[key] = value;
        }
    }

    return result;
}

/** Rejects the removed multi-project schema, naming the file that still uses it. */
function assertNotOldSchema(data: JsonObject, label: string): void {
    if ("projects" in data || "defaultProject" in data) {
        throw new ConfigError(`${label} uses the removed multi-project schema ('projects' / 'defaultProject').`, {
            details: [
                "A sous config now describes exactly one project. To migrate:",
                "  1. Move your single project's fields (name, _vars, _aliases, compilation,",
                "     runtimeContext, tools) to the top level of the config.",
                "  2. Delete the 'projects' and 'defaultProject' keys.",
                "A config with several projects must be split into one config per project.",
            ],
        });
    }
}

/** An error that names the config file it came from. */
function namingFile(error: unknown, label: string, file: string): unknown {
    const message = error instanceof Error ? error.message : String(error);

    if (message.includes(label) || message.includes(file)) {
        return error;
    }

    if (isSousError(error)) {
        return new ConfigError(`${label}: ${message}`, { cause: error, details: error.details });
    }

    return new ConfigError(`${label} failed to load: ${message}`, { cause: error });
}

/** Whether an import failed because Node could not run a TypeScript file as it is. */
function needsTypeStripping(error: unknown): boolean {
    const code = (error as { code?: unknown } | undefined)?.code;

    return (
        code === "ERR_UNKNOWN_FILE_EXTENSION"
        || code === "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX"
        || code === "ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING"
        || code === "ERR_INVALID_TYPESCRIPT_SYNTAX"
        || (error instanceof SyntaxError && /typescript|type annotation|Unexpected token/i.test(error.message))
    );
}

function isFile(file: string): boolean {
    try {
        return fs.statSync(file).isFile();
    } catch {
        return false;
    }
}
