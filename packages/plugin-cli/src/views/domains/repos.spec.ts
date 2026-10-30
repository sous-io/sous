import { describe, expect, it } from "vitest";
import type { CliViewOutput } from "../../types.js";
import { captureView } from "../testing.js";
import { describeLatest, describePinned, describeSize, lockDiffLines, views } from "./repos.js";

const EMPTY_DIFF = { added: [], removed: [], updated: [], reposAdded: [], reposRemoved: [], unchanged: true };

/** What a run showed: the text of both streams, the exit code, and the follow-up views it asked for. */
interface Shown {
    readonly text: string;
    readonly stdout: string;
    readonly stderr: string;
    readonly output: CliViewOutput;
    /** The intents `view.show` was called for, in order, with their results. */
    readonly shown: Array<{ intent: string; result: unknown }>;
}

async function show(intent: string, result: unknown, input: Record<string, unknown> = {}): Promise<Shown> {
    const shown: Array<{ intent: string; result: unknown }> = [];
    const captured = await captureView(views[intent]!, result, {
        intent,
        input,
        show: async (nested, nestedResult) => {
            shown.push({ intent: nested, result: nestedResult });
        },
    });
    const text = `${captured.stdout}\n${captured.stderr}`;

    // Wrapped paragraphs are compared with their line breaks and indentation folded to one space.
    return { text: `${text}\n${text.replace(/\s+/g, " ")}`, stdout: captured.stdout, stderr: captured.stderr, output: captured.exitCode === undefined ? undefined : { exitCode: captured.exitCode }, shown };
}

describe("lockDiffLines()", () => {
    /**
     * A lockfile diff reads as one sentence per change, as today's lock service wrote it.
     *
     * lockDiffLines({ added: [{ key: "core/a", to: "1.0.0" }], ... }); // ["Adding core/a version 1.0.0"]
     */
    it("should describe every change, and say when nothing changed", () => {
        expect(
            lockDiffLines({
                added: [{ key: "w/b", to: "2.0.0" }, { key: "w/a", to: "1.0.0" }],
                updated: [{ key: "w/c", from: "1.0.0", to: "1.1.0" }],
                removed: [{ key: "w/d", from: "1.0.0" }],
                reposAdded: ["acme"],
                reposRemoved: ["old"],
                unchanged: false,
            }),
        ).toEqual([
            "Repository added: acme",
            "Adding w/a version 1.0.0",
            "Adding w/b version 2.0.0",
            "Updating w/c from version 1.0.0 to version 1.1.0",
            "Removing w/d, which nothing needs any more",
            "Repository no longer needed: old",
        ]);
        expect(lockDiffLines(EMPTY_DIFF)).toEqual(["Nothing changed."]);
    });
});

describe("describeSize()", () => {
    it("should show bytes, then kilobytes and up", () => {
        expect(describeSize(512)).toBe("512 bytes");
        expect(describeSize(2048)).toBe("2.0 KB");
        expect(describeSize(3 * 1024 * 1024)).toBe("3.0 MB");
    });
});

describe("repo.add", () => {
    /**
     * sous repo add https://github.com/acme/recipes
     * // ->     Repository: recipes ... This project now trusts 'recipes'.
     */
    it("should show the repository it trusted and what it publishes", async () => {
        const { text } = await show("repo.add", { name: "recipes", url: "https://github.com/acme/recipes", provider: "github", alreadyTrusted: false, namespaces: ["workflow", "core"], recipeCount: 3, dryRun: false });

        expect(text).toContain("Adding a repository");
        expect(text).toMatch(/Repository\s*:\s*recipes/);
        expect(text).toMatch(/Namespaces\s*:\s*workflow, core/);
        expect(text).toMatch(/Recipes\s*:\s*3/);
        expect(text).toContain("This project now trusts 'recipes'. Nothing from it has been installed.");
        expect(text).not.toContain("\u001b[");
    });

    it("should say a repository already trusted was only refreshed, and a dry run what it would do", async () => {
        const base = { name: "r", url: "u", provider: "github", namespaces: [], recipeCount: 0 };

        expect((await show("repo.add", { ...base, alreadyTrusted: true, dryRun: false })).text).toContain("none; this repository publishes nothing yet");
        expect((await show("repo.add", { ...base, alreadyTrusted: true, dryRun: false })).text).toContain("already trusted 'r', so only its index was refreshed");

        const dry = (await show("repo.add", { ...base, alreadyTrusted: false, dryRun: true })).text;

        expect(dry).toContain("Nothing will be trusted, written or downloaded.");
        expect(dry).toContain("would be added as 'r', read through the github provider");
    });
});

describe("repo.remove", () => {
    const base = { name: "acme", url: "u", optedOut: false, subscriptions: [], keptSubscriptions: [], removedRecipes: [], outputs: [], linkIsGlobal: false };

    it("should show the lockfile change, what stayed, and the build that followed", async () => {
        const { text, shown } = await show("repo.remove", {
            ...base,
            stayed: [{ key: "w/kept", heldBy: ["core"] }],
            diff: { ...EMPTY_DIFF, removed: [{ key: "w/gone", from: "1.0.0" }], unchanged: false },
            dryRun: false,
            followUps: [{ intent: "build", result: { ok: true } }],
        });

        expect(text).toContain("Lockfile");
        expect(text).toContain("Removing w/gone, which nothing needs any more");
        expect(text).toContain("What stayed, and why");
        expect(text).toMatch(/w\/kept\s+core/);
        expect(text).toContain("This project no longer trusts 'acme'.");
        expect(text).not.toContain("Run 'sous build' to prune");
        expect(shown).toEqual([{ intent: "build", result: { ok: true } }]);
    });

    it("should fail when the build that followed failed, and hint at a build when none ran", async () => {
        const failed = await show("repo.remove", { ...base, stayed: [], diff: EMPTY_DIFF, dryRun: false, followUps: [{ intent: "build", result: { ok: false } }] });

        expect(failed.output).toMatchObject({ exitCode: 1 });
        expect(failed.stderr).toContain("was removed, but the build that followed it failed");

        const opted = await show("repo.remove", { ...base, optedOut: true, stayed: [], diff: EMPTY_DIFF, dryRun: false, followUps: [{ intent: "build", skipped: "--no-build" }] });

        expect(opted.text).toContain("Nothing changed; nothing was locked because of this repository.");
        expect(opted.text).toContain("switched off rather than deleted");
        expect(opted.text).toContain("Run 'sous build' to prune what it used to write.");
    });
});

describe("repo.trust", () => {
    it("should say whether the repository is now trusted", async () => {
        const base = { name: "acme", url: "https://x", alreadyTrusted: false, dryRun: false };

        expect((await show("repo.trust", { ...base, trusted: true })).text).toContain("This project now trusts 'acme'.");
        expect((await show("repo.trust", { ...base, trusted: true, alreadyTrusted: true })).text).toContain("already trusts 'acme'");
        expect((await show("repo.trust", { ...base, trusted: false, dryRun: true })).text).toContain("without '--dry-run' to trust 'acme'");
    });
});

describe("repo.gc", () => {
    it("should show the counts, the sizes and every evicted entry", async () => {
        const entry = { repo: "github.com/acme/r", namespace: "w", name: "t", version: "1.0.0", lastAccessAt: "2026-01-01", sizeBytes: 4096 };
        const { text } = await show("repo.gc", { evicted: [entry], kept: [entry, entry], bytesBefore: 12288, bytesAfter: 8192, dryRun: false });

        expect(text).toContain("Collecting the recipe store");
        expect(text).toMatch(/Entries before\s*:\s*3/);
        expect(text).toMatch(/Entries evicted\s*:\s*1/);
        expect(text).toMatch(/Size before\s*:\s*12\.0 KB/);
        expect(text).toMatch(/w\/t\s+1\.0\.0\s+4\.0 KB/);
        expect(text).toContain("re-fetchable from the lockfile that pins it; the next build");
    });

    it("should say nothing was removed when the store fits", async () => {
        expect((await show("repo.gc", { evicted: [], kept: [], bytesBefore: 0, bytesAfter: 0, dryRun: true })).text).toContain("already inside its size cap");
    });
});

describe("repo.link and repo.unlink", () => {
    it("should show where the link points", async () => {
        const { text } = await show("repo.link", { repo: "acme", path: "/src/acme", origin: "clone", scope: "project", cloned: true, branch: "main", trusted: [], dryRun: false });

        expect(text).toContain("Linking a repository");
        expect(text).toMatch(/Checkout\s*:\s*\/src\/acme/);
        expect(text).toMatch(/Branch\s*:\s*main/);
    });

    /** What was done, the links map, and how a reused checkout compares with upstream, as the old command printed them. */
    it("should show what was done and how the checkout compares with upstream", async () => {
        const { text } = await show("repo.link", {
            repo: "acme",
            path: "/src/acme",
            origin: "clone",
            scope: "project",
            cloned: false,
            branch: "main",
            trusted: [],
            dryRun: false,
            notes: ["Reused the checkout already at /src/acme; nothing was cloned."],
            recordedIn: "/p/.sous/sous.links.json",
            upstream: { upstream: "origin/main", merged: true, behind: 1 },
        });

        expect(text).toContain("Reused the checkout already at /src/acme");
        expect(text).toMatch(/Recorded in\s*:\s*\/p\/.sous\/sous.links.json/);
        expect(text).toMatch(/Merged into origin\/main\s*:\s*yes/);
        expect(text).toMatch(/Behind origin\/main\s*:\s*1 commit\b/);
        expect(text).toContain("nothing in the checkout was changed");
    });

    /** A dry run lists what it would do. */
    it("should list what a dry run would do", async () => {
        const link = await show("repo.link", { repo: "acme", path: "/src/acme", origin: "clone", scope: "project", cloned: false, trusted: [], dryRun: true, wouldDo: ["would link 'acme' to /src/acme"] });
        const unlink = await show("repo.unlink", { repo: "acme", path: "/src/acme", scope: "global", removedCheckout: false, dryRun: true, followUps: [], wouldDo: ["the checkout itself would be left where it is"] });

        expect(link.text).toContain("would link 'acme' to /src/acme");
        expect(unlink.text).toContain("the checkout itself would be left where it is");
    });

    it("should show the unlinked checkout, the pin update and the build", async () => {
        const { text, shown } = await show("repo.unlink", {
            repo: "acme",
            path: "/src/acme",
            scope: "global",
            removedCheckout: false,
            dryRun: false,
            followUps: [
                { intent: "subscription.update", result: { applied: true } },
                { intent: "build", result: { ok: true } },
            ],
        });

        expect(text).toContain("Unlinking a repository");
        expect(text).toContain("every project on this machine");
        expect(text).toContain("Updating the pins");
        expect(shown).toEqual([
            { intent: "subscription.update", result: { applied: true } },
            { intent: "build", result: { ok: true } },
        ]);
    });
});

describe("subscription.add", () => {
    it("should show what was installed and why, the lockfile, the answers and the build", async () => {
        const { text, shown } = await show("subscription.add", {
            ref: "workflow/task-files",
            key: "workflow/task-files",
            resolved: [
                { key: "workflow/task-files", repo: "acme", version: "1.2.0", kind: "subscribes", requestedBy: ["project"] },
                { key: "workflow/helpers", repo: "acme", version: "0.1.0", kind: "depends", requestedBy: ["workflow/task-files"] },
            ],
            trusted: ["acme"],
            diff: { ...EMPTY_DIFF, added: [{ key: "workflow/task-files", to: "1.2.0" }], unchanged: false },
            unreadable: [],
            cycles: [["a", "b", "a"]],
            dryRun: false,
            followUps: [
                { intent: "vars.ask", result: {} },
                { intent: "build", result: { ok: true } },
            ],
        });

        expect(text).toContain("What was installed");
        expect(text).toMatch(/workflow\/task-files\s+1\.2\.0\s+acme\s+you subscribed to it/);
        expect(text).toMatch(/needed by workflow\/task-files/);
        expect(text).toContain("Repositories trusted along the way: acme.");
        expect(text).toContain("Adding workflow/task-files version 1.2.0");
        expect(text).toContain("co-subscribe to each other in a circle");
        expect(text).toContain("a -> b -> a");
        expect(text).toContain("Variables");
        expect(shown.map((entry) => entry.intent)).toEqual(["vars.ask", "build"]);
        expect(text).not.toContain("Run 'sous build' to compile");
    });

    it("should say a dry run wrote nothing", async () => {
        const { text } = await show("subscription.add", { key: "k", resolved: [], trusted: [], diff: EMPTY_DIFF, cycles: [], dryRun: true, followUps: [{ intent: "build", skipped: "--dry-run" }] });

        expect(text).toContain("Nothing will be downloaded, written or asked.");
        expect(text).toContain("What would be installed");
        expect(text).toContain("Nothing changed; everything asked for was already locked.");
        expect(text).toContain("without '--dry-run' to install it");
    });
});

describe("subscription.remove", () => {
    it("should show the lockfile change and what removing it means", async () => {
        const { text } = await show("subscription.remove", { key: "w/t", diff: EMPTY_DIFF, stayed: [], optedOut: false, dryRun: false, followUps: [{ intent: "build", skipped: "--no-build" }] });

        expect(text).toContain("Unsubscribing");
        expect(text).toContain("Nothing changed; nothing was locked because of this subscription.");
        expect(text).toContain("The subscription to 'w/t' is gone.");
        expect(text).toContain("Run 'sous build' to prune what it used to write.");
    });
});

describe("subscription.enable and subscription.disable", () => {
    it("should say whether the subscription was switched", async () => {
        const base = { key: "w/t", file: "/p/.sous/conf.d/510-subscriptions.jsonc", dryRun: false, followUps: [] };
        const on = (await show("subscription.enable", { ...base, enabled: true, changed: true })).text;

        expect(on).toContain("Enabling a subscription");
        expect(on).toContain("is now switched on");
        expect((await show("subscription.disable", { ...base, enabled: false, changed: false })).text).toContain("was already switched off; nothing changed");
    });
});

describe("subscription.list", () => {
    const listings = [
        { key: "core", range: undefined, enabled: true, addedBy: "sous", pinned: [{ key: "core/sous-skills", version: "0.2.34" }] },
        { key: "workflow/task-files", range: "^1.0.0", enabled: false, addedBy: undefined, pinned: [], newer: [] },
    ];

    it("should list every subscription with its range, pins, latest version, origin and whether it is on", async () => {
        const { text } = await show("subscription.list", listings);

        expect(text).toContain("Subscriptions");
        expect(text).toMatch(/Subscription\s+Range\s+Pinned version\s+Latest version\s+Origin\s+Enabled/);
        expect(text).toMatch(/core\s+any version\s+core\/sous-skills 0\.2\.34\s+0\.2\.34\s+built in\s+yes/);
        expect(text).toMatch(/workflow\/task-files\s+\^1\.0\.0\s+not pinned\s+user\s+no/);
    });

    it("should show the latest versions with --latest, and only installed ones with --installed", async () => {
        const latest = (await show("subscription.list", [{ ...listings[0]!, newer: [{ key: "core/sous-skills", version: "0.3.0" }] }], { latest: true })).text;

        expect(latest).toMatch(/Latest version/);
        expect(latest).toContain("0.3.0");

        const installed = (await show("subscription.list", listings, { installed: true })).text;

        expect(installed).toContain("Installed version");
        expect(installed).not.toContain("workflow/task-files");
        expect((await show("subscription.list", [], {})).text).toContain("This project subscribes to nothing yet.");
    });

    it("should describe pins and latest versions as today's list did", () => {
        expect(describePinned([], true)).toBe("pinned on first build");
        expect(describePinned([], false)).toBe("not pinned");
        expect(describeLatest({ key: "w", range: undefined, enabled: true, addedBy: undefined, pinned: [{ key: "w/a", version: "1.0.0" }, { key: "w/b", version: "1.0.0" }], newer: [{ key: "w/b", version: "1.1.0" }] })).toBe("w/a 1.0.0, w/b 1.1.0");
    });
});
