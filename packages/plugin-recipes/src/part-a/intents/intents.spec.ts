import { isSousErrorOfKind, scriptedPrompter, type BuiltConfig, type JsonObject } from "@sous-io/plugin-api";
import type { IndexFile, Lockfile } from "@sous-io/plugin-formats/types";
import { describe, expect, it, vi } from "vitest";
import { builtConfig, context, memoryLock, memoryManaged, serviceReader, shortRefs } from "../../../test/part-a/helpers.js";
import type { CachedIndex, RecipeRequest, RecipesIndexCache, RecipesResolver, ResolvedRecipe, ResolveOptions } from "../../types.js";
import { Trust } from "../trust.js";
import { showNamespace, showRecipe } from "./catalog.js";
import { addRepo, listRepos, removeRepo, searchRepos } from "./repo.js";
import { addSubscription, laterSetters, listSubscriptions, removeSubscription, toggleSubscription, updateSubscriptions } from "./subscription.js";
import { planUpdate } from "../update-plan.js";

const hash = "sha256-aa" as const;

function index(recipes: Record<string, string[]>, variables: Record<string, string[]> = {}): IndexFile {
    const namespaces = Object.fromEntries([...new Set(Object.keys(recipes).map((key) => key.split("/")[0]!))].map((namespace) => [namespace, { description: `The ${namespace} namespace` }]));

    return {
        formatVersion: 1,
        name: "r",
        generatedAt: "2026-01-01T00:00:00Z",
        generator: "0.2.34",
        namespaces,
        recipes: Object.fromEntries(
            Object.entries(recipes).map(([key, versions]) => [
                key,
                {
                    path: key,
                    description: `About ${key}`,
                    versions: Object.fromEntries(
                        versions.map((version) => [
                            version,
                            {
                                hash,
                                tag: `${key}@${version}`,
                                prerelease: false,
                                variables: (variables[`${key}@${version}`] ?? []).map((name) => ({ name, type: "string", prompt: name, description: `The ${name}`, example: "x", required: true, secret: false, scope: "shared" })),
                            },
                        ]),
                    ),
                },
            ]),
        ),
    } as IndexFile;
}

/** A resolver that picks the newest version an index offers, or the kept one, for the recipes a ref names. */
function fakeResolver(indexes: Map<string, IndexFile>, missingRepos: RecipeRequest[] = []): RecipesResolver & { calls: RecipeRequest[][] } {
    const calls: RecipeRequest[][] = [];

    return {
        calls,
        async resolve(requests: readonly RecipeRequest[], options: ResolveOptions = {}) {
            calls.push([...requests]);

            const resolved: ResolvedRecipe[] = [];
            const pool = options.indexes ?? indexes;

            for (const request of requests) {
                for (const [repo, file] of pool) {
                    for (const [key, recipe] of Object.entries(file.recipes)) {
                        const [namespace, name] = key.split("/") as [string, string];
                        const named = request.ref.kind === "namespace" ? request.ref.name === namespace : request.ref.name === name && request.ref.namespace?.name === namespace;

                        if (!named) {
                            continue;
                        }

                        const versions = Object.keys(recipe.versions).sort();
                        const version = options.keep?.[key] ?? versions[versions.length - 1]!;

                        resolved.push({
                            key,
                            namespace,
                            name,
                            repo,
                            identity: `github.com/acme/${repo}`,
                            version,
                            hash,
                            tag: `${key}@${version}`,
                            path: key,
                            kind: "subscribes",
                            requestedBy: [request.requestedBy],
                            ranges: [],
                            prerelease: false,
                            variables: recipe.versions[version]?.variables ?? [],
                        });
                    }
                }
            }

            return { resolved, missingRepos: missingRepos.length > 0 ? [{ name: "extra", url: "https://github.com/acme/extra", requiredBy: [] }] : [], unreadable: [], cycles: [] };
        },
        resolveSubscriptions: async () => ({ resolved: [], missingRepos: [], unreadable: [], cycles: [] }),
        reachable: () => [],
    };
}

function fakeIndexCache(indexes: Map<string, IndexFile>, failing: string[] = []): RecipesIndexCache {
    const cached = (repo: string): CachedIndex | undefined => {
        const file = indexes.get(repo);

        return file === undefined ? undefined : { repo, index: file, source: "cache", meta: { url: "", identity: `github.com/acme/${repo}`, fetchedAt: "", lastCheckedAt: "2026-01-02T00:00:00Z", hash } };
    };

    return {
        get: async (repo) => {
            if (failing.includes(repo)) {
                throw new Error(`${repo} is offline`);
            }

            return { ...cached(repo)!, source: "network" };
        },
        getAll: async () => ({ indexes: [], failed: [] }),
        cached,
        isFresh: () => true,
        meta: (repo) => cached(repo)?.meta,
        forget: async () => {},
    };
}

const locations = {
    identity: (url: string) => url.replace(/^https:\/\//, "").toLowerCase(),
    identityOf: (repository: { host: string; owner: string; name: string }) => `${repository.host}/${repository.owner}/${repository.name}`.toLowerCase(),
    canonicalize: (url: string) => {
        const [host, owner, name] = url.replace(/^https:\/\//, "").split("/") as [string, string, string];

        return { host, owner, name, httpsUrl: url, sshUrl: "" };
    },
    hostFor: () => ({ id: "github" }),
    hosts: () => [{ id: "github" }, { id: "gitlab" }, { id: "local" }, { id: "gitea" }],
    host: (id: string) => (["github", "gitlab", "local", "gitea"].includes(id) ? { id } : undefined),
};

interface Setup {
    data?: JsonObject;
    lock?: Lockfile;
    indexes?: Record<string, IndexFile>;
    managed?: Record<string, JsonObject>;
    layers?: Record<string, string[]>;
    failing?: string[];
    missing?: boolean;
    services?: Record<string, unknown>;
    entities?: Record<string, Array<{ id: string }>>;
}

function setup(options: Setup = {}) {
    const indexes = new Map(Object.entries(options.indexes ?? { r: index({ "workflow/task-files": ["1.0.0", "1.1.0"], "workflow/reviews": ["0.1.0"], "tools/helper": ["2.0.0"] }) }));
    const managed = memoryManaged(options.managed ?? {});
    const lock = memoryLock(options.lock ?? { formatVersion: 1, repos: {}, recipes: {} });
    const refs = shortRefs();
    const resolver = fakeResolver(indexes, options.missing === true ? [{} as RecipeRequest] : []);
    const services: Record<string, unknown> = {
        "confd.managed": managed,
        "recipes.lock": lock,
        "recipes.index-cache": fakeIndexCache(indexes, options.failing),
        "recipes.resolver": resolver,
        "refs.resolver": refs.resolver,
        "refs.format": refs.format,
        "refs.locations": locations,
        "refs.picker": { pick: vi.fn(async (matches: unknown[]) => matches[0]) },
        ...options.services,
    };
    const data = options.data ?? { repos: { r: { url: "https://github.com/acme/r" } }, subscriptions: {} };
    const reader = serviceReader(services);
    const config: BuiltConfig = builtConfig(data, {
        services,
        ...(options.layers === undefined ? {} : { layers: options.layers }),
        ...(options.entities === undefined ? {} : { entities: options.entities }),
    });

    services["recipes.trust"] = new Trust(config, reader);

    return { config, managed, lock, resolver, services };
}

const pinned: Lockfile = {
    formatVersion: 1,
    repos: { r: { url: "https://github.com/acme/r", identity: "github.com/acme/r" } },
    recipes: {
        "workflow/task-files": { repo: "r", version: "1.0.0", hash, requestedBy: ["project"], kind: "subscribes" },
        "tools/helper": { repo: "r", version: "2.0.0", hash, requestedBy: ["workflow/task-files"], kind: "depends" },
    },
};

describe("subscription.disable and subscription.enable (C59)", () => {
    /** Disabling overwrites only `enabled` in conf.d/510, keeping every other field (S2). */
    it("should switch a subscription off, keeping its other fields and its pins", async () => {
        const { config, managed, lock } = setup({
            data: { repos: { r: { url: "https://github.com/acme/r" } }, subscriptions: { "workflow/task-files": { range: "^1.0.0" } } },
            managed: { "510-subscriptions.jsonc": { subscriptions: { "workflow/task-files": { range: "^1.0.0", addedBy: "user" } } } },
            lock: pinned,
        });
        const ctx = context(config, { intents: ["build"] });
        const result = await toggleSubscription({ ref: "workflow/task-files", noBuild: true }, ctx, false);

        expect(result).toMatchObject({ key: "workflow/task-files", enabled: false, changed: true, file: "/project/.sous/conf.d/510-subscriptions.jsonc" });
        expect(managed.files["510-subscriptions.jsonc"]).toEqual({ subscriptions: { "workflow/task-files": { range: "^1.0.0", addedBy: "user", enabled: false } } });
        expect(lock.current).toBe(pinned);
        expect(result.followUps).toEqual([{ intent: "build", skipped: "--no-build" }]);
        expect(ctx.configChanged).toHaveBeenCalled();
    });

    /** A subscription written in the user's own file is switched off from the managed file, which wins over it. */
    it("should switch off a subscription the managed file does not hold, and build afterwards", async () => {
        const { config, managed } = setup({ data: { repos: {}, subscriptions: { workflow: {} } } });
        const ctx = context(config, { intents: ["build"] });
        const result = await toggleSubscription({ ref: "workflow" }, ctx, false);

        expect(managed.files["510-subscriptions.jsonc"]).toEqual({ subscriptions: { workflow: { enabled: false } } });
        expect(result.followUps).toEqual([{ intent: "build", result: { ran: "build" } }]);
    });

    /** Enabling a subscription already on changes nothing. */
    it("should report nothing changed", async () => {
        const { config } = setup({ data: { repos: {}, subscriptions: { workflow: {} } }, managed: { "510-subscriptions.jsonc": { subscriptions: { workflow: { enabled: true } } } } });
        const result = await toggleSubscription({ ref: "workflow" }, context(config), true);

        expect(result).toMatchObject({ changed: false, followUps: [{ intent: "build", skipped: "nothing changed" }] });
    });

    /** A layer after 510 still wins; sous says so and lets it (L6). */
    it("should warn when a later layer sets enabled", async () => {
        const { config } = setup({
            data: { repos: {}, subscriptions: { workflow: { enabled: false } } },
            layers: { "subscriptions.workflow.enabled": ["confd/510-subscriptions.jsonc", "confd/610-mac.jsonc"] },
        });
        const ctx = context(config);

        expect(laterSetters(config, "workflow")).toEqual(["conf.d/610-mac.jsonc"]);
        await toggleSubscription({ ref: "workflow", noBuild: true }, ctx, true);
        expect(ctx.reporter.at("warning")[0]).toMatch(/conf.d\/610-mac.jsonc also sets subscriptions.workflow.enabled/);
    });

    /** Toggling a subscription the project does not have is an error listing what it has. */
    it("should refuse an unknown subscription", async () => {
        const { config } = setup({ data: { repos: {}, subscriptions: { core: {} } } });

        await expect(toggleSubscription({ ref: "nope" }, context(config), false)).rejects.toThrow(/does not subscribe to 'nope'/);
    });
});

describe("subscription.remove", () => {
    /** Removing deletes the managed entry and releases its recipes, refcounted. */
    it("should remove the entry and what only it held", async () => {
        const { config, managed, lock } = setup({
            data: { repos: { r: { url: "https://github.com/acme/r" } }, subscriptions: { "workflow/task-files": {} } },
            managed: { "510-subscriptions.jsonc": { subscriptions: { "workflow/task-files": { addedBy: "user" } } } },
            lock: pinned,
        });
        const result = await removeSubscription({ ref: "workflow/task-files", noBuild: true }, context(config));

        expect(result.diff.removed.map((change) => change.key).sort()).toEqual(["tools/helper", "workflow/task-files"]);
        expect(lock.current.recipes).toEqual({});
        expect(managed.files["510-subscriptions.jsonc"]).toEqual({ subscriptions: {} });
        expect(result.optedOut).toBe(false);
    });

    /** A subscription sous provides itself is switched off instead. */
    it("should opt out of a built-in subscription", async () => {
        const { config, managed } = setup({ data: { repos: {}, subscriptions: { core: { range: "0.2.34", addedBy: "sous" } } } });
        const result = await removeSubscription({ ref: "core", dryRun: false, noBuild: true }, context(config));

        expect(result.optedOut).toBe(true);
        expect(managed.files["510-subscriptions.jsonc"]).toEqual({ subscriptions: { core: { enabled: false } } });
    });

    /** One written in the user's own file is not sous's to delete; the error names `disable`. */
    it("should refuse to delete what the user wrote", async () => {
        const { config } = setup({ data: { repos: {}, subscriptions: { workflow: {} } } });

        await expect(removeSubscription({ ref: "workflow" }, context(config))).rejects.toMatchObject({ details: expect.arrayContaining([expect.stringMatching(/subscription disable workflow/)]) });
    });

    /** A dry run writes nothing. */
    it("should write nothing on a dry run", async () => {
        const { config, managed, lock } = setup({
            data: { repos: {}, subscriptions: { "workflow/task-files": {} } },
            managed: { "510-subscriptions.jsonc": { subscriptions: { "workflow/task-files": {} } } },
            lock: pinned,
        });
        const result = await removeSubscription({ ref: "workflow/task-files", dryRun: true }, context(config));

        expect(result.diff.removed).toHaveLength(2);
        expect(lock.current).toBe(pinned);
        expect(managed.files["510-subscriptions.jsonc"]).toEqual({ subscriptions: { "workflow/task-files": {} } });
    });
});

describe("subscription.add", () => {
    /** Subscribing resolves, writes the lockfile and conf.d/510, then runs vars.ask and build through ctx.run. */
    it("should subscribe and run the follow-ups", async () => {
        const indexes = { r: index({ "workflow/task-files": ["1.0.0", "1.1.0"] }, { "workflow/task-files@1.1.0": ["apiUrl"] }) };
        const { config, managed, lock } = setup({ indexes });
        const ctx = context(config, { intents: ["vars.ask", "build"] });
        const result = await addSubscription({ ref: "workflow/task-files@^1.0.0", yes: true, answer: ["apiUrl=https://x"] }, ctx);

        expect(result).toMatchObject({ key: "workflow/task-files", ref: "workflow/task-files@^1.0.0", dryRun: false });
        expect(lock.current.recipes["workflow/task-files"]).toMatchObject({ version: "1.1.0", requestedBy: ["project"] });
        expect(lock.current.repos.r).toEqual({ url: "https://github.com/acme/r", identity: "github.com/acme/r" });
        expect((managed.files["510-subscriptions.jsonc"] as { subscriptions: Record<string, unknown> }).subscriptions["workflow/task-files"]).toMatchObject({ range: "^1.0.0", addedBy: "user" });
        expect(ctx.run).toHaveBeenNthCalledWith(1, "vars.ask", { within: ["workflow/task-files"], answer: ["apiUrl=https://x"] });
        expect(ctx.run).toHaveBeenNthCalledWith(2, "build", {});
        expect(ctx.emit).toHaveBeenCalledWith("recipes.locked", expect.objectContaining({ path: "/project/.sous/sous.lock.json" }));
    });

    /**
     * After writing, subscribing refreshes the chain's config (ctx.refreshConfig()), so vars.ask
     * and build see the new subscription; it refreshes again after vars.ask, so build sees the
     * answers.
     */
    it("should refresh the config before vars.ask and again before build", async () => {
        const indexes = { r: index({ "workflow/task-files": ["1.0.0"] }, { "workflow/task-files@1.0.0": ["apiUrl"] }) };
        const { config } = setup({ indexes });
        const next = { ...config, buildNumber: 99 } as typeof config;
        const ctx = context(config, { intents: ["vars.ask", "build"], next });
        const seen: Array<{ intent: string; buildNumber: number; refreshes: number }> = [];
        const refresh = ctx.refreshConfig as unknown as { mock: { calls: unknown[] } };

        ctx.run.mockImplementation(async (intent: string) => {
            seen.push({ intent, buildNumber: ctx.config.buildNumber, refreshes: refresh.mock.calls.length });

            return { ran: intent };
        });

        await addSubscription({ ref: "workflow/task-files", yes: true }, ctx);

        expect(seen).toEqual([
            { intent: "vars.ask", buildNumber: 99, refreshes: 1 },
            { intent: "build", buildNumber: 99, refreshes: 2 },
        ]);
    });

    /** A one-word ref is settled against the indexes; a dry run writes and runs nothing. */
    it("should settle a one-word ref and write nothing on a dry run", async () => {
        const { config, managed, lock } = setup();
        const ctx = context(config, { intents: ["vars.ask", "build"] });
        const result = await addSubscription({ ref: "reviews", dryRun: true }, ctx);

        expect(result).toMatchObject({ key: "workflow/reviews", resolvedFrom: "reviews", dryRun: true });
        expect(result.diff.added.map((change) => change.key)).toEqual(["workflow/reviews"]);
        expect(managed.files).toEqual({});
        expect(lock.current.recipes).toEqual({});
        expect(ctx.run).not.toHaveBeenCalled();
    });

    /** Without --yes and with no way to ask, it fails naming --yes (L4). */
    it("should need --yes when it cannot ask", async () => {
        const { config } = setup();

        await expect(addSubscription({ ref: "workflow" }, context(config))).rejects.toSatisfy((error: unknown) => isSousErrorOfKind(error, "non-interactive"));
    });

    /** A name nothing publishes is an error naming what was searched. */
    it("should explain a ref that names nothing", async () => {
        const { config } = setup();

        await expect(addSubscription({ ref: "nothing", yes: true }, context(config))).rejects.toMatchObject({ details: expect.arrayContaining([expect.stringMatching(/Searched the namespaces and recipes of: r/)]) });
    });

    /** A repository a dependency needs that has no URL stops the install, saying how to add it. */
    it("should stop on a repository it cannot trust", async () => {
        const { config } = setup({ missing: true });
        const ctx = context(config, { prompter: scriptedPrompter([true]) });

        await expect(addSubscription({ ref: "workflow", yes: true, dryRun: true }, ctx)).resolves.toMatchObject({ trusted: ["extra"] });
    });
});

describe("subscription.list", () => {
    /** Every declared subscription, switched-off ones included, with its pins and, with --latest, newer versions in range. */
    it("should list subscriptions with pins, latest and newer versions", async () => {
        const { config } = setup({ data: { repos: {}, subscriptions: { "workflow/task-files": { range: "^1.0.0" }, old: { enabled: false } } }, lock: pinned });
        const listings = await listSubscriptions({ latest: true }, context(config));

        expect(listings).toEqual([
            { key: "old", range: undefined, enabled: false, addedBy: undefined, pinned: [], latest: [], newer: [] },
            {
                key: "workflow/task-files",
                range: "^1.0.0",
                enabled: true,
                addedBy: undefined,
                pinned: [{ key: "workflow/task-files", version: "1.0.0" }],
                latest: [{ key: "workflow/task-files", version: "1.1.0" }],
                newer: [{ key: "workflow/task-files", version: "1.1.0" }],
            },
        ]);
    });
});

describe("recipe.update and subscription.update (C60)", () => {
    const data = { repos: { r: { url: "https://github.com/acme/r" } }, subscriptions: { "workflow/task-files": {}, core: { range: "0.2.34", addedBy: "sous" }, gone: { enabled: false } } };

    /** A plan says what the lockfile would become, writing nothing. */
    it("should plan an update without writing", async () => {
        const indexes = { r: index({ "workflow/task-files": ["1.0.0", "1.1.0"], "tools/helper": ["2.0.0"] }, { "workflow/task-files@1.1.0": ["newQuestion"] }) };
        const { config, lock } = setup({ data, lock: pinned, indexes });
        const plan = await planUpdate({}, context(config));

        expect(plan.scope).toEqual({ kind: "all" });
        expect(plan.diff.updated).toEqual([{ key: "workflow/task-files", from: "1.0.0", to: "1.1.0" }]);
        expect(plan.lockfile.recipes["workflow/task-files"]?.version).toBe("1.1.0");
        expect(plan.newVariables).toEqual([{ recipe: "workflow/task-files", name: "newQuestion" }]);
        expect(plan.switchedOff).toEqual(["gone"]);
        expect(lock.current).toBe(pinned);
    });

    /** A ref narrows the scope; pins outside it are kept. */
    it("should narrow the plan to a ref", async () => {
        const { config, resolver } = setup({ data, lock: pinned });
        const plan = await planUpdate({ ref: "tools/helper" }, context(config));

        expect(plan.scope).toEqual({ kind: "recipe", repo: "r", key: "tools/helper" });
        expect(plan.diff.updated).toEqual([]);
        expect(resolver.calls.length).toBe(1);
    });

    /** An unreachable repository keeps its pins and is reported. */
    it("should keep the pins of an unreachable repository", async () => {
        const alone: Lockfile = { ...pinned, recipes: { "workflow/task-files": pinned.recipes["workflow/task-files"]! } };
        const { config } = setup({ data, lock: alone, failing: ["r"] });
        const plan = await planUpdate({}, context(config));

        expect(plan.unreachable).toEqual([{ repo: "r", reason: "r is offline" }]);
        expect(plan.diff.unchanged).toBe(true);
    });

    /** Applying asks once (--yes answers it), writes the plan's lockfile, then builds. */
    it("should apply a plan", async () => {
        const { config, lock } = setup({ data, lock: pinned });
        const ctx = context(config, { intents: ["build"] });

        ctx.run.mockImplementation(async (intent: string, input: unknown) => (intent === "recipe.update" ? planUpdate(input as never, ctx) : { ran: intent }));

        const result = await updateSubscriptions({ yes: true }, ctx);

        expect(result).toMatchObject({ applied: true, nothingToUpdate: false });
        expect(lock.current.recipes["workflow/task-files"]?.version).toBe("1.1.0");
        expect(ctx.run).toHaveBeenLastCalledWith("build", {});
    });
});

describe("repo intents", () => {
    /** Adding trusts first, writes conf.d/500 as added by the user, then reads the index. */
    it("should add a repository", async () => {
        const { config, managed } = setup({ data: { repos: {}, subscriptions: {} }, indexes: { acme: index({ "a/b": ["1.0.0"] }) } });
        const result = await addRepo({ url: "https://github.com/acme/acme", yes: true }, context(config));

        expect(result).toMatchObject({ name: "acme", provider: "github", alreadyTrusted: false, namespaces: ["a"], recipeCount: 1 });
        expect((managed.files["500-repos.jsonc"] as { repos: Record<string, unknown> }).repos.acme).toMatchObject({ url: "https://github.com/acme/acme", addedBy: "user" });
    });

    /** --provider takes any loaded repository-host id, a plugin's own included. */
    it("should accept a provider a plugin adds, and refuse one no plugin provides", async () => {
        const { config } = setup({ data: { repos: {}, subscriptions: {} }, indexes: { acme: index({ "a/b": ["1.0.0"] }) } });

        expect(await addRepo({ url: "https://git.example/acme/acme", provider: "gitea", yes: true }, context(config))).toMatchObject({ provider: "gitea" });
        await expect(addRepo({ url: "https://git.example/acme/acme", provider: "nowhere", yes: true }, context(config))).rejects.toMatchObject({
            message: "'nowhere' is not a repository host sous knows.",
            details: [expect.stringContaining("gitea, github, gitlab, local")],
        });
    });

    /** A typed path is checked by the host that reads it, which explains a path mistake. */
    it("should let the host of a typed path check it before anything is written", async () => {
        const checked: Array<[string, string]> = [];
        const local = {
            id: "local",
            checkTypedPath: (typed: string, resolved: string) => {
                checked.push([typed, resolved]);
                throw new Error(`The directory '${typed}' is not a sous repository.`);
            },
        };
        const { config, managed } = setup({ data: { repos: {}, subscriptions: {} }, entities: { "repository-host": [local] } });

        await expect(addRepo({ url: "/tmp", provider: "local", yes: true }, context(config))).rejects.toThrow(/is not a sous repository/);
        expect(checked).toEqual([["/tmp", "/tmp"]]);
        expect(managed.files["500-repos.jsonc"]).toBeUndefined();
    });

    /** A name already used by a different repository is refused. */
    it("should refuse a clashing name", async () => {
        const { config } = setup();

        await expect(addRepo({ url: "https://github.com/other/r", yes: true }, context(config))).rejects.toThrow(/already has a repository called 'r'/);
    });

    /** Removing reports what goes, the built files from compiler.state included, then removes subscriptions and the entry. */
    it("should remove a repository and what resolves into it", async () => {
        const { config, managed, lock } = setup({
            data: { repos: { r: { url: "https://github.com/acme/r" } }, subscriptions: { "workflow/task-files": {} } },
            managed: { "500-repos.jsonc": { repos: { r: { url: "https://github.com/acme/r" } } }, "510-subscriptions.jsonc": { subscriptions: { "workflow/task-files": {} } } },
            lock: pinned,
            services: { "compiler.state": { filesFrom: () => [{ dest: "/project/.claude/skills/a.md" }, { dest: "/project/.claude/skills/a.md" }] } },
        });
        const ctx = context(config);
        const result = await removeRepo({ repo: "r", yes: true, noBuild: true }, ctx);

        expect(result).toMatchObject({ subscriptions: ["workflow/task-files"], outputs: ["/project/.claude/skills/a.md"], optedOut: false });
        // With --yes nothing is asked, so the plan travels in the result for the view to print.
        expect(result.plan).toContain("Removing r deletes 1 built file on the next build:");
        expect(managed.files["500-repos.jsonc"]).toEqual({ repos: {} });
        expect(lock.current.recipes).toEqual({});
    });

    /** Listing shows every configured repository with its index facts. */
    it("should list repositories", async () => {
        const { config } = setup({ data: { repos: { r: { url: "https://github.com/acme/r" }, off: { url: "https://github.com/acme/off", enabled: false } }, subscriptions: {} } });
        const listings = await listRepos({}, context(config));

        expect(listings.map((listing) => [listing.name, listing.enabled, listing.recipeCount])).toEqual([
            ["off", false, undefined],
            ["r", true, 3],
        ]);
    });

    /** Search ranks exact names first, and finds variables. */
    it("should search namespaces, recipes and variables", async () => {
        const { config } = setup({ indexes: { r: index({ "workflow/task-files": ["1.0.0"], "tasks/other": ["1.0.0"] }, { "workflow/task-files@1.0.0": ["taskDir"] }) } });
        const matches = await searchRepos({ text: "task" }, context(config));

        expect(matches.map((match) => `${match.kind} ${match.key} ${match.score}`)).toEqual([
            "namespace tasks 75",
            "recipe tasks/other 75",
            "recipe workflow/task-files 75",
            "variable workflow/task-files.taskDir 70",
        ]);
    });
});

describe("catalog intents", () => {
    /** A namespace shows with its recipes; a recipe ref is told it is not a namespace. */
    it("should show a namespace", async () => {
        const { config } = setup();
        const ctx = context(config);

        await expect(showNamespace({ ref: "workflow" }, ctx)).resolves.toMatchObject({ namespace: "workflow", recipes: [{ key: "workflow/reviews" }, { key: "workflow/task-files" }] });
        await expect(showNamespace({ ref: "workflow/reviews" }, ctx)).rejects.toThrow(/names the recipe 'workflow\/reviews', not a namespace/);
    });

    /** A recipe shows from its index when its files are not here; a namespace name is explained. */
    it("should show a recipe", async () => {
        const { config } = setup({ services: { "formats.manifests": { readRecipe: async () => undefined } } });
        const ctx = context(config);

        await expect(showRecipe({ ref: "task-files" }, ctx)).resolves.toMatchObject({ key: "workflow/task-files", latest: "1.1.0", manifestRead: false });
        await expect(showRecipe({ ref: "tools" }, ctx)).rejects.toThrow(/publishes a recipe called 'tools'/);
    });
});
