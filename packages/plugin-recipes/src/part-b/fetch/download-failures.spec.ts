import { ConfigError } from "@sous-io/plugin-api";
import { describe, expect, it } from "vitest";
import type { RecipeDownloadAttempt } from "../../types.js";
import { describeFailures, downloadFailureError } from "./download-failures.js";

/** A download error as `fetchRecipeTree` throws it: git's reason per URL, and the attempts. */
function downloadError(attempts: RecipeDownloadAttempt[]): Error {
    return Object.assign(new ConfigError("Could not fetch 'recipes/acme/widget' at the tag 'acme/widget@0.1.0'.", { details: attempts.map((one) => `${one.url}: ${one.reason}`) }), {
        attempts,
    });
}

const NO_CREDENTIALS: RecipeDownloadAttempt[] = [
    { url: "https://gitlab.com/acme/recipes.git", host: "gitlab.com", problem: "credentials", reason: "could not read Username for 'https://gitlab.com': terminal prompts disabled" },
    { url: "git@gitlab.com:acme/recipes.git", host: "gitlab.com", problem: "credentials", reason: "git@gitlab.com: Permission denied (publickey)" },
];

describe("describeFailures()", () => {
    /**
     * Each recipe keeps git's reason for each URL, and the fix names the host git had no
     * credentials for, without any advice about the network.
     *
     * describeFailures([{ key: "acme/widget", error: noCredentials }])
     * // lines: ["acme/widget: Could not fetch …", "  https://gitlab.com/…: could not read Username …", "  git@gitlab.com:…: … (publickey)"]
     * // fixes: ["Git has no credentials for gitlab.com. …"]
     */
    it("should keep git's reason per URL and suggest git access to the host, not the network", () => {
        const { lines, fixes } = describeFailures([{ key: "acme/widget", error: downloadError(NO_CREDENTIALS) }]);

        expect(lines).toEqual([
            "acme/widget: Could not fetch 'recipes/acme/widget' at the tag 'acme/widget@0.1.0'.",
            "  https://gitlab.com/acme/recipes.git: could not read Username for 'https://gitlab.com': terminal prompts disabled",
            "  git@gitlab.com:acme/recipes.git: git@gitlab.com: Permission denied (publickey)",
        ]);
        expect(fixes).toEqual(["Git has no credentials for gitlab.com. Set up git access to it (a credential helper or an SSH key), then run the command again."]);
    });

    /**
     * Without git, the one fix is to install it; every other line would follow from the same cause.
     *
     * // fixes: ["Sous needs git to download recipes, and git was not found on PATH. …"]
     */
    it("should say git was not found on PATH when git is missing", () => {
        const missing: RecipeDownloadAttempt = { url: "https://gitlab.com/acme/recipes.git", host: "gitlab.com", problem: "git-missing", reason: "git is not installed, or is not on your PATH" };
        const { fixes } = describeFailures([{ key: "acme/widget", error: downloadError([missing]) }]);

        expect(fixes).toEqual(["Sous needs git to download recipes, and git was not found on PATH. Install git, then run the command again."]);
    });

    /**
     * The network is mentioned only when git could not reach a host, and a missing tag gets its own fix.
     *
     * // network -> "Git could not reach gitlab.com. Check the network, …"
     * // missing tag -> "A tag the lockfile pins is not on its repository: …"
     */
    it("should suggest checking the network only when a host could not be reached, and explain a missing tag", () => {
        const offline: RecipeDownloadAttempt = { url: "https://gitlab.com/acme/recipes.git", host: "gitlab.com", problem: "network", reason: "Could not resolve host: gitlab.com" };
        const untagged: RecipeDownloadAttempt = { url: "https://gitlab.com/acme/recipes.git", host: "gitlab.com", problem: "missing-tag", reason: "Remote branch acme/gadget@1.0.0 not found in upstream origin" };

        expect(describeFailures([{ key: "acme/widget", error: downloadError([offline]) }]).fixes).toEqual(["Git could not reach gitlab.com. Check the network, then run the command again."]);
        expect(describeFailures([{ key: "acme/gadget", error: downloadError([untagged]) }]).fixes[0]).toMatch(/^A tag the lockfile pins is not on its repository/);
    });

    /**
     * A failure that is not a download keeps its own hint, and gets no network advice.
     *
     * restore's "that repository's index does not offer it" with its hint
     * // lines keep "Either the index could not be fetched, or the version was withdrawn upstream. …"; fixes: []
     */
    it("should keep the hint a failure carries and add no network advice to it", () => {
        const withdrawn = new ConfigError("The lockfile pins 'acme/widget' at version 0.1.2 from 'recipes', and that repository's index does not offer it.", {
            details: ["Either the index could not be fetched, or the version was withdrawn upstream. Run 'sous repo list' to see what sous has."],
        });
        const { lines, fixes } = describeFailures([{ key: "acme/widget", error: withdrawn }]);

        expect(lines[1]).toBe("  Either the index could not be fetched, or the version was withdrawn upstream. Run 'sous repo list' to see what sous has.");
        expect(fixes).toEqual([]);
    });
});

describe("downloadFailureError()", () => {
    /**
     * The error names how many recipes failed, then lists each with its reasons, then the fixes.
     *
     * downloadFailureError([widget, gadget]).message
     * // -> "Sous could not download 2 recipes this project's subscriptions need."
     */
    it("should count the recipes and end its details with the fixes", () => {
        const error = downloadFailureError([
            { key: "acme/widget", error: downloadError(NO_CREDENTIALS) },
            { key: "acme/gadget", error: downloadError(NO_CREDENTIALS) },
        ]);

        expect(error.message).toBe("Sous could not download 2 recipes this project's subscriptions need.");
        // One fix for the one host, however many recipes failed on it.
        expect(error.details.filter((line) => line.startsWith("Git has no credentials"))).toHaveLength(1);
        expect(error.details.at(-1)).toMatch(/^Git has no credentials for gitlab\.com/);
        expect(error.details.join("\n")).not.toMatch(/Check the network/);
    });
});
