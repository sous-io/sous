/**
 * Entries of `editor.edits`: checking one and turning it into ordered steps, its assertions and
 * its silences; who declared each (from the config's record of every change); and an entry's
 * identity, which is who declared it plus what it says (spec 07, "Identity: No `id` on an Entry").
 */

import { createHash } from "node:crypto";
import { getAtPath, isJsonObject, isPathPrefix, parsePath, stableStringify, type JsonObject, type JsonValue, type Patch, type PatchSet, type PathSegment } from "@sous-io/documents";
import type { Contribution } from "@sous-io/plugin-api";
import { ASSERT_SETTINGS, CHECKS, normalizeKind } from "./checks.js";
import { isOperationName, OperationParamsError, resolveOperation, type ResolvedOperation } from "./operations.js";

/** The config key of the master list. */
export const EDITS_KEY = "editor.edits";

/** The settings on an entry as a whole, with their defaults (spec 12). */
export interface EntrySettings {
    once: boolean;
    rollback: boolean;
    backupBeforeChange: boolean;
    backupOnRemoval: boolean;
}

/** The defaults: `once` off, `rollback` on, `backupBeforeChange` off, `backupOnRemoval` on. */
export const DEFAULT_SETTINGS: Readonly<EntrySettings> = Object.freeze({
    once: false,
    rollback: true,
    backupBeforeChange: false,
    backupOnRemoval: true,
});

/** An assertion an author wrote, one per check. */
export interface AuthoredAssertion {
    readonly path: string;
    readonly check: string;
    readonly arg: JsonValue;
    readonly not: boolean;
    readonly level: "error" | "warn";
    readonly message: string | undefined;
}

/** A silence on this declarer's automatic assertions. */
export interface Silence {
    readonly path: string;
    readonly kinds: readonly string[] | undefined;
    readonly except: readonly string[] | undefined;
    readonly scope: "key-and-below" | "key-only" | "below";
}

/** An entry checked and taken apart. */
export interface NormalizedEntry {
    readonly file: string | undefined;
    readonly settings: EntrySettings;
    /** The operations, in the order they run. */
    readonly steps: ResolvedOperation[];
    readonly asserts: AuthoredAssertion[];
    readonly silences: Silence[];
    /** The recipe that declared it, when a recipe did. */
    readonly recipe: string | undefined;
}

const ENTRY_SETTINGS = ["once", "rollback", "backupBeforeChange", "backupOnRemoval"] as const;
const ENTRY_KEYS = new Set<string>(["file", "recipe", "operations", "assert", "silence", ...ENTRY_SETTINGS]);
const SCOPES = new Set(["key-and-below", "key-only", "below"]);

function stringOrList(value: JsonValue | undefined, what: string): string[] | undefined {
    if (value === undefined) return undefined;

    const list = Array.isArray(value) ? value : [value];

    if (!list.every((item) => typeof item === "string")) {
        throw new OperationParamsError(`${what} must be a kind or a list of kinds.`);
    }

    return (list as string[]).map(normalizeKind);
}

function pathOf(value: JsonValue | undefined, what: string): string {
    if (value === undefined || value === null || value === "") return "";
    if (typeof value !== "string") throw new OperationParamsError(`${what}: 'path' must be a string.`);

    return value;
}

/** Takes an `assert` object apart, one assertion per check. */
export function normalizeAssert(raw: JsonValue): AuthoredAssertion[] {
    if (!isJsonObject(raw)) {
        throw new OperationParamsError("'assert' must hold an object: a 'path' and one or more checks.");
    }

    const level = raw.level ?? "error";

    if (level !== "error" && level !== "warn") {
        throw new OperationParamsError("'assert': 'level' must be error or warn.");
    }

    if (raw.message !== undefined && typeof raw.message !== "string") {
        throw new OperationParamsError("'assert': 'message' must be a string.");
    }

    if (raw.not !== undefined && typeof raw.not !== "boolean") {
        throw new OperationParamsError("'assert': 'not' must be true or false.");
    }

    const path = pathOf(raw.path, "'assert'");
    const checks = Object.keys(raw).filter((key) => !ASSERT_SETTINGS.has(key));

    if (checks.length === 0) {
        throw new OperationParamsError(`'assert' names no check. The checks: ${[...CHECKS.keys()].join(", ")}.`);
    }

    return checks.map((check) => {
        if (!CHECKS.has(check)) {
            throw new OperationParamsError(`'assert' has no check named '${check}'. The checks: ${[...CHECKS.keys()].join(", ")}.`);
        }

        return { path, check, arg: raw[check]!, not: raw.not === true, level, message: raw.message as string | undefined };
    });
}

/** Checks a `silence` object. */
export function normalizeSilence(raw: JsonValue): Silence {
    if (!isJsonObject(raw)) {
        throw new OperationParamsError("'silence' must hold an object ({} silences the whole file).");
    }

    for (const key of Object.keys(raw)) {
        if (!["path", "kinds", "except", "scope"].includes(key)) {
            throw new OperationParamsError(`'silence' has no setting '${key}'. Its settings: path, kinds, except, scope.`);
        }
    }

    const kinds = stringOrList(raw.kinds, "'silence': 'kinds'");
    const except = stringOrList(raw.except, "'silence': 'except'");

    if (kinds !== undefined && except !== undefined) {
        throw new OperationParamsError("'silence': 'except' only goes with no 'kinds' (it means every kind except these).");
    }

    const scope = raw.scope ?? "key-and-below";

    if (typeof scope !== "string" || !SCOPES.has(scope)) {
        throw new OperationParamsError("'silence': 'scope' must be key-and-below, key-only or below.");
    }

    return { path: pathOf(raw.path, "'silence'"), kinds, except, scope: scope as Silence["scope"] };
}

/**
 * Checks an entry and takes it apart. Several operation keys run in their definitions' `order`
 * (then by name); an `operations` list runs as written.
 *
 * @throws OperationParamsError naming what is wrong.
 */
export function normalizeEntry(raw: unknown): NormalizedEntry {
    if (!isJsonObject(raw as JsonValue)) {
        throw new OperationParamsError("An entry of editor.edits must be an object.");
    }

    const entry = raw as JsonObject;
    const operationKeys: string[] = [];

    for (const key of Object.keys(entry)) {
        if (ENTRY_KEYS.has(key)) continue;

        if (!isOperationName(key)) {
            throw new OperationParamsError(`'${key}' is not an operation or a setting of an entry.`);
        }

        operationKeys.push(key);
    }

    for (const setting of ENTRY_SETTINGS) {
        if (entry[setting] !== undefined && typeof entry[setting] !== "boolean") {
            throw new OperationParamsError(`'${setting}' must be true or false.`);
        }
    }

    if (entry.file !== undefined && (typeof entry.file !== "string" || entry.file === "")) {
        throw new OperationParamsError("'file' must be a path.");
    }

    if (entry.recipe !== undefined && typeof entry.recipe !== "string") {
        throw new OperationParamsError("'recipe' must be a recipe's id.");
    }

    if (operationKeys.length > 0 && entry.operations !== undefined) {
        throw new OperationParamsError("An entry has operation keys or an 'operations' list, not both.");
    }

    let steps: ResolvedOperation[];

    if (entry.operations !== undefined) {
        if (!Array.isArray(entry.operations)) {
            throw new OperationParamsError("'operations' must be a list, each item holding one operation.");
        }

        steps = entry.operations.map((item, index) => {
            const keys = isJsonObject(item) ? Object.keys(item) : [];

            if (keys.length !== 1) {
                throw new OperationParamsError(`operations[${index}] must hold exactly one operation.`);
            }

            return resolveOperation(keys[0]!, (item as JsonObject)[keys[0]!]);
        });
    } else {
        steps = operationKeys
            .map((key) => resolveOperation(key, entry[key]))
            .sort((a, b) => a.definition.order - b.definition.order || (a.definition.name < b.definition.name ? -1 : 1));
    }

    const asserts = entry.assert === undefined ? [] : normalizeAssert(entry.assert);
    const silences = entry.silence === undefined ? [] : [normalizeSilence(entry.silence)];
    const folders = steps.filter((step) => step.definition.scope === "directory");

    if (steps.length === 0 && asserts.length === 0 && silences.length === 0) {
        throw new OperationParamsError("An entry needs an operation, an 'assert' or a 'silence'.");
    }

    if (folders.length > 0 && folders.length !== steps.length) {
        throw new OperationParamsError("'ensureDirectoryExists' goes in an entry of its own.");
    }

    if (entry.file === undefined && (folders.length === 0 || asserts.length > 0 || silences.length > 0)) {
        throw new OperationParamsError("An entry needs a 'file' (only 'ensureDirectoryExists' goes without one).");
    }

    const settings: EntrySettings = { ...DEFAULT_SETTINGS };

    for (const setting of ENTRY_SETTINGS) {
        if (typeof entry[setting] === "boolean") settings[setting] = entry[setting];
    }

    return {
        file: entry.file as string | undefined,
        settings,
        steps,
        asserts,
        silences,
        recipe: entry.recipe as string | undefined,
    };
}

/**
 * An entry's identity: who declared it plus what it says (its file and its operations), hashed.
 * `occurrence` tells apart the same entry declared twice by the same declarer.
 */
export function entryIdentity(declarer: string, file: string, steps: readonly ResolvedOperation[], occurrence = 0): string {
    const said = stableStringify({
        declarer,
        file,
        steps: steps.map((step) => ({ op: step.definition.name, params: step.params })),
        occurrence,
    } as unknown as JsonValue);

    return createHash("sha256").update(said).digest("hex").slice(0, 24);
}

/** The plugin and contributor that added one item of the list. */
export interface ItemOwner {
    readonly plugin: string;
    readonly contributor: string;
}

/** The plugins whose contributors apply the project's own config files. */
const PROJECT_PLUGINS = new Set(["@sous-io/sous-plugin-config-files", "@sous-io/sous-plugin-confd"]);

/** How a declarer is named: the recipe, `project` for the project's config files, or the plugin. */
export function declarerLabel(owner: ItemOwner | undefined, recipe: string | undefined): string {
    if (recipe !== undefined) return recipe;
    if (owner === undefined) return "unknown";

    return PROJECT_PLUGINS.has(owner.plugin) ? "project" : owner.plugin;
}

function walkPatches(set: PatchSet, visit: (patch: Patch) => void): void {
    for (const item of set.patches) {
        if ("op" in item) visit(item as Patch);
        else walkPatches(item as PatchSet, visit);
    }
}

function samePath(a: readonly PathSegment[], b: readonly PathSegment[]): boolean {
    return a.length === b.length && a.every((segment, index) => segment === b[index]);
}

/**
 * Who added each item of a list in the config, by replaying every contributor's primitives in the
 * order they applied. Returns one owner per item, or `undefined` for the whole list when the replay
 * does not end at the list's length (a patch the replay does not understand).
 */
export function listOwners(contributions: readonly Contribution[], key: string, finalLength: number): (ItemOwner | undefined)[] | undefined {
    const target = parsePath(key);
    let owners: (ItemOwner | undefined)[] = [];

    for (const contribution of contributions) {
        const owner: ItemOwner = { plugin: contribution.plugin, contributor: contribution.contributor };

        walkPatches(contribution.patches, (patch) => {
            const at = parsePath(patch.path);

            if (samePath(at, target)) {
                switch (patch.op) {
                    case "insertAt": {
                        const index = patch.index === "end" ? owners.length : Math.min(patch.index, owners.length);

                        owners.splice(index, 0, owner);
                        break;
                    }
                    case "setIndex":
                        owners[patch.index] = owner;
                        break;
                    case "removeIndex":
                        owners.splice(patch.index, 1);
                        break;
                    default:
                        break;
                }

                return;
            }

            if ((patch.op === "setKey" || patch.op === "deleteKey") && isPathPrefix([...at, patch.key], target)) {
                if (patch.op === "deleteKey") {
                    owners = [];
                } else {
                    const value = getAtPath(patch.value, target.slice(at.length + 1));

                    owners = Array.isArray(value) ? value.map(() => owner) : [];
                }
            }
        });
    }

    return owners.length === finalLength ? owners : undefined;
}
