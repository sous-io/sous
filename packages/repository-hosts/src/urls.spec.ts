import { describe, expect, it } from "vitest";
import {
    canonicalRepository,
    formatHostedLocator,
    invalidRepoUrl,
    normalizeRepoUrl,
    readingsAfterRepository,
    splitRepoUrl,
    withoutGitSuffix,
} from "./urls.js";

describe("normalizeRepoUrl()", () => {
    /**
     * normalizeRepoUrl drops surrounding whitespace, trailing slashes and a `.git` suffix.
     *
     * normalizeRepoUrl(" https://github.com/o/r.git/ "); // -> "https://github.com/o/r"
     */
    it("should drop surrounding whitespace, trailing slashes and a .git suffix", () => {
        expect(normalizeRepoUrl(" https://github.com/o/r.git/ ")).toBe("https://github.com/o/r");
        expect(normalizeRepoUrl("https://github.com/o/r//")).toBe("https://github.com/o/r");
    });
});

describe("splitRepoUrl()", () => {
    /**
     * splitRepoUrl takes the HTTPS, scp-style and ssh:// forms apart alike.
     *
     * splitRepoUrl("git@github.com:o/r.git"); // -> { host: "github.com", owner: "o", name: "r" }
     */
    it("should take apart the HTTPS, scp-style and ssh:// forms alike", () => {
        const expected = { host: "github.com", owner: "o", name: "r" };

        expect(splitRepoUrl("https://github.com/o/r")).toEqual(expected);
        expect(splitRepoUrl("https://GitHub.com/o/r.git")).toEqual(expected);
        expect(splitRepoUrl("git@github.com:o/r.git")).toEqual(expected);
        expect(splitRepoUrl("ssh://git@github.com/o/r")).toEqual(expected);
    });

    /**
     * Every segment before the last is the owner, so a nested GitLab group stays whole.
     *
     * splitRepoUrl("https://gitlab.com/acme/platform/recipes"); // -> owner "acme/platform"
     */
    it("should treat every segment before the last as the owner", () => {
        expect(splitRepoUrl("https://gitlab.com/acme/platform/recipes")).toEqual({ host: "gitlab.com", owner: "acme/platform", name: "recipes" });
    });

    /**
     * A URL naming no repository gives undefined.
     *
     * splitRepoUrl("https://github.com/only-owner"); // -> undefined
     */
    it("should return undefined for a URL that names no repository", () => {
        expect(splitRepoUrl("https://github.com/only-owner")).toBeUndefined();
        expect(splitRepoUrl("")).toBeUndefined();
        expect(splitRepoUrl("not a url")).toBeUndefined();
    });
});

describe("canonicalRepository()", () => {
    /**
     * canonicalRepository builds the HTTPS and SSH clone URLs.
     *
     * canonicalRepository("github.com", "o", "r").sshUrl; // -> "git@github.com:o/r.git"
     */
    it("should build the HTTPS and SSH clone URLs", () => {
        expect(canonicalRepository("github.com", "o", "r")).toEqual({
            host: "github.com",
            owner: "o",
            name: "r",
            httpsUrl: "https://github.com/o/r.git",
            sshUrl: "git@github.com:o/r.git",
        });
    });
});

describe("readingsAfterRepository()", () => {
    /**
     * After `tree/` or `blob/` there are two readings: a browser path and plain names.
     *
     * readingsAfterRepository("o/r", ["tree", "main", "x"]);
     * // -> [{ browsed: "main/x" }, { named: ["tree", "main", "x"] }]
     */
    it("should return a browsed and a named reading after tree or blob", () => {
        expect(readingsAfterRepository("o/r", ["tree", "main", "recipes", "workflow"])).toEqual([
            { repoPath: "o/r", browsed: "main/recipes/workflow" },
            { repoPath: "o/r", named: ["tree", "main", "recipes", "workflow"] },
        ]);
    });

    /**
     * Otherwise there is one named reading, a leading `-` dropped.
     *
     * readingsAfterRepository("g/p", ["-", "workflow"]); // -> [{ named: ["workflow"] }]
     */
    it("should return one named reading otherwise, dropping a leading separator", () => {
        expect(readingsAfterRepository("g/p", ["-", "workflow"])).toEqual([{ repoPath: "g/p", named: ["workflow"] }]);
    });
});

describe("withoutGitSuffix()", () => {
    /**
     * withoutGitSuffix("r.git"); // -> "r"
     */
    it("should drop a .git suffix", () => {
        expect(withoutGitSuffix("r.git")).toBe("r");
        expect(withoutGitSuffix("r")).toBe("r");
    });
});

describe("formatHostedLocator()", () => {
    /**
     * The default host is left out; any other host is kept.
     *
     * formatHostedLocator("github", "github.com", "github.com", "o/r", "w/a"); // -> "github://o/r/w/a"
     */
    it("should leave out the default host and keep any other", () => {
        expect(formatHostedLocator("github", "github.com", "github.com", "o/r", "w/a")).toBe("github://o/r/w/a");
        expect(formatHostedLocator("github", "github.com", "ghe.example.com", "o/r", "")).toBe("github://ghe.example.com/o/r");
        expect(formatHostedLocator("gitlab", "gitlab.com", "gitlab.com", "g/p", "w", "/-/")).toBe("gitlab://g/p/-/w");
    });
});

describe("invalidRepoUrl()", () => {
    /**
     * The error names the URL and shows an example.
     *
     * invalidRepoUrl("github", "x", "github.com").message; // -> "'x' is not a github repository URL that sous can read."
     */
    it("should name the URL and give an example", () => {
        const error = invalidRepoUrl("github", "x", "github.com");

        expect(error.message).toBe("'x' is not a github repository URL that sous can read.");
        expect(error.details[0]).toContain("https://github.com/owner/repository");
    });
});
