/**
 * Reads the names and paths of a ref: the namespace, the recipe, the path of a file inside a
 * recipe, and the name of a variable after a `.`.
 */

import type { HostGlobs } from "@sous-io/plugin-host/types";
import { ENV_VAR_NAME, isGlobName, NAME_ANY_CASE, splitSegments, VARIABLE_NAME } from "../names.js";
import type { NamespaceRef, PartialRef, RecipeRef, RefSplitterEntity, SousRef } from "../types.js";
import { finishRef, splitter } from "./partial-ref.js";

/** The characters a path inside a recipe may use: anything but whitespace and a backslash. */
const FILE_PATH = /^[^\s\\]+$/;

/** The sentence for a range that has nothing to apply to. */
const NAMESPACE_NOT_VERSIONED =
    "a version range applies to a recipe, and namespaces are not versioned. Name a " +
    "recipe, as in 'workflow/task-files@^1.2.0'.";

/** What reading names needs: glob syntax, as `host.globs` decides it, and where readings go. */
interface Reader {
    state: PartialRef;
    globs: Pick<HostGlobs, "hasGlob">;
    make(ref: SousRef): void;
    ns(name: string): NamespaceRef;
}

/** True when a segment is a name (in any case) or a glob pattern standing for one. */
function isName(reader: Reader, segment: string): boolean {
    return NAME_ANY_CASE.test(segment) || isGlobName(segment, reader.globs);
}

/** True when a segment is a variable name or a glob pattern standing for one. */
function isVariableName(reader: Reader, segment: string): boolean {
    return VARIABLE_NAME.test(segment) || isGlobName(segment, reader.globs);
}

/** The sentence for a name that is not one. */
function badName(what: string, name: string): string {
    return `the ${what} '${name}' must be kebab-case: a letter, then letters, digits or hyphens.`;
}

/** `{ glob: true }` when any of the names is a pattern. */
function withGlob(reader: Reader, names: string[]): { glob?: true } {
    return names.some((name) => reader.globs.hasGlob(name)) ? { glob: true } : {};
}

/** Reads one segment: a namespace, a recipe, a repository, a variable, or `recipe.variable`. */
function readOne(reader: Reader, text: string): void {
    const { state, make, ns } = reader;
    const { repo, range } = state;
    const dot = text.indexOf(".");
    // A location names a repository, so only a namespace can follow it here.
    const located = repo?.location !== undefined;
    const inRepo = repo === undefined ? {} : { repo };

    if (!located && dot > 0 && dot < text.length - 1 && range === undefined) {
        const left = text.slice(0, dot);
        const right = text.slice(dot + 1);

        if (isName(reader, left) && isVariableName(reader, right)) {
            make({ kind: "variable", name: right, recipe: { kind: "recipe", name: left, ...inRepo }, ...withGlob(reader, [left, right]) });
        }
    }

    if (isName(reader, text)) {
        if (range === undefined) {
            make({ ...ns(text), ...withGlob(reader, [text]) });

            if (repo === undefined) {
                make({ kind: "repo", name: text, ...withGlob(reader, [text]) });
            }
        } else {
            state.problems.push(NAMESPACE_NOT_VERSIONED);
        }

        if (!located) {
            make({ kind: "recipe", name: text, ...inRepo, ...(range === undefined ? {} : { range }), ...withGlob(reader, [text]) });
        }
    }

    if (!located && range === undefined && isVariableName(reader, text)) {
        make({ kind: "variable", name: text, ...inRepo, ...withGlob(reader, [text]) });
    }

    const readsAsOther = repo === undefined && (VARIABLE_NAME.test(text) || ENV_VAR_NAME.test(text));

    if (!isName(reader, text) && !readsAsOther && dot <= 0) {
        state.problems.push(badName("namespace", text));
    }
}

/** Reads `namespace/second`: a recipe, `namespace/*`, or `namespace/recipe.variable`. */
function readTwo(reader: Reader, namespace: string, second: string): void {
    const { state, make, ns } = reader;
    const { range } = state;
    const dot = second.indexOf(".");

    if (second === "*") {
        if (range === undefined) {
            make({ ...ns(namespace), wildcard: true, ...withGlob(reader, [namespace]) });
        } else {
            state.problems.push(NAMESPACE_NOT_VERSIONED);
        }
    }

    if (dot > 0 && dot < second.length - 1 && range === undefined) {
        const left = second.slice(0, dot);
        const right = second.slice(dot + 1);

        if (isName(reader, left) && isVariableName(reader, right)) {
            make({
                kind: "variable",
                name: right,
                recipe: { kind: "recipe", name: left, namespace: ns(namespace) },
                ...withGlob(reader, [namespace, left, right]),
            });
        }
    }

    if (isName(reader, second)) {
        make({
            kind: "recipe",
            name: second,
            namespace: ns(namespace),
            ...(range === undefined ? {} : { range }),
            ...withGlob(reader, [namespace, second]),
        });
    } else if (dot <= 0) {
        state.problems.push(badName("recipe name", second));
    }
}

/**
 * Splits what is left of the text at `/` and reads it every way it can be read:
 *
 *     workflow                      a namespace, a recipe, a repository or a variable
 *     workflow/alpha                a recipe
 *     workflow/*                    a namespace spelled out
 *     task-files.apiUrl             a variable of a recipe
 *     workflow/alpha.apiUrl         a variable of a recipe in a namespace
 *     workflow/alpha/SKILL.md       a file inside a recipe
 *
 * Any name or path may be a glob pattern. The text is also left unread, so the environment
 * variable splitter may read the same word.
 */
export const namePathSplitter: RefSplitterEntity = splitter("name-path", 60, (state, ctx) => {
    const segments = splitSegments(state.rest);
    const out: PartialRef[] = [state];
    const make = (ref: SousRef): void => {
        out.push(finishRef(state, ref));
    };
    const repo = state.repo;
    const ns = (name: string): NamespaceRef => ({ kind: "namespace", name, ...(repo === undefined ? {} : { repo }) });
    const reader: Reader = { state, globs: ctx.services.get("host.globs"), make, ns };

    if (segments[0] === "") {
        state.problems.push("the namespace is empty.");

        return out;
    }

    if (segments.length > 1 && segments.includes("")) {
        state.problems.push(segments[segments.length - 1] === "" ? "the recipe name after '/' is empty." : "a ref has an empty segment between two '/'.");

        return out;
    }

    if (segments.length === 1) {
        readOne(reader, segments[0]!);

        return out;
    }

    const [namespace, second] = segments as [string, string, ...string[]];

    if (!isName(reader, namespace)) {
        state.problems.push(badName("namespace", namespace));

        return out;
    }

    if (segments.length === 2) {
        readTwo(reader, namespace, second);

        return out;
    }

    const path = segments.slice(2).join("/");

    if (!isName(reader, second)) {
        state.problems.push(badName("recipe name", second));

        return out;
    }

    if (!FILE_PATH.test(path)) {
        state.problems.push(`the path '${path}' inside a recipe holds a space or a backslash.`);

        return out;
    }

    const recipe: RecipeRef = { kind: "recipe", name: second, namespace: ns(namespace) };

    make({
        kind: "recipeFile",
        path,
        recipe,
        ...(state.range === undefined ? {} : { range: state.range }),
        ...withGlob(reader, [namespace, second, path]),
    });

    return out;
});
