import { describe, expect, it } from "vitest";
import type { IndexFile, Lockfile } from "@sous-io/plugin-formats/types";
import { indexFile } from "../../../test/part-b/helpers.js";
import { plainSubscriptionKey } from "../lock/reachable.js";
import { explainMissing, type ExplainInput } from "./explain-missing.js";

const HASH = "sha256-0" as const;

const LOCK: Lockfile = {
    formatVersion: 1,
    repos: { acme: { url: "https://fake.test/acme/recipes", identity: "fake.test/acme/recipes" } },
    recipes: { "workflow/set": { repo: "acme", version: "2.0.0", hash: HASH, requestedBy: ["project"], kind: "subscribes" } },
};

/** An index where workflow/set 1.0.0 declared workflow/member, which declared workflow/library. */
function published(): IndexFile {
    return indexFile("acme", {
        "workflow/set": {
            versions: {
                "1.0.0": { hash: HASH, dependencies: { "workflow/member": { version: "1.0.0" } } },
                "2.0.0": { hash: HASH },
            },
        },
        "workflow/member": { versions: { "1.0.0": { hash: HASH, dependencies: { "workflow/library": { version: "1.0.0" } } } } },
        "workflow/library": { versions: { "1.0.0": { hash: HASH } } },
    });
}

function input(overrides: Partial<ExplainInput> = {}): ExplainInput {
    return {
        subscriptions: {},
        keyOf: plainSubscriptionKey,
        lockfile: () => LOCK,
        cachedIndex: (identity) => (identity === "fake.test/acme/recipes" ? published() : undefined),
        ...overrides,
    };
}

describe("explainMissing()", () => {
    it("should name a switched-off subscription to the recipe or its namespace", () => {
        expect(explainMissing("tools/lint", input({ subscriptions: { "tools/lint": { enabled: false } } }))).toEqual({ by: "disabled-subscription", subscription: "tools/lint" });
        expect(explainMissing("tools/lint", input({ subscriptions: { tools: { enabled: false } } }))).toEqual({ by: "disabled-subscription", subscription: "tools" });
    });

    it("should name the earlier version of a pinned recipe that brought it in", () => {
        expect(explainMissing("workflow/member", input())).toEqual({ by: "recipe", recipe: "workflow/set", declaredAt: "1.0.0", pinned: "2.0.0" });
    });

    it("should name the recipes the chain ran through", () => {
        expect(explainMissing("workflow/library", input())).toEqual({ by: "recipe", recipe: "workflow/set", declaredAt: "1.0.0", pinned: "2.0.0", through: ["workflow/member"] });
    });

    it("should say nothing when nothing explains it, or the lockfile cannot be read", () => {
        expect(explainMissing("tools/unknown", input())).toBeUndefined();
        expect(
            explainMissing(
                "workflow/member",
                input({
                    lockfile: () => {
                        throw new Error("damaged");
                    },
                }),
            ),
        ).toBeUndefined();
    });
});
