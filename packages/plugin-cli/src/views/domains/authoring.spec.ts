import { describe, expect, it } from "vitest";
import { type CapturedView, type CaptureOptions, captureView } from "../testing.js";
import { type ContributeResultShape, type SubmitResultShape, views } from "./authoring.js";

/** Runs a view and returns what a terminal would get (both streams, colors off). */
async function run(intent: string, result: unknown, options: CaptureOptions = {}): Promise<CapturedView & { text: string }> {
    const shown = await captureView(views[intent]!, result, { intent, ...options });

    return { ...shown, text: shown.stdout + shown.stderr };
}

/** Matches a label and its value however the reporter separates them. */
function fact(label: string, value: string): RegExp {
    const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    return new RegExp(`${escape(label)}[ :]*${escape(value)}`);
}

const submitted: SubmitResultShape = {
    repo: "acme/recipes",
    branch: "fix-typo",
    fromFork: false,
    dryRun: false,
    outcome: "created",
    host: "github",
    proposalNoun: "pull request",
    baseBranch: "main",
    pushedTo: "origin",
    title: "Fix a typo",
    proposal: { url: "https://github.com/acme/recipes/pull/7", title: "Fix a typo" },
};

describe("the authoring views", () => {
    /** Releasing and scaffolding report every line as they run, so their views add nothing. */
    it("should print nothing more for repo release and repo init", async () => {
        expect((await run("repo.release", { ok: true, plan: [] })).text).toBe("");
        expect((await run("repo.init", { directory: "/x", files: [] })).text).toBe("");
    });

    /** `repo submit` closes with the proposal's facts, as today's command did. */
    it("should close repo submit with the proposal's facts", async () => {
        const { text } = await run("repo.submit", submitted);
        const flat = text.replace(/ +/g, " ");

        expect(flat).toContain("The pull request that was opened");
        expect(flat).toMatch(fact("Provider", "github"));
        expect(flat).toMatch(fact("Repository", "acme/recipes"));
        expect(flat).toMatch(fact("Branch", "fix-typo"));
        expect(flat).toMatch(fact("Target branch", "main"));
        expect(flat).toMatch(fact("Pushed to", "origin"));
        expect(flat).toMatch(fact("Through a fork", "false"));
        expect(flat).toMatch(fact("Title", "Fix a typo"));
        expect(flat).toMatch(fact("Address", "https://github.com/acme/recipes/pull/7"));
    });

    /** A dry run pushed nothing and opened nothing; an update names the branch. */
    it("should describe a dry run and an update", async () => {
        const dry = (await run("repo.submit", { ...submitted, dryRun: true, proposal: undefined, committedPaths: ["a.md", "b.md"] })).text.replace(/ +/g, " ");

        expect(dry).toContain("The pull request this would open");
        expect(dry).toMatch(fact("Pushed to", "(nothing was pushed)"));
        expect(dry).toMatch(fact("Committed", "a.md, b.md"));
        expect(dry).toMatch(fact("Address", "(not opened yet)"));

        const updated = (await run("repo.submit", { ...submitted, outcome: "updated", proposal: { title: "Fix" } })).text;

        expect(updated).toContain("The pull request for 'fix-typo'");
        expect(updated).toContain("(the provider printed no address)");
    });

    /** A status look-up and a cancelled run reported everything already. */
    it("should print nothing more for a status look-up or a cancelled submit", async () => {
        expect((await run("repo.submit", { ...submitted, outcome: "status" })).text).toBe("");
        expect((await run("repo.submit", { ...submitted, outcome: "cancelled" })).text).toBe("");
    });

    /** Contributing shows each step's own view in order, then what a start completed. */
    it("should show each step of repo contribute through its own view", async () => {
        const shownIntents: string[] = [];
        const options: CaptureOptions = {
            show: async (intent) => {
                shownIntents.push(intent);
            },
        };
        const started: ContributeResultShape = { stage: "linked", link: { repo: "acme" }, dryRun: false, completed: ["Linked acme"] };
        const start = await run("repo.contribute", started, options);

        expect(shownIntents).toEqual(["repo.link"]);
        expect(start.text).toContain("What this run did");
        expect(start.text).toContain("Linked acme");

        shownIntents.length = 0;

        const finished: ContributeResultShape = { stage: "finished", submit: submitted, unlink: { repo: "acme" }, dryRun: false, completed: ["a", "b"] };
        const finish = await run("repo.contribute", finished, options);

        expect(shownIntents).toEqual(["repo.submit", "repo.unlink"]);
        expect(finish.text).not.toContain("What this run did");

        shownIntents.length = 0;

        expect((await run("repo.contribute", { stage: "linked", dryRun: true, completed: [] }, options)).text).toBe("");
        expect(shownIntents).toEqual([]);
    });
});
