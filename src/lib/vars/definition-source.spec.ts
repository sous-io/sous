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
          description: "The service every request this recipe generates is sent to.",
          example: "https://api.example.com",
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
   * loadProjectDefinitions should return an empty list for a project with no
   * lockfile, so `sous vars` reports an empty project rather than failing.
   *
   * loadProjectDefinitions(settings, sousDir).load(); // -> []
   */
  it("should return no definitions when the project locks nothing", async () => {
    const source = loadProjectDefinitions({} as Settings, tmp.path);
    await expect(source.load()).resolves.toEqual([]);
  });

  /**
   * loadProjectDefinitions should return one entry per `variables:` entry of
   * every recipe the lockfile pins, attributed to the recipe that published it,
   * so `sous vars` can name where each question came from.
   *
   * loadProjectDefinitions(settings, sousDir).load();
   * // -> [{ definition: { name: "apiUrl", ... }, recipe: { namespace: "workflow", ... } }]
   */
  it("should read the variables of every locked recipe", async () => {
    const sousDir = path.join(tmp.path, ".sous");
    const storeRoot = path.join(tmp.path, "home", "cache");
    const recipeDir = path.join(storeRoot, "fixtures", "workflow", "task-files", "1.0.0");

    fs.mkdirSync(sousDir, { recursive: true });
    fs.mkdirSync(recipeDir, { recursive: true });
    fs.writeFileSync(
      path.join(sousDir, "sous.lock.json"),
      JSON.stringify({
        formatVersion: 1,
        repos: { fixtures: { url: "https://example.com/owner/fixtures" } },
        recipes: {
          "workflow/task-files": {
            repo: "fixtures",
            version: "1.0.0",
            hash: `sha256-${"b".repeat(64)}`,
            requestedBy: ["project"],
            kind: "subscribes",
          },
        },
      }),
      "utf8"
    );
    fs.writeFileSync(
      path.join(recipeDir, "sous.recipe.json"),
      JSON.stringify({
        formatVersion: 1,
        namespace: "workflow",
        name: "task-files",
        version: "1.0.0",
        contents: [],
        variables: [
          {
            name: "apiUrl",
            type: "url",
            prompt: "Where does the API live?",
            description: "The service every request this recipe generates is sent to.",
            example: "https://api.example.com",
          },
        ],
      }),
      "utf8"
    );

    const source = loadProjectDefinitions({} as Settings, sousDir, {
      SOUS_HOME: path.join(tmp.path, "home"),
    });
    const defined = await source.load();

    expect(defined).toHaveLength(1);
    expect(defined[0]!.definition.name).toBe("apiUrl");
    expect(defined[0]!.recipe).toMatchObject({
      repo: "fixtures",
      namespace: "workflow",
      name: "task-files",
      version: "1.0.0",
      url: "https://example.com/owner/fixtures",
    });
    expect(defined[0]!.recipe.dir).toContain(
      path.join("fixtures", "workflow", "task-files", "1.0.0")
    );
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
        "    description: The service every request is sent to.",
        "    example: https://api.example.com",
        "  - name: apiToken",
        "    type: string",
        "    prompt: What is the API token?",
        "    description: The token sous authenticates to the API with.",
        "    example: tok_0123456789abcdef",
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
      JSON.stringify({
        variables: [
          {
            name: "apiUrl",
            type: "nonsense",
            prompt: "?",
            description: "The service every request is sent to.",
            example: "https://api.example.com",
          },
        ],
      })
    );

    expect(() => loadDefinitionsFile(filePath)).toThrow(/variables\[0\]\.type/);
  });
});
