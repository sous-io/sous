import type { Style } from "./style.js";

/**
 * Colors pretty JSON by token (ported from `colorizeJson` in today's `src/lib/config-inspect.ts`):
 * keys cyan, strings green, numbers yellow, `true`, `false` and `null` magenta. It only reads token
 * syntax, so it never changes the structure.
 */
export function colorizeJson(json: string, style: Style): string {
    const tokens = /"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\b(?:true|false|null)\b/g;

    return json.replace(tokens, (match, offset: number, whole: string) => {
        if (match[0] === '"') {
            return /^\s*:/.test(whole.slice(offset + match.length)) ? style.cyan(match) : style.green(match);
        }

        if (match === "true" || match === "false" || match === "null") {
            return style.magenta(match);
        }

        return style.yellow(match);
    });
}

/** A value as pretty JSON (two spaces), colored when the style is. */
export function renderJson(value: unknown, style: Style): string {
    const json = JSON.stringify(value, null, 2) ?? "undefined";

    return style.enabled ? colorizeJson(json, style) : json;
}

/** A value as JSON on one line, cut to `max` characters with an ellipsis. */
export function truncateJson(value: unknown, max = 80): string {
    const encoded = JSON.stringify(value);

    if (encoded === undefined) {
        return "undefined";
    }

    return encoded.length > max ? `${encoded.slice(0, max - 1)}…` : encoded;
}

/** Whether a value is a JSON scalar: a string, number, boolean or `null`. */
export function isScalar(value: unknown): value is string | number | boolean | null {
    return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}
