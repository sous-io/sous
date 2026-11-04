import { describe, expect, it } from "vitest";
import type { RecipeRequest, ResolveResult } from "../types.js";
import { NoVersionSatisfiesError } from "../part-b/resolver/resolve.js";
import { resolveTogether } from "./update-plan.js";

/** A request for one subscription, named by its key. */
function request(key: string): { key: string; request: RecipeRequest } {
    const [namespace, name] = key.split("/") as [string, string];

    return { key, request: { ref: { kind: "recipe", name, namespace: { kind: "namespace", name: namespace } }, requestedBy: "project", kind: "subscribes" } };
}

/** The subscription keys a set of requests asks for. */
const keysOf = (requests: readonly RecipeRequest[]): string[] => requests.map((asked) => (asked.ref.kind === "recipe" ? `${asked.ref.namespace?.name}/${asked.ref.name}` : asked.ref.name));

/** A result that resolves each asked key at 1.0.0. */
function resultOf(keys: readonly string[]): ResolveResult {
    return {
        resolved: keys.map((key) => ({ key, version: "1.0.0" }) as ResolveResult["resolved"][number]),
        missingRepos: [],
        unreadable: [],
        cycles: [],
    };
}

describe("resolveTogether()", () => {
    /**
     * Every subscription is resolved in one pass, so a recipe several of them reach gets one version
     * every holder's range allows.
     *
     * resolveTogether([w/a, w/b]) // -> one resolve call with both; resolved [w/a, w/b]
     */
    it("should resolve every subscription in one pass", async () => {
        const calls: string[][] = [];
        const together = await resolveTogether([request("w/a"), request("w/b")], async (asked) => {
            calls.push(keysOf(asked));

            return resultOf(keysOf(asked));
        });

        expect(calls).toEqual([["w/a", "w/b"]]);
        expect(together.resolved).toEqual(["w/a", "w/b"]);
        expect(together.failed).toEqual([]);
    });

    /**
     * When no version of a shared recipe satisfies two holders, the subscriptions are added one at a
     * time; the one that cannot join is refused, naming each holder and its range, and the others
     * still resolve.
     *
     * w/b needs lib/x@^2 while w/a needs lib/x@^1
     * // -> resolved [w/a, w/c]; failed w/b: "... '^1' from 'w/a', '^2' from 'w/b'."
     */
    it("should refuse only the subscription that conflicts, naming each holder and its range", async () => {
        const together = await resolveTogether([request("w/a"), request("w/b"), request("w/c")], async (asked) => {
            const keys = keysOf(asked);

            if (keys.includes("w/a") && keys.includes("w/b")) {
                throw new NoVersionSatisfiesError(
                    "lib/x",
                    [
                        { range: "^1", requestedBy: "w/a" },
                        { range: "^2", requestedBy: "w/b" },
                    ],
                    "No published version of 'lib/x' satisfies what was asked for.",
                    { details: [] },
                );
            }

            return resultOf(keys);
        });

        expect(together.resolved).toEqual(["w/a", "w/c"]);
        expect(together.result.resolved.map((recipe) => recipe.key)).toEqual(["w/a", "w/c"]);
        expect(together.failed).toEqual([
            { key: "w/b", reason: "No published version of 'lib/x' satisfies every recipe that needs it: '^1' from 'w/a', '^2' from 'w/b'." },
        ]);
    });

    /** Nothing to resolve resolves nothing: resolveTogether([]) -> an empty result, no call. */
    it("should resolve nothing when there are no subscriptions", async () => {
        let called = false;
        const together = await resolveTogether([], async () => {
            called = true;

            return resultOf([]);
        });

        expect(called).toBe(false);
        expect(together.result.resolved).toEqual([]);
    });
});
