import { Liquid } from "liquidjs";
import { describe, it, expect } from "vitest";
import { createLiquidEngine } from "./init-liquid-engine.js";

describe("createLiquidEngine()", () => {
  /**
   * createLiquidEngine() should return an instance of the LiquidJS Liquid class,
   * confirming the factory produces the right type.
   *
   * const engine = createLiquidEngine([]);
   * engine instanceof Liquid; // -> true
   */
  it("should return a Liquid instance", () => {
    const engine = createLiquidEngine([]);
    expect(engine).toBeInstanceOf(Liquid);
  });

  /**
   * createLiquidEngine() should pass the provided root paths through to the
   * engine options so that partial resolution uses the correct directories.
   *
   * const engine = createLiquidEngine(["/tmp/a", "/tmp/b"]);
   * engine.options.root; // -> ["/tmp/a", "/tmp/b"]
   */
  it("should set engine.options.root to the provided paths", () => {
    const roots = ["/tmp/a", "/tmp/b"];
    const engine = createLiquidEngine(roots);
    expect(engine.options.root).toEqual(roots);
  });

  /**
   * createLiquidEngine() should register the `bulletList` filter so that
   * rendering `{{ items | bulletList }}` with an array produces markdown
   * bullet lines.
   *
   * const engine = createLiquidEngine([]);
   * await engine.parseAndRender('{{ items | bulletList }}', { items: ["x", "y"] });
   * // -> "- x\n- y"
   */
  it("should register the bulletList filter that converts an array to bullet lines", async () => {
    const engine = createLiquidEngine([]);
    const result = await engine.parseAndRender("{{ items | bulletList }}", {
      items: ["x", "y"],
    });
    expect(result).toBe("- x\n- y");
  });

  /**
   * createLiquidEngine() should register the `showVars` tag so that rendering
   * `{% showVars %}` with variables in scope outputs a fenced ```json block
   * containing those variables serialised as JSON.
   *
   * const engine = createLiquidEngine([]);
   * await engine.parseAndRender('{% showVars %}', { name: "sous" });
   * // -> "```json\n{...}\n```"  (block contains "name": "sous")
   */
  it("should register the showVars tag that outputs a fenced json block of scope variables", async () => {
    const engine = createLiquidEngine([]);
    const result = await engine.parseAndRender("{% showVars %}", { name: "sous" });
    expect(result).toMatch(/^# Sous Debug: Variable Dump\n```json\n/);
    expect(result).toMatch(/\n```$/);
    expect(result).toContain('"name"');
    expect(result).toContain('"sous"');
  });

  /**
   * createLiquidEngine() should not throw when given an empty roots array,
   * confirming a valid engine is returned even with no search paths.
   *
   * const engine = createLiquidEngine([]);
   * await engine.parseAndRender('{{ val }}', { val: "ok" }); // -> "ok"
   */
  it("should not throw when roots is an empty array", async () => {
    const engine = createLiquidEngine([]);
    const result = await engine.parseAndRender("{{ val }}", { val: "ok" });
    expect(result).toBe("ok");
  });
});
