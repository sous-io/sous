import { describe, expect, it } from "vitest";
import { isConfigError } from "../test/errors.js";
import {
    createRecipeManifestFormat,
    indexFileFormat,
    linksMapFormat,
    lockfileFormat,
    repoManifestFormat,
    storeEntryFormat,
    variableDefinitionFormat,
} from "./parsers.js";

const SOURCE = "/project/sous.lock.json";

const hash = `sha256-${"a".repeat(64)}` as const;

describe("the lockfile format", () => {
    /** An empty lockfile parses and writes back to the same stable text. */
    it("should round-trip an empty lockfile as sorted JSON with a trailing newline", () => {
        const empty = lockfileFormat.empty();
        const text = lockfileFormat.stringify(empty);
        expect(text).toBe('{\n  "formatVersion": 1,\n  "recipes": {},\n  "repos": {}\n}\n');
        expect(lockfileFormat.parse(JSON.parse(text), SOURCE)).toEqual(empty);
    });

    /** `check` reports the problems and does not throw. */
    it("should return the issues from check instead of throwing", () => {
        const result = lockfileFormat.check({ formatVersion: 2, repos: {}, recipes: {} }, SOURCE);
        expect(result.value).toBeUndefined();
        expect(result.issues?.[0]).toBe(`Invalid lockfile at ${SOURCE}:`);
        expect(result.issues?.join("\n")).toContain("formatVersion");
    });

    /** `parse` throws a ConfigError naming the source. */
    it("should throw a ConfigError from parse", () => {
        try {
            lockfileFormat.parse({}, SOURCE);
            expect.unreachable();
        } catch (error) {
            expect(isConfigError(error)).toBe(true);
            expect((error as Error).message).toContain(SOURCE);
        }
    });

    /** Parsing is pure: a repository with no identity keeps none. */
    it("should not work out an identity", () => {
        const parsed = lockfileFormat.parse(
            { formatVersion: 1, repos: { r: { url: "https://github.com/sous-io/sous-recipes" } }, recipes: {} },
            SOURCE,
        );
        expect(parsed.repos["r"]!.identity).toBeUndefined();
    });

    /** Each writable format names its file. */
    it("should carry the file name", () => {
        expect(lockfileFormat.fileName).toBe("sous.lock.json");
        expect(linksMapFormat.fileName).toBe("sous.links.json");
        expect(indexFileFormat.fileName).toBe("sous.index.json");
        expect(storeEntryFormat.fileName).toBe(".sous.entry.json");
    });
});

describe("the other formats", () => {
    /** The empty links map parses. */
    it("should parse an empty links map", () => {
        expect(linksMapFormat.parse(linksMapFormat.empty(), SOURCE)).toEqual({ formatVersion: 1, links: {} });
    });

    /** A store entry round-trips through stringify. */
    it("should round-trip a store entry", () => {
        const entry = {
            formatVersion: 1 as const,
            repo: "github.com/sous-io/sous-recipes",
            namespace: "workflow",
            name: "task-files",
            version: "1.0.0",
            hash,
            fetchedAt: "2026-09-09T14:03:11.482Z",
            lastAccessAt: "2026-09-09T14:03:11.482Z",
            sizeBytes: 12,
        };
        expect(storeEntryFormat.parse(JSON.parse(storeEntryFormat.stringify(entry)), SOURCE)).toEqual(entry);
    });

    /** An index file with one recipe parses and keeps unknown keys. */
    it("should parse an index and keep keys of a newer format", () => {
        const index = {
            formatVersion: 1,
            name: "sous-recipes",
            generatedAt: "2026-09-09T14:03:11.482Z",
            generator: "0.2.34",
            namespaces: { workflow: {} },
            recipes: {
                "workflow/task-files": {
                    path: "recipes/workflow/task-files",
                    versions: {
                        "1.0.0": { hash, tag: "workflow/task-files@1.0.0", prerelease: false, later: 1 },
                    },
                },
            },
            future: true,
        };
        expect(indexFileFormat.parse(index, SOURCE)).toMatchObject({ future: true });
    });

    /** A repo manifest needs its namespaces and recipes. */
    it("should parse a repo manifest and reject a bad one", () => {
        expect(
            repoManifestFormat.parse(
                { formatVersion: 1, name: "r", namespaces: { workflow: {} }, recipes: ["recipes/workflow/a"] },
                SOURCE,
            ).name,
        ).toBe("r");
        expect(repoManifestFormat.check({ formatVersion: 1 }, SOURCE).issues).toBeDefined();
    });

    /** A variable definition applies its defaults. */
    it("should parse a variable definition and fill in defaults", () => {
        const parsed = variableDefinitionFormat.parse(
            { name: "apiUrl", type: "url", prompt: "Where?", description: "The API.", example: "https://a.b" },
            SOURCE,
        );
        expect(parsed).toMatchObject({ required: true, secret: false, scope: "shared" });
    });
});

describe("the recipe manifest format", () => {
    const manifest = {
        formatVersion: 1,
        namespace: "workflow",
        name: "task-files",
        version: "1.0.0",
        depends: ["workflow/other"],
    };

    /** The checker given is run on every dependency and its message carried through. */
    it("should run the dependency ref checker", () => {
        const seen: string[] = [];
        const format = createRecipeManifestFormat((ref) => {
            seen.push(ref);
            throw new Error("nope");
        });
        const result = format.check(manifest, SOURCE);
        expect(seen).toEqual(["workflow/other"]);
        expect(result.issues?.join("\n")).toContain("depends[0]: nope");
    });

    /** With no checker any non-empty ref passes, and contents default to empty. */
    it("should accept dependencies when no checker is given", () => {
        expect(createRecipeManifestFormat().parse(manifest, SOURCE).contents).toEqual([]);
    });
});
