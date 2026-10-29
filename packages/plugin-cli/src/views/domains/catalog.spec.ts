import { describe, expect, it } from "vitest";
import type { CliViewContext } from "../../types.js";
import { Printer } from "../printer.js";
import { createStyle } from "../style.js";
import {
    describeCoverage,
    describeDependencyKind,
    describeOrigin,
    describeVersionStatus,
    firstSentence,
    noDestinationText,
    type NamespaceDetailShape,
    type RecipeDetailShape,
    type RecipeListingShape,
    views,
} from "./catalog.js";

/** A plain, 100-column context for one intent and input. */
function context(intent: string, input: Record<string, unknown> = {}, options: { color?: boolean; columns?: number; tty?: boolean } = {}): CliViewContext {
    const style = createStyle(options.color ?? false);
    const columns = options.columns ?? 100;
    const isTTY = options.tty ?? false;

    return {
        intent,
        input,
        globals: {},
        style,
        columns,
        isTTY,
        printer: () => new Printer(style, columns, isTTY),
        render: async () => "",
    };
}

async function show(intent: string, result: unknown, input: Record<string, unknown> = {}, options = {}): Promise<string> {
    return String(await views[intent]!(result, context(intent, input, options)));
}

const helper: RecipeListingShape = { key: "workflow/qa-helper", repo: "qa-recipes", latest: "0.1.0", subscribed: false, description: "Helps" };
const variables: RecipeListingShape = { key: "workflow/qa-variables", repo: "qa-recipes", latest: "0.1.0", pinned: "0.1.0", subscribed: true };

describe("the catalog views", () => {
    describe("wording", () => {
        /** The catalog's words become the ones a person reads, as today. */
        it("should word coverage, version status, dependency kinds, origins and destinations", () => {
            expect(describeCoverage("whole namespace")).toBe("the whole namespace");
            expect(describeCoverage("some recipes")).toBe("some recipes");
            expect(describeCoverage("none")).toBe("no");
            expect(describeVersionStatus("latest and pinned")).toBe("the latest version, and the one pinned here");
            expect(describeVersionStatus("latest")).toBe("the latest version");
            expect(describeVersionStatus("pinned")).toBe("the version pinned here");
            expect(describeVersionStatus("other")).toBe("an earlier version");
            expect(describeDependencyKind("depends")).toBe("build dependency");
            expect(describeDependencyKind("subscribes")).toBe("co-subscription");
            expect(describeDependencyKind(undefined)).toBe("not recorded");
            expect(describeOrigin("sous")).toBe("built in");
            expect(describeOrigin(undefined)).toBe("user");
            expect(describeOrigin("core/x")).toBe("required by core/x");
            expect(noDestinationText("memories")).toContain("include line");
            expect(firstSentence("One. Two.")).toBe("One.");
        });
    });

    describe("namespace list", () => {
        /**
         * sous namespace list
         * // ▶ Namespaces in the repositories this project trusts:
         * //   workflow  qa-recipes  2  some recipes  ...
         */
        it("should print a table of namespaces with their coverage", async () => {
            const text = await show("namespace.list", [
                { repo: "qa-recipes", namespace: "workflow", recipeCount: 2, subscribed: "some recipes" },
                { repo: "qa-recipes", namespace: "quality", recipeCount: 2, subscribed: "none", description: "Checks" },
            ]);

            expect(text).toContain("▶ Namespaces in the repositories this project trusts:");
            expect(text).toMatch(/workflow\s+qa-recipes\s+2\s+some recipes\s+no description published/);
            expect(text).toMatch(/quality\s+qa-recipes\s+2\s+no\s+Checks/);
        });

        /** `--installed` heads the count column "Installed" and words an empty listing for it. */
        it("should say what --installed narrows to", async () => {
            const empty = await show("namespace.list", [], { installed: true });

            expect(empty).toContain("Namespaces this project has installed recipes from");
            expect(empty).toContain("This project has installed no recipe from the repositories it trusts.");

            const full = await show("namespace.list", [{ repo: "r", namespace: "n", recipeCount: 1, subscribed: "whole namespace" }], { installed: true });

            expect(full).toMatch(/Namespace\s+Repository\s+Installed/);
        });
    });

    describe("namespace show", () => {
        const detail: NamespaceDetailShape = {
            repo: "qa-recipes",
            repoUrl: "https://github.com/acme/qa",
            namespace: "workflow",
            subscribed: "some recipes",
            recipes: [helper, { ...variables, linkedPath: "/work/qa" }],
        };

        /** The facts, then the recipe table, then what `linked` means. */
        it("should show the namespace's facts and its recipes", async () => {
            const text = await show("namespace.show", detail, { ref: "workflow" });

            expect(text).toContain("The namespace workflow");
            expect(text).toMatch(/Repository: qa-recipes/);
            expect(text).toMatch(/Location {2}: https:\/\/github.com\/acme\/qa/);
            expect(text).toContain("Recipes in workflow");
            expect(text).toContain("workflow/qa-helper");
            expect(text).toMatch(/workflow\/qa-variables\s+qa-recipes\s+0\.1\.0\s+0\.1\.0 linked\s+yes/);
            expect(text).toContain("some recipes");
            expect(text).toContain("A recipe marked linked");
        });

        it("should say when the namespace has no recipes", async () => {
            const text = await show("namespace.show", { ...detail, recipes: [] });

            expect(text).toContain("The repository qa-recipes publishes no recipes in this namespace.");
        });
    });

    describe("recipe list", () => {
        /** Each recipe with its repository, latest and pinned versions, and whether it is subscribed. */
        it("should print a table of recipes", async () => {
            const text = await show("recipe.list", [variables, { ...helper, key: "quality/qa-pattern" }]);

            expect(text).toContain("Recipes in the repositories this project trusts");
            expect(text).toMatch(/workflow\/qa-variables\s+qa-recipes\s+0\.1\.0\s+0\.1\.0\s+yes/);
            expect(text).toMatch(/quality\/qa-pattern\s+qa-recipes\s+0\.1\.0\s+no/);
            expect(text).not.toContain("linked");
        });

        it("should say when there is nothing to list", async () => {
            expect(await show("recipe.list", [])).toContain("The repositories this project trusts publish no recipes.");
        });

        /** Colors only on a terminal: the header row is cyan. */
        it("should color the table header when color is on", async () => {
            const text = await show("recipe.list", [variables], {}, { color: true });

            expect(text).toContain("\u001b[36mRecipe");
        });
    });

    describe("recipe show", () => {
        const detail: RecipeDetailShape = {
            key: "workflow/qa-variables",
            repo: "qa-recipes",
            path: "recipes/workflow/qa-variables",
            latest: "0.1.0",
            pinned: "0.1.0",
            subscribed: true,
            describing: "0.1.0",
            versions: [{ version: "0.1.0", status: "latest and pinned", prerelease: false }],
            dependencies: [{ key: "workflow/qa-helper", declared: "workflow/qa-helper", kind: "depends", resolvedVersion: "0.1.0" }],
            dependenciesRecorded: true,
            contents: [
                { kind: "skills", include: ["skills/**"], destinations: ["/p/.claude/skills"] },
                { kind: "memories", include: ["memories/*.md"], destinations: [] },
            ],
            variables: [
                { name: "dashboardUrl", env: "SOUS_VAR_QA_DASHBOARD_URL", prompt: "Where is the dashboard?", description: "The QA dashboard. More words.", example: "https://qa" },
                { name: "serviceToken", env: "QA_SERVICE_TOKEN", required: false, secret: true },
            ],
            manifestRead: true,
        };

        /** Facts, versions, dependencies, questions and where its files land. */
        it("should show the recipe in full", async () => {
            const text = await show("recipe.show", detail, { ref: "qa-variables" });

            expect(text).toContain("▶ workflow/qa-variables:");
            expect(text).toContain("recipes/workflow/qa-variables");
            expect(text).toContain("Published versions");
            expect(text).toContain("the latest version, and the one pinned here");
            expect(text).toContain("workflow/qa-helper");
            expect(text).toContain("build dependency");
            expect(text).toContain("This recipe asks 2 questions.");
            expect(text).toContain("SOUS_VAR_QA_DASHBOARD_URL");
            expect(text).toContain("QA_SERVICE_TOKEN");
            expect(text).toContain("about    : The QA dashboard.");
            expect(text).toContain("Where its files land in this project");
            expect(text).toContain("/p/.claude/skills");
            expect(text).toContain("reaches an agent through an include line");
        });

        /** A recipe nothing pins, whose files are not on this machine. */
        it("should say what it does not know", async () => {
            const text = await show("recipe.show", { ...detail, pinned: undefined, manifestRead: false, dependencies: [], dependenciesRecorded: false, variables: [] });

            expect(text).toContain("this project pins none");
            expect(text).toContain("The repository's index records no dependencies for this version.");
            expect(text).toContain("This recipe asks no questions");
            expect(text).toContain("The recipe's own files are not on this machine");
        });

        it("should head the version 'Installed version' with --installed", async () => {
            expect(await show("recipe.show", detail, { installed: true })).toContain("Installed version");
        });
    });

    describe("repo search", () => {
        /** Matches in score order, as the intent returned them. */
        it("should print the matches", async () => {
            const text = await show(
                "repo.search",
                [
                    { key: "workflow/task-files", kind: "recipe", repo: "sous-recipes", description: "Task files", score: 75 },
                    { key: "workflow", kind: "namespace", repo: "sous-recipes", score: 20 },
                ],
                { text: "task" },
            );

            expect(text).toContain("Recipes matching your search");
            expect(text).toMatch(/workflow\/task-files\s+recipe\s+sous-recipes\s+Task files/);
            expect(text).toMatch(/workflow\s+namespace\s+sous-recipes\s+no description published/);
            expect(text).not.toContain("--limit");
        });

        it("should say when nothing matches, and when the limit cut the list", async () => {
            expect(await show("repo.search", [], { text: "zzz" })).toContain("Nothing in the repositories this project trusts matches 'zzz'.");
            expect(await show("repo.search", [], { text: "zzz", installed: true })).toContain("Nothing this project has installed matches 'zzz'.");

            const one = [{ key: "a", kind: "recipe", repo: "r", score: 1 }];

            expect(await show("repo.search", one, { text: "a", limit: 1 })).toContain("Raise the number with '--limit'.");
        });
    });

    describe("repo list", () => {
        const repos = [
            { name: "sous-recipes", url: "https://github.com/sous-io/sous-recipes", provider: "github", enabled: true, addedBy: "sous", recipeCount: 12, namespaces: ["core", "workflow"] },
            { name: "mine", url: "/work/mine", provider: "local", enabled: false, linkedPath: "/work/mine", problem: "offline" },
        ];

        /** One row per repository: provider, origin, link, recipe count and URL. */
        it("should print a table of repositories", async () => {
            const text = await show("repo.list", repos);

            expect(text).toContain("Repositories this project trusts");
            expect(text).toMatch(/sous-recipes\s+github\s+built in\s+no\s+12\s+https:\/\/github\.co/);
            expect(text).toMatch(/mine\s+local\s+user\s+yes: \/work\/mine\s+not fetched/);
            expect(text).toContain("Switched off in the config");
            expect(text).toContain("mine could not be checked upstream, so it is shown from the cache: offline");
            expect(text).not.toContain("Namespaces:");
        });

        /** `--verbose` names each repository's namespaces under its row, indented with it. */
        it("should list namespaces under each row with --verbose", async () => {
            const text = await show("repo.list", repos, { verbose: true });

            expect(text).toContain("\n    Namespaces: core, workflow");
            expect(text).toContain("Namespaces: not fetched");
        });

        it("should say when there are no repositories", async () => {
            expect(await show("repo.list", [])).toContain("This project trusts no repositories yet.");
        });
    });
});
