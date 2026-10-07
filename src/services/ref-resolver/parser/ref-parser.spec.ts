import { describe, expect, it } from "vitest";
import { builtInProviders } from "../../../lib/repos/providers/index.js";
import { printed } from "../../../test/utils/ref-fixtures.js";
import { EnvVarSplitter } from "./env-var-splitter.js";
import { LocationSplitter } from "./location-splitter.js";
import { NamePathSplitter } from "./name-path-splitter.js";
import { QuerySplitter } from "./query-splitter.js";
import { RangeSplitter } from "./range-splitter.js";
import { RefParser } from "./ref-parser.js";
import { BaseRefSplitter, type PartialRef } from "./partial-ref.js";
import { RepoQualifierSplitter } from "./repo-qualifier-splitter.js";

/** A parser with every splitter, given in a scrambled order. */
function makeParser(extra: BaseRefSplitter[] = []): RefParser {
  return new RefParser([
    new EnvVarSplitter(),
    new NamePathSplitter(),
    new RepoQualifierSplitter(),
    new LocationSplitter(builtInProviders()),
    new RangeSplitter(),
    new QuerySplitter(),
    ...extra,
  ]);
}

describe("RefParser", () => {
  const parser = makeParser();

  /**
   * The parser should return every reading of a bare word.
   *
   * parse("workflow")
   * // -> repo, namespace, recipe, variable and envVar readings
   */
  it("should return every reading of a bare word", () => {
    expect(printed(parser.parse("workflow"))).toEqual([
      "repo:workflow",
      "namespace:workflow",
      "recipe:workflow",
      "variable:workflow",
      "envVar:workflow",
    ]);
  });

  /**
   * The parser should run the splitters by their order whatever order it was
   * given them in, and combine a query, a range, a qualifier and names.
   *
   * parse("sous-recipes:workflow/alpha@^1.2?x=a%20b")
   * // -> a recipe in sous-recipes with range ^1.2 and vars { x: "a b" }
   */
  it("should combine the splitters in their order", () => {
    const [ref] = parser.parse("sous-recipes:workflow/alpha@^1.2?x=a%20b");
    expect(ref).toEqual({
      kind: "recipe",
      name: "alpha",
      namespace: {
        kind: "namespace",
        name: "workflow",
        repo: { kind: "repo", name: "sous-recipes" },
      },
      range: "^1.2",
      vars: { x: "a b" },
    });
  });

  /**
   * Text that could be a glob path holding `?` and `=` keeps both readings.
   *
   * parse("w/a/f?=1.md") // -> a recipeFile with a glob path
   */
  it("should keep the glob reading of a path that looks like it has a query", () => {
    const refs = parser.parse("w/a/f.md?x=1");
    expect(refs.map((ref) => ref.kind)).toEqual(["recipeFile", "recipeFile"]);
    expect(refs[0]).toMatchObject({ path: "f.md", vars: { x: "1" } });
    expect(refs[1]).toMatchObject({ path: "f.md?x=1", glob: true });
  });

  /**
   * A URL keeps its own query.
   *
   * parse("https://github.com/o/r/w/a?x=1") // -> no vars
   */
  it("should leave a URL's query to the URL", () => {
    const refs = parser.parse("https://github.com/o/r/w");
    expect(refs.every((ref) => ref.vars === undefined)).toBe(true);
  });

  /**
   * A plugin's splitter runs among the others by its order.
   *
   * parse("@@") with a splitter that reads "plugin" // -> its ref
   */
  it("should run an added splitter", () => {
    class PluginSplitter extends BaseRefSplitter {
      readonly order = 450;
      protected read(state: PartialRef): PartialRef[] {
        if (state.rest !== "plugin") return [state];
        return [{ ...state, rest: "", ref: { kind: "envVar", name: "FROM_PLUGIN" } }];
      }
    }
    expect(makeParser([new PluginSplitter()]).parse("plugin")[0]).toEqual({
      kind: "envVar",
      name: "FROM_PLUGIN",
    });
  });

  /**
   * Text that fits no form raises a ConfigError quoting the input and the
   * reason; several reasons are listed.
   *
   * parse("") // throws "must not be empty"
   */
  it("should raise an error that quotes the input and says why", () => {
    expect(() => parser.parse("")).toThrow(/must not be empty/);
    expect(() => parser.parse("   ")).toThrow(/must not be empty/);
    expect(() => parser.parse("@workflow")).toThrow(/no '@' prefix/);
    expect(() => parser.parse("~workflow")).toThrow(/no '~' prefix/);
    expect(() => parser.parse(42 as unknown as string)).toThrow(/must be a string/);
    expect(() => parser.parse("a:b:c")).toThrow(/Invalid ref 'a:b:c': a ref may carry at most one/);
    expect(() => parser.parse("a/b/c d")).toThrow(/holds a space/);
    expect(() => parser.parse("work-flow$")).toThrow(/Invalid ref 'work-flow\$'/);
  });
});
