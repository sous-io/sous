/**
 * Unit tests for URL canonicalization and provider selection.
 */

import { describe, it, expect } from "vitest";
import {
  buildCanonicalRepo,
  normalizeRepoUrl,
  readingsAfterRepository,
  splitRepoUrl,
  withoutGitSuffix,
} from "./provider.js";
import { builtInProviders, detectProvider, providerById, requireProvider } from "./index.js";

describe("normalizeRepoUrl()", () => {
  /**
   * normalizeRepoUrl should trim whitespace and drop a trailing slash and a
   * trailing ".git", so the same repository written four ways is one string.
   *
   * normalizeRepoUrl(" https://github.com/a/b.git/ ") // -> "https://github.com/a/b"
   */
  it("should drop surrounding whitespace, trailing slashes and a .git suffix", () => {
    expect(normalizeRepoUrl(" https://github.com/a/b.git ")).toBe("https://github.com/a/b");
    expect(normalizeRepoUrl("https://github.com/a/b/")).toBe("https://github.com/a/b");
  });
});

describe("splitRepoUrl()", () => {
  /**
   * splitRepoUrl should accept the three forms people actually paste: HTTPS,
   * the scp-style SSH form, and an ssh:// URL.
   *
   * splitRepoUrl("git@github.com:sous-io/sous-recipes.git")
   * // -> { host: "github.com", owner: "sous-io", name: "sous-recipes" }
   */
  it("should take apart the HTTPS, scp-style and ssh:// forms alike", () => {
    const expected = { host: "github.com", owner: "sous-io", name: "sous-recipes" };
    expect(splitRepoUrl("https://github.com/sous-io/sous-recipes")).toEqual(expected);
    expect(splitRepoUrl("git@github.com:sous-io/sous-recipes.git")).toEqual(expected);
    expect(splitRepoUrl("ssh://git@github.com/sous-io/sous-recipes.git")).toEqual(expected);
  });

  /**
   * A GitLab group path has more than two segments; everything before the last
   * one is the owner.
   *
   * splitRepoUrl("https://gitlab.com/group/sub/repo")
   * // -> { host: "gitlab.com", owner: "group/sub", name: "repo" }
   */
  it("should treat every segment before the last as the owner", () => {
    expect(splitRepoUrl("https://gitlab.com/group/sub/repo")).toEqual({
      host: "gitlab.com",
      owner: "group/sub",
      name: "repo",
    });
  });

  /**
   * Anything that does not name both an owner and a repository is not a
   * repository URL, and splitRepoUrl should say so with undefined.
   */
  it("should return undefined for a URL that names no repository", () => {
    expect(splitRepoUrl("https://github.com/sous-io")).toBeUndefined();
    expect(splitRepoUrl("not a url")).toBeUndefined();
    expect(splitRepoUrl("")).toBeUndefined();
  });
});

describe("buildCanonicalRepo()", () => {
  /**
   * buildCanonicalRepo should produce both clone URLs from the three parts.
   */
  it("should build the HTTPS and SSH clone URLs", () => {
    expect(buildCanonicalRepo("github.com", "sous-io", "sous-recipes")).toEqual({
      host: "github.com",
      owner: "sous-io",
      name: "sous-recipes",
      httpsUrl: "https://github.com/sous-io/sous-recipes.git",
      sshUrl: "git@github.com:sous-io/sous-recipes.git",
    });
  });
});

describe("the built-in provider list", () => {
  /**
   * builtInProviders should return the two hosted providers version one ships,
   * each declaring the read path and the propose-a-change path (delegated to
   * their command line tools), plus the local provider, which can only
   * fetch. The local provider comes last, and matches only a local path, so it
   * can never intercept a hosted repository's URL.
   *
   * builtInProviders().map((provider) => provider.id);
   * // -> ["github", "gitlab", "local"]
   */
  it("should ship GitHub, GitLab and file, with submit only on the hosted two", () => {
    const providers = builtInProviders();
    expect(providers.map((provider) => provider.id)).toEqual([
      "github",
      "gitlab",
      "local",
    ]);
    const expected: Record<string, string[]> = {
      github: ["fetch", "submit", "proposals"],
      gitlab: ["fetch", "submit"],
      local: ["fetch"],
    };
    for (const provider of providers) {
      expect(provider.features).toEqual(expected[provider.id]);
    }
  });

  /**
   * detectProvider should pick the provider whose host it recognizes, including
   * a self-hosted GitLab whose host name begins with "gitlab.".
   */
  it("should detect the provider from the URL's host", () => {
    expect(detectProvider("https://github.com/a/b")?.id).toBe("github");
    expect(detectProvider("git@gitlab.com:a/b.git")?.id).toBe("gitlab");
    expect(detectProvider("https://gitlab.example.com/a/b")?.id).toBe("gitlab");
    expect(detectProvider("https://git.example.com/a/b")).toBeUndefined();
  });

  /**
   * providerById should find a provider by the identifier a repository entry
   * writes down.
   */
  it("should look a provider up by its identifier", () => {
    expect(providerById("gitlab")?.id).toBe("gitlab");
    expect(providerById("bitbucket")).toBeUndefined();
  });

  /**
   * requireProvider should prefer the provider a repository entry names, so a
   * self-hosted instance behind an unfamiliar host still works.
   */
  it("should use the provider the entry names before detecting one", () => {
    expect(requireProvider("https://git.example.com/a/b", "gitlab").id).toBe("gitlab");
  });

  /**
   * When neither the entry nor the URL identifies a provider, the error should
   * list the providers sous has and show how to name one.
   */
  it("should raise a ConfigError listing the providers sous ships", () => {
    expect(() => requireProvider("https://git.example.com/a/b")).toThrow(
      /Sous ships these providers: github, gitlab/
    );
    expect(() => requireProvider("https://git.example.com/a/b", "bitbucket")).toThrow(
      /names the provider 'bitbucket'/
    );
  });
});

describe("readingsAfterRepository()", () => {
  /**
   * readingsAfterRepository should read the segments after a repository as
   * what they name, and, when they start with `tree/` or `blob/`, also as the
   * browser path they could be, dropping a leading `-` separator first.
   *
   * readingsAfterRepository("o/r", ["-", "tree", "main", "x"])
   * // -> [{ repoPath: "o/r", browsed: "main/x" },
   * //     { repoPath: "o/r", named: ["tree", "main", "x"] }]
   */
  it("should return a browsed and a named reading after tree or blob", () => {
    expect(readingsAfterRepository("o/r", ["-", "tree", "main", "x"])).toEqual([
      { repoPath: "o/r", browsed: "main/x" },
      { repoPath: "o/r", named: ["tree", "main", "x"] },
    ]);
    expect(readingsAfterRepository("o/r", ["blob", "main", "x", "SKILL.md"])[0]).toEqual({
      repoPath: "o/r",
      browsed: "main/x/SKILL.md",
    });
  });

  /**
   * Segments that do not start with a browse word are one named reading.
   *
   * readingsAfterRepository("o/r", ["workflow", "alpha"])
   * // -> [{ repoPath: "o/r", named: ["workflow", "alpha"] }]
   */
  it("should return one named reading otherwise", () => {
    expect(readingsAfterRepository("o/r", ["workflow", "alpha"])).toEqual([
      { repoPath: "o/r", named: ["workflow", "alpha"] },
    ]);
    expect(readingsAfterRepository("o/r", [])).toEqual([{ repoPath: "o/r", named: [] }]);
  });
});

describe("withoutGitSuffix()", () => {
  /**
   * withoutGitSuffix should drop a `.git` suffix in any case, and nothing else.
   *
   * withoutGitSuffix("repo.GIT") // -> "repo"
   */
  it("should drop a .git suffix", () => {
    expect(withoutGitSuffix("repo.GIT")).toBe("repo");
    expect(withoutGitSuffix("repo")).toBe("repo");
  });
});

describe("GithubProvider.readLocation()", () => {
  const github = providerById("github")!;

  /**
   * A GitHub repository is always an owner and a name, so the reading splits
   * after the second segment, with any `.git` suffix removed.
   *
   * readLocation({ host: "github.com", segments: ["o", "r.git", "workflow"] })
   * // -> [{ repoPath: "o/r", named: ["workflow"] }]
   */
  it("should read the first two segments as the repository", () => {
    expect(
      github.readLocation({ host: "github.com", segments: ["o", "r.git", "workflow"] })
    ).toEqual([{ repoPath: "o/r", named: ["workflow"] }]);
  });

  /**
   * A browser URL reads as a browsed path after `tree/`.
   *
   * readLocation({ segments: ["o", "r", "tree", "main", "recipes", "x"] })[0]
   * // -> { repoPath: "o/r", browsed: "main/recipes/x" }
   */
  it("should read a browser path", () => {
    expect(
      github.readLocation({
        host: "github.com",
        segments: ["o", "r", "tree", "main", "recipes", "x"],
      })[0]
    ).toEqual({ repoPath: "o/r", browsed: "main/recipes/x" });
  });

  /**
   * A single segment is not a repository at all.
   *
   * readLocation({ segments: ["o"] }) // -> []
   */
  it("should read nothing from a single segment", () => {
    expect(github.readLocation({ host: "github.com", segments: ["o"] })).toEqual([]);
  });

  /**
   * The canonical locator leaves out the default host and keeps any other.
   *
   * formatLocator("github.com", "o/r", "workflow/alpha") // -> "github://o/r/workflow/alpha"
   */
  it("should format a canonical locator", () => {
    expect(github.formatLocator("github.com", "o/r", "workflow/alpha")).toBe(
      "github://o/r/workflow/alpha"
    );
    expect(github.formatLocator("ghe.example.com", "o/r", "")).toBe(
      "github://ghe.example.com/o/r"
    );
  });
});

describe("GitlabProvider.readLocation()", () => {
  const gitlab = providerById("gitlab")!;

  /**
   * Without a separator, a nested group reads every way that leaves a project
   * of at least two segments and at most a namespace and a recipe after it.
   *
   * readLocation({ segments: ["a", "b", "c", "d"] })
   * // -> project a/b naming c/d, a/b/c naming d, and a/b/c/d naming nothing
   */
  it("should return every split of a nested group", () => {
    expect(gitlab.readLocation({ host: "gitlab.com", segments: ["a", "b", "c", "d"] })).toEqual([
      { repoPath: "a/b", named: ["c", "d"] },
      { repoPath: "a/b/c", named: ["d"] },
      { repoPath: "a/b/c/d", named: [] },
    ]);
  });

  /**
   * GitLab's `-` separator ends the project path, and what follows it is a
   * browser path or what it names.
   *
   * readLocation({ segments: ["a", "b", "c", "-", "tree", "main", "x"] })[0]
   * // -> { repoPath: "a/b/c", browsed: "main/x" }
   */
  it("should end the project path at the separator", () => {
    expect(
      gitlab.readLocation({
        host: "gitlab.com",
        segments: ["a", "b", "c", "-", "tree", "main", "x"],
      })[0]
    ).toEqual({ repoPath: "a/b/c", browsed: "main/x" });
    expect(
      gitlab.readLocation({ host: "gitlab.com", segments: ["a", "b", "-", "c", "d"] })
    ).toEqual([{ repoPath: "a/b", named: ["c", "d"] }]);
  });

  /**
   * A `.git` suffix also ends the project path.
   *
   * readLocation({ segments: ["a", "b", "c.git", "d"] })
   * // -> [{ repoPath: "a/b/c", named: ["d"] }]
   */
  it("should end the project path at a .git suffix", () => {
    expect(
      gitlab.readLocation({ host: "gitlab.com", segments: ["a", "b", "c.git", "d"] })
    ).toEqual([{ repoPath: "a/b/c", named: ["d"] }]);
  });

  /**
   * The canonical locator always marks where the project path ends.
   *
   * formatLocator("gitlab.com", "a/b", "c/d") // -> "gitlab://a/b/-/c/d"
   */
  it("should format a canonical locator with the separator", () => {
    expect(gitlab.formatLocator("gitlab.com", "a/b", "c/d")).toBe("gitlab://a/b/-/c/d");
    expect(gitlab.formatLocator("gitlab.example.com", "a/b", "")).toBe(
      "gitlab://gitlab.example.com/a/b"
    );
  });
});

describe("LocalProvider.readLocation()", () => {
  /**
   * The local provider reads no location inside its repositories.
   *
   * readLocation({ host: "localhost", segments: ["a", "b"] }) // -> []
   */
  it("should read nothing", () => {
    expect(
      providerById("local")!.readLocation({ host: "localhost", segments: ["a", "b"] })
    ).toEqual([]);
  });
});
