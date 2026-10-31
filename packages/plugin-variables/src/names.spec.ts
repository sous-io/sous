import { describe, expect, it } from "vitest";
import { bareName, ENV_PREFIX, namespaceScopedName, recipeScopedName, sharedName, toUpperSnake, variablesNames } from "./names.js";

describe("toUpperSnake()", () => {
    /**
     * toUpperSnake("apiBaseUrl");  // "API_BASE_URL"
     */
    it("should convert camelCase to upper snake case", () => {
        expect(toUpperSnake("apiBaseUrl")).toBe("API_BASE_URL");
    });

    /**
     * toUpperSnake("automated-browser-tasks");  // "AUTOMATED_BROWSER_TASKS"
     */
    it("should turn hyphens into underscores", () => {
        expect(toUpperSnake("automated-browser-tasks")).toBe("AUTOMATED_BROWSER_TASKS");
    });

    /**
     * toUpperSnake("githubAPIToken");  // "GITHUB_API_TOKEN"
     */
    it("should split an acronym from the word that follows it", () => {
        expect(toUpperSnake("githubAPIToken")).toBe("GITHUB_API_TOKEN");
    });
});

describe("sharedName()", () => {
    /**
     * sharedName("apiUrl");  // "SOUS_VAR_API_URL"
     */
    it("should prefix the upper snake case name", () => {
        expect(sharedName("apiUrl")).toBe(`${ENV_PREFIX}API_URL`);
        expect(variablesNames.sharedName("branchPattern")).toBe("SOUS_VAR_BRANCH_PATTERN");
    });
});

describe("recipeScopedName() and namespaceScopedName()", () => {
    /**
     * recipeScopedName("misc", "stuff", "apiUrl");  // "SOUS_VAR_MISC_STUFF_API_URL"
     */
    it("should name the namespace, the recipe and the variable", () => {
        expect(recipeScopedName("misc", "stuff", "apiUrl")).toBe("SOUS_VAR_MISC_STUFF_API_URL");
        expect(recipeScopedName("workflow", "task-files", "branchPattern")).toBe("SOUS_VAR_WORKFLOW_TASK_FILES_BRANCH_PATTERN");
    });

    /**
     * namespaceScopedName("misc", "apiUrl");  // "SOUS_VAR_MISC_API_URL"
     */
    it("should name the namespace and the variable", () => {
        expect(namespaceScopedName("misc", "apiUrl")).toBe("SOUS_VAR_MISC_API_URL");
    });
});

describe("bareName()", () => {
    /** The definition's own `env` wins, so a recipe can bind GITHUB_TOKEN. */
    it("should use the declared env name when there is one", () => {
        expect(bareName({ name: "token", env: "GITHUB_TOKEN" })).toBe("GITHUB_TOKEN");
    });

    /** Otherwise the shared name. */
    it("should fall back to the shared form", () => {
        expect(bareName({ name: "apiUrl" })).toBe("SOUS_VAR_API_URL");
    });
});

describe("the variables.names service", () => {
    /** Variable names are camelCase; env names upper snake case. */
    it("should tell well-formed variable and environment names", () => {
        expect(variablesNames.envPrefix).toBe("SOUS_VAR_");
        expect(variablesNames.isVariableName("branchPattern")).toBe(true);
        expect(variablesNames.isVariableName("BranchPattern")).toBe(false);
        expect(variablesNames.isVariableName("branch-pattern")).toBe(false);
        expect(variablesNames.isEnvName("SOUS_VAR_X")).toBe(true);
        expect(variablesNames.isEnvName("sous_var_x")).toBe(false);
        expect(variablesNames.isEnvName("1X")).toBe(false);
    });
});
