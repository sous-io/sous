import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BufferedReporter, nonInteractivePrompter, scriptedPrompter, type IntentInput, type Prompter } from "@sous-io/plugin-api";
import type { RepoLinkResult, RepoUnlinkResult } from "@sous-io/plugin-recipes/types";
import type { SousRef } from "@sous-io/plugin-refs/types";
import { commitAll, git, initRepo, makeTmpDir, writeFile, type TmpDir } from "../../test/support/git-repo.js";
import { memoryLinks, testTools } from "../../test/support/standins.js";
import type { RepoSubmitResult } from "../types.js";
import { commandLine, runContribute, startStep, submitStep, unlinkStep, type IntentRunner } from "./contribute.js";

describe("startStep()", () => {
    /**
     * Starting links the repository with `--latest` on a new branch whose name is generated when none
     * was named.
     *
     * ```ts
     * commandLine(startStep("sous-recipes", { ref: "sous-recipes" }));
     * // "sous repo link sous-recipes --latest --generate-branch"
     * ```
     */
    it("should link with --latest on a generated branch by default", () => {
        const step = startStep("sous-recipes", { ref: "sous-recipes" });

        expect(step.intent).toBe("repo.link");
        expect(step.input).toEqual({ repo: "sous-recipes", latest: true, generateBranch: true });
        expect(commandLine(step)).toBe("sous repo link sous-recipes --latest --generate-branch");
    });

    /** A named branch replaces the generated one, and the rest of the link flags pass through. */
    it("should pass a named branch and the link flags through", () => {
        expect(commandLine(startStep("r", { ref: "r", createBranch: "fix", from: "dev", global: true, yes: true }))).toBe(
            "sous repo link r --latest --from dev --global --yes --create-branch fix",
        );
        expect(startStep("r", { ref: "r", branch: "existing" }).input).toEqual({ repo: "r", latest: true, branch: "existing" });
    });
});

describe("submitStep()", () => {
    /** The proposal flags pass through, and `--yes` only when given, so an unanswered question is still asked. */
    it("should pass the submit flags through, and --yes only when given", () => {
        expect(submitStep("r", { ref: "r", title: "T", draft: true }).input).toEqual({ repo: "r", title: "T", draft: true });
        expect(submitStep("r", { ref: "r", title: "T", body: "B", branch: "b", commit: true, yes: true, remove: true }).input).toEqual({
            repo: "r",
            title: "T",
            body: "B",
            branch: "b",
            commit: true,
            yes: true,
        });
    });
});

describe("unlinkStep()", () => {
    /** Finishing always unlinks with `--update`, and passes `--remove`, `--global` and `--yes` through. */
    it("should unlink with --update and pass its flags through", () => {
        expect(unlinkStep("r", { ref: "r" }).input).toEqual({ repo: "r", update: true });
        expect(commandLine(unlinkStep("r", { ref: "r", remove: true, global: true, yes: true }))).toBe("sous repo unlink r --update --remove --global --yes");
        expect(unlinkStep("r", { ref: "r", remove: true }).running).toContain("deleting the checkout");
    });
});

describe("commandLine()", () => {
    /**
     * A step reads as the command line that would run it, an argument holding a space or a quote
     * quoted for a shell.
     */
    it("should write a step as a quoted command line", () => {
        expect(commandLine(submitStep("r", { ref: "r", title: "It's done" }))).toBe("sous repo submit r --title 'It'\\''s done'");
    });
});

describe("runContribute()", () => {
    let tmp: TmpDir;
    let checkout: string;
    let ran: Array<{ intent: string; input: unknown }>;

    /** The repository the stand-in lookups know, by its short name. */
    const known: SousRef[] = [
        { kind: "repo", name: "sous-recipes" },
        { kind: "recipe", name: "task-files", namespace: { kind: "namespace", name: "workflow", repo: { kind: "repo", name: "sous-recipes" } } },
    ];

    beforeEach(() => {
        tmp = makeTmpDir("sous-contribute-run-");
        const upstream = path.join(tmp.path, "upstream");
        const seed = path.join(tmp.path, "seed");

        checkout = path.join(tmp.path, "checkout");
        git(tmp.path, "init", "--quiet", "--bare", "--initial-branch", "main", upstream);
        git(tmp.path, "init", "--quiet", "--initial-branch", "main", seed);
        initRepo(seed);
        writeFile(seed, "README.md", "readme\n");
        commitAll(seed, "first commit");
        git(seed, "push", "--quiet", upstream, "main");
        git(tmp.path, "clone", "--quiet", upstream, checkout);
        initRepo(checkout);
        git(checkout, "switch", "--quiet", "-c", "change");
        ran = [];
    });

    afterEach(() => {
        tmp.cleanup();
    });

    /** Runs the steps as the stand-in intents, recording each. */
    const runner = (submitted: Partial<RepoSubmitResult> = {}): IntentRunner =>
        (async (intent: string, input: IntentInput<"repo.link">) => {
            ran.push({ intent, input });

            if (intent === "repo.link") {
                return { repo: "sous-recipes", path: checkout, origin: "clone", scope: "project", cloned: true, branch: "sous/edit-1", trusted: [], dryRun: false } satisfies RepoLinkResult;
            }

            if (intent === "repo.unlink") {
                return { repo: "sous-recipes", path: checkout, scope: "project", removedCheckout: false, dryRun: false, followUps: [] } satisfies RepoUnlinkResult;
            }

            return { repo: "sous-recipes", branch: "change", fromFork: false, committed: false, pushed: true, created: true, updated: false, dryRun: false, outcome: "created", proposalNoun: "pull request", refusing: [], completed: [], ...submitted };
        }) as IntentRunner;

    /** The tools, with the checkout linked in this project. */
    const tools = (prompter: Prompter = nonInteractivePrompter) =>
        testTools({
            known,
            prompter,
            reporter: new BufferedReporter(),
            links: memoryLinks([{ repo: "sous-recipes", path: checkout, origin: "clone", linkedAt: "now", scope: "project" }]),
        });

    /** Starting runs one step, `repo.link`, on a generated branch. */
    it("should start by linking the repository a recipe ref names", async () => {
        const result = await runContribute(tools(), { ref: "workflow/task-files" }, runner());

        expect(result.stage).toBe("linked");
        expect(result.repo).toBe("sous-recipes");
        expect(ran).toEqual([{ intent: "repo.link", input: { repo: "sous-recipes", latest: true, generateBranch: true } }]);
        expect(result.completed).toEqual(["Linked 'sous-recipes' on a new branch"]);
    });

    /** A dry run lists the step and runs nothing. */
    it("should run nothing on a dry run", async () => {
        const result = await runContribute(tools(), { ref: "sous-recipes", dryRun: true }, runner());

        expect(ran).toEqual([]);
        expect(result.steps).toEqual(["sous repo link sous-recipes --latest --generate-branch"]);
    });

    /** Finishing a branch with work no proposal carries submits it with --submit, then unlinks. */
    it("should submit pending work and unlink when finishing", async () => {
        writeFile(checkout, "change.md", "change\n");
        commitAll(checkout, "a change");

        const result = await runContribute(tools(), { ref: "sous-recipes", finish: true, submit: true, title: "T", body: "B" }, runner());

        expect(result.stage).toBe("finished");
        expect(ran.map((entry) => entry.intent)).toEqual(["repo.submit", "repo.unlink"]);
        expect(ran[0]!.input).toEqual({ repo: "sous-recipes", title: "T", body: "B" });
        expect(result.verdict).toContain("has never been pushed");
    });

    /** --no-submit finishes without submitting; the checkout keeps the work. */
    it("should only unlink with --no-submit", async () => {
        writeFile(checkout, "change.md", "change\n");
        commitAll(checkout, "a change");

        await runContribute(tools(), { ref: "sous-recipes", finish: true, submit: false }, runner());

        expect(ran.map((entry) => entry.intent)).toEqual(["repo.unlink"]);
    });

    /** Without --submit or --no-submit the person is asked; with nothing to ask, the error names both flags (L4). */
    it("should ask whether to submit, naming the flags that answer it", async () => {
        writeFile(checkout, "change.md", "change\n");
        commitAll(checkout, "a change");

        await expect(runContribute(tools(), { ref: "sous-recipes", finish: true }, runner())).rejects.toThrow(/--submit[\s\S]*--no-submit/);

        await runContribute(tools(scriptedPrompter([true])), { ref: "sous-recipes", finish: true }, runner());
        expect(ran.map((entry) => entry.intent)).toEqual(["repo.submit", "repo.unlink"]);
    });

    /** A branch with nothing of its own skips the submission. */
    it("should skip submitting when there is nothing to submit", async () => {
        const result = await runContribute(tools(), { ref: "sous-recipes", finish: true }, runner());

        expect(ran.map((entry) => entry.intent)).toEqual(["repo.unlink"]);
        expect(result.verdict).toContain("nothing to submit");
    });

    /** A branch whose every commit was pushed is judged by its proposal, looked up through `repo.submit --status`. */
    it("should look the proposal up for a branch that was pushed", async () => {
        writeFile(checkout, "change.md", "change\n");
        commitAll(checkout, "a change");
        git(checkout, "push", "--quiet", "origin", "change");

        const result = await runContribute(
            tools(),
            { ref: "sous-recipes", finish: true },
            runner({ outcome: "status", proposal: { id: "7", state: "open", title: "T", draft: false } }),
        );

        expect(ran[0]).toEqual({ intent: "repo.submit", input: { repo: "sous-recipes", branch: "change", status: true } });
        expect(ran.map((entry) => entry.intent)).toEqual(["repo.submit", "repo.unlink"]);
        expect(result.verdict).toContain("already in its open pull request");
    });

    /** A failed step says which had completed. */
    it("should say which steps completed when one fails", async () => {
        const failing = (async (intent: string) => {
            throw new Error(`${intent} broke`);
        }) as IntentRunner;

        await expect(runContribute(tools(), { ref: "sous-recipes", finish: true }, failing)).rejects.toThrow(
            /repo\.unlink broke[\s\S]*Failed step: [\s\S]*had completed before it[^\n]*\n {4}Looked for work/,
        );
    });

    /** Finishing a repository linked only in the other scope says where it is linked. */
    it("should name the other scope when the repository is not linked in this one", async () => {
        await expect(runContribute(tools(), { ref: "sous-recipes", finish: true, global: true }, runner())).rejects.toThrow(
            /not linked in the machine-wide links map[\s\S]*without --global/,
        );
    });

    /** Flags that only start a contribution are refused with --finish, and the reverse. */
    it("should refuse flags that mean nothing together", async () => {
        await expect(runContribute(tools(), { ref: "r", finish: true, createBranch: "x" }, runner())).rejects.toThrow(/--create-branch only starts/);
        await expect(runContribute(tools(), { ref: "r", title: "T" }, runner())).rejects.toThrow(/--title only applies when finishing/);
        await expect(runContribute(tools(), { ref: "r", branch: "a", createBranch: "b" }, runner())).rejects.toThrow(/cannot be used together/);
    });
});
