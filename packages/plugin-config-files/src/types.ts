/**
 * The contract of plugin-config-files: `sous.config.*` as a
 * contributor (`config-files.main`), reading one config file in-process, patch files beside it,
 * setting one value from the command line, and the `.env` files.
 *
 * Other plugins import this file type-only.
 */

import type { ConfigBuilder, Environment, JsonValue, Patch, PatchSet } from "@sous-io/plugin-api";

// ---------------------------------------------------------------------------------------------
// config-files.loader
// ---------------------------------------------------------------------------------------------

/** The formats a config file may be written in. */
export type ConfigFileFormat = "json" | "jsonc" | "yaml" | "js" | "ts" | "patch-json" | "patch-jsonl";

/** The names `sous.config.*` is found under, in the order they are tried. */
export type MainConfigFileName =
    | "sous.config.ts"
    | "sous.config.js"
    | "sous.config.mjs"
    | "sous.config.jsonc"
    | "sous.config.json"
    | "sous.config.yaml"
    | "sous.config.yml";

/** A `.js` or `.ts` config file's export: given the builder, like any contributor. */
export type ConfigureFunction = (config: ConfigBuilder) => void | Promise<void>;

/** A data file: parsed JSON, JSONC or YAML. */
export interface DataConfigFile {
    readonly kind: "data";
    readonly path: string;
    readonly format: "json" | "jsonc" | "yaml";
    /** The parsed data, expressions still in it. */
    readonly data: JsonValue;
    /** The text as written, for `config show --raw`. */
    readonly text: string;
}

/** A module file: imported in-process, exporting `configure(config)`. */
export interface ModuleConfigFile {
    readonly kind: "module";
    readonly path: string;
    readonly format: "js" | "ts";
    readonly configure: ConfigureFunction;
    readonly text: string;
}

/** A patch file: raw patches, applied with `config.apply`. */
export interface PatchConfigFile {
    readonly kind: "patch";
    readonly path: string;
    readonly format: "patch-json" | "patch-jsonl";
    readonly patches: ReadonlyArray<Patch | PatchSet>;
    readonly text: string;
}

/** One config file, read. */
export type LoadedConfigFile = DataConfigFile | ModuleConfigFile | PatchConfigFile;

/** Reading one config file. Each file is read from disk once per build. */
export interface ConfigFilesLoader {
    /** The format a file name means, or `undefined` for a file sous does not read. */
    formatOf(fileName: string): ConfigFileFormat | undefined;
    /** Reads one file. A `.js` file changed on disk is imported again under a new URL. */
    load(path: string): Promise<LoadedConfigFile>;
    /** The `sous.config.*` file in a `.sous/` directory, or `undefined`. */
    findMain(sousDir: string): string | undefined;
    /** The patch files beside a config file (`sous.config.patch.json`, `.patch.jsonl`), bytewise. */
    findPatches(directory: string, baseName?: string): string[];
    /** Forgets what was read, so the next build reads every file again (watch mode). */
    forget(path?: string): void;
    /**
     * Applies one file through a builder, the one way every config file is applied: data is
     * evaluated and merged at the root, a module's `configure` runs, a patch file's patches are
     * applied. Errors name the file. (Added beside the contract names, so `plugin-confd` applies
     * its files the same way without importing this plugin's code.)
     */
    contribute(file: LoadedConfigFile, config: ConfigBuilder, options?: ContributeOptions): Promise<void>;
    /** A file's name for messages: relative to `.sous/` when it lies inside it (`conf.d/610-mac.jsonc`). */
    label(path: string): string;
}

/** Options for applying one file. */
export interface ContributeOptions {
    /** The file's name in messages. Default: its path relative to `.sous/`. */
    label?: string;
    /** True for a recipe's config file: expression languages that run code are refused. */
    fromRecipe?: boolean;
}

// ---------------------------------------------------------------------------------------------
// config-files.env
// ---------------------------------------------------------------------------------------------

/** Which env file: `shared` is `.sous/.env`, `local` the gitignored `.sous/.env.local`. */
export type EnvFileKind = "shared" | "local";

/** The env files' paths. */
export interface EnvFilePaths {
    readonly shared: string;
    readonly local: string;
}

/** What the env files hold. */
export interface EnvFileValues {
    readonly shared: Readonly<Record<string, string>>;
    readonly local: Readonly<Record<string, string>>;
    /** The process environment, then `.env`, then `.env.local`; the process wins (it was set on purpose). */
    readonly merged: Environment;
}

/** What writing an env file did. */
export interface EnvFileChange {
    readonly file: string;
    readonly changed: boolean;
    /** Names set or changed. */
    readonly set: readonly string[];
    /** Names removed. */
    readonly removed: readonly string[];
}

/** Options for writing an env file. */
export interface EnvFileWriteOptions {
    dryRun?: boolean;
    /** A comment written above new entries. */
    comment?: string;
}

/** Reading and writing `.sous/.env` and `.sous/.env.local`; one parser for both. */
export interface ConfigFilesEnv {
    /** The paths, for the project (or `undefined` outside one). */
    paths(): EnvFilePaths | undefined;
    /** What the files hold, with the process environment. */
    read(): Promise<EnvFileValues>;
    /** The same, blocking (the engine's environment is built from it). */
    readSync(): EnvFileValues;
    /** Sets values in one file, surgically: other lines and comments stay; `undefined` removes a name. */
    write(kind: EnvFileKind, entries: Readonly<Record<string, string | undefined>>, options?: EnvFileWriteOptions): Promise<EnvFileChange>;
    /** Parses env file text. */
    parse(text: string): Record<string, string>;
}

// ---------------------------------------------------------------------------------------------
// The config.set intent
// ---------------------------------------------------------------------------------------------

/** The input of `config.set`: one value written into a config file, surgically. */
export interface ConfigSetInput {
    /** The key path: `compilation.includeSourceComments`, `subscriptions."workflow/x".enabled`. */
    path: string;
    /** The value, parsed as JSON when it is valid JSON, else kept as a string. */
    value?: string;
    /** Removes the key instead. */
    unset?: boolean;
    /** The file to write: a path, or a `conf.d` file name. Default: `sous.config.*`. */
    file?: string;
    /** Shows what would change, writing nothing. */
    dryRun?: boolean;
}

/** The result of `config.set`. */
export interface ConfigSetResult {
    readonly file: string;
    readonly path: string;
    readonly previous: JsonValue | undefined;
    readonly value: JsonValue | undefined;
    readonly changed: boolean;
    readonly dryRun: boolean;
}

/** The top-level keys plugin-config-files owns. */
export interface ConfigFilesKeys {
    /** The JSON Schema the file declares, for editors. */
    $schema?: string;
    /** The config format version: `1`. */
    version?: 1;
    /** A display name for the project. */
    name?: string;
}

declare module "@sous-io/plugin-api" {
    interface SousServices {
        /** Reading one config file. */
        "config-files.loader": ConfigFilesLoader;
        /** The `.env` files. */
        "config-files.env": ConfigFilesEnv;
    }

    interface SousIntents {
        /** Sets one value in a config file. */
        "config.set": { input: ConfigSetInput; result: ConfigSetResult };
    }

    interface SousConfig {
        $schema: string;
        version: 1;
        name: string;
    }
}
