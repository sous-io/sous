import { describe, expect, it } from "vitest";
import { fakeProcesses, hostContext, type ProcessAnswer } from "@sous-io/repository-hosts/testing";
import { buildReleaseWorkflow, githubWorkflowFiles } from "./ci.js";
import { createGithubHost } from "./host.js";
import { checksOf } from "./proposals.js";

const host = createGithubHost();
const repository = host.canonicalize("https://github.com/owner/recipes");

/** A context whose gh answers by its first two arguments, `"pr create"`. */
function withGh(answers: Record<string, ProcessAnswer>) {
    const processes = fakeProcesses({ installed: ["gh"], answer: (_command, args) => answers[args.slice(0, 2).join(" ")] ?? { exitCode: 1, stderr: "unscripted" } });

    return { processes, ctx: hostContext({ services: { "host.processes": processes } }) };
}

describe("github write path", () => {
    /**
     * authStatus reports `gh auth status` as yes or no, with the whole explanation when no.
     *
     * host.authStatus(ctx); // -> { ok: true, detail: "the GitHub CLI ('gh') is installed and signed in." }
     */
    it("should report whether the GitHub CLI is installed and signed in", async () => {
        expect((await host.authStatus!(withGh({ "auth status": {} }).ctx)).ok).toBe(true);

        const refused = await host.authStatus!(withGh({ "auth status": { exitCode: 1 } }).ctx);

        expect(refused.ok).toBe(false);
        expect(refused.detail).toContain("https://cli.github.com");
        expect(refused.detail).toContain("gh auth login");
    });

    /**
     * canPush turns GitHub's answer into a boolean, or undefined when gh could not answer.
     *
     * // gh api repos/owner/recipes --jq .permissions.push -> "true\n" -> true
     */
    it("should read push permission from the host, and admit when it cannot", async () => {
        const allowed = withGh({ "api repos/owner/recipes": { stdout: "true\n" } });

        expect(await host.canPush!(repository, allowed.ctx)).toBe(true);
        expect(await host.canPush!(repository, withGh({ "api repos/owner/recipes": { stdout: "false\n" } }).ctx)).toBe(false);
        expect(await host.canPush!(repository, withGh({ "api repos/owner/recipes": { exitCode: 1 } }).ctx)).toBeUndefined();
        expect(allowed.processes.runs[0]?.args).toContain(".permissions.push");
    });

    /**
     * fork forks without touching git remotes, reads the login, and reports where the fork landed.
     *
     * host.fork(repo, ctx); // -> { owner: "contributor", httpsUrl: "https://github.com/contributor/recipes.git", ... }
     */
    it("should fork onto the contributor's account and report where it landed", async () => {
        const { processes, ctx } = withGh({ "repo fork": {}, "api user": { stdout: "contributor\n" } });

        expect(await host.fork!(repository, ctx)).toEqual({
            owner: "contributor",
            name: "recipes",
            httpsUrl: "https://github.com/contributor/recipes.git",
            sshUrl: "git@github.com:contributor/recipes.git",
        });
        expect(processes.runs[0]?.args).toContain("--remote=false");
    });

    /**
     * A fork that did not succeed is an error carrying what gh said.
     *
     * // gh repo fork exits 1 "forking is disabled here" -> ConfigError with that line
     */
    it("should raise a ConfigError when the fork does not succeed", async () => {
        const error = (await host.fork!(repository, withGh({ "repo fork": { exitCode: 1, stderr: "forking is disabled here" } }).ctx).catch((caught: unknown) => caught)) as Error & {
            details: string[];
        };

        expect(error.message).toBe("'gh repo fork' did not succeed.");
        expect(error.details).toEqual(["forking is disabled here"]);
    });

    /**
     * proposeChange opens a pull request and spells a fork's head as `owner:branch`.
     *
     * host.proposeChange(repo, { branch: "work", head: { owner: "contributor" }, ... })
     * // -> { url: "https://github.com/owner/recipes/pull/7", detail: "The pull request is at ..." }
     */
    it("should open a pull request and report its address", async () => {
        const { processes, ctx } = withGh({ "pr create": { stdout: "https://github.com/owner/recipes/pull/7\n" } });
        const made = await host.proposeChange!(repository, { branch: "work", base: "main", title: "T", body: "B", draft: true, head: { owner: "contributor" } }, ctx);

        expect(made).toEqual({ url: "https://github.com/owner/recipes/pull/7", detail: "The pull request is at https://github.com/owner/recipes/pull/7." });
        expect(processes.runs[0]?.args).toEqual([
            "pr", "create", "--repo", "owner/recipes", "--base", "main", "--head", "contributor:work", "--title", "T", "--body", "B", "--draft",
        ]);
    });

    /**
     * Without a fork, the head is the branch itself; a refusal is a ConfigError; GitHub
     * Enterprise gets GH_HOST.
     *
     * // --head work; refused -> "'gh pr create' did not succeed, so no proposal was opened."
     */
    it("should use the branch as the head, explain a refusal and point gh at Enterprise", async () => {
        const { processes, ctx } = withGh({ "pr create": { stdout: "opened\n" } });

        expect(await host.proposeChange!(repository, { branch: "work", title: "T", body: "B", draft: false }, ctx)).toEqual({
            detail: "The pull request was opened, but 'gh' printed no address for it.",
        });
        expect(processes.runs[0]?.args).toContain("work");

        await expect(
            host.proposeChange!(repository, { branch: "work", title: "T", body: "B", draft: false }, withGh({ "pr create": { exitCode: 1, stderr: "no" } }).ctx),
        ).rejects.toThrow("'gh pr create' did not succeed, so no proposal was opened.");

        const enterprise = withGh({ "pr create": { stdout: "" } });

        await host.proposeChange!({ ...repository, host: "ghe.example.com" }, { branch: "w", title: "T", body: "B", draft: false }, enterprise.ctx);
        expect(enterprise.processes.runs[0]?.options?.env).toMatchObject({ GH_HOST: "ghe.example.com" });
    });
});

describe("github proposals", () => {
    const listed = (entries: unknown[]) => ({ stdout: JSON.stringify(entries) });

    /**
     * findProposal lists the branch's pull requests in every state, keeps those from the
     * repository itself, and prefers the open one.
     *
     * host.findProposal(repo, { branch: "b", fromFork: false }); // -> { id: "3", state: "open", ... }
     */
    it("should find the open pull request a branch was pushed for", async () => {
        const { processes, ctx } = withGh({
            "pr list": listed([
                { number: 2, state: "CLOSED", title: "old", isCrossRepository: false },
                { number: 3, url: "https://github.com/owner/recipes/pull/3", state: "OPEN", title: "Add a skill", isDraft: true, baseRefName: "main", isCrossRepository: false },
                { number: 4, state: "OPEN", title: "a fork's", isCrossRepository: true, headRepositoryOwner: { login: "someone" } },
            ]),
        });

        expect(await host.findProposal!(repository, { branch: "b", fromFork: false }, ctx)).toEqual({
            id: "3",
            url: "https://github.com/owner/recipes/pull/3",
            state: "open",
            title: "Add a skill",
            draft: true,
            base: "main",
        });
        expect(processes.runs[0]?.args).toEqual(expect.arrayContaining(["--head", "b", "--state", "all"]));
    });

    /**
     * A fork's pull request is matched by its owner, asked of gh when not given; with none open,
     * the newest wins; none at all is undefined.
     *
     * // api user -> "contributor"; PRs 5 (closed) and 6 (merged) from contributor -> id "6"
     */
    it("should match a fork's pull request by its owner, newest first", async () => {
        const { ctx } = withGh({
            "api user": { stdout: "contributor\n" },
            "pr list": listed([
                { number: 5, state: "CLOSED", title: "a", isCrossRepository: true, headRepositoryOwner: { login: "contributor" } },
                { number: 6, state: "MERGED", title: "b", isCrossRepository: true, headRepositoryOwner: { login: "contributor" } },
                { number: 7, state: "OPEN", title: "c", isCrossRepository: true, headRepositoryOwner: { login: "other" } },
            ]),
        });

        expect(await host.findProposal!(repository, { branch: "b", fromFork: true }, ctx)).toMatchObject({ id: "6", state: "merged" });
        expect(await host.findProposal!(repository, { branch: "b", fromFork: true, forkOwner: "nobody" }, ctx)).toBeUndefined();
    });

    /**
     * A failed listing is a ConfigError.
     *
     * // gh pr list exits 1 -> "'gh pr list' did not succeed."
     */
    it("should raise a ConfigError when gh cannot list pull requests", async () => {
        await expect(host.findProposal!(repository, { branch: "b", fromFork: false }, withGh({ "pr list": { exitCode: 1, stderr: "auth" } }).ctx)).rejects.toThrow(
            "'gh pr list' did not succeed.",
        );
    });

    /**
     * proposalStatus reports review, checks and mergeability as plain data.
     *
     * // reviewDecision APPROVED, one passing and one pending check -> { review: "approved", checks: { passed: 1, pending: 1 } }
     */
    it("should report review and checks as plain data", async () => {
        const { ctx } = withGh({
            "pr view": {
                stdout: JSON.stringify({
                    number: 3,
                    state: "OPEN",
                    title: "t",
                    reviewDecision: "APPROVED",
                    mergeable: "MERGEABLE",
                    statusCheckRollup: [
                        { __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" },
                        { __typename: "CheckRun", status: "IN_PROGRESS" },
                        { __typename: "StatusContext", state: "FAILURE" },
                    ],
                }),
            },
        });

        expect(await host.proposalStatus!(repository, "3", ctx)).toEqual({
            proposal: { id: "3", state: "open", title: "t", draft: false },
            review: "approved",
            checks: { passed: 1, failed: 1, pending: 1 },
            mergeable: true,
        });
        expect(checksOf([])).toBeUndefined();
    });

    /**
     * updateProposal edits only the fields given.
     *
     * host.updateProposal(repo, "3", { body: "new" }); // gh pr edit 3 --repo owner/recipes --body new
     */
    it("should edit only the fields it was given", async () => {
        const { processes, ctx } = withGh({ "pr edit": { stdout: "https://github.com/owner/recipes/pull/3\n" } });

        expect(await host.updateProposal!(repository, "3", { body: "new" }, ctx)).toEqual({
            url: "https://github.com/owner/recipes/pull/3",
            detail: "The pull request at https://github.com/owner/recipes/pull/3 was updated.",
        });
        expect(processes.runs[0]?.args).toEqual(["pr", "edit", "3", "--repo", "owner/recipes", "--body", "new"]);
    });
});

describe("githubWorkflowFiles()", () => {
    /**
     * A GitHub scaffold gets `.github/workflows/sous-release.yml`: validate pull requests, publish on
     * merge to main, as before the refactor.
     *
     * githubWorkflowFiles({ name: "r", sousVersion: "1.0.0" }) // -> [{ path: ".github/workflows/sous-release.yml", content }]
     */
    it("should write the release workflow", () => {
        const files = githubWorkflowFiles({ name: "r", sousVersion: "1.0.0" });

        expect(files.map((file) => file.path)).toEqual([".github/workflows/sous-release.yml"]);
        expect(files[0]?.content).toBe(buildReleaseWorkflow());
        expect(buildReleaseWorkflow()).toMatch(/^# Release automation for this sous recipe repository\./);
        expect(buildReleaseWorkflow()).toContain("run: npx --yes @sous-io/sous repo release --check");
        expect(buildReleaseWorkflow()).toContain("run: npx --yes @sous-io/sous repo release --ci --push --yes");
        expect(host.scaffoldFiles).toBe(githubWorkflowFiles);
    });
});
