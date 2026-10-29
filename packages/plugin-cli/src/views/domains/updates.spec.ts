import { describe, expect, it } from "vitest";
import type { CliViewContext } from "../../types.js";
import { Printer } from "../printer.js";
import { createStyle } from "../style.js";
import {
    describeLockDiff,
    describeUpdateScope,
    formatUpdatePlan,
    isEmptyUpdate,
    type LockDiffShape,
    type LockShowShape,
    type SubscriptionUpdateShape,
    type UpdatePlanShape,
    views,
} from "./updates.js";

/** A plain, 100-column view context; `render` shows nested results as `<intent>`. */
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
        render: async (other) => `<${other}>\n`,
    };
}

function diff(changes: Partial<LockDiffShape> = {}): LockDiffShape {
    const full = { added: [], removed: [], updated: [], reposAdded: [], reposRemoved: [], ...changes };
    const unchanged = full.added.length + full.removed.length + full.updated.length + full.reposAdded.length + full.reposRemoved.length === 0;

    return { ...full, unchanged };
}

function plan(overrides: Partial<UpdatePlanShape> = {}): UpdatePlanShape {
    return {
        scope: { kind: "all" },
        diff: diff(),
        missingRepos: [],
        newVariables: [],
        unreadable: [],
        unreachable: [],
        linked: [],
        builtIn: [],
        switchedOff: [],
        failed: [],
        cycles: [],
        ...overrides,
    };
}

/** Joins wrapped lines back up, so a test can look for a whole sentence. */
function flat(text: string): string {
    return text.replace(/\s+/g, " ");
}

const updated = diff({ updated: [{ key: "workflow/a", from: "1.0.0", to: "1.1.0" }] });

async function render(intent: string, result: unknown): Promise<string> {
    const output = await views[intent]!(result, context(intent));

    return flat(typeof output === "string" ? output : (output?.stdout ?? ""));
}

describe("describeUpdateScope()", () => {
    /** Each scope reads as a phrase: describeUpdateScope({ kind: "all" }) -> "every subscription in this project" */
    it("should name each kind of scope", () => {
        expect(describeUpdateScope({ kind: "all" })).toBe("every subscription in this project");
        expect(describeUpdateScope({ kind: "repository", repo: "r" })).toContain("the repository 'r'");
        expect(describeUpdateScope({ kind: "namespace", repo: "r", namespace: "workflow" })).toBe("the recipes in the namespace 'r:workflow'");
        expect(describeUpdateScope({ kind: "recipe", repo: "r", key: "workflow/x" })).toBe("the recipe 'r:workflow/x'");
    });
});

describe("isEmptyUpdate()", () => {
    it("should be true only when nothing changes and nothing needs trusting", () => {
        expect(isEmptyUpdate({ diff: diff(), missingRepos: [] })).toBe(true);
        expect(isEmptyUpdate({ diff: updated, missingRepos: [] })).toBe(false);
        expect(isEmptyUpdate({ diff: diff(), missingRepos: [{ name: "vendor", requiredBy: [] }] })).toBe(false);
    });
});

describe("describeLockDiff()", () => {
    /** The lines today's lock service wrote: "Updating workflow/a from version 1.0.0 to version 1.1.0". */
    it("should write one line per change, and 'Nothing changed.' for none", () => {
        expect(describeLockDiff(diff())).toEqual(["Nothing changed."]);
        expect(
            describeLockDiff(
                diff({
                    reposAdded: ["vendor"],
                    added: [{ key: "x/b", to: "2.0.0" }],
                    updated: [{ key: "x/a", from: "1.0.0", to: "1.1.0" }],
                    removed: [{ key: "x/c", from: "0.1.0" }],
                    reposRemoved: ["old"],
                }),
            ),
        ).toEqual([
            "Repository added: vendor",
            "Adding x/b version 2.0.0",
            "Updating x/a from version 1.0.0 to version 1.1.0",
            "Removing x/c, which nothing needs any more",
            "Repository no longer needed: old",
        ]);
    });
});

describe("formatUpdatePlan()", () => {
    const text = (facts: UpdatePlanShape) => flat(formatUpdatePlan(facts, context("recipe.update")).join("\n"));

    it("should say when there is nothing to update", () => {
        expect(text(plan())).toContain("Nothing to update");
    });

    it("should list each change under the scope", () => {
        const out = text(plan({ diff: updated }));

        expect(out).toContain("Updating every subscription in this project changes the lockfile:");
        expect(out).toContain("• Updating workflow/a from version 1.0.0 to version 1.1.0");
    });

    it("should name the repositories that need trusting", () => {
        const out = text(
            plan({ missingRepos: [{ name: "vendor", url: "https://github.com/acme/vendor", requiredBy: [{ ref: "vendor:x/y", requestedBy: "workflow/a" }] }] }),
        );

        expect(out).toContain("does not trust yet");
        expect(out).toContain("No pin moves until the repositories below are trusted and read.");
        expect(out).toContain("vendor at https://github.com/acme/vendor, needed by workflow/a");
    });

    it("should list the questions the new versions ask", () => {
        const out = text(plan({ diff: updated, newVariables: [{ recipe: "workflow/a", name: "TEAM" }] }));

        expect(out).toContain("Questions the new versions ask that nothing answers yet:");
        expect(out).toContain("workflow/a asks 1 question:");
        expect(out).toContain("--answer TEAM=<value>");
    });

    it("should note everything the update left alone", () => {
        const out = text(
            plan({
                diff: updated,
                unreachable: [{ repo: "far", reason: "No answer.\nMore detail." }],
                failed: [{ key: "workflow/b", reason: "Broken." }],
                linked: ["mine"],
                builtIn: [{ key: "core/sous-skills", version: "1.2.3" }],
                switchedOff: ["old"],
            }),
        );

        expect(out).toContain("The index of 'far' could not be fetched");
        expect(out).toContain("No answer.");
        expect(out).not.toContain("More detail.");
        expect(out).toContain("The subscription to 'workflow/b' could not be resolved");
        expect(out).toContain("The repository 'mine' is linked");
        expect(out).toContain("stays at version 1.2.3");
        expect(out).toContain("Switched off, so left alone: old.");
    });
});

describe("the recipe.update view", () => {
    it("should print the plan and say nothing was written", async () => {
        const out = await render("recipe.update", plan({ diff: updated }));

        expect(out).toContain("▶ Update plan:");
        expect(out).toContain("Updating workflow/a from version 1.0.0 to version 1.1.0");
        expect(out).toContain("Nothing was written.");
    });
});

describe("the subscription.update view", () => {
    function result(overrides: Partial<SubscriptionUpdateShape> = {}): SubscriptionUpdateShape {
        return { plan: plan({ diff: updated }), applied: true, nothingToUpdate: false, trusted: [], dryRun: false, followUps: [], ...overrides };
    }

    /** The plan was reported before the question, so an empty update prints nothing more. */
    it("should print nothing when there was nothing to update", async () => {
        expect(await render("subscription.update", result({ plan: plan(), applied: false, nothingToUpdate: true }))).toBe("");
    });

    it("should say a dry run wrote nothing", async () => {
        const out = await render("subscription.update", result({ applied: false, dryRun: true }));

        expect(out).toContain("Nothing was written. Run the same command without '--dry-run' to update every subscription in this project.");
    });

    it("should print the lockfile changes, trusted repositories, follow-ups and the closing sentence", async () => {
        const out = await render(
            "subscription.update",
            result({
                trusted: ["vendor"],
                plan: plan({ diff: updated, cycles: [["x/a", "x/b", "x/a"]] }),
                followUps: [
                    { intent: "vars.ask", result: {} },
                    { intent: "build", result: {} },
                ],
            }),
        );

        expect(out).toContain("➔ Lockfile:");
        expect(out).toContain("Lockfile: Updating workflow/a from version 1.0.0 to version 1.1.0");
        expect(out).toContain("Repositories trusted along the way: vendor.");
        expect(out).toContain("➔ Variables:");
        expect(out).toContain("<vars.ask>");
        expect(out).toContain("x/a -> x/b -> x/a");
        expect(out).toContain("The lockfile now pins the newest versions the ranges allow for every subscription in this project.");
        expect(out).not.toContain("The project was not rebuilt.");
        expect(out).toContain("<build>");
    });

    it("should say the project was not rebuilt when the build was skipped", async () => {
        const out = await render("subscription.update", result({ followUps: [{ intent: "build", skipped: "--no-build" }] }));

        expect(out).toContain("The project was not rebuilt.");
    });
});

describe("the lock.rebuild view", () => {
    /** The handler reports every change and its closing sentence itself. */
    it("should add nothing to what the handler reported", async () => {
        expect(await render("lock.rebuild", { diff: diff(), dryRun: true })).toBe("");
    });
});

describe("the lock.show view", () => {
    function lock(recipes: LockShowShape["recipes"]): LockShowShape {
        return { path: "/p/.sous/sous.lock.json", recipes };
    }

    /** sous lock show: the recipe, the version, the repository and who holds it. */
    it("should show what the lockfile pins and who holds it", async () => {
        const out = await render(
            "lock.show",
            lock([
                { key: "workflow/qa-variables", entry: { repo: "qa-recipes", version: "0.1.0", requestedBy: ["project"] }, active: true },
                {
                    key: "workflow/qa-helper",
                    entry: { repo: "qa-recipes", version: "0.1.0", requestedBy: ["workflow/qa-variables"] },
                    active: false,
                    skipped: { message: "Its subscription is switched off." },
                },
            ]),
        );

        expect(out).toContain("Recipe versions this project pins");
        expect(out).toMatch(/workflow\/qa-variables\s+0\.1\.0\s+qa-recipes\s+this project/);
        expect(out).toMatch(/workflow\/qa-helper\s+0\.1\.0\s+qa-recipes\s+workflow\/qa-variables/);
        expect(out).toContain("not built here: Its subscription is switched off.");
        expect(out.indexOf("workflow/qa-helper")).toBeLessThan(out.indexOf("workflow/qa-variables"));
        expect(out).toContain("This project's lockfile is /p/.sous/sous.lock.json.");
    });

    it("should say when nothing is pinned", async () => {
        expect(await render("lock.show", lock([]))).toContain("This project pins nothing yet. Its lockfile is /p/.sous/sous.lock.json.");
    });
});
