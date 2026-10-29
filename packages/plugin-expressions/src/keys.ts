/**
 * S5's reserved keys: the exact list that makes an object an expression object, and the order a
 * chain's keys are tried in.
 */

/** What a reserved key says. */
export type ReservedKey =
    /** `$expr`, or `$expr:<language>` (`language` is `""` for `"$expr:"`, an error later). */
    | { readonly kind: "expr"; readonly key: string; readonly language: string | undefined }
    /** `$if` / `$elseif`, or with `:<name>` (`name` is `""` for `"$if:"`, an error later). */
    | { readonly kind: "if" | "elseif"; readonly key: string; readonly name: string | undefined }
    /** `$else`. */
    | { readonly kind: "else"; readonly key: string };

const QUALIFIED = /^\$(expr|if|elseif)(?::(.*))?$/s;

/** What a key means, or `undefined` when it is not one of S5's reserved keys (`$schema`, `$iff`). */
export function parseReservedKey(key: string): ReservedKey | undefined {
    if (key === "$else") {
        return { kind: "else", key };
    }

    const match = QUALIFIED.exec(key);

    if (!match) {
        return undefined;
    }

    const kind = match[1] as "expr" | "if" | "elseif";
    const qualifier = match[2];

    return kind === "expr" ? { kind, key, language: qualifier } : { kind, key, name: qualifier };
}

/** Whether a key is one of S5's reserved keys. */
export function isReservedKey(key: string): boolean {
    return parseReservedKey(key) !== undefined;
}

/** Whether a value is a plain JSON object (not an array, not null). */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether a value is an expression object: an object holding at least one reserved key. */
export function isExpressionObject(value: unknown): boolean {
    return isPlainObject(value) && Object.keys(value).some(isReservedKey);
}

/** Whether a value holds an expression object at any depth, itself included. */
export function hasExpressions(value: unknown): boolean {
    if (Array.isArray(value)) {
        return value.some(hasExpressions);
    }

    if (!isPlainObject(value)) {
        return false;
    }

    return isExpressionObject(value) || Object.values(value).some(hasExpressions);
}

/** A bytewise comparison of two strings (UTF-8), the sort `conf.d/` uses, the same in every locale. */
export function compareBytes(a: string, b: string): number {
    return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/**
 * Sorts `$if` or `$elseif` keys into chain order: the unqualified key first, then every qualified
 * one by bytewise name order.
 */
export function chainOrder<T extends { readonly name: string | undefined }>(keys: readonly T[]): T[] {
    return [...keys].sort((a, b) => {
        if (a.name === undefined || b.name === undefined) {
            return a.name === b.name ? 0 : a.name === undefined ? -1 : 1;
        }

        return compareBytes(a.name, b.name);
    });
}
