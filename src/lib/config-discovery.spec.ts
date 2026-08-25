import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  CONFIG_FILE_NAMES,
  CONFD_DIR_NAME,
  LAYER_EXTENSIONS,
  candidateDirs,
  discoverConfig,
  expandHome,
  findConfigInSousDir,
  formatNotFoundMessage,
  listConfDirLayers,
  assertUniqueLayerBaseNames,
  refreshDiscoveredConfig,
  resolveConfigFlag,
} from "./config-discovery.js";
import { ConfigError } from "./errors.js";
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
     * findConfigInSousDir() should recognise sous.config.yaml, added in the
     * composable-config work. CONFIG_FILE_NAMES lists it (and NOT .yml).
     *
     * // only .sous/sous.config.yaml exists
     * findConfigInSousDir("<tmp>/.sous"); // -> ".../sous.config.yaml"
     */
    it("should find sous.config.yaml (and CONFIG_FILE_NAMES lists yaml, not yml)", () => {
      const yaml = write("y/.sous/sous.config.yaml", "name: x\n");
      expect(findConfigInSousDir(path.join(tmp.path, "y/.sous"))).toBe(yaml);
      expect(CONFIG_FILE_NAMES).toContain("sous.config.yaml");
      expect(CONFIG_FILE_NAMES).not.toContain("sous.config.yml");
    });

    /**
     * findConfigInSousDir() must NOT silently pick a winner when more than one
     * primary config exists in a single .sous/. It throws a ConfigError whose
     * message names every conflicting file.
     *
     * // .sous/ holds both sous.config.js and sous.config.json
     * findConfigInSousDir("<tmp>/.sous"); // -> throws ConfigError naming both
     */
    it("should throw ConfigError listing every file when multiple primaries exist", () => {
      const js = write(".sous/sous.config.js");
      const json = write(".sous/sous.config.json");
      const sousDir = path.join(tmp.path, ".sous");
      expect(() => findConfigInSousDir(sousDir)).toThrow(ConfigError);
      try {
        findConfigInSousDir(sousDir);
        throw new Error("expected findConfigInSousDir to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigError);
        const message = (error as Error).message;
        expect(message).toContain(js);
        expect(message).toContain(json);
      }
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
      const sousDir = path.join(tmp.path, ".sous");
      const result = discoverConfig(tmp.path);
      expect(result).toEqual({
        configPath,
        sousDir,
        confDir: path.join(sousDir, CONFD_DIR_NAME),
        layerPaths: [configPath],
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

    /**
     * discoverConfig() should set confDir to <sousDir>/conf.d and, when the
     * directory exists, append its layer files to layerPaths after the primary.
     * The primary config is always first.
     *
     * // .sous/sous.config.js + .sous/conf.d/10-a.json exist
     * discoverConfig("<tmp>").layerPaths;
     * // -> [".../sous.config.js", ".../conf.d/10-a.json"]
     */
    it("should populate confDir and append conf.d layers after the primary", () => {
      const configPath = write(".sous/sous.config.js");
      const layer = write(".sous/conf.d/10-a.json");
      const sousDir = path.join(tmp.path, ".sous");
      const result = discoverConfig(tmp.path);
      expect(result?.confDir).toBe(path.join(sousDir, CONFD_DIR_NAME));
      expect(result?.layerPaths).toEqual([configPath, layer]);
    });

    /**
     * conf.d enumeration is BYTEWISE (plain string <), not numeric: a file named
     * 10-b.json sorts before 2-a.json because '1' < '2'. The primary config
     * always leads regardless.
     *
     * // conf.d holds 2-a.json and 10-b.json
     * discoverConfig("<tmp>").layerPaths;
     * // -> [primary, ".../conf.d/10-b.json", ".../conf.d/2-a.json"]
     */
    it("should order conf.d layers bytewise so 10-b sorts before 2-a", () => {
      const configPath = write(".sous/sous.config.js");
      const ten = write(".sous/conf.d/10-b.json");
      const two = write(".sous/conf.d/2-a.json");
      const result = discoverConfig(tmp.path);
      expect(result?.layerPaths).toEqual([configPath, ten, two]);
    });

    /**
     * conf.d enumeration is non-recursive and extension-filtered: files in a
     * nested subdirectory, and files with an unrecognised extension, are ignored.
     *
     * // conf.d/keep.json, conf.d/notes.md, conf.d/nested/deep.json
     * discoverConfig("<tmp>").layerPaths; // -> [primary, ".../conf.d/keep.json"]
     */
    it("should ignore nested and non-layer files in conf.d", () => {
      const configPath = write(".sous/sous.config.js");
      const keep = write(".sous/conf.d/keep.json");
      write(".sous/conf.d/notes.md", "# not a layer");
      write(".sous/conf.d/nested/deep.json");
      const result = discoverConfig(tmp.path);
      expect(result?.layerPaths).toEqual([configPath, keep]);
    });

    /**
     * A missing conf.d directory is not an error: layerPaths is just the primary.
     *
     * // no .sous/conf.d/ at all
     * discoverConfig("<tmp>").layerPaths; // -> [primary]
     */
    it("should treat a missing conf.d directory as no layers", () => {
      const configPath = write(".sous/sous.config.js");
      const result = discoverConfig(tmp.path);
      expect(fs.existsSync(path.join(tmp.path, ".sous", CONFD_DIR_NAME))).toBe(false);
      expect(result?.layerPaths).toEqual([configPath]);
    });

    /**
     * The duplicate-baseName rule spans the primary AND conf.d: a conf.d layer
     * whose baseName (filename minus final extension) matches the primary's
     * baseName throws a ConfigError naming both files.
     *
     * // primary sous.config.json + conf.d/sous.config.yaml
     * discoverConfig("<tmp>"); // -> throws ConfigError naming both
     */
    it("should throw when a conf.d layer's baseName collides with the primary", () => {
      const primary = write(".sous/sous.config.json");
      const dup = write(".sous/conf.d/sous.config.yaml", "name: x\n");
      expect(() => discoverConfig(tmp.path)).toThrow(ConfigError);
      try {
        discoverConfig(tmp.path);
        throw new Error("expected discoverConfig to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigError);
        const message = (error as Error).message;
        expect(message).toContain(primary);
        expect(message).toContain(dup);
      }
    });

    /**
     * The duplicate-baseName rule also catches two conf.d layers that differ only
     * by extension: 500-repos.json and 500-repos.yaml share the baseName
     * '500-repos'.
     *
     * // conf.d/500-repos.json + conf.d/500-repos.yaml
     * discoverConfig("<tmp>"); // -> throws ConfigError naming both
     */
    it("should throw when two conf.d layers differ only by extension", () => {
      write(".sous/sous.config.js");
      const asJson = write(".sous/conf.d/500-repos.json");
      const asYaml = write(".sous/conf.d/500-repos.yaml", "a: 1\n");
      expect(() => discoverConfig(tmp.path)).toThrow(ConfigError);
      try {
        discoverConfig(tmp.path);
        throw new Error("expected discoverConfig to throw");
      } catch (error) {
        const message = (error as Error).message;
        expect(message).toContain(asJson);
        expect(message).toContain(asYaml);
      }
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
      const sousDir = path.join(tmp.path, ".sous");
      expect(resolveConfigFlag(configPath)).toEqual({
        configPath,
        sousDir,
        confDir: path.join(sousDir, CONFD_DIR_NAME),
        layerPaths: [configPath],
        source: "flag",
      });
    });

    /**
     * resolveConfigFlag() must populate confDir/layerPaths just like discovery:
     * it enumerates the sibling conf.d/ of the resolved config and runs the
     * duplicate-baseName check.
     *
     * // --config .../sous.config.js, with conf.d/10-a.json alongside
     * resolveConfigFlag(configPath).layerPaths;
     * // -> [configPath, ".../conf.d/10-a.json"]
     */
    it("should populate confDir and conf.d layers for a flag path", () => {
      const configPath = write(".sous/sous.config.js");
      const layer = write(".sous/conf.d/10-a.json");
      const sousDir = path.join(tmp.path, ".sous");
      const result = resolveConfigFlag(configPath);
      expect(result.confDir).toBe(path.join(sousDir, CONFD_DIR_NAME));
      expect(result.layerPaths).toEqual([configPath, layer]);
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
     * formatNotFoundMessage() should mention sous.config.yaml among the config
     * file names it looked for, now that yaml is a recognised primary.
     *
     * formatNotFoundMessage("/a/b"); // -> text containing "sous.config.yaml"
     */
    it("should mention sous.config.yaml among the recognised names", () => {
      expect(formatNotFoundMessage("/a/b")).toContain("sous.config.yaml");
    });

    /**
     * The embedded sample config must show the flat single-project shape: fields
     * like `name` and `compilation` at the top level, with no `projects` map or
     * `defaultProject` key.
     *
     * formatNotFoundMessage("/a/b");
     * // -> sample contains 'name: "My Project"' but no "projects"/"defaultProject"
     */
    it("should show a flat sample config with no projects map or defaultProject", () => {
      const message = formatNotFoundMessage("/a/b");
      expect(message).toContain('name: "My Project"');
      expect(message).toContain("compilation:");
      expect(message).not.toContain("projects");
      expect(message).not.toContain("defaultProject");
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

  // -------------------------------------------------------------------------
  // listConfDirLayers()
  // -------------------------------------------------------------------------

  describe("listConfDirLayers()", () => {
    /**
     * listConfDirLayers() returns an empty list (no error) when the directory
     * does not exist.
     */
    it("should return [] for a missing conf.d directory", () => {
      expect(listConfDirLayers(path.join(tmp.path, "conf.d"))).toEqual([]);
    });

    /**
     * listConfDirLayers() keeps only files with a recognised layer extension,
     * ignoring other files, and returns them bytewise-sorted as absolute paths.
     * LAYER_EXTENSIONS covers .js/.mjs/.json/.yaml.
     */
    it("should keep only layer-extension files, sorted bytewise", () => {
      const confDir = mkdir("conf.d");
      const a = write("conf.d/10-b.json");
      const b = write("conf.d/2-a.yaml", "x: 1\n");
      const c = write("conf.d/1-c.mjs", "export const config = {};");
      write("conf.d/README.md", "# ignore");
      write("conf.d/notes.txt", "ignore");
      expect(listConfDirLayers(confDir)).toEqual([c, a, b]);
      expect(LAYER_EXTENSIONS).toEqual([".js", ".mjs", ".json", ".yaml"]);
    });

    /**
     * listConfDirLayers() is non-recursive: a nested directory (even one holding
     * a layer-extension file) is not descended into.
     */
    it("should not recurse into subdirectories", () => {
      const confDir = mkdir("conf.d");
      const top = write("conf.d/top.json");
      write("conf.d/sub/inner.json");
      expect(listConfDirLayers(confDir)).toEqual([top]);
    });
  });

  // -------------------------------------------------------------------------
  // assertUniqueLayerBaseNames()
  // -------------------------------------------------------------------------

  describe("assertUniqueLayerBaseNames()", () => {
    /**
     * assertUniqueLayerBaseNames() is a no-op when every baseName (filename minus
     * final extension) is unique, even across different extensions.
     */
    it("should not throw when all baseNames are unique", () => {
      expect(() =>
        assertUniqueLayerBaseNames(["/x/sous.config.js", "/x/conf.d/10-a.json", "/x/conf.d/20-b.yaml"])
      ).not.toThrow();
    });

    /**
     * assertUniqueLayerBaseNames() throws a ConfigError naming both files when two
     * paths share a baseName once their final extension is stripped.
     */
    it("should throw ConfigError naming both duplicates", () => {
      const paths = ["/x/conf.d/500-repos.json", "/x/conf.d/500-repos.yaml"];
      expect(() => assertUniqueLayerBaseNames(paths)).toThrow(ConfigError);
      try {
        assertUniqueLayerBaseNames(paths);
        throw new Error("expected assertUniqueLayerBaseNames to throw");
      } catch (error) {
        const message = (error as Error).message;
        expect(message).toContain("500-repos");
        expect(message).toContain(paths[0]);
        expect(message).toContain(paths[1]);
      }
    });
  });

  // -------------------------------------------------------------------------
  // refreshDiscoveredConfig()
  // -------------------------------------------------------------------------

  describe("refreshDiscoveredConfig()", () => {
    /**
     * refreshDiscoveredConfig() re-enumerates conf.d so layer files added after
     * the initial discovery show up. This is what watch mode relies on.
     *
     * // discover with no conf.d, then drop in a layer, then refresh
     * refreshDiscoveredConfig(discovered).layerPaths; // -> [primary, newLayer]
     */
    it("should pick up conf.d layers added after the initial discovery", () => {
      const configPath = write(".sous/sous.config.js");
      const discovered = discoverConfig(tmp.path);
      expect(discovered?.layerPaths).toEqual([configPath]);

      const layer = write(".sous/conf.d/10-a.json");
      const refreshed = refreshDiscoveredConfig(discovered!);
      expect(refreshed.layerPaths).toEqual([configPath, layer]);
      expect(refreshed.configPath).toBe(configPath);
      expect(refreshed.source).toBe(discovered!.source);
    });

    /**
     * refreshDiscoveredConfig() drops layer files that have since disappeared.
     */
    it("should drop conf.d layers removed after the initial discovery", () => {
      const configPath = write(".sous/sous.config.js");
      const layer = write(".sous/conf.d/10-a.json");
      const discovered = discoverConfig(tmp.path);
      expect(discovered?.layerPaths).toEqual([configPath, layer]);

      fs.rmSync(layer);
      const refreshed = refreshDiscoveredConfig(discovered!);
      expect(refreshed.layerPaths).toEqual([configPath]);
    });
  });
});
