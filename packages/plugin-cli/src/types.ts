import type { ProjectInfo, Reporter, SousSchema } from "@sous-io/plugin-api";
import type { CommandTree } from "./command-tree.js";

/**
 * An argument every command accepts, such as `--debug`. Any plugin can add one; its value reaches every handler as `ctx.globals[id]`.
 *
 * ```ts
 * sous.entities.add("cli-global-argument", {
 *     id: "verbose",
 *     schema: jsonSchema({ type: "boolean", default: false }),
 *     description: "Print more detail",
 * });
 * ```
 */
export interface CliGlobalArgumentEntity {
    /** The flag name without dashes, in kebab case: `log-level` is `--log-level`. */
    id: string;
    /** The value's schema; its JSON Schema type decides how it is parsed. */
    schema: SousSchema;
    /** One sentence for `--help`. */
    description: string;
    /** A one-letter short form, without the dash. */
    short?: string;
    /** The value's name in help: `--log-level <level>`. Default: `value`. */
    valueName?: string;
    /** Keeps it out of `--help`. */
    hidden?: boolean;
}

/**
 * The help of a command group (`sous repo --help`). Any plugin can add one for any group.
 *
 * ```ts
 * sous.entities.add("cli-group", { id: "repo add", command: ["repo", "add"], summary: "Add a recipe repository" });
 * ```
 */
export interface CliGroupEntity {
    id: string;
    /** The group's command words. */
    command: readonly string[];
    /** One sentence for the parent's command list. */
    summary: string;
    /** More, for the group's own `--help`. */
    description?: string;
    /** Keeps the group out of its parent's help. */
    hidden?: boolean;
    /**
     * Other words for the whole group (`repos` for `repo`). Each one runs the same commands and shows
     * the same help, and stays out of the parent's help.
     */
    aliases?: ReadonlyArray<readonly string[]>;
}

/** Whether this run may ask questions. */
export interface CliInteractivity {
    /**
     * True when standard input and output are terminals, no CI variable is set and
     * `--non-interactive` was not passed (about-cli-command-design, "Never prompt without a terminal").
     */
    canPrompt(globals?: Readonly<Record<string, unknown>>): boolean;
}

/** An error as the CLI shows it. */
export interface CliErrorView {
    /** Lines for standard error, the first starting `Error: `. */
    readonly lines: readonly string[];
    readonly exitCode: number;
}

/** Turning errors into messages and exit codes. */
export interface CliErrors {
    view(error: unknown, options?: { debug?: boolean }): CliErrorView;
}

/** What a view is given besides the result. */
export interface CliViewContext {
    /** The intent whose result it shows. */
    readonly intent: string;
    /** The input the command line gave (before defaults). */
    readonly input: Readonly<Record<string, unknown>>;
    /** The global arguments' values. */
    readonly globals: Readonly<Record<string, unknown>>;
    /**
     * Where the view shows the result: the run's reporter. A view says what each entry is
     * (`reporter.table(...)`, `reporter.variables(...)`, `reporter.operationStart(...)`), and the
     * reporter decides how it looks and which stream it goes to.
     */
    readonly reporter: Reporter;
    /**
     * Shows another intent's result through that intent's view (or as data when it has none), for a
     * result that holds another's: `build` holds what `build.prepare` returned.
     */
    show(intent: string, result: unknown, input?: Readonly<Record<string, unknown>>): Promise<void>;
    /**
     * The project the command ran on (its root, `.sous/` directory and config file), for views that
     * name them, such as the "Command Variables" block; `undefined` outside a project.
     */
    readonly project?: ProjectInfo;
    /** The project's name, as its config's `name` gives it. */
    readonly projectName?: string;
    /** The directory the command was run from. */
    readonly cwd?: string;
}

/** What a view returns: nothing, or the exit code (a failed build shows its report and exits 1). */
export type CliViewOutput = undefined | void | { exitCode?: number };

/**
 * How the CLI shows one intent's result. The id is the intent's name. Any
 * plugin may add one, for its own intent or to replace another's view: the later one wins. An intent
 * with no view shows its result as data, and `--json` always prints it as JSON.
 *
 * ```ts
 * sous.entities.add("cli-view", {
 *     id: "diagrams.render",
 *     render: (result: { written: string[] }, view) => {
 *         view.reporter.operationStart("Rendering diagrams");
 *
 *         for (const file of result.written) {
 *             view.reporter.operation("written", file);
 *         }
 *     },
 * });
 * ```
 */
export interface CliViewEntity {
    /** The intent whose result it shows. */
    id: string;
    /** Turns the result into text. It may throw: a `config get` of a missing path is an error. */
    render(result: any, view: CliViewContext): CliViewOutput | Promise<CliViewOutput>;
}

declare module "@sous-io/plugin-api" {
    interface SousEntities {
        "cli-global-argument": CliGlobalArgumentEntity;
        "cli-group": CliGroupEntity;
        "cli-view": CliViewEntity;
    }

    interface SousServices {
        "cli.commands": CommandTree;
        "cli.interactivity": CliInteractivity;
        "cli.errors": CliErrors;
    }

    interface SousIntents {
        help: { input: { command?: string[] }; result: string };
        version: { input: { verbose?: boolean }; result: string | { name: string; version: string } };
    }
}
