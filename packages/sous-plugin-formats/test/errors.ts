import { isSousErrorOfKind } from "@sous-io/plugin-api";

/** Whether a value is a `ConfigError`. */
export function isConfigError(value: unknown): boolean {
    return isSousErrorOfKind(value, "config");
}
