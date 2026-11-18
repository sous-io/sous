/**
 * The schemas the `liquid-tag` and `liquid-filter` entity kinds check every entry against.
 * JSON Schema has no function type, so a small check on top makes sure the factory is a function.
 */

import { jsonSchema, type JsonSchema, type SousSchema } from "@sous-io/plugin-api";

const PURPOSES: JsonSchema = { type: "array", items: { type: "string" } };

/** A JSON Schema for an entity with an id, a description, purposes and one factory method. */
function extensionSchema(factory: "tag" | "filter"): SousSchema {
    const base = jsonSchema({
        type: "object",
        properties: {
            id: { type: "string" },
            description: { type: "string" },
            purposes: PURPOSES,
            [factory]: {},
        },
        required: ["id", factory],
    });

    return {
        "~standard": {
            ...base["~standard"],
            validate(value: unknown) {
                const result = base["~standard"].validate(value);

                if (result instanceof Promise || result.issues) {
                    return result;
                }

                const made = (result.value as Record<string, unknown>)[factory];

                if (typeof made !== "function") {
                    return { issues: [{ message: "Expected a function.", path: [factory] }] };
                }

                return result;
            },
        },
    };
}

/** The `liquid-tag` schema. */
export const liquidTagSchema: SousSchema = extensionSchema("tag");

/** The `liquid-filter` schema. */
export const liquidFilterSchema: SousSchema = extensionSchema("filter");
