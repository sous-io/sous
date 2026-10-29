import { describe, expect, it } from "vitest";
import type { IndexFile, IndexVersion } from "@sous-io/plugin-formats/types";
import type { RefLocation, SousRef } from "@sous-io/plugin-refs/types";
import { indexDependencyLists, isConfirmedByRecord, pickVersion, proposeRepoName, resolveWanted, settleBrowsed, wantedOf, type DependencyLists, type ResolveContext, type WantedRequest } from "./resolve.js";

const HASH = `sha256-${"d".repeat(64)}` as const;

type Versions = Record<string, Partial<IndexVersion>>;

function index(name: string, recipes: Record<string, Versions>, paths: Record<string, string> = {}): IndexFile {
    const namespaces: IndexFile["namespaces"] = {};

    for (const key of Object.keys(recipes)) {
        namespaces[key.split("/")[0]] = {};
    }

    return {
        formatVersion: 1,
        name,
        generatedAt: "2026-01-01T00:00:00.000Z",
        generator: "0.2.34",
        namespaces,
        recipes: Object.fromEntries(
            Object.entries(recipes).map(([key, versions]) => [
                key,
                {
                    path: paths[key] ?? `recipes/${key}`,
                    versions: Object.fromEntries(Object.entries(versions).map(([version, entry]) => [version, { hash: HASH, tag: `${key}@${version}`, prerelease: false, ...entry }])),
                },
            ]),
        ),
    };
}

function location(owner: string, repo: string): RefLocation {
    return { provider: "fake", host: "fake.test", repoPath: `${owner}/${repo}`, identity: `fake.test/${owner}/${repo}`, url: `https://fake.test/${owner}/${repo}` };
}

/**
 * A stand-in for `refs.resolver` from `manifest`: `ns/name@range`, `ns`, `repo:ns/name`,
 * `https://fake.test/<owner>/<repo>/ns/name`, `https://fake.test/<owner>/<repo>/tree/<path>`, and
 * alternatives separated by `||` for a ref that reads several ways.
 */
function parse(written: string): SousRef[] {
    return written.split("||").map((one) => parseOne(one.trim()));
}

function parseOne(written: string): SousRef {
    const url = /^https:\/\/fake\.test\/([^/]+)\/([^/]+)\/(.*)$/.exec(written);

    if (url) {
        const where = location(url[1], url[2]);

        if (url[3].startsWith("tree/")) {
            const [path, range] = url[3].slice(5).split("@");

            return { kind: "repo", location: where, browsed: path, ...(range ? { range } : {}) };
        }

        const [namespace, name] = url[3].split("/");

        return name === undefined
            ? { kind: "namespace", name: namespace, repo: { kind: "repo", location: where } }
            : { kind: "recipe", name, namespace: { kind: "namespace", name: namespace, repo: { kind: "repo", location: where } } };
    }

    const colon = written.indexOf(":");
    const repo = colon === -1 ? undefined : written.slice(0, colon);
    const rest = colon === -1 ? written : written.slice(colon + 1);
    const [path, range] = rest.split("@");
    const [namespace, name] = path.split("/");
    const repoRef = repo === undefined ? {} : { repo: { kind: "repo" as const, name: repo } };

    return name === undefined
        ? { kind: "namespace", name: namespace, ...repoRef }
        : { kind: "recipe", name, namespace: { kind: "namespace", name: namespace, ...repoRef }, ...(range ? { range } : {}) };
}

/** A context over indexes and manifests (keyed `key@version`). */
function context(indexes: Record<string, IndexFile>, manifests: Record<string, DependencyLists> = {}, extra: Partial<ResolveContext> = {}): ResolveContext {
    return {
        indexes: new Map(Object.entries(indexes)),
        repos: Object.fromEntries(Object.keys(indexes).map((name) => [name, { url: `https://fake.test/owner/${name}`, identity: `fake.test/owner/${name}` }])),
        loadManifest: (recipe) => manifests[`${recipe.key}@${recipe.version}`],
        parseDependency: parse,
        ...extra,
    };
}

const project = (namespace: string, name?: string, extra: Partial<WantedRequest> = {}): WantedRequest => ({ namespace, ...(name ? { name } : {}), requestedBy: "project", ...extra });

describe("resolveWanted: versions", () => {
    it("should pick the highest published version satisfying the range", async () => {
        const result = await resolveWanted([project("w", "a", { range: "^1" })], context({ acme: index("acme", { "w/a": { "1.0.0": {}, "1.4.0": {}, "2.0.0": {} } }) }));

        expect(result.resolved).toHaveLength(1);
        expect(result.resolved[0]).toMatchObject({ key: "w/a", version: "1.4.0", repo: "acme", identity: "fake.test/owner/acme", tag: "w/a@1.4.0", kind: "subscribes", requestedBy: ["project"] });
    });

    it("should satisfy every range asked of a recipe at once", async () => {
        const acme = index("acme", { "w/a": { "1.0.0": {}, "1.4.0": {} }, "w/b": { "1.0.0": {} } });
        const result = await resolveWanted([project("w", "a", { range: "^1" }), project("w", "b")], context({ acme }, { "w/b@1.0.0": { depends: ["w/a@<1.2.0"], subscribes: [] } }));
        const a = result.resolved.find((recipe) => recipe.key === "w/a");

        expect(a?.version).toBe("1.0.0");
        expect(a?.requestedBy).toEqual(["project", "w/b"]);
        expect(a?.ranges).toEqual([
            { range: "^1", requestedBy: "project" },
            { range: "<1.2.0", requestedBy: "w/b" },
        ]);
    });

    it("should leave prereleases out unless the request opts in", async () => {
        const acme = index("acme", { "w/a": { "1.0.0": {}, "1.1.0-beta.1": { prerelease: true } } });

        expect((await resolveWanted([project("w", "a")], context({ acme }))).resolved[0].version).toBe("1.0.0");
        expect((await resolveWanted([project("w", "a", { prerelease: true })], context({ acme }))).resolved[0].version).toBe("1.1.0-beta.1");
    });

    it("should hold a kept version while every range allows it", async () => {
        const acme = index("acme", { "w/a": { "1.0.0": {}, "1.4.0": {} } });

        expect((await resolveWanted([project("w", "a")], context({ acme }, {}, { keep: { "w/a": "1.0.0" } }))).resolved[0].version).toBe("1.0.0");
        expect((await resolveWanted([project("w", "a", { range: ">1.0.0" })], context({ acme }, {}, { keep: { "w/a": "1.0.0" } }))).resolved[0].version).toBe("1.4.0");
    });

    it("should explain when no version satisfies the ranges", () => {
        const entry = index("acme", { "w/a": { "1.0.0": {} } }).recipes["w/a"];

        expect(() => pickVersion("w/a", entry, [{ range: "^2", requestedBy: "project" }], false)).toThrow(/No published version of 'w\/a' satisfies/);
    });
});

describe("resolveWanted: finding recipes", () => {
    it("should refuse a ref published by more than one repository, naming the qualified forms", async () => {
        const indexes = { acme: index("acme", { "w/a": { "1.0.0": {} } }), other: index("other", { "w/a": { "1.0.0": {} } }) };

        await expect(resolveWanted([project("w", "a")], context(indexes))).rejects.toMatchObject({
            message: expect.stringMatching(/published by more than one added repository: acme, other/),
            details: expect.arrayContaining(["  acme:w/a", "  other:w/a"]),
        });
    });

    it("should resolve a qualified ref in the repository it names", async () => {
        const indexes = { acme: index("acme", { "w/a": { "1.0.0": {} } }), other: index("other", { "w/a": { "2.0.0": {} } }) };
        const result = await resolveWanted([project("w", "a", { repo: "other" })], context(indexes));

        expect(result.resolved[0]).toMatchObject({ repo: "other", version: "2.0.0" });
    });

    it("should name the repositories searched for a ref nobody publishes", async () => {
        await expect(resolveWanted([project("w", "zz")], context({ acme: index("acme", { "w/a": { "1.0.0": {} } }) }))).rejects.toMatchObject({
            message: "No added repository publishes the recipe 'w/zz'.",
            details: expect.arrayContaining(["Repositories searched: acme."]),
        });
        await expect(resolveWanted([project("nope")], context({}))).rejects.toThrow(/namespace 'nope'/);
    });

    it("should expand a namespace into every recipe in it, applying its range to each", async () => {
        const acme = index("acme", { "core/a": { "0.2.33": {}, "0.2.34": {} }, "core/b": { "0.2.34": {}, "0.3.0": {} } });
        const result = await resolveWanted([project("core", undefined, { range: "0.2.34" })], context({ acme }));

        expect(result.resolved.map((recipe) => `${recipe.key}@${recipe.version}`)).toEqual(["core/a@0.2.34", "core/b@0.2.34"]);
    });
});

describe("resolveWanted: dependencies", () => {
    it("should resolve a sibling dependency in the declaring recipe's repository, as a build dependency", async () => {
        const indexes = { acme: index("acme", { "w/a": { "1.0.0": {} }, "lib/x": { "1.0.0": {} } }), other: index("other", { "lib/x": { "9.0.0": {} } }) };
        const result = await resolveWanted([project("w", "a", { repo: "acme" })], context(indexes, { "w/a@1.0.0": { depends: ["lib/x"], subscribes: [] } }));
        const lib = result.resolved.find((recipe) => recipe.key === "lib/x");

        expect(lib).toMatchObject({ repo: "acme", version: "1.0.0", kind: "depends", requestedBy: ["w/a"] });
    });

    it("should ask for the version the index recorded a dependency was released against", async () => {
        const acme = index("acme", {
            "w/a": { "1.0.0": { dependencies: { "lib/x": { version: "1.1.0", range: "^1" } } } },
            "lib/x": { "1.0.0": {}, "1.1.0": {}, "1.9.0": {} },
        });
        const result = await resolveWanted([project("w", "a")], context({ acme }, { "w/a@1.0.0": { depends: ["lib/x@^1"], subscribes: [] } }));

        expect(result.resolved.find((recipe) => recipe.key === "lib/x")?.version).toBe("1.1.0");
    });

    it("should read what a recipe declares from its index entry when its files are not here", async () => {
        const acme = index("acme", { "w/a": { "1.0.0": { depends: [], subscribes: ["w/b"] } }, "w/b": { "1.0.0": {} } });
        const result = await resolveWanted([project("w", "a")], context({ acme }));

        expect(result.resolved.find((recipe) => recipe.key === "w/b")).toMatchObject({ kind: "subscribes", requestedBy: ["w/a"] });
        expect(result.unreadable).toEqual(["w/b"]);
    });

    it("should report a recipe whose dependencies cannot be read at all", async () => {
        const result = await resolveWanted([project("w", "a")], context({ acme: index("acme", { "w/a": { "1.0.0": {} } }) }));

        expect(result.unreadable).toEqual(["w/a"]);
    });

    it("should return a qualifier naming an untrusted repository as a missing repository", async () => {
        const result = await resolveWanted([project("w", "a", { repo: "ghost", written: "ghost:w/a" })], context({}));

        expect(result.missingRepos).toEqual([{ name: "ghost", requiredBy: [{ ref: "ghost:w/a", requestedBy: "project" }] }]);
    });

    it("should return a dependency on an untrusted repository by location, with a proposed name", async () => {
        const acme = index("acme", { "w/a": { "1.0.0": {} } });
        const result = await resolveWanted([project("w", "a")], context({ acme }, { "w/a@1.0.0": { depends: ["https://fake.test/someone/acme/lib/x"], subscribes: [] } }));

        expect(result.missingRepos).toEqual([
            {
                name: "acme-2",
                url: "https://fake.test/someone/acme",
                identity: "fake.test/someone/acme",
                provider: "fake",
                requiredBy: [{ ref: "https://fake.test/someone/acme/lib/x", requestedBy: "w/a" }],
            },
        ]);
    });

    it("should match a dependency by location to a trusted repository whatever its short name", async () => {
        const indexes = { acme: index("acme", { "w/a": { "1.0.0": {} } }), mirror: index("mirror", { "lib/x": { "1.0.0": {} } }) };
        const result = await resolveWanted([project("w", "a")], context(indexes, { "w/a@1.0.0": { depends: ["https://fake.test/owner/mirror/lib/x"], subscribes: [] } }));

        expect(result.resolved.find((recipe) => recipe.key === "lib/x")?.repo).toBe("mirror");
    });

    it("should report a cycle without failing", async () => {
        const acme = index("acme", { "w/a": { "1.0.0": {} }, "w/b": { "1.0.0": {} } });
        const result = await resolveWanted(
            [project("w", "a")],
            context({ acme }, { "w/a@1.0.0": { depends: ["w/b"], subscribes: [] }, "w/b@1.0.0": { depends: ["w/a"], subscribes: [] } }),
        );

        expect(result.cycles).toEqual([["w/a", "w/b", "w/a"]]);
        expect(result.resolved.map((recipe) => recipe.key)).toEqual(["w/a", "w/b"]);
    });

    it("should drop what a replaced version declared once a later holder narrows the version", async () => {
        const acme = index("acme", {
            "w/a": { "1.0.0": {}, "2.0.0": {} },
            "w/b": { "1.0.0": {} },
            "w/only-in-a2": { "1.0.0": {} },
        });
        const result = await resolveWanted(
            [project("w", "a"), project("w", "b")],
            context({ acme }, { "w/a@2.0.0": { depends: ["w/only-in-a2"], subscribes: [] }, "w/a@1.0.0": { depends: [], subscribes: [] }, "w/b@1.0.0": { depends: ["w/a@^1"], subscribes: [] } }),
        );

        expect(result.resolved.map((recipe) => `${recipe.key}@${recipe.version}`)).toEqual(["w/a@1.0.0", "w/b@1.0.0"]);
        expect(result.resolved[0].requestedBy).toEqual(["project", "w/b"]);
    });

    it("should settle a dependency that reads several ways by what the release recorded", async () => {
        const acme = index("acme", { "w/a": { "1.0.0": { dependencies: { "lib/x": {} } } }, "lib/x": { "1.0.0": {} }, "other/y": { "1.0.0": {} } });
        const result = await resolveWanted([project("w", "a")], context({ acme }, { "w/a@1.0.0": { depends: ["lib/x || other/y"], subscribes: [] } }));

        expect(result.resolved.map((recipe) => recipe.key)).toEqual(["lib/x", "w/a"]);
    });

    it("should refuse a dependency that reads several ways with nothing to settle it", async () => {
        const acme = index("acme", { "w/a": { "1.0.0": {} }, "lib/x": { "1.0.0": {} }, "other/y": { "1.0.0": {} } });

        await expect(resolveWanted([project("w", "a")], context({ acme }, { "w/a@1.0.0": { depends: ["lib/x || other/y"], subscribes: [] } }))).rejects.toThrow(/can be read 2 ways/);
    });

    it("should settle a browsed folder path to the recipe whose folder holds it", async () => {
        const indexes = { acme: index("acme", { "w/a": { "1.0.0": {} } }), lib: index("lib", { "tools/x": { "1.0.0": {}, "2.0.0": {} } }, { "tools/x": "recipes/tools/x" }) };
        const result = await resolveWanted([project("w", "a", { repo: "acme" })], context(indexes, { "w/a@1.0.0": { depends: ["https://fake.test/owner/lib/tree/main/recipes/tools/x/skills@^1"], subscribes: [] } }));

        expect(result.resolved.find((recipe) => recipe.key === "tools/x")).toMatchObject({ repo: "lib", version: "1.0.0" });
    });
});

describe("helpers", () => {
    it("should propose a short name from an identity, unique among those in use", () => {
        expect(proposeRepoName({}, "github.com/acme/recipes")).toBe("recipes");
        expect(proposeRepoName({ recipes: 1, "recipes-2": 1 }, "github.com/acme/recipes")).toBe("recipes-3");
    });

    it("should settle a browsed path to the deepest recipe, else to a namespace", () => {
        const acme = index("acme", { "w/a": { "1.0.0": {} }, "w/b": { "1.0.0": {} } });

        expect(settleBrowsed("main/recipes/w/a/skills/x.md", acme)).toEqual([{ namespace: "w", name: "a" }]);
        expect(settleBrowsed("main/recipes/w", acme)).toEqual([{ namespace: "w" }]);
        expect(settleBrowsed("main/elsewhere", acme)).toEqual([]);
    });

    it("should read declared lists from an index version only when it records them", () => {
        expect(indexDependencyLists(undefined)).toBeUndefined();
        expect(indexDependencyLists({ hash: HASH, tag: "t", prerelease: false })).toBeUndefined();
        expect(indexDependencyLists({ hash: HASH, tag: "t", prerelease: false, subscribes: ["x"] })).toEqual({ depends: [], subscribes: ["x"] });
    });

    it("should confirm a reading by what a release recorded", () => {
        expect(isConfirmedByRecord(parseOne("lib/x"), { "lib/x": {} })).toBe(true);
        expect(isConfirmedByRecord(parseOne("lib"), { "lib/x": {} })).toBe(true);
        expect(isConfirmedByRecord(parseOne("https://fake.test/o/r/lib/x"), { "lib/x": {} })).toBe(false);
        expect(isConfirmedByRecord(parseOne("https://fake.test/o/r/lib/x"), { "lib/x": { repo: "fake.test/o/r" } })).toBe(true);
    });

    it("should turn refs into wanted parts", () => {
        expect(wantedOf(parseOne("acme:w/a@^1"))).toEqual({ namespace: "w", name: "a", range: "^1", repo: "acme" });
        expect(wantedOf({ kind: "envVar", name: "X" })).toBeUndefined();
    });
});
