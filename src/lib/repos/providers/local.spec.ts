import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTmpDir, type TmpDir } from "../../../test/utils/tmp.js";
import { LocalProvider, localRepoPath } from "./local.js";
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
  tmp = makeTmpDir("sous-file-provider-");
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
