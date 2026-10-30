/**
 * The error classes every plugin throws and every front end recognizes.
 *
 * A front end turns an error into a message and an exit code. Errors are recognized by their
 * `sousErrorKind` as well as by class, so two copies of this package never confuse a front end.
 */

/** The kind of a sous error, one per class. */
export type SousErrorKind =
    | "sous"
    | "config"
    | "input"
    | "non-interactive"
    | "cancelled"
    | "loop"
    | "plugin"
    | "conflict"
    | "not-found"
    | "budget";

/** Options every sous error accepts. */
export interface SousErrorOptions {
    /** The error that caused this one. */
    cause?: unknown;
    /** More lines that explain it or say how to fix it, shown under the message. */
    details?: readonly string[];
    /** The exit code a CLI should use. Default 1. */
    exitCode?: number;
}

/** The base of every error sous and its plugins throw on purpose. */
export class SousError extends Error {
    /** Identifies sous errors across copies of this package. */
    readonly sousErrorKind: SousErrorKind = "sous";
    /** More lines that explain the error or say how to fix it. */
    readonly details: readonly string[];
    /** The exit code a CLI should use. */
    readonly exitCode: number;

    constructor(message: string, options: SousErrorOptions = {}) {
        super(message, options.cause === undefined ? undefined : { cause: options.cause });
        this.name = new.target.name;
        this.details = options.details ?? [];
        this.exitCode = options.exitCode ?? 1;
    }
}

/** The config could not be built, or is not valid. */
export class ConfigError extends SousError {
    override readonly sousErrorKind: SousErrorKind = "config";
}

/** One problem with an intent's input, or a config value: where, and what. */
export interface InputIssue {
    /** Where, as a path string (`ref`, `targets[2].id`); `""` for the value itself. */
    path: string;
    message: string;
}

/** An intent's input did not match its schema. */
export class InputError extends SousError {
    override readonly sousErrorKind: SousErrorKind = "input";
    /** The intent whose input was wrong. */
    readonly intent: string;
    /** Every problem found. */
    readonly issues: readonly InputIssue[];

    constructor(intent: string, issues: readonly InputIssue[], options: SousErrorOptions = {}) {
        super(`The input to "${intent}" is not valid.`, {
            exitCode: 2,
            ...options,
            details: options.details ?? issues.map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message)),
        });
        this.intent = intent;
        this.issues = issues;
    }
}

/**
 * A question could not be asked, because nothing can answer it in this run (L4). The message
 * names the question and the flag or argument that answers it ahead of time.
 */
export class NonInteractiveError extends SousError {
    override readonly sousErrorKind: SousErrorKind = "non-interactive";
    /** The question that could not be asked. */
    readonly question: string;
    /** The flag or argument that answers it, such as `--yes`. */
    readonly answeredBy: string | undefined;

    constructor(question: string, answeredBy: string | undefined, options: SousErrorOptions = {}) {
        const fix = answeredBy ? ` Pass ${answeredBy} to answer it ahead of time.` : "";

        // Exit code 1, as before the refactor: only a command line the CLI could not parse exits 2.
        super(`sous needed to ask "${question}" but cannot ask questions in this run.${fix}`, options);
        this.question = question;
        this.answeredBy = answeredBy;
    }
}

/** A listener cancelled an intent or an event on purpose; `reason` says why. */
export class CancelledError extends SousError {
    override readonly sousErrorKind: SousErrorKind = "cancelled";
    /** What was cancelled: an intent or an event name. */
    readonly target: string;
    /** The reason the listener gave. */
    readonly reason: string;
    /** The plugin whose listener cancelled it. */
    readonly cancelledBy: string | undefined;

    constructor(target: string, reason: string, cancelledBy?: string, options: SousErrorOptions = {}) {
        const by = cancelledBy ? ` (cancelled by ${cancelledBy})` : "";

        super(`"${target}" was cancelled: ${reason}${by}`, options);
        this.target = target;
        this.reason = reason;
        this.cancelledBy = cancelledBy;
    }
}

/** The engine found a loop: the config did not settle, or calls nested past a limit. */
export class LoopError extends SousError {
    override readonly sousErrorKind: SousErrorKind = "loop";
    /** Which limit was passed, as named under the `limits` config key. */
    readonly limit: string;

    constructor(limit: string, message: string, options: SousErrorOptions = {}) {
        super(message, options);
        this.limit = limit;
    }
}

/** A plugin could not be found, loaded or registered, or a plugin it depends on is missing. */
export class PluginError extends SousError {
    override readonly sousErrorKind: SousErrorKind = "plugin";
    /** The plugin, by name or by the specifier it was asked for under. */
    readonly plugin: string;

    constructor(plugin: string, message: string, options: SousErrorOptions = {}) {
        super(message, options);
        this.plugin = plugin;
    }
}

/**
 * Two plugins claim the same thing (a service replacement, an intent, a CLI command) and the
 * config does not pick one. The message names both and the config key that picks one.
 */
export class ConflictError extends SousError {
    override readonly sousErrorKind: SousErrorKind = "conflict";
    /** What is claimed twice. */
    readonly subject: string;
    /** The plugins claiming it. */
    readonly plugins: readonly string[];

    constructor(subject: string, plugins: readonly string[], message: string, options: SousErrorOptions = {}) {
        super(message, options);
        this.subject = subject;
        this.plugins = plugins;
    }
}

/** No plugin provides the intent, service, entity or front end asked for. */
export class NotFoundError extends SousError {
    override readonly sousErrorKind: SousErrorKind = "not-found";
    /** What kind of thing was asked for: `intent`, `service`, `entity`, `front end`. */
    readonly thing: string;
    /** Its name or id. */
    readonly id: string;

    constructor(thing: string, id: string, message?: string, options: SousErrorOptions = {}) {
        super(message ?? `No plugin provides the ${thing} "${id}".`, options);
        this.thing = thing;
        this.id = id;
    }
}

/**
 * Whether a value is a sous error, by class or by its `sousErrorKind` (so a second copy of this
 * package is still recognized).
 */
export function isSousError(value: unknown): value is SousError {
    return (
        value instanceof SousError ||
        (value instanceof Error && typeof (value as { sousErrorKind?: unknown }).sousErrorKind === "string")
    );
}

/** Whether a value is a sous error of one kind. */
export function isSousErrorOfKind(value: unknown, kind: SousErrorKind): value is SousError {
    return isSousError(value) && value.sousErrorKind === kind;
}
