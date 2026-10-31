/**
 * The small built-in splitters: the query, the version range, the `repo:` qualifier and the
 * environment variable name. The location and name/path splitters have files of their own.
 */

import type {} from "@sous-io/plugin-host/types";
import semver from "semver";
import { ENV_VAR_NAME, isGlobName, NAME_ANY_CASE } from "../names.js";
import type { RefSplitterEntity } from "../types.js";
import { finishRef, SCHEME, SCP, splitter } from "./partial-ref.js";

/** One pair of a query: a percent-encoded name, `=`, and a percent-encoded value. */
const PAIR = /^([A-Za-z0-9\-._~%+!*'(),:@/$]+)=([A-Za-z0-9\-._~%+!*'(),:@/$]*)$/;

/**
 * The decoded pairs of a query, or `undefined` when it is not a valid percent-encoded query.
 *
 * ```ts
 * decodeQuery("a=1&b=two%20words"); // -> { a: "1", b: "two words" }
 * decodeQuery("a=%zz");             // -> undefined
 * ```
 */
export function decodeQuery(query: string): Record<string, string> | undefined {
    if (query.length === 0) {
        return undefined;
    }

    const vars: Record<string, string> = {};

    for (const pair of query.split("&")) {
        const match = PAIR.exec(pair);

        if (match === null) {
            return undefined;
        }

        try {
            vars[decodeURIComponent(match[1]!.replace(/\+/g, " "))] = decodeURIComponent(match[2]!.replace(/\+/g, " "));
        } catch {
            return undefined;
        }
    }

    return vars;
}

/**
 * Takes a valid, percent-encoded query off the end of the text. A URL keeps its own query. When the
 * text before the `?` could also be a glob path holding a `?` and an `=`, both readings are kept.
 */
export const querySplitter: RefSplitterEntity = splitter("query", 10, (state) => {
    if (SCHEME.test(state.rest)) {
        return [state];
    }

    const mark = state.rest.lastIndexOf("?");

    if (mark <= 0) {
        return [state];
    }

    const vars = decodeQuery(state.rest.slice(mark + 1));

    if (vars === undefined) {
        return [state];
    }

    return [{ ...state, rest: state.rest.slice(0, mark), vars: { ...state.vars, ...vars } }, state];
});

/**
 * Takes a version range off the end of the text: whatever follows the last `@` after the last
 * `/`, so the `@` of an SSH remote is never mistaken for one. Text after the `@` that is not a
 * range stays, where a later splitter accepts it as part of a path or turns it down.
 */
export const rangeSplitter: RefSplitterEntity = splitter("range", 20, (state) => {
    const text = state.rest;
    const at = text.lastIndexOf("@");

    if (at === -1 || at < text.lastIndexOf("/")) {
        return [state];
    }

    const before = text.slice(0, at).trim();
    const range = text.slice(at + 1).trim();

    if (range.length === 0) {
        state.problems.push("the '@' is not followed by a version range.");

        return [];
    }

    if (before.includes("@") && !SCHEME.test(before) && !SCP.test(before)) {
        state.problems.push("a ref may carry at most one '@' version range.");

        return [];
    }

    if (semver.validRange(range) === null) {
        state.problems.push(
            `'${range}' is not a version range. Ranges follow npm's rules, such as '^1.2.0', ` +
                "'~2.1', '>=1.0.0 <2.0.0' or '*'.",
        );

        return [state];
    }

    return [{ ...state, rest: before, range }];
});

/**
 * Takes `sous-recipes:` off the front of the text and records the repository short name, which may
 * be a glob. A location, or text whose first `:` comes after a `/`, has no qualifier.
 */
export const repoQualifierSplitter: RefSplitterEntity = splitter("repo-qualifier", 40, (state, ctx) => {
    const text = state.rest;

    if (state.repo !== undefined || SCHEME.test(text) || SCP.test(text)) {
        return [state];
    }

    const match = /^([^:/\s]*):(.*)$/s.exec(text);

    if (match === null) {
        return [state];
    }

    const name = match[1]!;
    const rest = match[2]!;

    if (name.length === 0) {
        state.problems.push("the repo qualifier before ':' is empty.");

        return [];
    }

    if (rest.includes(":")) {
        state.problems.push("a ref may carry at most one 'repo:' qualifier.");

        return [];
    }

    if (!NAME_ANY_CASE.test(name) && !isGlobName(name, ctx.services.get("host.globs"))) {
        state.problems.push(`the repo qualifier '${name}' must be kebab-case: a letter, then letters, digits or hyphens.`);

        return [];
    }

    return [{ ...state, rest, repo: { kind: "repo", name } }];
});

/**
 * Any legal environment variable name is also read as one, whole: `_` is both the delimiter and an
 * identifier character, so a name is never split into scopes. The text stays unread for the other
 * splitters too, because `workflow` is a namespace as well.
 */
export const envVarSplitter: RefSplitterEntity = splitter("env-var", 50, (state) => {
    if (state.repo !== undefined || state.range !== undefined || !ENV_VAR_NAME.test(state.rest)) {
        return [state];
    }

    return [state, finishRef(state, { kind: "envVar", name: state.rest })];
});
