import { describe, it, expect } from "vitest";
import { identitySegments, repoIdentity, shortNameFromIdentity } from "./identity.js";

/**
 * Unit tests for canonical repository identity, which is what every key shared
 * between projects on one machine is built from.
 */

describe("repoIdentity()", () => {
  /** The ordinary hosted case: host, owner, name, all lowercase. */
  it("should build a host-and-path identity", () => {
    expect(
      repoIdentity({
        host: "GitHub.com",
        owner: "Sous-IO",
        name: "sous-recipes",
        httpsUrl: "https://github.com/sous-io/sous-recipes.git",
        sshUrl: "git@github.com:sous-io/sous-recipes.git",
      })
    ).toBe("github.com/sous-io/sous-recipes");
  });

  /** A GitLab group path is several segments, and they all belong to the identity. */
  it("should keep nested group paths", () => {
    expect(
      repoIdentity({
        host: "gitlab.example.com",
        owner: "group/subgroup",
        name: "project",
        httpsUrl: "https://gitlab.example.com/group/subgroup/project.git",
        sshUrl: "git@gitlab.example.com:group/subgroup/project.git",
      })
    ).toBe("gitlab.example.com/group/subgroup/project");
  });

  /** A `.git` suffix is part of a clone URL, never part of an identity. */
  it("should drop a .git suffix from the name", () => {
    expect(
      repoIdentity({
        host: "github.com",
        owner: "owner",
        name: "thing.git",
        httpsUrl: "https://github.com/owner/thing.git",
        sshUrl: "git@github.com:owner/thing.git",
      })
    ).toBe("github.com/owner/thing");
  });

  /**
   * A local repository's owner is an absolute path, so its leading separator
   * would otherwise leave an empty first segment in the identity.
   */
  it("should collapse the leading separator of a local path", () => {
    expect(
      repoIdentity({
        host: "localhost",
        owner: "/home/me/Projects",
        name: "my-recipes",
        httpsUrl: "/home/me/Projects/my-recipes",
        sshUrl: "file:///home/me/Projects/my-recipes",
      })
    ).toBe("localhost/home/me/projects/my-recipes");
  });
});

describe("identitySegments()", () => {
  /** The segments are what the store turns into directories. */
  it("should split, lowercase and drop empty segments", () => {
    expect(identitySegments("localhost//home/Me/recipes")).toEqual([
      "localhost",
      "home",
      "me",
      "recipes",
    ]);
  });
});

describe("shortNameFromIdentity()", () => {
  /** The repository's own name is what a person would have called it. */
  it("should use the last segment", () => {
    expect(shortNameFromIdentity("github.com/sous-io/sous-recipes")).toBe("sous-recipes");
  });

  /** A name a short name may not carry is still turned into something usable. */
  it("should repair a name that is not kebab-case", () => {
    expect(shortNameFromIdentity("github.com/owner/My_Recipes")).toBe("my-recipes");
    expect(shortNameFromIdentity("github.com/owner/2fa")).toBe("repo-2fa");
  });
});
