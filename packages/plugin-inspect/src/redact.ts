/**
 * Hiding secrets (G4): everything about the config can be inspected except the values of secrets.
 * The secret policy is `variables.secrets` (declared secrets, secret-sounding names, token formats);
 * when that service is not there, a key is taken as a secret by its name alone.
 */

import type { JsonObject, JsonValue, Patch } from "@sous-io/plugin-api";
import type { ConfigLayer } from "@sous-io/plugin-api";
import type { VariablesSecrets } from "@sous-io/plugin-variables/types";

/** What stands in for a secret's value. */
export const HIDDEN = "(hidden)";

const SECRET_KEY = /(pass(word|wd|phrase)?|secret|token|api[-_]?key|private[-_]?key|credential|authorization|bearer)/i;

/** What decides that a value is secret. */
export interface SecretPolicy {
    /** Whether a key's value is secret. `value` is what the key holds. */
    isSecret(key: string, value: unknown): boolean;
    /** Whether a name alone says its value is secret (used for paths, where the value may not be known). */
    isSecretName(name: string): boolean;
}

/** Whether a key names a secret, by its spelling alone (the fallback rule). */
export function isSecretKey(key: string): boolean {
    return SECRET_KEY.test(key);
}

/** The fallback policy: a key is a secret by its name alone, unless it holds nothing. */
export const KEY_NAME_POLICY: SecretPolicy = {
    isSecret: (key, value) => isSecretKey(key) && value !== null && value !== "",
    isSecretName: isSecretKey,
};

/** The policy of a `variables.secrets` service: declared names, secret-sounding names and known token formats. */
export function servicePolicy(secrets: VariablesSecrets): SecretPolicy {
    const declared = secrets.declared();

    return {
        isSecret: (key, value) => secrets.isSecret(key, value, declared) || (typeof value === "string" && secrets.hasSecretValue(value)),
        isSecretName: (name) => declared.has(name) || secrets.hasSecretName(name),
    };
}

/** A copy of a value with every secret hidden. */
export function redactValue<T extends JsonValue>(value: T, policy: SecretPolicy = KEY_NAME_POLICY): T {
    if (Array.isArray(value)) {
        return value.map((item) => redactValue(item, policy)) as T;
    }

    if (value !== null && typeof value === "object") {
        const out: JsonObject = {};

        for (const [key, inner] of Object.entries(value as JsonObject)) {
            out[key] = redactUnder(key, inner, policy);
        }

        return out as T;
    }

    return value;
}

/** A value as shown under a key: hidden when the key holds a secret (a whole object under a secret name too). */
export function redactUnder<T extends JsonValue>(key: string, value: T, policy: SecretPolicy = KEY_NAME_POLICY): JsonValue {
    const isStructure = value !== null && typeof value === "object";
    const secret = isStructure ? policy.isSecretName(key) : policy.isSecret(key, value);

    return secret ? HIDDEN : redactValue(value, policy);
}

/** Whether any segment of a path string names a secret. */
function pathHasSecret(path: string, policy: SecretPolicy): boolean {
    return path.split(/[.[\]"]+/).some((segment) => segment !== "" && policy.isSecretName(segment));
}

/** A copy of a patch with a secret's value hidden. */
export function redactPatch(patch: Patch, policy: SecretPolicy = KEY_NAME_POLICY): Patch {
    if (patch.op === "setKey") {
        const secret = policy.isSecretName(patch.key) || pathHasSecret(patch.path, policy);

        return { ...patch, value: secret ? HIDDEN : redactUnder(patch.key, patch.value, policy) };
    }

    if (patch.op === "setIndex" || patch.op === "insertAt") {
        return { ...patch, value: pathHasSecret(patch.path, policy) ? HIDDEN : redactValue(patch.value, policy) };
    }

    return patch;
}

/** A copy of a layer with its patch redacted. */
export function redactLayer<L extends ConfigLayer>(layer: L, policy: SecretPolicy = KEY_NAME_POLICY): L {
    return { ...layer, patch: redactPatch(layer.patch, policy) };
}

/** A key, its separator, and a simple value (quoted, or a bare word). Blocks are never matched. */
const KEY_VALUE = /(["']?)([\w$.-]+)\1(\s*[:=]\s*)("(?:\\.|[^"\\])*"|'[^']*'|[^\s,{}[\]#]+)/g;

/** Config file text with the value after a secret key hidden (best effort: JSON, YAML, TOML-like). */
export function redactText(text: string, policy: SecretPolicy = KEY_NAME_POLICY): string {
    return text.replace(KEY_VALUE, (whole, quote: string, key: string, separator: string) =>
        policy.isSecretName(key) ? `${quote}${key}${quote}${separator}"${HIDDEN}"` : whole,
    );
}
