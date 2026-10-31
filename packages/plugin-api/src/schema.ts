/**
 * Schemas.
 *
 * Sous accepts any schema that follows the Standard Schema interface (zod 4, valibot, arktype and
 * others do), so a plugin uses the schema library it likes. Front ends that generate flags or tools
 * from a schema (the CLI, MCP) also need its JSON Schema, which the Standard JSON Schema interface
 * gives; zod 4 has both.
 *
 * For plugins that want no schema library at all (core and plugin-cli among them, to keep start-up
 * fast), {@link jsonSchema} turns a small JSON Schema into a schema sous accepts.
 */

/** The Standard Schema interface (https://standardschema.dev), version 1. */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
    readonly "~standard": StandardSchemaV1.Props<Input, Output>;
}

// The namespace mirrors the published Standard Schema type declarations exactly.
// eslint-disable-next-line @typescript-eslint/no-namespace
export declare namespace StandardSchemaV1 {
    interface Props<Input = unknown, Output = Input> {
        readonly version: 1;
        readonly vendor: string;
        readonly validate: (
            value: unknown,
            options?: Options | undefined,
        ) => Result<Output> | Promise<Result<Output>>;
        readonly types?: Types<Input, Output> | undefined;
    }

    interface Options {
        readonly libraryOptions?: Record<string, unknown> | undefined;
    }

    type Result<Output> = SuccessResult<Output> | FailureResult;

    interface SuccessResult<Output> {
        readonly value: Output;
        readonly issues?: undefined;
    }

    interface FailureResult {
        readonly issues: ReadonlyArray<Issue>;
    }

    interface Issue {
        readonly message: string;
        readonly path?: ReadonlyArray<PropertyKey | PathSegment> | undefined;
    }

    interface PathSegment {
        readonly key: PropertyKey;
    }

    interface Types<Input = unknown, Output = Input> {
        readonly input: Input;
        readonly output: Output;
    }

    type InferInput<Schema extends StandardSchemaV1> = NonNullable<Schema["~standard"]["types"]>["input"];
    type InferOutput<Schema extends StandardSchemaV1> = NonNullable<Schema["~standard"]["types"]>["output"];
}

/** The converter the Standard JSON Schema interface adds to `~standard`. */
export interface StandardJsonSchemaConverter {
    readonly input: (options: { readonly target: string }) => Record<string, unknown>;
    readonly output: (options: { readonly target: string }) => Record<string, unknown>;
}

/** Any schema sous accepts: Standard Schema, optionally with a JSON Schema converter. */
export type SousSchema<Input = unknown, Output = Input> = StandardSchemaV1<Input, Output>;

/** The value a schema produces. */
export type InferOutput<S> = S extends StandardSchemaV1<unknown, infer O> ? O : unknown;

/** The value a schema accepts. */
export type InferInput<S> = S extends StandardSchemaV1<infer I, unknown> ? I : unknown;

/** One problem found while checking a value. */
export interface SchemaIssue {
    /** Where, as a path string (`compilation.targets[2].id`); `""` for the value itself. */
    path: string;
    message: string;
}

/**
 * The subset of JSON Schema {@link jsonSchema} checks: `type`, `enum`, `const`, `properties`,
 * `required`, `additionalProperties`, `items`, `anyOf`, `default` and `description`.
 */
export interface JsonSchema {
    type?: JsonSchemaType | JsonSchemaType[];
    description?: string;
    default?: unknown;
    enum?: readonly unknown[];
    const?: unknown;
    properties?: Record<string, JsonSchema>;
    required?: readonly string[];
    additionalProperties?: boolean | JsonSchema;
    items?: JsonSchema;
    anyOf?: readonly JsonSchema[];
    [extra: string]: unknown;
}

/** The JSON Schema type names. */
export type JsonSchemaType = "string" | "number" | "integer" | "boolean" | "null" | "object" | "array";

/**
 * Turns a small JSON Schema into a schema sous accepts, with no schema library. It checks the
 * subset {@link JsonSchema} lists, fills in `default`s, and gives its JSON Schema back to front ends.
 *
 * ```ts
 * sous.entities.add("cli-global-argument", {
 *     id: "debug",
 *     schema: jsonSchema<boolean>({ type: "boolean", default: false }),
 *     description: "Show every message, debug ones included",
 * });
 * ```
 */
export function jsonSchema<T = unknown>(schema: JsonSchema): SousSchema<T, T> {
    const converter: StandardJsonSchemaConverter = {
        input: () => ({ ...schema }),
        output: () => ({ ...schema }),
    };

    return {
        "~standard": {
            version: 1,
            vendor: "sous",
            validate(value: unknown) {
                const issues: CheckIssue[] = [];
                const result = check(schema, value, [], issues);

                if (issues.length > 0) {
                    return { issues: issues.map((issue) => ({ message: issue.message, path: issue.path })) };
                }

                return { value: result as T };
            },
            jsonSchema: converter,
        } as StandardSchemaV1.Props<T, T> & { jsonSchema: StandardJsonSchemaConverter },
    };
}

/**
 * The JSON Schema of any schema, when it has one: through the Standard JSON Schema converter
 * (zod 4 and {@link jsonSchema} have it). `undefined` when the schema cannot describe itself.
 */
export function toJsonSchema(schema: SousSchema | undefined): JsonSchema | undefined {
    const converter = (schema?.["~standard"] as { jsonSchema?: StandardJsonSchemaConverter } | undefined)
        ?.jsonSchema;

    if (!converter) {
        return undefined;
    }

    try {
        return converter.input({ target: "draft-2020-12" }) as JsonSchema;
    } catch {
        return undefined;
    }
}

/**
 * Checks a value against any schema and returns the checked value (with defaults filled in) or the
 * issues, each with a path string. Asynchronous schemas are awaited.
 */
export async function validateWith<T>(
    schema: SousSchema<unknown, T>,
    value: unknown,
): Promise<{ value: T; issues?: undefined } | { value?: undefined; issues: SchemaIssue[] }> {
    const result = await schema["~standard"].validate(value);

    return result.issues ? { issues: result.issues.map(toSchemaIssue) } : { value: result.value };
}

/**
 * The synchronous form of {@link validateWith}. A schema that answers with a promise is reported
 * as one issue, since nothing can wait for it here.
 */
export function validateWithSync<T>(
    schema: SousSchema<unknown, T>,
    value: unknown,
): { value: T; issues?: undefined } | { value?: undefined; issues: SchemaIssue[] } {
    const result = schema["~standard"].validate(value);

    if (result instanceof Promise) {
        return { issues: [{ path: "", message: "This schema checks values asynchronously, which is not supported here." }] };
    }

    return result.issues ? { issues: result.issues.map(toSchemaIssue) } : { value: result.value };
}

/** Whether a value looks like a schema sous accepts. */
export function isSchema(value: unknown): value is SousSchema {
    const props = (value as { "~standard"?: { validate?: unknown } } | null | undefined)?.["~standard"];

    return typeof props?.validate === "function";
}

function toSchemaIssue(issue: StandardSchemaV1.Issue): SchemaIssue {
    const segments = (issue.path ?? []).map((segment) =>
        typeof segment === "object" && segment !== null ? segment.key : segment,
    );

    return { path: formatIssuePath(segments), message: issue.message };
}

/** Writes issue path segments the way sous writes paths: `a.b[2]."c.d"`. */
export function formatIssuePath(segments: readonly PropertyKey[]): string {
    let out = "";

    for (const segment of segments) {
        if (typeof segment === "number") {
            out += `[${segment}]`;
        } else {
            const key = String(segment);
            const part = /^[A-Za-z_$][\w$-]*$/.test(key) ? key : JSON.stringify(key);

            out += out === "" ? part : `.${part}`;
        }
    }

    return out;
}

function check(schema: JsonSchema, value: unknown, path: PropertyKey[], issues: CheckIssue[]): unknown {
    if (value === undefined && schema.default !== undefined) {
        value = structuredClone(schema.default);
    }

    if (schema.anyOf) {
        for (const option of schema.anyOf) {
            const optionIssues: CheckIssue[] = [];
            const result = check(option, value, path, optionIssues);

            if (optionIssues.length === 0) {
                return result;
            }
        }

        issues.push({ path: path, message: "Expected a value matching one of the allowed forms." });

        return value;
    }

    if (schema.const !== undefined && !sameJson(value, schema.const)) {
        issues.push({ path: path, message: `Expected ${JSON.stringify(schema.const)}.` });

        return value;
    }

    if (schema.enum && !schema.enum.some((option) => sameJson(option, value))) {
        const options = schema.enum.map((option) => JSON.stringify(option)).join(", ");

        issues.push({ path: path, message: `Expected one of ${options}.` });

        return value;
    }

    if (schema.type !== undefined) {
        const types = Array.isArray(schema.type) ? schema.type : [schema.type];

        if (!types.some((type) => hasType(value, type))) {
            const got = value === undefined ? "nothing" : describeType(value);

            issues.push({ path: path, message: `Expected ${types.join(" or ")}, got ${got}.` });

            return value;
        }
    }

    if (isPlainObject(value) && (schema.properties || schema.required || schema.additionalProperties !== undefined)) {
        return checkObject(schema, value, path, issues);
    }

    if (Array.isArray(value) && schema.items) {
        return value.map((item, index) => check(schema.items!, item, [...path, index], issues));
    }

    return value;
}

function checkObject(
    schema: JsonSchema,
    value: Record<string, unknown>,
    path: PropertyKey[],
    issues: CheckIssue[],
): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const properties = schema.properties ?? {};

    for (const name of schema.required ?? []) {
        if (value[name] === undefined && properties[name]?.default === undefined) {
            issues.push({ path: [...path, name], message: "Required, but missing." });
        }
    }

    for (const [name, propertySchema] of Object.entries(properties)) {
        // A missing optional property is fine; required ones were reported above.
        if (value[name] === undefined && propertySchema.default === undefined) {
            continue;
        }

        const checked = check(propertySchema, value[name], [...path, name], issues);

        if (checked !== undefined) {
            out[name] = checked;
        }
    }

    for (const [name, item] of Object.entries(value)) {
        if (name in properties) {
            continue;
        }

        if (schema.additionalProperties === false) {
            issues.push({ path: [...path, name], message: "Not a known key." });
        } else if (typeof schema.additionalProperties === "object") {
            out[name] = check(schema.additionalProperties, item, [...path, name], issues);
        } else {
            out[name] = item;
        }
    }

    return out;
}

function hasType(value: unknown, type: JsonSchemaType): boolean {
    switch (type) {
        case "string":
            return typeof value === "string";
        case "number":
            return typeof value === "number" && Number.isFinite(value);
        case "integer":
            return typeof value === "number" && Number.isInteger(value);
        case "boolean":
            return typeof value === "boolean";
        case "null":
            return value === null;
        case "array":
            return Array.isArray(value);
        case "object":
            return isPlainObject(value);
    }
}

function describeType(value: unknown): string {
    if (value === null) {
        return "null";
    }

    if (Array.isArray(value)) {
        return "an array";
    }

    return typeof value === "object" ? "an object" : `${typeof value} ${JSON.stringify(value)}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameJson(a: unknown, b: unknown): boolean {
    return a === b || JSON.stringify(a) === JSON.stringify(b);
}

interface CheckIssue {
    path: PropertyKey[];
    message: string;
}
