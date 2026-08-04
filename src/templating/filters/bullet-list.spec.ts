import { Liquid } from "liquidjs";
import { describe, it, expect, beforeEach } from "vitest";
import { registerBulletListFilter } from "./bullet-list.js";

describe("registerBulletListFilter()", () => {
  let engine: Liquid;

  beforeEach(() => {
    engine = new Liquid();
    registerBulletListFilter(engine);
  });

  /**
   * An array of strings should be rendered as a markdown bullet list where
   * each item is prefixed with "- " and items are joined with newlines.
   *
   * engine.parseAndRenderSync('{{ items | bulletList }}', { items: ["a", "b", "c"] });
   * // -> "- a\n- b\n- c"
   */
  it("should render an array of strings as a bullet list", () => {
    const result = engine.parseAndRenderSync("{{ items | bulletList }}", {
      items: ["a", "b", "c"],
    });
    expect(result).toBe("- a\n- b\n- c");
  });

  /**
   * An array of numbers should be stringified and each item prefixed with "- ".
   *
   * engine.parseAndRenderSync('{{ items | bulletList }}', { items: [1, 2, 3] });
   * // -> "- 1\n- 2\n- 3"
   */
  it("should render an array of numbers as a bullet list", () => {
    const result = engine.parseAndRenderSync("{{ items | bulletList }}", {
      items: [1, 2, 3],
    });
    expect(result).toBe("- 1\n- 2\n- 3");
  });

  /**
   * An empty array should produce an empty string with no bullet characters.
   *
   * engine.parseAndRenderSync('{{ items | bulletList }}', { items: [] });
   * // -> ""
   */
  it("should return an empty string for an empty array", () => {
    const result = engine.parseAndRenderSync("{{ items | bulletList }}", {
      items: [],
    });
    expect(result).toBe("");
  });

  /**
   * A non-array value (such as a plain string) should be returned as-is via
   * String(), without adding bullet prefixes.
   *
   * engine.parseAndRenderSync('{{ value | bulletList }}', { value: "hello" });
   * // -> "hello"
   */
  it("should return a non-array value as-is via String()", () => {
    const result = engine.parseAndRenderSync("{{ value | bulletList }}", {
      value: "hello",
    });
    expect(result).toBe("hello");
  });
});
