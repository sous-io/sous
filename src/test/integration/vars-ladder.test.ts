import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTmpDir, type TmpDir } from "../utils/tmp.js";
import { parseEnvLocal } from "../../lib/env-local.js";
import { updateEnvFile } from "../../lib/env-file.js";
import type { Settings } from "../../lib/settings.js";
import {
  diagnoseVariable,
  loadLadderContext,
  resolveVariable,
  type DefinedVariable,
} from "../../lib/vars/index.js";

/**
 * The resolution ladder, exercised against REAL `.sous/.env` and
 * `.sous/.env.local` files rather than in-memory maps, since the point of the
 * ladder is that what it reports matches what a build actually reads. The
 * env-file writer takes part too: an answer written by sous must be readable by
 * the env file parser on the next run.
 */
describe("the variable resolution ladder over real env files", () => {
  let tmp: TmpDir;
  let sousDir: string;

  beforeEach(() => {
    tmp = makeTmpDir("sous-vars-ladder-");
    sousDir = path.join(tmp.path, ".sous");
    fs.mkdirSync(sousDir, { recursive: true });
  });

  afterEach(() => {
    tmp.cleanup();
  });

  /** One variable published by a recipe, for the ladder to resolve. */
  const defined: DefinedVariable = {
    definition: {
      name: "apiUrl",
      type: "url",
      prompt: "Which API should sous talk to?",
      required: true,
      secret: false,
      scope: "shared",
    },
    recipe: { repo: "sous-recipes", namespace: "misc", name: "stuff", version: "1.0.0" },
  } as DefinedVariable;

  /** Writes both env files with the given contents. */
  function writeEnvFiles(shared: string, local: string): void {
    fs.writeFileSync(path.join(sousDir, ".env"), shared, "utf8");
    fs.writeFileSync(path.join(sousDir, ".env.local"), local, "utf8");
  }

  /**
   * The ladder should read the two env files separately and report which one
   * answered, with `.env.local` outranking `.env`.
   */
  it("should prefer .env.local over .env and say which answered", () => {
    writeEnvFiles("SOUS_VAR_API_URL=https://shared.example.com\n", "SOUS_VAR_API_URL=https://local.example.com\n");

    const context = loadLadderContext({ sousDir, shellEnv: {} });
    const resolved = resolveVariable(defined, context);

    expect(resolved?.value).toBe("https://local.example.com");
    expect(resolved?.source.file).toBe(".env.local");
    expect(resolved?.source.rung).toBe("shared");
  });

  /**
   * The shell environment should outrank both files, which is what makes
   * `SOUS_VAR_API_URL=... sous build` behave the way anyone would expect.
   */
  it("should let the shell environment outrank both files", () => {
    writeEnvFiles("SOUS_VAR_API_URL=https://shared.example.com\n", "SOUS_VAR_API_URL=https://local.example.com\n");

    const context = loadLadderContext({
      sousDir,
      shellEnv: { SOUS_VAR_API_URL: "https://shell.example.com" },
    });

    expect(resolveVariable(defined, context)?.source.file).toBe("shell");
  });

  /**
   * A more specific rung should win even when a broader name is set in a
   * higher-precedence layer, since specificity is decided before precedence.
   */
  it("should prefer the recipe-scoped name over a shared one in a stronger layer", () => {
    writeEnvFiles("SOUS_VAR_MISC_STUFF_API_URL=https://recipe.example.com\n", "");

    const context = loadLadderContext({
      sousDir,
      shellEnv: { SOUS_VAR_API_URL: "https://shell.example.com" },
    });
    const resolved = resolveVariable(defined, context);

    expect(resolved?.value).toBe("https://recipe.example.com");
    expect(resolved?.source.rung).toBe("recipe");
  });

  /**
   * A mapping record in the merged config should add its own name to the top of
   * the ladder and win, which is what makes it the conflict resolver.
   */
  it("should let a mapping record answer before any generated name", () => {
    writeEnvFiles(
      "TEAM_API=https://mapped.example.com\nSOUS_VAR_MISC_STUFF_API_URL=https://recipe.example.com\n",
      ""
    );

    const settings = {
      varMappings: { TEAM_API: "sous-recipes:misc/stuff/apiUrl" },
    } as unknown as Settings;
    const context = loadLadderContext({ sousDir, settings, shellEnv: {} });
    const diagnosis = diagnoseVariable(defined, context);

    expect(diagnosis.resolved?.value).toBe("https://mapped.example.com");
    expect(diagnosis.candidates[0]).toEqual({ rung: "mapping", envName: "TEAM_API" });
  });

  /**
   * An answer written by the env-file writer must be readable by the ladder on
   * the next run, and the hand-written parts of the file must survive: this is
   * the round trip the whole answer-storage design rests on.
   */
  it("should read back an answer the writer stored, leaving the rest of the file intact", () => {
    const filePath = path.join(sousDir, ".env");
    const original = [
      "# The team's shared answers.",
      "",
      "OTHER_SETTING=untouched  # keep this comment",
      "",
    ].join("\n");
    fs.writeFileSync(filePath, original, "utf8");

    updateEnvFile(filePath, "SOUS_VAR_API_URL", "https://written.example.com", {
      header: "Set by sous for misc/stuff: Which API should sous talk to?",
    });

    const content = fs.readFileSync(filePath, "utf8");
    expect(content).toContain("# The team's shared answers.");
    expect(content).toContain("OTHER_SETTING=untouched  # keep this comment");
    expect(content).toContain("# Set by sous for misc/stuff: Which API should sous talk to?");
    expect(parseEnvLocal(content).OTHER_SETTING).toBe("untouched");

    const context = loadLadderContext({ sousDir, shellEnv: {} });
    expect(resolveVariable(defined, context)?.value).toBe("https://written.example.com");
  });

  /**
   * A value with spaces and a hash in it should survive the round trip through
   * the writer and the parser, because the writer quotes what needs quoting.
   */
  it("should round-trip a value that needs quoting", () => {
    const filePath = path.join(sousDir, ".env.local");
    updateEnvFile(filePath, "SOUS_VAR_MISC_STUFF_API_URL", "https://example.com/a b#c");

    const context = loadLadderContext({ sousDir, shellEnv: {} });
    expect(resolveVariable(defined, context)?.value).toBe("https://example.com/a b#c");
  });
});
