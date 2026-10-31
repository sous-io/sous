/**
 * The schemas plugin-variables registers: its two root config keys and the `variable-source` kind.
 */

import type { ConfigKeyEntity, SousSchema, StandardSchemaV1 } from "@sous-io/plugin-api";
import { isAutoVariable } from "./auto.js";

type Issue = StandardSchemaV1.Issue;

/**
 * A schema for a map of names to strings, refusing names sous sets itself. `what` says what the
 * values are, for messages.
 */
function variableMap(what: string): SousSchema<Record<string, string> | undefined> {
    return {
        "~standard": {
            version: 1,
            vendor: "sous",
            validate(value: unknown) {
                if (value === undefined) {
                    return { value: undefined };
                }

                if (value === null || typeof value !== "object" || Array.isArray(value)) {
                    return { issues: [{ message: `Expected an object of ${what}.` }] };
                }

                const issues: Issue[] = [];

                for (const [name, item] of Object.entries(value)) {
                    // `projectRoot` may be written the way configs before it was an auto-variable
                    // wrote it; resolving the block refuses a value other than the one sous sets.
                    if (isAutoVariable(name) && name !== "projectRoot") {
                        issues.push({
                            message: `"${name}" is set by sous; it cannot be set here. Remove it: \${${name}} always holds the value sous gives it.`,
                            path: [name],
                        });
                    } else if (typeof item !== "string") {
                        issues.push({ message: `Expected a string (${what}), got ${item === null ? "null" : typeof item}.`, path: [name] });
                    }
                }

                return issues.length > 0 ? { issues } : { value: value as Record<string, string> };
            },
        },
    };
}

/** The `_vars` and `_env` config keys. */
export const CONFIG_KEYS: readonly ConfigKeyEntity[] = [
    {
        id: "_vars",
        description: "Config variables, used as ${name}. Values may refer to each other in any order.",
        schema: variableMap("variable values"),
    },
    {
        id: "_env",
        description: "Config variables read from the environment: each name mapped to an environment variable.",
        schema: variableMap("environment variable names"),
    },
];

/** The schema every `variable-source` entity is checked against. */
export const VARIABLE_SOURCE_SCHEMA: SousSchema = {
    "~standard": {
        version: 1,
        vendor: "sous",
        validate(value: unknown) {
            const entry = value as Record<string, unknown> | null;
            const issues: Issue[] = [];

            if (typeof entry?.id !== "string" || entry.id === "") {
                issues.push({ message: "A variable-source entity needs an id.", path: ["id"] });
            }

            if (typeof entry?.description !== "string") {
                issues.push({ message: "A variable-source entity needs a description.", path: ["description"] });
            }

            if (typeof entry?.variables !== "function") {
                issues.push({ message: "A variable-source entity needs a variables function.", path: ["variables"] });
            }

            for (const name of ["scoped", "secrets"]) {
                if (entry?.[name] !== undefined && typeof entry[name] !== "function") {
                    issues.push({ message: `A variable-source entity's ${name} must be a function.`, path: [name] });
                }
            }

            if (entry?.forbiddenUnder !== undefined && !Array.isArray(entry.forbiddenUnder)) {
                issues.push({ message: "A variable-source entity's forbiddenUnder must be a list of keys.", path: ["forbiddenUnder"] });
            }

            return issues.length > 0 ? { issues } : { value };
        },
    },
};
