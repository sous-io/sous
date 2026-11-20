import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BufferedReporter, nullReporter } from "@sous-io/sous-plugin-api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RepositoryHostContext, RepositoryHostEntity, RepositoryReadStrategy, RepositoryTokenSource } from "../../types.js";
import { IndexReadError, readFailureSentence, readThroughChain, StrategyMemoryFile, type ChainRead } from "./read-chain.js";

const repository = { host: "fake.test", owner: "acme", name: "recipes", httpsUrl: "https://fake.test/acme/recipes", sshUrl: "git@fake.test:acme/recipes.git" };
const ctx = { reporter: nullReporter } as unknown as RepositoryHostContext;

let dir: string;
let memory: StrategyMemoryFile;
let order: string[];

/** A strategy that records its call and succeeds or fails. */
function strategy(id: string, outcome: "ok" | string, options: { usesToken?: boolean; seen?: Array<string | undefined> } = {}): RepositoryReadStrategy {
    return {
        id,
        label: id.toUpperCase(),
        ...(options.usesToken ? { usesToken: true } : {}),
        async read(request) {
            order.push(id);
            options.seen?.push(request.token?.value);

            return outcome === "ok" ? { ok: true, text: "{}", ref: request.ref } : { ok: false, reason: outcome };
        },
    };
}

/** A read through a host with these strategies and token sources. */
function readOf(readStrategies: RepositoryReadStrategy[], tokenSources?: RepositoryTokenSource[]): ChainRead {
    const host = { id: "fake", readStrategies, ...(tokenSources ? { tokenSources } : {}) } as unknown as RepositoryHostEntity;

    return { identity: "fake.test/acme/recipes", label: "acme", repository, host, path: "sous.index.json" };
}

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "read-chain-"));
    memory = new StrategyMemoryFile(path.join(dir, "cache", "read-strategies.json"));
    order = [];
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("readThroughChain", () => {
    it("should try each strategy in order until one works", async () => {
        const outcome = await readThroughChain(readOf([strategy("http", "403"), strategy("git", "ok")]), memory, ctx);

        expect(order).toEqual(["http", "git"]);
        expect(outcome).toMatchObject({ ok: true, strategy: "git" });
    });

    it("should skip a token strategy with 'no token found' when no token source finds one", async () => {
        const none: RepositoryTokenSource = { id: "env", label: "GITLAB_TOKEN", token: async () => undefined };

        await expect(readThroughChain(readOf([strategy("http-token", "ok", { usesToken: true }), strategy("http", "302 to sign-in page")], [none]), memory, ctx)).rejects.toSatisfy(
            (error: IndexReadError) => {
                expect(order).toEqual(["http"]);
                expect(error.failure.attempts[0]).toEqual({ strategy: "HTTP-TOKEN", reason: "no token found (GITLAB_TOKEN: none)" });

                return true;
            },
        );
    });

    it("should hand the first token found to a token strategy", async () => {
        const seen: Array<string | undefined> = [];
        const sources: RepositoryTokenSource[] = [
            { id: "env", label: "GITLAB_TOKEN", token: async () => undefined },
            { id: "git", label: "git credential fill", token: async () => ({ value: "secret", source: "git credential fill" }) },
        ];

        await readThroughChain(readOf([strategy("http-token", "ok", { usesToken: true, seen })], sources), memory, ctx);

        expect(seen).toEqual(["secret"]);
        expect(memory.read()["fake.test/acme/recipes"]).toMatchObject({ strategy: "http-token", tokenSource: "git credential fill" });
    });

    it("should remember what worked in read-strategies.json and try it first next time", async () => {
        const strategies = [strategy("http", "403"), strategy("git", "ok")];

        await readThroughChain(readOf(strategies), memory, ctx);

        const written = JSON.parse(fs.readFileSync(memory.file, "utf8"));

        expect(written["fake.test/acme/recipes"]).toMatchObject({ strategy: "git", tokenSource: null });
        expect(typeof written["fake.test/acme/recipes"].lastSuccess).toBe("string");

        order = [];
        await readThroughChain(readOf(strategies), memory, ctx);

        expect(order).toEqual(["git"]);
    });

    it("should drop the remembered strategy after every strategy fails", async () => {
        await readThroughChain(readOf([strategy("git", "ok")]), memory, ctx);
        await expect(readThroughChain(readOf([strategy("git", "Permission denied (publickey)")]), memory, ctx)).rejects.toBeInstanceOf(IndexReadError);

        expect(memory.read()["fake.test/acme/recipes"]).toBeUndefined();
    });

    it("should throw one error listing each attempt and the fixes", async () => {
        const sources: RepositoryTokenSource[] = [{ id: "env", label: "GITLAB_TOKEN", token: async () => undefined }];

        try {
            await readThroughChain(readOf([strategy("http", "302 to sign-in page"), strategy("git", "Permission denied (publickey)")], sources), memory, ctx);
            expect.unreachable();
        } catch (error) {
            const failure = (error as IndexReadError).failure;

            expect((error as Error).message.split("\n")[0]).toBe("could not read fake.test/acme/recipes.");
            expect(failure.attempts.map((attempt) => attempt.reason)).toEqual(["302 to sign-in page", "Permission denied (publickey)"]);
            expect(failure.fixes).toEqual(["provide a token through GITLAB_TOKEN", "set up git access to fake.test (an SSH key, or a credential helper)"]);
            expect((error as Error).message).toContain("Permission denied (publickey)");
        }
    });

    it("should word the combined error the same way for every host, through the hosts' find and fix methods", async () => {
        const sources: RepositoryTokenSource[] = [
            { id: "env", label: "GITLAB_TOKEN", token: async () => undefined, find: async () => ({ missing: "GITLAB_TOKEN unset" }), fix: () => "export GITLAB_TOKEN=<a token with read_repository>" },
            { id: "git-credential", label: "git credential fill", token: async () => undefined, find: async (repository) => ({ missing: `git has no stored credential for ${repository.host}` }) },
            // Not installed: says nothing.
            { id: "glab", label: "glab", token: async () => undefined, find: async () => ({ missing: undefined }) },
        ];
        const git: RepositoryReadStrategy = {
            ...strategy("git", "Permission denied (publickey)"),
            label: "git",
            fix: (repository) => `set up git access to ${repository.host} (an SSH key, or a credential helper)`,
        };
        const read = readOf(
            [
                { ...strategy("http-token", "ok", { usesToken: true }), label: "HTTP with token" },
                { ...strategy("http", "302 to sign-in page: the repository is private"), label: "HTTP without token" },
                git,
            ],
            sources,
        );
        const failure = readThroughChain({ ...read, identity: "gitlab.com/acme/private-recipes", repository: { ...read.repository, host: "gitlab.com" } }, memory, ctx);

        await expect(failure).rejects.toThrow(
            [
                "could not read gitlab.com/acme/private-recipes.",
                "  HTTP with token      no token found (GITLAB_TOKEN unset; git has no stored credential for gitlab.com)",
                "  HTTP without token   302 to sign-in page: the repository is private",
                "  git                  Permission denied (publickey)",
                "Fix one of these:",
                "  export GITLAB_TOKEN=<a token with read_repository>",
                "  set up git access to gitlab.com (an SSH key, or a credential helper)",
            ].join("\n"),
        );
    });

    it("should count a strategy that throws as a failed attempt", async () => {
        const throwing: RepositoryReadStrategy = { id: "http", label: "HTTP", read: async () => Promise.reject(new Error("ECONNRESET")) };

        await expect(readThroughChain(readOf([throwing, strategy("git", "ok")]), memory, ctx)).resolves.toMatchObject({ strategy: "git" });
    });

    it("should read a damaged memory file as empty", () => {
        fs.mkdirSync(path.dirname(memory.file), { recursive: true });
        fs.writeFileSync(memory.file, "not json", "utf8");

        expect(memory.read()).toEqual({});
    });
});

describe("readThroughChain: fixes chosen from what the attempts said (#204 bug 20)", () => {
    const gitlab = { ...repository, host: "gitlab.com" };
    const exportToken = "export GITLAB_TOKEN=<a token with read_repository>";
    const gitAccess = "set up git access to gitlab.com (an SSH key, or a credential helper)";
    const envSource: RepositoryTokenSource = {
        id: "env",
        label: "GITLAB_TOKEN",
        token: async () => undefined,
        find: async () => ({ missing: "GITLAB_TOKEN unset" }),
        fix: () => exportToken,
    } as RepositoryTokenSource;

    /** A glab token source: installed or not, and signed in or out. */
    function glab(state: "missing" | "signed-out"): RepositoryTokenSource {
        return {
            id: "glab",
            label: "glab",
            token: async () => undefined,
            find: async () => ({ missing: state === "missing" ? undefined : "glab printed no token for gitlab.com" }),
            fix: () => "glab auth login --hostname gitlab.com",
        } as RepositoryTokenSource;
    }

    /** GitLab's chain, each strategy failing with the reason given. */
    function gitlabRead(reasons: { http: string; git: string }, sources: RepositoryTokenSource[] = [envSource]): ChainRead {
        const git: RepositoryReadStrategy = { ...strategy("git", reasons.git), label: "git", fix: (repo) => `set up git access to ${repo.host} (an SSH key, or a credential helper)` } as RepositoryReadStrategy;
        const read = readOf([{ ...strategy("http-token", "ok", { usesToken: true }), label: "HTTP with token" }, { ...strategy("http", reasons.http), label: "HTTP without token" }, git], sources);

        return { ...read, identity: "gitlab.com/acme/recipes", repository: gitlab };
    }

    async function failureOf(read: ChainRead): Promise<IndexReadError> {
        return readThroughChain(read, memory, ctx).then(
            () => expect.unreachable() as never,
            (error: IndexReadError) => error,
        );
    }

    /**
     * Offline, every attempt failed to connect, so the only fix is the connection; no token advice.
     *
     * // http: could not connect (ENOTFOUND), git: Could not resolve host
     * // -> ["check that this machine can reach gitlab.com, and set HTTPS_PROXY if this network needs a proxy"]
     */
    it("should offer only the network fix when every attempt could not connect", async () => {
        const error = await failureOf(
            gitlabRead({ http: "could not connect: Sous could not reach https://gitlab.com/x: getaddrinfo ENOTFOUND gitlab.com.", git: "unable to access 'https://gitlab.com/acme/recipes.git/': Could not resolve host: gitlab.com" }),
        );

        expect(error.failure.fixes).toEqual(["check that this machine can reach gitlab.com, and set HTTPS_PROXY if this network needs a proxy"]);
    });

    /**
     * When git reached the repository and said the index file is not there, the repository is not
     * private: the fix is the URL, and no token is offered.
     *
     * // git: path 'sous.index.json' does not exist in 'FETCH_HEAD'
     * // -> ["check the URL: git reached gitlab.com/acme/recipes, but it has no sous.index.json, ..."]
     */
    it("should say the repository has no index, and offer no token, when git reached it", async () => {
        const error = await failureOf(gitlabRead({ http: "404: no sous.index.json at HEAD, or the repository is private", git: "path 'sous.index.json' does not exist in 'FETCH_HEAD'" }));

        expect(error.failure.fixes).toEqual([
            "check the URL: git reached gitlab.com/acme/recipes, but it has no sous.index.json, so it is not a sous recipe repository, or nothing in it has been released yet",
        ]);
    });

    /**
     * A CLI that is installed but signed out gets its login command; one that is not installed gets nothing.
     *
     * // glab installed, no token -> fixes include "glab auth login --hostname gitlab.com"
     * // glab not installed      -> they do not
     */
    it("should offer 'glab auth login' only when glab is installed and signed out", async () => {
        const reasons = { http: "302 to sign-in page: the repository is private", git: "Permission denied (publickey)" };

        expect((await failureOf(gitlabRead(reasons, [envSource, glab("signed-out")]))).failure.fixes).toEqual([exportToken, "glab auth login --hostname gitlab.com", gitAccess]);
        expect((await failureOf(gitlabRead(reasons, [envSource, glab("missing")]))).failure.fixes).toEqual([exportToken, gitAccess]);
    });

    /**
     * A token that was found and refused is named by where it came from, and its source's "export"
     * line is not offered again.
     *
     * // GITLAB_TOKEN set, HTTP with token: 401 -> "replace the token in GITLAB_TOKEN: gitlab.com refused it ..."
     */
    it("should name the source of a refused token instead of asking to set it", async () => {
        const set: RepositoryTokenSource = { ...envSource, find: async () => ({ token: { value: "wrong", source: "GITLAB_TOKEN" } }) } as RepositoryTokenSource;
        const read = gitlabRead({ http: "302 to sign-in page: the repository is private", git: "Permission denied (publickey)" }, [set]);
        const refusing = { ...strategy("http-token", "401: the token was refused", { usesToken: true }), label: "HTTP with token" };
        const error = await failureOf({ ...read, host: { ...read.host, readStrategies: [refusing, ...read.host.readStrategies.slice(1)] } as RepositoryHostEntity });

        expect(error.failure.fixes).toEqual(["replace the token in GITLAB_TOKEN with one that can read gitlab.com/acme/recipes: gitlab.com refused it", gitAccess]);
    });
});

describe("readFailureSentence()", () => {
    /**
     * A read failure becomes one capitalized sentence naming each attempt, for a note with one line
     * to give it (#204 bug 33).
     *
     * readFailureSentence({ repo: "github.com/sous-io/sous-recipes", attempts: [http, git] })
     * // -> "Sous could not read github.com/sous-io/sous-recipes (HTTP without token: could not connect: …; git: Could not resolve host: github.com)."
     */
    it("should give the failure as one sentence that names each attempt", () => {
        const sentence = readFailureSentence({
            repo: "github.com/sous-io/sous-recipes",
            attempts: [
                { strategy: "HTTP without token", reason: "could not connect: Sous could not reach https://raw.githubusercontent.com/x: getaddrinfo ENOTFOUND raw.githubusercontent.com." },
                { strategy: "git", reason: "Could not resolve host: github.com" },
            ],
            fixes: [],
        });

        expect(sentence).toBe(
            "Sous could not read github.com/sous-io/sous-recipes (HTTP without token: could not connect: Sous could not reach https://raw.githubusercontent.com/x: getaddrinfo ENOTFOUND raw.githubusercontent.com; git: Could not resolve host: github.com).",
        );
    });
});

describe("readThroughChain: current reads (#133)", () => {
    /** GitHub's shape: a raw host that may serve a cached copy, and an API used only for current reads. */
    function github(outcomes: { raw?: string; api?: string; git?: string } = {}): RepositoryReadStrategy[] {
        return [
            { ...strategy("http", outcomes.raw ?? "ok"), servesCachedCopies: true },
            { ...strategy("http-api", outcomes.api ?? "ok"), onlyForCurrentReads: true },
            strategy("git", outcomes.git ?? "ok"),
        ];
    }

    /**
     * An ordinary read never uses a strategy meant only for current reads.
     *
     * // http (cached copies), http-api (current reads only), git; http fails
     * readThroughChain(read) // tries http, then git
     */
    it("should leave out strategies meant only for current reads from an ordinary read", async () => {
        await readThroughChain(readOf(github({ raw: "500" })), memory, ctx);

        expect(order).toEqual(["http", "git"]);
    });

    /**
     * A current read tries a server that may answer with a cached copy only after every other
     * strategy, even when it is the remembered one, and does not remember a current-only strategy.
     *
     * readThroughChain({ ...read, current: true }) // tries http-api first
     */
    it("should try a cached-copy server last on a current read, and not remember a current-only strategy", async () => {
        await readThroughChain(readOf(github()), memory, ctx);
        expect(memory.read()["fake.test/acme/recipes"]).toMatchObject({ strategy: "http" });

        order = [];
        await expect(readThroughChain({ ...readOf(github()), current: true }, memory, ctx)).resolves.toMatchObject({ strategy: "http-api" });

        expect(order).toEqual(["http-api"]);
        expect(memory.read()["fake.test/acme/recipes"]).toMatchObject({ strategy: "http" });
    });

    /**
     * When nothing else answers a current read, the cached-copy server still does.
     *
     * // http-api and git fail -> http answers
     */
    it("should still fall back to a cached-copy server when nothing else answers a current read", async () => {
        await expect(readThroughChain({ ...readOf(github({ api: "403: rate limited", git: "Permission denied (publickey)" })), current: true }, memory, ctx)).resolves.toMatchObject({ strategy: "http" });

        expect(order).toEqual(["http-api", "git", "http"]);
    });
});

describe("readThroughChain: a refused token (#230 item 7)", () => {
    /** A token strategy that refuses every token but `good` with a 401, recording each token it was sent. */
    function refusing(good: string | undefined, seen: string[]): RepositoryReadStrategy {
        return {
            id: "http-token",
            label: "HTTP with token",
            usesToken: true,
            async read(request) {
                seen.push(request.token?.value ?? "none");

                return request.token?.value === good ? { ok: true, text: "{}", ref: request.ref } : { ok: false, reason: "401: the token was refused", status: 401 };
            },
        };
    }

    /** A token source that finds `value`. */
    function source(id: string, label: string, value: string | undefined, fix?: string): RepositoryTokenSource {
        return {
            id,
            label,
            token: async () => undefined,
            find: async () => (value === undefined ? { missing: `${label}: none` } : { token: { value, source: label } }),
            ...(fix === undefined ? {} : { fix: () => fix }),
        } as RepositoryTokenSource;
    }

    const env = () => source("env", "GITLAB_TOKEN", "wrong", "export GITLAB_TOKEN=<a token with read_repository>");

    /**
     * After a 401, the next token source's token is sent to the same strategy; when it works, one
     * warning names where the refused token came from and how to fix it, and the source that worked
     * is remembered.
     *
     * // GITLAB_TOKEN "wrong" -> 401; git credential fill "right" -> 200
     * // warning: "GITLAB_TOKEN holds a token fake.test refused (401: the token was refused), so sous read ..."
     */
    it("should try the next token source after a refusal and warn once that the first was refused", async () => {
        const seen: string[] = [];
        const reporter = new BufferedReporter();
        const warned = new Set<string>();
        const read = readOf([refusing("right", seen), strategy("git", "ok")], [env(), source("git-credential", "git credential fill", "right")]);

        const outcome = await readThroughChain(read, memory, { reporter } as unknown as RepositoryHostContext, { warned });

        expect(seen).toEqual(["wrong", "right"]);
        expect(outcome).toMatchObject({ strategy: "http-token", token: { value: "right" }, refusedTokens: ["wrong"] });
        expect(memory.strategy("fake.test/acme/recipes")).toMatchObject({ strategy: "http-token", tokenSource: "git credential fill" });
        expect(reporter.at("warning")).toEqual([
            "GITLAB_TOKEN holds a token fake.test refused (401: the token was refused), so sous read fake.test/acme/recipes with HTTP with token, using the token from git credential fill. " +
                "Replace the token in GITLAB_TOKEN with one that can read the repository (export GITLAB_TOKEN=<a token with read_repository>), or unset GITLAB_TOKEN.",
        ]);

        await readThroughChain(read, memory, { reporter } as unknown as RepositoryHostContext, { warned });

        expect(reporter.at("warning")).toHaveLength(1);
    });

    /**
     * When every token is refused and git works, the warning still names the refused token; a source
     * that hands back the same token (glab returning GITLAB_TOKEN) is not tried again.
     *
     * // GITLAB_TOKEN "wrong" -> 401; glab "wrong" -> skipped; git -> ok
     */
    it("should warn about a refused token when git succeeds, and skip a repeated token", async () => {
        const seen: string[] = [];
        const reporter = new BufferedReporter();
        const read = readOf([refusing(undefined, seen), strategy("git", "ok")], [env(), source("glab", "glab", "wrong")]);

        expect(await readThroughChain(read, memory, { reporter } as unknown as RepositoryHostContext)).toMatchObject({ strategy: "git" });
        expect(seen).toEqual(["wrong"]);
        expect(reporter.at("warning")[0]).toContain("so sous read fake.test/acme/recipes with GIT.");
    });

    /**
     * When everything fails, each attempt names the token it sent, and the fix replaces the refused
     * token rather than asking to export the variable already set.
     *
     * // HTTP with token  401: the token was refused (the token from GITLAB_TOKEN)
     * // fixes: ["replace the token in GITLAB_TOKEN with one that can read fake.test/acme/recipes: fake.test refused it", ...]
     */
    it("should name each refused token's source in the error", async () => {
        const read = readOf([refusing(undefined, []), strategy("git", "Permission denied (publickey)")], [env()]);
        const error = await readThroughChain(read, memory, ctx).then(
            () => expect.unreachable() as never,
            (failure: IndexReadError) => failure,
        );

        expect(error.failure.attempts[0]).toEqual({ strategy: "HTTP with token", reason: "401: the token was refused (the token from GITLAB_TOKEN)" });
        expect(error.failure.fixes[0]).toBe("replace the token in GITLAB_TOKEN with one that can read fake.test/acme/recipes: fake.test refused it");
        expect(error.failure.fixes).not.toContain("export GITLAB_TOKEN=<a token with read_repository>");
    });
});

describe("readThroughChain: how long a remembered strategy stays first (#230 item 10)", () => {
    const DAY = 24 * 60 * 60 * 1000;

    /**
     * A remembered strategy goes first for `memorySeconds` from when it became first, however often
     * it works since; after that, the host's order is tried first again.
     *
     * // git remembered since day 0, memory 7 days: day 3 -> git first; day 8 -> http first
     */
    it("should put a remembered strategy first only until its time runs out", async () => {
        const strategies = [strategy("http", "ok"), strategy("git", "ok")];
        const start = new Date("2026-11-01T00:00:00.000Z");

        memory.remember("fake.test/acme/recipes", { strategy: "git", tokenSource: null, lastSuccess: start.toISOString(), lastDurationMs: 1, since: start.toISOString() });

        await readThroughChain(readOf(strategies), memory, ctx, { now: () => new Date(start.getTime() + 3 * DAY), memorySeconds: 7 * 86400 });

        expect(order).toEqual(["git"]);
        expect(memory.strategy("fake.test/acme/recipes")?.since).toBe(start.toISOString());

        order = [];
        await readThroughChain(readOf(strategies), memory, ctx, { now: () => new Date(start.getTime() + 8 * DAY), memorySeconds: 7 * 86400 });

        expect(order).toEqual(["http"]);
        expect(memory.strategy("fake.test/acme/recipes")).toMatchObject({ strategy: "http", since: new Date(start.getTime() + 8 * DAY).toISOString() });
    });

    /**
     * A record written before `since` existed goes first no longer, and `0` never puts one first.
     *
     * // { strategy: "git" } with no since -> http first
     */
    it("should not put a record without a start, or with no memory time, first", async () => {
        const strategies = [strategy("http", "ok"), strategy("git", "ok")];

        memory.remember("fake.test/acme/recipes", { strategy: "git", tokenSource: null, lastSuccess: new Date().toISOString(), lastDurationMs: 1 });
        await readThroughChain(readOf(strategies), memory, ctx);
        expect(order).toEqual(["http"]);

        order = [];
        memory.remember("fake.test/acme/recipes", { strategy: "git", tokenSource: null, lastSuccess: new Date().toISOString(), lastDurationMs: 1, since: new Date().toISOString() });
        await readThroughChain(readOf(strategies), memory, ctx, { memorySeconds: 0 });
        expect(order).toEqual(["http"]);
    });

    /**
     * The download's clone URL is kept beside the read strategy: forgetting one leaves the other.
     *
     * rememberDownload(id, { url }); remember(id, undefined); // -> { download: { url } }
     */
    it("should keep the download record when the read strategy is forgotten", () => {
        const now = new Date().toISOString();

        memory.remember("fake.test/acme/recipes", { strategy: "git", tokenSource: null, lastSuccess: now, lastDurationMs: 1, since: now });
        memory.rememberDownload("fake.test/acme/recipes", { url: "git@fake.test:acme/recipes.git", lastSuccess: now, since: now });
        memory.remember("fake.test/acme/recipes", undefined);

        expect(memory.read()["fake.test/acme/recipes"]).toEqual({ download: { url: "git@fake.test:acme/recipes.git", lastSuccess: now, since: now } });

        memory.rememberDownload("fake.test/acme/recipes", undefined);
        expect(memory.read()["fake.test/acme/recipes"]).toBeUndefined();
    });
});
