import { describe, expect, it } from "vitest";
import { ladder, variable } from "../test/stand-ins.js";
import { AnswersService, answersForRecipe, computeAnswers, noRecipeAnswers, unansweredWarning } from "./answers.js";

describe("computeAnswers()", () => {
    /** A stored answer should land in the merged view under the definition's name. */
    it("should lay a stored answer into the merged view under the definition's name", () => {
        const answers = computeAnswers([variable()], ladder({ shared: { SOUS_VAR_API_URL: "https://api.example.com" } }));

        expect(answers.merged).toEqual({ apiUrl: "https://api.example.com" });
        expect(answers.byRecipe).toEqual({ "misc/stuff": { apiUrl: "https://api.example.com" } });
        expect(answers.unanswered).toEqual([]);
    });

    /** The definition's default should answer when nothing else does, as a string. */
    it("should fall back to the definition's default, stringified", () => {
        expect(computeAnswers([variable({ default: "https://default.example.com" })], ladder()).merged).toEqual({ apiUrl: "https://default.example.com" });
        expect(computeAnswers([variable({ name: "port", type: "number", default: 8080 })], ladder()).merged).toEqual({ port: "8080" });
    });

    /** Required variables nothing answers should be listed; optional ones dropped. */
    it("should list required definitions nothing answered, and drop optional ones", () => {
        const required = variable();
        const optional = variable({ name: "extra", required: false });
        const answers = computeAnswers([required, optional], ladder());

        expect(answers.unanswered).toEqual([required]);
        expect(answers.merged).toEqual({});
    });

    /** Each recipe should get its own view, while the first definition wins the merged one. */
    it("should give each recipe its own view while the first definition wins the merged view", () => {
        const first = variable({}, { name: "first" });
        const second = variable({}, { name: "second" });
        const answers = computeAnswers([first, second], ladder({ shared: { SOUS_VAR_MISC_FIRST_API_URL: "one", SOUS_VAR_MISC_SECOND_API_URL: "two" } }));

        expect(answers.merged).toEqual({ apiUrl: "one" });
        expect(answers.byRecipe).toEqual({ "misc/first": { apiUrl: "one" }, "misc/second": { apiUrl: "two" } });
    });

    /** A recipe's own view should include the merged answers, its own laid over them. */
    it("should include the merged answers in a recipe's own view", () => {
        const answers = computeAnswers(
            [variable({ name: "shared" }, { name: "first" }), variable({}, { name: "second" })],
            ladder({ shared: { SOUS_VAR_SHARED: "s", SOUS_VAR_API_URL: "a" } }),
        );

        expect(answersForRecipe(answers, "misc/second")).toEqual({ shared: "s", apiUrl: "a" });
        expect(answersForRecipe(answers, "misc/unknown")).toEqual(answers.merged);
    });

    /** A mapping record should win over the generated names. */
    it("should honor a mapping record above the generated names", () => {
        const answers = computeAnswers([variable()], ladder({ local: { TEAM: "mapped", SOUS_VAR_API_URL: "shared" } }, { TEAM: "misc/stuff/apiUrl" }));

        expect(answers.merged).toEqual({ apiUrl: "mapped" });
    });

    /** Every name declared secret should be listed, answered or not. */
    it("should list the secrets", () => {
        expect([...computeAnswers([variable({ name: "apiToken", secret: true, scope: "local" })], ladder()).secrets]).toEqual(["apiToken"]);
    });

    /** No definitions should give empty views. */
    it("should return empty views for no definitions", () => {
        expect(computeAnswers([], ladder())).toEqual(noRecipeAnswers());
    });
});

describe("AnswersService", () => {
    /** The service should compute once per config, and lay one recipe's answers over the rest. */
    it("should compute once and serve each recipe's scope", () => {
        let runs = 0;
        const service = new AnswersService(() => {
            runs += 1;

            return computeAnswers([variable()], ladder({ shared: { SOUS_VAR_API_URL: "a" } }));
        });

        expect(service.get().merged).toEqual({ apiUrl: "a" });
        expect(service.forRecipe("misc/stuff")).toEqual({ apiUrl: "a" });
        expect(runs).toBe(1);
    });
});

describe("unansweredWarning()", () => {
    /** Nothing missing should give no warning. */
    it("should return undefined when nothing is unanswered", () => {
        expect(unansweredWarning(noRecipeAnswers())).toBeUndefined();
    });

    /** The warning should name the variable, its recipe and the command that answers it. */
    it("should name the variable, its recipe and the command that answers it", () => {
        const warning = unansweredWarning(computeAnswers([variable()], ladder()));

        expect(warning).toBe(
            "1 required recipe variable has no answer, so the templates that use it render an empty value:\n" +
                "  • apiUrl (asked by misc/stuff)\n" +
                "Run 'sous vars ask' to answer it.",
        );
    });

    /** A variable the render scope already holds is not missing. */
    it("should not warn about a variable the render scope already holds", () => {
        expect(unansweredWarning(computeAnswers([variable()], ladder()), { apiUrl: "from _vars" })).toBeUndefined();
    });
});
