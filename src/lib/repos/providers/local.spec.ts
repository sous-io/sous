import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTmpDir, type TmpDir } from "../../../test/utils/tmp.js";
import {
  LocalProvider,
  assertLocalRepoDirectory,
  localRepoPath,
  looksLikeLocalPath,
  resolveRepoArgument,
} from "./local.js";
import { builtInProviders, detectProvider, requireProvider } from "./index.js";
import type { CommandResult, CommandRunner } from "./git.js";

let tmp: TmpDir;
let repoDir: string;

/** A runner that answers every command as though git were not a repository here. */
const notAGitRepo: CommandRunner = async (): Promise<CommandResult> => ({
  code: 128,
  stdout: "",
  stderr: "not a git repository",
});

beforeEach(() => {
  tmp = makeTmpDir("sous-local-provider-");
  repoDir = path.join(tmp.path, "recipes");
  fs.mkdirSync(repoDir, { recursive: true });
});

afterEach(() => {
  tmp.cleanup();
});

describe("localRepoPath()", () => {
  /**
   * localRepoPath should accept both spellings of a local repository, the
   * `file://` URL and the bare absolute path, and return the same directory for
   * each.
   *
   * localRepoPath("file:///home/me/recipes"); // -> "/home/me/recipes"
   * localRepoPath("/home/me/recipes");        // -> "/home/me/recipes"
   */
  it("should accept both the file URL and the bare absolute path", () => {
    expect(localRepoPath("file:///home/me/recipes")).toBe("/home/me/recipes");
    expect(localRepoPath("/home/me/recipes")).toBe("/home/me/recipes");
  });

  /**
   * localRepoPath should reject anything that is not a local path, including a
   * relative one, because a repository entry is read from a config file that
   * several working directories may run against.
   *
   * localRepoPath("https://github.com/owner/repo"); // -> undefined
   * localRepoPath("./recipes");                     // -> undefined
   */
  it("should reject a hosted URL and a relative path", () => {
    expect(localRepoPath("https://github.com/owner/repo")).toBeUndefined();
    expect(localRepoPath("./recipes")).toBeUndefined();
    expect(localRepoPath("   ")).toBeUndefined();
  });
});

describe("LocalProvider", () => {
  /**
   * The provider should claim a local path and nothing else, so adding it to
   * the built-in list can never intercept a hosted repository's URL.
   *
   * detectProvider("/home/me/recipes")?.id;             // -> "local"
   * detectProvider("https://github.com/o/r")?.id;       // -> "github"
   */
  it("should claim local paths only", () => {
    expect(detectProvider("/home/me/recipes")?.id).toBe("local");
    expect(detectProvider("file:///home/me/recipes")?.id).toBe("local");
    expect(detectProvider("https://github.com/owner/repo")?.id).toBe("github");
    expect(detectProvider("https://gitlab.com/group/repo")?.id).toBe("gitlab");
  });

  /**
   * The provider should be one of the built-ins, and reachable by name, so a
   * repository entry may say `provider: local` outright.
   *
   * requireProvider("/home/me/recipes", "local").id; // -> "local"
   */
  it("should be a built-in reachable by name", () => {
    expect(builtInProviders().map((provider) => provider.id)).toContain("local");
    expect(requireProvider("/home/me/recipes", "local").id).toBe("local");
  });

  /**
   * canonicalize should carry the absolute directory in `httpsUrl`, because that
   * is what git is handed when a recipe is fetched, and the canonical `file://`
   * spelling in `sshUrl` for anything that shows the location to a person.
   *
   * canonicalize("/home/me/recipes");
   * // -> { httpsUrl: "/home/me/recipes", sshUrl: "file:///home/me/recipes", ... }
   */
  it("should canonicalize a local path into its directory and file URL", () => {
    const repo = new LocalProvider().canonicalize("/home/me/recipes");
    expect(repo.httpsUrl).toBe("/home/me/recipes");
    expect(repo.sshUrl).toBe("file:///home/me/recipes");
    expect(repo.name).toBe("recipes");
  });

  /**
   * canonicalize should raise a ConfigError naming the offending value when the
   * URL is not a local path at all, rather than producing a repository pointing
   * at nothing.
   *
   * canonicalize("./recipes"); // throws
   */
  it("should refuse a value that is not a local path", () => {
    expect(() => new LocalProvider().canonicalize("./recipes")).toThrow(
      /not a local repository path/
    );
  });

  /**
   * fetchIndex should read the working tree's index when there is one, so an
   * index being authored right now is picked up without a commit.
   *
   * fetchIndex(repo); // -> { text: "{...}", ref: "working tree" }
   */
  it("should read the index from the working tree", async () => {
    fs.writeFileSync(path.join(repoDir, "sous.index.json"), '{"formatVersion":1}', "utf8");
    const provider = new LocalProvider();

    const fetched = await provider.fetchIndex(provider.canonicalize(repoDir), {
      run: notAGitRepo,
    });

    expect(fetched.ref).toBe("working tree");
    expect(fetched.text).toBe('{"formatVersion":1}');
  });

  /**
   * fetchIndex should say plainly that a plain directory with no index publishes
   * nothing, rather than failing somewhere further from the mistake.
   *
   * fetchIndex(repo); // throws "publishes no sous index"
   */
  it("should explain a directory that publishes no index", async () => {
    const provider = new LocalProvider();
    await expect(
      provider.fetchIndex(provider.canonicalize(repoDir), { run: notAGitRepo })
    ).rejects.toThrow(/publishes no sous index/);
  });

  /**
   * fetchRecipeTree should copy the recipe folder out of the working tree when
   * the directory is not a git repository, since a plain directory has no
   * versions to honour.
   *
   * fetchRecipeTree(repo, "recipes/ns/name", "ns/name@1.0.0", dest);
   * // -> dest holds the folder's files
   */
  it("should copy the recipe folder when there is no git repository", async () => {
    const source = path.join(repoDir, "recipes", "workflow", "task-files");
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, "SKILL.md"), "# a skill", "utf8");

    const provider = new LocalProvider();
    const dest = path.join(tmp.path, "fetched");

    await provider.fetchRecipeTree(
      provider.canonicalize(repoDir),
      "recipes/workflow/task-files",
      "workflow/task-files@1.0.0",
      dest,
      { run: notAGitRepo }
    );

    expect(fs.readFileSync(path.join(dest, "SKILL.md"), "utf8")).toBe("# a skill");
  });

  /**
   * fetchRecipeTree should name the folder the index promised when it is not
   * there, so an index that has drifted from the repository says so.
   *
   * fetchRecipeTree(repo, "recipes/missing", tag, dest); // throws
   */
  it("should name a recipe folder that is not there", async () => {
    const provider = new LocalProvider();
    await expect(
      provider.fetchRecipeTree(
        provider.canonicalize(repoDir),
        "recipes/missing",
        "workflow/missing@1.0.0",
        path.join(tmp.path, "fetched"),
        { run: notAGitRepo }
      )
    ).rejects.toThrow(/has no folder 'recipes\/missing'/);
  });
});

describe("looksLikeLocalPath()", () => {
  /**
   * A path a person actually types should be recognized as a path: an explicit
   * relative one, a `~` one and an absolute one all count, whether or not they
   * exist yet, so a typo still gets a path error rather than a provider error.
   *
   * looksLikeLocalPath("../my-recipes"); // -> true
   */
  it("should recognize relative, home and absolute paths", () => {
    expect(looksLikeLocalPath("../my-recipes", tmp.path)).toBe(true);
    expect(looksLikeLocalPath("./my-recipes", tmp.path)).toBe(true);
    expect(looksLikeLocalPath("~/my-recipes", tmp.path)).toBe(true);
    expect(looksLikeLocalPath("/home/me/my-recipes", tmp.path)).toBe(true);
    expect(looksLikeLocalPath("file:///home/me/my-recipes", tmp.path)).toBe(true);
  });

  /**
   * A hosted URL should never be read as a path, in any of the spellings people
   * paste, so the hosted providers keep their URLs.
   *
   * looksLikeLocalPath("https://github.com/owner/repo"); // -> false
   */
  it("should not claim a hosted URL", () => {
    expect(looksLikeLocalPath("https://github.com/owner/repo", tmp.path)).toBe(false);
    expect(looksLikeLocalPath("ssh://gitlab.com/group/repo", tmp.path)).toBe(false);
    expect(looksLikeLocalPath("git@github.com:owner/repo.git", tmp.path)).toBe(false);
    expect(looksLikeLocalPath("   ", tmp.path)).toBe(false);
  });

  /**
   * A bare segment is a path only when a directory of that name really is
   * there, so a host name is never mistaken for a folder.
   *
   * looksLikeLocalPath("recipes", tmpPath); // -> true, the directory exists
   */
  it("should claim a bare segment only when the directory exists", () => {
    expect(looksLikeLocalPath("recipes", tmp.path)).toBe(true);
    expect(looksLikeLocalPath("not-there", tmp.path)).toBe(false);
  });
});

describe("resolveRepoArgument()", () => {
  /**
   * A relative path should come back absolute, resolved against the working
   * directory it was typed in, because that absolute form is what gets stored.
   *
   * resolveRepoArgument("./recipes", tmpPath); // -> "<tmp>/recipes"
   */
  it("should resolve a relative path against the working directory", () => {
    expect(resolveRepoArgument("./recipes", tmp.path)).toBe(repoDir);
    expect(resolveRepoArgument("recipes", tmp.path)).toBe(repoDir);
    expect(resolveRepoArgument(`file://${repoDir}`, tmp.path)).toBe(repoDir);
  });

  /**
   * A `~` path should be expanded, and a hosted URL should come back untouched,
   * so normalization never rewrites something a provider is about to parse.
   *
   * resolveRepoArgument("https://github.com/owner/repo"); // -> unchanged
   */
  it("should expand a home path and leave a URL alone", () => {
    expect(resolveRepoArgument("~/my-recipes", tmp.path)).toBe(
      path.join(os.homedir(), "my-recipes")
    );
    expect(resolveRepoArgument("https://github.com/owner/repo", tmp.path)).toBe(
      "https://github.com/owner/repo"
    );
  });
});

describe("assertLocalRepoDirectory()", () => {
  /**
   * A path that is not there should be reported as a path: what was typed, the
   * absolute path sous tried, and what it expected to find there. Which
   * provider handles it is not the reader's problem.
   *
   * assertLocalRepoDirectory("../nope", "/tmp/nope"); // throws
   */
  it("should name the typed path and the resolved path when nothing is there", () => {
    const resolved = path.join(tmp.path, "nope");
    expect(() => assertLocalRepoDirectory("../nope", resolved)).toThrow(
      /There is no directory at '\.\.\/nope'/
    );
    expect(() => assertLocalRepoDirectory("../nope", resolved)).toThrow(resolved);
    expect(() => assertLocalRepoDirectory("../nope", resolved)).not.toThrow(/--provider/);
  });

  /**
   * A directory that exists but publishes no repo manifest is not a repository,
   * and the message should say exactly that rather than failing later.
   *
   * assertLocalRepoDirectory("./recipes", repoDir); // throws
   */
  it("should say when a directory holds no repository manifest", () => {
    expect(() => assertLocalRepoDirectory("./recipes", repoDir)).toThrow(
      /is not a sous repository/
    );
    expect(() => assertLocalRepoDirectory("./recipes", repoDir)).toThrow(
      /sous\.repo\.yaml/
    );
  });

  /**
   * A directory holding a manifest should pass, which is the point of the
   * check: only a real repository gets through to the provider.
   */
  it("should accept a directory holding a repo manifest", () => {
    fs.writeFileSync(path.join(repoDir, "sous.repo.yaml"), "name: recipes\n");
    expect(() => assertLocalRepoDirectory("./recipes", repoDir)).not.toThrow();
  });
});

describe("requireProvider() with an explicit provider", () => {
  /**
   * Naming a provider that plainly does not own the URL should be refused, and
   * the message should name the one that does, so '--provider github' on a path
   * is a clear mistake rather than a confusing failure later.
   *
   * requireProvider("/home/me/repo", "github"); // throws
   */
  it("should refuse a provider that contradicts the URL", () => {
    expect(() => requireProvider("/home/me/repo", "github")).toThrow(
      /The github provider does not handle \/home\/me\/repo/
    );
    expect(() => requireProvider("/home/me/repo", "github")).toThrow(
      /that is a local path, which the local provider handles/
    );
    expect(() => requireProvider("https://github.com/owner/repo", "local")).toThrow(
      /the github provider handles/
    );
  });

  /**
   * A named provider should still be honoured for a host nobody recognizes,
   * which is exactly what a self-hosted instance needs.
   *
   * requireProvider("https://git.mycorp.example/group/repo", "gitlab").id; // -> "gitlab"
   */
  it("should honour a named provider for an unrecognized host", () => {
    expect(requireProvider("https://git.mycorp.example/group/repo", "gitlab").id).toBe(
      "gitlab"
    );
  });

  /**
   * With no provider named, an unrecognized host should list the providers sous
   * ships without pushing the reader at one of them.
   *
   * requireProvider("https://git.mycorp.example/group/repo"); // throws
   */
  it("should list providers without suggesting one for an unknown host", () => {
    expect(() => requireProvider("https://git.mycorp.example/group/repo")).toThrow(
      /Sous ships these providers: github, gitlab, local/
    );
    expect(() => requireProvider("https://git.mycorp.example/group/repo")).toThrow(
      /--provider <provider>/
    );
  });
});
