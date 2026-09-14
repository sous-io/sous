import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTmpDir, type TmpDir } from "../../test/utils/tmp.js";
import type { Settings } from "../settings.js";
import { resolveRootScope } from "../settings.js";
import {
  answersForRecipe,
  resolveRecipeAnswers,
  unansweredWarning,
  type DefinedVariable,
} from "./index.js";

/**
 * The answers layer of a build's render scope: what the ladder found for every
 * definition in play, in the merged view a project's templates render, the
 * per-recipe view a recipe's own files render, and the list of what nothing
 * answered. Real env files are used throughout, since the point is that a
 * template renders exactly what `sous vars list` reports.
 */
describe("resolveRecipeAnswers()", () => {
  let tmp: TmpDir;
  let sousDir: string;

  beforeEach(() => {
    tmp = makeTmpDir("sous-answers-");
    sousDir = path.join(tmp.path, ".sous");
    fs.mkdirSync(sousDir, { recursive: true });
  });

  afterEach(() => {
    tmp.cleanup();
  });

  /** Writes the two env files. */
  function writeEnvFiles(shared: string, local = ""): void {
    fs.writeFileSync(path.join(sousDir, ".env"), shared, "utf8");
    fs.writeFileSync(path.join(sousDir, ".env.local"), local, "utf8");
  }

  /** One definition published by a recipe. */
  function define(
    recipe: string,
    name: string,
    extra: Partial<DefinedVariable["definition"]> = {}
  ): DefinedVariable {
    const [namespace, recipeName] = recipe.split("/");
    return {
      definition: {
        name,
        type: "string",
        prompt: `What is ${name}?`,
        description: `The ${name} this recipe renders.`,
        example: "example",
        required: true,
        secret: false,
        scope: "shared",
        ...extra,
      },
      recipe: { repo: "fixtures", namespace, name: recipeName, version: "1.0.0" },
    } as DefinedVariable;
  }

  const settings: Settings = {} as Settings;

  /**
   * A definition answered in `.sous/.env` under its shared name should appear
   * in the merged view under the definition's own name, so a template can
   * render `{{ apiUrl }}`.
   *
   * .env: SOUS_VAR_API_URL=https://shared.example
   * // -> merged.apiUrl === "https://shared.example"
   */
  it("should lay a stored answer into the merged view under the definition's name", () => {
    writeEnvFiles("SOUS_VAR_API_URL=https://shared.example\n");

    const answers = resolveRecipeAnswers({
      settings,
      sousDir,
      shellEnv: {},
      definitions: [define("workflow/alpha", "apiUrl")],
    });

    expect(answers.merged).toEqual({ apiUrl: "https://shared.example" });
    expect(answers.unanswered).toEqual([]);
  });

  /**
   * When no rung answers, the definition's own default is the answer, because
   * the description a publisher writes promises what the default does.
   *
   * definition.default = "hello", no env files
   * // -> merged.greeting === "hello"
   */
  it("should fall back to the definition's default when nothing answers", () => {
    writeEnvFiles("");

    const answers = resolveRecipeAnswers({
      settings,
      sousDir,
      shellEnv: {},
      definitions: [define("workflow/alpha", "greeting", { default: "hello" })],
    });

    expect(answers.merged.greeting).toBe("hello");
    expect(answers.unanswered).toEqual([]);
  });

  /**
   * A non-string default is laid in as its string form, since a template
   * renders text.
   *
   * definition.default = 3
   * // -> merged.retries === "3"
   */
  it("should stringify a numeric default", () => {
    writeEnvFiles("");

    const answers = resolveRecipeAnswers({
      settings,
      sousDir,
      shellEnv: {},
      definitions: [define("workflow/alpha", "retries", { type: "number", default: 3 })],
    });

    expect(answers.merged.retries).toBe("3");
  });

  /**
   * A required definition with no answer and no default is reported as
   * unanswered rather than laid in as an empty string; an optional one is
   * simply absent.
   *
   * definitions: apiUrl (required), nickname (required: false), no env files
   * // -> unanswered = [apiUrl]; merged has neither
   */
  it("should list required definitions nothing answered, and drop optional ones", () => {
    writeEnvFiles("");

    const answers = resolveRecipeAnswers({
      settings,
      sousDir,
      shellEnv: {},
      definitions: [
        define("workflow/alpha", "apiUrl"),
        define("workflow/alpha", "nickname", { required: false }),
      ],
    });

    expect(answers.merged).toEqual({});
    expect(answers.unanswered.map((d) => d.definition.name)).toEqual(["apiUrl"]);
  });

  /**
   * Two recipes publishing the same name share the merged view, where the
   * first definition wins, while each recipe's own view carries the answer the
   * ladder found for that recipe. The recipe-scoped rung is what makes them
   * differ.
   *
   * .env: SOUS_VAR_GREETING=shared, SOUS_VAR_WORKFLOW_BETA_GREETING=beta-only
   * // -> merged.greeting === "shared"; beta's view: "beta-only"; alpha's: "shared"
   */
  it("should give each recipe its own view while the first definition wins the merged view", () => {
    writeEnvFiles("SOUS_VAR_GREETING=shared\nSOUS_VAR_WORKFLOW_BETA_GREETING=beta-only\n");

    const answers = resolveRecipeAnswers({
      settings,
      sousDir,
      shellEnv: {},
      definitions: [define("workflow/alpha", "greeting"), define("workflow/beta", "greeting")],
    });

    expect(answers.merged.greeting).toBe("shared");
    expect(answersForRecipe(answers, "workflow/alpha").greeting).toBe("shared");
    expect(answersForRecipe(answers, "workflow/beta").greeting).toBe("beta-only");
  });

  /**
   * A recipe's own view still carries every other recipe's answers, since its
   * templates may include partials from the recipes it depends on.
   *
   * alpha defines apiUrl, beta defines greeting
   * // -> beta's view has both apiUrl and greeting
   */
  it("should include the merged answers in a recipe's own view", () => {
    writeEnvFiles("SOUS_VAR_API_URL=https://shared.example\nSOUS_VAR_GREETING=hi\n");

    const answers = resolveRecipeAnswers({
      settings,
      sousDir,
      shellEnv: {},
      definitions: [define("workflow/alpha", "apiUrl"), define("workflow/beta", "greeting")],
    });

    expect(answersForRecipe(answers, "workflow/beta")).toEqual({
      apiUrl: "https://shared.example",
      greeting: "hi",
    });
  });

  /**
   * A mapping record binds an arbitrary environment variable to one variable,
   * and it is the top rung, so its value wins over the shared name.
   *
   * varMappings: { MY_URL: "workflow/alpha/apiUrl" }; .env: MY_URL=..., SOUS_VAR_API_URL=...
   * // -> merged.apiUrl is the MY_URL value
   */
  it("should honor a mapping record above the generated names", () => {
    writeEnvFiles("MY_URL=https://mapped.example\nSOUS_VAR_API_URL=https://shared.example\n");

    const answers = resolveRecipeAnswers({
      settings: { varMappings: { MY_URL: "workflow/alpha/apiUrl" } } as unknown as Settings,
      sousDir,
      shellEnv: {},
      definitions: [define("workflow/alpha", "apiUrl")],
    });

    expect(answers.merged.apiUrl).toBe("https://mapped.example");
  });

  /**
   * A project that locks nothing gets empty views and nothing to warn about.
   *
   * definitions: []
   * // -> merged {}, unanswered []
   */
  it("should return empty views for no definitions", () => {
    const answers = resolveRecipeAnswers({ settings, sousDir, shellEnv: {}, definitions: [] });

    expect(answers.merged).toEqual({});
    expect(answers.byRecipe.size).toBe(0);
    expect(answers.unanswered).toEqual([]);
  });
});

describe("unansweredWarning()", () => {
  /** A definition with nothing answering it. */
  const unansweredApiUrl = {
    definition: { name: "apiUrl", required: true },
    recipe: { repo: "fixtures", namespace: "workflow", name: "alpha", version: "1.0.0" },
  } as DefinedVariable;

  /**
   * Nothing missing means no warning at all, so a clean build prints nothing.
   *
   * unansweredWarning({ unanswered: [] })  // -> undefined
   */
  it("should return undefined when nothing is unanswered", () => {
    expect(
      unansweredWarning({ merged: {}, byRecipe: new Map(), unanswered: [] })
    ).toBeUndefined();
  });

  /**
   * The warning names each variable with the recipe that asks for it, and the
   * command that answers them.
   *
   * unanswered: [apiUrl from workflow/alpha]
   * // -> mentions "apiUrl", "workflow/alpha" and "sous vars ask"
   */
  it("should name the variable, its recipe and the command that answers it", () => {
    const text = unansweredWarning({
      merged: {},
      byRecipe: new Map(),
      unanswered: [unansweredApiUrl],
    });

    expect(text).toContain("1 required recipe variable has no answer");
    expect(text).toContain("apiUrl (asked by workflow/alpha)");
    expect(text).toContain("sous vars ask");
  });

  /**
   * A variable the project's own config defines is not missing, whatever the
   * ladder found: the template renders the config's value.
   *
   * render scope has apiUrl  // -> undefined
   */
  it("should not warn about a variable the render scope already holds", () => {
    const text = unansweredWarning(
      { merged: {}, byRecipe: new Map(), unanswered: [unansweredApiUrl] },
      { apiUrl: "https://from-vars.example" }
    );

    expect(text).toBeUndefined();
  });
});

describe("resolveRootScope() with recipe answers", () => {
  let tmp: TmpDir;
  let sousDir: string;

  beforeEach(() => {
    tmp = makeTmpDir("sous-root-scope-answers-");
    sousDir = path.join(tmp.path, ".sous");
    fs.mkdirSync(sousDir, { recursive: true });
  });

  afterEach(() => {
    tmp.cleanup();
  });

  /** A config context pointing at the temp project. */
  function context() {
    return { sousDir, configPath: path.join(sousDir, "sous.config.json") };
  }

  /** Answers already resolved, as a build hands them in. */
  function answers(merged: Record<string, string>, byRecipe: Record<string, Record<string, string>> = {}) {
    return { merged, byRecipe: new Map(Object.entries(byRecipe)), unanswered: [] };
  }

  /**
   * An answer sits under `_vars`, so a config that names the same variable
   * wins; every other answer comes through.
   *
   * answers: { apiUrl: "from-answer", owner: "from-answer" }; _vars: { owner: "from-vars" }
   * // -> apiUrl "from-answer", owner "from-vars"
   */
  it("should let _vars override an answer and pass the rest through", () => {
    const scope = resolveRootScope(
      { _vars: { owner: "from-vars" } } as unknown as Settings,
      context(),
      { answers: answers({ apiUrl: "from-answer", owner: "from-answer" }) }
    );

    expect(scope.apiUrl).toBe("from-answer");
    expect(scope.owner).toBe("from-vars");
  });

  /**
   * An `_env` mapping also sits above an answer, so the documented bridge keeps
   * working exactly as before for a project that already wrote one.
   *
   * _env: { apiUrl: "EXPLICIT_URL" }, process.env.EXPLICIT_URL = "from-env-block"
   * // -> apiUrl "from-env-block"
   */
  it("should let _env override an answer", () => {
    process.env.SOUS_TEST_EXPLICIT_URL = "from-env-block";
    try {
      const scope = resolveRootScope(
        { _env: { apiUrl: "SOUS_TEST_EXPLICIT_URL" } } as unknown as Settings,
        context(),
        { answers: answers({ apiUrl: "from-answer" }) }
      );
      expect(scope.apiUrl).toBe("from-env-block");
    } finally {
      delete process.env.SOUS_TEST_EXPLICIT_URL;
    }
  });

  /**
   * A `_vars` entry may refer to an answer with `${name}`, since answers are in
   * the scope `_vars` resolves against.
   *
   * answers: { taskFileRoot: ".sous/tasks" }; _vars: { taskFilePath: "${sousDir}/../${taskFileRoot}" }
   * // -> taskFilePath ends with ".sous/tasks"
   */
  it("should let _vars reference an answer", () => {
    const scope = resolveRootScope(
      { _vars: { taskFilePath: "${sousDir}/../${taskFileRoot}" } } as unknown as Settings,
      context(),
      { answers: answers({ taskFileRoot: ".sous/tasks" }) }
    );

    expect(scope.taskFilePath).toBe(`${sousDir}/../.sous/tasks`);
  });

  /**
   * Asking for a recipe's scope lays that recipe's own answers over the merged
   * view.
   *
   * merged: { greeting: "shared" }, byRecipe: { "workflow/beta": { greeting: "beta-only" } }
   * // -> scope for workflow/beta has greeting "beta-only"; the merged scope has "shared"
   */
  it("should lay a recipe's own answers over the merged view when asked for that recipe", () => {
    const resolved = answers({ greeting: "shared" }, { "workflow/beta": { greeting: "beta-only" } });

    const merged = resolveRootScope({} as Settings, context(), { answers: resolved });
    const beta = resolveRootScope({} as Settings, context(), {
      answers: resolved,
      recipe: "workflow/beta",
    });

    expect(merged.greeting).toBe("shared");
    expect(beta.greeting).toBe("beta-only");
  });

  /**
   * With no config context there is no project to read answers for, so the
   * scope holds none; a settings object built by hand in a test behaves as it
   * always has.
   *
   * resolveRootScope(settings)  // -> no answer keys
   */
  it("should add no answers without a config context", () => {
    const scope = resolveRootScope({ _vars: { a: "1" } } as unknown as Settings);
    expect(scope).toEqual(expect.objectContaining({ a: "1" }));
    expect(scope.apiUrl).toBeUndefined();
  });

  /**
   * With a config context and nothing handed in, the answers are read from the
   * project itself; a project with no lockfile simply has none.
   *
   * resolveRootScope(settings, context)  // -> no answer keys, no error
   */
  it("should read answers from the project when none are handed in", () => {
    const scope = resolveRootScope({} as Settings, context());
    expect(scope.sousDir).toBe(sousDir);
  });
});
