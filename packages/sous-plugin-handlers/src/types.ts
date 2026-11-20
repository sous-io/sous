/**
 * The contract of sous-plugin-handlers: the `handler` entity kind, what a handler receives, what
 * running a purpose's handlers returns, the intents that run them and the `handlers.system`
 * service. Other plugins import this file type-only.
 *
 * A handler is a function a recipe or a plugin provides for a purpose. A recipe names a file and
 * an exported function in its manifest; a plugin passes the function itself:
 *
 * ```ts
 * sous.handlers.add("check", {
 *     id: "knowledge-worker/commands",
 *     handle: checkCommands,
 * });
 * ```
 */

import type { BuiltConfig, ConfigBuilder, Context, Environment, HandlerPurpose, ProjectInfo } from "@sous-io/sous-plugin-api";
import type { ProcessResult } from "@sous-io/sous-plugin-host/types";

export type { HandlerPurpose } from "@sous-io/sous-plugin-api";

// ---------------------------------------------------------------------------------------------
// The handler entity
// ---------------------------------------------------------------------------------------------

/**
 * A `handler` entity. `sous.handlers.add(purpose, { id, handle })` adds one for a plugin; the
 * `handlers/recipes` contributor adds one for each handler a trusted recipe's manifest lists.
 */
export interface HandlerEntity {
    /** Names it in timings and reports. A recipe's: `voltagrid/knowledge-worker/check/handlers/check.js#checkCommands`. */
    id: string;
    purpose: HandlerPurpose;
    /** The function. Timed by the engine under `entity.method`, as `handler:<id>.handle`. */
    handle: (sous: never, input: never) => unknown;
    /** Lower runs earlier within the purpose. Default `500`. */
    order?: number;
    /** The recipe that lists it (`namespace/recipe`), for a handler from a manifest. */
    recipe?: string;
    /** The plugin that added it with `sous.handlers.add`, for a handler from a plugin. */
    plugin?: string;
    /** Where it came from, for messages: `handlers/prerequisites.js#checkCommands`. */
    source?: string;
}

// ---------------------------------------------------------------------------------------------
// What a handler receives
// ---------------------------------------------------------------------------------------------

/** One thing a handler reported. */
export interface HandlerReportEntry {
    readonly level: "error" | "warn" | "info";
    readonly message: string;
    /** The handler's id. */
    readonly handler: string;
}

/** `sous.report`: what a handler found. The command prints it; a handler never prints. */
export interface HandlerReport {
    /** A problem. From a `check` handler, it fails the build unless failed checks are ignored. */
    error(message: string): void;
    /** Something to fix that does not stop anything. */
    warn(message: string): void;
    /** Something worth knowing. */
    info(message: string): void;
}

/** What `sous.utils.process.run` gives back. */
export type HandlerProcessResult = ProcessResult;

/** The helpers under `sous.utils`. Paths are relative to the project's folder. */
export interface HandlerUtils {
    readonly system: {
        /** Whether a command is installed: found on `PATH` (with `PATHEXT` on Windows). Answered once per run. */
        isAppAvailable(name: string): Promise<boolean>;
        /** The version a command prints for `--version`, when one can be read. Answered once per run. */
        appVersion(name: string): Promise<string | undefined>;
    };
    readonly process: {
        /** Runs a command in the project's folder and gives its exit code and output. A missing command exits 127. */
        run(command: string, args?: readonly string[], options?: { cwd?: string; input?: string; timeoutMs?: number }): Promise<HandlerProcessResult>;
    };
    /** ONE file. */
    readonly file: {
        exists(path: string): Promise<boolean>;
        /** Its text, or `undefined` when there is no such file. */
        read(path: string): Promise<string | undefined>;
        /** Removes it. True when there was one. */
        remove(path: string): Promise<boolean>;
    };
    /** Many files. */
    readonly files: {
        /** Removes every file matching a glob pattern (dot files included); gives the paths removed. */
        removeMatching(pattern: string): Promise<string[]>;
    };
}

/** The helpers every handler receives, whatever its purpose. */
export interface HandlerHelpers {
    readonly report: HandlerReport;
    readonly utils: HandlerUtils;
    readonly editor: {
        /**
         * Edits a document directly, with the same operations as a declared edit. Needs the `editor`
         * service of `@sous-io/sous-plugin-editor`; without it, this throws an error saying so.
         */
        file(path: string): unknown;
    };
    readonly vars: {
        /** A recipe variable's answer: for a recipe's handler, as that recipe sees it. */
        get(name: string): string | undefined;
    };
    readonly project: ProjectInfo;
    readonly config: { get<T = unknown>(path: string): T | undefined };
    readonly env: Environment;
}

/**
 * What a handler receives as `sous`: the full context a plugin receives (every service, the
 * finished config, the project's folder, the reporter, `run`) plus the helpers.
 *
 * A `configure` handler runs while the config is built, so it receives the helpers alone: there is
 * no finished config yet, `sous.config.get` reads the config built so far, and services are not
 * available. It also receives the config builder.
 */
export interface HandlerTools extends Omit<Context, "config" | "project">, HandlerHelpers {
    readonly config: BuiltConfig;
    readonly project: ProjectInfo;
}

/** The second argument of each purpose's handlers. */
export interface HandlerInputs {
    check: undefined;
    /** The builder of the config being built, as a contributor gets it. */
    configure: { readonly config: ConfigBuilder };
    beforeBuild: undefined;
    afterBuild: undefined;
    uninstall: undefined;
    /** The versions the recipe moved between. */
    migrate: { readonly from: string; readonly to: string };
}

// ---------------------------------------------------------------------------------------------
// Running a purpose
// ---------------------------------------------------------------------------------------------

/** How to run a purpose's handlers. */
export interface RunHandlersOptions {
    /** `check` only: report errors as warnings, so they fail nothing. Default `false`. */
    ignoreFailedChecks?: boolean;
    /** Only the handlers of these recipes (`namespace/recipe`); plugins' handlers are left out. */
    recipes?: readonly string[];
    /** The second argument each handler receives (`migrate`: `{ from, to }`). */
    input?: unknown;
}

/** One handler that ran. */
export interface HandlerRun {
    readonly id: string;
    /** The plugin that added it (for a recipe's handler, sous-plugin-handlers). */
    readonly plugin: string;
    readonly recipe?: string;
    /** Who reported, as each printed line starts: `workflow/github-projects (check: hasGh)`. */
    readonly label: string;
    readonly reports: readonly HandlerReportEntry[];
    /** Set when it threw; its message is also reported as an error. */
    readonly threw?: string;
}

/** What running one purpose's handlers did. */
export interface HandlerRunResult {
    readonly purpose: HandlerPurpose;
    /** In run order. */
    readonly ran: readonly HandlerRun[];
    /** Errors reported (a handler that threw counts as one), before `ignoreFailedChecks`. */
    readonly errors: number;
    readonly warnings: number;
    /** Errors that were reported as warnings because failed checks are ignored. */
    readonly ignoredErrors: number;
    /** An error was reported and not ignored. For `check`, the build must stop. */
    readonly failed: boolean;
}

/** The input of `handlers.check`, `handlers.beforeBuild`, `handlers.afterBuild` and `handlers.uninstall`. */
export interface HandlersIntentInput {
    /** Only the handlers of these recipes. */
    recipes?: string[];
    /** `handlers.check` only. */
    ignoreFailedChecks?: boolean;
}

/** The input of `handlers.migrate`. */
export interface HandlersMigrateInput {
    /** The recipe that moved: `namespace/recipe`. */
    recipe: string;
    from: string;
    to: string;
}

// ---------------------------------------------------------------------------------------------
// recipes.handlers (config) and handlers.system (service)
// ---------------------------------------------------------------------------------------------

/** One entry of `recipes.handlers`: a handler a recipe's manifest lists, as config. */
export interface RecipeHandlerDeclaration {
    /** `namespace/recipe`. */
    recipe: string;
    purpose: HandlerPurpose;
    /** Relative to the recipe. */
    file: string;
    /** The exported function. */
    handler: string;
}

/** `handlers.system`: what is installed on this machine, each answer kept for the run. */
export interface HandlersSystem {
    isAppAvailable(name: string): Promise<boolean>;
    appVersion(name: string): Promise<string | undefined>;
}

declare module "@sous-io/sous-plugin-api" {
    interface SousHandlerTypes {
        tools: HandlerTools;
        inputs: HandlerInputs;
    }

    interface SousEntities {
        /** A function a recipe or plugin provides for a purpose. */
        handler: HandlerEntity;
    }

    interface SousServices {
        "handlers.system": HandlersSystem;
    }

    interface SousConfig {
        "recipes.handlers": RecipeHandlerDeclaration[];
    }

    interface SousIntents {
        "handlers.check": { input: HandlersIntentInput; result: HandlerRunResult };
        "handlers.beforeBuild": { input: HandlersIntentInput; result: HandlerRunResult };
        "handlers.afterBuild": { input: HandlersIntentInput; result: HandlerRunResult };
        "handlers.uninstall": { input: HandlersIntentInput; result: HandlerRunResult };
        "handlers.migrate": { input: HandlersMigrateInput; result: HandlerRunResult };
    }
}
