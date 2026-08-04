import { Liquid } from "liquidjs";
import { describe, it, expect, beforeEach } from "vitest";
import { registerExportScalarVarsJsTag } from "./exportScalarVarsJs.js";

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
});
