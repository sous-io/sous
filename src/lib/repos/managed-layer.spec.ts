/**
 * Unit tests for the machine-written `conf.d/` layers. These use real temporary
 * directories, since the point of the module is what ends up on disk.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import {
  MANAGED_LAYER_COMMENT,
  REPOS_LAYER_FILENAME,
  managedLayerHeader,
  readManagedLayer,
  removeManagedLayer,
  updateManagedLayer,
  writeManagedLayer,
} from "./managed-layer.js";
import { makeTmpDir, type TmpDir } from "../../test/utils/tmp.js";

describe("the managed config layers", () => {
  let tmp: TmpDir;
  let sousDir: string;

  beforeEach(() => {
    tmp = makeTmpDir("sous-managed-layer-");
    sousDir = path.join(tmp.path, ".sous");
    fs.mkdirSync(sousDir, { recursive: true });
  });

  afterEach(() => {
    tmp.cleanup();
  });

  /** The layer's text as it sits on disk. */
  function layerText(fileName = REPOS_LAYER_FILENAME): string {
    return fs.readFileSync(path.join(sousDir, "conf.d", fileName), "utf8");
  }

  /** Writes a layer file directly, bypassing the writers under test. */
  function seed(fileName: string, text: string): string {
    const confDir = path.join(sousDir, "conf.d");
    fs.mkdirSync(confDir, { recursive: true });
    const full = path.join(confDir, fileName);
    fs.writeFileSync(full, text, "utf8");
    return full;
  }

  /**
   * readManagedLayer should treat a layer that has never been written as empty,
   * because a project with no repositories has no such file.
   *
   * readManagedLayer(sousDir, "500-repos.jsonc") // -> {}
   */
  it("should return an empty object when the layer does not exist", () => {
    expect(readManagedLayer(sousDir, REPOS_LAYER_FILENAME)).toEqual({});
  });

  /**
   * The managed layers are `.jsonc`, so the policy can be stated in a real
   * comment at the top of the file rather than in a `$comment` property.
   */
  it("should name the layers .jsonc", () => {
    expect(REPOS_LAYER_FILENAME.endsWith(".jsonc")).toBe(true);
    expect(managedLayerHeader(REPOS_LAYER_FILENAME)).toContain("// This file is managed by sous");
    expect(MANAGED_LAYER_COMMENT).toContain("you may edit them");
  });

  /**
   * writeManagedLayer should create `conf.d/`, open the file with its header
   * comment, and sort the keys.
   */
  it("should create conf.d, write the header comment and sort the keys", () => {
    const written = writeManagedLayer(sousDir, REPOS_LAYER_FILENAME, {
      repos: { "team-recipes": { url: "https://github.com/team/recipes" } },
    });

    expect(written).toBe(path.join(sousDir, "conf.d", REPOS_LAYER_FILENAME));
    const text = fs.readFileSync(written, "utf8");
    expect(text.startsWith("// This file is managed by sous")).toBe(true);
    expect(text).toContain("'sous repo add'");
    expect(text.endsWith("\n")).toBe(true);
    expect(parseJsonc(text)).toEqual({
      repos: { "team-recipes": { url: "https://github.com/team/recipes" } },
    });
    expect(text).not.toContain("$comment");
  });

  /**
   * updateManagedLayer creates a layer that does not exist yet, header comment
   * and all, and writes the entry the caller asked for.
   *
   * updateManagedLayer(sousDir, "500-repos.jsonc", [{ path: ["repos", "a"], value: {} }]);
   */
  it("should create a new layer with its header and the requested entry", () => {
    const written = updateManagedLayer(sousDir, REPOS_LAYER_FILENAME, [
      { path: ["repos", "team-recipes"], value: { url: "https://github.com/team/recipes" } },
    ]);

    expect(written).toBe(path.join(sousDir, "conf.d", REPOS_LAYER_FILENAME));
    const text = fs.readFileSync(written, "utf8");
    expect(text.startsWith("// This file is managed by sous")).toBe(true);
    expect(readManagedLayer(sousDir, REPOS_LAYER_FILENAME)).toEqual({
      repos: { "team-recipes": { url: "https://github.com/team/recipes" } },
    });
  });

  /**
   * An edit rewrites only the bytes of the entry it changes, so a comment
   * somebody wrote beside another entry, and the order they put the keys in,
   * both survive.
   */
  it("should keep a user's comment and key order across an edit", () => {
    seed(
      REPOS_LAYER_FILENAME,
      [
        "// managed by sous",
        "{",
        '  "repos": {',
        "    // ours, do not remove",
        '    "zebra": { "url": "https://github.com/team/zebra" },',
        '    "alpha": { "url": "https://github.com/team/alpha" }',
        "  }",
        "}",
        "",
      ].join("\n")
    );

    updateManagedLayer(sousDir, REPOS_LAYER_FILENAME, [
      { path: ["repos", "zebra", "alwaysPull"], value: true },
    ]);

    const text = layerText();
    expect(text).toContain("// managed by sous");
    expect(text).toContain("// ours, do not remove");
    expect(text.indexOf('"zebra"')).toBeLessThan(text.indexOf('"alpha"'));
    expect(readManagedLayer(sousDir, REPOS_LAYER_FILENAME)).toEqual({
      repos: {
        zebra: { url: "https://github.com/team/zebra", alwaysPull: true },
        alpha: { url: "https://github.com/team/alpha" },
      },
    });
  });

  /**
   * An edit with an undefined value removes the key, and leaves everything
   * around it alone.
   */
  it("should remove a key when the edit's value is undefined", () => {
    updateManagedLayer(sousDir, REPOS_LAYER_FILENAME, [
      { path: ["repos", "one"], value: { url: "https://github.com/a/one" } },
      { path: ["repos", "two"], value: { url: "https://github.com/a/two" } },
    ]);
    updateManagedLayer(sousDir, REPOS_LAYER_FILENAME, [
      { path: ["repos", "one"], value: undefined },
    ]);

    const read = readManagedLayer(sousDir, REPOS_LAYER_FILENAME) as {
      repos: Record<string, unknown>;
    };
    expect(Object.keys(read.repos)).toEqual(["two"]);
  });

  /**
   * Removing a key from a layer that has never been written is already done,
   * and has to stay quiet: a removal is how a command reverses itself, and the
   * layer is absent whenever nothing has been added to it yet.
   */
  it("should treat removing a key from a layer that does not exist as done", () => {
    expect(() =>
      updateManagedLayer(sousDir, REPOS_LAYER_FILENAME, [
        { path: ["repos", "one"], value: undefined },
      ])
    ).not.toThrow();

    expect(readManagedLayer(sousDir, REPOS_LAYER_FILENAME)).toEqual({});
  });

  /**
   * The same when the layer is there but the block the key lives in is not,
   * which is the state a hand-edited layer is left in.
   */
  it("should treat removing a key with no containing block as done", () => {
    seed(REPOS_LAYER_FILENAME, `${managedLayerHeader(REPOS_LAYER_FILENAME)}{}\n`);

    expect(() =>
      updateManagedLayer(sousDir, REPOS_LAYER_FILENAME, [
        { path: ["repos", "one"], value: undefined },
      ])
    ).not.toThrow();

    expect(readManagedLayer(sousDir, REPOS_LAYER_FILENAME)).toEqual({});
  });

  /**
   * New keys go in sorted, so a layer only sous has ever written stays in a
   * stable order and its diffs stay small.
   */
  it("should insert new keys in sorted position", () => {
    updateManagedLayer(sousDir, REPOS_LAYER_FILENAME, [
      { path: ["repos", "zebra"], value: { url: "https://github.com/a/zebra" } },
    ]);
    updateManagedLayer(sousDir, REPOS_LAYER_FILENAME, [
      { path: ["repos", "alpha"], value: { url: "https://github.com/a/alpha" } },
    ]);

    const text = layerText();
    expect(text.indexOf('"alpha"')).toBeLessThan(text.indexOf('"zebra"'));
  });

  /**
   * A layer still under its old `.json` name is read as a fallback, and the
   * first write migrates it: the `.jsonc` file holds the result and the `.json`
   * one is gone, so the duplicate-baseName rule never trips.
   */
  it("should migrate a .json layer to .jsonc on the next write", () => {
    const legacy = seed(
      "500-repos.json",
      JSON.stringify({ repos: { one: { url: "https://github.com/a/one" } } }, null, 2)
    );

    expect(readManagedLayer(sousDir, REPOS_LAYER_FILENAME)).toEqual({
      repos: { one: { url: "https://github.com/a/one" } },
    });

    updateManagedLayer(sousDir, REPOS_LAYER_FILENAME, [
      { path: ["repos", "two"], value: { url: "https://github.com/a/two" } },
    ]);

    expect(fs.existsSync(legacy)).toBe(false);
    expect(fs.readdirSync(path.join(sousDir, "conf.d"))).toEqual([REPOS_LAYER_FILENAME]);
    expect(readManagedLayer(sousDir, REPOS_LAYER_FILENAME)).toEqual({
      repos: {
        one: { url: "https://github.com/a/one" },
        two: { url: "https://github.com/a/two" },
      },
    });
  });

  /**
   * A rewrite replaces the file wholesale: an entry that is gone from the new
   * content is gone from the file, which is what makes a removal a removal.
   */
  it("should replace the layer in full rather than merging into it", () => {
    writeManagedLayer(sousDir, REPOS_LAYER_FILENAME, {
      repos: { one: { url: "https://github.com/a/one" }, two: { url: "https://github.com/a/two" } },
    });
    writeManagedLayer(sousDir, REPOS_LAYER_FILENAME, {
      repos: { two: { url: "https://github.com/a/two" } },
    });

    const read = readManagedLayer(sousDir, REPOS_LAYER_FILENAME) as {
      repos: Record<string, unknown>;
    };
    expect(Object.keys(read.repos)).toEqual(["two"]);
  });

  /**
   * The write leaves no temporary file behind, since it renames one into place.
   */
  it("should leave no temporary file behind", () => {
    writeManagedLayer(sousDir, REPOS_LAYER_FILENAME, { repos: {} });
    expect(fs.readdirSync(path.join(sousDir, "conf.d"))).toEqual([REPOS_LAYER_FILENAME]);
  });

  /**
   * Comments and trailing commas are part of the format, so a layer somebody
   * has annotated reads back as the object it describes.
   */
  it("should read a layer with comments and trailing commas", () => {
    seed(
      REPOS_LAYER_FILENAME,
      [
        "// a note",
        "{",
        '  "repos": {',
        '    "one": { "url": "https://github.com/a/one" },',
        "  },",
        "}",
        "",
      ].join("\n")
    );

    expect(readManagedLayer(sousDir, REPOS_LAYER_FILENAME)).toEqual({
      repos: { one: { url: "https://github.com/a/one" } },
    });
  });

  /**
   * A managed layer that has been damaged is an error naming the file, rather
   * than a silent overwrite of whatever was in it.
   */
  it("should raise a ConfigError when the layer does not parse", () => {
    seed(REPOS_LAYER_FILENAME, "{ not json");

    expect(() => readManagedLayer(sousDir, REPOS_LAYER_FILENAME)).toThrow(
      /could not read its own config layer/
    );
    expect(() =>
      updateManagedLayer(sousDir, REPOS_LAYER_FILENAME, [{ path: ["repos", "a"], value: {} }])
    ).toThrow(/could not read its own config layer/);
  });

  /**
   * An explicit conf.d directory wins, so `--sous-confd` and SOUS_CONFD are
   * respected.
   */
  it("should honor an explicit conf.d directory", () => {
    const confDir = path.join(tmp.path, "elsewhere");
    const written = writeManagedLayer(sousDir, REPOS_LAYER_FILENAME, { repos: {} }, { confDir });

    expect(written).toBe(path.join(confDir, REPOS_LAYER_FILENAME));
    expect(readManagedLayer(sousDir, REPOS_LAYER_FILENAME, { confDir })).toMatchObject({
      repos: {},
    });
  });

  /**
   * removeManagedLayer should delete the file, the old `.json` name included,
   * and be happy when it is already gone.
   */
  it("should remove the layer, and not mind when it is already gone", () => {
    writeManagedLayer(sousDir, REPOS_LAYER_FILENAME, { repos: {} });
    seed("500-repos.json", "{}");
    removeManagedLayer(sousDir, REPOS_LAYER_FILENAME);
    removeManagedLayer(sousDir, REPOS_LAYER_FILENAME);

    expect(fs.readdirSync(path.join(sousDir, "conf.d"))).toEqual([]);
    expect(readManagedLayer(sousDir, REPOS_LAYER_FILENAME)).toEqual({});
  });
});
