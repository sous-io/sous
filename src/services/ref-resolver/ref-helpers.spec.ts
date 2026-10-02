import { describe, expect, it } from "vitest";
import { getFirstRef, getRefsInString, isValidRef, pruneRefs } from "./ref-helpers.js";
import { RefSource } from "./source.js";
import { locationFor, locationFromUrl } from "./location.js";
import { GithubProvider } from "../../lib/repos/providers/github.js";

describe("ref helpers", () => {
  /**
   * isValidRef and getRefsInString use the shared resolver.
   *
   * isValidRef("w/a/x.md", Include) // -> true
   */
  it("should check and find refs with the shared resolver", () => {
    expect(isValidRef("w/a/x.md", RefSource.Include)).toBe(true);
    expect(isValidRef("w/a", RefSource.Include)).toBe(false);
    expect(getRefsInString("run 'w/a' now").map((entry) => entry.text)).toContain("w/a");
  });

  /**
   * getFirstRef returns the best ref of a result or of a written ref.
   *
   * getFirstRef("workflow/alpha")?.kind // -> "recipe"
   */
  it("should return the first ref", () => {
    expect(getFirstRef("workflow/alpha")?.kind).toBe("recipe");
    const result = { first: () => undefined } as never;
    expect(getFirstRef(result)).toBeUndefined();
  });

  /**
   * pruneRefs keeps refs by kind or by a test.
   *
   * pruneRefs(refs, ["namespace"]) // -> the namespaces
   */
  it("should keep refs by kind or by predicate", () => {
    const refs = [
      { kind: "namespace" as const, name: "a" },
      { kind: "envVar" as const, name: "B" },
    ];
    expect(pruneRefs(refs, ["namespace"])).toEqual([refs[0]]);
    expect(pruneRefs(refs, (ref) => ref.kind === "envVar")).toEqual([refs[1]]);
  });
});

describe("location helpers", () => {
  /**
   * locationFromUrl reads a configured URL into a location, and refuses a URL
   * no provider knows; locationFor refuses a repository path that is not one.
   *
   * locationFromUrl("https://github.com/o/r.git").identity // -> "github.com/o/r"
   */
  it("should build a location from a URL or from a provider and path", () => {
    expect(locationFromUrl("https://github.com/o/r.git")).toMatchObject({
      provider: "github",
      repoPath: "o/r",
      identity: "github.com/o/r",
    });
    expect(locationFromUrl("https://example.com/x")).toBeUndefined();
    expect(locationFor(new GithubProvider(), "github.com", "just-one")).toBeUndefined();
  });
});
