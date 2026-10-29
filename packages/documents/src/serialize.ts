/**
 * Patch sets as JSON: writing them, reading them back with clear errors, and reading the raw
 * patch files users write (`.patch.json`, `.patch.jsonl`; S2, "Patch files").
 */
import { parse, type ParseError } from "jsonc-parser";
import { formatPath, parsePath } from "./path.js";
import { isJsonObject, toPlainJson } from "./json.js";
import { PATCH_OPS } from "./patch-set.js";
import type { JsonValue, Patch, PatchOp, PatchSet, PathSegment } from "./types.js";

/** Patch data that is not valid. The message says what is wrong and where. */
export class PatchFormatError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "PatchFormatError";
    }
}

/**
 * A patch set as JSON text, to save, send or preview (C76).
 *
 * ```ts
 * deserializePatchSet(serializePatchSet(set));   // deeply equal to set
 * ```
 */
export function serializePatchSet(set: PatchSet): string {
    return JSON.stringify(set);
}

/**
 * Reads a patch set from JSON text, or from data already parsed, checking every patch.
 *
 * @throws PatchFormatError naming what is wrong.
 */
export function deserializePatchSet(json: string | unknown): PatchSet {
    let data: unknown = json;

    if (typeof json === "string") {
        try {
            data = JSON.parse(json);
        } catch (error) {
            throw new PatchFormatError(`The patch set is not valid JSON: ${(error as Error).message}`);
        }
    }

    return readSet(data, "The patch set");
}

function readSet(data: unknown, where: string): PatchSet {
    if (!isJsonObject(data)) {
        throw new PatchFormatError(`${where} must be an object with "name" and "patches".`);
    }

    if (typeof data.name !== "string") {
        throw new PatchFormatError(`${where} needs a "name" string.`);
    }

    if (!Array.isArray(data.patches)) {
        throw new PatchFormatError(`${where} (${data.name}) needs a "patches" array.`);
    }

    const set: PatchSet = { name: data.name, patches: [] };

    if (data.path !== undefined) {
        set.path = normalizePath(data.path, `${where} (${data.name})`);
    }

    data.patches.forEach((item, index) => {
        const itemWhere = `Item ${index + 1} of ${data.name}`;

        set.patches.push(isJsonObject(item) && !("op" in item) ? readSet(item, itemWhere) : parsePatch(item, itemWhere));
    });

    return set;
}

/**
 * Checks one patch and returns a clean copy, with its path in canonical form. `path` may be a
 * string or an array of segments.
 *
 * ```ts
 * parsePatch({ op: "setKey", path: ["_vars"], key: "machineRole", value: "laptop" });
 * // { op: "setKey", path: "_vars", key: "machineRole", value: "laptop" }
 * ```
 *
 * @throws PatchFormatError naming what is wrong.
 */
export function parsePatch(data: unknown, where = "The patch"): Patch {
    if (!isJsonObject(data)) {
        throw new PatchFormatError(`${where} must be an object with an "op".`);
    }

    const op = data.op;

    if (typeof op !== "string" || !PATCH_OPS.includes(op as PatchOp)) {
        throw new PatchFormatError(
            `${where}: "op" must be one of ${PATCH_OPS.join(", ")}; got ${JSON.stringify(op ?? null)}.`,
        );
    }

    const path = normalizePath(data.path ?? "", where);
    const key = (field: string): string => {
        const value = data[field];

        if (typeof value !== "string") {
            throw new PatchFormatError(`${where}: ${op} needs "${field}" to be a string.`);
        }

        return value;
    };
    const index = (allowEnd: boolean): number | "end" => {
        const value = data.index;

        if (allowEnd && value === "end") {
            return "end";
        }

        if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
            throw new PatchFormatError(
                `${where}: ${op} needs "index" to be a whole number of 0 or more${allowEnd ? ', or "end"' : ""}.`,
            );
        }

        return value;
    };
    const value = (): JsonValue => {
        const plain = data.value === undefined ? undefined : toPlainJson(data.value);

        if (plain === undefined) {
            throw new PatchFormatError(`${where}: ${op} needs a "value".`);
        }

        return plain;
    };

    switch (op as PatchOp) {
        case "setKey":
            return { op: "setKey", path, key: key("key"), value: value() };
        case "deleteKey":
            return { op: "deleteKey", path, key: key("key") };
        case "renameKey":
            return { op: "renameKey", path, key: key("key"), to: key("to") };
        case "setIndex":
            return { op: "setIndex", path, index: index(false) as number, value: value() };
        case "insertAt":
            return { op: "insertAt", path, index: index(true), value: value() };
        case "removeIndex":
            return { op: "removeIndex", path, index: index(false) as number };
    }
}

function normalizePath(path: unknown, where: string): string {
    if (typeof path !== "string" && !Array.isArray(path)) {
        throw new PatchFormatError(`${where}: "path" must be a string or an array of keys and indexes.`);
    }

    try {
        return formatPath(parsePath(path as string | PathSegment[]));
    } catch (error) {
        throw new PatchFormatError(`${where}: ${(error as Error).message}`);
    }
}

/**
 * Reads a raw patch file into one patch set named after the file (C77).
 *
 * - `json` (`.patch.json`): one patch, unless the top-level object has a single key, `$patches`,
 *   holding an array; then each item is a patch. Comments are allowed.
 * - `jsonl` (`.patch.jsonl`): one patch per line; blank lines and lines starting with `//` are
 *   skipped.
 *
 * ```ts
 * parsePatchFile('{"op": "deleteKey", "path": "tools", "key": "codex"}', "json", "confd/722-one.patch.json");
 * // { name: "confd/722-one.patch.json", patches: [{ op: "deleteKey", path: "tools", key: "codex" }] }
 * ```
 *
 * @throws PatchFormatError naming the file, and the line or item, that is wrong.
 */
export function parsePatchFile(text: string, kind: "json" | "jsonl", name: string): PatchSet {
    return kind === "json" ? parseJsonPatchFile(text, name) : parseJsonlPatchFile(text, name);
}

function parseJsonPatchFile(text: string, name: string): PatchSet {
    const errors: ParseError[] = [];
    const data: unknown = parse(text, errors, { allowTrailingComma: true });

    if (errors.length > 0 || data === undefined) {
        throw new PatchFormatError(`${name} is not valid JSON.`);
    }

    if (isJsonObject(data) && Object.keys(data).length === 1 && "$patches" in data) {
        const list = data.$patches;

        if (!Array.isArray(list)) {
            throw new PatchFormatError(`${name}: "$patches" must be an array of patches.`);
        }

        return { name, patches: list.map((item, index) => parsePatch(item, `Patch ${index + 1} in ${name}`)) };
    }

    return { name, patches: [parsePatch(data, `The patch in ${name}`)] };
}

function parseJsonlPatchFile(text: string, name: string): PatchSet {
    const patches: Patch[] = [];

    text.split(/\r?\n/).forEach((line, index) => {
        const trimmed = line.trim();

        if (trimmed === "" || trimmed.startsWith("//")) {
            return;
        }

        const where = `Line ${index + 1} of ${name}`;
        let data: unknown;

        try {
            data = JSON.parse(trimmed);
        } catch {
            throw new PatchFormatError(`${where} is not valid JSON.`);
        }

        patches.push(parsePatch(data, where));
    });

    return { name, patches };
}
