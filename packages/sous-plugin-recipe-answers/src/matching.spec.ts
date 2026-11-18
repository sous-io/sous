import { describe, expect, it } from "vitest";
import { ladder, variable } from "../test/stand-ins.js";
import { matchName, matchVariables, narrowTo } from "./matching.js";

const apiUrl = variable();
const taskRoot = variable({ name: "taskRoot" }, { namespace: "workflow", name: "task-files" });
const otherRepo = variable({}, { repo: "acme", namespace: "acme", name: "web" });
const pool = [apiUrl, taskRoot, otherRepo];

describe("matchName()", () => {
    /**
     * It should match exactly, then ignoring case, and read globs.
     *
     * matchName("Workflow", "workflow"); // -> "folded"
     * matchName("work*", "workflow");    // -> "exact"
     */
    it("should match exactly, folded, and by glob", () => {
        expect(matchName("workflow", "workflow")).toBe("exact");
        expect(matchName("Workflow", "workflow")).toBe("folded");
        expect(matchName("work*", "workflow")).toBe("exact");
        expect(matchName("WORK*", "workflow")).toBe("folded");
        expect(matchName("{misc,workflow}", "misc")).toBe("exact");
        expect(matchName("t?sk", "task")).toBe("exact");
        expect(matchName("other", "workflow")).toBeUndefined();
    });
});

describe("matchVariables()", () => {
    /** A bare variable name should match every variable of that name. */
    it("should match a variable by name and by qualified name", () => {
        expect(matchVariables(pool, { kind: "variable", name: "apiUrl" }).map((match) => match.ref)).toEqual([otherRepo.ref, apiUrl.ref]);
        expect(
            matchVariables(pool, { kind: "variable", name: "apiUrl", recipe: { kind: "recipe", name: "stuff", namespace: { kind: "namespace", name: "misc" } } }).map((match) => match.ref),
        ).toEqual([apiUrl.ref]);
        expect(matchVariables(pool, { kind: "variable", name: "apiUrl", repo: { kind: "repo", name: "acme" } }).map((match) => match.ref)).toEqual([otherRepo.ref]);
    });

    /** Repositories, namespaces and recipes that publish variables should match once each. */
    it("should match the repositories, namespaces and recipes that publish them", () => {
        expect(matchVariables(pool, { kind: "repo", name: "sous-recipes" })).toEqual([{ ref: { kind: "repo", name: "sous-recipes" }, exactSpelling: true }]);
        expect(matchVariables(pool, { kind: "namespace", name: "Workflow" })).toEqual([
            { ref: { kind: "namespace", name: "workflow", repo: { kind: "repo", name: "sous-recipes" } }, exactSpelling: false },
        ]);
        expect(matchVariables(pool, { kind: "recipe", name: "task-files" }).map((match) => match.ref)).toEqual([taskRoot.ref.recipe]);
        expect(matchVariables(pool, { kind: "namespace", name: "nothing" })).toEqual([]);
    });

    /**
     * An environment name should match, in its exact spelling, the declared name of each variable
     * and each generated name in use in the env files.
     */
    it("should match environment names that answer variables", () => {
        const subject = ladder({ shared: { SOUS_VAR_MISC_STUFF_API_URL: "x" } });

        expect(matchVariables(pool, { kind: "envVar", name: "SOUS_VAR_API_URL" }, subject)[0]?.ref).toEqual({ kind: "envVar", name: "SOUS_VAR_API_URL", variables: [apiUrl.ref, otherRepo.ref] });
        expect(matchVariables(pool, { kind: "envVar", name: "SOUS_VAR_MISC_STUFF_API_URL" }, subject)[0]?.ref).toMatchObject({ variables: [apiUrl.ref] });
        expect(matchVariables(pool, { kind: "envVar", name: "SOUS_VAR_WORKFLOW_TASK_ROOT" }, subject)).toEqual([]);
        expect(matchVariables(pool, { kind: "envVar", name: "SOUS_VAR_API_URL" })).toEqual([]);
    });
});

describe("narrowTo()", () => {
    /** A ref should narrow the pool to the variables inside what it names. */
    it("should narrow to a repository, namespace, recipe, variable or env name", () => {
        expect(narrowTo(pool, { kind: "repo", name: "acme" })).toEqual([otherRepo]);
        expect(narrowTo(pool, { kind: "namespace", name: "workflow" })).toEqual([taskRoot]);
        expect(narrowTo(pool, taskRoot.ref.recipe!)).toEqual([taskRoot]);
        expect(narrowTo(pool, apiUrl.ref)).toEqual([apiUrl]);
        expect(narrowTo(pool, { kind: "envVar", name: "X", variables: [otherRepo.ref] })).toEqual([otherRepo]);
    });
});
