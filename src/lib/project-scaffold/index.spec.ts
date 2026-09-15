import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  configFileNameFor,
  configSchemaUrl,
  scaffoldProject,
  sousDirFor,
  STARTER_PROMPT_RELATIVE_PATH,
} from "./index.js";
import { IGNORE_BLOCK_END, IGNORE_BLOCK_START } from "../repos/links.js";
import { isConfigError } from "../errors.js";
import { loadSettings } from "../settings.js";
import { resolveConfigFlag } from "../config-discovery.js";
import { makeTmpDir, type TmpDir } from "../../test/utils/tmp.js";

/** The version named in scaffolded files; any valid semver will do. */
const SOUS_VERSION = "0.1.1";

/** Every path under `root`, relative to it, sorted, so two snapshots compare. */
function listTree(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else found.push(path.relative(root, full));
    }
  };
  walk(root);
  return found.sort();
}

describe("scaffoldProject()", () => {
  let tmp: TmpDir;
  let projectRoot: string;
  let sousDir: string;

  beforeEach(() => {
    tmp = makeTmpDir("sous-project-scaffold-");
    projectRoot = path.join(tmp.path, "my-app");
    fs.mkdirSync(projectRoot, { recursive: true });
    sousDir = sousDirFor(projectRoot);
  });

  afterEach(() => {
    tmp.cleanup();
  });

  /**
   * scaffoldProject should write every file a new project needs under `.sous/`
   * and report them, relative to the project root, in the order written.
   *
   * await scaffoldProject({ sousDir: "/tmp/my-app/.sous", sousVersion: "0.1.1" });
   * // -> writes sous.config.js, prompts/AGENTS.md, .env, .env.local.example
   * //    and .gitignore inside .sous/
   */
  it("should write every file a new project needs", async () => {
    const result = await scaffoldProject({ sousDir, sousVersion: SOUS_VERSION });

    expect(result.files).toEqual([
      ".sous/sous.config.js",
      `.sous/${STARTER_PROMPT_RELATIVE_PATH}`,
      ".sous/.env",
      ".sous/.env.local.example",
      ".sous/.gitignore",
    ]);
    for (const relative of result.files) {
      expect(fs.existsSync(path.join(projectRoot, relative))).toBe(true);
    }
    expect(result.configPath).toBe(path.join(sousDir, "sous.config.js"));
    expect(result.format).toBe("js");
    expect(result.dryRun).toBe(false);
  });

  /**
   * The config's display name should default to the project root's own
   * directory name, and an explicit name should win over it.
   *
   * await scaffoldProject({ sousDir: "/tmp/my-app/.sous", ... });
   * // -> name "my-app"
   */
  it("should name the project after its directory unless told otherwise", async () => {
    const defaulted = await scaffoldProject({ sousDir, sousVersion: SOUS_VERSION });
    expect(defaulted.name).toBe("my-app");
    expect(fs.readFileSync(defaulted.configPath, "utf8")).toContain('name: "my-app"');

    const other = path.join(tmp.path, "other");
    fs.mkdirSync(other);
    const named = await scaffoldProject({
      sousDir: sousDirFor(other),
      name: "Other Project",
      sousVersion: SOUS_VERSION,
    });
    expect(named.name).toBe("Other Project");
  });

  /**
   * A scaffolded config should load through the real settings loader, with the
   * starter target and the recipe output the scaffold promises.
   *
   * await scaffoldProject({ ... });
   * // -> loadSettings(...) resolves; compilation.targets has one entryPoint
   */
  it("should write a config that loads through the real settings loader", async () => {
    const result = await scaffoldProject({ sousDir, sousVersion: SOUS_VERSION });

    const settings = await loadSettings(resolveConfigFlag(result.configPath, projectRoot));
    expect(settings.name).toBe("my-app");
    expect(settings.compilation?.targets).toHaveLength(1);
    expect(settings.compilation?.targets?.[0]?.entryPoint).toBe(
      `\${sousDir}/${STARTER_PROMPT_RELATIVE_PATH}`
    );
    expect(settings.recipeOutputs?.skills).toEqual(["${projectRoot}/.claude/skills"]);
  });

  /**
   * The `json` format should write `sous.config.json`, bound to the shipped
   * schema for this sous version through `$schema`, and it should load too.
   *
   * await scaffoldProject({ ..., format: "json" });
   * // -> .sous/sous.config.json with "$schema": "https://raw.githubusercontent.com/.../v0.1.1/..."
   */
  it("should write a JSON config bound to the schema for this version", async () => {
    const result = await scaffoldProject({
      sousDir,
      format: "json",
      sousVersion: SOUS_VERSION,
    });

    expect(result.configPath).toBe(path.join(sousDir, configFileNameFor("json")));
    const parsed = JSON.parse(fs.readFileSync(result.configPath, "utf8")) as {
      $schema: string;
      name: string;
    };
    expect(parsed.$schema).toBe(configSchemaUrl(SOUS_VERSION));
    expect(parsed.$schema).toContain(`/v${SOUS_VERSION}/sous.config.schema.json`);
    expect(parsed.name).toBe("my-app");

    const settings = await loadSettings(resolveConfigFlag(result.configPath, projectRoot));
    expect(settings.compilation?.targets).toHaveLength(1);
  });

  /**
   * A `.sous/` that already holds a primary config should be refused with a
   * ConfigError naming that config, and nothing at all should be written.
   *
   * // .sous/sous.config.yaml exists
   * await scaffoldProject({ ... });
   * // -> throws "already set up for sous"; the tree is unchanged
   */
  it("should refuse a project that already holds a primary config", async () => {
    fs.mkdirSync(sousDir, { recursive: true });
    const existing = path.join(sousDir, "sous.config.yaml");
    fs.writeFileSync(existing, "name: Existing\n");
    const before = listTree(projectRoot);

    await expect(scaffoldProject({ sousDir, sousVersion: SOUS_VERSION })).rejects.toThrow(
      /already set up for sous/
    );
    await scaffoldProject({ sousDir, sousVersion: SOUS_VERSION }).catch((error: unknown) => {
      expect(isConfigError(error)).toBe(true);
      expect((error as Error).message).toContain(existing);
    });

    expect(listTree(projectRoot)).toEqual(before);
    expect(fs.readFileSync(existing, "utf8")).toBe("name: Existing\n");
  });

  /**
   * Any other file the scaffold would write, already present, should be
   * refused by name, and nothing should be written.
   *
   * // .sous/.env exists, no config
   * await scaffoldProject({ ... });
   * // -> throws naming .sous/.env; the tree is unchanged
   */
  it("should refuse to overwrite any file it would write", async () => {
    fs.mkdirSync(sousDir, { recursive: true });
    const envPath = path.join(sousDir, ".env");
    fs.writeFileSync(envPath, "TEAM=us\n");
    const before = listTree(projectRoot);

    await expect(scaffoldProject({ sousDir, sousVersion: SOUS_VERSION })).rejects.toThrow(
      envPath
    );

    expect(listTree(projectRoot)).toEqual(before);
    expect(fs.readFileSync(envPath, "utf8")).toBe("TEAM=us\n");
  });

  /**
   * A dry run should plan and check everything but write nothing, and say so.
   *
   * await scaffoldProject({ ..., dryRun: true });
   * // -> { dryRun: true, files: [...] } and no .sous/ on disk
   */
  it("should write nothing on a dry run", async () => {
    const result = await scaffoldProject({
      sousDir,
      dryRun: true,
      sousVersion: SOUS_VERSION,
    });

    expect(result.dryRun).toBe(true);
    expect(result.files).toHaveLength(5);
    expect(fs.existsSync(sousDir)).toBe(false);
  });

  /**
   * An existing `.sous/.gitignore` should keep every line of its own and gain
   * the sous-managed block once; a block already there is left as one block.
   *
   * // .sous/.gitignore holds "scratch/"
   * await scaffoldProject({ ... });
   * // -> "scratch/" survives, and the managed block appears exactly once
   */
  it("should merge the managed block into an existing ignore file", async () => {
    fs.mkdirSync(sousDir, { recursive: true });
    const ignorePath = path.join(sousDir, ".gitignore");
    fs.writeFileSync(ignorePath, "scratch/\n");

    await scaffoldProject({ sousDir, sousVersion: SOUS_VERSION });

    const written = fs.readFileSync(ignorePath, "utf8");
    expect(written.startsWith("scratch/\n")).toBe(true);
    expect(written.split("\n").filter((line) => line === IGNORE_BLOCK_START)).toHaveLength(1);
    expect(written.split("\n").filter((line) => line === IGNORE_BLOCK_END)).toHaveLength(1);
    expect(written).toContain("sous.state.json");
    expect(written).toContain(".env.local");
  });
});
