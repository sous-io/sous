import { describe, expect, it } from "vitest";
import { findAll, keysOf, variableOf } from "../../../test/utils/ref-fixtures.js";
import { locationFromUrl } from "../location.js";
import type { VariableRef } from "../types.js";
import { VariableLookup, variableRefOf } from "./variable-lookup.js";

const variables = [
  variableOf("fixtures", "workflow", "task-files", "taskFileRoot"),
  variableOf("fixtures", "workflow", "task-files", "apiUrl"),
  variableOf("other", "misc", "stuff", "apiUrl"),
];
const lookup = new VariableLookup(variables);

describe("variableRefOf()", () => {
  /**
   * A defined variable is known as its name with the recipe, namespace and
   * repository nested as parents, and its prompt as the description.
   *
   * variableRefOf(fixtures:workflow/task-files.apiUrl)
   */
  it("should nest every parent", () => {
    const ref = variableRefOf(variables[1]!);
    expect(ref).toMatchObject({
      kind: "variable",
      name: "apiUrl",
      description: "What is apiUrl?",
      recipe: { name: "task-files", namespace: { name: "workflow", repo: { name: "fixtures" } } },
    });
  });
});

describe("VariableLookup", () => {
  /**
   * A bare variable name finds the variable in every recipe declaring it.
   *
   * find("apiUrl") // -> both recipes' apiUrl
   */
  it("should find a variable by its bare name", async () => {
    const matches = (await findAll(lookup, "apiUrl")).filter((m) => m.ref.kind === "variable");
    expect(keysOf(matches)).toEqual([
      "variable:fixtures:workflow/task-files.apiUrl",
      "variable:other:misc/stuff.apiUrl",
    ]);
  });

  /**
   * A variable is found at every level of qualification.
   *
   * find("task-files.apiUrl"), find("workflow/task-files.apiUrl"),
   * find("other:misc/stuff.apiUrl") // -> one variable each
   */
  it("should find a variable by a qualified name", async () => {
    for (const [text, key] of [
      ["task-files.apiUrl", "variable:fixtures:workflow/task-files.apiUrl"],
      ["workflow/task-files.apiUrl", "variable:fixtures:workflow/task-files.apiUrl"],
      ["other:misc/stuff.apiUrl", "variable:other:misc/stuff.apiUrl"],
    ] as const) {
      const found = (await findAll(lookup, text)).filter((m) => m.ref.kind === "variable");
      expect(keysOf(found), text).toEqual([key]);
    }
    const byRepo = (await findAll(lookup, "other:apiUrl")).filter((m) => m.ref.kind === "variable");
    expect(keysOf(byRepo)).toEqual(["variable:other:misc/stuff.apiUrl"]);
  });

  /**
   * A name that differs only in case is returned, flagged; a glob matches
   * several variables.
   *
   * find("apiurl") // -> folded matches; find("*Url") // -> every apiUrl
   */
  it("should flag a case-insensitive match and match globs", async () => {
    const folded = (await findAll(lookup, "apiurl")).filter((m) => m.ref.kind === "variable");
    expect(folded.every((m) => !m.exactSpelling)).toBe(true);
    expect(folded).toHaveLength(2);
    const globbed = (await findAll(lookup, "*Root")).filter((m) => m.ref.kind === "variable");
    expect(keysOf(globbed)).toEqual(["variable:fixtures:workflow/task-files.taskFileRoot"]);
  });

  /**
   * The repositories, namespaces and recipes that publish variables are
   * answered too, derived from the definitions.
   *
   * find("misc") // -> the namespace misc
   */
  it("should answer the namespaces and recipes the definitions belong to", async () => {
    const matches = await findAll(lookup, "misc");
    expect(keysOf(matches.filter((m) => m.ref.kind === "namespace"))).toEqual(["namespace:other:misc"]);
    expect(keysOf(await findAll(lookup, "workflow/task-files")).filter((k) => k.startsWith("recipe:"))).toEqual([
      "recipe:fixtures:workflow/task-files",
    ]);
  });

  /**
   * A trusted repository lends its location, so a ref written as a location
   * finds a variable's recipe.
   *
   * trusted fixtures at https://github.com/o/fixtures // the URL finds workflow/task-files
   */
  it("should use the location of a trusted repository", async () => {
    const location = locationFromUrl("https://github.com/o/fixtures")!;
    const located = new VariableLookup(variables, [
      {
        name: "fixtures",
        location,
        namespaces: [],
        recipes: [{ namespace: "workflow", name: "task-files", path: "recipes/workflow/task-files" }],
      },
    ]);
    expect(keysOf(await findAll(located, "https://github.com/o/fixtures/workflow/task-files"))).toEqual([
      "recipe:fixtures:workflow/task-files",
    ]);
    const byRepo = await located.find({
      kind: "variable",
      name: "apiUrl",
      repo: { kind: "repo", location },
    } as VariableRef);
    expect(keysOf(byRepo)).toEqual(["variable:fixtures:workflow/task-files.apiUrl"]);
  });

  /**
   * Query values on the candidate ride along on the known variable.
   *
   * find("apiUrl?x=1") // -> vars on the match
   */
  it("should carry the query values", async () => {
    const [match] = (await findAll(lookup, "workflow/task-files.apiUrl?x=1")).filter(
      (m) => m.ref.kind === "variable"
    );
    expect(match?.ref.vars).toEqual({ x: "1" });
  });
});
