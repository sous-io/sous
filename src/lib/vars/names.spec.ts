import { describe, expect, it } from "vitest";
import {
  bareName,
  deriveEnvName,
  ENV_PREFIX,
  namespaceScopedName,
  recipeScopedName,
  sharedName,
  toUpperSnake,
} from "./names.js";
import type { VariableDefinition } from "../repos/formats/recipe-manifest.js";

/** Builds a minimal, valid variable definition for naming tests. */
function definition(overrides: Partial<VariableDefinition> = {}): VariableDefinition {
  return {
    name: "apiUrl",
    type: "string",
    prompt: "Which API should sous talk to?",
    required: true,
    secret: false,
    scope: "shared",
    ...overrides,
  } as VariableDefinition;
}

describe("toUpperSnake()", () => {
  /**
   * toUpperSnake should accept a camelCase identifier and return the same
   * identifier in upper snake case.
   *
   * toUpperSnake("apiBaseUrl");
   * // -> "API_BASE_URL"
   */
  it("should convert camelCase to upper snake case", () => {
    expect(toUpperSnake("apiBaseUrl")).toBe("API_BASE_URL");
  });

  /**
   * toUpperSnake should treat a hyphen as a word separator, so a kebab-case
   * namespace or recipe name becomes a legal environment variable segment.
   *
   * toUpperSnake("automated-browser-tasks");
   * // -> "AUTOMATED_BROWSER_TASKS"
   */
  it("should turn hyphens into underscores", () => {
    expect(toUpperSnake("automated-browser-tasks")).toBe("AUTOMATED_BROWSER_TASKS");
  });

  /**
   * toUpperSnake should keep a run of capitals together and only break before
   * the capital that starts the next word.
   *
   * toUpperSnake("githubAPIToken");
   * // -> "GITHUB_API_TOKEN"
   */
  it("should split an acronym from the word that follows it", () => {
    expect(toUpperSnake("githubAPIToken")).toBe("GITHUB_API_TOKEN");
  });
});

describe("deriveEnvName()", () => {
  /**
   * deriveEnvName should accept a camelCase variable name and return the
   * prefixed shared-scope environment variable name.
   *
   * deriveEnvName("apiUrl");
   * // -> "SOUS_VAR_API_URL"
   */
  it("should prefix the upper snake case name", () => {
    expect(deriveEnvName("apiUrl")).toBe(`${ENV_PREFIX}API_URL`);
  });

  /**
   * sharedName should be the same string as deriveEnvName, since the shared
   * rung of the ladder IS the derived default name.
   */
  it("should be the same string the shared rung uses", () => {
    expect(sharedName("apiUrl")).toBe(deriveEnvName("apiUrl"));
  });
});

describe("recipeScopedName() and namespaceScopedName()", () => {
  /**
   * recipeScopedName should accept a namespace, a recipe and a variable name
   * and return the most specific generated name.
   *
   * recipeScopedName("misc", "stuff", "apiUrl");
   * // -> "SOUS_VAR_MISC_STUFF_API_URL"
   */
  it("should name the namespace, the recipe and the variable", () => {
    expect(recipeScopedName("misc", "stuff", "apiUrl")).toBe("SOUS_VAR_MISC_STUFF_API_URL");
  });

  /**
   * namespaceScopedName should accept a namespace and a variable name and
   * return the name that answers every recipe in that namespace.
   *
   * namespaceScopedName("misc", "apiUrl");
   * // -> "SOUS_VAR_MISC_API_URL"
   */
  it("should name the namespace and the variable", () => {
    expect(namespaceScopedName("misc", "apiUrl")).toBe("SOUS_VAR_MISC_API_URL");
  });
});

describe("bareName()", () => {
  /**
   * bareName should return the definition's own `env` field when its author
   * declared one, so a recipe can bind a name that already exists.
   *
   * bareName({ name: "token", env: "GITHUB_TOKEN", ... });
   * // -> "GITHUB_TOKEN"
   */
  it("should use the declared env name when there is one", () => {
    expect(bareName(definition({ name: "token", env: "GITHUB_TOKEN" }))).toBe("GITHUB_TOKEN");
  });

  /**
   * bareName should fall back to the shared form when no `env` field was
   * declared.
   *
   * bareName({ name: "apiUrl", ... });
   * // -> "SOUS_VAR_API_URL"
   */
  it("should fall back to the shared form", () => {
    expect(bareName(definition())).toBe("SOUS_VAR_API_URL");
  });
});
