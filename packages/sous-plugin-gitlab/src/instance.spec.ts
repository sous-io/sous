import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GitCloneOptions } from "@sous-io/sous-plugin-git/types";
import { fakeGit, fakeSousHome, hostContext, readWith, recordedHttp, type RecordedRoute } from "@sous-io/sous-lib-repository-hosts/testing";
import { createGitlabHost, gitlabFileMetaUrl, gitlabFileUrl } from "./host.js";
import { candidateBasePaths, configuredHost, GITLAB_INSTANCES_FILENAME } from "./instance.js";

const INDEX = '{"formatVersion":1,"namespaces":{}}';
const JSON_TYPE = { "content-type": "application/json" };

let home: string;

beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "sous-gitlab-instance-"));
});

afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
});

/** A context over recorded HTTP, a sous home in the temporary directory, and a git that clones nothing. */
function ctxFor(routes: Record<string, RecordedRoute>, cloneFails: (url: string) => boolean = () => false) {
    const http = recordedHttp(routes);
    const git = fakeGit({
        clone: async (url: string, directory: string, options?: GitCloneOptions) => {
            if (cloneFails(url)) {
                throw new Error("fatal: Authentication failed");
            }

            fs.mkdirSync(path.join(directory, options?.sparsePaths?.[0] ?? ""), { recursive: true });
        },
    });

    return { http, git, ctx: hostContext({ services: { "host.http": http, "git.runner": git, "host.sous-home": fakeSousHome(home) } }) };
}

describe("configuredHost()", () => {
    /**
     * An entry of the `hosts` option names a host, and may name a port and a sub-path.
     *
     * configuredHost("Git.Example.com:8443/gitlab/"); // -> { host: "git.example.com:8443", basePath: "gitlab" }
     */
    it("should take a host, a port and a sub-path out of an entry", () => {
        expect(configuredHost("Git.Example.com:8443/gitlab/")).toEqual({ host: "git.example.com:8443", basePath: "gitlab" });
        expect(configuredHost("https://git.example.com/")).toEqual({ host: "git.example.com" });
    });
});

describe("candidateBasePaths()", () => {
    /**
     * Each sub-path leaves at least one group before the project, root first.
     *
     * candidateBasePaths("a/b/c"); // -> ["", "a", "a/b"]
     */
    it("should list the sub-paths a path could start with, root first", () => {
        expect(candidateBasePaths("a/b/c")).toEqual(["", "a", "a/b"]);
        expect(candidateBasePaths("acme")).toEqual([]);
    });
});

describe("a self-managed GitLab on a port (#212)", () => {
    const host = createGitlabHost({ hosts: ["git.example.com:8443"] });

    /**
     * An entry of the `hosts` option matches a URL with or without the port, either way round.
     *
     * createGitlabHost({ hosts: ["git.example.com"] }).matches("https://git.example.com:8443/a/b"); // -> true
     */
    it("should match a host with or without its port", () => {
        expect(createGitlabHost({ hosts: ["git.example.com"] }).matches("https://git.example.com:8443/a/b")).toBe(true);
        expect(host.matches("git@git.example.com:a/b.git")).toBe(true);
        expect(host.matches("https://git.example.com/a/b")).toBe(true);
        expect(host.matches("https://other.example.com:8443/a/b")).toBe(false);
    });

    /**
     * An HTTPS port stays in the HTTPS clone URL and the API address, and never reaches the SSH URL.
     *
     * canonicalize("https://git.example.com:8443/acme/recipes");
     * // httpsUrl "https://git.example.com:8443/acme/recipes.git", sshUrl "git@git.example.com:acme/recipes.git"
     */
    it("should keep the HTTPS port in HTTPS and API addresses only", () => {
        const repository = host.canonicalize("https://git.example.com:8443/acme/recipes");

        expect(repository).toMatchObject({ httpsUrl: "https://git.example.com:8443/acme/recipes.git", sshUrl: "git@git.example.com:acme/recipes.git" });
        expect(gitlabFileUrl({ repository, path: "sous.index.json", ref: "HEAD" })).toBe(
            "https://git.example.com:8443/api/v4/projects/acme%2Frecipes/repository/files/sous.index.json/raw?ref=HEAD",
        );
    });

    /**
     * An SSH URL's port stays in the SSH URL alone; the HTTPS address takes the port the option names.
     *
     * canonicalize("ssh://git@git.example.com:2222/acme/recipes");
     * // sshUrl "ssh://git@git.example.com:2222/acme/recipes.git", httpsUrl "https://git.example.com:8443/acme/recipes.git"
     */
    it("should keep an SSH port in the SSH URL only", () => {
        const repository = host.canonicalize("ssh://git@git.example.com:2222/acme/recipes");

        expect(repository).toMatchObject({ sshUrl: "ssh://git@git.example.com:2222/acme/recipes.git", httpsUrl: "https://git.example.com:8443/acme/recipes.git" });
        expect(gitlabFileUrl({ repository, path: "sous.index.json", ref: "HEAD" })).toBe(
            "https://git.example.com:8443/api/v4/projects/acme%2Frecipes/repository/files/sous.index.json/raw?ref=HEAD",
        );

        const unconfigured = createGitlabHost().canonicalize("ssh://git@gitlab.example.com:2222/acme/recipes");

        expect(unconfigured).toMatchObject({ host: "gitlab.example.com", httpsUrl: "https://gitlab.example.com/acme/recipes.git" });
    });
});

describe("a self-managed GitLab under a sub-path (#212)", () => {
    const URL = "https://git.example.com/gitlab/acme/recipes";
    const API = "https://git.example.com/gitlab/api/v4/projects/acme%2Frecipes/repository/files/sous.index.json/raw?ref=HEAD";

    /**
     * A sub-path the option names is used as given: the API address and the SSH URL leave it out of
     * the project path, the HTTPS clone URL keeps it, and the server is never asked.
     *
     * createGitlabHost({ hosts: ["git.example.com/gitlab"] }).canonicalize(URL).sshUrl; // -> "git@git.example.com:acme/recipes.git"
     */
    it("should use a sub-path the option names without asking the server", async () => {
        const host = createGitlabHost({ hosts: ["git.example.com/gitlab"] });
        const repository = host.canonicalize(URL);
        const { http, ctx } = ctxFor({ [API]: { status: 200, body: INDEX } });

        expect(repository).toMatchObject({ httpsUrl: "https://git.example.com/gitlab/acme/recipes.git", sshUrl: "git@git.example.com:acme/recipes.git", basePath: "gitlab" });
        expect(await readWith(host, "http", { repository, path: "sous.index.json", ref: "HEAD" }, ctx)).toMatchObject({ ok: true, text: INDEX });
        expect(http.requests.map((request) => request.url)).toEqual([API]);
    });

    /**
     * Without the option, the server is asked once where its API answers (`<base>/api/v4/version`,
     * root first); the answer is used, remembered under the sous home and reported, and a later
     * read asks nothing.
     *
     * GET https://git.example.com/api/v4/version        -> 404 (not GitLab)
     * GET https://git.example.com/gitlab/api/v4/version -> 401, JSON (GitLab's API)
     * // read at .../gitlab/api/v4/...; gitlab-instances.json: { "git.example.com": { basePath: "gitlab" } }
     */
    it("should ask the server for its sub-path once, remember it and report it", async () => {
        const host = createGitlabHost({ hosts: ["git.example.com"] });
        const repository = host.canonicalize(URL);
        const routes: Record<string, RecordedRoute> = {
            "https://git.example.com/api/v4/version": { status: 404, headers: { "content-type": "text/html" } },
            "https://git.example.com/gitlab/api/v4/version": { status: 401, headers: JSON_TYPE, body: '{"message":"401 Unauthorized"}' },
            [API]: { status: 200, body: INDEX },
        };
        const { http, ctx } = ctxFor(routes);

        expect(repository.basePath).toBeUndefined();
        expect(await readWith(host, "http", { repository, path: "sous.index.json", ref: "HEAD" }, ctx)).toMatchObject({ ok: true, text: INDEX });
        expect(http.requests.map((request) => request.url)).toEqual(["https://git.example.com/api/v4/version", "https://git.example.com/gitlab/api/v4/version", API]);
        expect(JSON.parse(fs.readFileSync(path.join(home, "cache", GITLAB_INSTANCES_FILENAME), "utf8"))["git.example.com"]).toMatchObject({ basePath: "gitlab" });
        expect(ctx.reporter.styled("note").map((entry) => entry.message).join("\n")).toContain("/gitlab/api/v4");

        // A new host entity (a new command) reads the remembered answer and asks nothing.
        const later = ctxFor(routes);

        await readWith(createGitlabHost({ hosts: ["git.example.com"] }), "http", { repository, path: "sous.index.json", ref: "HEAD" }, later.ctx);
        expect(later.http.requests.map((request) => request.url)).toEqual([API]);
    });

    /**
     * A download clones the HTTPS URL with the sub-path, and the SSH URL without it.
     *
     * fetchRecipeTree -> git clone https://git.example.com/gitlab/acme/recipes.git (fails) -> git@git.example.com:acme/recipes.git
     */
    it("should clone over SSH without the sub-path", async () => {
        const host = createGitlabHost({ hosts: ["git.example.com/gitlab"] });
        const { git, ctx } = ctxFor({}, (url) => url.startsWith("https://"));
        const fetched = await host.fetchRecipeTree(host.canonicalize(URL), "recipes/w/a", "w/a@1.0.0", path.join(home, "out"), ctx);
        const cloned = git.calls.filter((call) => call.method === "clone").map((call) => call.args[0]);

        expect(cloned).toEqual(["https://git.example.com/gitlab/acme/recipes.git", "git@git.example.com:acme/recipes.git"]);
        expect(fetched).toEqual({ url: "git@git.example.com:acme/recipes.git" });
    });
});

describe("revalidating a GitLab index (#230 item 10)", () => {
    const host = createGitlabHost();
    const repository = host.canonicalize("https://gitlab.com/acme/recipes");
    const request = { repository, path: "sous.index.json", ref: "HEAD" };
    const API = gitlabFileUrl(request);
    const META = gitlabFileMetaUrl(request);

    /**
     * GitLab sends no ETag for a file, so its `X-Gitlab-Content-Sha256` is kept as the cached copy's
     * ETag, and a later read sends one `HEAD` request: the same hash is "not modified", with no
     * download.
     *
     * GET  <API>  -> 200, x-gitlab-content-sha256: abc -> etag "x-gitlab-content-sha256:abc"
     * HEAD <META> -> 200, x-gitlab-content-sha256: abc -> { ok: true, notModified: true }
     */
    it("should revalidate with the content hash instead of downloading the file again", async () => {
        const first = ctxFor({ [API]: { status: 200, headers: { "x-gitlab-content-sha256": "abc" }, body: INDEX } });
        const read = await readWith(host, "http", request, first.ctx);

        expect(read).toEqual({ ok: true, text: INDEX, ref: "HEAD", etag: "x-gitlab-content-sha256:abc" });

        const again = ctxFor({ [META]: { status: 200, headers: { "x-gitlab-content-sha256": "abc" } }, [API]: { status: 200, body: INDEX } });

        expect(await readWith(host, "http", { ...request, etag: "x-gitlab-content-sha256:abc" }, again.ctx)).toEqual({ ok: true, notModified: true, etag: "x-gitlab-content-sha256:abc" });
        expect(again.http.requests.map((one) => `${one.method} ${one.url}`)).toEqual([`HEAD ${META}`]);
        expect(again.http.requests[0]?.headers?.["If-None-Match"]).toBeUndefined();
    });

    /**
     * A changed hash downloads the file, with its new hash.
     *
     * HEAD <META> -> x-gitlab-content-sha256: def -> GET <API> -> { ok: true, etag: "x-gitlab-content-sha256:def" }
     */
    it("should download the file when its content hash changed", async () => {
        const { http, ctx } = ctxFor({ [META]: { status: 200, headers: { "x-gitlab-content-sha256": "def" } }, [API]: { status: 200, headers: { "x-gitlab-content-sha256": "def" }, body: INDEX } });

        expect(await readWith(host, "http", { ...request, etag: "x-gitlab-content-sha256:abc" }, ctx)).toEqual({ ok: true, text: INDEX, ref: "HEAD", etag: "x-gitlab-content-sha256:def" });
        expect(http.requests.map((one) => one.method)).toEqual(["HEAD", "GET"]);
    });
});
