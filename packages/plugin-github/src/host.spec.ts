import { describe, expect, it } from "vitest";
import type { ExplainedTokenSource } from "@sous-io/repository-hosts";
import { fakeGit, fakeProcesses, firstToken, hostContext, readWith, recordedHttp, type RecordedRoute } from "@sous-io/repository-hosts/testing";
import { createGithubHost, githubApiFileUrl, githubRawFileUrl, readGithubLocation } from "./host.js";

const host = createGithubHost();
const repository = host.canonicalize("https://github.com/sous-io/sous-recipes");
const request = { repository, path: "sous.index.json", ref: "HEAD" };
const API = "https://api.github.com/repos/sous-io/sous-recipes/contents/sous.index.json?ref=HEAD";
const RAW = "https://raw.githubusercontent.com/sous-io/sous-recipes/HEAD/sous.index.json";
const INDEX = '{"formatVersion":1}';

function ctxFor(options: { routes?: Record<string, RecordedRoute>; env?: Record<string, string>; installed?: string[]; ghToken?: string; gitText?: string }) {
    const http = recordedHttp(options.routes ?? {});
    const processes = fakeProcesses({ installed: options.installed ?? [], answer: () => ({ stdout: options.ghToken ?? "" }) });
    const git = fakeGit({
        runAnswer: () => ({ exitCode: 128 }),
        readRemoteFile: async () => {
            if (options.gitText === undefined) {
                throw new Error("git@github.com: Permission denied (publickey).");
            }

            return options.gitText;
        },
    });

    return { http, processes, ctx: hostContext({ services: { "host.http": http, "host.processes": processes, "git.runner": git }, env: options.env ?? {} }) };
}

describe("the github host's addresses", () => {
    /**
     * With a token, the contents API is asked; without, the raw host; GitHub Enterprise uses its own.
     *
     * githubApiFileUrl(request) // -> "https://api.github.com/repos/sous-io/sous-recipes/contents/sous.index.json?ref=HEAD"
     * githubRawFileUrl(request) // -> "https://raw.githubusercontent.com/sous-io/sous-recipes/HEAD/sous.index.json"
     */
    it("should build the API and raw addresses, for github.com and Enterprise", () => {
        expect(githubApiFileUrl(request)).toBe(API);
        expect(githubRawFileUrl(request)).toBe(RAW);

        const enterprise = { ...request, repository: { ...repository, host: "ghe.example.com" } };

        expect(githubApiFileUrl(enterprise)).toBe("https://ghe.example.com/api/v3/repos/sous-io/sous-recipes/contents/sous.index.json?ref=HEAD");
        expect(githubRawFileUrl(enterprise)).toBe("https://ghe.example.com/sous-io/sous-recipes/raw/HEAD/sous.index.json");
    });
});

describe("the github host", () => {
    /**
     * It matches github.com URLs, and the Enterprise hosts the options name.
     *
     * host.matches("git@github.com:o/r.git"); // -> true
     */
    it("should match github.com URLs and the hosts the options name", () => {
        expect(host.matches("https://github.com/o/r")).toBe(true);
        expect(host.matches("git@github.com:o/r.git")).toBe(true);
        expect(host.matches("https://gitlab.com/o/r")).toBe(false);
        expect(host.matches("https://ghe.example.com/o/r")).toBe(false);
        expect(createGithubHost({ hosts: ["ghe.example.com"] }).matches("https://ghe.example.com/o/r")).toBe(true);
    });

    /**
     * canonicalize builds both clone URLs, and refuses a URL naming no repository.
     *
     * host.canonicalize("git@github.com:o/r.git").httpsUrl; // -> "https://github.com/o/r.git"
     */
    it("should canonicalize a repository URL", () => {
        expect(host.canonicalize("git@github.com:o/r.git")).toEqual({
            host: "github.com",
            owner: "o",
            name: "r",
            httpsUrl: "https://github.com/o/r.git",
            sshUrl: "git@github.com:o/r.git",
        });
        expect(() => host.canonicalize("https://github.com")).toThrow("is not a github repository URL");
    });

    /**
     * It registers the strategies and token sources in S4's order.
     *
     * host.tokenSources.map((s) => s.id); // -> ["env", "git-credential", "gh"]
     */
    it("should register the read strategies and token sources in order", () => {
        expect(host.readStrategies.map((strategy) => strategy.id)).toEqual(["http-token", "http", "git"]);
        expect(host.tokenSources?.map((source) => source.id)).toEqual(["env", "git-credential", "gh"]);
        expect(host.proposalNoun).toBe("pull request");
    });
});

describe("reading through the github host", () => {
    /**
     * GITHUB_TOKEN is sent as a bearer token to the contents API, asking for the raw file.
     *
     * GET <API> Authorization: Bearer ghp_x, Accept: application/vnd.github.raw+json -> 200
     */
    it("should send GITHUB_TOKEN as a bearer token to the contents API", async () => {
        const { http, ctx } = ctxFor({ env: { GITHUB_TOKEN: "ghp_x" }, routes: { [API]: { status: 200, headers: { etag: '"e"' }, body: INDEX } } });
        const token = await firstToken(host, repository, ctx);

        expect(token).toEqual({ value: "ghp_x", source: "GITHUB_TOKEN" });
        expect(await readWith(host, "http-token", { ...request, token: token! }, ctx)).toEqual({ ok: true, text: INDEX, ref: "HEAD", etag: '"e"' });
        expect(http.requests[0]?.headers).toMatchObject({ Authorization: "Bearer ghp_x", Accept: "application/vnd.github.raw+json" });
    });

    /**
     * GH_TOKEN works too, and `gh auth token --hostname <host>` when gh is installed.
     *
     * // no variables, gh prints "gho_y" -> { value: "gho_y", source: "gh" }
     */
    it("should fall back to GH_TOKEN, then gh auth token", async () => {
        expect(await firstToken(host, repository, ctxFor({ env: { GH_TOKEN: "gho_env" } }).ctx)).toEqual({ value: "gho_env", source: "GH_TOKEN" });

        const viaGh = ctxFor({ installed: ["gh"], ghToken: "gho_y\n" });

        expect(await firstToken(host, repository, viaGh.ctx)).toEqual({ value: "gho_y", source: "gh" });
        expect(viaGh.processes.runs[0]?.args).toEqual(["auth", "token", "--hostname", "github.com"]);
        expect(await firstToken(host, repository, ctxFor({ installed: ["gh"], ghToken: "You are not logged into any GitHub hosts.\n" }).ctx)).toBeUndefined();
    });

    /**
     * Without a token, the raw host is read with no authorization.
     *
     * // one request, to <RAW>, with no Authorization header
     */
    it("should read the raw host with no authorization", async () => {
        const { http, ctx } = ctxFor({ routes: { [RAW]: { status: 200, body: INDEX } } });

        expect(await readWith(host, "http", request, ctx)).toMatchObject({ ok: true, text: INDEX });
        expect(http.requests.map((sent) => sent.url)).toEqual([RAW]);
        expect(http.requests[0]?.headers?.["Authorization"]).toBeUndefined();
    });

    /**
     * Each strategy's reason is the line S4's combined error shows, and the fixes are GitHub's.
     *
     * HTTP without token   404: no sous.index.json at HEAD, or the repository is private
     * git                  Permission denied (publickey)
     * export GITHUB_TOKEN=<a token that can read the repository>
     */
    it("should give reasons and fixes when a private repository cannot be read", async () => {
        const { ctx } = ctxFor({ routes: { [RAW]: { status: 404, statusText: "Not Found" } } });
        const env = host.tokenSources![0] as ExplainedTokenSource;

        expect(await env.find(repository, ctx)).toEqual({ missing: "GITHUB_TOKEN and GH_TOKEN unset" });
        expect(env.fix?.(repository)).toBe("export GITHUB_TOKEN=<a token that can read the repository>");
        expect(await readWith(host, "http", request, ctx)).toEqual({ ok: false, reason: "404: no sous.index.json at HEAD, or the repository is private" });
        expect(await readWith(host, "git", request, ctx)).toEqual({ ok: false, reason: "Permission denied (publickey)" });
    });

    /**
     * git reads a private repository with the user's own SSH key.
     *
     * // git -> the index
     */
    it("should read through git", async () => {
        expect(await readWith(host, "git", request, ctxFor({ gitText: INDEX }).ctx)).toEqual({ ok: true, text: INDEX, ref: "HEAD" });
    });
});

describe("readGithubLocation()", () => {
    /**
     * The first two segments are the repository.
     *
     * readGithubLocation({ segments: ["o", "r.git", "workflow", "alpha"] }); // -> [{ repoPath: "o/r", named: ["workflow", "alpha"] }]
     */
    it("should read the first two segments as the repository", () => {
        expect(readGithubLocation({ host: "github.com", segments: ["o", "r.git", "workflow", "alpha"] })).toEqual([{ repoPath: "o/r", named: ["workflow", "alpha"] }]);
    });

    /**
     * A browser path after `tree/` is a reading too.
     *
     * readGithubLocation({ segments: ["o", "r", "tree", "main", "recipes"] }); // -> browsed "main/recipes", and named
     */
    it("should read a browser path", () => {
        expect(readGithubLocation({ host: "github.com", segments: ["o", "r", "tree", "main", "recipes"] })).toEqual([
            { repoPath: "o/r", browsed: "main/recipes" },
            { repoPath: "o/r", named: ["tree", "main", "recipes"] },
        ]);
    });

    /**
     * A single segment names no repository.
     *
     * readGithubLocation({ segments: ["o"] }); // -> []
     */
    it("should read nothing from a single segment, and format a canonical locator", () => {
        expect(readGithubLocation({ host: "github.com", segments: ["o"] })).toEqual([]);
        expect(host.formatLocator("github.com", "o/r", "workflow/alpha")).toBe("github://o/r/workflow/alpha");
        expect(host.formatLocator("ghe.example.com", "o/r", "")).toBe("github://ghe.example.com/o/r");
    });
});
