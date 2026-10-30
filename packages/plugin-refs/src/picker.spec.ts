import { BufferedReporter, ConfigError, NonInteractiveError, nonInteractivePrompter, scriptedPrompter } from "@sous-io/plugin-api";
import { beforeAll, describe, expect, it } from "vitest";
import { buildRefs, recipeRef, type Refs } from "../test/fixtures.js";
import { resolvedRefFacts } from "./picker.js";
import type { VariableRef } from "./types.js";

let refs: Refs;

beforeAll(async () => {
    refs = await buildRefs();
});

const first = recipeRef("workflow", "formatter", "fixtures");
const second = recipeRef("tooling", "formatter", "extras");

describe("refs.picker pick()", () => {
    /**
     * The only match proceeds, and its facts are reported with the sentence saying why.
     *
     * pick([task-files]) // -> it, reporting "'task-files' named one recipe, and nothing else, ..."
     */
    it("should take the only match and report the facts about it", async () => {
        const reporter = new BufferedReporter();
        const only = { ...recipeRef("workflow", "task-files", "fixtures"), description: "Task files" };
        const chosen = await refs.picker.pick([only], { search: "task-files" }, { prompter: nonInteractivePrompter, reporter });

        expect(chosen).toBe(only);
        expect(reporter.messages).toEqual([
            {
                level: "notice",
                message: "'task-files' named one recipe, and nothing else, so that is what is being used.",
                details: {
                    search: "task-files",
                    resolvedTo: "fixtures:workflow/task-files",
                    kind: "recipe",
                    recipe: "task-files",
                    namespace: "workflow",
                    repository: "fixtures",
                    description: "Task files",
                },
            },
        ]);
    });

    /**
     * A ref that matched nothing is an error, with the caller's lines under it.
     *
     * pick([], { search: "nope", details }) // throws "Nothing called 'nope' was found."
     */
    it("should refuse a ref that matched nothing", async () => {
        const error = (await refs.picker
            .pick([], { search: "nope", details: ["Searched the recipes of: fixtures."] }, { prompter: nonInteractivePrompter, reporter: new BufferedReporter() })
            .catch((caught: unknown) => caught)) as ConfigError;

        expect(error).toBeInstanceOf(ConfigError);
        expect(error.message).toBe("Nothing called 'nope' was found.");
        expect(error.details).toEqual(["Searched the recipes of: fixtures."]);
    });

    /**
     * Several matches are offered through the prompter, which names --accept-first.
     *
     * pick([first, second]) with a prompter answering second // -> second
     */
    it("should ask which one was meant when several match", async () => {
        const prompter = scriptedPrompter([second]);
        const chosen = await refs.picker.pick([first, second], { search: "formatter" }, { prompter, reporter: new BufferedReporter() });

        expect(chosen).toBe(second);
        expect(prompter.asked).toEqual(["Which 'formatter' did you mean?"]);

        const custom = scriptedPrompter([first]);

        await refs.picker.pick([first, second], { search: "formatter", prompt: "Subscribe to which?" }, { prompter: custom, reporter: new BufferedReporter() });
        expect(custom.asked).toEqual(["Subscribe to which?"]);
    });

    /**
     * The choices carry each match, described so a person can tell them apart.
     *
     * askChoice({ choices }) // -> labels "fixtures:workflow/formatter  (the recipe ...)"
     */
    it("should describe each choice and name the flag that answers the question", async () => {
        let seen: { answeredBy?: string; labels: string[] } | undefined;
        const prompter = {
            ...nonInteractivePrompter,
            interactive: true,
            askChoice: <T>(question: { answeredBy?: string; choices: ReadonlyArray<{ label: string; value: T }> }) => {
                seen = { ...(question.answeredBy === undefined ? {} : { answeredBy: question.answeredBy }), labels: question.choices.map((choice) => choice.label) };

                return Promise.resolve(question.choices[0]!.value);
            },
        };

        await refs.picker.pick([first, second], { search: "formatter" }, { prompter, reporter: new BufferedReporter() });

        expect(seen).toEqual({
            answeredBy: "--accept-first",
            labels: [
                "fixtures:workflow/formatter  (the recipe 'formatter' in the namespace 'workflow' of the repository 'fixtures')",
                "extras:tooling/formatter  (the recipe 'formatter' in the namespace 'tooling' of the repository 'extras')",
            ],
        });
    });

    /**
     * --accept-first takes the first match without asking, and says so.
     *
     * pick([first, second], { acceptFirst: true }) // -> first
     */
    it("should take the first match with --accept-first", async () => {
        const reporter = new BufferedReporter();
        const prompter = scriptedPrompter([]);
        const chosen = await refs.picker.pick([first, second], { search: "formatter", acceptFirst: true }, { prompter, reporter });

        expect(chosen).toBe(first);
        expect(prompter.asked).toEqual([]);
        expect(reporter.messages[0]?.message).toBe("'formatter' named 2 things, and '--accept-first' was passed, so the first one listed is being used.");
        expect(reporter.messages[0]?.details).toMatchObject({ resolvedTo: "fixtures:workflow/formatter" });
    });

    /**
     * With announcing off, --accept-first still says it chose; one match says nothing.
     *
     * pick([first, second], { acceptFirst: true, announce: false }) // -> the sentence, no facts
     */
    it("should still say --accept-first chose, with announcing turned off", async () => {
        const reporter = new BufferedReporter();

        await refs.picker.pick([first, second], { search: "formatter", acceptFirst: true, announce: false }, { prompter: nonInteractivePrompter, reporter });
        expect(reporter.messages).toEqual([
            { level: "notice", message: "'formatter' named 2 things, and '--accept-first' was passed, so the first one listed is being used." },
        ]);

        const silent = new BufferedReporter();

        await refs.picker.pick([first], { search: "formatter", announce: false }, { prompter: nonInteractivePrompter, reporter: silent });
        expect(silent.messages).toEqual([]);
    });

    /**
     * A run that cannot ask fails, naming --accept-first and every candidate.
     *
     * pick([first, second]) with no terminal // throws NonInteractiveError
     */
    it("should fail without a terminal, naming --accept-first and the candidates", async () => {
        const error = (await refs.picker
            .pick([first, second], { search: "formatter" }, { prompter: nonInteractivePrompter, reporter: new BufferedReporter() })
            .catch((caught: unknown) => caught)) as NonInteractiveError;

        expect(error).toBeInstanceOf(NonInteractiveError);
        expect(error.answeredBy).toBe("--accept-first");
        expect(error.message).toContain("Pass --accept-first to answer it ahead of time.");
        expect(error.details.join("\n")).toContain("extras:tooling/formatter");
        expect(error.details.at(-1)).toContain("for example 'fixtures:workflow/formatter'");
    });
});

describe("refs.picker facts()", () => {
    /**
     * An environment variable name reports the variable it answers.
     *
     * facts(envVar answering apiUrl) // -> resolvedTo "fixtures:workflow/task-files.apiUrl"
     */
    it("should report the variable an environment name answers", () => {
        const variable: VariableRef = { kind: "variable", name: "apiUrl", recipe: recipeRef("workflow", "task-files", "fixtures") };

        expect(refs.picker.facts({ kind: "envVar", name: "SOUS_VAR_API_URL", variables: [variable] }, "SOUS_VAR_API_URL")).toMatchObject({
            resolvedTo: "fixtures:workflow/task-files.apiUrl",
            kind: "environment variable",
            variable: "apiUrl",
            recipe: "task-files",
            namespace: "workflow",
            repository: "fixtures",
        });
    });

    /**
     * A repository reports where it lives, and not its own name twice.
     *
     * facts(repo "fixtures") // -> location, no repository line
     */
    it("should report a repository's location", () => {
        const facts = resolvedRefFacts(
            {
                kind: "repo",
                name: "fixtures",
                location: { provider: "github", host: "github.com", repoPath: "o/f", identity: "github.com/o/f", url: "https://github.com/o/f" },
            },
            "fixtures",
            "because",
        );

        expect(facts).toMatchObject({ resolvedTo: "fixtures", location: "https://github.com/o/f", reason: "because" });
        expect(facts.repository).toBeUndefined();
    });
});
