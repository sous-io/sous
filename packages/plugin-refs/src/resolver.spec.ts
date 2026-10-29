import { ConfigError, definePlugin } from "@sous-io/plugin-api";
import { beforeAll, describe, expect, it } from "vitest";
import { catalogLookup, catalogRepo } from "../test/catalog-lookup.js";
import { buildRefs, lookupsPlugin, type Refs } from "../test/fixtures.js";
import { qualificationOf } from "./parts.js";
import { rulePruner } from "./pruners/rules.js";
import { selectLookups } from "./resolver.js";
import type { RefLookupEntity, RefSource, SousRef } from "./types.js";

let refs: Refs;

beforeAll(async () => {
    refs = await buildRefs();
});

/** Every place a ref was written before the include line existed. */
const EVERY_SOURCE: RefSource[] = ["commandLine", "config", "manifest", "lockfile"];
const ALL = [...EVERY_SOURCE];
const LOCATED: RefSource[] = ["commandLine", "manifest"];

/**
 * The readings a place keeps that name a namespace, a recipe in a namespace or a repository by
 * location, printed canonically: the forms the old parser knew.
 */
function printed(ref: string, from: RefSource = "commandLine"): string[] {
    return refs.resolver
        .parse(ref, from)
        .refs.filter(
            (entry) =>
                entry.kind === "namespace" ||
                (entry.kind === "recipe" && entry.namespace !== undefined) ||
                (entry.kind === "repo" && entry.location !== undefined),
        )
        .map((entry) => refs.format.format(entry));
}

/** The message a ref raises in a place, or undefined when it parses there. */
function refusal(ref: string, from: RefSource): string | undefined {
    try {
        refs.resolver.parse(ref, from);

        return undefined;
    } catch (error) {
        const sous = error as ConfigError;

        return [sous.message, ...sous.details].join("\n");
    }
}

/** Checks one form in every place: read where it is allowed, refused saying what to write elsewhere. */
function checkEverywhere(ref: string, expected: string[], allowed: RefSource[], instead: Partial<Record<RefSource, string>> = {}): void {
    for (const from of EVERY_SOURCE) {
        if (allowed.includes(from)) {
            expect(printed(ref, from), `${ref} ${from}`).toEqual(expected);
            continue;
        }

        const message = refusal(ref, from);

        expect(message, `${ref} should be refused in ${from}`).toBeDefined();
        expect(message).toContain("Write ");

        if (instead[from] !== undefined) {
            expect(message).toContain(instead[from]);
        }
    }
}

describe("refs.resolver parse() (the forms, ported from the old parser)", () => {
    /**
     * A bare namespace and a namespace with a recipe are read in every place.
     *
     * parse("workflow/alpha", from) // -> the recipe workflow/alpha
     */
    it("should read a bare namespace and a namespace with a recipe everywhere", () => {
        checkEverywhere("workflow", ["workflow"], ALL);
        checkEverywhere("workflow/alpha", ["workflow/alpha"], ALL);
    });

    /**
     * `namespace/*` is read on the command line and in a manifest; a stored key is the name alone.
     *
     * parse("workflow/*") // -> the namespace workflow
     */
    it("should read the /* spelling of a namespace where it is allowed", () => {
        checkEverywhere("workflow/*", ["workflow"], LOCATED, { config: "'workflow'", lockfile: "'workflow'" });
    });

    /**
     * A `repo:` qualifier is read on the command line only.
     *
     * parse("repo:workflow/alpha") // -> repo:workflow/alpha
     */
    it("should read a repo qualifier on the command line only", () => {
        checkEverywhere("repo:workflow/alpha", ["repo:workflow/alpha"], ["commandLine"], {
            manifest: "github://owner/repository/workflow/alpha",
            config: "sous subscribe repo:workflow/alpha",
            lockfile: "'workflow/alpha'",
        });
    });

    /**
     * A version range is read on the command line and in a manifest; a config file keeps it in
     * the entry's own `range` field.
     *
     * parse("workflow/alpha@^1.2")[0].range // -> "^1.2"
     */
    it("should read a version range where it is allowed", () => {
        checkEverywhere("workflow/alpha@^1.2", ["workflow/alpha@^1.2"], LOCATED, { config: "range: '^1.2'", lockfile: "'workflow/alpha'" });
    });

    /**
     * A host-scheme locator names the repository and the namespace in it.
     *
     * parse("github://owner/repo/workflow") // -> namespace workflow at github.com/owner/repo
     */
    it("should read a host-scheme locator for a namespace", () => {
        checkEverywhere("github://owner/repo/workflow", ["github://owner/repo/workflow"], LOCATED, { config: "sous subscribe github://owner/repo/workflow" });
        expect(refs.resolver.parse("github://owner/repo/workflow").refs.find((ref) => ref.kind === "namespace")).toEqual({
            kind: "namespace",
            name: "workflow",
            repo: {
                kind: "repo",
                location: { provider: "github", host: "github.com", repoPath: "owner/repo", identity: "github.com/owner/repo", url: "https://github.com/owner/repo" },
            },
        });
    });

    /**
     * The same with a wildcard, and for a recipe with a range.
     *
     * parse("github://owner/repo/workflow/alpha@^1")
     */
    it("should read a locator with a wildcard, and for a recipe", () => {
        checkEverywhere("github://owner/repo/workflow/*", ["github://owner/repo/workflow"], LOCATED);
        checkEverywhere("github://owner/repo/workflow/alpha@^1", ["github://owner/repo/workflow/alpha@^1"], LOCATED);
    });

    /**
     * An HTTPS URL, with or without a scheme, reads like the locator.
     *
     * parse("https://github.com/owner/repo/workflow/alpha")
     */
    it("should read an HTTPS URL and a scheme-less host path", () => {
        checkEverywhere("https://github.com/owner/repo/workflow/alpha", ["github://owner/repo/workflow/alpha"], LOCATED);
        checkEverywhere("http://github.com/owner/repo/workflow", ["github://owner/repo/workflow"], LOCATED);
        checkEverywhere("github.com/owner/repo/workflow/alpha", ["github://owner/repo/workflow/alpha"], LOCATED);
    });

    /**
     * An SSH remote names a repository: a reading on the command line, refused in a manifest
     * without a namespace after it.
     *
     * parse("git@github.com:owner/repo.git") // -> a repository
     */
    it("should read an SSH remote", () => {
        checkEverywhere("git@github.com:owner/repo.git", ["github://owner/repo"], ["commandLine"]);
        expect(refusal("git@github.com:owner/repo.git", "manifest")).toContain("nothing inside it");
        expect(refusal("git@github.com:owner/repo.git", "manifest")).toContain("Write 'github://owner/repo/namespace/recipe' instead.");
        checkEverywhere("git@github.com:owner/repo.git/workflow/alpha", ["github://owner/repo/workflow/alpha"], LOCATED);
        checkEverywhere("ssh://git@github.com/owner/repo.git/workflow", ["github://owner/repo/workflow"], LOCATED);
    });

    /**
     * A browser URL reads as a browsed repository path, settled later through the index.
     *
     * parse("https://github.com/owner/repo/tree/main/recipes/workflow/alpha")
     */
    it("should read a browser URL as a browsed path", () => {
        const url = "https://github.com/owner/repo/tree/main/recipes/workflow/alpha";

        expect(refs.resolver.parse(url).refs).toContainEqual(expect.objectContaining({ kind: "repo", browsed: "main/recipes/workflow/alpha" }));
        expect(refs.resolver.parse(url, "manifest").refs).toHaveLength(1);
        expect(refs.resolver.parse("https://github.com/owner/repo/blob/main/recipes/workflow/alpha/SKILL.md").refs).toContainEqual(
            expect.objectContaining({ kind: "repo", browsed: "main/recipes/workflow/alpha/SKILL.md" }),
        );
    });

    /**
     * A `.git` suffix on the repository is dropped, in every URL form.
     *
     * parse("https://github.com/owner/repo.git/workflow/alpha")
     */
    it("should drop a .git suffix on the repository", () => {
        for (const ref of ["https://github.com/owner/repo.git/workflow/alpha", "github://owner/repo.git/workflow/alpha", "github.com/owner/repo.git/workflow/alpha"]) {
            checkEverywhere(ref, ["github://owner/repo/workflow/alpha"], LOCATED);
        }
    });

    /**
     * GitLab: `/-/` names the project exactly, and a nested group without one reads every way.
     *
     * parse("https://gitlab.com/a/b/c/d") // -> projects a/b and a/b/c
     */
    it("should read every GitLab form, with every reading of a nested group", () => {
        checkEverywhere("https://gitlab.com/group/sub/repo/-/tree/main/recipes/workflow/alpha", ["gitlab://group/sub/repo/-/tree/main/recipes/workflow/alpha"], LOCATED);
        checkEverywhere("gitlab://group/sub/repo/-/workflow/alpha", ["gitlab://group/sub/repo/-/workflow/alpha"], LOCATED);

        const both = ["gitlab://a/b/c/-/d", "gitlab://a/b/-/c/d"];

        for (const ref of ["https://gitlab.com/a/b/c/d", "gitlab://a/b/c/d", "gitlab.com/a/b/c/d"]) {
            expect(printed(ref).sort(), ref).toEqual([...both].sort());
        }

        checkEverywhere("gitlab://a/b/c/d/*", ["gitlab://a/b/c/-/d"], LOCATED);
        checkEverywhere("git@gitlab.com:a/b/c.git/d", ["gitlab://a/b/c/-/d"], LOCATED);
        checkEverywhere("gitlab://a/b.git/c/d", ["gitlab://a/b/-/c/d"], LOCATED);
        checkEverywhere("gitlab://gitlab.example.com/a/b/-/c/d@^2", ["gitlab://gitlab.example.com/a/b/-/c/d@^2"], LOCATED);
        checkEverywhere("https://gitlab.example.com/a/b/-/c/d", ["gitlab://gitlab.example.com/a/b/-/c/d"], LOCATED);
        expect(printed("gitlab://a/b/c/d@^1")).toEqual(["gitlab://a/b/-/c/d@^1"]);
    });

    /**
     * The command line keeps names as typed; a manifest stores them lowercase; a stored key must
     * already be lowercase.
     *
     * parse("Workflow/Alpha", "manifest") // -> workflow/alpha
     */
    it("should keep, lowercase and refuse the case of names by place", () => {
        expect(printed("Workflow/Alpha")).toEqual(["Workflow/Alpha"]);
        expect(printed("Workflow/Alpha", "manifest")).toEqual(["workflow/alpha"]);
        expect(printed("github://Owner/Repo/Workflow/Alpha", "manifest")).toEqual(["github://Owner/Repo/workflow/alpha"]);
        expect(refusal("Workflow", "lockfile")).toContain("Write 'workflow' instead.");
        expect(refusal("Workflow/Alpha", "config")).toContain("Write 'workflow/alpha' instead.");
    });

    /**
     * A name that is not kebab case is not a name anywhere; on the command line it is still an
     * environment variable name.
     *
     * parse("work_flow") // -> an envVar on the command line, refused elsewhere
     */
    it("should refuse a name that is not kebab-case", () => {
        expect(refs.resolver.parse("work_flow").refs.map((ref) => ref.kind)).toEqual(["envVar"]);

        for (const from of ["config", "manifest", "lockfile"] as const) {
            expect(refusal("work_flow", from)).toContain("must be kebab-case");
        }

        for (const from of EVERY_SOURCE) {
            expect(refusal("workflow/1alpha", from)).toContain("must be kebab-case");
        }

        expect(refusal("github://owner/repo/work_flow", "manifest")).toContain("must be kebab-case");
    });

    /**
     * A local repository is not a published location; elsewhere it is added by its path.
     *
     * parse("local:///x/workflow/alpha", "manifest") // throws
     */
    it("should refuse a local location, saying what to write instead", () => {
        expect(refusal("local:///x/y/workflow/alpha", "manifest")).toContain("the recipe's published location");
        expect(refusal("file:///x/y/workflow/alpha", "commandLine")).toContain("sous repo add <path>");
    });

    /**
     * A config file and a stored key never name a location.
     *
     * parse("https://github.com/o/r/w", "config") // throws "... run 'sous subscribe ...'"
     */
    it("should refuse a location in a config file and in a stored key", () => {
        expect(refusal("https://github.com/o/r/w", "config")).toContain("sous subscribe https://github.com/o/r/w");
        expect(refusal("https://github.com/o/r/w", "lockfile")).toContain("never names a location");
    });

    /**
     * An unknown scheme and an unrecognized host are refused, naming what is accepted.
     *
     * parse("bitbucket://o/r/w") // throws "... sous has these: github, gitlab ..."
     */
    it("should refuse an unknown scheme and an unrecognized host", () => {
        expect(refusal("bitbucket://o/r/w", "manifest")).toContain("sous has these: github, gitlab");
        expect(refusal("https://git.example.com/o/r/w", "commandLine")).toContain("://git.example.com/owner/repository/namespace/recipe");
    });

    /**
     * Too many segments name a file inside a recipe, which a short ref cannot be.
     *
     * parse("a/b/c") // throws, on the command line
     */
    it("should refuse too many segments, pointing at the browser URL", () => {
        expect(refusal("github://o/r/a/b/c", "manifest")).toContain("copied from the browser");
        expect(refusal("a/b/c", "commandLine")).toContain("copied from the browser");
    });

    /**
     * A range needs a recipe and must be a real range.
     *
     * parse("workflow@^1", "manifest") // throws
     */
    it("should refuse a range on a namespace and a range that is not one", () => {
        expect(refusal("workflow@^1", "manifest")).toContain("namespaces are not versioned");
        expect(refusal("github://o/r/workflow@^1", "manifest")).toContain("namespaces are not versioned");
        expect(refusal("workflow/alpha@nope", "manifest")).toContain("is not a version range");
        expect(refusal("github://o/r/workflow/alpha@nope", "manifest")).toContain("is not a version range");
        expect(refusal("workflow/alpha@", "commandLine")).toContain("not followed");
        expect(refusal("github://o/r/w/a@", "commandLine")).toContain("not followed");
        expect(refusal("a@1@2", "commandLine")).toContain("at most one '@'");
    });

    /**
     * Empty refs, sigils and doubled qualifiers are malformed everywhere.
     *
     * parse("") // throws
     */
    it("should refuse malformed refs everywhere", () => {
        for (const from of EVERY_SOURCE) {
            expect(refusal("", from)).toContain("must not be empty");
            expect(refusal("@workflow", from)).toContain("no '@' prefix");
            expect(refusal("~workflow", from)).toContain("no '~' prefix");
            expect(refusal("/alpha", from)).toContain("namespace is empty");
            expect(refusal("workflow/", from)).toContain("recipe name after '/' is empty");
        }

        expect(refusal("a:b:c", "commandLine")).toContain("at most one 'repo:'");
        expect(refusal(":workflow", "commandLine")).toContain("qualifier before ':' is empty");
        expect(refusal("re_po:workflow", "commandLine")).toContain("must be kebab-case");
        expect(refusal(42 as unknown as string, "commandLine")).toContain("must be a string");
        expect(refusal("https://", "commandLine")).toBeDefined();
    });

    /**
     * The canonical form round-trips, and the key drops the range but keeps the repository.
     *
     * format(parse(" repo:workflow/alpha@^1.0 ")) // -> "repo:workflow/alpha@^1.0"
     */
    it("should print the canonical form and key", () => {
        expect(printed(" repo:workflow/alpha@^1.0 ")).toEqual(["repo:workflow/alpha@^1.0"]);
        expect(printed("https://github.com/o/r/w/a@^1")).toEqual(["github://o/r/w/a@^1"]);
        expect(printed("github://github.com/o/r/w")).toEqual(["github://o/r/w"]);
        expect(refs.format.key(refs.resolver.parse("repo:workflow/alpha@^1").refs[0]!)).toBe("repo:workflow/alpha");
    });
});

describe("refs.resolver parse() (the new forms)", () => {
    /**
     * Query values are kept on the ref and printed back.
     *
     * parse("workflow/alpha?x=a%20b").refs[0].vars // -> { x: "a b" }
     */
    it("should keep query values on the ref", () => {
        const ref = refs.resolver.parse("workflow/alpha?x=a%20b").refs[0]!;

        expect(ref.vars).toEqual({ x: "a b" });
        expect(refs.format.format(ref)).toBe("workflow/alpha?x=a%20b");
    });

    /**
     * A variable is written `namespace/recipe.name`; an environment variable name is held whole.
     *
     * parse("workflow/task-files.apiUrl") // -> a variable
     */
    it("should read a variable and an environment variable name on the command line", () => {
        expect(refs.resolver.parse("workflow/task-files.apiUrl").refs.map((ref) => ref.kind)).toEqual(["variable"]);
        expect(refs.resolver.parse("SOUS_VAR_API_URL").refs).toEqual([{ kind: "envVar", name: "SOUS_VAR_API_URL" }]);
    });

    /**
     * An include line takes a file inside a recipe, glob allowed, and refuses `.` and `..`.
     *
     * parse("workflow/task-files/_partials/*.md", "include") // -> a recipeFile
     */
    it("should read a recipe file in an include line", () => {
        expect(refs.resolver.parse("workflow/task-files/_partials/*.md", "include").refs[0]).toMatchObject({ kind: "recipeFile", path: "_partials/*.md", glob: true });
        expect(refusal("w/a/../f.md", "include")).toContain("'.' or '..'");
        expect(refusal("github://o/r/w/a/f.md", "include")).toContain("never names a location");
        expect(refusal("w/a/f.md@^1", "include")).toContain("takes no version range");
    });

    /**
     * Refs come best first: a fully qualified spelling before a bare one, an environment variable
     * name last.
     *
     * parse("workflow") // -> repo, namespace, recipe, variable, envVar
     */
    it("should list readings by qualification, then kind", () => {
        expect(refs.resolver.parse("workflow").refs.map((ref) => ref.kind)).toEqual(["repo", "namespace", "recipe", "variable", "envVar"]);
        expect(qualificationOf(refs.resolver.parse("r:w/a").refs[0]!)).toBe(0);
        expect(qualificationOf(refs.resolver.parse("w/a").refs[0]!)).toBe(1);
        expect(qualificationOf(refs.resolver.parse("w").refs[1]!)).toBe(2);
        expect(qualificationOf(refs.resolver.parse("SOUS_VAR_X").refs[0]!)).toBe(3);
    });

    /**
     * Nothing left after pruning is one error listing every reason.
     *
     * parse("workflow/*", "config") // throws, listing why each reading was refused
     */
    it("should list every dropped reason when nothing is left", () => {
        const message = refusal("workflow/*", "config")!;

        expect(message).toContain("cannot be written as a subscription key in a config file. Every way it reads is refused");
        expect(message).toContain("Write 'workflow' instead.");
        expect(refusal("workflow", "include")).toContain("Write 'namespace/recipe/path/to/file.md' instead.");
    });

    /**
     * A place no pruner speaks for is named in the error; a plugin adds one with a pruner entity.
     *
     * parse("workflow", "report") // throws "No pruner is registered for a ref written as 'report'."
     */
    it("should name a place no pruner speaks for, and use a pruner a plugin adds", async () => {
        expect(() => refs.resolver.parse("workflow", "report")).toThrow(/No pruner is registered for a ref written as 'report'/);

        const report = rulePruner({
            id: "report",
            source: "report",
            place: "in a report filter",
            rules: [{ matches: (ref) => ref.kind !== "namespace", action: "drop", message: "a report filters by namespace." }],
        });
        const withPlugin = await buildRefs({ plugins: [definePlugin({ name: "test-report", version: "1.0.0", register: (sous) => sous.entities.add("ref-pruner", report) })] });

        expect(withPlugin.resolver.parse("workflow", "report").refs.map((ref) => ref.kind)).toEqual(["namespace"]);
        expect(() => withPlugin.resolver.parse("w/a", "report")).toThrow("The ref 'w/a' cannot be written in a report filter: a report filters by namespace.");
    });

    /**
     * Several pruners for one place run in turn, each given what the one before kept, and a warn
     * rule keeps the reading with a warning.
     *
     * parse("Workflow", "commandLine") with a warning pruner // -> kept, and a warning
     */
    it("should run every pruner for a place in turn, collecting warnings", async () => {
        const shout = rulePruner({
            id: "shout",
            source: "commandLine",
            rules: [{ matches: (ref) => /[A-Z]/.test(ref.kind === "envVar" ? "" : JSON.stringify(ref)), action: "warn", message: "names are usually lowercase." }],
        });
        const withPlugin = await buildRefs({ plugins: [definePlugin({ name: "test-shout", version: "1.0.0", register: (sous) => sous.entities.add("ref-pruner", shout) })] });
        const result = withPlugin.resolver.parse("Workflow/Alpha");

        expect(result.refs).toHaveLength(1);
        expect(result.warnings).toEqual(["names are usually lowercase."]);
    });
});

describe("refs.resolver resolve()", () => {
    const repos = [catalogRepo("one", ["workflow/task-files", "workflow/alpha"]), catalogRepo("two", ["tools/task-files"])];
    const lookup = catalogLookup(repos);

    /**
     * With no lookup, resolve returns the readings the place allows.
     *
     * resolve({ input: "workflow/alpha", lookups: false }) // -> the recipe, usedLookup false
     */
    it("should return the pruned readings when there is no lookup", async () => {
        const result = await refs.resolver.resolve({ input: "workflow/alpha" });

        expect(result.usedLookup).toBe(false);
        expect(result.refs).toHaveLength(1);
        expect(result.dropped).toEqual([]);
    });

    /**
     * With a lookup, readings narrow to what exists in the published spelling, and an ambiguous
     * bare name keeps every match in listing order.
     *
     * resolve("task-files") // -> one:workflow/task-files, two:tools/task-files
     */
    it("should narrow to known refs and list them best first", async () => {
        const result = await refs.resolver.resolve({ input: "task-files", extraLookups: [lookup] });

        expect(result.usedLookup).toBe(true);
        expect(result.refs.map((ref) => refs.format.key(ref))).toEqual(["one:workflow/task-files", "two:tools/task-files"]);
    });

    /**
     * Exact-spelling matches win over case-insensitive ones, and the known spelling comes back.
     *
     * resolve("Workflow/Alpha") // -> one:workflow/alpha
     */
    it("should prefer exact spelling and return the published one", async () => {
        expect((await refs.resolver.resolve({ input: "Workflow/Alpha", extraLookups: [lookup] })).refs.map((ref) => refs.format.key(ref))).toEqual(["one:workflow/alpha"]);
        expect((await refs.resolver.resolve({ input: "workflow", extraLookups: [lookup] })).refs.map((ref) => refs.format.key(ref))).toEqual(["one:workflow"]);
    });

    /**
     * A ref nothing knows comes back with no refs, for the caller to report.
     *
     * resolve("nothing") // -> refs []
     */
    it("should return no refs for a ref nothing knows", async () => {
        const result = await refs.resolver.resolve({ input: "nothing", extraLookups: [lookup] });

        expect(result.refs).toEqual([]);
        expect(result.usedLookup).toBe(true);
    });

    /**
     * A lookup that fails makes resolve fail; the error is never swallowed.
     *
     * resolve with a throwing lookup // rejects "offline"
     */
    it("should let a failing lookup throw", async () => {
        const failing: RefLookupEntity = { id: "failing", find: () => Promise.reject(new Error("offline")) };

        await expect(refs.resolver.resolve({ input: "workflow", extraLookups: [failing] })).rejects.toThrow("offline");
    });

    /**
     * The same ref found by two readings is returned once.
     *
     * a lookup answering every reading with one namespace // -> one ref
     */
    it("should return a ref found twice only once", async () => {
        const same: RefLookupEntity = { id: "same", find: () => Promise.resolve([{ ref: { kind: "namespace", name: "workflow" }, exactSpelling: true }]) };

        expect((await refs.resolver.resolve({ input: "workflow", extraLookups: [same] })).refs).toHaveLength(1);
    });

    /**
     * A refused ref names nothing when the caller says so, and raises the refusal otherwise.
     *
     * resolve({ input: "a/b/c", refusedIsEmpty: true }) // -> refs []
     */
    it("should treat a refused ref as naming nothing only when asked", async () => {
        expect((await refs.resolver.resolve({ input: "a/b/c", extraLookups: [lookup], refusedIsEmpty: true })).refs).toEqual([]);
        expect((await refs.resolver.resolve({ input: "   ", extraLookups: [lookup], refusedIsEmpty: true })).refs).toEqual([]);
        await expect(refs.resolver.resolve({ input: "a/b/c", extraLookups: [lookup] })).rejects.toThrow(/at most two path segments/);
    });
});

describe("refs.resolver lookups as entities", () => {
    const installed: RefLookupEntity = {
        id: "lockfile",
        tags: ["installed"],
        kinds: ["namespace", "recipe"],
        find: (candidate) =>
            Promise.resolve(
                candidate.kind === "recipe" && candidate.name === "alpha"
                    ? [{ ref: { kind: "recipe", name: "alpha", namespace: { kind: "namespace", name: "workflow", repo: { kind: "repo", name: "pinned" } } }, exactSpelling: true }]
                    : [],
            ),
    };
    const fetched: RefLookupEntity = {
        ...catalogLookup([catalogRepo("remote", ["workflow/alpha", "workflow/beta"])], { id: "fetched-index", tags: ["latest"] }),
        optIn: true,
    };
    const asked: string[] = [];
    const variables: RefLookupEntity = {
        id: "variables",
        kinds: ["variable"],
        find: (candidate) => {
            asked.push(candidate.kind);

            return Promise.resolve([]);
        },
    };
    let withLookups: Refs;

    beforeAll(async () => {
        withLookups = await buildRefs({ plugins: [lookupsPlugin(installed, fetched, variables)] });
    });

    /**
     * By default every lookup that is not opt-in is asked, and only for the kinds it answers.
     *
     * resolve("alpha") // -> pinned:workflow/alpha, from the lockfile lookup alone
     */
    it("should ask every default lookup, each only for its kinds", async () => {
        const result = await withLookups.resolver.resolve({ input: "alpha" });

        expect(result.usedLookup).toBe(true);
        expect(result.refs.map((ref) => withLookups.format.key(ref))).toEqual(["pinned:workflow/alpha"]);
        expect(asked).toEqual(["variable"]);
    });

    /**
     * An opt-in lookup is asked when a caller names it or one of its tags; the answers of every
     * selected lookup are joined.
     *
     * resolve({ input: "alpha", lookups: ["installed", "latest"] }) // -> pinned and remote
     */
    it("should select lookups by id and tag, joining their answers", async () => {
        const byTag = await withLookups.resolver.resolve({ input: "alpha", lookups: ["installed", "latest"] });

        expect(byTag.refs.map((ref) => withLookups.format.key(ref))).toEqual(["pinned:workflow/alpha", "remote:workflow/alpha"]);

        const byId = await withLookups.resolver.resolve({ input: "beta", lookups: ["fetched-index"] });

        expect(byId.refs.map((ref) => withLookups.format.key(ref))).toEqual(["remote:workflow/beta"]);
    });

    /**
     * `lookups: false` asks none; a selection that names nothing at all is an error naming it.
     *
     * resolve({ input: "alpha", lookups: ["nowhere"] }) // throws "No ref lookup answers to 'nowhere'."
     */
    it("should ask none when lookups are off, and report a selection that names nothing", async () => {
        expect((await withLookups.resolver.resolve({ input: "alpha", lookups: false })).usedLookup).toBe(false);
        await expect(withLookups.resolver.resolve({ input: "alpha", lookups: ["nowhere"] })).rejects.toThrow("No ref lookup answers to 'nowhere'.");
    });

    /**
     * selectLookups keeps the order a selection names lookups in, each once.
     *
     * selectLookups([a, b], ["b", "a", "b"]) // -> [b, a]
     */
    it("should keep the order of the selection", () => {
        expect(selectLookups([installed, fetched, variables], ["latest", "installed", "lockfile"]).map((lookup) => lookup.id)).toEqual(["fetched-index", "lockfile"]);
        expect(selectLookups([installed, fetched], true).map((lookup) => lookup.id)).toEqual(["lockfile"]);
    });

    /**
     * The kinds a caller accepts set other readings aside before any lookup is asked, and other
     * matches after; a browser URL is kept for a caller that accepts recipes.
     *
     * resolve({ input: "workflow", kinds: ["namespace"] }) // -> namespaces only
     */
    it("should set aside readings and matches of kinds the caller does not accept", async () => {
        const result = await refs.resolver.resolve({ input: "workflow", kinds: ["namespace"], lookups: false });

        expect(result.refs.map((ref) => ref.kind)).toEqual(["namespace"]);

        const browsed = await refs.resolver.resolve({ input: "https://github.com/o/r/tree/main/w/a", kinds: ["recipe"], lookups: false });

        expect(browsed.refs.map((ref) => ref.kind)).toEqual(["repo"]);
    });
});

describe("refs.resolver helpers", () => {
    /**
     * isValid says whether a place allows a ref.
     *
     * isValid("workflow/alpha", "config") // -> true
     */
    it("should tell a valid ref from an invalid one", () => {
        expect(refs.resolver.isValid("workflow/alpha", "config")).toBe(true);
        expect(refs.resolver.isValid("workflow/alpha@^1", "config")).toBe(false);
        expect(refs.resolver.isValid("", "commandLine")).toBe(false);
        expect(refs.resolver.isValid("workflow")).toBe(true);
    });

    /**
     * findInString finds the refs among the words of a text, the punctuation around each taken off.
     *
     * findInString("see 'workflow/task-files', then") // -> workflow/task-files at index 5
     */
    it("should find the refs inside a string", () => {
        const found = refs.resolver.findInString("see 'workflow/task-files', then (a b/c/d.md) ok");
        const texts = found.map((entry) => entry.text);

        expect(texts).toContain("workflow/task-files");
        expect(found.find((entry) => entry.text === "workflow/task-files")?.index).toBe(5);
        expect(texts).not.toContain("(a");
        expect(refs.resolver.findInString("x w/a/b.md y", "include").map((entry) => entry.text)).toEqual(["w/a/b.md"]);
    });
});

describe("refs.resolver resolveSync()", () => {
    /** A lookup that knows one recipe file, answering both ways. */
    const lookup: RefLookupEntity = {
        id: "files",
        findSync: (candidate: SousRef) => (candidate.kind === "recipeFile" && candidate.recipe.name === "alpha" ? [{ ref: candidate, exactSpelling: true }] : []),
        find: () => Promise.resolve([]),
    };

    /**
     * resolveSync narrows the readings without waiting.
     *
     * resolveSync({ input: "w/alpha/f.md", from: "include" }) // -> the recipe file
     */
    it("should narrow readings against a synchronous lookup", () => {
        expect(refs.resolver.resolveSync({ input: "w/alpha/f.md", from: "include", extraLookups: [lookup] }).refs.map((ref) => ref.kind)).toEqual(["recipeFile"]);
        expect(refs.resolver.resolveSync({ input: "w/beta/f.md", from: "include", extraLookups: [lookup] }).refs).toEqual([]);
    });

    /**
     * A lookup with no findSync is skipped, and a refused ref raises the place's refusal.
     *
     * resolveSync with { find } only // -> refs [] (nothing could answer)
     */
    it("should skip a lookup that cannot answer at once, and raise a refusal", () => {
        const asyncOnly: RefLookupEntity = { id: "async", find: () => Promise.resolve([]) };

        expect(refs.resolver.resolveSync({ input: "w/alpha/f.md", from: "include", extraLookups: [asyncOnly] }).refs).toEqual([]);
        expect(() => refs.resolver.resolveSync({ input: "w/alpha", from: "include", extraLookups: [lookup] })).toThrow(/names a file inside a recipe/);
    });

    /**
     * What a place dropped comes back with the reason, for a caller that explains it in its own words.
     *
     * resolve({ input: "w/a/../f.md", from: "include", refusedIsEmpty: true }).dropped // -> one recipe file
     */
    it("should return the dropped readings with the reason", () => {
        const { refs: kept, dropped } = refs.resolver.resolveSync({ input: "w/a/../f.md", from: "include", refusedIsEmpty: true, lookups: false });

        expect(kept).toEqual([]);
        expect(dropped[0]?.ref.kind).toBe("recipeFile");
        expect(dropped[0]?.reason).toContain("'.' or '..'");
    });
});
