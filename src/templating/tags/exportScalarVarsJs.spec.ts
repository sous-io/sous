import { Liquid } from "liquidjs";
import { describe, it, expect, beforeEach } from "vitest";
import { registerExportScalarVarsJsTag } from "./exportScalarVarsJs.js";
import { setSecretNames } from "../lib/secret-scope.js";

describe("registerExportScalarVarsJsTag()", () => {
  let engine: Liquid;

  beforeEach(() => {
    engine = new Liquid();
    registerExportScalarVarsJsTag(engine);
  });

  /** Parse the `export default {...};` output back into an object for assertions. */
  function parseExport(output: string): Record<string, unknown> {
    const json = output
      .replace(/^export default /, "")
      .replace(/;\s*$/, "")
      .trim();
    return JSON.parse(json);
  }

  it("should emit a valid `export default { ... };` module", () => {
    const result = engine.parseAndRenderSync("{% exportScalarVarsJs %}", {
      chromeProfile: "Default",
    });
    expect(result).toMatch(/^export default \{/);
    expect(result.trimEnd()).toMatch(/\};$/);
    expect(parseExport(result)).toEqual({ chromeProfile: "Default" });
  });

  it("should include strings, finite numbers, and booleans", () => {
    const result = engine.parseAndRenderSync("{% exportScalarVarsJs %}", {
      name: "sous",
      count: 3,
      enabled: true,
      disabled: false,
    });
    expect(parseExport(result)).toEqual({
      name: "sous",
      count: 3,
      enabled: true,
      disabled: false,
    });
  });

  it("should exclude objects, arrays, null, and functions", () => {
    const result = engine.parseAndRenderSync("{% exportScalarVarsJs %}", {
      keep: "yes",
      obj: { a: 1 },
      arr: [1, 2, 3],
      nothing: null,
      undef: undefined,
    });
    expect(parseExport(result)).toEqual({ keep: "yes" });
  });

  it("should exclude non-finite numbers (NaN, Infinity)", () => {
    const result = engine.parseAndRenderSync("{% exportScalarVarsJs %}", {
      ok: 42,
      nan: NaN,
      inf: Infinity,
    });
    expect(parseExport(result)).toEqual({ ok: 42 });
  });

  it("should sort keys alphabetically", () => {
    const result = engine.parseAndRenderSync("{% exportScalarVarsJs %}", {
      zebra: 1,
      apple: 2,
      mango: 3,
    });
    expect(Object.keys(parseExport(result))).toEqual(["apple", "mango", "zebra"]);
  });

  it("should emit an empty object when no scalars are in scope", () => {
    const result = engine.parseAndRenderSync("{% exportScalarVarsJs %}", {
      obj: { a: 1 },
    });
    expect(parseExport(result)).toEqual({});
  });

  /**
   * A variable a recipe declared secret is left out of the export entirely,
   * whatever it is called, because runtime code would read a mask as a value.
   *
   * setSecretNames(engine, ["deployKey"]);
   * // { deployKey: "abc123", owner: "luke" } -> { owner: "luke" }
   */
  it("should leave out a variable a recipe declared secret", () => {
    setSecretNames(engine, ["deployKey"]);
    const result = engine.parseAndRenderSync("{% exportScalarVarsJs %}", {
      deployKey: "abc123",
      owner: "luke",
    });
    expect(parseExport(result)).toEqual({ owner: "luke" });
    expect(result).not.toContain("abc123");
  });

  /**
   * A variable that very probably holds a secret is left out with no
   * declaration: a secret-sounding name, or a value in a known token format.
   *
   * // { githubToken: "x1", someUrl: "https://u:p@db.example" } -> {}
   */
  it("should leave out a variable that very probably holds a secret", () => {
    const result = engine.parseAndRenderSync("{% exportScalarVarsJs %}", {
      githubToken: "x1",
      someUrl: "https://u:p@db.example",
      maxTokens: 4096,
    });
    expect(parseExport(result)).toEqual({ maxTokens: 4096 });
  });
});
