/**
 * `refs.parser`: the one place a written ref becomes every reading it could have.
 *
 * It is context free: it never asks where the ref was written (a pruner's job) or what exists (a
 * lookup's). Some forms read more than one way: a bare `workflow` is a namespace, a recipe, a
 * repository, a variable and an environment variable name.
 *
 * The parser runs the `ref-splitter` entities by their `order`. Each reads what it recognizes of
 * the remaining text and returns every way to read it; every reading goes through every splitter,
 * and the readings that end with a finished ref and no text left are kept. A plugin adds a form by
 * adding a splitter.
 */

import { ConfigError, type ServiceContext } from "@sous-io/plugin-api";
import { REF_KINDS } from "../parts.js";
import type { PartialRef, RefParseResult, RefSplitterEntity, RefsParser, SousRef } from "../types.js";

/** The forms a ref may take, for the reminder under a ref that does not parse. */
export const SYNTAX_HELP =
    "A ref is written as 'namespace', 'namespace/recipe', 'repo:namespace/recipe', " +
    "'namespace/recipe/path/to/file.md', 'namespace/recipe.variable', an environment variable " +
    "name, any of those with '@<range>' or '?name=value', or a location such as " +
    "'github://owner/repository/namespace/recipe' or a URL copied from the browser.";

/** Why text cannot be a ref before any splitter looks at it, or `undefined`. */
function earlyProblem(input: unknown): string | undefined {
    if (typeof input !== "string") {
        return "a ref must be a string.";
    }

    const trimmed = input.trim();

    if (trimmed.length === 0) {
        return "a ref must not be empty.";
    }

    if (trimmed.startsWith("@")) {
        return "refs take no '@' prefix. The '@' character introduces a version range only, as in 'workflow/task-files@^1.2.0'.";
    }

    if (trimmed.startsWith("~")) {
        return (
            "refs take no '~' prefix. The '~' sigil belongs to template include lines " +
            "('@~workflow/file.md'); a ref itself is written without it."
        );
    }

    return undefined;
}

/** The finished readings, each once, in kind order and then in the order the splitters made them. */
function finished(states: readonly PartialRef[]): SousRef[] {
    const seen = new Set<string>();
    const refs: SousRef[] = [];

    for (const state of states) {
        if (state.ref === undefined || state.rest !== "") {
            continue;
        }

        const key = JSON.stringify(state.ref);

        if (!seen.has(key)) {
            seen.add(key);
            refs.push(state.ref);
        }
    }

    return refs
        .map((ref, position) => ({ ref, position }))
        .sort((left, right) => REF_KINDS.indexOf(left.ref.kind) - REF_KINDS.indexOf(right.ref.kind) || left.position - right.position)
        .map((entry) => entry.ref);
}

/**
 * Parses with the splitters given, in their `order`.
 *
 * ```ts
 * parseWith(splitters, "workflow/alpha@^1.2", ctx).readings;
 * // -> [{ kind: "recipe", name: "alpha", namespace: { kind: "namespace", name: "workflow" }, range: "^1.2" }]
 * ```
 */
export function parseWith(splitters: readonly RefSplitterEntity[], input: string, ctx: ServiceContext): RefParseResult {
    const early = earlyProblem(input);

    if (early !== undefined) {
        return { input: String(input), readings: [], problems: [early] };
    }

    const trimmed = input.trim();
    const problems: string[] = [];
    const ordered = [...splitters].sort((left, right) => left.order - right.order);
    let states: PartialRef[] = [{ input: trimmed, rest: trimmed, problems }];

    for (const entry of ordered) {
        states = states.flatMap((state) => entry.split(state, ctx));

        if (states.length === 0) {
            break;
        }
    }

    return { input, readings: finished(states), problems: [...new Set(problems)] };
}

/**
 * The `ConfigError` for text that reads no way at all, quoting it, the reasons and the forms.
 *
 * ```ts
 * parseError({ input: "a:b:c", readings: [], problems: ["a ref may carry at most one 'repo:' qualifier."] });
 * // -> "Invalid ref 'a:b:c': a ref may carry at most one 'repo:' qualifier."
 * ```
 */
export function parseError(result: RefParseResult): ConfigError {
    const reasons = result.problems;
    let problem: string;

    if (reasons.length === 0) {
        problem = "it does not fit any form of a ref.";
    } else if (reasons.length === 1) {
        problem = reasons[0]!;
    } else {
        problem = `it fits no form of a ref:\n${reasons.map((reason) => `    ${reason}`).join("\n")}`;
    }

    return new ConfigError(`Invalid ref '${result.input}': ${problem}`, { details: [SYNTAX_HELP] });
}

/** Makes `refs.parser` over the `ref-splitter` entities of a build. */
export function createRefsParser(ctx: ServiceContext): RefsParser {
    return {
        parse: (input) => parseWith(ctx.entities.list("ref-splitter"), input, ctx),
    };
}
