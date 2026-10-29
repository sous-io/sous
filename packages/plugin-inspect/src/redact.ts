/**
 * Hiding secrets (G4): everything about the config can be inspected except the values of secrets.
 * A key is taken as a secret by its name.
 */

import type { JsonObject, JsonValue, Patch } from "@sous-io/plugin-api";
import type { ConfigLayer } from "@sous-io/plugin-api";

/** What stands in for a secret's value. */
export const HIDDEN = "(hidden)";

const SECRET_KEY = /(pass(word|wd|phrase)?|secret|token|api[-_]?key|private[-_]?key|credential|authorization|bearer)/i;

/** Whether a key names a secret. */
export function isSecretKey(key: string): boolean {
    return SECRET_KEY.test(key);
}

/** A copy of a value with the value of every secret key hidden. */
export function redactValue<T extends JsonValue>(value: T): T {
    if (Array.isArray(value)) {
        return value.map((item) => redactValue(item)) as T;
    }

    if (value !== null && typeof value === "object") {
        const out: JsonObject = {};

        for (const [key, inner] of Object.entries(value as JsonObject)) {
            out[key] = isSecretKey(key) && inner !== null && inner !== "" ? HIDDEN : redactValue(inner);
        }

        return out as T;
    }

    return value;
}

/** Whether any segment of a path string names a secret. */
function pathHasSecret(path: string): boolean {
    return path.split(/[.[\]"]+/).some((segment) => segment !== "" && isSecretKey(segment));
}

/** A copy of a patch with a secret's value hidden. */
export function redactPatch(patch: Patch): Patch {
    if (patch.op === "setKey") {
        const secret = isSecretKey(patch.key) || pathHasSecret(patch.path);

        return { ...patch, value: secret ? HIDDEN : redactValue(patch.value) };
    }

    if (patch.op === "setIndex" || patch.op === "insertAt") {
        return { ...patch, value: pathHasSecret(patch.path) ? HIDDEN : redactValue(patch.value) };
    }

    return patch;
}

/** A copy of a layer with its patch redacted. */
export function redactLayer<L extends ConfigLayer>(layer: L): L {
    return { ...layer, patch: redactPatch(layer.patch) };
}

/** A key, its separator, and a simple value (quoted, or a bare word). Blocks are never matched. */
const KEY_VALUE = /(["']?)([\w$.-]+)\1(\s*[:=]\s*)("(?:\\.|[^"\\])*"|'[^']*'|[^\s,{}[\]#]+)/g;

/** Config file text with the value after a secret key hidden (best effort: JSON, YAML, TOML-like). */
export function redactText(text: string): string {
    return text.replace(KEY_VALUE, (whole, quote: string, key: string, separator: string) =>
        isSecretKey(key) ? `${quote}${key}${quote}${separator}"${HIDDEN}"` : whole,
    );
}
