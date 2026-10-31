import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isSousErrorOfKind } from "@sous-io/plugin-api";
import { createGitRunner, LF_CHECKOUT_OPTIONS } from "@sous-io/plugin-git";
import type { GitResult, GitRunner } from "@sous-io/plugin-git/types";
import { createProcesses } from "@sous-io/plugin-host";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanTemp, tempDir } from "../../../test/part-b/helpers.js";
import * as checkout from "./checkout.js";

/** The line-ending options every clone carries, as they appear in a joined command. */
const LF = LF_CHECKOUT_OPTIONS.join(" ");

/** A runner that answers from a table of command lines, recording every call. */
function fakeRunner(answers: Record<string, Partial<GitResult>>): GitRunner & { calls: string[] } {
    const calls: string[] = [];
    const run = async (args: readonly string[]): Promise<GitResult> => {
        calls.push(args.join(" "));
        const answer = answers[args.join(" ")];

        return { args, exitCode: answer?.exitCode ?? (answer === undefined ? 1 : 0), stdout: answer?.stdout ?? "", stderr: answer?.stderr ?? "", durationMs: 0 };
    };

    return { calls, run } as unknown as GitRunner & { calls: string[] };
}

describe("remote URLs", () => {
    it("should reduce every spelling of one repository to the same string", () => {
        const expected = "github.com/sous-io/sous-recipes";

        for (const url of [
            "https://github.com/sous-io/sous-recipes",
            "https://github.com/sous-io/sous-recipes.git",
            "https://github.com/sous-io/sous-recipes/",
            "git@github.com:sous-io/sous-recipes.git",
            "ssh://git@github.com:22/sous-io/sous-recipes.git",
            "https://user:token@GitHub.com/Sous-IO/sous-recipes",
        ]) {
            expect(checkout.normalizeRemoteUrl(url)).toBe(expected);
        }
    });

    it("should keep two repositories apart and treat SSH and HTTPS spellings as one", () => {
        expect(checkout.sameRemote("https://github.com/a/b", "https://github.com/a/c")).toBe(false);
        expect(checkout.sameRemote("git@github.com:a/b.git", "https://github.com/a/b")).toBe(true);
    });

    it("should give the owner and the name, 'repos' when there is no owner, and refuse a URL with no path", () => {
        expect(checkout.repoSlugFromUrl("https://github.com/sous-io/sous-recipes")).toEqual({ owner: "sous-io", name: "sous-recipes" });
        expect(checkout.repoSlugFromUrl("https://gitlab.com/group/sub/repo.git")).toEqual({ owner: "sub", name: "repo" });
        expect(checkout.repoSlugFromUrl("https://example.com/repo")).toEqual({ owner: "repos", name: "repo" });

        try {
            checkout.repoSlugFromUrl("https://example.com");
            expect.unreachable();
        } catch (error) {
            expect(isSousErrorOfKind(error, "config")).toBe(true);
        }
    });

    it("should recognize URLs and paths, and not a bare short name", () => {
        expect(checkout.looksLikeRepoUrl("https://github.com/a/b")).toBe(true);
        expect(checkout.looksLikeRepoUrl("git@github.com:a/b.git")).toBe(true);
        expect(checkout.looksLikeRepoUrl("sous-recipes")).toBe(false);

        for (const value of ["/abs", "./rel", "../up", ".", "~/home"]) {
            expect(checkout.looksLikeLocalPath(value)).toBe(true);
        }

        expect(checkout.looksLikeLocalPath("sous-recipes")).toBe(false);
    });

    it("should generate a branch name from the local date and time", () => {
        expect(checkout.generatedBranchName(new Date(2026, 0, 5, 9, 7))).toBe("sous/edit-20260105-0907");
    });
});

describe("with a fake runner", () => {
    it("should retry the full history when a shallow clone is refused, and say so", async () => {
        const destination = path.join(tempDir(), "repo");
        const runner = fakeRunner({ [`clone ${LF} -- https://x/y ${destination}`]: { exitCode: 0 } });

        expect(await checkout.cloneRepo(runner, "https://x/y", destination)).toEqual({ depth: 0, fellBackToFullClone: true });
        expect(runner.calls[0]).toBe(`clone ${LF} --depth 1 -- https://x/y ${destination}`);
    });

    it("should carry git's message into the error when a clone fails", async () => {
        const destination = path.join(tempDir(), "repo");
        const runner = fakeRunner({ [`clone ${LF} -- https://x/y ${destination}`]: { exitCode: 128, stderr: "fatal: repository not found" } });

        await expect(checkout.cloneRepo(runner, "https://x/y", destination, 0)).rejects.toMatchObject({ message: "Cloning https://x/y failed.", details: expect.arrayContaining(["  fatal: repository not found"]) });
    });

    it("should treat a checkout git cannot read as possibly holding work", async () => {
        const work = await checkout.unsavedWork(fakeRunner({}), "/nowhere");

        expect(work.unknown).toContain("git could not read the checkout");
        expect(checkout.hasNoUnsavedWork(work)).toBe(false);
    });

    it("should read origin/HEAD first, then ask upstream, and give up quietly", async () => {
        expect(await checkout.defaultBranch(fakeRunner({ "symbolic-ref --quiet --short refs/remotes/origin/HEAD": { exitCode: 0, stdout: "origin/main" } }), "/r")).toBe("main");
        expect(await checkout.defaultBranch(fakeRunner({ "ls-remote --symref origin HEAD": { exitCode: 0, stdout: "ref: refs/heads/trunk\tHEAD\nabc\tHEAD" } }), "/r")).toBe("trunk");
        expect(await checkout.defaultBranch(fakeRunner({}), "/r")).toBeUndefined();
    });

    it("should return git's reason when a fetch fails", async () => {
        expect(await checkout.tryFetchUpstream(fakeRunner({ "fetch --quiet origin": { exitCode: 1, stderr: "Could not resolve host" } }), "/r")).toEqual({ ok: false, reason: "Could not resolve host" });
        expect(await checkout.tryFetchUpstream(fakeRunner({ "fetch --quiet origin": { exitCode: 0 } }), "/r")).toEqual({ ok: true });
    });

    it("should tell not merged apart from unknown", async () => {
        const runner = fakeRunner({ "merge-base --is-ancestor HEAD origin/main": { exitCode: 1 }, "rev-list --count HEAD..origin/main": { exitCode: 0, stdout: "3" } });

        expect(await checkout.compareWithUpstream(runner, "/r", "main")).toMatchObject({ merged: false, behind: 3 });
        expect(await checkout.compareWithUpstream(fakeRunner({ "merge-base --is-ancestor HEAD origin/main": { exitCode: 128 } }), "/r", "main")).toMatchObject({ merged: undefined, behind: undefined });
    });

    it("should leave a wildcard fetch configuration alone", async () => {
        const runner = fakeRunner({
            "fetch --quiet origin +refs/heads/feature:refs/remotes/origin/feature": { exitCode: 0 },
            "config --get-all remote.origin.fetch": { exitCode: 0, stdout: "+refs/heads/*:refs/remotes/origin/*" },
        });

        await checkout.fetchBranch(runner, "/r", "feature");
        expect(runner.calls.some((call) => call.startsWith("remote set-branches"))).toBe(false);
    });

    it("should name the step and carry git's message when fetching a branch fails", async () => {
        await expect(checkout.fetchBranch(fakeRunner({ "fetch --quiet origin +refs/heads/nope:refs/remotes/origin/nope": { exitCode: 128, stderr: "couldn't find remote ref nope" } }), "/r", "nope")).rejects.toMatchObject({
            message: "Fetching the branch 'nope' from origin failed.",
        });
    });
});

describe("with real git", () => {
    let base: string;
    let git: GitRunner;
    let upstream: string;
    let url: string;

    /** Runs git in a directory, failing the test when git fails. */
    const run = async (cwd: string, ...args: string[]): Promise<string> => (await git.run(args, { cwd })).stdout;

    beforeAll(async () => {
        base = tempDir();
        const env = {
            ...process.env,
            HOME: base,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_AUTHOR_NAME: "Sous Test",
            GIT_AUTHOR_EMAIL: "test@example.com",
            GIT_COMMITTER_NAME: "Sous Test",
            GIT_COMMITTER_EMAIL: "test@example.com",
        };

        git = createGitRunner({ processes: createProcesses({ env }), env });
        upstream = path.join(base, "upstream.git");
        await run(base, "init", "--bare", "-b", "main", upstream);

        const seed = path.join(base, "seed");

        await run(base, "init", "-b", "main", seed);
        fs.writeFileSync(path.join(seed, "a.md"), "one\n");
        await run(seed, "add", ".");
        await run(seed, "commit", "-m", "one");
        await run(seed, "checkout", "-b", "feature");
        fs.writeFileSync(path.join(seed, "b.md"), "two\n");
        await run(seed, "add", ".");
        await run(seed, "commit", "-m", "two");
        await run(seed, "remote", "add", "origin", upstream);
        await run(seed, "push", "origin", "main", "feature");
        url = pathToFileURL(upstream).href;
    });

    afterAll(() => cleanTemp());

    it("should clone shallow into a new directory, and refuse a directory that is not empty", async () => {
        const destination = path.join(base, "clones", "one");

        expect(await checkout.cloneRepo(git, url, destination)).toEqual({ depth: 1, fellBackToFullClone: false });
        expect(fs.readFileSync(path.join(destination, "a.md"), "utf8")).toBe("one\n");
        await expect(checkout.cloneRepo(git, url, destination)).rejects.toThrow(/already exists and is not empty/);
    });

    it("should tell the top of a working tree from anything else, and read its remote", async () => {
        const destination = path.join(base, "clones", "two");

        await checkout.cloneRepo(git, url, destination, 0);

        expect(await checkout.isGitCheckout(git, destination)).toBe(true);
        fs.mkdirSync(path.join(destination, "sub"));
        expect(await checkout.isGitCheckout(git, path.join(destination, "sub"))).toBe(false);
        expect(await checkout.isGitCheckout(git, path.join(base, "missing"))).toBe(false);
        expect(await checkout.remoteUrlOf(git, destination)).toBe(url);
        expect(await checkout.currentBranch(git, destination)).toBe("main");
        expect(await checkout.defaultBranch(git, destination)).toBe("main");
    });

    it("should list uncommitted changes, unpushed commits and stashes, and nothing for a clean checkout", async () => {
        const destination = path.join(base, "clones", "three");

        await checkout.cloneRepo(git, url, destination, 0);
        expect(checkout.hasNoUnsavedWork(await checkout.unsavedWork(git, destination))).toBe(true);

        fs.writeFileSync(path.join(destination, "a.md"), "changed\n");
        await run(destination, "stash");
        fs.writeFileSync(path.join(destination, "c.md"), "new\n");
        await run(destination, "add", "c.md");
        await run(destination, "commit", "-m", "local");
        fs.writeFileSync(path.join(destination, "a.md"), "dirty\n");

        const work = await checkout.unsavedWork(git, destination);

        expect(work.uncommitted).toEqual([" M a.md"]);
        expect(work.unpushed).toHaveLength(1);
        expect(work.stashes).toHaveLength(1);
    });

    it("should fetch a branch a single-branch clone cannot see, switch to it, and create a new branch from upstream", async () => {
        const destination = path.join(base, "clones", "four");

        await checkout.cloneRepo(git, url, destination);
        expect(await checkout.localBranchExists(git, destination, "feature")).toBe(false);

        await checkout.fetchBranch(git, destination, "feature");
        await checkout.switchBranch(git, destination, "feature");
        expect(await checkout.currentBranch(git, destination)).toBe("feature");
        expect(fs.existsSync(path.join(destination, "b.md"))).toBe(true);

        await checkout.assertBranchName(git, destination, "sous/edit-1");
        await expect(checkout.assertBranchName(git, destination, "bad..name")).rejects.toThrow(/Checking the branch name/);
        await checkout.fetchBranch(git, destination, "main");
        await checkout.createBranch(git, destination, "sous/edit-1", "origin/main");
        expect(await checkout.currentBranch(git, destination)).toBe("sous/edit-1");
        expect(fs.existsSync(path.join(destination, "b.md"))).toBe(false);
    });

    it("should list what making a branch match upstream discards, then discard it", async () => {
        const destination = path.join(base, "clones", "five");

        await checkout.cloneRepo(git, url, destination, 0);
        fs.writeFileSync(path.join(destination, "c.md"), "local\n");
        await run(destination, "add", "c.md");
        await run(destination, "commit", "-m", "local commit");
        fs.writeFileSync(path.join(destination, "a.md"), "dirty\n");

        const work = await checkout.discardableWork(git, destination, "main");

        expect(work.uncommitted).toEqual([" M a.md"]);
        expect(work.localCommits).toHaveLength(1);
        expect((await checkout.discardableWork(git, destination, "no-such-branch")).localCommits).toEqual([]);

        await checkout.resetBranchToUpstream(git, destination, "main");

        expect(fs.readFileSync(path.join(destination, "a.md"), "utf8")).toBe("one\n");
        expect(fs.existsSync(path.join(destination, "c.md"))).toBe(false);
    });

    it("should compare a checkout with upstream, and know when it last fetched", async () => {
        const destination = path.join(base, "clones", "six");

        await checkout.cloneRepo(git, url, destination, 0);
        expect(await checkout.tryFetchUpstream(git, destination)).toEqual({ ok: true });
        expect(await checkout.compareWithUpstream(git, destination, "main")).toMatchObject({ branch: "main", merged: true, behind: 0 });
        expect(await checkout.lastFetchedAt(git, destination, "main")).toBeInstanceOf(Date);
    });
});
