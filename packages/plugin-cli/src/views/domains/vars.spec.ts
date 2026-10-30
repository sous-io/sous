import { describe, expect, it } from "vitest";
import { type CaptureOptions, captureView } from "../testing.js";
import {
    describeSource,
    displayValue,
    recipeLink,
    variableFacts,
    type ViewAskResult,
    type ViewDetail,
    type ViewListing,
    type ViewRecipe,
    type ViewVariable,
    views,
} from "./vars.js";

/** Runs a view and returns the text a terminal would get (colors off). */
async function render(intent: string, result: unknown, input: Record<string, unknown> = {}, options: CaptureOptions = {}): Promise<string> {
    const shown = await captureView(views[intent]!, result, { intent, input, ...options });

    return shown.stdout + shown.stderr;
}

function recipe(overrides: Partial<ViewRecipe> = {}): ViewRecipe {
    return { repo: "local", namespace: "local", name: "questions", version: "1.0.0", ...overrides };
}

function variable(overrides: Partial<ViewVariable["definition"]> = {}, recipeOverrides: Partial<ViewRecipe> = {}): ViewVariable {
    return {
        definition: {
            name: "apiUrl",
            prompt: "Which API should sous talk to?",
            description: "The API the skills call.",
            example: "https://api.example.com",
            secret: false,
            ...overrides,
        },
        recipe: recipe(recipeOverrides),
    };
}

const answered: ViewListing = {
    variable: variable(),
    answered: true,
    value: "https://example.com",
    source: { rung: "shared", envName: "SOUS_VAR_API_URL", file: "shared" },
    storedAs: "SOUS_VAR_API_URL",
    storeIn: "shared",
};

const unanswered: ViewListing = {
    variable: variable({ name: "apiToken", secret: true }),
    answered: false,
    storedAs: "SOUS_VAR_API_TOKEN",
    storeIn: "local",
};

const detail: ViewDetail = {
    ...answered,
    diagnosis: {
        resolved: { value: "https://example.com", source: { rung: "shared", envName: "SOUS_VAR_API_URL", file: "shared" } },
        candidates: [
            { rung: "recipe", envName: "SOUS_VAR_LOCAL_QUESTIONS_API_URL" },
            { rung: "namespace", envName: "SOUS_VAR_LOCAL_API_URL" },
            { rung: "shared", envName: "SOUS_VAR_API_URL" },
        ],
    },
    constraints: ["Must be a URL."],
};

describe("the vars views", () => {
    describe("helpers", () => {
        /** A secret never prints, and an unanswered variable says so. */
        it("should hide secrets and mark missing answers", () => {
            expect(displayValue(undefined, false)).toBe("(unanswered)");
            expect(displayValue("x", true)).toBe("(hidden)");
            expect(displayValue("x", false)).toBe("x");
        });

        /** "the shared scope name SOUS_VAR_API_URL, from the .env file". */
        it("should describe where an answer came from in plain words", () => {
            expect(describeSource({ rung: "shared", envName: "SOUS_VAR_API_URL", file: "shared" })).toBe("the shared scope name SOUS_VAR_API_URL, from the .env file");
            expect(describeSource({ rung: "recipe", envName: "X", file: "shell" })).toBe("the recipe scope name X, from the shell environment");
        });

        /** A hosted repository links to the recipe's folder; a local one to its path or directory. */
        it("should link a recipe to where it lives", () => {
            expect(recipeLink(recipe({ url: "https://github.com/acme/recipes/", path: "workflow/task-files" }))).toEqual({
                text: "local/questions",
                detail: "https://github.com/acme/recipes/workflow/task-files",
            });
            expect(recipeLink(recipe({ url: "/srv/recipes", path: "workflow/task-files" }))).toEqual({ text: "local/questions", detail: "/srv/recipes/workflow/task-files" });
            expect(recipeLink(recipe({ dir: "/store/x/1.2.0" }))).toEqual({ text: "local/questions", detail: "/store/x/1.2.0" });
            expect(recipeLink(recipe())).toEqual({ text: "local/questions" });
        });

        /** The facts come in the order `vars show` prints them; `default` only when there is one. */
        it("should list a variable's facts in order", () => {
            expect(variableFacts(detail).map((fact) => fact.label)).toEqual(["example", "required-by", "defined-by", "storage-path", "stored-as", "constraints"]);

            const withDefault = variableFacts({ ...detail, variable: variable({ default: "https://d" }) });

            expect(withDefault[0]).toEqual({ label: "default", lines: ["https://d"] });
            expect(withDefault.find((fact) => fact.label === "storage-path")?.lines).toEqual([".env"]);
            expect(withDefault.find((fact) => fact.label === "constraints")?.lines).toEqual(["Must be a URL."]);
        });
    });

    describe("vars.list", () => {
        /**
         * sous vars list
         * // Variables in play, then a table: Variable, Recipe, Answered by, Value, Source
         */
        it("should print the table of every variable in play", async () => {
            const text = await render("vars.list", [unanswered, answered]);

            expect(text).toContain("Variables in play");
            expect(text).toContain("Answered by");
            expect(text).toContain("SOUS_VAR_API_URL");
            expect(text).toContain("https://example.com");
            expect(text).toContain("(unanswered)");
            expect(text).toContain("shared scope, the .env file");
            expect(text).toContain("nothing yet");
            // Sorted by recipe then name: apiToken before apiUrl.
            expect(text.indexOf("apiToken")).toBeLessThan(text.indexOf("apiUrl"));
        });

        /** No variables: a sentence saying how to get some. */
        it("should say when no recipe defines a variable", async () => {
            expect(await render("vars.list", [])).toContain("No recipe in this project defines any variables yet.");
        });

        /** `sous vars apiUrl` returns the details and prints each one in full. */
        it("should print the details when a name was given", async () => {
            const text = await render("vars.list", [detail], { name: "apiUrl" });

            expect(text).toContain("Which API should sous talk to?");
            expect(text).not.toContain("Variables in play");
        });
    });

    describe("vars.show", () => {
        /** The question, documentation, facts, and the ladder with the rung that answered. */
        it("should print everything about one variable", async () => {
            const text = await render("vars.show", detail);

            expect(text).toContain("apiUrl (local/questions)");
            expect(text).toContain("Which API should sous talk to?");
            expect(text).toContain("For example");
            expect(text).toContain("https://api.example.com");
            expect(text).toContain("the value in scope fits this definition");
            expect(text).toContain("constraints");
            expect(text).toContain("Must be a URL.");
            expect(text).toContain("SOUS_VAR_LOCAL_QUESTIONS_API_URL");
            expect(text).toContain("SOUS_VAR_LOCAL_API_URL");
            expect(text).toContain("answered it, from the .env file");
            expect(text).toContain("not set");
        });

        /**
         * In a project, the report opens with the "Command Variables" block and gives the env file's
         * full path, as before the refactor.
         */
        it("should name the project and the env file's full path", async () => {
            const project = { root: "/work/app", sousDir: "/work/app/.sous", configPath: "/work/app/.sous/sous.config.json", confDir: "/work/app/.sous/conf.d" };
            const text = await render("vars.show", detail, { file: "questions.yaml" }, { project });

            expect(text).toContain("Command Variables");
            expect(text).toMatch(/Project\s*:\s*app/);
            expect(text).toMatch(/Config\s*:\s*\/work\/app\/\.sous\/sous\.config\.json/);
            expect(text).toMatch(/Definitions\s*:\s*questions\.yaml/);
            expect(text).toMatch(/storage-path\s*:\s*\/work\/app\/\.sous\/\.env/);
        });

        /** A value that does not fit says why; no answer says so. */
        it("should say whether the value in scope fits", async () => {
            expect(await render("vars.show", { ...detail, problem: "it is not a URL" })).toContain("the value in scope does not fit: it is not a URL");

            const none = await render("vars.show", { ...detail, answered: false, diagnosis: { candidates: detail.diagnosis.candidates } });

            expect(none).toContain("nothing in scope answers this variable yet");
            expect(none).toContain("(unanswered)");
        });
    });

    describe("vars.ask", () => {
        const report: ViewAskResult = {
            inherited: [{ variable: variable({ name: "apiToken", secret: true }), resolved: { value: "(hidden)", source: { rung: "shared", envName: "SOUS_VAR_API_TOKEN", file: "shell" } } }],
            answered: [
                {
                    variable: variable(),
                    envName: "SOUS_VAR_API_URL",
                    file: "shared",
                    value: "https://new",
                    replaced: "https://old",
                    mapping: { target: "local/questions/apiUrl" },
                    shadowedBy: "SOUS_VAR_API_URL",
                },
            ],
            skipped: [{ variable: variable({ name: "region" }), reason: "no terminal to ask on" }],
            dryRun: false,
        };

        /** Answers kept, stored and skipped, each as an aligned block. */
        it("should print what was kept, stored and left unanswered", async () => {
            const text = await render("vars.ask", report);

            expect(text).toContain("Answering variables");
            expect(text).toContain("Answers already in scope:");
            expect(text).toContain("(hidden)");
            expect(text).toContain("from the shared scope name SOUS_VAR_API_TOKEN, from the shell environment");
            expect(text).toContain("Answers stored:");
            expect(text).toContain("SOUS_VAR_API_URL in .env");
            expect(text).toContain("mapped to local/questions/apiUrl in the conf.d layer");
            expect(text).toContain("replaced the answer already there: https://old");
            expect(text).toContain("is set in your shell environment");
            expect(text).toContain("Left unanswered:");
            expect(text).toContain("no terminal to ask on");
        });

        /** A dry run says what would be stored. */
        it("should word a dry run as what would happen", async () => {
            const text = await render("vars.ask", { ...report, dryRun: true });

            expect(text).toContain("Answers that would be stored:");
            expect(text).toContain("replacing the answer already there");
        });
    });

    describe("vars.map", () => {
        /** The handler already reports the change, so the view prints nothing. */
        it("should print nothing", async () => {
            const shown = await captureView(views["vars.map"]!, { envName: "X", file: "f", changed: true, dryRun: false });

            expect(shown).toEqual({ stdout: "", stderr: "" });
        });
    });
});
