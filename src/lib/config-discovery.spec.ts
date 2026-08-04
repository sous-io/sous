import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  CONFIG_FILE_NAMES,
  candidateDirs,
  discoverConfig,
  expandHome,
  findConfigInSousDir,
  formatNotFoundMessage,
  resolveConfigFlag,
} from "./config-discovery.js";
import { makeTmpDir, type TmpDir } from "../test/utils/tmp.js";

/**
 * These tests use real temp directories rather than memfs: discovery walks all
 * the way to the filesystem root, and a mocked fs would hide the interaction
 * between `.sous/` directories at different depths.
 */
describe("config-discovery", () => {
  let tmp: TmpDir;

  /** Creates a directory (recursively) under the temp root and returns its path. */
  function mkdir(relative: string): string {
    const full = path.join(tmp.path, relative);
    fs.mkdirSync(full, { recursive: true });
    return full;
  }

  /** Writes a file (creating parents) under the temp root and returns its path. */
  function write(relative: string, content = "{}"): string {
    const full = path.join(tmp.path, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf8");
    return full;
  }

  beforeEach(() => {
    tmp = makeTmpDir("sous-discovery-");
  });

  afterEach(() => {
    tmp.cleanup();
  });

  // -------------------------------------------------------------------------
  // candidateDirs()
  // -------------------------------------------------------------------------

  describe("candidateDirs()", () => {
    /**
     * candidateDirs() should list the starting directory first, then each parent
     * in turn, ending at the filesystem root.
     *
     * candidateDirs("/a/b/c");
     * // -> ["/a/b/c", "/a/b", "/a", "/"]
     */
    it("should list the start dir then every parent up to the root", () => {
      const dirs = candidateDirs("/a/b/c");
      expect(dirs).toEqual(["/a/b/c", "/a/b", "/a", "/"]);
    });

    /**
     * candidateDirs() should terminate (not loop) when given the root itself.
     *
     * candidateDirs("/"); // -> ["/"]
     */
    it("should return just the root when given the root", () => {
      expect(candidateDirs("/")).toEqual(["/"]);
    });

    /**
     * candidateDirs() should resolve a relative start dir against cwd before
     * walking, so the result is always absolute.
     *
     * candidateDirs(".")[0]; // -> process.cwd()
     */
    it("should resolve a relative start dir to an absolute path", () => {
      expect(candidateDirs(".")[0]).toBe(process.cwd());
    });
  });

  // -------------------------------------------------------------------------
  // findConfigInSousDir()
  // -------------------------------------------------------------------------

  describe("findConfigInSousDir()", () => {
    /**
     * findConfigInSousDir() should return the path to sous.config.js when present.
     *
     * // .sous/sous.config.js exists
     * findConfigInSousDir("<tmp>/.sous"); // -> "<tmp>/.sous/sous.config.js"
     */
    it("should find sous.config.js", () => {
      const configPath = write(".sous/sous.config.js");
      expect(findConfigInSousDir(path.join(tmp.path, ".sous"))).toBe(configPath);
    });

    /**
     * findConfigInSousDir() should accept .mjs and .json variants too.
     *
     * // only .sous/sous.config.json exists
     * findConfigInSousDir("<tmp>/.sous"); // -> ".../sous.config.json"
     */
    it("should find sous.config.mjs and sous.config.json", () => {
      const mjs = write("a/.sous/sous.config.mjs");
      expect(findConfigInSousDir(path.join(tmp.path, "a/.sous"))).toBe(mjs);

      const json = write("b/.sous/sous.config.json");
      expect(findConfigInSousDir(path.join(tmp.path, "b/.sous"))).toBe(json);
    });

    /**
     * findConfigInSousDir() should prefer .js over .mjs over .json when more than
     * one is present, matching CONFIG_FILE_NAMES order.
     *
     * // all three exist
     * findConfigInSousDir("<tmp>/.sous"); // -> ".../sous.config.js"
     */
    it("should prefer .js over .mjs over .json", () => {
      write(".sous/sous.config.json");
      write(".sous/sous.config.mjs");
      const js = write(".sous/sous.config.js");
      expect(findConfigInSousDir(path.join(tmp.path, ".sous"))).toBe(js);
      expect(CONFIG_FILE_NAMES[0]).toBe("sous.config.js");
    });

    /**
     * findConfigInSousDir() should return null when the directory holds no
     * recognised config file name.
     *
     * // .sous/ contains only notes.md
     * findConfigInSousDir("<tmp>/.sous"); // -> null
     */
    it("should return null when no recognised config file is present", () => {
      write(".sous/notes.md", "# hi");
      expect(findConfigInSousDir(path.join(tmp.path, ".sous"))).toBeNull();
    });

    /**
     * findConfigInSousDir() should ignore a *directory* that happens to be named
     * sous.config.js — only files count.
     *
     * // .sous/sous.config.js/ is a directory
     * findConfigInSousDir("<tmp>/.sous"); // -> null
     */
    it("should ignore a directory named like a config file", () => {
      mkdir(".sous/sous.config.js");
      expect(findConfigInSousDir(path.join(tmp.path, ".sous"))).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // discoverConfig()
  // -------------------------------------------------------------------------

  describe("discoverConfig()", () => {
    /**
     * discoverConfig() should find a config in the starting directory's own
     * .sous/ directory.
     *
     * // <tmp>/.sous/sous.config.js exists
     * discoverConfig("<tmp>");
     * // -> { configPath: ".../sous.config.js", sousDir: "<tmp>/.sous", source: "walk-up" }
     */
    it("should find a config in the start directory's .sous/", () => {
      const configPath = write(".sous/sous.config.js");
      const result = discoverConfig(tmp.path);
      expect(result).toEqual({
        configPath,
        sousDir: path.join(tmp.path, ".sous"),
        source: "walk-up",
      });
    });

    /**
     * discoverConfig() should walk up through parent directories to find the
     * config, so running sous from anywhere inside a project works.
     *
     * // <tmp>/.sous/sous.config.js exists
     * discoverConfig("<tmp>/deep/nested/dir"); // -> finds <tmp>/.sous/sous.config.js
     */
    it("should walk up parent directories to find the config", () => {
      const configPath = write(".sous/sous.config.js");
      const deep = mkdir("src/lib/nested");
      const result = discoverConfig(deep);
      expect(result?.configPath).toBe(configPath);
      expect(result?.sousDir).toBe(path.join(tmp.path, ".sous"));
    });

    /**
     * discoverConfig() should stop at the nearest .sous/ that holds a config, so
     * an inner project config wins over an outer one.
     *
     * // both <tmp>/.sous/ and <tmp>/inner/.sous/ hold configs
     * discoverConfig("<tmp>/inner/sub"); // -> the inner config
     */
    it("should return the nearest config when several ancestors have one", () => {
      write(".sous/sous.config.js");
      const inner = write("inner/.sous/sous.config.js");
      const start = mkdir("inner/sub");
      expect(discoverConfig(start)?.configPath).toBe(inner);
    });

    /**
     * discoverConfig() should keep walking past a .sous/ directory that contains
     * no config file, rather than treating it as a stopping point.
     *
     * // <tmp>/.sous/sous.config.js exists; <tmp>/inner/.sous/ is empty
     * discoverConfig("<tmp>/inner"); // -> the outer config
     */
    it("should keep walking past a .sous/ directory with no config in it", () => {
      const outer = write(".sous/sous.config.js");
      mkdir("inner/.sous");
      const result = discoverConfig(path.join(tmp.path, "inner"));
      expect(result?.configPath).toBe(outer);
    });

    /**
     * discoverConfig() should return null when no .sous/ config exists anywhere
     * from the start directory up to the filesystem root.
     *
     * discoverConfig("<empty tmp>"); // -> null
     */
    it("should return null when no config exists anywhere up the tree", () => {
      // os.tmpdir() and its ancestors are not expected to contain a .sous/ config.
      expect(discoverConfig(tmp.path)).toBeNull();
    });

    /**
     * discoverConfig() should not be confused by a *file* named .sous — it must
     * be a directory.
     *
     * // <tmp>/.sous is a regular file
     * discoverConfig("<tmp>"); // -> null
     */
    it("should ignore a plain file named .sous", () => {
      write(".sous", "not a directory");
      expect(discoverConfig(tmp.path)).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // resolveConfigFlag()
  // -------------------------------------------------------------------------

  describe("resolveConfigFlag()", () => {
    /**
     * resolveConfigFlag() should accept a direct path to a config file and report
     * source "flag", with sousDir set to the file's parent directory.
     *
     * resolveConfigFlag("<tmp>/.sous/sous.config.js");
     * // -> { configPath, sousDir: "<tmp>/.sous", source: "flag" }
     */
    it("should accept a direct path to a config file", () => {
      const configPath = write(".sous/sous.config.js");
      expect(resolveConfigFlag(configPath)).toEqual({
        configPath,
        sousDir: path.join(tmp.path, ".sous"),
        source: "flag",
      });
    });

    /**
     * resolveConfigFlag() should resolve a relative path against the supplied cwd.
     *
     * resolveConfigFlag(".sous/sous.config.js", "<tmp>"); // -> absolute config path
     */
    it("should resolve a relative path against cwd", () => {
      const configPath = write(".sous/sous.config.js");
      expect(resolveConfigFlag(".sous/sous.config.js", tmp.path).configPath).toBe(configPath);
    });

    /**
     * resolveConfigFlag() should search a directory argument for a config file,
     * so `--config <some>/.sous` works.
     *
     * resolveConfigFlag("<tmp>/.sous"); // -> the config inside it
     */
    it("should search a directory argument for a config file", () => {
      const configPath = write(".sous/sous.config.js");
      const result = resolveConfigFlag(path.join(tmp.path, ".sous"));
      expect(result.configPath).toBe(configPath);
      expect(result.sousDir).toBe(path.join(tmp.path, ".sous"));
    });

    /**
     * resolveConfigFlag() should look inside a directory's `.sous/` child when the
     * directory itself holds no config, so `--config .` works from a project root.
     *
     * resolveConfigFlag("<tmp>"); // -> "<tmp>/.sous/sous.config.js"
     */
    it("should look in a directory's .sous/ child when the directory has no config", () => {
      const configPath = write(".sous/sous.config.js");
      const result = resolveConfigFlag(tmp.path);
      expect(result.configPath).toBe(configPath);
      expect(result.sousDir).toBe(path.join(tmp.path, ".sous"));
    });

    /**
     * resolveConfigFlag() should throw a message naming the missing path when the
     * argument does not exist.
     *
     * resolveConfigFlag("<tmp>/nope.js"); // -> throws /not found/
     */
    it("should throw when the path does not exist", () => {
      expect(() => resolveConfigFlag(path.join(tmp.path, "nope.js"))).toThrow(/not found/);
    });

    /**
     * resolveConfigFlag() should throw, listing the names it looked for, when the
     * directory argument holds no config file at any level.
     *
     * resolveConfigFlag("<empty dir>"); // -> throws /no sous config file/
     */
    it("should throw when a directory argument holds no config file", () => {
      const empty = mkdir("empty");
      expect(() => resolveConfigFlag(empty)).toThrow(/no sous config file/);
      expect(() => resolveConfigFlag(empty)).toThrow(/sous\.config\.js/);
    });
  });

  // -------------------------------------------------------------------------
  // expandHome()
  // -------------------------------------------------------------------------

  describe("expandHome()", () => {
    /**
     * expandHome() should replace a leading "~/" with the value of $HOME.
     *
     * // HOME=/home/me
     * expandHome("~/projects"); // -> "/home/me/projects"
     */
    it("should expand a leading ~/ to the home directory", () => {
      const home = process.env.HOME;
      if (!home) return;
      expect(expandHome("~/projects")).toBe(path.join(home, "projects"));
    });

    /**
     * expandHome() should leave a path with no leading tilde untouched, including
     * a tilde that appears mid-path.
     *
     * expandHome("/a/b~c"); // -> "/a/b~c"
     */
    it("should leave paths without a leading tilde unchanged", () => {
      expect(expandHome("/a/b~c")).toBe("/a/b~c");
      expect(expandHome("./rel")).toBe("./rel");
    });
  });

  // -------------------------------------------------------------------------
  // formatNotFoundMessage()
  // -------------------------------------------------------------------------

  describe("formatNotFoundMessage()", () => {
    /**
     * formatNotFoundMessage() should name the directories that were checked and
     * explain both fixes (create .sous/ or pass --config).
     *
     * formatNotFoundMessage("/a/b");
     * // -> text containing "/a/b/.sous/", "sous.config.js", and "--config"
     */
    it("should name the checked directories and both fixes", () => {
      const message = formatNotFoundMessage("/a/b");
      expect(message).toContain("No sous config found");
      expect(message).toContain(path.join("/a/b", ".sous"));
      expect(message).toContain("sous.config.js");
      expect(message).toContain("--config");
    });

    /**
     * formatNotFoundMessage() should summarise rather than list every ancestor
     * when the start directory is deeply nested.
     *
     * formatNotFoundMessage("/a/b/c/d/e/f/g/h/i/j");
     * // -> text containing "... and N more parent directories"
     */
    it("should summarise the tail of a long ancestor list", () => {
      const message = formatNotFoundMessage("/a/b/c/d/e/f/g/h/i/j");
      expect(message).toMatch(/and \d+ more parent director/);
    });
  });
});
