import { describe, expect, it } from "vitest";
import { candidates, findAll, variableOf } from "../../../test/utils/ref-fixtures.js";
import type { LadderContext } from "../../../lib/vars/ladder.js";
import type { EnvVarRef } from "../types.js";
import { EnvVarLookup } from "./env-var-lookup.js";

/** An environment context holding the given names in the shared `.env` file. */
function ladderWith(sharedEnv: Record<string, string>): LadderContext {
  return { shellEnv: {}, localEnv: {}, sharedEnv, mappings: {} };
}

const variables = [
  variableOf("fixtures", "workflow", "task-files", "apiUrl"),
  variableOf("other", "misc", "stuff", "apiUrl"),
  variableOf("fixtures", "workflow", "task-files", "token", "GITHUB_TOKEN"),
];

/** The variables the environment name answers, as `recipe.variable` keys. */
async function answers(lookup: EnvVarLookup, name: string): Promise<string[]> {
  const matches = await findAll(lookup, name);
  const envVar = matches.map((m) => m.ref).find((ref): ref is EnvVarRef => ref.kind === "envVar");
  return (envVar?.variables ?? []).map((v) => `${v.recipe?.name}.${v.name}`);
}

describe("EnvVarLookup", () => {
  /**
   * The shared name answers every variable of that name, as parents of the
   * one environment variable ref.
   *
   * SOUS_VAR_API_URL in use // -> task-files.apiUrl and stuff.apiUrl
   */
  it("should return the variables a generated name in use answers", async () => {
    const lookup = new EnvVarLookup(variables, ladderWith({ SOUS_VAR_API_URL: "x" }));
    expect(await answers(lookup, "SOUS_VAR_API_URL")).toEqual(["task-files.apiUrl", "stuff.apiUrl"]);
  });

  /**
   * A scoped generated name that nothing has set is not searched, so a project
   * is not told that a name nothing uses names one of its variables. The
   * shared name is the declared one, so it always is.
   *
   * SOUS_VAR_MISC_STUFF_API_URL not in use // -> nothing
   */
  it("should not search a generated name that is not in use", async () => {
    const lookup = new EnvVarLookup(variables, ladderWith({}));
    expect(await answers(lookup, "SOUS_VAR_MISC_STUFF_API_URL")).toEqual([]);
    expect(await answers(lookup, "SOUS_VAR_API_URL")).toEqual(["task-files.apiUrl", "stuff.apiUrl"]);
    expect(await answers(new EnvVarLookup(variables), "SOUS_VAR_MISC_STUFF_API_URL")).toEqual([]);
  });

  /**
   * The name a definition declares (a recipe may bind an existing variable)
   * is always searched, and a recipe-scoped name in use answers one variable.
   *
   * GITHUB_TOKEN // -> task-files.token
   */
  it("should always search the declared name, and a scoped name in use", async () => {
    const lookup = new EnvVarLookup(
      variables,
      ladderWith({ SOUS_VAR_MISC_STUFF_API_URL: "x" })
    );
    expect(await answers(lookup, "GITHUB_TOKEN")).toEqual(["task-files.token"]);
    expect(await answers(lookup, "SOUS_VAR_MISC_STUFF_API_URL")).toEqual(["stuff.apiUrl"]);
  });

  /**
   * The spelling is exact only: a name differing in case is not a match.
   *
   * github_token // -> nothing
   */
  it("should match the exact spelling only", async () => {
    const lookup = new EnvVarLookup(variables);
    expect(await answers(lookup, "GITHUB_TOKEN")).toHaveLength(1);
    expect(await findAll(lookup, "github_token")).toEqual([]);
    for (const candidate of candidates("workflow/alpha")) {
      expect(await lookup.find(candidate)).toEqual([]);
    }
  });

  /**
   * Query values on the candidate ride along on the match.
   *
   * GITHUB_TOKEN?x=1 // vars on the match
   */
  it("should carry the query values", async () => {
    const matches = await findAll(new EnvVarLookup(variables), "GITHUB_TOKEN?x=1");
    expect(matches[0]?.ref.vars).toEqual({ x: "1" });
  });
});
