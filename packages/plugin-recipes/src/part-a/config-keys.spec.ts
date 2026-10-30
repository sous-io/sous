import { describe, expect, it } from "vitest";
import { configKeys, isRepoUrl } from "./config-keys.js";

/** The problems one key's schema finds in a value, each as `path: message`. */
function problems(key: "repos" | "subscriptions" | "store", value: unknown): string[] {
    const entity = configKeys().find((entry) => entry.id === key)!;
    const result = entity.schema["~standard"].validate(value) as { issues?: ReadonlyArray<{ path?: ReadonlyArray<PropertyKey | { key: PropertyKey }>; message: string }> };

    return (result.issues ?? []).map((issue) => `${(issue.path ?? []).map((part) => String(typeof part === "object" ? part.key : part)).join(".")}: ${issue.message}`);
}

/**
 * The `repos`, `subscriptions` and `store` keys, ported from the old `src/lib/config-schema.spec.ts`
 * ("Repositories keys"): what each accepts, and the plain-language problem each mistake names.
 */
describe("the repos, subscriptions and store config keys", () => {
    /**
     * Entries written by hand or by `sous repo add` and `sous subscribe` validate.
     *
     * repos: { "sous-recipes": { url, provider, alwaysPull, addedAt, addedBy } } // -> no problems
     */
    it("should accept repos, subscriptions and store together", () => {
        expect(
            problems("repos", {
                "sous-recipes": { url: "https://github.com/sous-io/sous-recipes", provider: "github", alwaysPull: false, addedAt: "2026-09-09T14:03:11.482Z", addedBy: "user" },
                local: { url: "/home/me/recipes" },
                ssh: { url: "git@github.com:acme/recipes.git" },
            }),
        ).toEqual([]);
        expect(
            problems("subscriptions", {
                core: { range: "*", prerelease: false },
                "workflow/task-files": { range: "^1.2.0", prerelease: true, alwaysPull: true, addedAt: "2026-09-09T14:03:11.482Z", addedBy: "user", enabled: false },
            }),
        ).toEqual([]);
        expect(problems("store", { maxBytes: 1073741824, freshnessSeconds: 0, watchPollSeconds: 300 })).toEqual([]);
    });

    /**
     * A repo entry needs somewhere to fetch from.
     *
     * repos: { "sous-recipes": {} } // -> "sous-recipes.url: Required, but missing."
     */
    it("should require a url on a repo entry", () => {
        expect(problems("repos", { "sous-recipes": {} }).join("\n")).toContain("sous-recipes.url");
        expect(problems("repos", { "sous-recipes": { url: "sous-io/sous-recipes" } }).join("\n")).toContain("sous-recipes.url: must be a repository URL");
        expect(isRepoUrl("https://gitlab.com/a/b/c")).toBe(true);
        expect(isRepoUrl("C:\\recipes")).toBe(true);
    });

    /**
     * Repo keys are the short names refs use as their `repo:` qualifier.
     *
     * repos: { "Sous Recipes": { url } } // -> "invalid key; a repo name must be lowercase kebab-case"
     */
    it("should refuse a repo key that is not a usable short name", () => {
        expect(problems("repos", { "Sous Recipes": { url: "https://example.com/x" } }).join("\n")).toContain("invalid key; a repo name must be lowercase kebab-case");
    });

    /**
     * A subscription key is a namespace or a namespace and recipe; the range belongs in the entry.
     *
     * subscriptions: { "sous-recipes:workflow": {} } // -> "a subscription key must be a namespace"
     */
    it("should refuse a subscription key carrying a qualifier or a range", () => {
        expect(problems("subscriptions", { "sous-recipes:workflow": {} }).join("\n")).toContain("a subscription key must be a namespace");
        expect(problems("subscriptions", { "workflow/task-files@^1.0.0": {} }).join("\n")).toContain("a subscription key must be a namespace");
    });

    /**
     * The range is checked with npm's own rules.
     *
     * subscriptions: { "workflow/task-files": { range: "latest" } } // -> "workflow/task-files.range: ..."
     */
    it("should refuse a subscription range that is not a range", () => {
        expect(problems("subscriptions", { "workflow/task-files": { range: "latest" } }).join("\n")).toContain("workflow/task-files.range");
    });

    /**
     * Store numbers are whole, and a zero-byte cap is not a cap.
     *
     * store: { maxBytes: 0 } // -> "maxBytes: must be a whole number of bytes, above zero"
     */
    it("should refuse nonsense store settings", () => {
        expect(problems("store", { maxBytes: 0 }).join("\n")).toContain("maxBytes");
        expect(problems("store", { freshnessSeconds: -1 }).join("\n")).toContain("freshnessSeconds");
        expect(problems("store", { watchPollSeconds: 1.5 }).join("\n")).toContain("watchPollSeconds");
    });

    /**
     * Unknown keys inside an entry are typos, as everywhere else.
     *
     * repos: { "sous-recipes": { url, trusted: true } } // -> "sous-recipes.trusted: Not a known key."
     */
    it("should refuse unknown keys inside a repo, subscription or store entry", () => {
        expect(problems("repos", { "sous-recipes": { url: "https://example.com/x", trusted: true } }).join("\n")).toContain("sous-recipes.trusted: Not a known key.");
        expect(problems("subscriptions", { workflow: { pinned: "1.0.0" } }).join("\n")).toContain("workflow.pinned: Not a known key.");
        expect(problems("store", { maxSize: 10 }).join("\n")).toContain("maxSize: Not a known key.");
    });
});
