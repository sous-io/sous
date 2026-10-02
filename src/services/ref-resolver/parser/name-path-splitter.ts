/**
 * Reads the names and paths of a ref: the namespace, the recipe, the path of a
 * file inside a recipe, and the name of a variable after a `.`.
 */

import { makeInjectable } from "../injectable.js";
import {
  ENV_VAR_NAME,
  hasGlob,
  isGlobName,
  NAME_ANY_CASE,
  splitSegments,
  VARIABLE_NAME,
} from "../glob.js";
import type { NamespaceRef, RecipeRef, SousRef } from "../types.js";
import { BaseRefSplitter, finishRef, type PartialRef } from "./partial-ref.js";

/** The characters a path inside a recipe may use: anything but whitespace and a backslash. */
const FILE_PATH = /^[^\s\\]+$/;

/** True when a segment is a name (in any case) or a glob pattern standing for one. */
function isName(segment: string): boolean {
  return NAME_ANY_CASE.test(segment) || isGlobName(segment);
}

/** The sentence for a name that is not one. */
function badName(what: string, name: string): string {
  return `the ${what} '${name}' must be kebab-case: a letter, then letters, digits or hyphens.`;
}

/** The sentence for a range that has nothing to apply to. */
const NAMESPACE_NOT_VERSIONED =
  "a version range applies to a recipe, and namespaces are not versioned. Name a " +
  "recipe, as in 'workflow/task-files@^1.2.0'.";

/**
 * Splits what is left of the text at `/` and reads it every way it can be
 * read:
 *
 *     workflow                      a namespace, a recipe, a repository or a variable
 *     workflow/alpha                a recipe
 *     workflow/*                    a namespace spelled out, and every recipe in it
 *     task-files.apiUrl             a variable of a recipe
 *     workflow/alpha.apiUrl         a variable of a recipe in a namespace
 *     workflow/alpha/SKILL.md       a file inside a recipe
 *
 * Any name or path may be a glob pattern. The text is also left unread, so the
 * environment variable splitter may read the same word.
 */
export class NamePathSplitter extends BaseRefSplitter {
  readonly order = 500;

  protected read(state: PartialRef): PartialRef[] {
    const segments = splitSegments(state.rest);
    const out: PartialRef[] = [state];
    const make = (ref: SousRef): void => {
      out.push(finishRef(state, ref));
    };

    if (segments[0] === "") {
      state.problems.push("the namespace is empty.");
      return out;
    }
    const last = segments[segments.length - 1];
    if (segments.length > 1 && segments.includes("")) {
      state.problems.push(
        last === ""
          ? "the recipe name after '/' is empty."
          : "a ref has an empty segment between two '/'."
      );
      return out;
    }

    const repo = state.repo;
    const range = state.range;
    const withGlob = (names: string[]) => (names.some(hasGlob) ? { glob: true as const } : {});
    const ns = (name: string): NamespaceRef => ({
      kind: "namespace",
      name,
      ...(repo === undefined ? {} : { repo }),
    });

    if (segments.length === 1) {
      const text = segments[0]!;
      const dot = text.indexOf(".");
      // A location names a repository, so only a namespace can follow it here.
      const located = repo?.location !== undefined;

      if (!located && dot > 0 && dot < text.length - 1) {
        const left = text.slice(0, dot);
        const right = text.slice(dot + 1);
        if (isName(left) && (VARIABLE_NAME.test(right) || isGlobName(right))) {
          if (range === undefined) {
            make({
              kind: "variable",
              name: right,
              recipe: {
                kind: "recipe",
                name: left,
                ...(repo === undefined ? {} : { repo }),
              },
              ...withGlob([left, right]),
            });
          }
        }
      }

      if (isName(text)) {
        if (range === undefined) {
          make({ ...ns(text), ...withGlob([text]) });
          if (repo === undefined) make({ kind: "repo", name: text, ...withGlob([text]) });
        } else {
          state.problems.push(NAMESPACE_NOT_VERSIONED);
        }
        if (!located) {
          make({
            kind: "recipe",
            name: text,
            ...(repo === undefined ? {} : { repo }),
            ...(range === undefined ? {} : { range }),
            ...withGlob([text]),
          });
        }
      }
      if (!located && range === undefined && (VARIABLE_NAME.test(text) || isGlobName(text))) {
        make({
          kind: "variable",
          name: text,
          ...(repo === undefined ? {} : { repo }),
          ...withGlob([text]),
        });
      }
      const readsAsOther =
        repo === undefined && (VARIABLE_NAME.test(text) || ENV_VAR_NAME.test(text));
      if (!isName(text) && !readsAsOther && dot <= 0) {
        state.problems.push(badName("namespace", text));
      }
      return out;
    }

    const [namespace, second] = segments as [string, string, ...string[]];
    if (!isName(namespace)) {
      state.problems.push(badName("namespace", namespace));
      return out;
    }

    if (segments.length === 2) {
      const dot = second.indexOf(".");
      if (second === "*") {
        if (range === undefined) make({ ...ns(namespace), wildcard: true, ...withGlob([namespace]) });
        else state.problems.push(NAMESPACE_NOT_VERSIONED);
      }
      if (dot > 0 && dot < second.length - 1 && range === undefined) {
        const left = second.slice(0, dot);
        const right = second.slice(dot + 1);
        if (isName(left) && (VARIABLE_NAME.test(right) || isGlobName(right))) {
          make({
            kind: "variable",
            name: right,
            recipe: { kind: "recipe", name: left, namespace: ns(namespace) },
            ...withGlob([namespace, left, right]),
          });
        }
      }
      if (isName(second)) {
        make({
          kind: "recipe",
          name: second,
          namespace: ns(namespace),
          ...(range === undefined ? {} : { range }),
          ...withGlob([namespace, second]),
        });
      } else if (dot <= 0) {
        state.problems.push(badName("recipe name", second));
      }
      return out;
    }

    const path = segments.slice(2).join("/");
    if (!isName(second)) {
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
      ...(range === undefined ? {} : { range }),
      ...withGlob([namespace, second, path]),
    });
    return out;
  }
}

makeInjectable(NamePathSplitter);
