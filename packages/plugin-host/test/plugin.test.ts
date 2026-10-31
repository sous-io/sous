import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hostServices, plugin } from "./helpers.js";

const claudePointer = plugin("sous-plugin-claude", (sous) => sous.entities.add("pointer-file", { id: "claude", fileName: "CLAUDE.md" }));
const codexPointer = plugin("sous-plugin-codex", (sous) => {
    sous.entities.add("pointer-file", { id: "codex", fileName: "AGENTS.md" });
    sous.entities.add("pointer-file", { id: "codex-again", fileName: "CLAUDE.md", content: "ignored duplicate" });
});

describe("plugin-host", () => {
    let tmp: string;

    beforeEach(() => {
        tmp = mkdtempSync(path.join(tmpdir(), "host-plugin-"));
    });

    afterEach(() => rmSync(tmp, { recursive: true, force: true }));

    /** Every service the contract names is provided. */
    it("should provide every host service", async () => {
        const services = await hostServices();

        for (const name of ["host.processes", "host.http", "host.globs", "host.sous-home", "host.directories", "host.gitignore", "host.package"] as const) {
            expect(services.get(name)).toBeDefined();
        }
    });

    /** Services read the environment the engine was given, never process.env. */
    it("should use the engine's environment", async () => {
        const services = await hostServices([], { env: { SOUS_HOME: path.join(tmp, "home"), PATH: process.env.PATH, MARK: "engine" } });

        expect(services.get("host.sous-home").paths().root).toBe(path.join(tmp, "home"));

        const result = await services.get("host.processes").run(process.execPath, ["-e", "console.log(process.env.MARK, process.env.HOME)"]);

        expect(result.stdout).toBe("engine undefined\n");
    });

    /** A directory gets a README of its own and nothing else when no plugin adds pointer files. */
    it("should write only a README without pointer-file entities", async () => {
        const services = await hostServices();
        const target = path.join(tmp, "a", "b");
        const made = await services.get("host.directories").ensure(target, { title: "A title", body: ["One.", "Two."] });

        expect(made).toEqual({ path: target, created: true, wrote: ["README.md"] });
        expect(readFileSync(path.join(target, "README.md"), "utf8")).toBe("# A title\n\nOne.\n\nTwo.\n");
        expect(existsSync(path.join(target, "CLAUDE.md"))).toBe(false);
    });

    /** Pointer files come from entities, each name once, and the first entity wins. */
    it("should write each pointer file once", async () => {
        const services = await hostServices([claudePointer, codexPointer]);
        const directories = services.get("host.directories");
        const target = path.join(tmp, "dir");
        const made = await directories.ensure(target, { title: "T", body: ["B."] });

        expect(directories.pointerFileNames()).toEqual(["AGENTS.md", "CLAUDE.md"]);
        expect(made.wrote).toEqual(["README.md", "AGENTS.md", "CLAUDE.md"]);
        expect(readFileSync(path.join(target, "CLAUDE.md"), "utf8")).toBe("Read `./README.md` for information about this directory.\n");
    });

    /** A file that is already there is never overwritten, and a second call writes nothing. */
    it("should never overwrite an existing file", async () => {
        const services = await hostServices([claudePointer]);
        const directories = services.get("host.directories");
        const target = path.join(tmp, "dir");

        mkdirSync(target);
        writeFileSync(path.join(target, "README.md"), "My own words.\n");
        writeFileSync(path.join(target, "CLAUDE.md"), "My own rules.\n");

        const first = await directories.ensure(target, { title: "Generated", body: ["Body."] });
        const second = await directories.ensure(target, { title: "Other", body: ["Other."] });

        expect(first).toEqual({ path: target, created: false, wrote: [] });
        expect(second.wrote).toEqual([]);
        expect(readFileSync(path.join(target, "README.md"), "utf8")).toBe("My own words.\n");
        expect(readFileSync(path.join(target, "CLAUDE.md"), "utf8")).toBe("My own rules.\n");
    });

    /** Each well-known directory has its own README. */
    it("should give every known directory its own README", async () => {
        const services = await hostServices([claudePointer]);
        const directories = services.get("host.directories");
        const cases = [
            ["sous-dir", "# The .sous directory"],
            ["confd", "# conf.d: drop-in configuration layers"],
            ["project-repos", "# repos: linked repository checkouts"],
            ["sous-home", "# Your user-level sous directory"],
            ["store", "# cache: the machine-wide recipe store"],
            ["global-repos", "# repos: globally linked repository checkouts"],
            ["index-cache", "# _indexes: cached repository indexes"],
        ] as const;

        for (const [kind, heading] of cases) {
            const target = path.join(tmp, "elsewhere", kind);

            await directories.ensureKnown(kind, target);

            expect(readFileSync(path.join(target, "README.md"), "utf8")).toContain(heading);
            expect(existsSync(path.join(target, "CLAUDE.md"))).toBe(true);
        }
    });

    /** A store under the sous home explains the home too, and an index cache explains the store. */
    it("should explain the parents inside the sous home", async () => {
        const home = path.join(tmp, "sous-home");
        const services = await hostServices([], { env: { SOUS_HOME: home } });

        await services.get("host.directories").ensureKnown("index-cache", path.join(home, "cache", "_indexes"));

        expect(readFileSync(path.join(home, "README.md"), "utf8")).toContain("Your user-level sous directory");
        expect(readFileSync(path.join(home, "cache", "README.md"), "utf8")).toContain("machine-wide recipe store");
        expect(existsSync(path.join(home, "cache", "_indexes", "README.md"))).toBe(true);
    });

    /** A store somewhere else must not leave files in a directory sous does not own. */
    it("should leave a parent that is not the sous home alone", async () => {
        const services = await hostServices([], { env: { SOUS_HOME: path.join(tmp, "elsewhere") } });

        await services.get("host.directories").ensureKnown("store", path.join(tmp, "detached-store"));

        expect(existsSync(path.join(tmp, "README.md"))).toBe(false);
        expect(existsSync(path.join(tmp, "detached-store", "README.md"))).toBe(true);
    });

    /** A pointer-file entity without a file name is refused by its schema. */
    it("should check pointer-file entities", async () => {
        const bad = plugin("sous-plugin-bad", (sous) => sous.entities.add("pointer-file", { id: "x" } as never));

        await expect(async () => (await hostServices([bad])).get("host.directories").pointerFileNames()).rejects.toThrow();
    });
});
