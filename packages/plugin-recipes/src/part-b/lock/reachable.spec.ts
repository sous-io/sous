import { describe, expect, it } from "vitest";
import type { Lockfile } from "@sous-io/plugin-formats/types";
import { plainSubscriptionKey, reachability } from "./reachable.js";

const HASH = `sha256-${"b".repeat(64)}` as const;
const pin = (requestedBy: string[], repo = "acme") => ({ repo, version: "1.0.0", hash: HASH, requestedBy, kind: "subscribes" as const });

const lockfile: Lockfile = {
    formatVersion: 1,
    repos: { acme: { url: "https://github.com/acme/r" }, other: { url: "https://github.com/o/r" } },
    recipes: {
        "tools/browser": pin(["project"]),
        "tools/lib": pin(["tools/browser"]),
        "workflow/tasks": pin(["project"]),
        "workflow/helper": pin(["workflow/tasks"]),
        "x/remote": pin(["project"], "other"),
        "y/orphan": pin(["gone/recipe"]),
    },
};
const repos = { acme: { url: "https://github.com/acme/r" }, other: { url: "https://github.com/o/r" } };

describe("plainSubscriptionKey", () => {
    it("should strip a repository qualifier, a range and a trailing /*", () => {
        expect(plainSubscriptionKey("acme:workflow/task-files@^1")).toBe("workflow/task-files");
        expect(plainSubscriptionKey("workflow/*")).toBe("workflow");
        expect(plainSubscriptionKey("core")).toBe("core");
    });
});

describe("reachability", () => {
    it("should reach only what switched-on subscriptions hold, through holder lists", () => {
        const result = reachability({ lockfile, repos, subscriptions: { workflow: {}, "x/remote": {} } });

        expect(result.reached).toEqual(["workflow/helper", "workflow/tasks", "x/remote"]);
    });

    it("should skip a switched-off subscription's recipes, saying which file switched it off", () => {
        const result = reachability({
            lockfile,
            repos,
            subscriptions: { "tools/browser": { enabled: false }, workflow: {} },
            setBy: () => "conf.d/610-mac.jsonc",
        });
        const browser = result.skipped.find((entry) => entry.key === "tools/browser");

        expect(result.reached).not.toContain("tools/browser");
        expect(browser).toMatchObject({ reason: "subscription-disabled", subscription: "tools/browser", setBy: "conf.d/610-mac.jsonc" });
        expect(browser?.message).toBe("Skipped tools/browser: its subscription is switched off (conf.d/610-mac.jsonc).");
        expect(result.skipped.find((entry) => entry.key === "tools/lib")?.reason).toBe("not-reached");
    });

    it("should skip recipes of a switched-off or untrusted repository", () => {
        const result = reachability({ lockfile, repos: { acme: { url: "u", enabled: false } }, subscriptions: { workflow: {}, "x/remote": {} } });

        expect(result.reached).toEqual([]);
        expect(result.skipped.find((entry) => entry.key === "workflow/tasks")?.reason).toBe("repository-disabled");
        expect(result.skipped.find((entry) => entry.key === "x/remote")?.reason).toBe("untrusted");
    });

    it("should use the key function given, and ignore keys it cannot read", () => {
        const result = reachability({
            lockfile,
            repos,
            subscriptions: { "WORKFLOW": {}, bad: {} },
            keyOf: (key) => {
                if (key === "bad") {
                    throw new Error("no");
                }

                return key.toLowerCase();
            },
        });

        expect(result.reached).toEqual(["workflow/helper", "workflow/tasks"]);
    });
});

describe("reachability, narrower entries", () => {
    it("should keep a recipe switched off inside a namespace subscription that is on", () => {
        const lockfile = {
            formatVersion: 1 as const,
            repos: { acme: { url: "https://fake.test/acme/recipes" } },
            recipes: {
                "workflow/alpha": { repo: "acme", version: "1.0.0", hash: "sha256-a" as const, requestedBy: ["project"], kind: "subscribes" as const },
                "workflow/beta": { repo: "acme", version: "1.0.0", hash: "sha256-b" as const, requestedBy: ["project"], kind: "subscribes" as const },
            },
        };
        const result = reachability({
            lockfile,
            subscriptions: { workflow: {}, "workflow/beta": { enabled: false } },
            repos: { acme: { url: "https://fake.test/acme/recipes" } },
        });

        expect(result.reached).toEqual(["workflow/alpha"]);
        expect(result.skipped.map((entry) => [entry.key, entry.reason])).toEqual([["workflow/beta", "subscription-disabled"]]);
    });
});
