/**
 * Reading one expression object into a plan: a computed value (`$expr`), or a chain of branches
 * with an optional `$else` (S5). Every form S5 lists is accepted here, and every shape error S5
 * lists (1 to 4) is thrown here, naming the file and the key path.
 */

import type { JsonValue, PathSegment } from "@sous-io/plugin-api";
import { ExpressionError } from "./errors.js";
import { chainOrder, isPlainObject, parseReservedKey, type ReservedKey } from "./keys.js";

/** One expression string, and where it was written. */
export interface ExpressionSource {
    /** The language named by a qualifier, or `undefined` for the default. */
    readonly language: string | undefined;
    readonly source: string;
    /** The key path of the expression string itself, for errors. */
    readonly path: readonly PathSegment[];
}

/** A value written in an expression object (`then`, `$else`), and where. */
export interface WrittenValue {
    readonly value: JsonValue;
    readonly path: readonly PathSegment[];
}

/** One branch. With no `condition`, it is a fallback (S5, "Arrays"). */
export interface Branch {
    readonly condition: ExpressionSource | undefined;
    readonly then: WrittenValue | undefined;
}

/** What an expression object says. */
export type Plan =
    | { readonly kind: "value"; readonly expression: ExpressionSource }
    | { readonly kind: "chain"; readonly branches: readonly Branch[]; readonly otherwise: WrittenValue | undefined };

type ChainKey = Extract<ReservedKey, { kind: "if" | "elseif" }>;

/** Reads an expression object. `path` is the key path of the object itself. */
export function parseExpressionObject(object: Record<string, JsonValue>, path: readonly PathSegment[], file: string): Plan {
    const exprKeys: Array<Extract<ReservedKey, { kind: "expr" }>> = [];
    const ifs: ChainKey[] = [];
    const elseifs: ChainKey[] = [];
    let hasElse = false;
    const stray: string[] = [];

    for (const key of Object.keys(object)) {
        const reserved = parseReservedKey(key);

        if (!reserved) {
            stray.push(key);
        } else if (reserved.kind === "expr") {
            exprKeys.push(reserved);
        } else if (reserved.kind === "else") {
            hasElse = true;
        } else {
            (reserved.kind === "if" ? ifs : elseifs).push(reserved);
        }
    }

    const reservedKeys = Object.keys(object).filter((key) => !stray.includes(key));

    if (stray.length > 0) {
        throw new ExpressionError(
            file,
            path,
            `mixes the expression key ${quote(reservedKeys[0]!)} with ${list(stray)}, which ${stray.length === 1 ? "is" : "are"} not one.`,
            { details: ["An expression object holds only $expr, $if, $elseif and $else keys (with their qualifiers)."] },
        );
    }

    for (const key of [...ifs, ...elseifs]) {
        if (key.name === "") {
            throw new ExpressionError(file, [...path, key.key], "has an empty qualifier. Write a name after the colon, or leave the colon out.");
        }
    }

    if (exprKeys.length > 0) {
        if (exprKeys.length > 1) {
            throw new ExpressionError(file, path, `holds ${list(exprKeys.map((key) => key.key))}; write one.`);
        }

        if (ifs.length > 0 || elseifs.length > 0 || hasElse) {
            throw new ExpressionError(
                file,
                path,
                `holds ${quote(exprKeys[0]!.key)} together with ${list(reservedKeys.filter((key) => key !== exprKeys[0]!.key))}.`,
                { details: ["$expr computes one value; $if, $elseif and $else choose between values. Use one or the other."] },
            );
        }

        const key = exprKeys[0]!;

        return { kind: "value", expression: expressionAt(object[key.key]!, key.language, [...path, key.key], file) };
    }

    const keys = [...chainOrder(ifs), ...chainOrder(elseifs)];
    const branches: Branch[] = [];

    keys.forEach((key, index) => {
        const last = index === keys.length - 1;

        branches.push(...parseBranches(object[key.key]!, [...path, key.key], { last, hasElse }, file));
    });

    return {
        kind: "chain",
        branches,
        otherwise: hasElse ? { value: object.$else!, path: [...path, "$else"] } : undefined,
    };
}

/** Where a key sits in its chain, which decides whether a fallback is allowed in it. */
interface ChainPlace {
    /** The last `$if`/`$elseif` key of the chain. */
    readonly last: boolean;
    /** The chain holds an `$else`. */
    readonly hasElse: boolean;
}

/** The branches one `$if` or `$elseif` key holds: a string, a block, or an array of either. */
function parseBranches(value: JsonValue, path: readonly PathSegment[], place: ChainPlace, file: string): Branch[] {
    if (typeof value === "string") {
        return [{ condition: expressionAt(value, undefined, path, file), then: undefined }];
    }

    if (Array.isArray(value)) {
        return value.map((item, index) => {
            const itemPath = [...path, index];
            const branch = typeof item === "string" ? { condition: expressionAt(item, undefined, itemPath, file), then: undefined } : parseBlock(item, itemPath, file);

            if (branch.condition === undefined) {
                checkFallback(itemPath, index === value.length - 1, place, file);
            }

            return branch;
        });
    }

    const branch = parseBlock(value, path, file);

    if (branch.condition === undefined) {
        throw new ExpressionError(file, path, "has no expr. A branch block needs one; only an array item may leave it out, as a fallback.");
    }

    return [branch];
}

/** Throws unless a fallback item sits where S5 allows one: last item, last key, no `$else`. */
function checkFallback(path: readonly PathSegment[], lastItem: boolean, place: ChainPlace, file: string): void {
    if (place.hasElse) {
        throw new ExpressionError(file, path, "is a fallback (an item with no expr), and the chain also has an $else. Keep one of them.");
    }

    if (!lastItem || !place.last) {
        throw new ExpressionError(
            file,
            path,
            "is a fallback (an item with no expr), which is only allowed as the last item of the last key in the chain.",
        );
    }
}

/** One branch block: `expr` (or `$expr`, either with `:<language>`) and `then` (or `$then`). */
function parseBlock(value: JsonValue, path: readonly PathSegment[], file: string): Branch {
    if (!isPlainObject(value)) {
        throw new ExpressionError(file, path, `is ${describe(value)}. A branch is a string, a block with expr and then, or an array of those.`);
    }

    const exprKeys: string[] = [];
    const thenKeys: string[] = [];
    const unknown: string[] = [];

    for (const key of Object.keys(value)) {
        if (/^\$?expr(:.*)?$/s.test(key)) {
            exprKeys.push(key);
        } else if (key === "then" || key === "$then") {
            thenKeys.push(key);
        } else {
            unknown.push(key);
        }
    }

    if (unknown.length > 0) {
        throw new ExpressionError(file, path, `holds ${list(unknown)}. A branch block holds only expr (or $expr) and then (or $then).`);
    }

    if (exprKeys.length > 1) {
        throw new ExpressionError(file, path, `holds both ${list(exprKeys, "and")}. Write one.`);
    }

    if (thenKeys.length > 1) {
        throw new ExpressionError(file, path, `holds both "then" and "$then". Write one.`);
    }

    if (exprKeys.length === 0 && thenKeys.length === 0) {
        throw new ExpressionError(file, path, "is an empty branch block. Give it an expr, a then, or both.");
    }

    const exprKey = exprKeys[0];
    const thenKey = thenKeys[0];
    const language = exprKey === undefined ? undefined : qualifierOf(exprKey);

    return {
        condition: exprKey === undefined ? undefined : expressionAt(value[exprKey]!, language, [...path, exprKey], file),
        then: thenKey === undefined ? undefined : { value: value[thenKey]!, path: [...path, thenKey] },
    };
}

/** The language after `expr:` or `$expr:`, or `undefined`. */
function qualifierOf(key: string): string | undefined {
    const colon = key.indexOf(":");

    return colon === -1 ? undefined : key.slice(colon + 1);
}

/** An expression string, checked. */
function expressionAt(value: JsonValue, language: string | undefined, path: readonly PathSegment[], file: string): ExpressionSource {
    if (language === "") {
        throw new ExpressionError(file, path, "has an empty language qualifier. Name the language after the colon, or leave the colon out.");
    }

    if (typeof value !== "string") {
        throw new ExpressionError(file, path, `is ${describe(value)}. An expression is a string.`);
    }

    return { language, source: value, path };
}

function describe(value: unknown): string {
    if (value === null) {
        return "null";
    }

    if (Array.isArray(value)) {
        return "an array";
    }

    return typeof value === "object" ? "an object" : `a ${typeof value} (${JSON.stringify(value)})`;
}

function quote(key: string): string {
    return JSON.stringify(key);
}

function list(keys: readonly string[], join = "and"): string {
    const quoted = keys.map(quote);

    return quoted.length <= 1 ? quoted.join("") : `${quoted.slice(0, -1).join(", ")} ${join} ${quoted.at(-1)}`;
}
