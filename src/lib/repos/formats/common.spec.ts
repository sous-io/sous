import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  absolutePathSchema,
  byteCountSchema,
  contentHashSchema,
  extensibleObject,
  formatIssuePath,
  formatVersionSchema,
  isoTimestampSchema,
  parseFormat,
  refKeySchema,
  relativePathSchema,
  semverRangeSchema,
  semverVersionSchema,
  stableJsonStringify,
  variableNameSchema,
} from "./common.js";
import { isConfigError } from "../../errors.js";

/**
 * Unit tests for the primitives every Repositories on-disk format is built
 * from. These run the schemas directly; the per-format specs then only have to
 * cover the shape each format composes.
 */

describe("formatVersionSchema", () => {
  /**
   * formatVersionSchema accepts only the literal 1, the single on-disk format
   * version this sous understands.
   *
   * formatVersionSchema.safeParse(1).success;  // -> true
   * formatVersionSchema.safeParse(2).success;  // -> false
   */
  it("should accept 1 and reject any other version", () => {
    expect(formatVersionSchema.safeParse(1).success).toBe(true);
    expect(formatVersionSchema.safeParse(2).success).toBe(false);
    expect(formatVersionSchema.safeParse("1").success).toBe(false);
  });
});

describe("semverVersionSchema", () => {
  /**
   * semverVersionSchema accepts an exact semantic version, including a
   * prerelease, and rejects a range or a partial version.
   *
   * semverVersionSchema.safeParse("1.4.0").success;   // -> true
   * semverVersionSchema.safeParse("^1.4.0").success;  // -> false
   */
  it("should accept exact versions and reject ranges", () => {
    for (const good of ["1.4.0", "0.0.1", "2.0.0-beta.1"]) {
      expect(semverVersionSchema.safeParse(good).success).toBe(true);
    }
    for (const bad of ["^1.4.0", "1.4", "not-a-version", ""]) {
      expect(semverVersionSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe("semverRangeSchema", () => {
  /**
   * semverRangeSchema accepts anything npm's semver package recognizes as a
   * range, including the wildcard, and rejects nonsense.
   *
   * semverRangeSchema.safeParse(">=1.0.0 <2.0.0").success;  // -> true
   */
  it("should accept npm-style ranges and reject nonsense", () => {
    for (const good of ["^1.2.0", "~2.1", ">=1.0.0 <2.0.0", "*", "1.x"]) {
      expect(semverRangeSchema.safeParse(good).success).toBe(true);
    }
    for (const bad of ["not a range", "^^1.0.0"]) {
      expect(semverRangeSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe("contentHashSchema", () => {
  /**
   * contentHashSchema requires the algorithm prefix plus 64 lowercase hex
   * characters, so a bare digest or an uppercase one is rejected.
   *
   * contentHashSchema.safeParse("sha256-" + "a".repeat(64)).success;  // -> true
   */
  it("should accept a prefixed lowercase sha256 digest only", () => {
    expect(contentHashSchema.safeParse(`sha256-${"a".repeat(64)}`).success).toBe(true);
    expect(contentHashSchema.safeParse("a".repeat(64)).success).toBe(false);
    expect(contentHashSchema.safeParse(`sha256-${"A".repeat(64)}`).success).toBe(false);
    expect(contentHashSchema.safeParse(`sha256-${"a".repeat(63)}`).success).toBe(false);
    expect(contentHashSchema.safeParse(`sha1-${"a".repeat(64)}`).success).toBe(false);
  });
});

describe("isoTimestampSchema", () => {
  /**
   * isoTimestampSchema accepts what `new Date().toISOString()` produces, plus
   * an explicit numeric offset, and rejects a date with no time or offset.
   *
   * isoTimestampSchema.safeParse("2026-09-09T14:03:11.482Z").success;  // -> true
   */
  it("should accept ISO 8601 timestamps carrying an offset", () => {
    expect(isoTimestampSchema.safeParse(new Date().toISOString()).success).toBe(true);
    expect(isoTimestampSchema.safeParse("2026-09-09T14:03:11+02:00").success).toBe(true);
    expect(isoTimestampSchema.safeParse("2026-09-09").success).toBe(false);
    expect(isoTimestampSchema.safeParse("2026-09-09T14:03:11").success).toBe(false);
  });
});

describe("byteCountSchema", () => {
  /**
   * byteCountSchema accepts whole, non-negative numbers only.
   *
   * byteCountSchema.safeParse(0).success;     // -> true
   * byteCountSchema.safeParse(-1).success;    // -> false
   */
  it("should accept whole non-negative numbers only", () => {
    expect(byteCountSchema.safeParse(0).success).toBe(true);
    expect(byteCountSchema.safeParse(4096).success).toBe(true);
    expect(byteCountSchema.safeParse(-1).success).toBe(false);
    expect(byteCountSchema.safeParse(1.5).success).toBe(false);
  });
});

describe("absolutePathSchema", () => {
  /**
   * absolutePathSchema accepts a POSIX or Windows absolute path and rejects a
   * relative one or an empty string.
   *
   * absolutePathSchema.safeParse("/home/me/repo").success;  // -> true
   */
  it("should accept absolute paths and reject relative ones", () => {
    expect(absolutePathSchema.safeParse("/home/me/repo").success).toBe(true);
    expect(absolutePathSchema.safeParse("C:\\repos\\sous").success).toBe(true);
    expect(absolutePathSchema.safeParse("repos/sous").success).toBe(false);
    expect(absolutePathSchema.safeParse("").success).toBe(false);
  });
});

describe("refKeySchema", () => {
  /**
   * refKeySchema accepts a bare namespace or `namespace/recipe`, and rejects a
   * repo qualifier, a version range or a third segment.
   *
   * refKeySchema.safeParse("workflow/task-files").success;  // -> true
   */
  it("should accept one or two kebab-case segments only", () => {
    expect(refKeySchema.safeParse("workflow").success).toBe(true);
    expect(refKeySchema.safeParse("workflow/task-files").success).toBe(true);
    expect(refKeySchema.safeParse("recipes:workflow").success).toBe(false);
    expect(refKeySchema.safeParse("workflow/task-files@^1.0.0").success).toBe(false);
    expect(refKeySchema.safeParse("a/b/c").success).toBe(false);
    expect(refKeySchema.safeParse("Workflow").success).toBe(false);
  });
});

describe("variableNameSchema", () => {
  /**
   * variableNameSchema accepts camelCase names only, matching the project's
   * existing `_vars` convention.
   *
   * variableNameSchema.safeParse("apiBaseUrl").success;  // -> true
   */
  it("should accept camelCase names and reject other casings", () => {
    expect(variableNameSchema.safeParse("apiBaseUrl").success).toBe(true);
    expect(variableNameSchema.safeParse("token2").success).toBe(true);
    expect(variableNameSchema.safeParse("api_base_url").success).toBe(false);
    expect(variableNameSchema.safeParse("ApiBaseUrl").success).toBe(false);
    expect(variableNameSchema.safeParse("api-base-url").success).toBe(false);
  });
});

describe("relativePathSchema()", () => {
  const plain = relativePathSchema("a recipe path");
  const globbed = relativePathSchema("an include pattern", true);

  /**
   * A plain relative path may contain nested segments but never an absolute
   * prefix, a backslash, a traversal segment or a glob character.
   *
   * plain.safeParse("recipes/workflow/task-files").success;  // -> true
   * plain.safeParse("../outside").success;                   // -> false
   */
  it("should accept a nested relative path and reject escapes", () => {
    expect(plain.safeParse("recipes/workflow/task-files").success).toBe(true);
    expect(plain.safeParse("task-files").success).toBe(true);
    for (const bad of [
      "",
      "/absolute/path",
      "C:\\repos\\sous",
      "recipes\\workflow",
      "recipes/",
      "../outside",
      "recipes/../../outside",
      "recipes/./here",
      "recipes//here",
      "recipes/*",
    ]) {
      expect(plain.safeParse(bad).success, `expected ${JSON.stringify(bad)} to fail`).toBe(
        false
      );
    }
  });

  /**
   * With globs allowed, wildcard characters and a `**` segment pass, while the
   * traversal and absolute-path rules still hold.
   *
   * globbed.safeParse("skills/**\/*.md").success;  // -> true
   */
  it("should accept glob patterns only when globs are allowed", () => {
    expect(globbed.safeParse("skills/**/*.md").success).toBe(true);
    expect(globbed.safeParse("skills/*.{md,txt}").success).toBe(true);
    expect(globbed.safeParse("../skills/**").success).toBe(false);
    expect(globbed.safeParse("/skills/**").success).toBe(false);
  });

  /**
   * The failure message names what the path was supposed to be, so a manifest
   * author sees "a recipe path must be relative", not a bare zod complaint.
   */
  it("should name the subject in its failure message", () => {
    const result = plain.safeParse("/absolute");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain("a recipe path must be relative");
    }
  });
});

describe("extensibleObject()", () => {
  const schema = extensibleObject({ name: z.string() });

  /**
   * An extensible object rejects an unknown key, so a typo in a hand-written
   * manifest surfaces immediately rather than being silently ignored.
   *
   * schema.safeParse({ name: "a", nmae: "b" }).success;  // -> false
   */
  it("should reject an unknown key", () => {
    expect(schema.safeParse({ name: "a", nmae: "b" }).success).toBe(false);
  });

  /**
   * Keys in the reserved `x-` extension namespace are accepted and dropped, so
   * a repo may carry its own metadata without sous claiming the name.
   *
   * schema.parse({ name: "a", "x-internal": 1 });  // -> { name: "a" }
   */
  it("should accept and drop keys in the x- extension namespace", () => {
    const result = schema.safeParse({ name: "a", "x-internal": { any: "thing" } });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual({ name: "a" });
  });

  /**
   * A non-object value still fails as a missing object rather than passing
   * through the extension-key preprocessing untouched.
   */
  it("should reject a value that is not an object", () => {
    expect(schema.safeParse("not an object").success).toBe(false);
    expect(schema.safeParse(["not", "an", "object"]).success).toBe(false);
  });
});

describe("formatIssuePath()", () => {
  /**
   * formatIssuePath renders a zod issue path as the dotted, bracketed form a
   * user would type.
   *
   * formatIssuePath(["variables", 0, "name"]);  // -> "variables[0].name"
   */
  it("should render a mixed key and index path", () => {
    expect(formatIssuePath(["variables", 0, "name"])).toBe("variables[0].name");
    expect(formatIssuePath([])).toBe("");
    expect(formatIssuePath([0])).toBe("[0]");
  });
});

describe("parseFormat()", () => {
  const schema = extensibleObject({ name: z.string() });

  /**
   * parseFormat returns the validated value when the input is good.
   *
   * parseFormat(schema, { name: "a" }, "/x.yaml", "test format");  // -> { name: "a" }
   */
  it("should return the validated value on success", () => {
    expect(parseFormat(schema, { name: "a" }, "/x.yaml", "test format")).toEqual({
      name: "a",
    });
  });

  /**
   * On failure it throws a ConfigError naming the format, the file, and the
   * path of each bad field. It never leaks a raw zod dump.
   */
  it("should throw a ConfigError naming the format, the file and the field", () => {
    let message = "";
    try {
      parseFormat(schema, { name: 7 }, "/repo/sous.repo.yaml", "repo manifest");
    } catch (error) {
      expect(isConfigError(error)).toBe(true);
      message = (error as Error).message;
    }
    expect(message).toContain("Invalid repo manifest at /repo/sous.repo.yaml:");
    expect(message).toContain("- name:");
  });

  /**
   * An unknown key is reported as a likely typo, and the message says that only
   * `x-` keys are ignored.
   */
  /**
   * zod reports a bad record KEY as a bare "Invalid key in record" and hides the
   * reason in a nested issue list. parseFormat surfaces the reason instead,
   * since that is the part telling the author how to fix the key.
   *
   * // -> "  - Bad Key: invalid key; a bin name must be lowercase letters"
   */
  it("should surface the real reason a record key was rejected", () => {
    const record = z.record(
      z.string().regex(/^[a-z]+$/, "a bin name must be lowercase letters"),
      z.string()
    );
    let message = "";
    try {
      parseFormat(record, { "Bad Key": "v" }, "/repo/sous.repo.yaml", "repo manifest");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("Bad Key: invalid key; a bin name must be lowercase letters");
    expect(message).not.toContain("Invalid key in record");
  });

  it("should report an unknown key as a likely typo", () => {
    let message = "";
    try {
      parseFormat(schema, { name: "a", nmae: "b" }, "/repo/sous.repo.yaml", "repo manifest");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("unknown key 'nmae' at the top level");
    expect(message).toContain("likely a typo");
  });
});

describe("stableJsonStringify()", () => {
  /**
   * stableJsonStringify sorts every object key at every depth and ends with a
   * newline, so a machine-written file diffs minimally between runs.
   *
   * stableJsonStringify({ b: 1, a: { d: 2, c: 3 } });
   * // -> '{\n  "a": {\n    "c": 3,\n    "d": 2\n  },\n  "b": 1\n}\n'
   */
  it("should sort keys at every depth and end with a newline", () => {
    const out = stableJsonStringify({ b: 1, a: { d: 2, c: 3 }, list: [{ z: 1, y: 2 }] });
    expect(out.endsWith("\n")).toBe(true);
    expect(JSON.parse(out)).toEqual({ a: { c: 3, d: 2 }, b: 1, list: [{ y: 2, z: 1 }] });
    expect(out.indexOf('"a"')).toBeLessThan(out.indexOf('"b"'));
    expect(out.indexOf('"c"')).toBeLessThan(out.indexOf('"d"'));
    expect(out.indexOf('"y"')).toBeLessThan(out.indexOf('"z"'));
  });

  /**
   * Array order is content, not formatting, so it is preserved exactly.
   */
  it("should preserve array order", () => {
    expect(JSON.parse(stableJsonStringify(["c", "a", "b"]))).toEqual(["c", "a", "b"]);
  });
});
