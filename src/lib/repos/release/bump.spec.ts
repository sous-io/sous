import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTmpDir, type TmpDir } from "../../../test/utils/tmp.js";
import { bumpRecipeVersion, nextVersion, setRecipeVersion } from "./bump.js";

let tmp: TmpDir;

beforeEach(() => {
  tmp = makeTmpDir("sous-release-bump-");
});

afterEach(() => {
  tmp.cleanup();
});

/** Writes a file in the temp directory and returns its path. */
function write(name: string, contents: string): string {
  const target = path.join(tmp.path, name);
  fs.writeFileSync(target, contents, "utf8");
  return target;
}

describe("nextVersion()", () => {
  /**
   * Each level raises the version the way npm does, prereleases included.
   *
   * nextVersion("1.4.2", "minor");      // -> "1.5.0"
   * nextVersion("1.4.2", "prerelease"); // -> "1.4.3-0"
   */
  it("should raise a version by each supported level", () => {
    expect(nextVersion("1.4.2", "patch")).toBe("1.4.3");
    expect(nextVersion("1.4.2", "minor")).toBe("1.5.0");
    expect(nextVersion("1.4.2", "major")).toBe("2.0.0");
    expect(nextVersion("1.4.2", "prerelease")).toBe("1.4.3-0");
    expect(nextVersion("2.0.0-beta.1", "prerelease")).toBe("2.0.0-beta.2");
  });

  /**
   * A version that is not a semantic version cannot be raised, and the error
   * says what one looks like.
   */
  it("should throw a readable error for a version it cannot raise", () => {
    expect(() => nextVersion("not-a-version", "patch")).toThrow(
      /exact semantic version/
    );
  });
});

describe("bumpRecipeVersion()", () => {
  /**
   * A YAML manifest keeps its comments, its blank lines and its field order;
   * only the version's own value changes.
   *
   * bumpRecipeVersion("sous.recipe.yaml", "minor");
   * // -> { from: "0.1.0", to: "0.2.0" }, file otherwise unchanged
   */
  it("should raise the version in a YAML manifest and keep its comments", () => {
    const manifest = write(
      "sous.recipe.yaml",
      "# A recipe manifest: one publishable unit.\nformatVersion: 1\n\n" +
        "namespace: core\nname: example\n\n" +
        "# Recipe metadata is the source of truth for versions.\nversion: 0.1.0\n\n" +
        "description: >-\n  What this recipe gives a project.\n"
    );

    const result = bumpRecipeVersion(manifest, "minor");
    const after = fs.readFileSync(manifest, "utf8");

    expect(result).toEqual({ manifestPath: manifest, from: "0.1.0", to: "0.2.0" });
    expect(after).toContain("version: 0.2.0");
    expect(after).toContain("# A recipe manifest: one publishable unit.");
    expect(after).toContain("# Recipe metadata is the source of truth for versions.");
    expect(after).toContain("description: >-");
  });

  /**
   * A JSON manifest is edited at the version's own byte range, so its comments
   * and its formatting survive too.
   */
  it("should raise the version in a JSON manifest and keep its comments", () => {
    const manifest = write(
      "sous.recipe.json",
      '{\n  // one publishable unit\n  "formatVersion": 1,\n  "namespace": "core",\n' +
        '  "name": "example",\n  "version": "1.0.0"\n}\n'
    );

    const result = bumpRecipeVersion(manifest, "patch");
    const after = fs.readFileSync(manifest, "utf8");

    expect(result.to).toBe("1.0.1");
    expect(after).toContain('"version": "1.0.1"');
    expect(after).toContain("// one publishable unit");
  });

  /**
   * A manifest with nothing to raise is a readable error rather than a silently
   * added field.
   */
  it("should throw when the manifest declares no version", () => {
    const manifest = write("sous.recipe.yaml", "formatVersion: 1\nname: example\n");

    expect(() => bumpRecipeVersion(manifest, "patch")).toThrow(
      /has no 'version' field to write/
    );
  });
});

describe("setRecipeVersion()", () => {
  /**
   * The release pipeline dictates the core recipe's version rather than
   * stepping it, and the manifest still comes back looking hand-written.
   *
   * setRecipeVersion("sous.recipe.yaml", "2.3.4");
   * // -> { from: "0.1.0", to: "2.3.4" }, file otherwise unchanged
   */
  it("should write the exact version it is given and keep the comments", () => {
    const manifest = write(
      "sous.recipe.yaml",
      "# The packaged core recipe.\nformatVersion: 1\n\n" +
        "namespace: core\nname: sous-skills\nversion: 0.1.0\n"
    );

    const result = setRecipeVersion(manifest, "2.3.4");
    const after = fs.readFileSync(manifest, "utf8");

    expect(result).toEqual({ manifestPath: manifest, from: "0.1.0", to: "2.3.4" });
    expect(after).toContain("version: 2.3.4");
    expect(after).toContain("# The packaged core recipe.");
  });

  /**
   * Syncing a manifest that is already at the wanted version must not rewrite
   * it, because a YAML round trip can reflow a file nobody asked to change.
   */
  it("should leave a manifest that already declares that version untouched", () => {
    const before =
      "formatVersion: 1\nnamespace: core\nname: sous-skills\nversion: 1.2.3\n\n" +
      "description: >-\n  Written by hand,\n  across two lines.\n";
    const manifest = write("sous.recipe.yaml", before);

    const result = setRecipeVersion(manifest, "1.2.3");

    expect(result).toEqual({ manifestPath: manifest, from: "1.2.3", to: "1.2.3" });
    expect(fs.readFileSync(manifest, "utf8")).toBe(before);
  });

  /** A version that is not a semantic version is refused before anything is written. */
  it("should refuse a version that is not a semantic version", () => {
    const manifest = write("sous.recipe.yaml", "version: 1.0.0\n");

    expect(() => setRecipeVersion(manifest, "latest")).toThrow(
      /exact semantic version/
    );
    expect(fs.readFileSync(manifest, "utf8")).toBe("version: 1.0.0\n");
  });
});
