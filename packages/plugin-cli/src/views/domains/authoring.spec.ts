import { describe, expect, it } from "vitest";
import type { CliViewContext } from "../../types.js";
import { Printer } from "../printer.js";
import { createStyle } from "../style.js";
import { type ContributeResultShape, type SubmitResultShape, views } from "./authoring.js";

/** A view context with no color, 100 columns, and a stand-in for other intents' views. */
function context(intent: string): CliViewContext {
    const style = createStyle(false);

    return {
        intent,
        input: {},
        globals: {},
        style,
        columns: 100,
        isTTY: false,
        printer: () => new Printer(style, 100, false),
        render: async (other, result) => (other === "repo.submit" ? ((views["repo.submit"]!(result, context(other)) as string | undefined) ?? "") : `[${other}]\n`),
    };
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
        expect(await views["repo.release"]!({ ok: true, plan: [] }, context("repo.release"))).toBeUndefined();
        expect(await views["repo.init"]!({ directory: "/x", files: [] }, context("repo.init"))).toBeUndefined();
    });

    /**
     * sous repo submit
     * // ▶ The pull request that was opened:
     * //     Repository    : acme/recipes ...
     */
    it("should close repo submit with the proposal's facts, as today's command did", async () => {
        const text = (await views["repo.submit"]!(submitted, context("repo.submit"))) as string;

        expect(text.split("\n")).toEqual([
            " ",
            "▶ The pull request that was opened:",
            " ",
            "    Provider      : github",
            "    Repository    : acme/recipes",
            "    Branch        : fix-typo",
            "    Target branch : main",
            "    Pushed to     : origin",
            "    Through a fork: false",
            "    Title         : Fix a typo",
            "    Address       : https://github.com/acme/recipes/pull/7",
            "",
        ]);
    });

    /** A dry run pushed nothing and opened nothing; an update names the branch. */
    it("should describe a dry run and an update", async () => {
        const dry = (await views["repo.submit"]!({ ...submitted, dryRun: true, proposal: undefined, committedPaths: ["a.md", "b.md"] }, context("repo.submit"))) as string;

        expect(dry).toContain("▶ The pull request this would open:");
        expect(dry).toContain("Pushed to     : (nothing was pushed)");
        expect(dry).toContain("Committed     : a.md, b.md");
        expect(dry).toContain("Address       : (not opened yet)");

        const updated = (await views["repo.submit"]!({ ...submitted, outcome: "updated", proposal: { title: "Fix" } }, context("repo.submit"))) as string;

        expect(updated).toContain("▶ The pull request for 'fix-typo':");
        expect(updated).toContain("(the provider printed no address)");
    });

    /** A status look-up and a cancelled run reported everything already. */
    it("should print nothing more for a status look-up or a cancelled submit", async () => {
        expect(await views["repo.submit"]!({ ...submitted, outcome: "status" }, context("repo.submit"))).toBeUndefined();
        expect(await views["repo.submit"]!({ ...submitted, outcome: "cancelled" }, context("repo.submit"))).toBeUndefined();
    });

    /** Contributing shows each step's own view in order, then what a start completed. */
    it("should show each step of repo contribute through its own view", async () => {
        const started: ContributeResultShape = { stage: "linked", link: { repo: "acme" }, dryRun: false, completed: ["Linked acme"] };
        const start = (await views["repo.contribute"]!(started, context("repo.contribute"))) as string;

        expect(start.startsWith("[repo.link]\n")).toBe(true);
        expect(start).toContain("▶ What this run did:");
        expect(start).toContain("    • Linked acme");

        const finished: ContributeResultShape = { stage: "finished", submit: submitted, unlink: { repo: "acme" }, dryRun: false, completed: ["a", "b"] };
        const finish = (await views["repo.contribute"]!(finished, context("repo.contribute"))) as string;

        expect(finish).toContain("▶ The pull request that was opened:");
        expect(finish.indexOf("pull request")).toBeLessThan(finish.indexOf("[repo.unlink]"));
        expect(finish).not.toContain("What this run did");

        expect(await views["repo.contribute"]!({ stage: "linked", dryRun: true, completed: [] }, context("repo.contribute"))).toBeUndefined();
    });
});
