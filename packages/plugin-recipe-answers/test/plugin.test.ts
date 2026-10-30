import { createEngine, type Engine } from "@sous-io/core";
import { BufferedReporter, NonInteractiveError, nonInteractivePrompter, scriptedPrompter, type ServiceContext } from "@sous-io/plugin-api";
import type { VariableSourceEntity } from "@sous-io/plugin-variables/types";
import { beforeEach, describe, expect, it } from "vitest";
import recipeAnswersPlugin from "../src/index.js";
import { activeRecipe, definition, MemoryEnv, type StandIns, standInPlugins } from "./stand-ins.js";

/** An engine with the stand-ins, this plugin, and two active recipes. */
async function engineWith(env: Record<string, string> = {}): Promise<{ engine: Engine; standIns: StandIns }> {
    const standIns = standInPlugins(
        [
            activeRecipe("misc/stuff", [definition(), definition({ name: "apiToken", secret: true, scope: "local", required: false })]),
            activeRecipe("workflow/task-files", [definition({ name: "taskRoot", type: "path", default: ".sous/tasks" })], { requestedBy: ["misc/stuff"], kind: "depends" }),
        ],
        new MemoryEnv("/project/.sous", env),
    );
    // The vars intents need a project, as the old commands needed a config.
    const project = { root: "/project", sousDir: "/project/.sous", configPath: "/project/.sous/sous.config.json", confDir: "/project/.sous/conf.d" };
    const engine = createEngine({ builtIns: [...standIns.plugins, recipeAnswersPlugin], env, project, reporter: new BufferedReporter() });

    await engine.buildConfig();

    return { engine, standIns };
}

describe("plugin-recipe-answers through the engine", () => {
    let engine: Engine;
    let standIns: StandIns;

    beforeEach(async () => {
        ({ engine, standIns } = await engineWith({ SOUS_VAR_API_URL: "https://shell.example.com" }));
    });

    /** The definitions service should list the variables of every active recipe. */
    it("should list the variables the active recipes define", () => {
        const keys = engine.config.services.get("recipe-answers.definitions").listSync().map((entry) => entry.key);

        expect(keys).toEqual(["misc/stuff.apiUrl", "misc/stuff.apiToken", "workflow/task-files.taskRoot"]);
    });

    /** The answers service should resolve each through the ladder, defaults included. */
    it("should give a build its answers", () => {
        const answers = engine.config.services.get("recipe-answers.answers").get();

        expect(answers.merged).toEqual({ apiUrl: "https://shell.example.com", taskRoot: ".sous/tasks" });
        expect([...answers.secrets]).toEqual(["apiToken"]);
        expect(engine.config.services.get("recipe-answers.answers").forRecipe("workflow/task-files")).toEqual({ apiUrl: "https://shell.example.com", taskRoot: ".sous/tasks" });
    });

    /**
     * The answers should be a variable source, which no expression under `subscriptions` or
     * `repos` may read.
     */
    it("should add the answers as a variable source", () => {
        const source = engine.config.entities.get("variable-source", "recipe-answers") as VariableSourceEntity;
        const ctx = { project: undefined, env: { SOUS_VAR_API_URL: "https://shell.example.com" }, config: engine.config };

        expect(source.forbiddenUnder).toEqual(["subscriptions", "repos"]);
        expect(source.variables(ctx)).toEqual({ apiUrl: "https://shell.example.com", taskRoot: ".sous/tasks" });
        expect(source.scoped?.("misc/stuff", ctx)).toEqual({ apiUrl: "https://shell.example.com", taskRoot: ".sous/tasks" });
        expect(source.scoped?.("nope/nope", ctx)).toBeUndefined();
        expect(source.secrets?.(ctx)).toEqual(["apiToken"]);
    });

    /** The validator service should check an answer with a time-limited pattern. */
    it("should check answers", () => {
        const validator = engine.config.services.get("recipe-answers.validator");

        expect(validator.validate(definition({ type: "number" }), "x")).toEqual({ ok: false, message: "apiUrl must be a number." });
    });

    /** The ref lookups should answer for variables and environment names, opt-in. */
    it("should add the ref lookups over variables", async () => {
        const lookups = engine.config.entities.list("ref-lookup");
        const ctx = { services: engine.config.services, env: {}, config: engine.config, entities: engine.config.entities } as unknown as ServiceContext;

        expect(lookups.map((lookup) => [lookup.id, lookup.optIn, lookup.tags])).toEqual([
            ["recipe-answers.variables", true, ["variables"]],
            ["recipe-answers.env-vars", true, ["variables"]],
        ]);
        expect((await lookups[0]!.find({ kind: "variable", name: "taskRoot" }, ctx)).map((match) => match.ref.kind)).toEqual(["variable"]);
        expect((await lookups[1]!.find({ kind: "envVar", name: "SOUS_VAR_API_URL" }, ctx))[0]?.ref).toMatchObject({ kind: "envVar", variables: [{ name: "apiUrl" }] });
    });

    /** `vars list` should list every variable, a secret's value hidden. */
    it("should list variables with their answers", async () => {
        const listings = await engine.handle.submit({ intent: "vars.list", input: {} });

        expect(listings.map((entry) => [entry.variable.key, entry.answered, entry.value, entry.storeIn])).toEqual([
            ["misc/stuff.apiUrl", true, "https://shell.example.com", "shared"],
            ["misc/stuff.apiToken", false, undefined, "local"],
            ["workflow/task-files.taskRoot", false, undefined, "shared"],
        ]);
    });

    /** `vars show` should give one variable with every name tried and its constraints. */
    it("should show one variable in full", async () => {
        const detail = await engine.handle.submit({ intent: "vars.show", input: { name: "apiUrl" } });

        expect(detail.source).toEqual({ rung: "shared", envName: "SOUS_VAR_API_URL", file: "shell" });
        expect(detail.diagnosis.candidates.map((candidate) => candidate.rung)).toEqual(["recipe", "namespace", "shared"]);
        expect(detail.constraints).toEqual(["must be a value of the type string (type: string)"]);
        await expect(engine.handle.submit({ intent: "vars.show", input: { name: "nothing" } })).rejects.toThrow(/No variable named 'nothing'/);
    });

    /**
     * `vars ask` with no terminal should fail naming the flag that answers each question,
     * and succeed when the answers are given as flags, storing them and rebuilding the config.
     */
    it("should take every answer from flags when it cannot ask", async () => {
        await expect(engine.handle.submit({ intent: "vars.ask", input: { all: true } }, { prompter: nonInteractivePrompter })).rejects.toBeInstanceOf(NonInteractiveError);

        const result = await engine.handle.submit({ intent: "vars.ask", input: { answer: ["apiToken=tok_123", "workflow/task-files.taskRoot=docs/tasks"] } }, { prompter: nonInteractivePrompter });

        expect(result.answered.map((entry) => [entry.envName, entry.file, entry.value])).toEqual([
            ["SOUS_VAR_API_TOKEN", "local", "(hidden)"],
            ["SOUS_VAR_TASK_ROOT", "shared", "docs/tasks"],
        ]);
        expect(standIns.env.files).toEqual({ shared: { SOUS_VAR_TASK_ROOT: "docs/tasks" }, local: { SOUS_VAR_API_TOKEN: "tok_123" } });
        expect(engine.config.services.get("recipe-answers.answers").get().merged.taskRoot).toBe("docs/tasks");
    });

    /** `vars ask <name>` should ask about that variable through the chain's prompter. */
    it("should ask a named variable through the prompter", async () => {
        const prompter = scriptedPrompter(["https://typed.example.com"]);
        const result = await engine.handle.submit({ intent: "vars.ask", input: { name: "misc/stuff.apiUrl" } }, { prompter });

        expect(prompter.asked).toEqual(["Which API?"]);
        expect(result.answered[0]).toMatchObject({ envName: "SOUS_VAR_API_URL", value: "https://typed.example.com", shadowedBy: "SOUS_VAR_API_URL" });
        expect(standIns.env.files.shared).toEqual({ SOUS_VAR_API_URL: "https://typed.example.com" });
    });

    /** `vars ask --recipe` should ask only that recipe's questions, as `subscription.add` does. */
    it("should narrow to one recipe, and to a namespace", async () => {
        const recipe = await engine.handle.submit({ intent: "vars.ask", input: { recipe: "workflow/task-files", all: true, dryRun: true } }, { prompter: scriptedPrompter(["x"]) });

        expect(recipe.answered.map((entry) => entry.variable.key)).toEqual(["workflow/task-files.taskRoot"]);
        expect(recipe.answered[0]!.outcome).toBe("not written");
        expect(standIns.env.files.shared).toEqual({});

        await expect(engine.handle.submit({ intent: "vars.ask", input: { namespace: "nothing" } })).rejects.toThrow(/Nothing called 'nothing' was found/);
    });

    /** A name meaning several things should be settled by `--accept-first`. */
    it("should settle an ambiguous name with --accept-first", async () => {
        const result = await engine.handle.submit({ intent: "vars.ask", input: { name: "misc", acceptFirst: true, dryRun: true, all: true } }, { prompter: scriptedPrompter(["https://a", "tok"]) });

        expect(result.answered.map((entry) => entry.variable.key)).toEqual(["misc/stuff.apiUrl", "misc/stuff.apiToken"]);
    });

    /** A given answer for a name nothing defines should fail, listing what is in play. */
    it("should refuse an answer for an unknown variable", async () => {
        await expect(engine.handle.submit({ intent: "vars.ask", input: { answer: ["apiURL=x"] } })).rejects.toMatchObject({ details: expect.arrayContaining(["  misc/stuff", "    apiUrl"]) });
    });

    /** `vars map` should write a record surgically, and the ladder should read it after the rebuild. */
    it("should map an environment name to a variable", async () => {
        const result = await engine.handle.submit({ intent: "vars.map", input: { envName: "TEAM_API", target: "misc/stuff/apiUrl" } });

        expect(result).toEqual({ envName: "TEAM_API", target: "misc/stuff/apiUrl", file: "/project/.sous/conf.d/520-var-mappings.jsonc", changed: true, dryRun: false });
        expect(standIns.confd.data["520-var-mappings.jsonc"]).toEqual({ varMappings: { TEAM_API: "misc/stuff/apiUrl" } });

        const detail = await engine.handle.submit({ intent: "vars.show", input: { name: "apiUrl" } });

        expect(detail.diagnosis.candidates[0]).toEqual({ rung: "mapping", envName: "TEAM_API" });
        expect(engine.config.services.get("recipe-answers.mappings").list()).toEqual({ TEAM_API: { namespace: "misc", recipe: "stuff", variable: "apiUrl" } });

        await engine.handle.submit({ intent: "vars.map", input: { envName: "TEAM_API", remove: true } });
        expect(standIns.confd.data["520-var-mappings.jsonc"]).toEqual({ varMappings: {} });
    });

    /** The intents should keep today's commands, aliases and arguments. */
    it("should keep today's commands", () => {
        const cli = (name: string) => engine.intentCatalog.get(name)?.definition.cli;

        expect(cli("vars.list")).toMatchObject({ command: ["vars", "list"], aliases: [["var", "list"], ["vars"]], positional: ["name"] });
        expect(cli("vars.show")).toMatchObject({ command: ["vars", "show"], aliases: [["var", "show"]], positional: ["name"] });
        expect(cli("vars.ask")).toMatchObject({ command: ["vars", "ask"], aliases: [["var", "ask"]], positional: ["name"] });
    });
});
