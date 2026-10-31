import { describe, expect, it } from "vitest";
import type { ExplainedReadStrategy, ExplainedTokenSource } from "@sous-io/repository-hosts";
import { fakeGit, fakeProcesses, firstToken, hostContext, readWith, recordedHttp, type RecordedRoute } from "@sous-io/repository-hosts/testing";
import { createGitlabHost, gitlabFileUrl, readGitlabLocation } from "./host.js";

const host = createGitlabHost();
const repository = host.canonicalize("https://gitlab.com/acme/private-recipes.git");
const request = { repository, path: "sous.index.json", ref: "HEAD" };
const API = "https://gitlab.com/api/v4/projects/acme%2Fprivate-recipes/repository/files/sous.index.json/raw?ref=HEAD";
const INDEX = '{"formatVersion":1,"namespaces":{}}';

/** A context over recorded HTTP, scripted processes and git. */
function ctxFor(options: {
    routes?: Record<string, RecordedRoute>;
    env?: Record<string, string>;
    installed?: string[];
    processAnswer?: (command: string, args: readonly string[]) => { exitCode?: number; stdout?: string };
    gitRead?: (url: string) => string;
    credential?: string;
}) {
    const http = recordedHttp(options.routes ?? {});
    const processes = fakeProcesses({ installed: options.installed ?? [], ...(options.processAnswer === undefined ? {} : { answer: options.processAnswer }) });
    const git = fakeGit({
        runAnswer: () => (options.credential === undefined ? { exitCode: 128, stderr: "terminal prompts disabled" } : { exitCode: 0, stdout: `password=${options.credential}` }),
        readRemoteFile: async (url) => {
            if (options.gitRead === undefined) {
                throw new Error(url.startsWith("git@") ? "git@gitlab.com: Permission denied (publickey)." : "fatal: could not read Username for 'https://gitlab.com': terminal prompts disabled");
            }

            return options.gitRead(url);
        },
    });

    return { http, processes, git, ctx: hostContext({ services: { "host.http": http, "host.processes": processes, "git.runner": git }, env: options.env ?? {} }) };
}

describe("gitlabFileUrl()", () => {
    /**
     * Files are read from the API address, the whole project path encoded, so a nested group's `/`
     * becomes `%2F`.
     *
     * gitlabFileUrl({ repository: acme/platform/recipes, path: "sous.index.json", ref: "HEAD" });
     * // -> "https://gitlab.com/api/v4/projects/acme%2Fplatform%2Frecipes/repository/files/sous.index.json/raw?ref=HEAD"
     */
    it("should use the API address with the project path encoded", () => {
        const nested = host.canonicalize("git@gitlab.com:acme/platform/recipes.git");

        expect(gitlabFileUrl({ repository: nested, path: "sous.index.json", ref: "HEAD" })).toBe(
            "https://gitlab.com/api/v4/projects/acme%2Fplatform%2Frecipes/repository/files/sous.index.json/raw?ref=HEAD",
        );
        expect(gitlabFileUrl({ repository: nested, path: "dir/a b.json", ref: "v1/x" })).toBe(
            "https://gitlab.com/api/v4/projects/acme%2Fplatform%2Frecipes/repository/files/dir%2Fa%20b.json/raw?ref=v1%2Fx",
        );
    });
});

describe("the gitlab host", () => {
    /**
     * It matches gitlab.com, any `gitlab.` host, and the hosts the options name.
     *
     * createGitlabHost({ hosts: ["git.example.com"] }).matches("https://git.example.com/a/b"); // -> true
     */
    it("should match gitlab.com, gitlab. hosts and the hosts the options name", () => {
        expect(host.matches("https://gitlab.com/a/b")).toBe(true);
        expect(host.matches("git@gitlab.example.org:a/b.git")).toBe(true);
        expect(host.matches("https://github.com/a/b")).toBe(false);
        expect(host.matches("https://git.example.com/a/b")).toBe(false);
        expect(createGitlabHost({ hosts: ["Git.Example.com"] }).matches("https://git.example.com/a/b")).toBe(true);
    });

    /**
     * canonicalize keeps a nested group whole and refuses a URL naming no project.
     *
     * host.canonicalize("https://gitlab.com/acme/platform/recipes").owner; // -> "acme/platform"
     */
    it("should canonicalize a project URL and refuse one naming no project", () => {
        expect(host.canonicalize("https://gitlab.com/acme/platform/recipes")).toEqual({
            host: "gitlab.com",
            owner: "acme/platform",
            name: "recipes",
            httpsUrl: "https://gitlab.com/acme/platform/recipes.git",
            sshUrl: "git@gitlab.com:acme/platform/recipes.git",
        });
        expect(() => host.canonicalize("https://gitlab.com/acme")).toThrow("is not a gitlab repository URL");
    });

    /**
     * It registers the strategies and token sources, in order.
     *
     * host.readStrategies.map((s) => s.id); // -> ["http-token", "http", "git"]
     */
    it("should register the read strategies and token sources in order", () => {
        expect(host.readStrategies.map((strategy) => strategy.id)).toEqual(["http-token", "http", "git"]);
        expect(host.tokenSources?.map((source) => source.id)).toEqual(["env", "git-credential", "glab"]);
        expect(host.features).toEqual(["fetch", "submit", "proposals"]);
    });
});

describe("reading through the gitlab host", () => {
    /**
     * The token sources are tried in the expected order; GITLAB_TOKEN wins when set, and the token is sent
     * to the API address as `Authorization: Bearer <token>`.
     *
     * GET <API> Authorization: Bearer glpat-x -> 200 (recorded) -> { ok: true, text, etag }
     */
    it("should read the API address with the token from GITLAB_TOKEN", async () => {
        const { http, ctx } = ctxFor({ env: { GITLAB_TOKEN: "glpat-x" }, routes: { [API]: { status: 200, headers: { etag: 'W/"e1"' }, body: INDEX } } });
        const token = await firstToken(host, repository, ctx);

        expect(token).toEqual({ value: "glpat-x", source: "GITLAB_TOKEN" });
        expect(await readWith(host, "http-token", { ...request, token: token! }, ctx)).toEqual({ ok: true, text: INDEX, ref: "HEAD", etag: 'W/"e1"' });
        expect(http.requests[0]?.headers?.["Authorization"]).toBe("Bearer glpat-x");
    });

    /**
     * Without a variable, git's stored credential is asked next, then glab, with
     * `glab config get token --host <host>`, never `glab auth token`.
     *
     * // git has nothing; glab config get token --host gitlab.com -> "glpat-y" -> source "glab"
     */
    it("should take the token from git, then from glab config get token", async () => {
        expect(await firstToken(host, repository, ctxFor({ credential: "from-git" }).ctx)).toEqual({ value: "from-git", source: "git credential fill" });

        const { processes, ctx } = ctxFor({ installed: ["glab"], processAnswer: (_command, args) => (args[0] === "config" ? { stdout: "glpat-y\n" } : { exitCode: 1 }) });

        expect(await firstToken(host, repository, ctx)).toEqual({ value: "glpat-y", source: "glab" });
        expect(processes.runs.map((run) => run.args)).toEqual([["config", "get", "token", "--host", "gitlab.com"]]);
    });

    /**
     * Help text glab prints with exit code 0 is never taken as a token, and a missing glab is
     * skipped, never required.
     *
     * // glab prints its help -> no token; glab missing -> no token, nothing run
     */
    it("should refuse glab help text and skip a missing glab", async () => {
        const help = ctxFor({ installed: ["glab"], processAnswer: () => ({ stdout: "USAGE\n  glab auth <command> [flags]\n" }) });

        expect(await firstToken(host, repository, help.ctx)).toBeUndefined();

        const missing = ctxFor({});

        expect(await firstToken(host, repository, missing.ctx)).toBeUndefined();
        expect(missing.processes.runs).toEqual([]);
    });

    /**
     * A public project is read without a token at the same API address.
     *
     * GET <API> (no Authorization) -> 200 -> { ok: true }
     */
    it("should read a public project without a token", async () => {
        const { http, ctx } = ctxFor({ routes: { [API]: (req) => (req.headers?.["Authorization"] === undefined ? { status: 200, body: INDEX } : { status: 500 }) } });

        expect(await readWith(host, "http", request, ctx)).toMatchObject({ ok: true, text: INDEX });
        expect(http.requests).toHaveLength(1);
    });

    /**
     * A cached ETag is sent, and a 304 is "not modified" (ETag caching is kept).
     *
     * GET <API> If-None-Match: W/"e1" -> 304 -> { ok: true, notModified: true }
     */
    it("should send the cached ETag and accept not modified", async () => {
        const { ctx } = ctxFor({ routes: { [API]: (req) => (req.headers?.["If-None-Match"] === 'W/"e1"' ? { status: 304, headers: { etag: 'W/"e1"' } } : { status: 200, body: INDEX }) } });

        expect(await readWith(host, "http", { ...request, etag: 'W/"e1"' }, ctx)).toEqual({ ok: true, notModified: true, etag: 'W/"e1"' });
    });

    /**
     * Each strategy's reason is the line the combined error shows, and the fixes are GitLab's.
     *
     * HTTP without token   302 to sign-in page: the repository is private
     * git                  Permission denied (publickey); ...
     * export GITLAB_TOKEN=<a token with read_repository>
     */
    it("should give the expected reasons and fixes when a private project cannot be read", async () => {
        const { ctx } = ctxFor({ routes: { [API]: { status: 302, headers: { location: "https://gitlab.com/users/sign_in" } } } });
        const env = host.tokenSources![0] as ExplainedTokenSource;

        expect(await env.find(repository, ctx)).toEqual({ missing: "GITLAB_TOKEN unset" });
        expect(env.fix?.(repository)).toBe("export GITLAB_TOKEN=<a token with read_repository>");
        expect(await (host.tokenSources![1] as ExplainedTokenSource).find(repository, ctx)).toEqual({ missing: "git has no stored credential for gitlab.com" });
        expect(await readWith(host, "http", request, ctx)).toEqual({ ok: false, reason: "302 to sign-in page: the repository is private" });
        expect(await readWith(host, "git", request, ctx)).toEqual({
            ok: false,
            reason: "Permission denied (publickey); could not read Username for 'https://gitlab.com': terminal prompts disabled",
        });
        expect((host.readStrategies[2] as ExplainedReadStrategy).fix?.(repository)).toBe("set up git access to gitlab.com (an SSH key, or a credential helper)");
    });

    /**
     * A private project with no HTTP access is read through git, with the user's own SSH key.
     *
     * // git over SSH -> the index
     */
    it("should read through git", async () => {
        const { ctx } = ctxFor({ gitRead: () => INDEX });

        expect(await readWith(host, "git", request, ctx)).toEqual({ ok: true, text: INDEX, ref: "HEAD" });
    });

    /**
     * The token variables can be changed through the options.
     *
     * createGitlabHost({ tokenVariables: ["CI_JOB_TOKEN"] }) with CI_JOB_TOKEN=job -> token "job"
     */
    it("should read the token variables the options name", async () => {
        const custom = createGitlabHost({ tokenVariables: ["CI_JOB_TOKEN"] });

        expect(await firstToken(custom, repository, ctxFor({ env: { CI_JOB_TOKEN: "job", GITLAB_TOKEN: "no" } }).ctx)).toEqual({ value: "job", source: "CI_JOB_TOKEN" });
    });
});

describe("readGitlabLocation()", () => {
    /**
     * Without a marker, every split of a nested group is a reading.
     *
     * readGitlabLocation({ segments: ["a", "b", "c", "d"] });
     * // -> a/b naming c/d, a/b/c naming d, a/b/c/d naming nothing
     */
    it("should return every split of a nested group", () => {
        expect(readGitlabLocation({ host: "gitlab.com", segments: ["a", "b", "c", "d"] })).toEqual([
            { repoPath: "a/b", named: ["c", "d"] },
            { repoPath: "a/b/c", named: ["d"] },
            { repoPath: "a/b/c/d", named: [] },
        ]);
    });

    /**
     * A `-` segment ends the project path; a browser path after it is read too.
     *
     * readGitlabLocation({ segments: ["g", "sub", "p", "-", "tree", "main", "recipes"] });
     * // -> [{ repoPath: "g/sub/p", browsed: "main/recipes" }, { repoPath: "g/sub/p", named: ["tree", "main", "recipes"] }]
     */
    it("should end the project path at the separator", () => {
        expect(readGitlabLocation({ host: "gitlab.com", segments: ["g", "sub", "p", "-", "tree", "main", "recipes"] })).toEqual([
            { repoPath: "g/sub/p", browsed: "main/recipes" },
            { repoPath: "g/sub/p", named: ["tree", "main", "recipes"] },
        ]);
    });

    /**
     * A `.git` suffix ends the project path too.
     *
     * readGitlabLocation({ segments: ["g", "p.git", "workflow"] }); // -> [{ repoPath: "g/p", named: ["workflow"] }]
     */
    it("should end the project path at a .git suffix", () => {
        expect(readGitlabLocation({ host: "gitlab.com", segments: ["g", "p.git", "workflow"] })).toEqual([{ repoPath: "g/p", named: ["workflow"] }]);
    });

    /**
     * The canonical locator marks the end of the project path with `-`.
     *
     * host.formatLocator("gitlab.com", "g/p", "workflow/alpha"); // -> "gitlab://g/p/-/workflow/alpha"
     */
    it("should format a canonical locator with the separator", () => {
        expect(host.formatLocator("gitlab.com", "g/p", "workflow/alpha")).toBe("gitlab://g/p/-/workflow/alpha");
        expect(host.formatLocator("gitlab.example.org", "g/p", "")).toBe("gitlab://gitlab.example.org/g/p");
    });
});
