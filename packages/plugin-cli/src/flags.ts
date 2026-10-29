import type { CliSection, JsonSchema } from "@sous-io/plugin-api";
import { toKebab } from "./words.js";

/** How a flag's value is read from the command line. */
export type ValueKind = "boolean" | "string" | "number" | "integer" | "json";

/** One flag of a command, generated from one field of its input schema (L4: every input is a flag). */
export interface FlagSpec {
    /** The input field it sets. */
    readonly field: string;
    /** The long name, without dashes: `install-plugins`. */
    readonly name: string;
    /** More long names, without dashes. */
    readonly aliases: readonly string[];
    /** The one-letter short form help shows first, without the dash. */
    readonly short: string | undefined;
    /**
     * More one-letter short forms: one-letter `aliases`, and `-y` and `-f` for a flag also spelled
     * `--yes` or `--force` (the confirmation flag of today's CLI answers to all four). The parser
     * drops any another flag of the command already uses.
     */
    readonly shorts: readonly string[];
    readonly kind: ValueKind;
    /** True for array fields: the flag may be given more than once. */
    readonly multiple: boolean;
    readonly description: string | undefined;
    readonly defaultValue: unknown;
    readonly choices: readonly unknown[] | undefined;
    readonly required: boolean;
    readonly hidden: boolean;
}

/** One positional argument, from a field named in `cli.positional`. */
export interface PositionalSpec {
    readonly field: string;
    /** As help writes it: `repository`. */
    readonly name: string;
    readonly kind: ValueKind;
    /** True when it takes every remaining argument (the last one, for an array field). */
    readonly variadic: boolean;
    readonly required: boolean;
    readonly description: string | undefined;
}

/** The flags and positional arguments of a command. */
export interface CommandArguments {
    readonly flags: readonly FlagSpec[];
    readonly positionals: readonly PositionalSpec[];
}

/**
 * The flags and positional arguments of a command, from its input's JSON Schema and its `cli`
 * section. A field named in `cli.positional` is also accepted as a flag.
 */
export function argumentsFromSchema(schema: JsonSchema | undefined, cli: CliSection = {}): CommandArguments {
    const properties = schema?.properties ?? {};
    const required = new Set(schema?.required ?? []);
    const flags: FlagSpec[] = [];

    for (const [field, property] of Object.entries(properties)) {
        const options = cli.flags?.[field] ?? {};
        const { kind, multiple } = kindOf(property);
        const name = toKebab(field);
        const aliases = (options.aliases ?? []).filter((alias) => alias.length > 1);
        const shorts = extraShorts(kind, [name, ...aliases], options).filter((letter) => letter !== options.short);

        flags.push({
            field,
            name,
            aliases,
            short: options.short ?? shorts[0],
            shorts: options.short ? shorts : shorts.slice(1),
            kind,
            multiple,
            description: property.description,
            defaultValue: property.default,
            choices: choicesOf(property),
            required: required.has(field) && property.default === undefined,
            hidden: options.hidden ?? false,
        });
    }

    const names = cli.positional ?? [];
    const positionals = names.map((field, index): PositionalSpec => {
        const property = properties[field] ?? {};
        const { kind, multiple } = kindOf(property);

        return {
            field,
            name: toKebab(field),
            kind,
            variadic: multiple && index === names.length - 1,
            required: required.has(field) && property.default === undefined,
            description: property.description,
        };
    });

    return { flags, positionals };
}

/** Letters a flag also answers to, besides its declared `short`. */
const CONFIRMATION_SHORTS: Readonly<Record<string, string>> = { yes: "y", force: "f" };

function extraShorts(kind: ValueKind, names: readonly string[], options: { aliases?: readonly string[] }): string[] {
    const letters = (options.aliases ?? []).filter((alias) => alias.length === 1);

    if (kind === "boolean") {
        for (const name of names) {
            const letter = CONFIRMATION_SHORTS[name];

            if (letter) {
                letters.push(letter);
            }
        }
    }

    return [...new Set(letters)];
}

function kindOf(property: JsonSchema): { kind: ValueKind; multiple: boolean } {
    const type = primaryType(property);

    if (type === "array") {
        const itemType = property.items ? primaryType(property.items) : "string";

        return { kind: scalarKind(itemType), multiple: true };
    }

    if (type === undefined && property.enum) {
        return { kind: property.enum.every((item) => typeof item === "number") ? "number" : "string", multiple: false };
    }

    return { kind: scalarKind(type), multiple: false };
}

function scalarKind(type: string | undefined): ValueKind {
    switch (type) {
        case "boolean":
        case "number":
        case "integer":
        case "string":
            return type;
        case "object":
            return "json";
        default:
            return "string";
    }
}

function primaryType(property: JsonSchema): string | undefined {
    if (Array.isArray(property.type)) {
        return property.type.find((type) => type !== "null");
    }

    if (property.type) {
        return property.type;
    }

    const option = property.anyOf?.find((item) => item.type !== "null");

    return option ? primaryType(option) : undefined;
}

function choicesOf(property: JsonSchema): readonly unknown[] | undefined {
    if (property.enum) {
        return property.enum;
    }

    if (property.items?.enum) {
        return property.items.enum;
    }

    return undefined;
}

/**
 * Turns one command-line value into the value of its kind. Returns an error message instead when it
 * cannot.
 */
export function convertValue(raw: string, kind: ValueKind, flag: string): { value: unknown } | { error: string } {
    switch (kind) {
        case "number":
        case "integer": {
            const value = Number(raw);

            if (raw.trim() === "" || Number.isNaN(value) || (kind === "integer" && !Number.isInteger(value))) {
                return { error: `${flag} takes ${kind === "integer" ? "a whole number" : "a number"}, not "${raw}".` };
            }

            return { value };
        }
        case "json":
            try {
                return { value: JSON.parse(raw) };
            } catch {
                return { error: `${flag} takes JSON, and "${raw}" is not valid JSON.` };
            }
        case "boolean":
            return { value: raw === "" || raw === "true" };
        default:
            return { value: raw };
    }
}
