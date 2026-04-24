import { Liquid } from "liquidjs";
import { describe, it, expect, beforeEach } from "vitest";
import { registerShowVarsTag } from "./showVars.js";

describe("registerShowVarsTag()", () => {
  let engine: Liquid;

  beforeEach(() => {
    engine = new Liquid();
    registerShowVarsTag(engine);
  });

  /**
   * The {% showVars %} tag should render a heading followed by a fenced ```json
   * code block containing the serialised scope.
   *
   * engine.parseAndRenderSync('{% showVars %}', {});
   * // "# Sous Debug: Variable Dump\n```json\n{}\n```"
   */
  it("should render a heading and a fenced json code block", () => {
    const result = engine.parseAndRenderSync("{% showVars %}", {});
    expect(result).toMatch(/^# Sous Debug: Variable Dump\n```json\n/);
    expect(result).toMatch(/\n```$/);
  });

  /**
   * Variables that are in scope when {% showVars %} is rendered should appear in
   * the JSON output with keys sorted alphabetically.
   *
   * engine.parseAndRenderSync('{% showVars %}', { zebra: 1, apple: 2 });
   * // rendered JSON has "apple" before "zebra"
   */
  it("should include in-scope variables in the rendered JSON with keys sorted alphabetically", () => {
    const result = engine.parseAndRenderSync("{% showVars %}", {
      zebra: 1,
      apple: 2,
    });
    const jsonPart = result.replace(/^.*```json\n/s, "").replace(/\n```$/, "");
    const parsed = JSON.parse(jsonPart);
    expect(parsed).toMatchObject({ zebra: 1, apple: 2 });
    expect(Object.keys(parsed)).toEqual(["apple", "zebra"]);
  });

  /**
   * When a circular reference exists in the scope, the tag should replace it
   * with the string "[Circular]" instead of throwing a TypeError.
   *
   * const obj: Record<string, unknown> = {};
   * obj.self = obj;
   * engine.parseAndRenderSync('{% showVars %}', { obj });
   * // rendered JSON contains "[Circular]" for the self property
   */
  it("should replace circular references with \"[Circular]\" rather than throwing", () => {
    const obj: Record<string, unknown> = { label: "root" };
    obj["self"] = obj;

    let result: string;
    expect(() => {
      result = engine.parseAndRenderSync("{% showVars %}", { obj });
    }).not.toThrow();

    const jsonPart = result!.replace(/^```json\n/, "").replace(/\n```$/, "");
    expect(jsonPart).toContain('"[Circular]"');
  });
});
