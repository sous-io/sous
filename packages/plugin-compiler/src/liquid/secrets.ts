/**
 * Hiding secrets from the tags that dump a whole scope (`showVars`, `exportScalarVarsJs`). Which
 * values are secret is `variables.secrets`' concern; this only asks it.
 */

import type { LiquidExtensionContext } from "@sous-io/plugin-liquid/types";
import type { VariablesSecrets } from "@sous-io/plugin-variables/types";

/** What a hidden value prints as when `variables.secrets` is not loaded. */
const FALLBACK_HIDDEN = "(hidden)";

/** How a tag tells a secret, and what it prints instead. */
export interface SecretCheck {
    readonly hiddenValue: string;
    isSecret(name: string, value: unknown): boolean;
}

/**
 * The secret check for one engine: `variables.secrets` with the names the engine was told are
 * secret, or, without that service, the declared names alone.
 */
export function secretCheck(ctx: LiquidExtensionContext): SecretCheck {
    const secrets = ctx.services.has("variables.secrets") ? (ctx.services.get("variables.secrets") as VariablesSecrets) : undefined;

    if (secrets) {
        return {
            hiddenValue: secrets.hiddenValue,
            isSecret: (name, value) => secrets.isSecret(name, value, ctx.secretNames),
        };
    }

    return {
        hiddenValue: FALLBACK_HIDDEN,
        isSecret: (name, value) => typeof value === "string" && value.length > 0 && ctx.secretNames.has(name),
    };
}

/** A shallow copy of an object with its keys sorted. */
export function sortObjectKeys<T extends Record<string, unknown>>(value: T): T {
    return Object.keys(value)
        .sort()
        .reduce((acc, key) => {
            (acc as Record<string, unknown>)[key] = value[key];

            return acc;
        }, {} as T);
}
