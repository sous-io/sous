import { describe, expect, it } from "vitest";
import { stateOf } from "../../../test/utils/ref-fixtures.js";
import { RangeSplitter } from "./range-splitter.js";

describe("RangeSplitter", () => {
  const splitter = new RangeSplitter();

  /**
   * The splitter should take a valid range off the end of the text.
   *
   * split("workflow/alpha@^1.2") // -> [{ rest: "workflow/alpha", range: "^1.2" }]
   */
  it("should read a version range", () => {
    const [out] = splitter.split(stateOf("workflow/alpha@^1.2"));
    expect(out).toMatchObject({ rest: "workflow/alpha", range: "^1.2" });
  });

  /**
   * The `@` of an SSH remote comes before a `/`, so it is never a range.
   *
   * split("git@github.com:o/r.git") // -> the same state
   */
  it("should not mistake an SSH remote's @ for a range", () => {
    const state = stateOf("git@github.com:o/r.git");
    expect(splitter.split(state)).toEqual([state]);
    const [out] = splitter.split(stateOf("git@github.com:o/r.git@^1"));
    expect(out).toMatchObject({ rest: "git@github.com:o/r.git", range: "^1" });
  });

  /**
   * An empty range and a second `@` are turned down with a reason.
   *
   * split("a@") // -> [] with the problem "not followed by a version range"
   */
  it("should turn down an empty range and a second @", () => {
    const empty = stateOf("a@");
    expect(splitter.split(empty)).toEqual([]);
    expect(empty.problems[0]).toContain("not followed by a version range");
    const twice = stateOf("a@1@2");
    expect(splitter.split(twice)).toEqual([]);
    expect(twice.problems[0]).toContain("at most one '@'");
  });

  /**
   * Text after the @ that is not a range stays in the text, with the reason
   * recorded.
   *
   * split("a/b@nope") // -> the same state, and a problem
   */
  it("should leave a range that is not one in the text", () => {
    const state = stateOf("a/b@nope");
    expect(splitter.split(state)).toEqual([state]);
    expect(state.problems[0]).toContain("is not a version range");
  });

  /**
   * Text with no @, or whose @ comes before the last slash, has no range.
   *
   * split("workflow") // -> the same state
   */
  it("should pass text with no range through unchanged", () => {
    const state = stateOf("workflow");
    expect(splitter.split(state)).toEqual([state]);
    const early = stateOf("a@b/c");
    expect(splitter.split(early)).toEqual([early]);
  });
});
