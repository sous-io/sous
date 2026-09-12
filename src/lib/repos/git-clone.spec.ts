import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  cloneRepo,
  isGitCheckout,
  looksLikeRepoUrl,
  normalizeRemoteUrl,
  remoteUrlOf,
  repoNameFromUrl,
  repoSlugFromUrl,
  sameRemote,
  type GitResult,
  type GitRunner,
} from "./git-clone.js";
import { isConfigError } from "../errors.js";
import { makeTmpDir, type TmpDir } from "../../test/utils/tmp.js";

/** Builds a runner that answers from a table of command lines, recording every call. */
function fakeRunner(
  answers: Record<string, Partial<GitResult>>
): GitRunner & { calls: { args: string[]; cwd?: string }[] } {
  const calls: { args: string[]; cwd?: string }[] = [];
  const runner = ((args: string[], options: { cwd?: string }) => {
    calls.push({ args, cwd: options.cwd });
    const answer = answers[args.join(" ")];
    return {
      status: answer?.status ?? (answer === undefined ? 1 : 0),
      stdout: answer?.stdout ?? "",
      stderr: answer?.stderr ?? "",
    };
  }) as GitRunner & { calls: { args: string[]; cwd?: string }[] };
  runner.calls = calls;
  return runner;
}

describe("normalizeRemoteUrl()", () => {
  /**
   * normalizeRemoteUrl should reduce every spelling of one repository to the
   * same `host/path` string, dropping the scheme, any credentials, a port, a
   * trailing slash and a `.git` suffix.
   *
   * normalizeRemoteUrl("https://github.com/sous-io/sous-recipes.git");
   * // -> "github.com/sous-io/sous-recipes"
   */
  it("should reduce every spelling of one repository to the same string", () => {
    const expected = "github.com/sous-io/sous-recipes";
    expect(normalizeRemoteUrl("https://github.com/sous-io/sous-recipes")).toBe(expected);
    expect(normalizeRemoteUrl("https://github.com/sous-io/sous-recipes.git")).toBe(expected);
    expect(normalizeRemoteUrl("https://github.com/sous-io/sous-recipes/")).toBe(expected);
    expect(normalizeRemoteUrl("git@github.com:sous-io/sous-recipes.git")).toBe(expected);
    expect(normalizeRemoteUrl("ssh://git@github.com/sous-io/sous-recipes")).toBe(expected);
    expect(normalizeRemoteUrl("HTTPS://GitHub.com/sous-io/sous-recipes")).toBe(expected);
  });

  /**
   * normalizeRemoteUrl should keep two genuinely different repositories apart,
   * so a reused checkout is never mistaken for the right one.
   *
   * normalizeRemoteUrl("https://github.com/a/one") !==
   *   normalizeRemoteUrl("https://github.com/a/two")
   */
  it("should keep two different repositories apart", () => {
    expect(normalizeRemoteUrl("https://github.com/a/one")).not.toBe(
      normalizeRemoteUrl("https://github.com/a/two")
    );
    expect(normalizeRemoteUrl("https://gitlab.com/a/one")).not.toBe(
      normalizeRemoteUrl("https://github.com/a/one")
    );
  });
});

describe("sameRemote()", () => {
  /**
   * sameRemote should call an SSH remote and an HTTPS remote for one repository
   * the same repository, which is what lets `sous repo link` reuse a checkout a
   * user cloned themselves.
   *
   * sameRemote("git@github.com:a/b.git", "https://github.com/a/b"); // -> true
   */
  it("should treat SSH and HTTPS spellings of one repository as the same", () => {
    expect(sameRemote("git@github.com:a/b.git", "https://github.com/a/b")).toBe(true);
    expect(sameRemote("https://github.com/a/b", "https://github.com/a/c")).toBe(false);
  });
});

describe("repoSlugFromUrl()", () => {
  /**
   * repoSlugFromUrl should return the owner and the name that decide where a
   * default clone lands under `.sous/repos/`.
   *
   * repoSlugFromUrl("https://github.com/sous-io/sous-recipes.git");
   * // -> { owner: "sous-io", name: "sous-recipes" }
   */
  it("should return the owner and the name from a normal repository URL", () => {
    expect(repoSlugFromUrl("https://github.com/sous-io/sous-recipes.git")).toEqual({
      owner: "sous-io",
      name: "sous-recipes",
    });
    expect(repoSlugFromUrl("git@gitlab.com:group/subgroup/thing")).toEqual({
      owner: "subgroup",
      name: "thing",
    });
  });

  /**
   * repoSlugFromUrl should fall back to the literal owner "repos" when the URL
   * carries no owner segment, so the store layout stays two levels deep.
   *
   * repoSlugFromUrl("https://example.com/thing"); // -> { owner: "repos", name: "thing" }
   */
  it("should use the owner 'repos' when the URL has no owner segment", () => {
    expect(repoSlugFromUrl("https://example.com/thing")).toEqual({
      owner: "repos",
      name: "thing",
    });
  });

  /**
   * repoSlugFromUrl should raise a ConfigError naming the URL when it carries
   * no path at all, rather than inventing a directory name.
   *
   * repoSlugFromUrl("https://example.com"); // throws ConfigError
   */
  it("should raise a ConfigError for a URL with no repository path", () => {
    let caught: unknown;
    try {
      repoSlugFromUrl("https://example.com");
    } catch (error) {
      caught = error;
    }
    expect(isConfigError(caught)).toBe(true);
    expect((caught as Error).message).toContain("https://example.com");
  });

  /**
   * repoNameFromUrl should return just the last segment, which is the short
   * name a repository given as a bare URL is known by.
   *
   * repoNameFromUrl("https://github.com/sous-io/sous-recipes.git"); // -> "sous-recipes"
   */
  it("should return the last segment as the short name", () => {
    expect(repoNameFromUrl("https://github.com/sous-io/sous-recipes.git")).toBe(
      "sous-recipes"
    );
  });
});

describe("looksLikeRepoUrl()", () => {
  /**
   * looksLikeRepoUrl should recognize the forms git can clone and reject a bare
   * short name, which is what decides whether `sous repo link` looks a name up
   * in the project's config or treats it as a URL.
   *
   * looksLikeRepoUrl("https://github.com/a/b"); // -> true
   * looksLikeRepoUrl("sous-recipes");           // -> false
   */
  it("should recognize clonable forms and reject a bare short name", () => {
    expect(looksLikeRepoUrl("https://github.com/a/b")).toBe(true);
    expect(looksLikeRepoUrl("git@github.com:a/b.git")).toBe(true);
    expect(looksLikeRepoUrl("/srv/git/a.git")).toBe(true);
    expect(looksLikeRepoUrl("./local-repo")).toBe(true);
    expect(looksLikeRepoUrl("sous-recipes")).toBe(false);
  });
});

describe("isGitCheckout()", () => {
  let tmp: TmpDir;

  beforeEach(() => {
    tmp = makeTmpDir("sous-git-clone-");
  });

  afterEach(() => {
    tmp.cleanup();
  });

  /**
   * isGitCheckout should be true only when the directory IS the root of a
   * working tree; a subdirectory of one is deliberately not a checkout, because
   * linking half a repository yields a repo with no manifest at its root.
   *
   * isGitCheckout("/a/repo");     // -> true  (git reports /a/repo)
   * isGitCheckout("/a/repo/sub"); // -> false (git reports /a/repo)
   */
  it("should be true only for the root of a working tree", () => {
    const root = path.join(tmp.path, "repo");
    const sub = path.join(root, "sub");
    fs.mkdirSync(sub, { recursive: true });

    const runner = fakeRunner({
      "rev-parse --show-toplevel": { status: 0, stdout: root },
    });

    expect(isGitCheckout(root, { runner })).toBe(true);
    expect(isGitCheckout(sub, { runner })).toBe(false);
  });

  /**
   * isGitCheckout should be false, without asking git anything, when the
   * directory does not exist.
   *
   * isGitCheckout("/nowhere"); // -> false
   */
  it("should be false for a directory that does not exist", () => {
    const runner = fakeRunner({});
    expect(isGitCheckout(path.join(tmp.path, "nowhere"), { runner })).toBe(false);
    expect(runner.calls).toHaveLength(0);
  });

  /**
   * isGitCheckout should be false when git exits non-zero, which is what git
   * does for a directory that is not inside any repository.
   */
  it("should be false when git reports no repository", () => {
    const runner = fakeRunner({ "rev-parse --show-toplevel": { status: 128 } });
    expect(isGitCheckout(tmp.path, { runner })).toBe(false);
  });
});

describe("remoteUrlOf()", () => {
  /**
   * remoteUrlOf should return the origin remote's URL, and undefined when the
   * checkout has no origin (a repository created with `git init` has none).
   *
   * remoteUrlOf("/a/repo"); // -> "https://github.com/a/b"
   */
  it("should return the origin URL, or undefined when there is none", () => {
    const withOrigin = fakeRunner({
      "remote get-url origin": { status: 0, stdout: "https://github.com/a/b" },
    });
    expect(remoteUrlOf("/a/repo", { runner: withOrigin })).toBe("https://github.com/a/b");

    const withoutOrigin = fakeRunner({ "remote get-url origin": { status: 2 } });
    expect(remoteUrlOf("/a/repo", { runner: withoutOrigin })).toBeUndefined();
  });
});

describe("cloneRepo()", () => {
  let tmp: TmpDir;

  beforeEach(() => {
    tmp = makeTmpDir("sous-git-clone-");
  });

  afterEach(() => {
    tmp.cleanup();
  });

  /**
   * cloneRepo should invoke a shallow clone by default, creating the parent
   * directory first so git is never asked to write somewhere that is missing.
   *
   * cloneRepo("https://x/y", "/tmp/a/b");
   * // -> git clone --depth 1 -- https://x/y /tmp/a/b
   */
  it("should run a shallow clone and create the parent directory", () => {
    const dest = path.join(tmp.path, "nested", "repo");
    const runner = fakeRunner({
      [`clone --depth 1 -- https://x/y ${dest}`]: { status: 0 },
    });

    const result = cloneRepo("https://x/y", dest, { runner });

    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]!.args).toEqual([
      "clone",
      "--depth",
      "1",
      "--",
      "https://x/y",
      dest,
    ]);
    expect(result).toEqual({ depth: 1, fellBackToFullClone: false });
    expect(fs.existsSync(path.dirname(dest))).toBe(true);
  });

  /**
   * cloneRepo should retry in full when a remote refuses a shallow clone, which
   * some servers and every `file://` transport do, and should say so in its
   * result rather than reporting a failure.
   *
   * cloneRepo(url, dest); // -> { depth: 0, fellBackToFullClone: true }
   */
  it("should retry the full history when a shallow clone is refused", () => {
    const dest = path.join(tmp.path, "repo");
    const runner = fakeRunner({
      [`clone --depth 1 -- https://x/y ${dest}`]: {
        status: 128,
        stderr: "fatal: remote transport reported error",
      },
      [`clone -- https://x/y ${dest}`]: { status: 0 },
    });

    const result = cloneRepo("https://x/y", dest, { runner });

    expect(runner.calls).toHaveLength(2);
    expect(result).toEqual({ depth: 0, fellBackToFullClone: true });
  });

  /**
   * cloneRepo should omit --depth when asked for a full clone with depth 0.
   *
   * cloneRepo("https://x/y", dest, { depth: 0 });
   * // -> git clone -- https://x/y <dest>
   */
  it("should clone the full history when depth is zero", () => {
    const dest = path.join(tmp.path, "repo");
    const runner = fakeRunner({ [`clone -- https://x/y ${dest}`]: { status: 0 } });

    const result = cloneRepo("https://x/y", dest, { runner, depth: 0 });

    expect(runner.calls[0]!.args).toEqual(["clone", "--", "https://x/y", dest]);
    expect(result).toEqual({ depth: 0, fellBackToFullClone: false });
  });

  /**
   * cloneRepo should refuse to clone into a directory that already holds
   * something, rather than letting git fail with a message about an unrelated
   * directory, and should point at the way to link what is already there.
   */
  it("should refuse to clone into a non-empty directory", () => {
    const dest = path.join(tmp.path, "occupied");
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, "README.md"), "hello\n", "utf8");

    const runner = fakeRunner({});
    let caught: unknown;
    try {
      cloneRepo("https://x/y", dest, { runner });
    } catch (error) {
      caught = error;
    }

    expect(isConfigError(caught)).toBe(true);
    expect((caught as Error).message).toContain("already exists and is not empty");
    expect(runner.calls).toHaveLength(0);
  });

  /**
   * cloneRepo should raise a ConfigError carrying git's own message when the
   * clone fails, so the user reads the reason git gave rather than a stack.
   */
  it("should carry git's message into the error when a clone fails", () => {
    const dest = path.join(tmp.path, "repo");
    const runner = fakeRunner({
      [`clone --depth 1 -- https://x/y ${dest}`]: { status: 128 },
      [`clone -- https://x/y ${dest}`]: {
        status: 128,
        stderr: "fatal: repository 'https://x/y' not found",
      },
    });

    let caught: unknown;
    try {
      cloneRepo("https://x/y", dest, { runner });
    } catch (error) {
      caught = error;
    }

    expect(isConfigError(caught)).toBe(true);
    expect((caught as Error).message).toContain("repository 'https://x/y' not found");
  });
});
