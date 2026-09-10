/**
 * Unit tests for the machine-written `conf.d/` layers. These use real temporary
 * directories, since the point of the module is what ends up on disk.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  MANAGED_LAYER_COMMENT,
  REPOS_LAYER_FILENAME,
  readManagedLayer,
  removeManagedLayer,
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

  /**
   * readManagedLayer should treat a layer that has never been written as empty,
   * because a project with no repositories has no such file.
   *
   * readManagedLayer(sousDir, "500-repos.json") // -> {}
   */
  it("should return an empty object when the layer does not exist", () => {
    expect(readManagedLayer(sousDir, REPOS_LAYER_FILENAME)).toEqual({});
  });

  /**
   * writeManagedLayer should create `conf.d/`, sort the keys, and add the
   * `$comment` note saying sous wrote the file.
   */
  it("should create conf.d, sort the keys and add the $comment note", () => {
    const written = writeManagedLayer(sousDir, REPOS_LAYER_FILENAME, {
      repos: { "team-recipes": { url: "https://github.com/team/recipes" } },
    });

    expect(written).toBe(path.join(sousDir, "conf.d", REPOS_LAYER_FILENAME));
    const text = fs.readFileSync(written, "utf8");
    expect(text.startsWith('{\n  "$comment":')).toBe(true);
    expect(text.endsWith("\n")).toBe(true);
    expect(JSON.parse(text)).toEqual({
      $comment: MANAGED_LAYER_COMMENT,
      repos: { "team-recipes": { url: "https://github.com/team/recipes" } },
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
   * A managed layer that has been damaged is an error naming the file, rather
   * than a silent overwrite of whatever was in it.
   */
  it("should raise a ConfigError when the layer is not readable JSON", () => {
    const confDir = path.join(sousDir, "conf.d");
    fs.mkdirSync(confDir, { recursive: true });
    fs.writeFileSync(path.join(confDir, REPOS_LAYER_FILENAME), "{ not json", "utf8");

    expect(() => readManagedLayer(sousDir, REPOS_LAYER_FILENAME)).toThrow(
      /could not read its own config layer/
    );
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
   * removeManagedLayer should delete the file and be happy when it is already
   * gone.
   */
  it("should remove the layer, and not mind when it is already gone", () => {
    writeManagedLayer(sousDir, REPOS_LAYER_FILENAME, { repos: {} });
    removeManagedLayer(sousDir, REPOS_LAYER_FILENAME);
    removeManagedLayer(sousDir, REPOS_LAYER_FILENAME);

    expect(readManagedLayer(sousDir, REPOS_LAYER_FILENAME)).toEqual({});
  });
});
