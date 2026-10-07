import { describe, expect, it } from "vitest";
import { stateOf } from "../../../test/utils/ref-fixtures.js";
import { decodeQuery, QuerySplitter } from "./query-splitter.js";

describe("decodeQuery()", () => {
  /**
   * decodeQuery should percent-decode every name and value of a valid query.
   *
   * decodeQuery("a=1&b=two%20words");
   * // -> { a: "1", b: "two words" }
   */
  it("should decode every pair", () => {
    expect(decodeQuery("a=1&b=two%20words&c=")).toEqual({ a: "1", b: "two words", c: "" });
  });

  /**
   * decodeQuery should refuse malformed percent-encoding and text that is not
   * a query string at all.
   *
   * decodeQuery("a=%zz"); // -> undefined
   */
  it("should return undefined for anything that is not a valid query", () => {
    expect(decodeQuery("a=%zz")).toBeUndefined();
    expect(decodeQuery("")).toBeUndefined();
    expect(decodeQuery("novalue")).toBeUndefined();
    expect(decodeQuery("a=b c")).toBeUndefined();
    expect(decodeQuery("a={x}")).toBeUndefined();
  });
});

describe("QuerySplitter", () => {
  const splitter = new QuerySplitter();

  /**
   * The splitter should take a valid query off the end and keep both readings,
   * because the text before the `?` could also be a glob path.
   *
   * split("workflow/alpha?x=1")
   * // -> [{ rest: "workflow/alpha", vars: { x: "1" } }, { rest: "workflow/alpha?x=1" }]
   */
  it("should read a query and keep the unsplit reading too", () => {
    const out = splitter.split(stateOf("workflow/alpha?x=1&y=a%20b"));
    expect(out.map((state) => state.rest)).toEqual([
      "workflow/alpha",
      "workflow/alpha?x=1&y=a%20b",
    ]);
    expect(out[0]!.vars).toEqual({ x: "1", y: "a b" });
    expect(out[1]!.vars).toBeUndefined();
  });

  /**
   * A URL's own query belongs to the URL, so the splitter should leave any
   * text that starts with a scheme alone.
   *
   * split("https://github.com/o/r?x=1") // -> the same state
   */
  it("should leave a URL's query alone", () => {
    const state = stateOf("https://github.com/o/r?x=1");
    expect(splitter.split(state)).toEqual([state]);
  });

  /**
   * Malformed percent-encoding means there is no query reading; the state
   * passes through unchanged.
   *
   * split("a/b?x=%zz") // -> the same state
   */
  it("should pass a malformed query through unchanged", () => {
    const state = stateOf("a/b?x=%zz");
    expect(splitter.split(state)).toEqual([state]);
  });

  /**
   * Text with no `?`, or with the `?` first, has no query.
   *
   * split("workflow") // -> the same state
   */
  it("should pass text with no query through unchanged", () => {
    const plain = stateOf("workflow");
    const leading = stateOf("?x=1");
    expect(splitter.split(plain)).toEqual([plain]);
    expect(splitter.split(leading)).toEqual([leading]);
  });

  /**
   * A finished reading is never read again.
   *
   * split(finished) // -> the same state
   */
  it("should leave a finished reading alone", () => {
    const done = stateOf("", { ref: { kind: "envVar", name: "X" } });
    expect(splitter.split(done)).toEqual([done]);
  });
});
