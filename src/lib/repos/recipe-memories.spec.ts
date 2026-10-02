import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTmpDir, type TmpDir } from "../../test/utils/tmp.js";
import type { LockedRecipeLocation } from "./locked-recipes.js";
import { dependencyOrder, listMemories } from "./recipe-memories.js";

let tmp: TmpDir;

/** Writes a file, creating its parent directories. */
function write(rel: string, contents: string): void {
  const abs = path.join(tmp.path, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, contents, "utf8");
}

/**
 * Creates a recipe directory with a manifest and the given memory files, and
 * returns its located form.
 */
function recipe(
  key: string,
  options: {
    kind?: "subscribes" | "depends";
    requestedBy?: string[];
    files?: string[];
    include?: string[];
  } = {}
): LockedRecipeLocation {
  const [namespace, name] = key.split("/") as [string, string];
  const dir = path.join(tmp.path, "store", namespace, name);
  write(
    `store/${key}/sous.recipe.json`,
    JSON.stringify({
      formatVersion: 1,
      namespace,
      name,
      version: "1.0.0",
      contents: [{ kind: "memories", include: options.include ?? ["memories/*.md"] }],
    })
  );
  for (const file of options.files ?? ["memories/m.md"]) write(`store/${key}/${file}`, key);
  return {
    key,
    repo: "fixtures",
    namespace,
    name,
    version: "1.0.0",
    hash: `sha256-${"a".repeat(64)}`,
    kind: options.kind ?? "subscribes",
    requestedBy: options.requestedBy ?? ["project"],
    dir,
    linked: false,
    present: true,
  };
}

beforeEach(() => {
  tmp = makeTmpDir("sous-memories-");
});

afterEach(() => {
  tmp.cleanup();
});

describe("dependencyOrder()", () => {
  /**
   * A recipe comes after every recipe it depends on, whatever the keys say;
   * unrelated recipes go by key.
   *
   * zeta is held by alpha (alpha depends on zeta): zeta, alpha, then beta
   */
  it("should put a recipe after the recipes it depends on and break ties by key", () => {
    const alpha = recipe("a/alpha");
    const beta = recipe("b/beta");
    const zeta = recipe("z/zeta", { requestedBy: ["a/alpha"] });
    expect(dependencyOrder([alpha, beta, zeta])).toEqual(["b/beta", "z/zeta", "a/alpha"]);
  });
});

describe("listMemories()", () => {
  /**
   * Each memory is listed at namespace/recipe/path, the path being relative to
   * the static base of the include pattern, in bytewise order within a recipe.
   *
   * include "memories/**\/*.md" with memories/b.md and memories/sub/a.md
   * // -> "c/one/b.md", "c/one/sub/a.md"
   */
  it("should list virtual paths relative to the include pattern's base", () => {
    const one = recipe("c/one", {
      files: ["memories/sub/a.md", "memories/b.md", "other/x.md"],
      include: ["memories/**/*.md"],
    });
    const listed = listMemories({ sousDir: tmp.path, locked: [one] });
    expect(listed.map((entry) => entry.path)).toEqual(["c/one/b.md", "c/one/sub/a.md"]);
    expect(listed[0]?.file).toBe(path.join(one.dir, "memories", "b.md"));
    expect(listed[0]?.relative).toBe("memories/b.md");
  });

  /**
   * A recipe held only through depends is a library and lists nothing.
   *
   * kind "depends" -> []
   */
  it("should list nothing for a recipe held only through depends", () => {
    const library = recipe("c/lib", { kind: "depends", requestedBy: ["c/one"] });
    expect(listMemories({ sousDir: tmp.path, locked: [library] })).toEqual([]);
  });

  /**
   * Recipes are in dependency order.
   *
   * a/app depends on z/base -> z/base's memory first
   */
  it("should list a dependency's memories before its dependent's", () => {
    const app = recipe("a/app");
    const base = recipe("z/base", { requestedBy: ["a/app"] });
    const listed = listMemories({ sousDir: tmp.path, locked: [app, base] });
    expect(listed.map((entry) => entry.recipe)).toEqual(["z/base", "a/app"]);
  });

  /**
   * `first` moves matching recipes to the front, keeping the same relative
   * order among them and among the rest.
   *
   * first ["z/*"] with a/one, b/two, z/last -> z/last, a/one, b/two
   */
  it("should move recipes matching first to the front", () => {
    const locked = [recipe("a/one"), recipe("b/two"), recipe("z/last")];
    const listed = listMemories({ sousDir: tmp.path, locked, first: ["z/*"] });
    expect(listed.map((entry) => entry.recipe)).toEqual(["z/last", "a/one", "b/two"]);
  });

  /**
   * `exclude` drops matching recipes, including by a /regular expression/.
   *
   * exclude ["a/*", "/^b\//"] with a/one, b/two, z/last -> z/last
   */
  it("should drop recipes matching exclude", () => {
    const locked = [recipe("a/one"), recipe("b/two"), recipe("z/last")];
    const listed = listMemories({ sousDir: tmp.path, locked, exclude: ["a/*", "/^b\\//"] });
    expect(listed.map((entry) => entry.recipe)).toEqual(["z/last"]);
  });

  /**
   * A project that pins nothing has an empty list.
   *
   * listMemories({ locked: [] }) // -> []
   */
  it("should list nothing when no recipe is pinned", () => {
    expect(listMemories({ sousDir: tmp.path, locked: [] })).toEqual([]);
  });
});
