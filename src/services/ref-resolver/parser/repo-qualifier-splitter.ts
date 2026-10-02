/**
 * Reads the `repo:` qualifier at the front of a ref.
 */

import { makeInjectable } from "../injectable.js";
import { isGlobName, NAME_ANY_CASE } from "../glob.js";
import { BaseRefSplitter, type PartialRef } from "./partial-ref.js";

/** A URL that names its scheme, such as `https://` or `github://`. */
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/** The `scp`-style SSH form, as in `git@github.com:owner/name.git`. */
const SCP = /^[^@\s/:]+@([^@\s/:]+):(.+)$/s;

/**
 * Takes `sous-recipes:` off the front of the text and records the repository
 * short name it names. The name may be a glob. Text that is a location, or
 * whose first `:` comes after a `/`, has no qualifier.
 */
export class RepoQualifierSplitter extends BaseRefSplitter {
  readonly order = 400;

  protected read(state: PartialRef): PartialRef[] {
    const text = state.rest;
    if (state.repo !== undefined || SCHEME.test(text) || SCP.test(text)) return [state];

    const match = /^([^:/\s]*):(.*)$/s.exec(text);
    if (match === null) return [state];
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
    if (!NAME_ANY_CASE.test(name) && !isGlobName(name)) {
      state.problems.push(
        `the repo qualifier '${name}' must be kebab-case: a letter, then letters, digits ` +
          "or hyphens."
      );
      return [];
    }
    return [{ ...state, rest, repo: { kind: "repo", name } }];
  }
}

makeInjectable(RepoQualifierSplitter);
