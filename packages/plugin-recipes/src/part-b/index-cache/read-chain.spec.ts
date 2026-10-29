import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { nullReporter } from "@sous-io/plugin-api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RepositoryHostContext, RepositoryHostEntity, RepositoryReadStrategy, RepositoryTokenSource } from "../../types.js";
import { IndexReadError, readThroughChain, StrategyMemoryFile, type ChainRead } from "./read-chain.js";

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

    it("should word the combined error exactly as S4 does, through the hosts' find and fix methods", async () => {
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
