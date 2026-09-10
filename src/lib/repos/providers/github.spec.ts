/**
 * Unit tests for the GitHub and GitLab providers. `fetch` and the subprocess
 * runner are both injected, so nothing here touches the network or spawns a
 * process.
 */

import { describe, it, expect } from "vitest";
import { GithubProvider, findGithubToken } from "./github.js";
import { GitlabProvider, findGitlabToken } from "./gitlab.js";
import type { CommandRunner } from "./git.js";
import type { FetchLike } from "./http.js";

/** Builds a fetch stand-in that records its calls and answers with one body. */
function fakeFetch(body: string, init: { status?: number; etag?: string } = {}) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const status = init.status ?? 200;
  const impl: FetchLike = async (url, options) => {
    calls.push({ url, headers: options?.headers ?? {} });
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? "OK" : "Not Found",
      text: async () => body,
      headers: { get: (name: string) => (name.toLowerCase() === "etag" ? init.etag ?? null : null) },
    };
  };
  return { impl, calls };
}

/** A runner that refuses every optional command, as a machine with no CLI would. */
const noCommands: CommandRunner = async () => ({ code: 127, stdout: "", stderr: "not found" });

describe("GithubProvider", () => {
  /**
   * The provider should recognize github.com URLs in any of their forms, and
   * decline everything else.
   */
  it("should match github.com URLs only", () => {
    const provider = new GithubProvider();
    expect(provider.matches("https://github.com/sous-io/sous-recipes")).toBe(true);
    expect(provider.matches("git@github.com:sous-io/sous-recipes.git")).toBe(true);
    expect(provider.matches("https://gitlab.com/sous-io/sous-recipes")).toBe(false);
  });

  /**
   * canonicalize should produce the clone URLs the fetch path uses.
   */
  it("should canonicalize a repository URL", () => {
    const repo = new GithubProvider().canonicalize("https://github.com/sous-io/sous-recipes.git");
    expect(repo.httpsUrl).toBe("https://github.com/sous-io/sous-recipes.git");
    expect(repo.owner).toBe("sous-io");
  });

  /**
   * The index lives at the raw content host, at the repository's default
   * branch, which is what HEAD names there.
   *
   * indexUrl(repo)
   * // -> "https://raw.githubusercontent.com/sous-io/sous-recipes/HEAD/sous.index.json"
   */
  it("should read the index from the raw host at the default branch", async () => {
    const provider = new GithubProvider();
    const repo = provider.canonicalize("https://github.com/sous-io/sous-recipes");
    const { impl, calls } = fakeFetch('{"formatVersion":1}', { etag: 'W/"abc"' });

    const fetched = await provider.fetchIndex(repo, {
      env: {},
      fetchImpl: impl,
      run: noCommands,
    });

    expect(calls[0]?.url).toBe(
      "https://raw.githubusercontent.com/sous-io/sous-recipes/HEAD/sous.index.json"
    );
    expect(fetched).toEqual({ text: '{"formatVersion":1}', ref: "HEAD", etag: 'W/"abc"' });
  });

  /**
   * A token in the environment should be sent as a bearer token, so private
   * repositories work.
   */
  it("should send GITHUB_TOKEN as a bearer token when one is set", async () => {
    const provider = new GithubProvider();
    const repo = provider.canonicalize("https://github.com/sous-io/private-recipes");
    const { impl, calls } = fakeFetch("{}");

    await provider.fetchIndex(repo, {
      env: { GITHUB_TOKEN: "ghp_secret" },
      fetchImpl: impl,
      run: noCommands,
    });

    expect(calls[0]?.headers["Authorization"]).toBe("Bearer ghp_secret");
  });

  /**
   * With no token anywhere the request should simply carry no authorization
   * header; public repositories need none.
   */
  it("should send no authorization header when no token can be found", async () => {
    const provider = new GithubProvider();
    const repo = provider.canonicalize("https://github.com/sous-io/sous-recipes");
    const { impl, calls } = fakeFetch("{}");

    await provider.fetchIndex(repo, { env: {}, fetchImpl: impl, run: noCommands });

    expect(calls[0]?.headers["Authorization"]).toBeUndefined();
  });

  /**
   * A non-2xx answer should become a ConfigError naming the URL and the status,
   * and explaining what a 404 usually means.
   */
  it("should raise a ConfigError when the host answers with an error", async () => {
    const provider = new GithubProvider();
    const repo = provider.canonicalize("https://github.com/sous-io/sous-recipes");
    const { impl } = fakeFetch("", { status: 404 });

    await expect(
      provider.fetchIndex(repo, { env: {}, fetchImpl: impl, run: noCommands })
    ).rejects.toThrow(/publishes no sous index yet/);
  });
});

describe("findGithubToken()", () => {
  /**
   * The environment wins; the `gh` command line tool is only asked when the
   * environment says nothing.
   */
  it("should prefer GITHUB_TOKEN and fall back to the gh command line tool", async () => {
    expect(await findGithubToken({ env: { GITHUB_TOKEN: "from-env" }, run: noCommands })).toBe(
      "from-env"
    );

    const runner: CommandRunner = async (command, args) => {
      expect([command, ...args]).toEqual(["gh", "auth", "token"]);
      return { code: 0, stdout: "from-gh\n", stderr: "" };
    };
    expect(await findGithubToken({ env: {}, run: runner })).toBe("from-gh");
  });

  /**
   * A machine without `gh` installed is normal, so a missing tool yields
   * undefined rather than an error.
   */
  it("should return undefined when gh is not installed", async () => {
    expect(await findGithubToken({ env: {}, run: noCommands })).toBeUndefined();
  });
});

describe("GitlabProvider", () => {
  /**
   * The provider should recognize gitlab.com and self-hosted instances whose
   * host name begins with "gitlab.".
   */
  it("should match gitlab.com and self-hosted gitlab hosts", () => {
    const provider = new GitlabProvider();
    expect(provider.matches("https://gitlab.com/group/repo")).toBe(true);
    expect(provider.matches("https://gitlab.example.com/group/repo")).toBe(true);
    expect(provider.matches("https://github.com/owner/repo")).toBe(false);
  });

  /**
   * The index lives at the instance's own raw file endpoint, at the default
   * branch.
   *
   * indexUrl(repo) // -> "https://gitlab.com/group/repo/-/raw/HEAD/sous.index.json"
   */
  it("should read the index from the instance's raw endpoint", async () => {
    const provider = new GitlabProvider();
    const repo = provider.canonicalize("https://gitlab.example.com/group/sub/repo");
    const { impl, calls } = fakeFetch("{}");

    await provider.fetchIndex(repo, { env: {}, fetchImpl: impl, run: noCommands });

    expect(calls[0]?.url).toBe(
      "https://gitlab.example.com/group/sub/repo/-/raw/HEAD/sous.index.json"
    );
  });
});

describe("findGitlabToken()", () => {
  /**
   * The environment wins; `glab` is only asked when the environment says
   * nothing, and a missing `glab` is not an error.
   */
  it("should prefer GITLAB_TOKEN and fall back to the glab command line tool", async () => {
    expect(await findGitlabToken({ env: { GITLAB_TOKEN: "from-env" }, run: noCommands })).toBe(
      "from-env"
    );

    const runner: CommandRunner = async (command, args) => {
      expect([command, ...args]).toEqual(["glab", "auth", "token"]);
      return { code: 0, stdout: "from-glab\n", stderr: "" };
    };
    expect(await findGitlabToken({ env: {}, run: runner })).toBe("from-glab");
    expect(await findGitlabToken({ env: {}, run: noCommands })).toBeUndefined();
  });
});
