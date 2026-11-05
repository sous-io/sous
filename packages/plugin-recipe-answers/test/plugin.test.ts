import { createEngine, type Engine } from "@sous-io/core";
import { BufferedReporter, ReportEntryStyle, Table, VariableSet, NonInteractiveError, nonInteractivePrompter, scriptedPrompter, type ServiceContext } from "@sous-io/plugin-api";
import type { VariableSourceEntity } from "@sous-io/plugin-variables/types";
import { beforeEach, describe, expect, it } from "vitest";
import recipeAnswersPlugin from "../src/index.js";
import { activeRecipe, definition, MemoryEnv, pinnedRecipe, type StandIns, standInPlugins } from "./stand-ins.js";

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
        const listings = (await engine.handle.submit({ intent: "vars.list", input: {} })).toPlain();

        expect(listings.variables.map((entry) => [entry.variable.key, entry.answered, entry.value, entry.storeIn])).toEqual([
            ["misc/stuff.apiUrl", true, "https://shell.example.com", "shared"],
            ["misc/stuff.apiToken", false, undefined, "local"],
            ["workflow/task-files.taskRoot", false, ".sous/tasks", "shared"],
        ]);
    });

    /** `vars show` should give one variable with every name tried and its constraints. */
    it("should show one variable in full", async () => {
        const detail = (await engine.handle.submit({ intent: "vars.show", input: { name: "apiUrl" } })).toPlain();

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

        const result = (await engine.handle.submit({ intent: "vars.ask", input: { answer: ["apiToken=tok_123", "workflow/task-files.taskRoot=docs/tasks"] } }, { prompter: nonInteractivePrompter })).toPlain();

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
        const result = (await engine.handle.submit({ intent: "vars.ask", input: { name: "misc/stuff.apiUrl" } }, { prompter })).toPlain();

        expect(prompter.asked).toEqual(["Which API?"]);
        expect(result.answered[0]).toMatchObject({ envName: "SOUS_VAR_API_URL", value: "https://typed.example.com", shadowedBy: "SOUS_VAR_API_URL" });
        expect(standIns.env.files.shared).toEqual({ SOUS_VAR_API_URL: "https://typed.example.com" });
    });

    /** `vars ask --recipe` should ask only that recipe's questions, as `subscription.add` does. */
    it("should narrow to one recipe, and to a namespace", async () => {
        const recipe = (await engine.handle.submit({ intent: "vars.ask", input: { recipe: "workflow/task-files", all: true, dryRun: true } }, { prompter: scriptedPrompter(["x"]) })).toPlain();

        expect(recipe.answered.map((entry) => entry.variable.key)).toEqual(["workflow/task-files.taskRoot"]);
        expect(recipe.answered[0]!.outcome).toBe("not written");
        expect(standIns.env.files.shared).toEqual({});

        await expect(engine.handle.submit({ intent: "vars.ask", input: { namespace: "nothing" } })).rejects.toThrow(/Nothing called 'nothing' was found/);
    });

    /** A name meaning several things should be settled by `--accept-first`. */
    it("should settle an ambiguous name with --accept-first", async () => {
        const result = (await engine.handle.submit({ intent: "vars.ask", input: { name: "misc", acceptFirst: true, dryRun: true, all: true } }, { prompter: scriptedPrompter(["https://a", "tok"]) })).toPlain();

        expect(result.answered.map((entry) => entry.variable.key)).toEqual(["misc/stuff.apiUrl", "misc/stuff.apiToken"]);
    });

    /** A given answer for a name nothing defines should fail, listing what is in play. */
    it("should refuse an answer for an unknown variable", async () => {
        await expect(engine.handle.submit({ intent: "vars.ask", input: { answer: ["apiURL=x"] } })).rejects.toMatchObject({ details: expect.arrayContaining(["  misc/stuff", "    apiUrl"]) });
    });

    /** `vars map` should write a record surgically, and the ladder should read it after the rebuild. */
    it("should map an environment name to a variable", async () => {
        const result = (await engine.handle.submit({ intent: "vars.map", input: { envName: "TEAM_API", target: "misc/stuff/apiUrl" } })).toPlain();

        expect(result).toEqual({ envName: "TEAM_API", target: "misc/stuff/apiUrl", file: "/project/.sous/conf.d/520-var-mappings.jsonc", changed: true, dryRun: false });
        expect(standIns.confd.data["520-var-mappings.jsonc"]).toEqual({ varMappings: { TEAM_API: "misc/stuff/apiUrl" } });

        const detail = (await engine.handle.submit({ intent: "vars.show", input: { name: "apiUrl" } })).toPlain();

        expect(detail.diagnosis.candidates[0]).toEqual({ rung: "mapping", envName: "TEAM_API" });
        expect(engine.config.services.get("recipe-answers.mappings").list()).toEqual({ TEAM_API: { namespace: "misc", recipe: "stuff", variable: "apiUrl" } });

        await engine.handle.submit({ intent: "vars.map", input: { envName: "TEAM_API", remove: true } });
        expect(standIns.confd.data["520-var-mappings.jsonc"]).toEqual({ varMappings: {} });
    });

    /** `vars list` should open with Command Variables, then one sorted table, a secret hidden or unanswered. */
    it("should show the listing as command variables and a table", async () => {
        const outputs = await engine.handle.submit({ intent: "vars.list", input: {} });
        const [opening, listing] = outputs.toArray();

        expect(opening!.title).toBe("Command Variables");
        expect(opening!.style).toBe(ReportEntryStyle.CommandVariables);
        expect(opening!.result).toBeInstanceOf(VariableSet);
        expect((opening!.result as VariableSet).toObject()).toMatchObject({ Definitions: "the project's subscribed recipes" });
        expect(listing!.title).toBe("Variables in play");
        expect(listing!.result).toBeInstanceOf(Table);
        expect((listing!.result as Table).rows.map((row) => [row.name, row.value])).toEqual([
            ["apiToken", "(unanswered)"],
            ["apiUrl", "https://shell.example.com"],
            ["taskRoot", ".sous/tasks"],
        ]);
    });

    /** `vars list <name>` and `vars show` should show a variable in full: question block, facts, then the ladder table. */
    it("should show one variable as a block, its facts and its ladder", async () => {
        const outputs = await engine.handle.submit({ intent: "vars.show", input: { name: "apiUrl" } });
        const [, block, facts, ladder] = outputs.toArray();

        expect(block!.title).toBe("apiUrl (misc/stuff)");
        expect((block!.result as VariableSet).toObject()).toMatchObject({ Value: "https://shell.example.com", Answer: "the value in scope fits this definition" });
        expect((facts!.result as VariableSet).entries.map((entry) => entry.label)).toEqual(expect.arrayContaining(["example", "required-by", "defined-by", "stored-as"]));
        expect((ladder!.result as Table).title).toBe("Environment variables sous looks at, most specific first");
        expect(outputs.toPlain()).toMatchObject({ answered: true });
    });

    /** `vars ask` should title the run, then list the answers it stored under their own title. */
    it("should report the answers stored under their titles", async () => {
        const outputs = await engine.handle.submit(
            { intent: "vars.ask", input: { answer: ["apiToken=tok_123", "workflow/task-files.taskRoot=docs/tasks"], dryRun: true } },
            { prompter: nonInteractivePrompter },
        );
        const titles = outputs.toArray().map((output) => output.title);

        expect(titles).toEqual(["Answering variables", "Answers already in scope", "Answers that would be stored"]);
        expect(outputs.toPlain()).toMatchObject({ dryRun: true });
    });

    /** `vars map` should say what changed in its summary. */
    it("should say what vars map changed", async () => {
        const outputs = await engine.handle.submit({ intent: "vars.map", input: { envName: "TEAM_API", target: "misc/stuff/apiUrl" } });

        expect(outputs.last()!.summary).toMatch(/^Mapped TEAM_API to misc\/stuff\/apiUrl in /);
    });

    /** The intents should keep today's commands, aliases and arguments. */
    it("should keep today's commands", () => {
        const cli = (name: string) => engine.intentCatalog.get(name)?.definition.cli;

        expect(cli("vars.list")).toMatchObject({ command: ["vars", "list"], aliases: [["var", "list"], ["vars"]], positional: ["name"] });
        expect(cli("vars.show")).toMatchObject({ command: ["vars", "show"], aliases: [["var", "show"]], positional: ["name"] });
        expect(cli("vars.ask")).toMatchObject({ command: ["vars", "ask"], aliases: [["var", "ask"]], positional: ["name"] });
    });
});

describe("two versions of one recipe that cannot share an answer", () => {
    /**
     * `vars list` and `vars show` should show the version that is not asked as not answerable, with
     * the warning, even when an answer is set for the name.
     *
     * support/base 1.0.0 (lib/one): tone (string), 2.0.0 (lib/two): tone (number); SOUS_VAR_TONE=warm
     * // -> list: the 2.0.0 row "(unanswered)", "not answerable ..."; show: fact "not-answerable"
     */
    it("should list and show the version not asked as not answerable", async () => {
        const env = { SOUS_VAR_TONE: "warm" };
        const standIns = standInPlugins(
            [pinnedRecipe([definition({ name: "tone" })], [{ holder: "lib/two", version: "2.0.0", variables: [definition({ name: "tone", type: "number" })] }])],
            new MemoryEnv("/project/.sous", env),
        );
        const project = { root: "/project", sousDir: "/project/.sous", configPath: "/project/.sous/sous.config.json", confDir: "/project/.sous/conf.d" };
        const engine = createEngine({ builtIns: [...standIns.plugins, recipeAnswersPlugin], env, project, reporter: new BufferedReporter() });

        await engine.buildConfig();

        const [, listing] = (await engine.handle.submit({ intent: "vars.list", input: {} })).toArray();

        expect((listing!.result as Table).rows.map((row) => [row.value, row.source])).toEqual([
            ["warm", "shared scope, the shell environment"],
            ["(unanswered)", "not answerable alongside another version of this recipe"],
        ]);

        const shown = await engine.handle.submit({ intent: "vars.show", input: { name: "tone", acceptFirst: true } });
        const details = await engine.handle.submit({ intent: "vars.list", input: { name: "tone" } });
        const skipped = details.toArray().filter((output) => output.result instanceof VariableSet && (output.result as VariableSet).entries.some((entry) => entry.label === "not-answerable"));

        expect(shown.toPlain()).toMatchObject({ answered: true });
        expect(skipped).toHaveLength(1);
        expect((skipped[0]!.result as VariableSet).entries.find((entry) => entry.label === "not-answerable")?.value).toContain(
            "The variable tone of support/base 2.0.0 cannot be answered alongside support/base 1.0.0",
        );
    });
});

/** An engine over the given recipes, with the env files already holding `files`. */
async function engineOver(
    recipes: Parameters<typeof standInPlugins>[0],
    files: { shared?: Record<string, string>; local?: Record<string, string> } = {},
): Promise<{ engine: Engine; standIns: StandIns }> {
    const memory = new MemoryEnv("/project/.sous", {});

    Object.assign(memory.files.shared, files.shared ?? {});
    Object.assign(memory.files.local, files.local ?? {});

    const standIns = standInPlugins(recipes, memory);
    const project = { root: "/project", sousDir: "/project/.sous", configPath: "/project/.sous/sous.config.json", confDir: "/project/.sous/conf.d" };
    const engine = createEngine({ builtIns: [...standIns.plugins, recipeAnswersPlugin], env: {}, project, reporter: new BufferedReporter() });

    await engine.buildConfig();

    return { engine, standIns };
}

describe("vars output (gh-204, gh-229)", () => {
    /**
     * `vars ask --dry-run` without a terminal should list the questions it would ask and succeed,
     * instead of failing because nobody can answer them (gh-204 bug 34).
     *
     * vars.ask { dryRun: true }, no terminal, apiUrl and region required and unanswered
     * // -> wouldAsk: [apiUrl, region]; titled "Questions that would be asked"; nothing written
     */
    it("should list what a dry run would ask when there is no terminal", async () => {
        const { engine, standIns } = await engineOver([activeRecipe("misc/stuff", [definition(), definition({ name: "region" })])]);
        const outputs = await engine.handle.submit({ intent: "vars.ask", input: { dryRun: true } }, { prompter: nonInteractivePrompter });
        const result = outputs.toPlain();

        expect(result.wouldAsk?.map((entry) => entry.variable.key)).toEqual(["misc/stuff.apiUrl", "misc/stuff.region"]);
        expect(outputs.toArray().map((output) => output.title)).toContain("Questions that would be asked");
        expect(outputs.exitCode).toBeUndefined();
        expect(standIns.env.files).toEqual({ shared: {}, local: {} });
    });

    /**
     * A variable with a default and no answer should be listed and shown with its default in use,
     * not as unanswered (gh-229).
     *
     * prefix: optional, default "PROJ-", nothing stored
     * // -> list: value "PROJ-", source "its default; no answer is stored"; show: Value "PROJ- (default)"
     */
    it("should list and show a default in use", async () => {
        const { engine } = await engineOver([activeRecipe("misc/stuff", [definition({ name: "prefix", required: false, default: "PROJ-" })])]);
        const [, listing] = (await engine.handle.submit({ intent: "vars.list", input: {} })).toArray();

        expect((listing!.result as Table).rows.map((row) => [row.name, row.value, row.source])).toEqual([["prefix", "PROJ-", "its default; no answer is stored"]]);

        const [, block] = (await engine.handle.submit({ intent: "vars.show", input: { name: "prefix" } })).toArray();

        expect((block!.result as VariableSet).toObject()).toMatchObject({ Value: "PROJ- (default)", Answer: "nothing in scope answers this variable, so its default is used" });
    });

    /**
     * "Stored in" should name the file the value came from; where a new answer would go is shown
     * apart from it (gh-229 defect 8).
     *
     * token: scope local; SOUS_VAR_TOKEN only in .sous/.env
     * // -> Stored in: "/project/.sous/.env"; Saved to: "/project/.sous/.env.local (where new answers go)"
     */
    it("should say where the value is stored, apart from where new answers go", async () => {
        const { engine } = await engineOver([activeRecipe("misc/stuff", [definition({ name: "token", scope: "local" })])], { shared: { SOUS_VAR_TOKEN: "abc" } });
        const [, block, facts] = (await engine.handle.submit({ intent: "vars.show", input: { name: "token" } })).toArray();

        expect((block!.result as VariableSet).toObject()).toMatchObject({ Value: "abc", "Stored in": "/project/.sous/.env", "Saved to": "/project/.sous/.env.local (where new answers go)" });
        expect((facts!.result as VariableSet).entries.map((entry) => entry.label)).not.toContain("storage-path");
    });

    /**
     * `vars show` should accept the environment name `vars list` shows under "Answered by", and
     * offer every variable it answers when it answers several (gh-229 defect 7).
     *
     * vars.show { name: "MY_ENV_NAME" } -> misc/stuff.myVar
     * vars.show { name: "SOUS_VAR_API_URL" } -> asks which of misc/other.apiUrl, misc/third.apiUrl
     */
    it("should show a variable by the environment name that answers it", async () => {
        const { engine } = await engineOver(
            [activeRecipe("misc/stuff", [definition({ name: "myVar", env: "MY_ENV_NAME" })]), activeRecipe("misc/other", [definition()]), activeRecipe("misc/third", [definition()])],
            { shared: { MY_ENV_NAME: "x" } },
        );
        const detail = (await engine.handle.submit({ intent: "vars.show", input: { name: "MY_ENV_NAME" } })).toPlain();

        expect(detail.variable.key).toBe("misc/stuff.myVar");

        const third = engine.config.services.get("recipe-answers.definitions").listSync().find((entry) => entry.key === "misc/third.apiUrl")!;
        const prompter = scriptedPrompter([third.ref]);
        const second = (await engine.handle.submit({ intent: "vars.show", input: { name: "SOUS_VAR_API_URL" } }, { prompter })).toPlain();

        expect(prompter.asked).toHaveLength(1);
        expect(second.variable.key).toBe("misc/third.apiUrl");
    });

    /**
     * When optional variables are left unanswered, the report should say how to answer them
     * (gh-204 bug 35).
     *
     * vars.ask with only an optional variable left
     * // -> a note naming 'sous vars ask <name>' and 'sous vars ask --all'
     */
    it("should say how to answer the optional variables it left", async () => {
        const { engine } = await engineOver([activeRecipe("misc/stuff", [definition({ name: "extra", required: false })])]);
        const outputs = (await engine.handle.submit({ intent: "vars.ask", input: {} }, { prompter: nonInteractivePrompter })).toArray();
        const text = outputs.map((output) => output.summary ?? "").join("\n");

        expect(text).toContain("sous vars ask <name>");
        expect(text).toContain("sous vars ask --all");
    });

    /**
     * A name several recipes share should be reported once, naming the recipes, under "Answers
     * already in scope" and "Left unanswered" (gh-204 bug 48).
     *
     * memoryRoot answered by MEMORY_ROOT for three recipes; extra optional in two
     * // -> one "memoryRoot" entry naming the three recipes; one "extra" entry naming both
     */
    it("should report a variable several recipes share once, naming them", async () => {
        const shared = definition({ name: "memoryRoot", env: "MEMORY_ROOT" });
        const extra = definition({ name: "extra", required: false });
        const { engine } = await engineOver(
            [activeRecipe("misc/a", [shared, extra]), activeRecipe("misc/b", [shared, extra]), activeRecipe("misc/c", [shared])],
            { shared: { MEMORY_ROOT: "/m" } },
        );
        const outputs = (await engine.handle.submit({ intent: "vars.ask", input: {} }, { prompter: nonInteractivePrompter })).toArray();
        const section = (title: string) => (outputs.find((output) => output.title === title)!.result as VariableSet).entries;

        expect(section("Answers already in scope").map((entry) => [entry.label, entry.value, entry.detail])).toEqual([
            ["memoryRoot", "/m", "from the declared name MEMORY_ROOT, from the .env file; used by misc/a, misc/b, misc/c"],
        ]);
        expect(section("Left unanswered").map((entry) => [entry.label, entry.value])).toEqual([["extra", "no answer yet, and this variable is optional (used by misc/a, misc/b)"]]);
    });

    /**
     * Run for the recipes a subscription installed (`within`), with nothing to ask, `vars ask`
     * should report nothing while it runs: the subscription runs it before the build, and its
     * settings printed there would precede a step that never comes (gh-229).
     *
     * vars.ask { within: ["misc/stuff"] }, only an optional variable
     * // -> nothing reported while it runs
     */
    it("should report nothing while it runs when a subscription has nothing to ask", async () => {
        const { engine } = await engineOver([activeRecipe("misc/stuff", [definition({ name: "extra", required: false })])]);
        const reporter = new BufferedReporter();

        await engine.handle.submit({ intent: "vars.ask", input: { within: ["misc/stuff"] } }, { prompter: nonInteractivePrompter, reporter });

        expect(reporter.messages).toEqual([]);
    });

    /**
     * Run for a subscription with something to ask, the settings should still be reported, before
     * the first question.
     *
     * vars.ask { within: ["misc/stuff"] }, apiUrl required, answered at the prompt
     * // -> "Definitions" reported, then the question
     */
    it("should report its settings before the first question a subscription asks", async () => {
        const { engine } = await engineOver([activeRecipe("misc/stuff", [definition()])]);
        const reporter = new BufferedReporter();

        await engine.handle.submit({ intent: "vars.ask", input: { within: ["misc/stuff"] } }, { prompter: scriptedPrompter(["https://a"]), reporter });

        const styles = reporter.messages.map((entry) => entry.style);

        expect(styles.indexOf(ReportEntryStyle.VariableList)).toBeGreaterThanOrEqual(0);
        expect(styles.indexOf(ReportEntryStyle.VariableList)).toBeLessThan(styles.indexOf(ReportEntryStyle.Question));
    });
});
