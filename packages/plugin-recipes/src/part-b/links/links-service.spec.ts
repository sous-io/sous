import fs from "node:fs";
import path from "node:path";
import { isSousErrorOfKind } from "@sous-io/plugin-api";
import { linksMapFormat } from "@sous-io/plugin-formats";
import { createGitignore, IGNORE_BLOCK_START } from "@sous-io/plugin-host";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanTemp, tempDir } from "../../../test/part-b/helpers.js";
import { describeLinkedRepos, ensureLocalFilesIgnored, IGNORED_LOCAL_FILES, LinksFiles } from "./links-service.js";

let sousDir: string;
let globalFile: string;
let links: LinksFiles;
const NOW = new Date("2026-10-29T12:00:00.000Z");

beforeEach(() => {
    sousDir = path.join(tempDir(), ".sous");
    fs.mkdirSync(sousDir, { recursive: true });
    globalFile = path.join(tempDir(), "sous.links.json");
    links = new LinksFiles({ sousDir, globalFile, parser: linksMapFormat, now: () => NOW });
});

afterEach(() => cleanTemp());

describe("LinksFiles", () => {
    it("should read a missing map as an empty one", () => {
        expect(links.all()).toEqual({});
        expect(links.read("project").links).toEqual({});
    });

    it("should record a link, resolving its path, and read it back", async () => {
        const recorded = await links.set("acme", { path: "/checkouts/acme/../acme", origin: "path" }, "project");

        expect(recorded).toEqual({ repo: "acme", path: "/checkouts/acme", origin: "path", linkedAt: NOW.toISOString(), scope: "project" });
        expect(links.get("acme")).toEqual(recorded);
        expect(fs.existsSync(path.join(sousDir, "sous.links.json"))).toBe(true);
    });

    it("should let a project link win over a machine-wide one", async () => {
        await links.set("acme", { path: "/global/acme", origin: "clone" }, "global");
        await links.set("other", { path: "/global/other", origin: "clone" }, "global");
        await links.set("acme", { path: "/project/acme", origin: "path" }, "project");

        expect(links.get("acme")).toMatchObject({ path: "/project/acme", scope: "project" });
        expect(links.get("other")).toMatchObject({ path: "/global/other", scope: "global" });
        expect(links.getIn("acme", "global")).toMatchObject({ path: "/global/acme" });
    });

    it("should write nothing on a dry run", async () => {
        await links.set("acme", { path: "/x", origin: "path" }, "global", { dryRun: true });

        expect(fs.existsSync(globalFile)).toBe(false);
    });

    it("should remove a link and return it, and return nothing for one not linked", async () => {
        await links.set("acme", { path: "/x", origin: "path" }, "project");

        expect(await links.remove("acme", "project", { dryRun: true })).toMatchObject({ path: "/x" });
        expect(links.get("acme")).toBeDefined();
        expect(await links.remove("acme", "project")).toMatchObject({ path: "/x" });
        expect(links.get("acme")).toBeUndefined();
        expect(await links.remove("acme", "project")).toBeUndefined();
    });

    it("should refuse a damaged map rather than treating it as empty", () => {
        fs.writeFileSync(path.join(sousDir, "sous.links.json"), "{ not json", "utf8");

        expect(() => links.all()).toThrow(/could not read the links map/);
    });

    it("should have no project map outside a project, and say so when one is needed", () => {
        const outside = new LinksFiles({ sousDir: undefined, globalFile, parser: linksMapFormat });

        expect(outside.read("project").links).toEqual({});

        try {
            outside.path("project");
            expect.unreachable();
        } catch (error) {
            expect(isSousErrorOfKind(error, "config")).toBe(true);
        }
    });
});

describe("ensureLocalFilesIgnored()", () => {
    it("should write .sous/repos/.gitignore and the managed block, keeping the user's lines, twice over", async () => {
        fs.writeFileSync(path.join(sousDir, ".gitignore"), "my-own-line\n", "utf8");

        await ensureLocalFilesIgnored(sousDir, createGitignore());
        await ensureLocalFilesIgnored(sousDir, createGitignore());

        const text = fs.readFileSync(path.join(sousDir, ".gitignore"), "utf8");

        expect(fs.readFileSync(path.join(sousDir, "repos", ".gitignore"), "utf8")).toBe("*\n");
        expect(text).toContain("my-own-line");
        expect(text.split(IGNORE_BLOCK_START)).toHaveLength(2);

        for (const entry of IGNORED_LOCAL_FILES) {
            expect(text).toContain(entry);
        }
    });
});

describe("describeLinkedRepos()", () => {
    it("should print nothing when nothing is linked", () => {
        expect(describeLinkedRepos({})).toEqual([]);
    });

    it("should name every linked repository and how to unlink", () => {
        const one = { repo: "acme", path: "/x", origin: "path" as const, linkedAt: "", scope: "project" as const };

        expect(describeLinkedRepos({ acme: one })[0]).toBe("One repository is LINKED to a working copy on this machine.");

        const lines = describeLinkedRepos({ zed: { ...one, repo: "zed", path: "/z" }, acme: one });

        expect(lines[0]).toBe("2 repositories are LINKED to working copies on this machine.");
        expect(lines).toContain("acme -> /x");
        expect(lines.indexOf("acme -> /x")).toBeLessThan(lines.indexOf("zed -> /z"));
        expect(lines.at(-1)).toContain("sous repo unlink");
    });
});
