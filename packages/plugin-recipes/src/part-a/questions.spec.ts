import { describe, expect, it } from "vitest";

import { describeSource } from "./questions.js";

describe("describeSource", () => {
    /** A scoped answer names its scope and its variable name. */
    it("should name the scope and the environment name", () => {
        expect(describeSource({ rung: "shared", envName: "SOUS_VAR_X", file: "shared" })).toBe("the shared scope name SOUS_VAR_X, from the .env file");
    });

    /** The bare rung's label already ends in the word "name", so it must not be followed by a second one. */
    it("should not repeat the word name for the declared name", () => {
        expect(describeSource({ rung: "bare", envName: "MEMORY_ROOT", file: "shared" })).toBe("the declared name MEMORY_ROOT, from the .env file");
    });
});
