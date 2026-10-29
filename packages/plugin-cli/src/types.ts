import type { SousSchema } from "@sous-io/plugin-api";
import type { CommandTree } from "./command-tree.js";

/**
 * An argument every command accepts, such as `--debug` (S1, "What an intent declares for the CLI
 * and for agents"). Any plugin can add one; its value reaches every handler as `ctx.globals[id]`.
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

/** Whether this run may ask questions (S6, `cli.interactivity`). */
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

/** Turning errors into messages and exit codes (S6, `cli.errors`). */
export interface CliErrors {
    view(error: unknown, options?: { debug?: boolean }): CliErrorView;
}

declare module "@sous-io/plugin-api" {
    interface SousEntities {
        "cli-global-argument": CliGlobalArgumentEntity;
        "cli-group": CliGroupEntity;
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
