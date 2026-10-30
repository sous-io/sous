import { formatPath, getAtPath, isPathPrefix, parsePath } from "@sous-io/documents";
import { type ConfigKeyEntity, type JsonObject, type JsonValue, type PathSegment, validateWith } from "@sous-io/plugin-api";
import type { StoredEntity } from "../entities/entity-registry.js";

/** The result of checking a config. */
export interface ValidationResult {
    /** The config with every key's defaults filled in. */
    readonly config: JsonObject;
    /** One line per problem: `diagrams.sourceGlob: Expected string, got number 3.` */
    readonly issues: string[];
}

/**
 * Checks the finished config against every `config-key` entity, and fills in their defaults (S2,
 * rule 9; C4, C71). Unknown top-level keys are rejected. A key's schema never sees the keys inside
 * it that have `config-key` entities of their own; those are checked on their own.
 *
 * A missing key is checked as `undefined`, then as `{}` (so an object schema's defaults apply); when
 * neither passes, the key stays missing.
 *
 * `who` names who set a path, for the messages.
 */
export async function validateConfig(
    config: JsonObject,
    keys: readonly StoredEntity[],
    who: (path: readonly PathSegment[]) => string | undefined,
): Promise<ValidationResult> {
    const result = structuredClone(config) as JsonObject;
    const issues: string[] = [];
    const entries = keys.map((entity) => ({ path: parsePath((entity.entry as ConfigKeyEntity).id), entity }));
    const topLevel = new Set(entries.map((entry) => String(entry.path[0])));

    for (const key of Object.keys(result)) {
        if (!topLevel.has(key)) {
            issues.push(`${formatPath([key])}: Not a known config key; likely a typo.${by(who([key]))}`);
        }
    }

    const deepestFirst = [...entries].sort((a, b) => b.path.length - a.path.length);

    for (const { path, entity } of deepestFirst) {
        const children = entries.filter((other) => other.path.length > path.length && isPathPrefix(path, other.path));
        const value = getAtPath(result, path);
        const own = withoutChildren(value, path, children.map((child) => child.path));
        const schema = (entity.entry as ConfigKeyEntity).schema;
        let checked = await validateWith(schema, own);

        if (checked.issues && own === undefined) {
            const asEmpty = await validateWith(schema, {});

            checked = asEmpty.issues ? { value: undefined } : asEmpty;
        }

        if (checked.issues) {
            for (const issue of checked.issues) {
                const issuePath = [...path, ...parsePath(issue.path)];

                issues.push(`${formatPath(issuePath)}: ${issue.message}${by(who(issuePath))}`);
            }

            continue;
        }

        const restored = restoreChildren(checked.value as JsonValue | undefined, value, path, children.map((child) => child.path));

        setAt(result, path, restored);
    }

    return { config: result, issues };
}

function by(author: string | undefined): string {
    return author ? ` (set by ${author})` : "";
}

function withoutChildren(
    value: JsonValue | undefined,
    path: readonly PathSegment[],
    childPaths: ReadonlyArray<readonly PathSegment[]>,
): JsonValue | undefined {
    if (childPaths.length === 0 || value === undefined) {
        return value;
    }

    const copy = structuredClone(value);

    for (const child of childPaths) {
        deleteAt(copy, child.slice(path.length));
    }

    return copy;
}

function restoreChildren(
    checked: JsonValue | undefined,
    original: JsonValue | undefined,
    path: readonly PathSegment[],
    childPaths: ReadonlyArray<readonly PathSegment[]>,
): JsonValue | undefined {
    let out = checked;

    for (const child of childPaths) {
        const relative = child.slice(path.length);
        const childValue = getAtPath(original, relative);

        if (childValue === undefined) {
            continue;
        }

        if (out === undefined || out === null || typeof out !== "object") {
            out = {};
        }

        setAt(out as JsonObject, relative, childValue);
    }

    return out;
}

function setAt(root: JsonObject | JsonValue[], path: readonly PathSegment[], value: JsonValue | undefined): void {
    if (path.length === 0) {
        return;
    }

    let container = root as Record<string | number, JsonValue>;

    for (const segment of path.slice(0, -1)) {
        let next = container[segment];

        if (next === null || typeof next !== "object") {
            next = {};
            container[segment] = next;
        }

        container = next as Record<string | number, JsonValue>;
    }

    const last = path[path.length - 1]!;

    if (value === undefined) {
        delete container[last];
    } else {
        container[last] = value;
    }
}

function deleteAt(root: JsonValue, path: readonly PathSegment[]): void {
    const parent = getAtPath(root, path.slice(0, -1));

    if (parent !== null && typeof parent === "object" && !Array.isArray(parent)) {
        delete (parent as JsonObject)[String(path[path.length - 1])];
    }
}
