/**
 * `${name}` substitution: the one implementation. Before the refactor there were two, in
 * `settings.ts` and `include-resolver.ts`.
 */

import path from "node:path";
import { ConfigError, type JsonValue } from "@sous-io/plugin-api";
import type { VarScope } from "./types.js";

/** One `${name}` reference. The name is everything up to the closing brace. */
const REFERENCE = /\$\{([^}]+)\}/g;

/**
 * Replaces every `${name}` the scope knows. Unknown references stay as written.
 *
 * ```ts
 * substitute("${root}/x/${missing}", { root: "/proj" });
 * // "/proj/x/${missing}"
 * ```
 */
export function substitute(text: string, scope: VarScope): string {
    return text.replace(REFERENCE, (match, name: string) => (Object.hasOwn(scope, name) ? scope[name]! : match));
}

/** The names of every `${name}` in text, each once, in the order they first appear. */
export function references(text: string): string[] {
    return [...new Set([...text.matchAll(REFERENCE)].map((match) => match[1]!))];
}

/** The names in text that a scope does not resolve. With no scope, every name. */
export function unresolved(text: string, scope: VarScope = {}): string[] {
    return references(text).filter((name) => !Object.hasOwn(scope, name));
}

/**
 * Replaces every `${name}`, and throws a `ConfigError` naming `context` and each unknown name. Used
 * for every value sous acts on, so a typo fails loudly instead of leaving a literal `${var}` path.
 */
export function substituteStrict(text: string, scope: VarScope, context: string): string {
    const result = substitute(text, scope);
    const missing = references(result);

    if (missing.length === 0) {
        return result;
    }

    const names = missing.map((name) => `\${${name}}`).join(", ");
    const one = missing.length === 1;
    const available = Object.keys(scope).sort();

    throw new ConfigError(`Unresolved ${one ? "variable" : "variables"} ${names} in ${context}`, {
        details: [
            `raw value: ${text}`,
            `Define ${one ? "it" : "them"} in a _vars block, or map ${one ? "it" : "them"} from the environment ` +
                "via the top-level _env block (values can come from .sous/.env.local or .sous/.env).",
            `Variables in scope here: ${available.length > 0 ? available.join(", ") : "(none)"}`,
        ],
    });
}

/**
 * Substitutes every string inside a JSON value, strictly. Object keys are left alone. `context`
 * names the value; each string's own path is added to it in errors.
 */
export function substituteValue<T extends JsonValue>(value: T, scope: VarScope, context: string): T {
    return walk(value, scope, context) as T;
}

function walk(value: JsonValue, scope: VarScope, context: string): JsonValue {
    if (typeof value === "string") {
        return substituteStrict(value, scope, context);
    }

    if (Array.isArray(value)) {
        return value.map((item, index) => walk(item, scope, `${context}[${index}]`));
    }

    if (value !== null && typeof value === "object") {
        const out: Record<string, JsonValue> = {};

        for (const [key, item] of Object.entries(value)) {
            out[key] = walk(item, scope, context === "" ? key : `${context}.${key}`);
        }

        return out;
    }

    return value;
}

/**
 * A substituted path with a leading `~` expanded to the home directory and, when absolute, its `.`
 * and `..` segments collapsed. Relative paths are otherwise left alone: they are resolved later,
 * against a directory this function does not know.
 *
 * Collapsing matters: prune compares tracked files against a `destinationDir` by prefix, so
 * `/repo/.sous/../.claude/skills` must become `/repo/.claude/skills`.
 */
export function normalizePath(value: string, home: string | undefined): string {
    let result = value;

    if (home !== undefined && home !== "") {
        if (result === "~") {
            result = home;
        } else if (result.startsWith("~/")) {
            result = path.join(home, result.slice(2));
        }
    }

    return path.isAbsolute(result) ? path.normalize(result) : result;
}
