import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTmpDir, type TmpDir } from "../../test/utils/tmp.js";
import type { DefinedVariable } from "./definition-source.js";
import {
  formatMappingTarget,
  mappedNamesFor,
  mappingMatches,
  mappingTargetFor,
  parseMappingTarget,
  readMappingRecords,
  VAR_MAPPINGS_LAYER_FILENAME,
  writeMappingRecord,
} from "./mappings.js";

let tmp: TmpDir;

beforeEach(() => {
  tmp = makeTmpDir("sous-mappings-");
});

afterEach(() => {
  tmp.cleanup();
});

/** Builds a defined variable for match tests. */
function defined(overrides: Partial<DefinedVariable["recipe"]> = {}): DefinedVariable {
  return {
    definition: {
      name: "apiUrl",
      type: "string",
      prompt: "Which API?",
      required: true,
      secret: false,
      scope: "shared",
    },
    recipe: { repo: "sous-recipes", namespace: "misc", name: "stuff", version: "1.0.0", ...overrides },
  } as DefinedVariable;
}

describe("parseMappingTarget()", () => {
  /**
   * parseMappingTarget should accept a fully qualified target and return its
   * parts.
   *
   * parseMappingTarget("sous-recipes:misc/stuff/apiUrl");
   * // -> { repo: "sous-recipes", namespace: "misc", recipe: "stuff", variable: "apiUrl" }
   */
  it("should parse a repository-qualified target", () => {
    expect(parseMappingTarget("sous-recipes:misc/stuff/apiUrl")).toEqual({
      repo: "sous-recipes",
      namespace: "misc",
      recipe: "stuff",
      variable: "apiUrl",
    });
  });

  /**
   * parseMappingTarget should accept a target without a repository qualifier,
   * which matches the variable in any added repository.
   */
  it("should parse a target with no repository qualifier", () => {
    expect(parseMappingTarget("misc/stuff/apiUrl")).toEqual({
      namespace: "misc",
      recipe: "stuff",
      variable: "apiUrl",
    });
  });

  /**
   * parseMappingTarget should refuse a target that does not name all three
   * parts, quoting the input and showing the grammar.
   */
  it("should refuse a target that is missing a segment", () => {
    expect(() => parseMappingTarget("misc/apiUrl")).toThrow(/namespace, a recipe and a variable/);
  });

  /**
   * formatMappingTarget should round-trip with parseMappingTarget.
   */
  it("should round-trip through formatMappingTarget", () => {
    const written = "sous-recipes:misc/stuff/apiUrl";
    expect(formatMappingTarget(parseMappingTarget(written))).toBe(written);
  });
});

describe("mappingMatches() and mappedNamesFor()", () => {
  /**
   * mappingMatches should accept a target and a defined variable and say
   * whether the target names that exact variable.
   */
  it("should match on namespace, recipe and variable", () => {
    expect(mappingMatches(parseMappingTarget("misc/stuff/apiUrl"), defined())).toBe(true);
    expect(mappingMatches(parseMappingTarget("misc/other/apiUrl"), defined())).toBe(false);
  });

  /**
   * mappingMatches should refuse a target whose repository qualifier names a
   * different repository, so two repositories publishing the same recipe key do
   * not share one record.
   */
  it("should respect the repository qualifier when there is one", () => {
    expect(mappingMatches(parseMappingTarget("elsewhere:misc/stuff/apiUrl"), defined())).toBe(false);
  });

  /**
   * mappedNamesFor should accept the merged varMappings block and return every
   * environment variable bound to one variable, sorted so config layer order
   * never changes the answer.
   *
   * mappedNamesFor({ ZED: "misc/stuff/apiUrl", ABLE: "misc/stuff/apiUrl" }, defined);
   * // -> ["ABLE", "ZED"]
   */
  it("should return every bound name in sorted order", () => {
    const names = mappedNamesFor(
      { ZED: "misc/stuff/apiUrl", ABLE: "misc/stuff/apiUrl", OTHER: "misc/stuff/other" },
      defined()
    );
    expect(names).toEqual(["ABLE", "ZED"]);
  });
});

describe("writeMappingRecord()", () => {
  /**
   * writeMappingRecord should write the machine-written layer file with a
   * plain-language `$comment` and the record under `varMappings`, creating the
   * conf.d directory when it does not exist yet.
   */
  it("should write a stable, commented layer file", () => {
    const confDir = path.join(tmp.path, "conf.d");
    const written = writeMappingRecord(confDir, "TEAM_API_URL", mappingTargetFor(defined()));

    expect(written).toBe(path.join(confDir, VAR_MAPPINGS_LAYER_FILENAME));
    const parsed = JSON.parse(fs.readFileSync(written, "utf8"));
    expect(parsed.$comment).toContain("Written by sous");
    expect(parsed.varMappings).toEqual({ TEAM_API_URL: "sous-recipes:misc/stuff/apiUrl" });
  });

  /**
   * writeMappingRecord should replace the file wholesale while keeping the
   * records already in it, because config layers concatenate arrays and merge
   * objects; appending would leave two entries for one name.
   */
  it("should keep existing records when adding another", () => {
    const confDir = path.join(tmp.path, "conf.d");
    writeMappingRecord(confDir, "FIRST_NAME", "misc/stuff/apiUrl");
    writeMappingRecord(confDir, "SECOND_NAME", "misc/other/apiUrl");

    expect(readMappingRecords(path.join(confDir, VAR_MAPPINGS_LAYER_FILENAME))).toEqual({
      FIRST_NAME: "misc/stuff/apiUrl",
      SECOND_NAME: "misc/other/apiUrl",
    });
  });

  /**
   * readMappingRecords should return an empty object for a file that is not
   * there, so a project with no records needs no special case.
   */
  it("should read a missing file as no records", () => {
    expect(readMappingRecords(path.join(tmp.path, "nothing.json"))).toEqual({});
  });
});
