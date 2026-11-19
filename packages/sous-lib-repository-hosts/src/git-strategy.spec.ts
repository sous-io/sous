import { describe, expect, it } from "vitest";
import { gitFailureReason, gitReadStrategy } from "./git-strategy.js";
import { fakeGit, hostContext } from "./testing.js";
import { canonicalRepository } from "./urls.js";

const repository = canonicalRepository("gitlab.com", "acme", "recipes");
const request = { repository, path: "sous.index.json", ref: "HEAD" };

describe("gitReadStrategy()", () => {
    /**
     * It reads one file through git.runner.readRemoteFile, SSH first, then HTTPS.
     *
     * // SSH fails, HTTPS works -> { ok: true, text, ref: "HEAD" }
     */
    it("should read the file over SSH, then HTTPS", async () => {
        const urls: string[] = [];
        const git = fakeGit({
            readRemoteFile: async (url, file, options) => {
                urls.push(url);

                if (url.startsWith("git@")) {
                    throw new Error("git@gitlab.com: Permission denied (publickey).\nfatal: Could not read from remote repository.");
                }

                return `${file} at ${options?.ref}`;
            },
        });
        const outcome = await gitReadStrategy().read(request, hostContext({ services: { "git.runner": git } }));

        expect(outcome).toEqual({ ok: true, text: "sous.index.json at HEAD", ref: "HEAD" });
        expect(urls).toEqual(["git@gitlab.com:acme/recipes.git", "https://gitlab.com/acme/recipes.git"]);
    });

    /**
     * When both fail, the reason holds each distinct cause; the fix names the host.
     *
     * // -> "Permission denied (publickey); could not read Username for 'https://gitlab.com': terminal prompts disabled"
     */
    it("should give each distinct reason and a fix naming the host", async () => {
        const git = fakeGit({
            readRemoteFile: async (url) => {
                throw new Error(url.startsWith("git@") ? "git@gitlab.com: Permission denied (publickey)." : "fatal: could not read Username for 'https://gitlab.com': terminal prompts disabled");
            },
        });
        const strategy = gitReadStrategy();

        expect(await strategy.read(request, hostContext({ services: { "git.runner": git } }))).toEqual({
            ok: false,
            reason: "Permission denied (publickey); could not read Username for 'https://gitlab.com': terminal prompts disabled",
        });
        expect(strategy.fix?.(repository)).toBe("set up git access to gitlab.com (an SSH key, or a credential helper)");
        expect(await strategy.read(request, hostContext())).toEqual({ ok: false, reason: "git is not available" });
    });
});

describe("gitFailureReason()", () => {
    /**
     * The telling line wins, without git's prefixes; stderr and details are read too.
     *
     * gitFailureReason(Object.assign(new Error("git failed"), { stderr: "fatal: repository 'x' not found" }));
     * // -> "repository 'x' not found"
     */
    it("should pick the telling line, without prefixes", () => {
        expect(gitFailureReason(Object.assign(new Error("git failed"), { stderr: "fatal: repository 'x' not found\n" }))).toBe("repository 'x' not found");
        expect(gitFailureReason("plain")).toBe("plain");
    });
});
