import { describe, expect, it } from "vitest";
import { builtInProviders } from "../../../lib/repos/providers/index.js";
import { stateOf } from "../../../test/utils/ref-fixtures.js";
import { LocationSplitter, looksLikeLocation } from "./location-splitter.js";

const splitter = new LocationSplitter(builtInProviders());

describe("looksLikeLocation()", () => {
  /**
   * A location carries a scheme, an SSH `user@host:` prefix, or a dotted first
   * segment; a short ref carries none of them.
   *
   * looksLikeLocation("github.com/o/r") // -> true
   */
  it("should tell a location from a short ref", () => {
    expect(looksLikeLocation("https://github.com/o/r")).toBe(true);
    expect(looksLikeLocation("git@github.com:o/r")).toBe(true);
    expect(looksLikeLocation("github.com/o/r")).toBe(true);
    expect(looksLikeLocation("repo:workflow/alpha@^1.0")).toBe(false);
    expect(looksLikeLocation("workflow/task-files.taskFileRoot")).toBe(false);
  });
});

describe("LocationSplitter", () => {
  /**
   * A GitHub URL becomes a repository with the names after it left to read.
   *
   * split("https://github.com/o/r/workflow/alpha")
   * // -> [{ rest: "workflow/alpha", repo: { location: github.com/o/r } }]
   */
  it("should read the repository and leave the names unread", () => {
    const out = splitter.split(stateOf("https://github.com/o/r/workflow/alpha"));
    const named = out.find((state) => state.rest === "workflow/alpha");
    expect(named?.repo?.location).toMatchObject({
      provider: "github",
      repoPath: "o/r",
      identity: "github.com/o/r",
    });
  });

  /**
   * A browser URL becomes a finished repository ref holding the browsed path,
   * and keeps the version range it was written with.
   *
   * split("https://github.com/o/r/tree/main/recipes/w/a", range "^1")
   * // -> a finished repo ref with browsed "main/recipes/w/a" and range "^1"
   */
  it("should finish a browser URL as a browsed repository", () => {
    const out = splitter.split(
      stateOf("https://github.com/o/r/tree/main/recipes/w/a", { range: "^1" })
    );
    const browsed = out.find((state) => state.ref?.kind === "repo");
    expect(browsed?.ref).toMatchObject({ browsed: "main/recipes/w/a", range: "^1" });
  });

  /**
   * A GitLab URL with nested groups reads every way the provider reads it.
   *
   * split("gitlab.com/a/b/c/d") // -> projects a/b (naming c/d) and a/b/c (naming d)
   */
  it("should return every reading a provider gives", () => {
    const out = splitter.split(stateOf("gitlab.com/a/b/c/d"));
    expect(out.map((state) => `${state.repo?.location?.repoPath} ${state.rest}`)).toEqual([
      "a/b c/d",
      "a/b/c d",
    ]);
  });

  /**
   * A location naming only a repository finishes as a repository ref, and a
   * range there is turned down.
   *
   * split("git@github.com:o/r.git") // -> a finished repo ref
   */
  it("should finish a bare repository, and refuse a range on it", () => {
    const [out] = splitter.split(stateOf("git@github.com:o/r.git"));
    expect(out?.ref).toMatchObject({ kind: "repo", location: { repoPath: "o/r" } });
    const ranged = stateOf("git@github.com:o/r.git", { range: "^1" });
    expect(splitter.split(ranged)).toEqual([]);
    expect(ranged.problems[0]).toContain("applies to a recipe, not to a repository");
  });

  /**
   * A repository on this machine becomes a finished ref with the local
   * provider, so a pruner can refuse it with the right words.
   *
   * split("file:///x/y") // -> a finished repo ref, provider "local"
   */
  it("should read a local location as a local repository", () => {
    const [out] = splitter.split(stateOf("file:///x/y/workflow/alpha"));
    expect(out?.ref).toMatchObject({ kind: "repo", location: { provider: "local" } });
  });

  /**
   * Locations no provider can read are turned down with a reason.
   *
   * split("bitbucket://o/r/w") // -> [] and "sous ships these: github, gitlab"
   */
  it("should turn down an unknown scheme, host and unreadable URL", () => {
    const scheme = stateOf("bitbucket://o/r/w");
    expect(splitter.split(scheme)).toEqual([]);
    expect(scheme.problems[0]).toContain("sous ships these: github, gitlab");
    const host = stateOf("https://git.example.com/o/r/w");
    expect(splitter.split(host)).toEqual([]);
    expect(host.problems[0]).toContain("://git.example.com/owner/repository/namespace/recipe");
    const broken = stateOf("https://");
    expect(splitter.split(broken)).toEqual([]);
    expect(broken.problems[0]).toContain("could not be read");
  });

  /**
   * A provider that reads nothing from the segments leaves a reason.
   *
   * split("github.com/onlyowner/x") // handled by the provider
   */
  it("should explain when a provider reads no repository", () => {
    const state = stateOf("github.com/onlyowner/");
    expect(splitter.split(state)).toEqual([]);
    expect(state.problems.length).toBeGreaterThan(0);
  });

  /**
   * Text that is not a location, or already has a qualifier, passes through.
   *
   * split("workflow/alpha") // -> the same state
   */
  it("should pass a short ref through unchanged", () => {
    const state = stateOf("workflow/alpha");
    expect(splitter.split(state)).toEqual([state]);
  });
});
