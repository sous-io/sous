import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTmpDir, type TmpDir } from "../../test/utils/tmp.js";
import { makeSettings } from "../../test/utils/settings.js";
import { buildRecipeTargets, destinationsFor, projectRootFor } from "./recipe-targets.js";
import type { LockedRecipeLocation } from "./locked-recipes.js";

let tmp: TmpDir;
let sousDir: string;
let recipeDir: string;

/** Writes a file, creating its parent directories. */
function write(filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, "utf8");
}

/** Writes a recipe manifest with the given contents block. */
function writeManifest(contents: unknown[]): void {
  write(
    path.join(recipeDir, "sous.recipe.json"),
    JSON.stringify({
      formatVersion: 1,
      namespace: "workflow",
      name: "task-files",
      version: "1.0.0",
      contents,
    })
  );
}

/** A located recipe pointing at the fixture directory. */
function located(overrides: Partial<LockedRecipeLocation> = {}): LockedRecipeLocation {
  return {
    key: "workflow/task-files",
    repo: "fixtures",
    namespace: "workflow",
    name: "task-files",
    version: "1.0.0",
    hash: `sha256-${"a".repeat(64)}`,
    kind: "subscribes",
    requestedBy: ["project"],
    dir: recipeDir,
    linked: false,
    present: true,
    ...overrides,
  };
}

beforeEach(() => {
  tmp = makeTmpDir("sous-recipe-targets-");
  sousDir = path.join(tmp.path, "project", ".sous");
  recipeDir = path.join(tmp.path, "store", "fixtures", "workflow", "task-files", "1.0.0");
  fs.mkdirSync(sousDir, { recursive: true });
});

afterEach(() => {
  tmp.cleanup();
});

describe("projectRootFor()", () => {
  /**
   * projectRootFor should return the parent of the `.sous/` directory, which is
   * what the one defaulted destination is built from.
   *
   * projectRootFor("/a/project/.sous"); // -> "/a/project"
   */
  it("should return the parent of the .sous directory", () => {
    expect(projectRootFor("/a/project/.sous")).toBe("/a/project");
  });
});

describe("destinationsFor()", () => {
  /**
   * destinationsFor should default skills to the project's `.claude/skills`
   * directory, because that is where every agent looks for them.
   *
   * destinationsFor("skills", { sousDir, settings });
   * // -> ["<project>/.claude/skills"]
   */
  it("should default skills to the project's .claude/skills directory", () => {
    expect(destinationsFor("skills", { sousDir, settings: makeSettings() })).toEqual([
      path.join(path.dirname(sousDir), ".claude", "skills"),
    ]);
  });

  /**
   * destinationsFor should return nothing for a kind the project has not
   * configured, since sous cannot guess where a project wants its memories or
   * its prompts.
   *
   * destinationsFor("memories", { sousDir, settings }); // -> []
   */
  it("should return nothing for an unconfigured kind", () => {
    expect(destinationsFor("memories", { sousDir, settings: makeSettings() })).toEqual([]);
  });

  /**
   * destinationsFor should substitute `${var}` in every configured destination
   * and normalize the result, so a destination written against the project's own
   * variables lands where it reads.
   *
   * destinationsFor("skills", { settings: { recipeOutputs: { skills: ["${root}/x"] } } });
   * // -> ["/a/project/x"]
   */
  it("should substitute variables in configured destinations", () => {
    const settings = makeSettings({
      recipeOutputs: { skills: ["${root}/.claude/skills", "${root}/.codex/skills"] },
    });

    expect(
      destinationsFor("skills", { sousDir, settings, scope: { root: "/a/project" } })
    ).toEqual(["/a/project/.claude/skills", "/a/project/.codex/skills"]);
  });
});

describe("buildRecipeTargets()", () => {
  /**
   * buildRecipeTargets should produce one compile target per matched file, with
   * the static part of the include pattern as the base the output tree mirrors,
   * so a recipe's `skills/greeting/SKILL.md` becomes `<dest>/greeting/SKILL.md`.
   *
   * buildRecipeTargets({ sousDir, settings, locked });
   * // -> one target per file, writing into <project>/.claude/skills
   */
  it("should produce one target per contributed file", () => {
    writeManifest([{ kind: "skills", include: ["skills/**/*.md"] }]);
    write(path.join(recipeDir, "skills", "greeting", "SKILL.md"), "# hello");

    const result = buildRecipeTargets({
      sousDir,
      settings: makeSettings(),
      locked: [located()],
    });

    expect(result.targets).toHaveLength(1);
    expect(result.targets[0]!.rootInputPath).toBe(
      path.join(recipeDir, "skills", "greeting", "SKILL.md")
    );
    expect(result.targets[0]!.globBase).toBe(path.join(recipeDir, "skills"));
    expect(result.targets[0]!.outputs[0]!.destinationDir).toBe(
      path.join(path.dirname(sousDir), ".claude", "skills")
    );
    expect(result.warnings).toEqual([]);
  });

  /**
   * buildRecipeTargets should honour a content group's exclude patterns, so a
   * recipe can publish a directory without publishing everything in it.
   *
   * // include skills/**\/*.md, exclude skills/private/**
   * buildRecipeTargets(...).targets; // -> only the file outside skills/private
   */
  it("should honour exclude patterns", () => {
    writeManifest([
      { kind: "skills", include: ["skills/**/*.md"], exclude: ["skills/private/**"] },
    ]);
    write(path.join(recipeDir, "skills", "greeting", "SKILL.md"), "# hello");
    write(path.join(recipeDir, "skills", "private", "SKILL.md"), "# secret");

    const result = buildRecipeTargets({
      sousDir,
      settings: makeSettings(),
      locked: [located()],
    });

    expect(result.targets.map((target) => target.rootInputPath)).toEqual([
      path.join(recipeDir, "skills", "greeting", "SKILL.md"),
    ]);
  });

  /**
   * buildRecipeTargets should contribute nothing for a recipe held only as a
   * build dependency: it is fetched, pinned and addressable from the recipe that
   * declared it, and its files never enter the project's output.
   *
   * buildRecipeTargets({ locked: [{ kind: "depends", ... }] }).targets; // -> []
   */
  it("should contribute nothing for a build dependency", () => {
    writeManifest([{ kind: "skills", include: ["skills/**/*.md"] }]);
    write(path.join(recipeDir, "skills", "greeting", "SKILL.md"), "# hello");

    const result = buildRecipeTargets({
      sousDir,
      settings: makeSettings(),
      locked: [located({ kind: "depends" })],
    });

    expect(result.targets).toEqual([]);
  });

  /**
   * buildRecipeTargets should skip a content kind the project has configured no
   * destination for, and say so once, naming the config key and showing the
   * shape of an entry.
   *
   * buildRecipeTargets(...).warnings;
   * // -> ["Some subscribed recipes contribute memories files, ... 'recipeOutputs' ..."]
   */
  it("should warn once about a kind with nowhere to go", () => {
    writeManifest([
      { kind: "skills", include: ["skills/**/*.md"] },
      { kind: "memories", include: ["memories/**/*.md"] },
    ]);
    write(path.join(recipeDir, "skills", "greeting", "SKILL.md"), "# hello");
    write(path.join(recipeDir, "memories", "notes.md"), "# notes");

    const result = buildRecipeTargets({
      sousDir,
      settings: makeSettings(),
      locked: [located()],
    });

    expect(result.targets).toHaveLength(1);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("memories");
    expect(result.warnings[0]).toContain("recipeOutputs");
  });

  /**
   * buildRecipeTargets should report a linked recipe's directory as something a
   * watch must follow, because a link exists precisely so those files can be
   * edited while a watch is running.
   *
   * buildRecipeTargets({ locked: [{ linked: true, ... }] }).watchDirs;
   * // -> [the checkout's recipe directory]
   */
  it("should report a linked recipe's directory for watching", () => {
    writeManifest([{ kind: "skills", include: ["skills/**/*.md"] }]);
    write(path.join(recipeDir, "skills", "greeting", "SKILL.md"), "# hello");

    const result = buildRecipeTargets({
      sousDir,
      settings: makeSettings(),
      locked: [located({ linked: true })],
    });

    expect(result.watchDirs).toEqual([recipeDir]);
  });

  /**
   * buildRecipeTargets should return an empty result for a project that locks
   * nothing, so a project using no repositories pays nothing for this.
   *
   * buildRecipeTargets({ sousDir, settings, locked: [] });
   * // -> { targets: [], destinations: [], watchDirs: [], warnings: [] }
   */
  it("should return an empty result when nothing is locked", () => {
    expect(
      buildRecipeTargets({ sousDir, settings: makeSettings(), locked: [] })
    ).toEqual({ targets: [], destinations: [], watchDirs: [], warnings: [] });
  });
});
