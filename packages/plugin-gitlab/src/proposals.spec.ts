import { describe, expect, it } from "vitest";
import { fakeProcesses, hostContext, type ProcessAnswer } from "@sous-io/repository-hosts/testing";
import { buildGitlabPipeline, gitlabCiFiles } from "./ci.js";
import { createGitlabHost } from "./host.js";
import { statusOf } from "./proposals.js";

const host = createGitlabHost();
const repository = host.canonicalize("https://gitlab.example.org/acme/recipes");

function withGlab(answer: (args: readonly string[]) => ProcessAnswer) {
    const processes = fakeProcesses({ installed: ["glab"], answer: (_command, args) => answer(args) });

    return { processes, ctx: hostContext({ services: { "host.processes": processes } }) };
}

describe("gitlab proposals", () => {
    /**
     * A merge request is opened by `glab mr create` for the repository, on its instance
     * (`GITLAB_HOST`), and its address reported.
     *
     * proposeChange(repo, { branch: "fix", base: "main", title, body, draft: true })
     * // glab mr create --repo acme/recipes --source-branch fix --target-branch main ... --yes --draft
     * // -> { url, detail: "The merge request is at <url>." }
     */
    it("should open a merge request and report its address", async () => {
        const { processes, ctx } = withGlab(() => ({ stdout: "Creating merge request\nhttps://gitlab.example.org/acme/recipes/-/merge_requests/4\n" }));
        const made = await host.proposeChange!(repository, { branch: "fix", base: "main", title: "T", body: "B", draft: true }, ctx);

        expect(made).toEqual({
            url: "https://gitlab.example.org/acme/recipes/-/merge_requests/4",
            detail: "The merge request is at https://gitlab.example.org/acme/recipes/-/merge_requests/4.",
        });
        expect(processes.runs[0]?.args).toEqual([
            "mr", "create", "--repo", "acme/recipes", "--source-branch", "fix", "--target-branch", "main",
            "--title", "T", "--description", "B", "--yes", "--draft",
        ]);
        expect(processes.runs[0]?.options?.env).toMatchObject({ GITLAB_HOST: "gitlab.example.org" });
    });

    /**
     * A refused merge request is a ConfigError carrying what glab said.
     *
     * // glab exits 1 "branch not pushed" -> "'glab mr create' did not succeed, so no proposal was opened."
     */
    it("should raise a ConfigError when the merge request is refused", async () => {
        const { ctx } = withGlab(() => ({ exitCode: 1, stderr: "branch not pushed" }));

        await expect(host.proposeChange!(repository, { branch: "fix", title: "T", body: "B", draft: false }, ctx)).rejects.toThrow(
            "'glab mr create' did not succeed, so no proposal was opened.",
        );
    });

    /**
     * glab is required only here: a missing glab says how to install it.
     *
     * // glab not installed -> "The GitLab CLI ('glab') is not installed."
     */
    it("should say how to install glab when it is missing", async () => {
        const ctx = hostContext({ services: { "host.processes": fakeProcesses({}) } });

        await expect(host.proposeChange!(repository, { branch: "fix", title: "T", body: "B", draft: false }, ctx)).rejects.toThrow("The GitLab CLI ('glab') is not installed.");
        expect((await host.authStatus!(ctx)).ok).toBe(false);
    });

    /**
     * Sous cannot tell whether you may push on GitLab, and does not fork for you.
     *
     * canPush(repo) // -> undefined; fork(repo) // -> ConfigError with the manual route
     */
    it("should answer that it cannot tell whether you may push, and refuse to fork", async () => {
        const ctx = hostContext();

        expect(await host.canPush!(repository, ctx)).toBeUndefined();
        await expect(host.fork!(repository, ctx)).rejects.toThrow("Sous does not fork acme/recipes for you on the GitLab CLI");
    });

    /**
     * The merge request of a branch is found by `glab mr list --source-branch`; the open one wins,
     * and one from a fork is matched by its author.
     *
     * findProposal(repo, { branch: "fix", fromFork: false }) // -> { id: "5", state: "open", ... }
     */
    it("should find the merge request a branch was pushed for", async () => {
        const listed = JSON.stringify([
            { iid: 3, state: "closed", title: "old", source_project_id: 1, target_project_id: 1 },
            { iid: 5, state: "opened", title: "new", web_url: "u5", draft: true, target_branch: "main", source_project_id: 1, target_project_id: 1 },
            { iid: 7, state: "opened", title: "fork", source_project_id: 9, target_project_id: 1, author: { username: "me" } },
        ]);
        const { processes, ctx } = withGlab(() => ({ stdout: listed }));

        expect(await host.findProposal!(repository, { branch: "fix", fromFork: false }, ctx)).toEqual({
            id: "5",
            url: "u5",
            state: "open",
            title: "new",
            draft: true,
            base: "main",
        });
        expect(processes.runs[0]?.args).toEqual(["mr", "list", "--repo", "acme/recipes", "--source-branch", "fix", "--all", "--per-page", "50", "--output", "json"]);
        expect((await host.findProposal!(repository, { branch: "fix", fromFork: true, forkOwner: "me" }, ctx))?.id).toBe("7");
        expect(await host.findProposal!(repository, { branch: "fix", fromFork: true, forkOwner: "you" }, ctx)).toBeUndefined();
    });

    /**
     * A fork's owner defaults to the signed-in user, from `glab api user`.
     *
     * // glab api user -> { username: "me" } -> the fork's merge request by "me"
     */
    it("should ask glab who is signed in when the fork owner is not given", async () => {
        const { ctx } = withGlab((args) =>
            args[0] === "api" ? { stdout: '{"username":"me"}' } : { stdout: JSON.stringify([{ iid: 7, state: "merged", title: "f", source_project_id: 9, target_project_id: 1, author: { username: "me" } }]) },
        );

        expect(await host.findProposal!(repository, { branch: "fix", fromFork: true }, ctx)).toMatchObject({ id: "7", state: "merged" });
    });

    /**
     * Status maps the pipeline, the merge status and approvals onto plain words.
     *
     * statusOf({ iid: 1, head_pipeline: { status: "running" }, detailed_merge_status: "not_approved" })
     * // -> { review: "review required", checks: { passed: 0, failed: 0, pending: 1 } }
     */
    it("should report status as plain data", async () => {
        expect(statusOf({ iid: 1, state: "opened", head_pipeline: { status: "running" }, detailed_merge_status: "not_approved" })).toEqual({
            proposal: { id: "1", state: "open", title: "", draft: false },
            review: "review required",
            checks: { passed: 0, failed: 0, pending: 1 },
        });
        expect(statusOf({ iid: 2, head_pipeline: { status: "success" }, merge_status: "can_be_merged" })).toMatchObject({ checks: { passed: 1 }, mergeable: true });
        expect(statusOf({ iid: 3, has_conflicts: true })).toMatchObject({ mergeable: false });

        const { processes, ctx } = withGlab(() => ({ stdout: '{"iid":4,"state":"merged","title":"t"}' }));

        expect((await host.proposalStatus!(repository, "4", ctx)).proposal.state).toBe("merged");
        expect(processes.runs[0]?.args).toEqual(["mr", "view", "4", "--repo", "acme/recipes", "--output", "json"]);
    });

    /**
     * Updating edits only the fields given.
     *
     * updateProposal(repo, "4", { title: "New" }) // glab mr update 4 --repo acme/recipes --title New
     */
    it("should edit only the fields it was given", async () => {
        const { processes, ctx } = withGlab(() => ({ stdout: "" }));

        expect(await host.updateProposal!(repository, "4", { title: "New" }, ctx)).toEqual({ detail: "The merge request was updated." });
        expect(processes.runs[0]?.args).toEqual(["mr", "update", "4", "--repo", "acme/recipes", "--title", "New"]);
    });
});

describe("gitlabCiFiles()", () => {
    /**
     * A GitLab scaffold gets `.gitlab-ci.yml`: a check on merge requests and a release on the
     * default branch, pushing with SOUS_RELEASE_TOKEN.
     *
     * gitlabCiFiles({ name: "r", sousVersion: "1.0.0" }) // -> [{ path: ".gitlab-ci.yml", content }]
     */
    it("should write a pipeline that checks merge requests and releases the default branch", () => {
        const files = gitlabCiFiles({ name: "r", sousVersion: "1.0.0" });

        expect(files.map((file) => file.path)).toEqual([".gitlab-ci.yml"]);
        expect(files[0]?.content).toBe(buildGitlabPipeline());
        expect(buildGitlabPipeline()).toContain("npx --yes @sous-io/sous repo release --check");
        expect(buildGitlabPipeline()).toContain("npx --yes @sous-io/sous repo release --ci --push --yes");
        expect(buildGitlabPipeline()).toContain('$CI_PIPELINE_SOURCE == "merge_request_event"');
        expect(buildGitlabPipeline()).toContain("SOUS_RELEASE_TOKEN");
        expect(host.scaffoldFiles).toBe(gitlabCiFiles);
    });
});
