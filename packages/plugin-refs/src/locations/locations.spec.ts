import { ConfigError } from "@sous-io/plugin-api";
import { beforeAll, describe, expect, it } from "vitest";
import { buildRefs, gitlabHost, type Refs } from "../../test/fixtures.js";
import { readingsAfterRepository, splitRepoUrl } from "./host-helpers.js";
import { identitySegments, repositoryIdentity, sameRepositoryIdentity, shortNameFromIdentity } from "./identity.js";

let refs: Refs;

beforeAll(async () => {
    refs = await buildRefs();
});

describe("repositoryIdentity()", () => {
    /**
     * An identity is the host and the path, lowercased.
     *
     * repositoryIdentity({ host: "GitHub.com", owner: "Sous-IO", name: "sous-recipes" }) // -> "github.com/sous-io/sous-recipes"
     */
    it("should build a host-and-path identity", () => {
        expect(repositoryIdentity({ host: "GitHub.com", owner: "Sous-IO", name: "sous-recipes" })).toBe("github.com/sous-io/sous-recipes");
    });

    /**
     * Nested groups are kept, a `.git` suffix dropped, and a local path's leading separator collapsed.
     *
     * repositoryIdentity({ host: "localhost", owner: "/home/me/Projects", name: "my-recipes" }) // -> "localhost/home/me/projects/my-recipes"
     */
    it("should keep nested groups, drop .git and collapse a local path", () => {
        expect(repositoryIdentity({ host: "gitlab.example.com", owner: "group/subgroup", name: "project" })).toBe("gitlab.example.com/group/subgroup/project");
        expect(repositoryIdentity({ host: "github.com", owner: "owner", name: "thing.git" })).toBe("github.com/owner/thing");
        expect(repositoryIdentity({ host: "localhost", owner: "/home/me/Projects", name: "my-recipes" })).toBe("localhost/home/me/projects/my-recipes");
    });
});

describe("identitySegments(), shortNameFromIdentity() and sameRepositoryIdentity()", () => {
    /**
     * Segments are split, lowercased, and empty ones dropped.
     *
     * identitySegments("localhost//home/Me/recipes") // -> ["localhost", "home", "me", "recipes"]
     */
    it("should split, lowercase and drop empty segments", () => {
        expect(identitySegments("localhost//home/Me/recipes")).toEqual(["localhost", "home", "me", "recipes"]);
    });

    /**
     * A short name is the last segment, repaired into kebab case.
     *
     * shortNameFromIdentity("github.com/owner/2fa") // -> "repo-2fa"
     */
    it("should make a short name from the last segment", () => {
        expect(shortNameFromIdentity("github.com/sous-io/sous-recipes")).toBe("sous-recipes");
        expect(shortNameFromIdentity("github.com/owner/My_Recipes")).toBe("my-recipes");
        expect(shortNameFromIdentity("github.com/owner/2fa")).toBe("repo-2fa");
        expect(shortNameFromIdentity("github.com/owner/___")).toBe("repository");
        expect(refs.locations.shortName("github.com/o/x")).toBe("x");
        expect(sameRepositoryIdentity("github.com/o/r", "github.com/o/r")).toBe(true);
    });
});

describe("refs.locations", () => {
    /**
     * A URL's location keeps the URL as configured, which is what a person is shown.
     *
     * fromUrl("git@github.com:o/r.git") // -> { provider: "github", repoPath: "o/r", identity: "github.com/o/r", url: as written }
     */
    it("should build a location from a URL, keeping the URL as written", () => {
        expect(refs.locations.fromUrl("https://github.com/o/r.git")).toMatchObject({ provider: "github", repoPath: "o/r", identity: "github.com/o/r" });
        expect(refs.locations.fromUrl("https://github.com/o/r")!.url).toBe("https://github.com/o/r");
        expect(refs.locations.fromUrl("git@github.com:o/r.git")!.url).toBe("git@github.com:o/r.git");
        expect(refs.locations.fromUrl("https://example.com/x")).toBeUndefined();
    });

    /**
     * A host's own locator reads like its URL; a self-hosted instance is read when the provider is named.
     *
     * fromUrl("github://o/r") // -> github.com/o/r;  fromUrl("https://git.acme.io/t/r", "gitlab") // -> git.acme.io/t/r
     */
    it("should read a locator, and a URL with the provider named", () => {
        expect(refs.locations.fromUrl("github://o/r")).toMatchObject({ provider: "github", identity: "github.com/o/r", url: "github://o/r" });
        expect(refs.locations.fromUrl("https://git.acme.io/t/r")).toBeUndefined();
        expect(refs.locations.fromUrl("https://git.acme.io/t/r", "gitlab")).toMatchObject({ provider: "gitlab", identity: "git.acme.io/t/r" });
        expect(refs.locations.identity("https://git.acme.io/T/R.git", "gitlab")).toBe("git.acme.io/t/r");
    });

    /**
     * canonicalize names the hosts known when none reads a URL, and refuses a named host another plainly owns.
     *
     * canonicalize("https://example.com/x/y") // throws "Sous does not recognize the host ..."
     */
    it("should explain a URL no host reads, and a provider that contradicts the URL", () => {
        const unknown = (() => {
            try {
                refs.locations.canonicalize("https://example.com/x/y");
            } catch (error) {
                return error as ConfigError;
            }
        })();

        expect(unknown).toBeInstanceOf(ConfigError);
        expect(unknown!.message).toBe("Sous does not recognize the host in the repository URL https://example.com/x/y.");
        expect(unknown!.details[0]).toContain("Sous has these providers: github, gitlab, local.");
        expect(() => refs.locations.canonicalize("https://github.com/o/r", "gitlab")).toThrow("The gitlab provider does not handle https://github.com/o/r; the github provider does.");
        expect(() => refs.locations.canonicalize("https://github.com/o/r", "bitbucket")).toThrow(/names the provider 'bitbucket', which sous does not have/);
    });

    /**
     * The canonical form and identity come from the host that reads the URL.
     *
     * canonicalize("git@github.com:O/R.git") // -> { host: "github.com", owner: "O", name: "R", ... }
     */
    it("should canonicalize through the host, and give the identity", () => {
        const canonical = refs.locations.canonicalize("git@github.com:O/R.git");

        expect(canonical).toEqual({ host: "github.com", owner: "O", name: "R", httpsUrl: "https://github.com/O/R.git", sshUrl: "git@github.com:O/R.git" });
        expect(refs.locations.identityOf(canonical)).toBe("github.com/o/r");
        expect(refs.locations.identity("https://gitlab.com/a/b/c")).toBe("gitlab.com/a/b/c");
        expect(refs.locations.identity("/home/me/recipes")).toBe("localhost/home/me/recipes");
    });

    /**
     * locationFor builds the location of a repository a host reads, and refuses one it cannot.
     *
     * locationFor("github", "github.com", "o/r") // -> identity "github.com/o/r"
     */
    it("should build a location for a host and path", () => {
        expect(refs.locations.locationFor("github", "github.com", "o/r")).toEqual({
            provider: "github",
            host: "github.com",
            repoPath: "o/r",
            identity: "github.com/o/r",
            url: "https://github.com/o/r",
        });
        expect(() => refs.locations.locationFor("github", "github.com", "just-one")).toThrow();
        expect(() => refs.locations.locationFor("nope", "x.com", "o/r")).toThrow(/No provider 'nope'/);
    });

    /**
     * The hosts are the repository-host entities, in plugin order, found by URL or id.
     *
     * hostFor("https://gitlab.com/a/b") // -> the gitlab host
     */
    it("should list the hosts and find one by URL or id", async () => {
        expect(refs.locations.hosts().map((host) => host.id)).toEqual(["github", "gitlab", "local"]);
        expect(refs.locations.hostFor("https://gitlab.com/a/b")?.id).toBe("gitlab");
        expect(refs.locations.host("local")?.id).toBe("local");
        expect(refs.locations.hostFor("https://example.com/a/b")).toBeUndefined();

        const onlyGitlab = await buildRefs({ hosts: [gitlabHost] });

        expect(onlyGitlab.locations.hosts().map((host) => host.id)).toEqual(["gitlab"]);
    });
});

describe("host helpers", () => {
    /**
     * After a repository, `tree/` or `blob/` is also a browser path; a leading `-` is dropped.
     *
     * readingsAfterRepository("o/r", ["tree", "main", "w"]) // -> browsed "main/w", and named ["tree", "main", "w"]
     */
    it("should read the segments after a repository every way", () => {
        expect(readingsAfterRepository("o/r", ["tree", "main", "w"])).toEqual([
            { repoPath: "o/r", browsed: "main/w" },
            { repoPath: "o/r", named: ["tree", "main", "w"] },
        ]);
        expect(readingsAfterRepository("o/r", ["-", "w", "a"])).toEqual([{ repoPath: "o/r", named: ["w", "a"] }]);
    });

    /**
     * A URL is taken apart in its HTTPS, SSH and scp forms, and refused otherwise.
     *
     * splitRepoUrl("ssh://git@host.io/g/s/p.git") // -> { host: "host.io", owner: "g/s", name: "p" }
     */
    it("should take a repository URL apart", () => {
        expect(splitRepoUrl("https://GitHub.com/o/r/")).toEqual({ host: "github.com", owner: "o", name: "r" });
        expect(splitRepoUrl("ssh://git@host.io/g/s/p.git")).toEqual({ host: "host.io", owner: "g/s", name: "p" });
        expect(splitRepoUrl("git@github.com:o/r.git")).toEqual({ host: "github.com", owner: "o", name: "r" });
        expect(splitRepoUrl("https://github.com/only")).toBeUndefined();
        expect(splitRepoUrl("not a url")).toBeUndefined();
        expect(splitRepoUrl("")).toBeUndefined();
    });
});
