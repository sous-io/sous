import { describe, expect, it } from "vitest";
import { ladder, variable } from "../test/stand-ins.js";
import { describeSource, layersFrom } from "./ladder.js";

describe("Ladder.candidates()", () => {
    /**
     * candidates should return every environment name that could answer a variable, most
     * specific rung first.
     *
     * ladder({}, { TEAM_API: "misc/stuff/apiUrl" }).candidates(apiUrl);
     * // -> TEAM_API, SOUS_VAR_MISC_STUFF_API_URL, SOUS_VAR_MISC_API_URL, SOUS_VAR_API_URL
     */
    it("should list the rungs most specific first", () => {
        const candidates = ladder({}, { TEAM_API: "misc/stuff/apiUrl" }).candidates(variable());

        expect(candidates.map((candidate) => candidate.envName)).toEqual(["TEAM_API", "SOUS_VAR_MISC_STUFF_API_URL", "SOUS_VAR_MISC_API_URL", "SOUS_VAR_API_URL"]);
        expect(candidates.map((candidate) => candidate.rung)).toEqual(["mapping", "recipe", "namespace", "shared"]);
    });

    /**
     * candidates should add the declared name as its own last rung when the definition names
     * one, and not repeat the shared name when it names none.
     */
    it("should add the declared name as the last rung", () => {
        const candidates = ladder().candidates(variable({ env: "GITHUB_TOKEN" }));

        expect(candidates.at(-1)).toEqual({ rung: "bare", envName: "GITHUB_TOKEN" });
        expect(candidates).toHaveLength(4);
    });
});

describe("Ladder.resolve()", () => {
    /**
     * resolve should prefer the more specific rung: a recipe-scoped name beats a shared one even
     * when the shared one is set in a layer that wins.
     */
    it("should prefer the more specific rung", () => {
        const resolved = ladder({ shell: { SOUS_VAR_API_URL: "https://shared.example.com" }, shared: { SOUS_VAR_MISC_STUFF_API_URL: "https://recipe.example.com" } }).resolve(variable());

        expect(resolved?.value).toBe("https://recipe.example.com");
        expect(resolved?.source.rung).toBe("recipe");
        expect(resolved?.source.file).toBe("shared");
    });

    /**
     * resolve should prefer the shell over `.env.local`, and `.env.local` over `.env`, for one name
     * set in several layers.
     */
    it("should prefer the shell, then .env.local, then .env", () => {
        expect(ladder({ shell: { SOUS_VAR_API_URL: "a" }, local: { SOUS_VAR_API_URL: "b" }, shared: { SOUS_VAR_API_URL: "c" } }).resolve(variable())?.source.file).toBe("shell");
        expect(ladder({ local: { SOUS_VAR_API_URL: "b" }, shared: { SOUS_VAR_API_URL: "c" } }).resolve(variable())?.source.file).toBe("local");
        expect(ladder({ shared: { SOUS_VAR_API_URL: "c" } }).resolve(variable())?.source.file).toBe("shared");
    });

    /**
     * resolve should return undefined when no rung is set, which is what makes a variable
     * unanswered.
     */
    it("should return undefined when nothing answers", () => {
        expect(ladder().resolve(variable())).toBeUndefined();
    });

    /** A mapping record should win over every generated name. */
    it("should let a mapping record win", () => {
        const resolved = ladder({ local: { TEAM_API: "mapped", SOUS_VAR_MISC_STUFF_API_URL: "generated" } }, { TEAM_API: "sous-recipes:misc/stuff/apiUrl" }).resolve(variable());

        expect(resolved?.value).toBe("mapped");
        expect(resolved?.source.rung).toBe("mapping");
    });
});

describe("Ladder.diagnose()", () => {
    /** diagnose should return the winning answer and every candidate it tried. */
    it("should report the winner and every candidate", () => {
        const diagnosis = ladder({ shared: { SOUS_VAR_API_URL: "https://example.com" } }).diagnose(variable());

        expect(diagnosis.resolved?.source.envName).toBe("SOUS_VAR_API_URL");
        expect(diagnosis.candidates).toHaveLength(3);
    });
});

describe("Ladder.record() and Ladder.lookup()", () => {
    /**
     * record should place a stored answer in the layer it was written to, so later lookups in the
     * same run see it as the next run would.
     */
    it("should make a stored answer visible to later lookups", () => {
        const subject = ladder();

        subject.record("local", "SOUS_VAR_API_URL", "https://example.com");

        expect(subject.lookup("SOUS_VAR_API_URL")).toEqual({ value: "https://example.com", file: "local" });
        expect(subject.lookupIn("shared", "SOUS_VAR_API_URL")).toBeUndefined();
    });

    /** addMapping should make a new record a rung at once. */
    it("should read a mapping added in the same run", () => {
        const subject = ladder({ local: { MINE: "x" } });

        subject.addMapping("MINE", "misc/stuff/apiUrl");

        expect(subject.resolve(variable())?.source).toEqual({ rung: "mapping", envName: "MINE", file: "local" });
    });
});

describe("layersFrom()", () => {
    /**
     * layersFrom should keep the shell apart from the env files, taking a value equal to a file's
     * to come from the file, since the files may already be in the environment.
     */
    it("should keep the shell apart from the files", () => {
        const layers = layersFrom({ shared: { A: "1" }, local: { B: "2" } }, { A: "1", B: "changed", C: "3", D: undefined });

        expect(layers).toEqual({ shell: { B: "changed", C: "3" }, local: { B: "2" }, shared: { A: "1" } });
    });
});

describe("describeSource()", () => {
    /**
     * describeSource should name the rung, the name and the layer in one phrase.
     *
     * describeSource({ rung: "shared", envName: "SOUS_VAR_API_URL", file: "shared" });
     * // -> "the shared scope name SOUS_VAR_API_URL, from the .env file"
     */
    it("should describe the rung, the name and the layer in plain language", () => {
        expect(describeSource({ rung: "shared", envName: "SOUS_VAR_API_URL", file: "shared" })).toBe("the shared scope name SOUS_VAR_API_URL, from the .env file");
    });
});
