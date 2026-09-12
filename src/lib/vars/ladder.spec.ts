import { describe, expect, it } from "vitest";
import type { DefinedVariable } from "./definition-source.js";
import {
  diagnoseVariable,
  describeSource,
  lookupEnvName,
  recordAnswerInContext,
  resolveVariable,
  variableCandidates,
  type LadderContext,
} from "./ladder.js";

/** Builds a defined variable for ladder tests. */
function defined(env?: string): DefinedVariable {
  return {
    definition: {
      name: "apiUrl",
      type: "string",
      prompt: "Which API?",
      description: "The service every request this recipe generates is sent to.",
      example: "https://api.example.com",
      required: true,
      secret: false,
      scope: "shared",
      ...(env === undefined ? {} : { env }),
    },
    recipe: { repo: "sous-recipes", namespace: "misc", name: "stuff", version: "1.0.0" },
  } as DefinedVariable;
}

/** Builds a ladder context with empty layers, overridden as needed. */
function context(overrides: Partial<LadderContext> = {}): LadderContext {
  return { shellEnv: {}, localEnv: {}, sharedEnv: {}, mappings: {}, ...overrides };
}

describe("variableCandidates()", () => {
  /**
   * variableCandidates should accept a defined variable and return every
   * environment variable name that could answer it, most specific rung first.
   *
   * variableCandidates(defined, context({ mappings: { TEAM_API: "misc/stuff/apiUrl" } }));
   * // -> TEAM_API, SOUS_VAR_MISC_STUFF_API_URL, SOUS_VAR_MISC_API_URL, SOUS_VAR_API_URL
   */
  it("should list the rungs most specific first", () => {
    const candidates = variableCandidates(
      defined(),
      context({ mappings: { TEAM_API: "misc/stuff/apiUrl" } })
    );
    expect(candidates.map((candidate) => candidate.envName)).toEqual([
      "TEAM_API",
      "SOUS_VAR_MISC_STUFF_API_URL",
      "SOUS_VAR_MISC_API_URL",
      "SOUS_VAR_API_URL",
    ]);
    expect(candidates.map((candidate) => candidate.rung)).toEqual([
      "mapping",
      "recipe",
      "namespace",
      "shared",
    ]);
  });

  /**
   * variableCandidates should include the declared bare name as its own rung
   * when the definition names one, and should not repeat the shared name when
   * the definition declares nothing.
   */
  it("should add the declared name as the last rung", () => {
    const candidates = variableCandidates(defined("GITHUB_TOKEN"), context());
    expect(candidates[candidates.length - 1]).toEqual({
      rung: "bare",
      envName: "GITHUB_TOKEN",
    });
    expect(candidates).toHaveLength(4);
  });
});

describe("resolveVariable()", () => {
  /**
   * resolveVariable should prefer the more specific rung: a recipe-scoped name
   * beats a shared one even when the shared one is set in a higher-precedence
   * layer.
   */
  it("should prefer the more specific rung", () => {
    const resolved = resolveVariable(
      defined(),
      context({
        shellEnv: { SOUS_VAR_API_URL: "https://shared.example.com" },
        sharedEnv: { SOUS_VAR_MISC_STUFF_API_URL: "https://recipe.example.com" },
      })
    );
    expect(resolved?.value).toBe("https://recipe.example.com");
    expect(resolved?.source.rung).toBe("recipe");
    expect(resolved?.source.file).toBe(".env");
  });

  /**
   * resolveVariable should prefer the shell environment over `.env.local`, and
   * `.env.local` over `.env`, when one name is set in more than one layer.
   */
  it("should prefer the shell, then .env.local, then .env", () => {
    const layers = context({
      shellEnv: { SOUS_VAR_API_URL: "from-shell" },
      localEnv: { SOUS_VAR_API_URL: "from-local" },
      sharedEnv: { SOUS_VAR_API_URL: "from-shared" },
    });
    expect(resolveVariable(defined(), layers)?.source.file).toBe("shell");

    delete layers.shellEnv.SOUS_VAR_API_URL;
    expect(resolveVariable(defined(), layers)?.source.file).toBe(".env.local");

    delete layers.localEnv.SOUS_VAR_API_URL;
    expect(resolveVariable(defined(), layers)?.source.file).toBe(".env");
  });

  /**
   * resolveVariable should return undefined when no rung is set anywhere, which
   * is what makes a variable unanswered.
   */
  it("should return undefined when nothing answers", () => {
    expect(resolveVariable(defined(), context())).toBeUndefined();
  });

  /**
   * A mapping record should win over every generated name, which is what makes
   * it the universal conflict resolver.
   */
  it("should let a mapping record win", () => {
    const resolved = resolveVariable(
      defined(),
      context({
        mappings: { TEAM_API: "sous-recipes:misc/stuff/apiUrl" },
        localEnv: { TEAM_API: "mapped", SOUS_VAR_MISC_STUFF_API_URL: "generated" },
      })
    );
    expect(resolved?.value).toBe("mapped");
    expect(resolved?.source.rung).toBe("mapping");
  });
});

describe("diagnoseVariable()", () => {
  /**
   * diagnoseVariable should return both the winning answer and the full
   * candidate list, which is what `sous vars <name>` prints and what a
   * non-interactive failure names.
   */
  it("should report the winner and every candidate", () => {
    const diagnosis = diagnoseVariable(
      defined(),
      context({ sharedEnv: { SOUS_VAR_API_URL: "https://example.com" } })
    );
    expect(diagnosis.resolved?.source.envName).toBe("SOUS_VAR_API_URL");
    expect(diagnosis.candidates).toHaveLength(3);
  });
});

describe("lookupEnvName() and recordAnswerInContext()", () => {
  /**
   * recordAnswerInContext should place a freshly stored answer in the layer it
   * was written to, so later lookups in the same run see it exactly as the next
   * run would.
   */
  it("should make a stored answer visible to later lookups", () => {
    const layers = context();
    recordAnswerInContext(layers, ".env.local", "SOUS_VAR_API_URL", "https://example.com");
    expect(lookupEnvName("SOUS_VAR_API_URL", layers)).toEqual({
      value: "https://example.com",
      file: ".env.local",
    });
  });
});

describe("describeSource()", () => {
  /**
   * describeSource should accept a resolved source and return one plain-language
   * sentence fragment naming the rung, the environment variable and the layer.
   *
   * describeSource({ rung: "shared", envName: "SOUS_VAR_API_URL", file: ".env" });
   * // -> "the shared scope name SOUS_VAR_API_URL, from the .env file"
   */
  it("should describe the rung, the name and the layer in plain language", () => {
    expect(describeSource({ rung: "shared", envName: "SOUS_VAR_API_URL", file: ".env" })).toBe(
      "the shared scope name SOUS_VAR_API_URL, from the .env file"
    );
  });
});
