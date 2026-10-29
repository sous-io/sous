import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { InputError, type ServiceContext } from "@sous-io/plugin-api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryEnv, readJson, secrets, serviceReader, variable } from "../test/stand-ins.js";
import { answersFromData, collectAnswers, isEnvFile, matchAnswers, parseAnswerPair, PreanswersService } from "./preanswers.js";

describe("parseAnswerPair()", () => {
    /**
     * It should split at the first equals sign only, so a value may hold more.
     *
     * parseAnswerPair("apiUrl=https://x.test/?a=1&b=2");
     * // -> { name: "apiUrl", value: "https://x.test/?a=1&b=2", from: "--answer" }
     */
    it("should split on the first equals sign only", () => {
        expect(parseAnswerPair("apiUrl=https://x.test/?a=1&b=2")).toEqual({ name: "apiUrl", value: "https://x.test/?a=1&b=2", from: "--answer" });
    });

    /** It should keep an empty value. */
    it("should keep an empty value", () => {
        expect(parseAnswerPair("apiUrl=").value).toBe("");
    });

    /** It should refuse a pair with no equals sign, as an input error naming the flag. */
    it("should refuse a pair with no equals sign", () => {
        expect(() => parseAnswerPair("apiUrl")).toThrow(InputError);

        try {
            parseAnswerPair("apiUrl");
        } catch (error) {
            expect((error as InputError).issues[0]).toEqual({ path: "answer", message: "'apiUrl' is not an answer sous can read." });
        }
    });
});

describe("answersFromData()", () => {
    /** It should read a map of answers, turning numbers and booleans into text. */
    it("should read a map of answers", () => {
        expect(answersFromData({ apiUrl: "https://x", port: 80, on: true }, "/a.yaml")).toEqual([
            { name: "apiUrl", value: "https://x", from: "/a.yaml" },
            { name: "port", value: "80", from: "/a.yaml" },
            { name: "on", value: "true", from: "/a.yaml" },
        ]);
    });

    /** It should refuse a list, a nested value or an empty value. */
    it("should refuse a nested or empty value, and a file that is not a map", () => {
        expect(() => answersFromData(["x"], "/a.yaml")).toThrow(InputError);
        expect(() => answersFromData({ apiUrl: { nested: true } }, "/a.yaml")).toThrow(InputError);
        expect(() => answersFromData({ apiUrl: null }, "/a.yaml")).toThrow(InputError);
    });
});

describe("collectAnswers()", () => {
    /** An --answer should win over the same name in the file. */
    it("should let an --answer win over the same name in the file", () => {
        const answers = collectAnswers([{ name: "apiUrl", value: "from-file", from: "/a.yaml" }, { name: "other", value: "o", from: "/a.yaml" }], ["apiUrl=from-flag"]);

        expect(answers).toEqual([
            { name: "apiUrl", value: "from-flag", from: "--answer" },
            { name: "other", value: "o", from: "/a.yaml" },
        ]);
    });
});

describe("matchAnswers()", () => {
    /** It should check each answer against every variable it names, and coerce it. */
    it("should match and coerce answers", () => {
        const port = variable({ name: "port", type: "number" });

        expect(matchAnswers([{ name: "port", value: " 80 ", from: "--answer" }], [port])).toEqual([{ answer: { name: "port", value: " 80 ", from: "--answer" }, target: port, value: "80" }]);
    });

    /** An answer that does not fit should fail, naming the recipe and hiding a secret. */
    it("should refuse an answer that does not fit its definition", () => {
        const token = variable({ name: "apiToken", secret: true, scope: "local", validate: { pattern: "^tok_" } });

        try {
            matchAnswers([{ name: "apiToken", value: "leaked", from: "--answer" }], [token]);
            expect.unreachable();
        } catch (error) {
            const details = (error as InputError).details;

            expect(details[0]).toBe("The answer given for 'apiToken' does not fit the definition misc/stuff publishes.");
            expect(details).toContain("The answer given with --answer was: (hidden)");
            expect(details.join("\n")).not.toContain("leaked");
        }
    });

    /** An unknown name should fail, listing the variables in play by recipe. */
    it("should refuse an unknown name and list the variables in play", () => {
        try {
            matchAnswers([{ name: "nope", value: "x", from: "--answer" }], [variable(), variable({ name: "other" })]);
            expect.unreachable();
        } catch (error) {
            expect((error as InputError).details).toEqual(expect.arrayContaining(["  misc/stuff", "    apiUrl", "    other"]));
        }
    });
});

describe("PreanswersService", () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(path.join(tmpdir(), "sous-preanswers-"));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    /** A service resolving relative paths against `PWD`. */
    function service(): PreanswersService {
        return new PreanswersService({
            env: { PWD: dir },
            project: undefined,
            services: serviceReader({ "formats.manifests": { readFile: readJson }, "config-files.env": new MemoryEnv(), "variables.secrets": secrets }),
        } as unknown as ServiceContext);
    }

    /** read should take a relative answers file from the shell's directory, flags over it. */
    it("should read a relative answers file, flags over it", async () => {
        writeFileSync(path.join(dir, "answers.json"), JSON.stringify({ apiUrl: "https://file", port: 1 }));

        const answers = await service().read({ answersFile: "answers.json", answer: ["port=2"] });

        expect(answers.map((answer) => [answer.name, answer.value])).toEqual([
            ["apiUrl", "https://file"],
            ["port", "2"],
        ]);
    });

    /** read should take a `.env` file of NAME=value lines. */
    it("should read a .env answers file", async () => {
        writeFileSync(path.join(dir, "answers.env"), "apiUrl=https://env\n");

        expect(isEnvFile("answers.env")).toBe(true);
        expect(await service().read({ answersFile: path.join(dir, "answers.env") })).toEqual([{ name: "apiUrl", value: "https://env", from: path.join(dir, "answers.env") }]);
    });
});
