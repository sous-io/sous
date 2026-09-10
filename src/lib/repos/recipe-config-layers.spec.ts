import { describe, it, expect } from "vitest";
import {
  RECIPE_CONFIG_ALLOWED_KEYS,
  RECIPE_LAYER_EXTENSIONS,
  filterRecipeConfigLayer,
} from "./recipe-config-layers.js";

/**
 * The allowlist is the whole trust boundary for a recipe's config layer, so it
 * is tested on its own here; the end-to-end proof that a recipe cannot add a
 * repository lives in `src/test/integration/repositories.test.ts`.
 */
describe("filterRecipeConfigLayer()", () => {
  /**
   * filterRecipeConfigLayer() should pass through every key a recipe is allowed
   * to set, unchanged and with no warning.
   *
   * filterRecipeConfigLayer("ns/rec", "/l.json", { _vars: { a: "1" } });
   * // -> { config: { _vars: { a: "1" } }, warnings: [] }
   */
  it("should keep every key on the allowlist", () => {
    const raw: Record<string, unknown> = {};
    for (const key of RECIPE_CONFIG_ALLOWED_KEYS) raw[key] = { marker: key };

    const result = filterRecipeConfigLayer("ns/rec", "/layer.json", raw);

    expect(result.warnings).toEqual([]);
    expect(Object.keys(result.config).sort()).toEqual([...RECIPE_CONFIG_ALLOWED_KEYS].sort());
  });

  /**
   * filterRecipeConfigLayer() should drop a `repos` block so a recipe can never
   * grant repository trust, and say so naming the recipe and the key.
   *
   * filterRecipeConfigLayer("good/helper", "/l.json", { repos: { evil: {} } });
   * // -> { config: {}, warnings: ["The recipe good/helper tried to set 'repos' ..."] }
   */
  it("should drop a repos block and name the recipe and the key", () => {
    const result = filterRecipeConfigLayer("good/helper", "/layer.json", {
      repos: { evil: { url: "https://evil.example/x/y" } },
      _vars: { keep: "yes" },
    });

    expect(result.config).toEqual({ _vars: { keep: "yes" } });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("good/helper");
    expect(result.warnings[0]).toContain("'repos'");
    expect(result.warnings[0]).toContain("/layer.json");
  });

  /**
   * filterRecipeConfigLayer() should drop every other key that could change what
   * sous trusts or what sous runs, plus any key it does not recognise.
   *
   * filterRecipeConfigLayer("ns/rec", "/l.json", { tools: {}, whatever: 1 });
   * // -> { config: {}, warnings: [ ... one per key ... ] }
   */
  it("should drop subscriptions, tools, _env, version, name, $schema and unknown keys", () => {
    const refused = [
      "repos",
      "subscriptions",
      "tools",
      "_env",
      "version",
      "name",
      "$schema",
      "$comment",
      "whateverThisIs",
    ];
    const raw: Record<string, unknown> = {};
    for (const key of refused) raw[key] = {};

    const result = filterRecipeConfigLayer("ns/rec", "/layer.json", raw);

    expect(result.config).toEqual({});
    expect(result.warnings).toHaveLength(refused.length);
    for (const key of refused) {
      expect(result.warnings.some((line) => line.includes(`'${key}'`))).toBe(true);
    }
  });

  /**
   * filterRecipeConfigLayer() should refuse prototype-pollution keys the same
   * way it refuses anything else off the allowlist.
   *
   * filterRecipeConfigLayer("ns/rec", "/l.json", JSON.parse('{"__proto__":{"x":1}}'));
   * // -> { config: {}, warnings: [ ... ] }
   */
  it("should drop an own __proto__ key like any other key off the allowlist", () => {
    const raw = JSON.parse('{"__proto__": {"polluted": true}, "_vars": {"a": "1"}}');

    const result = filterRecipeConfigLayer("ns/rec", "/layer.json", raw);

    expect(result.config).toEqual({ _vars: { a: "1" } });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  /**
   * filterRecipeConfigLayer() should merge nothing at all when the layer did not
   * parse to an object, rather than throwing during config discovery.
   *
   * filterRecipeConfigLayer("ns/rec", "/l.json", ["a"]);
   * // -> { config: {}, warnings: ["... is not a set of configuration keys ..."] }
   */
  it("should merge nothing when the layer is not an object", () => {
    for (const raw of [["a"], "text", 7, null]) {
      const result = filterRecipeConfigLayer("ns/rec", "/layer.json", raw);
      expect(result.config).toEqual({});
      expect(result.warnings).toHaveLength(1);
    }
  });

  /**
   * A recipe config layer may be written as .yml as well as .yaml; the two are
   * the same format and refusing one of the spellings tells the author nothing
   * useful.
   *
   * RECIPE_LAYER_EXTENSIONS; // -> [".json", ".yaml", ".yml"]
   */
  it("should accept .yml alongside .yaml as a layer extension", () => {
    expect(RECIPE_LAYER_EXTENSIONS).toContain(".yml");
    expect(RECIPE_LAYER_EXTENSIONS).toContain(".yaml");
    expect(RECIPE_LAYER_EXTENSIONS).toContain(".json");
  });
});
