import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTmpDir, type TmpDir } from "../../test/utils/tmp.js";
import {
  definedVariableKey,
  definingRecipeKey,
  loadDefinitionsFile,
  loadProjectDefinitions,
  pseudoRecipeName,
  StaticDefinitionSource,
  type DefinedVariable,
} from "./definition-source.js";
import type { Settings } from "../settings.js";

let tmp: TmpDir;

beforeEach(() => {
  tmp = makeTmpDir("sous-definitions-");
});

afterEach(() => {
  tmp.cleanup();
});

/** Writes a definitions file into the temp directory and returns its path. */
function writeDefinitions(name: string, content: string): string {
  const filePath = path.join(tmp.path, name);
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}

describe("StaticDefinitionSource", () => {
  /**
   * StaticDefinitionSource should accept an array of defined variables and
   * return exactly that array from load().
   */
  it("should return the definitions it was constructed with", async () => {
    const defined: DefinedVariable[] = [
      {
        definition: {
          name: "apiUrl",
          type: "string",
          prompt: "Which API?",
          required: true,
          secret: false,
          scope: "shared",
        },
        recipe: { repo: "recipes", namespace: "misc", name: "stuff", version: "1.0.0" },
      } as DefinedVariable,
    ];
    await expect(new StaticDefinitionSource(defined).load()).resolves.toBe(defined);
  });
});

describe("loadProjectDefinitions()", () => {
  /**
   * loadProjectDefinitions should return a source that loads nothing until the
   * resolver is wired in, so every `sous vars` command reports an empty project
   * rather than failing.
   */
  it("should return a source with no definitions yet", async () => {
    const source = loadProjectDefinitions({} as Settings, tmp.path);
    await expect(source.load()).resolves.toEqual([]);
  });
});

describe("pseudoRecipeName()", () => {
  /**
   * pseudoRecipeName should accept a file path and return a kebab-case recipe
   * name derived from its base name, with the extension removed.
   *
   * pseudoRecipeName("/tmp/My Questions.yaml");
   * // -> "my-questions"
   */
  it("should turn a file name into a kebab-case recipe name", () => {
    expect(pseudoRecipeName("/tmp/My Questions.yaml")).toBe("my-questions");
  });

  /**
   * pseudoRecipeName should prefix a name that does not start with a letter, so
   * the result is always a legal recipe name.
   *
   * pseudoRecipeName("/tmp/2026-vars.json");
   * // -> "file-2026-vars"
   */
  it("should prefix a name that does not start with a letter", () => {
    expect(pseudoRecipeName("/tmp/2026-vars.json")).toBe("file-2026-vars");
  });
});

describe("loadDefinitionsFile()", () => {
  /**
   * loadDefinitionsFile should accept a YAML file holding the same `variables:`
   * array a recipe manifest carries, and return one DefinedVariable per entry,
   * attributed to a pseudo-recipe named after the file.
   */
  it("should read a YAML definitions file and attribute it to the file", () => {
    const filePath = writeDefinitions(
      "team-vars.yaml",
      [
        "variables:",
        "  - name: apiUrl",
        "    type: url",
        "    prompt: Which API should sous talk to?",
        "  - name: apiToken",
        "    type: string",
        "    prompt: What is the API token?",
        "    secret: true",
        "    scope: local",
        "",
      ].join("\n")
    );

    const defined = loadDefinitionsFile(filePath);

    expect(defined).toHaveLength(2);
    expect(defined[0]!.definition.name).toBe("apiUrl");
    expect(defined[0]!.recipe.name).toBe("team-vars");
    expect(definingRecipeKey(defined[0]!.recipe)).toBe("local/team-vars");
    expect(definedVariableKey(defined[1]!)).toBe("local/team-vars.apiToken");
  });

  /**
   * loadDefinitionsFile should raise a readable ConfigError naming the file and
   * the offending field when a definition does not fit the schema.
   */
  it("should report an invalid definition with the file and the field", () => {
    const filePath = writeDefinitions(
      "bad.json",
      JSON.stringify({ variables: [{ name: "apiUrl", type: "nonsense", prompt: "?" }] })
    );

    expect(() => loadDefinitionsFile(filePath)).toThrow(/variables\[0\]\.type/);
  });
});
