import { type JsonSchema, toJsonSchema } from "@sous-io/plugin-api";
import { type FlagSpec, type ValueKind } from "./flags.js";
import type { CliGlobalArgumentEntity } from "./types.js";

/** A global argument, ready to parse. */
export interface GlobalSpec extends FlagSpec {
    readonly valueName: string;
}

/** The flags every command accepts, from the `cli-global-argument` entities. */
export function globalSpecs(entities: readonly CliGlobalArgumentEntity[]): GlobalSpec[] {
    return entities.map((entity) => {
        const schema: JsonSchema = toJsonSchema(entity.schema) ?? {};
        const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
        const kind: ValueKind = type === "boolean" || type === "number" || type === "integer" ? type : schema.enum || type === "string" ? "string" : "string";

        return {
            field: entity.id,
            name: entity.id,
            aliases: [],
            short: entity.short,
            kind,
            multiple: type === "array",
            description: entity.description,
            defaultValue: schema.default,
            choices: schema.enum,
            required: false,
            hidden: entity.hidden ?? false,
            valueName: entity.valueName ?? "value",
        };
    });
}
