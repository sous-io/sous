import { BufferedReporter, NonInteractiveError, nullReporter, type Prompter, scriptedPrompter } from "@sous-io/plugin-api";
import type { EnvFileKind } from "@sous-io/plugin-config-files/types";
import { describe, expect, it } from "vitest";
import { ladder, silentPrompter, variable } from "../test/stand-ins.js";
import { type AnswerStore, askForMissing, askLeadIn, type AskRun, askSummary, nonInteractiveError, recipeOpeningLine, storeGivenAnswers } from "./ask.js";
import type { Ladder } from "./ladder.js";
import { matchAnswers } from "./preanswers.js";
import type { DefinedVariable } from "./types.js";

/** A store that keeps what is written. */
function memoryStore(): AnswerStore & { answers: Array<[EnvFileKind, string, string]>; mappings: Array<[string, string]> } {
    const answers: Array<[EnvFileKind, string, string]> = [];
    const mappings: Array<[string, string]> = [];

    return {
        answers,
        mappings,
        envPath: (file) => (file === "local" ? "/p/.sous/.env.local" : "/p/.sous/.env"),
        mappingPath: () => "/p/.sous/conf.d/520-var-mappings.jsonc",
        writeAnswer: async (file, envName, value) => {
            answers.push([file, envName, value]);
        },
        writeMapping: async (envName, target) => {
            mappings.push([envName, target]);

            return "/p/.sous/conf.d/520-var-mappings.jsonc";
        },
    };
}

/** A run over a prompter, writing to a memory store. */
function run(prompter: Prompter = silentPrompter, dryRun = false, reporter = nullReporter as AskRun["reporter"]) {
    const store = memoryStore();

    return { store, run: { prompter, reporter, store, hidden: "(hidden)", dryRun } satisfies AskRun };
}

/** Stores answers given up front. */
async function give(variables: DefinedVariable[], answers: Record<string, string>, subject: Ladder, dryRun = false) {
    const given = run(silentPrompter, dryRun);
    const provided = Object.entries(answers).map(([name, value]) => ({ name, value, from: "--answer" }));
    const result = await storeGivenAnswers(matchAnswers(provided, variables), subject, given.run);

    return { ...result, store: given.store };
}

describe("askLeadIn()", () => {
    /**
     * It should name each recipe and its count, marking one that came as a dependency.
     *
     * askLeadIn([{ key: "a", count: 4, direct: true }, { key: "b", count: 2, direct: false }]);
     * // -> "a needs 4 answers, and b, which it depends on, needs 2."
     */
    it("should name every recipe, its count, and how it got here", () => {
        expect(
            askLeadIn([
                { key: "workflow/task-files", count: 4, direct: true },
                { key: "workflow/sub-agent-delegation", count: 2, direct: false },
            ]),
        ).toBe("workflow/task-files needs 4 answers, and workflow/sub-agent-delegation, which it depends on, needs 2.");
    });

    /** One recipe needs no lead-in. */
    it("should produce nothing for a single recipe", () => {
        expect(askLeadIn([{ key: "workflow/task-files", count: 4, direct: true }])).toBeUndefined();
    });
});

describe("recipeOpeningLine()", () => {
    /** It should use the right noun for the count. */
    it("should count answers with the right noun", () => {
        expect(recipeOpeningLine("workflow/task-files", 4)).toBe("workflow/task-files needs 4 answers before it can be used.");
        expect(recipeOpeningLine("workflow/task-files", 1)).toBe("workflow/task-files needs 1 answer before it can be used.");
    });
});

describe("storeGivenAnswers()", () => {
    /** A given answer should go where the asking flow would put it: its declared name, its file. */
    it("should store a given answer in the file its scope asks for", async () => {
        const { stored, keys, store } = await give([variable()], { apiUrl: "https://x.test" }, ladder());

        expect([...keys]).toEqual(["misc/stuff.apiUrl"]);
        expect(stored[0]).toMatchObject({ envName: "SOUS_VAR_API_URL", file: "shared", outcome: "appended", filePath: "/p/.sous/.env" });
        expect(store.answers).toEqual([["shared", "SOUS_VAR_API_URL", "https://x.test"]]);
    });

    /** A secret should go to the gitignored file, and never be echoed. */
    it("should store a secret in the gitignored local file", async () => {
        const { stored, store } = await give([variable({ name: "apiToken", secret: true, scope: "local" })], { apiToken: "t0ken" }, ladder());

        expect(stored[0]).toMatchObject({ file: "local", value: "(hidden)" });
        expect(store.answers).toEqual([["local", "SOUS_VAR_API_TOKEN", "t0ken"]]);
    });

    /** An answer already stored should be replaced where it lives, and the result should say so. */
    it("should overwrite an answer that is already stored, and say so", async () => {
        const { stored, store } = await give([variable()], { apiUrl: "https://new.test" }, ladder({ shared: { SOUS_VAR_MISC_STUFF_API_URL: "https://old.test" } }));

        expect(stored[0]).toMatchObject({ envName: "SOUS_VAR_MISC_STUFF_API_URL", replaced: "https://old.test", outcome: "updated" });
        expect(store.answers).toEqual([["shared", "SOUS_VAR_MISC_STUFF_API_URL", "https://new.test"]]);
    });

    /** A shell variable that outranks the stored answer should be named. */
    it("should name a shell variable that outranks the stored answer", async () => {
        const { stored, store } = await give([variable()], { apiUrl: "https://new.test" }, ladder({ shell: { SOUS_VAR_API_URL: "https://shell.test" } }));

        expect(stored[0]!.shadowedBy).toBe("SOUS_VAR_API_URL");
        expect(store.answers).toEqual([["shared", "SOUS_VAR_API_URL", "https://new.test"]]);
    });

    /** Every answer should be checked before any is written. */
    it("should refuse an answer that does not fit its definition, writing nothing", async () => {
        const variables = [variable({ type: "url" }), variable({ name: "taskFileRoot", type: "path" })];

        await expect(give(variables, { taskFileRoot: ".sous/tasks", apiUrl: "not-a-url" }, ladder())).rejects.toMatchObject({
            details: expect.arrayContaining(["apiUrl must be a URL, including its scheme (for example 'https://example.com').", "For example: https://api.example.com"]),
        });
    });

    /** A dry run should write nothing, but plan as though the answer were stored. */
    it("should write nothing on a dry run", async () => {
        const subject = ladder();
        const { stored, store } = await give([variable()], { apiUrl: "https://x.test" }, subject, true);

        expect(stored[0]!.outcome).toBe("not written");
        expect(store.answers).toEqual([]);
        expect(subject.lookupIn("shared", "SOUS_VAR_API_URL")).toBe("https://x.test");
    });
});

describe("askForMissing()", () => {
    /** An answer that fits should be kept, and nothing asked. */
    it("should inherit an answer that fits", async () => {
        const { run: io } = run();
        const report = await askForMissing([variable()], ladder({ shared: { SOUS_VAR_API_URL: "https://x" } }), {}, io);

        expect(report.inherited).toHaveLength(1);
        expect(report.answered).toEqual([]);
    });

    /** An optional variable with no answer should be left, with the reason. */
    it("should skip an optional variable", async () => {
        const report = await askForMissing([variable({ required: false })], ladder(), {}, run().run);

        expect(report.skipped[0]!.reason).toBe("no answer yet, and this variable is optional");
    });

    /**
     * A run that cannot ask should fail naming, for each variable, every environment name that
     * would answer it and the flag that answers it (L4).
     */
    it("should fail without a terminal, naming the flag and every name", async () => {
        const error = await askForMissing([variable()], ladder(), {}, run().run).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(NonInteractiveError);
        expect((error as NonInteractiveError).answeredBy).toBe("--answer apiUrl=<value>");
        expect((error as NonInteractiveError).message).toBe("One variable still needs an answer, and there is no terminal to ask on.");
        expect((error as NonInteractiveError).exitCode).toBe(1);
        expect((error as NonInteractiveError).details).toEqual(
            expect.arrayContaining(["apiUrl (misc/stuff): Which API?", "  SOUS_VAR_MISC_STUFF_API_URL  (recipe scope)", "  SOUS_VAR_API_URL  (shared scope)"]),
        );
    });

    /** A value that no longer fits should be named in that failure. */
    it("should name a value in scope that no longer fits", () => {
        const error = nonInteractiveError([{ variable: variable(), candidates: [], current: "apiUrl must not be empty." }]);

        expect(error.details).toContain("  The value currently in scope does not fit this variable: apiUrl must not be empty.");
    });

    /** Questions should be asked through the prompter by type, and the answers stored. */
    it("should ask through the prompter and store each answer", async () => {
        const prompter = scriptedPrompter(["https://typed.example.com", "beta", true]);
        const reporter = new BufferedReporter();
        const { run: io, store } = run(prompter, false, reporter);
        const variables = [
            variable(),
            variable({ name: "channel", type: "enum", validate: { enum: ["alpha", "beta"] } }),
            variable({ name: "verbose", type: "boolean" }, { name: "other", direct: false }),
        ];

        const report = await askForMissing(variables, ladder(), {}, io);

        expect(prompter.asked).toEqual(["Which API?", "Which API?", "Which API?"]);
        expect(store.answers).toEqual([
            ["shared", "SOUS_VAR_API_URL", "https://typed.example.com"],
            ["shared", "SOUS_VAR_CHANNEL", "beta"],
            ["shared", "SOUS_VAR_VERBOSE", "true"],
        ]);
        expect(report.answered.map((entry) => entry.outcome)).toEqual(["appended", "appended", "appended"]);
        expect(reporter.at("notice")).toEqual(
            expect.arrayContaining([
                "misc/stuff needs 2 answers, and misc/other, which it depends on, needs 1.",
                "misc/stuff needs 2 answers before it can be used.",
                "Question 1 of 2: apiUrl",
                "Answer: SOUS_VAR_API_URL=https://typed.example.com",
                "Saved to: /p/.sous/.env",
            ]),
        );
    });

    /** A name the user picked should be asked even when answered, and --all asks everything. */
    it("should ask a named variable, and every one with reask", async () => {
        const subject = ladder({ shared: { SOUS_VAR_API_URL: "https://old" } });
        const named = await askForMissing([variable()], subject, { only: new Set(["misc/stuff.apiUrl"]) }, run(scriptedPrompter(["https://new"])).run);

        expect(named.answered[0]).toMatchObject({ envName: "SOUS_VAR_API_URL", outcome: "updated" });

        const all = await askForMissing([variable()], ladder({ shared: { SOUS_VAR_API_URL: "https://old" } }), { reask: true }, run(scriptedPrompter(["https://again"])).run);

        expect(all.answered).toHaveLength(1);
    });

    /** Two recipes sharing a name should be asked once; the second inherits the first's answer. */
    it("should ask a shared name once", async () => {
        const prompter = scriptedPrompter(["https://once"]);
        const report = await askForMissing([variable(), variable({}, { name: "other" })], ladder(), {}, run(prompter).run);

        expect(prompter.asked).toHaveLength(1);
        expect(report.inherited.map((entry) => entry.variable.key)).toEqual(["misc/other.apiUrl"]);
    });

    /** Variables answered up front should be neither asked nor reported. */
    it("should skip variables answered up front", async () => {
        const report = await askForMissing([variable()], ladder(), { skip: new Set(["misc/stuff.apiUrl"]) }, run().run);

        expect(report).toEqual({ answered: [], inherited: [], skipped: [] });
    });

    /**
     * When the name an answer goes under holds a value that does not fit, a mapping under the
     * recipe-scoped name should be written instead (without asking when the run cannot ask).
     */
    it("should map the answer to the recipe-scoped name when its name is taken", async () => {
        const prompter = scriptedPrompter(["https://mine.example.com", true]);
        const { run: io, store } = run(prompter);
        const subject = ladder({ shared: { SOUS_VAR_API_URL: "not a url" } });
        const report = await askForMissing([variable({ type: "url" })], subject, {}, io);

        expect(report.answered[0]).toMatchObject({
            envName: "SOUS_VAR_MISC_STUFF_API_URL",
            mapping: { envName: "SOUS_VAR_MISC_STUFF_API_URL", target: "sous-recipes:misc/stuff/apiUrl" },
        });
        expect(store.mappings).toEqual([["SOUS_VAR_MISC_STUFF_API_URL", "sous-recipes:misc/stuff/apiUrl"]]);
        expect(store.answers).toEqual([["shared", "SOUS_VAR_MISC_STUFF_API_URL", "https://mine.example.com"]]);
    });
});

describe("askSummary()", () => {
    /** It should list what was kept, stored and left, with where each answer came from. */
    it("should summarize a run in plain lines", () => {
        const lines = askSummary(
            {
                inherited: [{ variable: variable(), resolved: { value: "https://x", source: { rung: "shared", envName: "SOUS_VAR_API_URL", file: "shared" } } }],
                answered: [{ variable: variable({ name: "port" }), envName: "SOUS_VAR_PORT", file: "shared", filePath: "/p/.sous/.env", value: "80", outcome: "appended", replaced: "79" }],
                skipped: [{ variable: variable({ name: "extra" }), reason: "no answer yet, and this variable is optional" }],
                dryRun: false,
            },
            "(hidden)",
        );

        expect(lines).toEqual([
            "Answers already in scope:",
            "  apiUrl  https://x  (from the shared scope name SOUS_VAR_API_URL, from the .env file)",
            "",
            "Answers stored:",
            "  port  80  (SOUS_VAR_PORT in .env)",
            "    replaced the answer already there: 79",
            "",
            "Left unanswered:",
            "  extra  no answer yet, and this variable is optional",
        ]);
    });

    /** A run with nothing to do should say so. */
    it("should say when everything is answered", () => {
        expect(askSummary({ inherited: [], answered: [], skipped: [], dryRun: false }, "(hidden)")).toEqual(["Every variable in play already has an answer that fits its definition."]);
    });
});
