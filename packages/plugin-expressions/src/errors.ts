import { ConfigError, formatIssuePath, type PathSegment, type SousErrorOptions } from "@sous-io/plugin-api";

/** A key path as errors print it: `subscriptions."x/y".enabled`, or `(root)`. */
export function formatPath(path: readonly PathSegment[]): string {
    return path.length === 0 ? "(root)" : formatIssuePath(path);
}

/**
 * A config expression that fails the load (S5, "Errors"): a `ConfigError` naming the key path in
 * its message and the file in its first detail line.
 */
export class ExpressionError extends ConfigError {
    /** The file the expression came from. */
    readonly file: string;
    /** The key path, as printed. */
    readonly path: string;

    constructor(file: string, path: readonly PathSegment[] | string, problem: string, options: SousErrorOptions = {}) {
        const printed = typeof path === "string" ? path : formatPath(path);

        super(`${printed} ${problem}`, { ...options, details: [`in ${file}`, ...(options.details ?? [])] });
        this.file = file;
        this.path = printed;
    }
}
