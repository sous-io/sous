/**
 * Which variables hold a secret, and hiding them (S6, `variables.secrets`).
 *
 * A `variable-source` entity declaring a name secret is the authority (a recipe marks a variable
 * `secret: true`). Everything else (an `_env` mapping, a `_vars` entry, an answer whose definition
 * forgot the flag) is checked by a deliberately thin heuristic: a name whose last words say it is a
 * secret (`githubToken`, `OPENAI_API_KEY`), or a value in a widely used token format. It catches what
 * is very probably a secret; it is a safety net, not a scanner.
 */

import type { VariablesSecrets, VariableSourceContext, VariableSourceEntity, VarScope } from "./types.js";

/** What a hidden value shows in place of the secret. */
export const HIDDEN_VALUE = "(hidden)";

/**
 * Name endings that mark a secret, as lowercase words. A name matches when its last words are one of
 * these, so `apiToken` and `GITHUB_TOKEN` match while `tokenLimit` does not.
 */
const SECRET_NAME_ENDINGS: readonly (readonly string[])[] = [
    ["token"],
    ["secret"],
    ["secrets"],
    ["password"],
    ["passwd"],
    ["passphrase"],
    ["credential"],
    ["credentials"],
    ["apikey"],
    ["api", "key"],
    ["private", "key"],
    ["access", "key"],
    ["secret", "key"],
    ["signing", "key"],
    ["encryption", "key"],
];

/** Widely used secret formats, each specific enough that a match is very probably a secret. */
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/, // a PEM private key
    /\bgh[pousr]_[A-Za-z0-9]{36,}/, // GitHub token
    /\bgithub_pat_[A-Za-z0-9_]{22,}/, // GitHub fine-grained token
    /\bglpat-[A-Za-z0-9_-]{20,}/, // GitLab personal access token
    /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, // AWS access key id
    /\bxox[abposr]-[A-Za-z0-9-]{10,}/, // Slack token
    /\b[rs]k_live_[A-Za-z0-9]{16,}/, // Stripe live key
    /\bsk-ant-[A-Za-z0-9_-]{20,}/, // Anthropic API key
    /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/, // OpenAI API key
    /\bAIza[0-9A-Za-z_-]{35}/, // Google API key
    /\bnpm_[A-Za-z0-9]{36}\b/, // npm token
    /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, // JSON Web Token
    /^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i, // a URL carrying a password
];

/** Values a secret-sounding name may hold without being a secret: nothing, a number, a switch. */
const PLAIN_VALUE = /^(?:|-?\d+(?:\.\d+)?|true|false|yes|no|on|off)$/i;

/** The words of a name, lowercased: `OPENAI_API_KEY`, `openaiApiKey` and `openai-api-key` all give `openai api key`. */
function nameWords(name: string): string[] {
    return name
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
        .split(/[^A-Za-z0-9]+/)
        .filter((word) => word.length > 0)
        .map((word) => word.toLowerCase());
}

/** Whether a name says it holds a secret. */
export function hasSecretName(name: string): boolean {
    const words = nameWords(name);

    return SECRET_NAME_ENDINGS.some(
        (ending) => words.length >= ending.length && ending.every((word, i) => words[words.length - ending.length + i] === word),
    );
}

/** Whether a value is in one of the widely used secret formats. */
export function hasSecretValue(value: string): boolean {
    return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

/** Whether a variable very probably holds a secret: a known token format, or a secret name holding more than a number or a switch. */
export function looksLikeSecret(name: string, value: string): boolean {
    if (hasSecretValue(value)) {
        return true;
    }

    return hasSecretName(name) && !PLAIN_VALUE.test(value.trim());
}

/**
 * Whether a variable is treated as a secret: declared one (and not empty), or very probably one by
 * the heuristic. A value that is not a string never is.
 */
export function isSecret(name: string, value: unknown, declared: ReadonlySet<string> = new Set()): boolean {
    if (typeof value !== "string") {
        return false;
    }

    if (declared.has(name)) {
        return value.length > 0;
    }

    return looksLikeSecret(name, value);
}

/** A copy of a scope with every secret value replaced by {@link HIDDEN_VALUE}. */
export function hideSecrets(scope: VarScope, declared: ReadonlySet<string> = new Set()): Record<string, string> {
    const out: Record<string, string> = {};

    for (const [name, value] of Object.entries(scope)) {
        out[name] = isSecret(name, value, declared) ? HIDDEN_VALUE : value;
    }

    return out;
}

/**
 * The `variables.secrets` service for one config: the declared names come from the
 * `variable-source` entities of that config.
 */
export class Secrets implements VariablesSecrets {
    readonly hiddenValue = HIDDEN_VALUE;
    private cached: ReadonlySet<string> | undefined;

    constructor(
        private readonly sources: () => readonly VariableSourceEntity[],
        private readonly context: () => VariableSourceContext,
    ) {}

    declared(): ReadonlySet<string> {
        if (!this.cached) {
            const names = new Set<string>();
            const context = this.context();

            for (const source of this.sources()) {
                for (const name of source.secrets?.(context) ?? []) {
                    names.add(name);
                }
            }

            this.cached = names;
        }

        return this.cached;
    }

    isSecret(name: string, value: unknown, declared: ReadonlySet<string> = this.declared()): boolean {
        return isSecret(name, value, declared);
    }

    hasSecretName(name: string): boolean {
        return hasSecretName(name);
    }

    hasSecretValue(value: string): boolean {
        return hasSecretValue(value);
    }

    hide(scope: VarScope, declared: ReadonlySet<string> = this.declared()): Record<string, string> {
        return hideSecrets(scope, declared);
    }
}
