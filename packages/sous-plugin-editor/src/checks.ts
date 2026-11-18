/**
 * The checks an assertion is made of (spec 08). Each is defined ONCE here; the `assert` data form,
 * the `expect(...)` chain and the automatic assertions all use these definitions.
 */

import { deepEqual, isJsonObject, parseLines, stableStringify, type JsonValue } from "@sous-io/sous-lib-documents";
import { commentStyleFor, linesOfText } from "./documents-adapter.js";

/** What a check reads: the file as it is about to be written. */
export interface CheckSubject {
    /** The file (for messages). */
    readonly file: string;
    /** Whether the file will exist. */
    fileExists(): boolean;
    /** Whether a folder exists (the file's own path, for folder checks). */
    directoryExists(): boolean;
    /** Whether the document could be parsed. `false` for a missing file. */
    parsed(): boolean;
    /** The value at a path; `undefined` when missing. Only when {@link parsed}. */
    value(path: string): JsonValue | undefined;
    /** The text, `""` for a missing file. */
    text(): string;
    /** The size in tokens (`o200k_base`). */
    tokens(): Promise<number>;
}

/** How a check reads the file: its document, its text, its size, or whether it exists. */
export type CheckReads = "document" | "text" | "size" | "existence";

/** One check. */
export interface CheckDefinition {
    readonly name: string;
    readonly reads: CheckReads;
    /** For a check whose argument is `true` or `false`: `false` turns it around. */
    readonly boolean?: boolean;
    /** Whether the check holds. */
    evaluate(subject: CheckSubject, arg: JsonValue, path: string): boolean | Promise<boolean>;
    /** What the author expects, finishing "expects it to ...": `include "x"`. */
    describe(arg: JsonValue): string;
}

/** A value as it is shown in a message: JSON. */
export function show(value: JsonValue | undefined): string {
    return value === undefined ? "nothing" : JSON.stringify(value);
}

/** Whether `actual` contains `expected`: an object's keys, deeply; a list's items; a string's text. */
export function contains(actual: JsonValue | undefined, expected: JsonValue): boolean {
    if (Array.isArray(actual)) {
        return actual.some((item) => deepEqual(item, expected) || (isJsonObject(expected) && isJsonObject(item) && isSubset(item, expected)));
    }

    if (typeof actual === "string") {
        return typeof expected === "string" && actual.includes(expected);
    }

    if (isJsonObject(actual) && isJsonObject(expected)) {
        return isSubset(actual, expected);
    }

    return false;
}

/** Whether `expected` is inside `actual`: every key of an object, every item of a list. */
export function isSubset(actual: JsonValue | undefined, expected: JsonValue): boolean {
    if (isJsonObject(expected)) {
        return isJsonObject(actual) && Object.entries(expected).every(([key, value]) => Object.hasOwn(actual, key) && isSubset(actual[key], value));
    }

    if (Array.isArray(expected) && Array.isArray(actual)) {
        return expected.every((item) => actual.some((candidate) => deepEqual(candidate, item)));
    }

    return deepEqual(actual, expected);
}

/** Whether an item has every field of `match`. */
export function matchesFields(item: JsonValue | undefined, match: JsonValue): boolean {
    return isJsonObject(item) && isJsonObject(match) && Object.entries(match).every(([key, value]) => deepEqual(item[key], value));
}

/** How a list is ordered: by the whole item, or by one field; ascending unless `descending`. */
export interface SortOptions {
    by?: string;
    descending?: boolean;
}

/** Reads sort options from `true`, a field name, or `{ by, descending }`. */
export function sortOptions(arg: JsonValue | undefined): SortOptions {
    if (typeof arg === "string") return { by: arg };
    if (isJsonObject(arg)) {
        return {
            ...(typeof arg.by === "string" ? { by: arg.by } : {}),
            ...(arg.descending === true ? { descending: true } : {}),
        };
    }

    return {};
}

/** Compares two items for sorting: numbers by value, strings by code point, anything else as JSON. */
export function compareItems(a: JsonValue | undefined, b: JsonValue | undefined, options: SortOptions = {}): number {
    const left = options.by !== undefined && isJsonObject(a) ? a[options.by] : a;
    const right = options.by !== undefined && isJsonObject(b) ? b[options.by] : b;
    let result: number;

    if (typeof left === "number" && typeof right === "number") {
        result = left - right;
    } else if (typeof left === "string" && typeof right === "string") {
        result = left < right ? -1 : left > right ? 1 : 0;
    } else {
        const l = stableStringify(left ?? null);
        const r = stableStringify(right ?? null);

        result = l < r ? -1 : l > r ? 1 : 0;
    }

    return options.descending ? -result : result;
}

/** Whether a list is in order. */
export function isSorted(items: readonly JsonValue[], options: SortOptions = {}): boolean {
    return items.every((item, index) => index === 0 || compareItems(items[index - 1], item, options) <= 0);
}

/** What makes two items the same for `unique` and `dedupe`: the item, or one field. */
export function fingerprint(item: JsonValue, by?: string): string {
    return stableStringify(by !== undefined && isJsonObject(item) ? (item[by] ?? null) : item);
}

/** The text of the value at a path, or the whole text at the root; `undefined` when there is none. */
function textAt(subject: CheckSubject, path: string): string | undefined {
    if (path === "") {
        return subject.fileExists() ? subject.text() : undefined;
    }

    if (!subject.parsed()) {
        return undefined;
    }

    const value = subject.value(path);

    return typeof value === "string" ? value : undefined;
}

/** The lines of the value at a path, or of the whole text at the root. */
export function linesOf(subject: CheckSubject, path: string): string[] | undefined {
    const text = textAt(subject, path);

    return text === undefined ? undefined : linesOfText(text);
}

/**
 * The lines inside a managed block, in the file's comment style; `undefined` when the block is
 * missing, or damaged (a marker line without its pair).
 */
function blockAt(subject: CheckSubject, path: string, name: string): string[] | undefined {
    const text = textAt(subject, path);

    if (text === undefined) {
        return undefined;
    }

    try {
        return parseLines(text, { comment: commentStyleFor(subject.file), label: subject.file }).block(name);
    } catch {
        return undefined;
    }
}

/** A regular expression from `"^a"` or `"/^a/i"`. */
export function toRegExp(pattern: string): RegExp {
    const literal = /^\/(.*)\/([dgimsuvy]*)$/s.exec(pattern);

    return literal ? new RegExp(literal[1]!, literal[2]) : new RegExp(pattern);
}

function textOf(arg: JsonValue): string {
    return typeof arg === "string" ? arg : JSON.stringify(arg);
}

function numberArg(arg: JsonValue): number {
    return typeof arg === "number" ? arg : Number(arg);
}

const sizeCheck = (name: string, measure: (subject: CheckSubject) => number | Promise<number>, max: boolean, unit: string): CheckDefinition => ({
    name,
    reads: "size",
    async evaluate(subject, arg) {
        if (!subject.fileExists()) {
            return false;
        }

        const size = await measure(subject);

        return max ? size <= numberArg(arg) : size >= numberArg(arg);
    },
    describe: (arg) => `hold ${max ? "at most" : "at least"} ${textOf(arg)} ${unit}`,
});

const valueComparison = (name: string, holds: (actual: number, expected: number) => boolean, words: string): CheckDefinition => ({
    name,
    reads: "document",
    evaluate(subject, arg, path) {
        const value = subject.value(path);

        return typeof value === "number" && holds(value, numberArg(arg));
    },
    describe: (arg) => `be ${words} ${textOf(arg)}`,
});

/** Every check, in the order the docs list them. */
const CHECK_LIST: CheckDefinition[] = [
        {
            name: "equals",
            reads: "document",
            evaluate: (subject, arg, path) => deepEqual(subject.value(path), arg),
            describe: (arg) => `equal ${show(arg)}`,
        },
        {
            name: "includes",
            reads: "document",
            evaluate: (subject, arg, path) => contains(subject.value(path), arg),
            describe: (arg) => `include ${show(arg)}`,
        },
        {
            name: "excludes",
            reads: "document",
            evaluate: (subject, arg, path) => !contains(subject.value(path), arg),
            describe: (arg) => `not include ${show(arg)}`,
        },
        {
            name: "exists",
            reads: "document",
            boolean: true,
            evaluate: (subject, _arg, path) => subject.value(path) !== undefined,
            describe: () => "exist",
        },
        {
            name: "first",
            reads: "document",
            evaluate(subject, arg, path) {
                const value = subject.value(path);

                return Array.isArray(value) && value.length > 0 && deepEqual(value[0], arg);
            },
            describe: (arg) => `have ${show(arg)} as its first member`,
        },
        {
            name: "last",
            reads: "document",
            evaluate(subject, arg, path) {
                const value = subject.value(path);

                return Array.isArray(value) && value.length > 0 && deepEqual(value[value.length - 1], arg);
            },
            describe: (arg) => `have ${show(arg)} as its last member`,
        },
        {
            name: "at",
            reads: "document",
            evaluate(subject, arg, path) {
                const value = subject.value(path);

                return Array.isArray(value) && isJsonObject(arg) && typeof arg.index === "number" && deepEqual(value[arg.index], arg.item);
            },
            describe: (arg) => (isJsonObject(arg) ? `have ${show(arg.item)} at index ${show(arg.index)}` : `have ${show(arg)} at an index`),
        },
        {
            name: "itemWhere",
            reads: "document",
            evaluate(subject, arg, path) {
                const value = subject.value(path);

                if (!Array.isArray(value) || !isJsonObject(arg)) {
                    return false;
                }

                const match = isJsonObject(arg.match) ? arg.match : arg;
                const found = value.find((item) => matchesFields(item, match));

                return found !== undefined && (arg.item === undefined || !isJsonObject(arg.match) || deepEqual(found, arg.item));
            },
            describe: (arg) =>
                isJsonObject(arg) && isJsonObject(arg.match)
                    ? `have an item matching ${show(arg.match)}${arg.item === undefined ? "" : ` equal to ${show(arg.item)}`}`
                    : `have an item matching ${show(arg)}`,
        },
        {
            name: "noItemWhere",
            reads: "document",
            evaluate(subject, arg, path) {
                const value = subject.value(path);

                return !Array.isArray(value) || !value.some((item) => matchesFields(item, arg));
            },
            describe: (arg) => `have no item matching ${show(arg)}`,
        },
        {
            name: "unique",
            reads: "document",
            boolean: true,
            evaluate(subject, arg, path) {
                const value = subject.value(path);
                const { by } = sortOptions(arg);

                if (!Array.isArray(value)) {
                    return false;
                }

                return new Set(value.map((item) => fingerprint(item, by))).size === value.length;
            },
            describe: () => "have unique members",
        },
        {
            name: "sorted",
            reads: "document",
            boolean: true,
            evaluate(subject, arg, path) {
                const value = subject.value(path);

                return Array.isArray(value) && isSorted(value, sortOptions(arg));
            },
            describe: (arg) => {
                const { by, descending } = sortOptions(arg);

                return `be sorted${by === undefined ? "" : ` by ${by}`}${descending ? ", descending" : ""}`;
            },
        },
        {
            name: "sortedKeys",
            reads: "document",
            boolean: true,
            evaluate(subject, _arg, path) {
                const value = subject.value(path);

                return isJsonObject(value) && isSorted(Object.keys(value));
            },
            describe: () => "have its keys in order",
        },
        {
            name: "type",
            reads: "document",
            evaluate(subject, arg, path) {
                const value = subject.value(path);
                const type = value === undefined ? "missing" : value === null ? "null" : Array.isArray(value) ? "array" : typeof value;

                return type === arg;
            },
            describe: (arg) => `be ${/^[aeiou]/.test(textOf(arg)) ? "an" : "a"} ${textOf(arg)}`,
        },
        {
            name: "matches",
            reads: "document",
            evaluate(subject, arg, path) {
                const value = subject.value(path);

                return typeof value === "string" && typeof arg === "string" && toRegExp(arg).test(value);
            },
            describe: (arg) => `match ${textOf(arg)}`,
        },
        {
            name: "includesLine",
            reads: "text",
            evaluate: (subject, arg, path) => linesOf(subject, path)?.includes(textOf(arg)) ?? false,
            describe: (arg) => `contain the line ${show(arg)}`,
        },
        {
            name: "includesBlock",
            reads: "text",
            evaluate(subject, arg, path) {
                const name = isJsonObject(arg) ? arg.name : arg;
                const block = typeof name === "string" ? blockAt(subject, path, name) : undefined;

                if (block === undefined) {
                    return false;
                }

                const content = isJsonObject(arg) && typeof arg.content === "string" ? linesOfText(arg.content) : undefined;

                return content === undefined || deepEqual(block, content);
            },
            describe: (arg) => `contain the managed block ${show(isJsonObject(arg) ? (arg.name ?? null) : arg)}`,
        },
        valueComparison("lessThan", (a, b) => a < b, "less than"),
        valueComparison("lessThanOrEqualTo", (a, b) => a <= b, "less than or equal to"),
        valueComparison("greaterThan", (a, b) => a > b, "greater than"),
        valueComparison("greaterThanOrEqualTo", (a, b) => a >= b, "greater than or equal to"),
        {
            name: "fileExists",
            reads: "existence",
            boolean: true,
            evaluate: (subject) => subject.fileExists(),
            describe: () => "exist",
        },
        {
            name: "fileDoesNotExist",
            reads: "existence",
            boolean: true,
            evaluate: (subject) => !subject.fileExists(),
            describe: () => "not exist",
        },
        {
            name: "directoryExists",
            reads: "existence",
            boolean: true,
            evaluate: (subject) => subject.directoryExists(),
            describe: () => "exist as a folder",
        },
        {
            name: "directoryDoesNotExist",
            reads: "existence",
            boolean: true,
            evaluate: (subject) => !subject.directoryExists(),
            describe: () => "not exist as a folder",
        },
        sizeCheck("maxBytes", (subject) => Buffer.byteLength(subject.text(), "utf8"), true, "bytes"),
        sizeCheck("minBytes", (subject) => Buffer.byteLength(subject.text(), "utf8"), false, "bytes"),
        sizeCheck("maxCharacters", (subject) => [...subject.text()].length, true, "characters"),
        sizeCheck("minCharacters", (subject) => [...subject.text()].length, false, "characters"),
        sizeCheck("maxTokens", (subject) => subject.tokens(), true, "tokens (o200k_base, approximate)"),
        sizeCheck("minTokens", (subject) => subject.tokens(), false, "tokens (o200k_base, approximate)"),
];

/** Every check, by name. */
export const CHECKS: ReadonlyMap<string, CheckDefinition> = new Map(CHECK_LIST.map((check) => [check.name, check]));

/**
 * The kind names silencing accepts for each check: its own name, and `include` for `includes`
 * (the plugin spelling, as in `.except(["include"])`).
 */
export function normalizeKind(kind: string): string {
    return kind === "include" ? "includes" : kind;
}

/** The keys of an `assert` object that are not checks. */
export const ASSERT_SETTINGS = new Set(["path", "level", "message", "not"]);

/**
 * Runs one check. A check that reads the document fails on a file that is missing or cannot be
 * parsed; a check on existence never needs the document.
 */
export async function runCheck(subject: CheckSubject, check: string, arg: JsonValue, path: string, not = false): Promise<boolean> {
    const definition = CHECKS.get(check);

    if (definition === undefined) {
        return false;
    }

    let negate = not;

    if (definition.boolean && arg === false) {
        negate = !negate;
    }

    if (definition.reads === "document" && !subject.parsed()) {
        return false;
    }

    const holds = await definition.evaluate(subject, arg, path);

    return negate ? !holds : holds;
}

/** "include "x"", or "not include "x"" when turned around, for a message. */
export function describeCheck(check: string, arg: JsonValue, not = false): string {
    const definition = CHECKS.get(check);
    const negate = definition?.boolean && arg === false ? !not : not;
    const text = definition?.describe(arg) ?? `${check} ${show(arg)}`;

    return negate ? `not ${text}` : text;
}
