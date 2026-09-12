/**
 * Unit tests for the GitHub and GitLab providers. `fetch` and the subprocess
 * runner are both injected, so nothing here touches the network or spawns a
 * process.
 */

import { describe, it, expect } from "vitest";
import { GithubProvider, findGithubToken } from "./github.js";
import { GitlabProvider, findGitlabToken } from "./gitlab.js";
import type { CommandResult, CommandRunner } from "./git.js";
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

/**
 * A runner that records every call and answers from a table keyed by the first
 * two arguments, as in "pr create". Anything the table does not answer exits
 * successfully with no output.
 */
function scriptedRunner(answers: Record<string, CommandResult>) {
  const calls: Array<{ command: string; args: string[]; cwd?: string | undefined }> = [];
  const run: CommandRunner = async (command, args, options) => {
    calls.push({ command, args, cwd: options.cwd });
    return answers[args.slice(0, 2).join(" ")] ?? { code: 0, stdout: "", stderr: "" };
  };
  return { run, calls };
}

/** Finds one recorded call by its first two arguments. */
function callWith(
  calls: Array<{ command: string; args: string[] }>,
  key: string
): { command: string; args: string[] } | undefined {
  return calls.find((entry) => entry.args.slice(0, 2).join(" ") === key);
}

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

describe("GithubProvider write path", () => {
  const provider = new GithubProvider();
  const repo = provider.canonicalize("https://github.com/owner/recipes");

  /**
   * authStatus should report the exit code of `gh auth status` as a plain
   * yes-or-no, and carry the whole explanation with it when the answer is no.
   *
   * provider.authStatus({ run });  // -> { ok: true, detail: "the GitHub CLI ..." }
   */
  it("should report whether the GitHub CLI is installed and signed in", async () => {
    const signedIn = scriptedRunner({ "auth status": { code: 0, stdout: "", stderr: "" } });
    const signedOut = scriptedRunner({
      "auth status": { code: 1, stdout: "", stderr: "not logged in" },
    });

    const ok = await provider.authStatus({ run: signedIn.run });
    expect(ok.ok).toBe(true);
    expect(callWith(signedIn.calls, "auth status")?.command).toBe("gh");

    const refused = await provider.authStatus({ run: signedOut.run });
    expect(refused.ok).toBe(false);
    expect(refused.detail).toContain("https://cli.github.com");
    expect(refused.detail).toContain("gh auth login");
  });

  /**
   * canPush should turn GitHub's own answer into a boolean, and say "cannot
   * tell" (undefined) when `gh` could not answer at all.
   *
   * provider.canPush(repo, { run });  // -> true
   */
  it("should read push permission from the host, and admit when it cannot", async () => {
    const allowed = scriptedRunner({
      "api repos/owner/recipes": { code: 0, stdout: "true\n", stderr: "" },
    });
    const refused = scriptedRunner({
      "api repos/owner/recipes": { code: 0, stdout: "false\n", stderr: "" },
    });
    const broken = scriptedRunner({
      "api repos/owner/recipes": { code: 1, stdout: "", stderr: "not found" },
    });

    expect(await provider.canPush(repo, { run: allowed.run })).toBe(true);
    expect(await provider.canPush(repo, { run: refused.run })).toBe(false);
    expect(await provider.canPush(repo, { run: broken.run })).toBeUndefined();
    expect(callWith(allowed.calls, "api repos/owner/recipes")?.args).toContain(
      ".permissions.push"
    );
  });

  /**
   * fork should ask `gh` to fork the repository without touching the git
   * remotes (that is the caller's business), read the contributor's login, and
   * report where the fork landed.
   *
   * provider.fork(repo, { run });
   * // -> { owner: "contributor", httpsUrl: "https://github.com/contributor/recipes.git", ... }
   */
  it("should fork onto the contributor's account and report where it landed", async () => {
    const { run, calls } = scriptedRunner({
      "repo fork": { code: 0, stdout: "", stderr: "" },
      "api user": { code: 0, stdout: "contributor\n", stderr: "" },
    });

    const fork = await provider.fork(repo, { run, cwd: "/checkout" });

    expect(fork).toEqual({
      owner: "contributor",
      name: "recipes",
      httpsUrl: "https://github.com/contributor/recipes.git",
      sshUrl: "git@github.com:contributor/recipes.git",
    });
    expect(callWith(calls, "repo fork")?.args).toContain("--remote=false");
    expect(calls.every((entry) => entry.cwd === "/checkout")).toBe(true);
    expect(calls.some((entry) => entry.args[0] === "remote")).toBe(false);
  });

  /**
   * A fork that did not succeed is an error naming the command and whatever it
   * reported, because nothing after it can work.
   */
  it("should raise a ConfigError when the fork does not succeed", async () => {
    const { run } = scriptedRunner({
      "repo fork": { code: 1, stdout: "", stderr: "forking is disabled here" },
    });

    await expect(provider.fork(repo, { run })).rejects.toThrow(/forking is disabled here/);
  });

  /**
   * proposeChange should open a pull request for a branch that is already
   * pushed, and spell a cross-repository head as "owner:branch", which is the
   * only place that spelling is known.
   *
   * provider.proposeChange(repo, { branch: "work", head: { owner: "contributor" }, ... })
   * // -> { url: "https://github.com/owner/recipes/pull/7", detail: "..." }
   */
  it("should open a pull request and report its address", async () => {
    const { run, calls } = scriptedRunner({
      "pr create": {
        code: 0,
        stdout: "https://github.com/owner/recipes/pull/7\n",
        stderr: "",
      },
    });

    const proposed = await provider.proposeChange(
      repo,
      {
        branch: "sous/submit-20260910-1403",
        base: "main",
        title: "Add a recipe",
        body: "Please review.",
        draft: true,
        head: { owner: "contributor" },
      },
      { run }
    );

    expect(proposed.url).toBe("https://github.com/owner/recipes/pull/7");
    const created = callWith(calls, "pr create")!;
    expect(created.args).toContain("owner/recipes");
    expect(created.args).toContain("contributor:sous/submit-20260910-1403");
    expect(created.args).toContain("--draft");
    expect(created.args).toContain("Add a recipe");
  });

  /**
   * Without a fork the head is the branch itself, and a proposal that is not a
   * draft passes no draft flag.
   */
  it("should use the branch itself as the head when there is no fork", async () => {
    const { run, calls } = scriptedRunner({
      "pr create": { code: 0, stdout: "https://github.com/owner/recipes/pull/8", stderr: "" },
    });

    await provider.proposeChange(
      repo,
      { branch: "work", base: "main", title: "Tidy up", body: "", draft: false },
      { run }
    );

    const created = callWith(calls, "pr create")!;
    expect(created.args).toContain("work");
    expect(created.args).not.toContain("--draft");
  });

  /**
   * A refused pull request is an error saying no proposal was opened, so a
   * pushed branch is never mistaken for a submitted one.
   */
  it("should raise a ConfigError when the pull request is refused", async () => {
    const { run } = scriptedRunner({
      "pr create": { code: 1, stdout: "", stderr: "the API rejected the request" },
    });

    await expect(
      provider.proposeChange(
        repo,
        { branch: "work", title: "Tidy up", body: "", draft: false },
        { run }
      )
    ).rejects.toThrow(/no proposal was opened/);
  });
});

describe("GitlabProvider write path", () => {
  const provider = new GitlabProvider();
  const repo = provider.canonicalize("https://gitlab.com/group/recipes");

  /**
   * proposeChange should open a merge request from the branch in the checkout
   * the command runs in, which is why the working directory is passed along.
   *
   * provider.proposeChange(repo, { branch: "work", base: "main", ... }, { run, cwd });
   * // -> { url: "https://gitlab.com/group/recipes/-/merge_requests/3", detail: "..." }
   */
  it("should open a merge request and report its address", async () => {
    const { run, calls } = scriptedRunner({
      "mr create": {
        code: 0,
        stdout: "https://gitlab.com/group/recipes/-/merge_requests/3\n",
        stderr: "",
      },
    });

    const proposed = await provider.proposeChange(
      repo,
      { branch: "work", base: "main", title: "Add a recipe", body: "Please review.", draft: false },
      { run, cwd: "/checkout" }
    );

    expect(proposed.url).toBe("https://gitlab.com/group/recipes/-/merge_requests/3");
    const created = callWith(calls, "mr create")!;
    expect(created.command).toBe("glab");
    expect(created.args).toContain("--source-branch");
    expect(created.args).toContain("--target-branch");
    expect(created.args).toContain("--yes");
    expect(calls[0]?.cwd).toBe("/checkout");
  });

  /**
   * GitLab is asked nothing about push permission: sous has no reliable way to
   * find out, so the honest answer is "cannot tell" rather than a guess.
   *
   * provider.canPush(repo);  // -> undefined
   */
  it("should answer that it cannot tell whether you may push", async () => {
    const { run, calls } = scriptedRunner({});
    expect(await provider.canPush(repo, { run })).toBeUndefined();
    expect(calls).toEqual([]);
  });

  /**
   * Forking is not something this provider does, and the refusal says what to
   * do by hand instead of stranding the contributor halfway through.
   */
  it("should refuse to fork, and say what to do instead", async () => {
    await expect(provider.fork(repo)).rejects.toThrow(/does not fork/);
    await expect(provider.fork(repo)).rejects.toThrow(/merge request/);
  });

  /**
   * authStatus should report `glab`, not `gh`, and point at the GitLab CLI when
   * it is missing.
   */
  it("should report whether the GitLab CLI is installed and signed in", async () => {
    const { run, calls } = scriptedRunner({
      "auth status": { code: 1, stdout: "", stderr: "not logged in" },
    });

    const status = await provider.authStatus({ run });

    expect(status.ok).toBe(false);
    expect(status.detail).toContain("the GitLab CLI");
    expect(status.detail).toContain("glab auth login");
    expect(calls[0]?.command).toBe("glab");
  });
});
