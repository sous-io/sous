import { Liquid } from "liquidjs";
import { describe, it, expect, beforeEach } from "vitest";
import { registerShowVarsTag } from "./showVars.js";
import { setSecretNames } from "../lib/secret-scope.js";

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

  /**
   * A variable a recipe declared secret prints as "(hidden)", so the dump
   * shows the variable exists without carrying its value.
   *
   * setSecretNames(engine, ["deployKey"]);
   * // { deployKey: "abc123" } -> "deployKey": "(hidden)"
   */
  it("should hide a variable a recipe declared secret", () => {
    setSecretNames(engine, ["deployKey"]);
    const result = engine.parseAndRenderSync("{% showVars %}", { deployKey: "abc123", owner: "luke" });
    expect(result).not.toContain("abc123");
    expect(result).toContain('"deployKey": "(hidden)"');
    expect(result).toContain('"owner": "luke"');
  });

  /**
   * A variable that very probably holds a secret is hidden with no
   * declaration, including one nested inside an object.
   *
   * // { OPENAI_API_KEY: "k", nested: { dbPassword: "p" } } -> both "(hidden)"
   */
  it("should hide a variable that very probably holds a secret, at any depth", () => {
    const result = engine.parseAndRenderSync("{% showVars %}", {
      OPENAI_API_KEY: "plain-looking-value",
      nested: { dbPassword: "hunter2" },
      note: "ghp_" + "a".repeat(36),
    });
    expect(result).not.toContain("plain-looking-value");
    expect(result).not.toContain("hunter2");
    expect(result).not.toContain("ghp_");
    expect(result.match(/\(hidden\)/g)).toHaveLength(3);
  });

  /**
   * Hiding is only for the dump: a template that names a secret explicitly
   * still renders it.
   *
   * setSecretNames(engine, ["deployKey"]);
   * engine.parseAndRenderSync("{{ deployKey }}", { deployKey: "abc123" });  // "abc123"
   */
  it("should leave an explicitly named secret alone", () => {
    setSecretNames(engine, ["deployKey"]);
    expect(engine.parseAndRenderSync("{{ deployKey }}", { deployKey: "abc123" })).toBe("abc123");
  });
});
