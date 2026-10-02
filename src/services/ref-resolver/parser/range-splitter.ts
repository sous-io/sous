/**
 * Reads the `@^1.2` version range at the end of a ref.
 */

import { makeInjectable } from "../injectable.js";
import semver from "semver";
import { BaseRefSplitter, type PartialRef } from "./partial-ref.js";

/** A URL that names its scheme, such as `https://` or `github://`. */
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/** The `scp`-style SSH form, as in `git@github.com:owner/name.git`. */
const SCP = /^[^@\s/:]+@([^@\s/:]+):(.+)$/s;

/**
 * Takes a version range off the end of the text: whatever follows the last `@`
 * that comes after the last `/`, so the `@` of an SSH remote
 * (`git@host:owner/repo`) is never mistaken for one. A range that is not a
 * semantic version range is left in the text, where a later splitter either
 * accepts it as part of a path or turns it down.
 */
export class RangeSplitter extends BaseRefSplitter {
  readonly order = 200;

  protected read(state: PartialRef): PartialRef[] {
    const text = state.rest;
    const at = text.lastIndexOf("@");
    if (at === -1 || at < text.lastIndexOf("/")) return [state];

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
          "'~2.1', '>=1.0.0 <2.0.0' or '*'."
      );
      return [state];
    }
    return [{ ...state, rest: before, range }];
  }
}

makeInjectable(RangeSplitter);
