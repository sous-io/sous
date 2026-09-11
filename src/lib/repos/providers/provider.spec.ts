/**
 * Unit tests for URL canonicalization and provider selection.
 */

import { describe, it, expect } from "vitest";
import { buildCanonicalRepo, normalizeRepoUrl, splitRepoUrl } from "./provider.js";
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
    for (const provider of providers) {
      expect(provider.features).toEqual(
        provider.id === "local" ? ["fetch"] : ["fetch", "submit"],
      );
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
