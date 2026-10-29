import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeProject, standInGlobs, type TestProject } from "../test/helpers.js";
import { ConfigFilesLoaderImpl, mainCandidates } from "./loader.js";
import { baseNameOf, formatOf } from "./names.js";

let project: TestProject;
let loader: ConfigFilesLoaderImpl;

beforeEach(() => {
    project = makeProject();
    loader = new ConfigFilesLoaderImpl({
        project: project.info(),
        globs: () => standInGlobs,
        evaluator: () => undefined,
        pathVariables: () => ({ sousDir: project.sousDir }),
    });
});

afterEach(() => {
    project.cleanup();
});

describe("formatOf()", () => {
    /**
     * Each file name means one format; the longer ending wins.
     *
     * formatOf("720-x.patch.json");   // "patch-json"
     */
    it("should name the format of every file sous reads", () => {
        expect(formatOf("a.json")).toBe("json");
        expect(formatOf("a.jsonc")).toBe("jsonc");
        expect(formatOf("a.yaml")).toBe("yaml");
        expect(formatOf("a.yml")).toBe("yaml");
        expect(formatOf("a.js")).toBe("js");
        expect(formatOf("a.mjs")).toBe("js");
        expect(formatOf("a.ts")).toBe("ts");
        expect(formatOf("a.mts")).toBe("ts");
        expect(formatOf("720-x.patch.json")).toBe("patch-json");
        expect(formatOf("721-x.patch.jsonl")).toBe("patch-jsonl");
    });

    /** Anything else, and dot files, are not config files. */
    it("should skip files that are not config", () => {
        expect(formatOf("README.md")).toBeUndefined();
        expect(formatOf(".env")).toBeUndefined();
        expect(formatOf(".hidden.json")).toBeUndefined();
        expect(formatOf("notes.txt")).toBeUndefined();
    });

    /** The base name drops the final extension only. */
    it("should give a file's base name", () => {
        expect(baseNameOf("500-repos.jsonc")).toBe("500-repos");
        expect(baseNameOf("720-x.patch.json")).toBe("720-x.patch");
    });
});

describe("findMain()", () => {
    /** A TypeScript config comes first, then JavaScript, then data files. */
    it("should find sous.config.* in the order the names are tried", () => {
        project.write("sous.config.json", "{}");
        expect(loader.findMain(project.sousDir)).toBe(path.join(project.sousDir, "sous.config.json"));

        project.write("sous.config.js", "export default {};");
        expect(loader.findMain(project.sousDir)).toBe(path.join(project.sousDir, "sous.config.js"));
        expect(mainCandidates(project.sousDir)).toHaveLength(2);
    });

    /** A directory named like a config file is not one. */
    it("should ignore a directory named like a config file", () => {
        fs.mkdirSync(path.join(project.sousDir, "sous.config.json"));

        expect(loader.findMain(project.sousDir)).toBeUndefined();
    });
});

describe("findPatches()", () => {
    /** The patch files beside sous.config.*, bytewise. */
    it("should list sous.config patch files, bytewise", () => {
        project.write("sous.config.patch.jsonl", "");
        project.write("sous.config.patch.json", "{}");
        project.write("sous.config.b.patch.json", "{}");
        project.write("other.patch.json", "{}");
        project.write("sous.config.json", "{}");

        expect(loader.findPatches(project.sousDir).map((file) => path.basename(file))).toEqual([
            "sous.config.b.patch.json",
            "sous.config.patch.json",
            "sous.config.patch.jsonl",
        ]);
        expect(loader.findPatches(path.join(project.sousDir, "missing"))).toEqual([]);
    });
});

describe("load()", () => {
    /** A data file keeps its text, for `config show --raw`. */
    it("should read a data file with its text", async () => {
        const file = project.write("sous.config.jsonc", '{ "name": "x" } // note\n');

        expect(await loader.load(file)).toEqual({
            kind: "data",
            path: file,
            format: "jsonc",
            data: { name: "x" },
            text: '{ "name": "x" } // note\n',
        });
    });

    /** An empty YAML file is an empty config. */
    it("should read an empty YAML file as {}", async () => {
        const file = project.write("conf.d/1.yaml", "");

        expect((await loader.load(file)).kind === "data" && (await loader.load(file))).toMatchObject({ data: {} });
    });

    /** A patch file's patches, from `$patches` or one per line. */
    it("should read patch files", async () => {
        const one = project.write("conf.d/722-one.patch.json", '{ "op": "deleteKey", "path": "tools", "key": "codex" }');
        const lines = project.write("conf.d/721-lines.patch.jsonl", '{"op": "setKey", "path": "", "key": "a", "value": 1}\n\n');

        expect(await loader.load(one)).toMatchObject({ kind: "patch", patches: [{ op: "deleteKey", path: "tools", key: "codex" }] });
        expect(await loader.load(lines)).toMatchObject({ kind: "patch", patches: [{ op: "setKey", key: "a" }] });
    });

    /** A broken patch file names itself. */
    it("should name a broken patch file", async () => {
        const file = project.write("conf.d/723-bad.patch.json", '{ "op": "explode" }');

        await expect(loader.load(file)).rejects.toThrow(/723-bad\.patch\.json/);
    });

    /** A file is read once until forgotten (once per build). */
    it("should read a file once until it is forgotten", async () => {
        const file = project.write("sous.config.json", '{ "name": "one" }');

        expect(await loader.load(file)).toMatchObject({ data: { name: "one" } });
        fs.writeFileSync(file, '{ "name": "two" }');
        expect(await loader.load(file)).toMatchObject({ data: { name: "one" } });

        loader.forget(file);
        expect(await loader.load(file)).toMatchObject({ data: { name: "two" } });

        fs.writeFileSync(file, '{ "name": "three" }');
        loader.forget();
        expect(await loader.load(file)).toMatchObject({ data: { name: "three" } });
    });

    /** A module changed on disk is imported again under a new URL (S2). */
    it("should import a changed module again", async () => {
        const urls: string[] = [];
        const importing = new ConfigFilesLoaderImpl({
            project: project.info(),
            globs: () => standInGlobs,
            evaluator: () => undefined,
            pathVariables: () => ({}),
            importModule: async (url) => {
                urls.push(url);

                return { config: { n: urls.length } };
            },
        });
        const file = project.write("sous.config.js", "export const config = { n: 1 };");

        await importing.load(file);
        importing.forget();
        await importing.load(file);
        fs.writeFileSync(file, "export const config = { n: 2, more: true };");
        importing.forget();
        await importing.load(file);

        expect(urls[0]).toBe(urls[1]);
        expect(urls[2]).toMatch(/\?sous-reload=1$/);
    });

    /** A file of a kind sous does not read is an error naming it. */
    it("should refuse a file sous does not read", async () => {
        const file = project.write("notes.txt", "hello");

        await expect(loader.load(file)).rejects.toThrow(/notes\.txt is not a kind of file sous reads/);
    });

    /** Labels are relative to `.sous/`. */
    it("should label files relative to .sous", () => {
        expect(loader.label(path.join(project.confDir, "610-mac.jsonc"))).toBe("conf.d/610-mac.jsonc");
        expect(loader.label("/elsewhere/x.json")).toBe("/elsewhere/x.json");
    });
});
