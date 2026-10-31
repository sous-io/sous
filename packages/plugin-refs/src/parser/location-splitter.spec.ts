import { beforeAll, describe, expect, it } from "vitest";
import { buildRefs, githubHost, stateOf, type Refs } from "../../test/fixtures.js";
import { locationSplitter, looksLikeLocation } from "./location-splitter.js";

let refs: Refs;

beforeAll(async () => {
    refs = await buildRefs();
});

/** Splits with the location splitter in the test build. */
const split = (state: ReturnType<typeof stateOf>) => locationSplitter.split(state, refs.ctx);

describe("looksLikeLocation()", () => {
    /**
     * A location carries a scheme, an SSH `user@host:` prefix, or a dotted first segment.
     *
     * looksLikeLocation("github.com/o/r") // -> true
     */
    it("should tell a location from a short ref", () => {
        expect(looksLikeLocation("https://github.com/o/r")).toBe(true);
        expect(looksLikeLocation("git@github.com:o/r")).toBe(true);
        expect(looksLikeLocation("github.com/o/r")).toBe(true);
        expect(looksLikeLocation("repo:workflow/alpha@^1.0")).toBe(false);
        expect(looksLikeLocation("workflow/task-files.taskFileRoot")).toBe(false);
    });
});

describe("the location splitter", () => {
    /**
     * A GitHub URL becomes a repository, the names after it left to read.
     *
     * split("https://github.com/o/r/workflow/alpha") // -> rest "workflow/alpha", repo at github.com/o/r
     */
    it("should read the repository and leave the names unread", () => {
        const named = split(stateOf("https://github.com/o/r/workflow/alpha")).find((state) => state.rest === "workflow/alpha");

        expect(named?.repo?.location).toMatchObject({ provider: "github", repoPath: "o/r", identity: "github.com/o/r" });
    });

    /**
     * A browser URL becomes a finished repository ref holding the browsed path and its range.
     *
     * split("https://github.com/o/r/tree/main/recipes/w/a", range "^1") // -> browsed "main/recipes/w/a"
     */
    it("should finish a browser URL as a browsed repository", () => {
        const browsed = split(stateOf("https://github.com/o/r/tree/main/recipes/w/a", { range: "^1" })).find((state) => state.ref?.kind === "repo");

        expect(browsed?.ref).toMatchObject({ browsed: "main/recipes/w/a", range: "^1" });
    });

    /**
     * A GitLab URL with nested groups reads every way the host reads it.
     *
     * split("gitlab.com/a/b/c/d") // -> project a/b naming c/d, project a/b/c naming d
     */
    it("should return every reading a host gives", () => {
        expect(split(stateOf("gitlab.com/a/b/c/d")).map((state) => `${state.repo?.location?.repoPath} ${state.rest}`)).toEqual(["a/b c/d", "a/b/c d"]);
    });

    /**
     * A location naming only a repository finishes as a repository ref; a range there is turned down.
     *
     * split("git@github.com:o/r.git") // -> a finished repo ref
     */
    it("should finish a bare repository, and refuse a range on it", () => {
        expect(split(stateOf("git@github.com:o/r.git"))[0]?.ref).toMatchObject({ kind: "repo", location: { repoPath: "o/r" } });

        const ranged = stateOf("git@github.com:o/r.git", { range: "^1" });

        expect(split(ranged)).toEqual([]);
        expect(ranged.problems[0]).toContain("applies to a recipe, not to a repository");
    });

    /**
     * A repository on this machine becomes a finished ref with the `local` provider, for a pruner to refuse.
     *
     * split("file:///x/y") // -> a finished repo ref, provider "local"
     */
    it("should read a local location as a local repository", () => {
        expect(split(stateOf("file:///x/y/workflow/alpha"))[0]?.ref).toMatchObject({ kind: "repo", location: { provider: "local" } });
    });

    /**
     * An unknown scheme, an unknown host and an unreadable URL are turned down with a reason.
     *
     * split("bitbucket://o/r/w") // -> [] and "sous has these: github, gitlab"
     */
    it("should turn down an unknown scheme, host and unreadable URL", () => {
        const scheme = stateOf("bitbucket://o/r/w");

        expect(split(scheme)).toEqual([]);
        expect(scheme.problems[0]).toContain("sous has these: github, gitlab");

        const host = stateOf("https://git.example.com/o/r/w");

        expect(split(host)).toEqual([]);
        expect(host.problems[0]).toContain("://git.example.com/owner/repository/namespace/recipe");

        const broken = stateOf("https://");

        expect(split(broken)).toEqual([]);
        expect(broken.problems[0]).toContain("could not be read");
    });

    /**
     * A self-hosted instance is read with the host's scheme and the host name.
     *
     * split("gitlab://git.acme.io/team/recipes/-/workflow") // -> project team/recipes on git.acme.io
     */
    it("should read a scheme locator naming a self-hosted host", () => {
        const [out] = split(stateOf("gitlab://git.acme.io/team/recipes/-/workflow"));

        expect(out).toMatchObject({ rest: "workflow", repo: { location: { host: "git.acme.io", repoPath: "team/recipes", provider: "gitlab" } } });
    });

    /**
     * A host that reads no repository from the segments leaves a reason.
     *
     * split("github.com/onlyowner/") // -> [] with a reason
     */
    it("should explain when a host reads no repository", () => {
        const state = stateOf("github.com/onlyowner/");

        expect(split(state)).toEqual([]);
        expect(state.problems.length).toBeGreaterThan(0);
    });

    /**
     * Text that is not a location passes through.
     *
     * split("workflow/alpha") // -> the same state
     */
    it("should pass a short ref through unchanged", () => {
        const state = stateOf("workflow/alpha");

        expect(split(state)).toEqual([state]);
    });

    /**
     * With no hosts at all (no host plugin loaded), a location is refused with a reason, never a crash.
     *
     * split("https://github.com/o/r/w") with no hosts // -> [] and "does not recognize the host"
     */
    it("should refuse every hosted location when no host is loaded", async () => {
        const bare = await buildRefs({ hosts: [] });
        const state = stateOf("https://github.com/o/r/w");

        expect(locationSplitter.split(state, bare.ctx)).toEqual([]);
        expect(state.problems[0]).toContain("does not recognize the host 'github.com'");
    });

    /**
     * A host read by entity: a plugin's own host works like a built-in one (rule 5).
     *
     * split("codeberg://o/r/w") with a codeberg host // -> repository o/r on codeberg.org
     */
    it("should read a location through any host a plugin adds", async () => {
        const codeberg = {
            ...githubHost,
            id: "codeberg",
            defaultHost: "codeberg.org",
            matches: (url: string) => url.includes("codeberg.org"),
        };
        const custom = await buildRefs({ hosts: [codeberg] });
        const [out] = locationSplitter.split(stateOf("codeberg://o/r/w"), custom.ctx);

        expect(out?.repo?.location).toMatchObject({ provider: "codeberg", host: "codeberg.org", repoPath: "o/r", identity: "codeberg.org/o/r" });
    });
});
