import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError } from "@sous-io/plugin-api";
import { applyManagedBlock, createGitignore, IGNORE_BLOCK_END, IGNORE_BLOCK_START, readManagedBlock } from "./gitignore.js";

const ENTRIES = ["sous.links.json", "sous.state.json", "sous.pid", ".env.local", "repos/"];
const BLOCK = [IGNORE_BLOCK_START, ...ENTRIES, IGNORE_BLOCK_END].join("\n");

describe("applyManagedBlock()", () => {
    /** A file that does not exist, or is blank, gets just the block. */
    it("should produce just the block for a missing or blank file", () => {
        expect(applyManagedBlock(undefined, ENTRIES)).toBe(`${BLOCK}\n`);
        expect(applyManagedBlock("  \n", ENTRIES)).toBe(`${BLOCK}\n`);
    });

    /** A file with no block keeps its text and gets the block after a blank line. */
    it("should append the block after the user's lines", () => {
        expect(applyManagedBlock("node_modules/\n", ENTRIES)).toBe(`node_modules/\n\n${BLOCK}\n`);
        expect(applyManagedBlock("node_modules/", ENTRIES)).toBe(`node_modules/\n\n${BLOCK}\n`);
        expect(applyManagedBlock("a\n\n", ENTRIES)).toBe(`a\n\n${BLOCK}\n`);
    });

    /** Only the lines between the markers change. */
    it("should rewrite the block and leave the rest alone", () => {
        const existing = `top\n${IGNORE_BLOCK_START}\nstale\n${IGNORE_BLOCK_END}\nbottom\n`;

        expect(applyManagedBlock(existing, ["fresh"])).toBe(`top\n${IGNORE_BLOCK_START}\nfresh\n${IGNORE_BLOCK_END}\nbottom\n`);
    });

    /** Applying twice changes nothing. */
    it("should be idempotent", () => {
        const once = applyManagedBlock("keep\n", ENTRIES);

        expect(applyManagedBlock(once, ENTRIES)).toBe(once);
    });

    /** A block with no closing marker is an error that says how to fix it. */
    it("should refuse a block with no closing marker", () => {
        const damaged = `${IGNORE_BLOCK_START}\nx\n`;

        expect(() => applyManagedBlock(damaged, ENTRIES, "/p/.gitignore")).toThrow(ConfigError);
        expect(() => applyManagedBlock(damaged, ENTRIES, "/p/.gitignore")).toThrow(/\/p\/\.gitignore has no closing marker/);
    });

    /** An empty list removes the block, and the blank line before it. */
    it("should remove the block for an empty list", () => {
        const withBlock = applyManagedBlock("keep\n", ENTRIES);

        expect(applyManagedBlock(withBlock, [])).toBe("keep\n");
        expect(applyManagedBlock(`${BLOCK}\n`, [])).toBe("");
        expect(applyManagedBlock("keep\n", [])).toBe("keep\n");
        expect(applyManagedBlock(undefined, [])).toBe("");
    });
});

describe("readManagedBlock()", () => {
    /** The lines between the markers, or none. */
    it("should read the lines in the block", () => {
        expect(readManagedBlock(`a\n${BLOCK}\nb\n`)).toEqual(ENTRIES);
        expect(readManagedBlock("a\n")).toEqual([]);
        expect(readManagedBlock(undefined)).toEqual([]);
    });
});

describe("createGitignore()", () => {
    let dir: string;
    let file: string;
    const service = createGitignore();

    beforeEach(() => {
        dir = mkdtempSync(path.join(tmpdir(), "host-gitignore-"));
        file = path.join(dir, ".sous", ".gitignore");
    });

    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    /** Writing creates the file, and its directory. */
    it("should create the file with the block", async () => {
        const change = await service.write(file, ENTRIES);

        expect(change).toEqual({ file, changed: true, lines: ENTRIES });
        expect(readFileSync(file, "utf8")).toBe(`${BLOCK}\n`);
        expect((await service.write(file, ENTRIES)).changed).toBe(false);
    });

    /** A dry run reports the change and writes nothing. */
    it("should not write on a dry run", async () => {
        const change = await service.write(file, ENTRIES, { dryRun: true });

        expect(change.changed).toBe(true);
        expect(await service.read(file)).toEqual([]);
    });

    /** Adding keeps what is there and skips repeats. */
    it("should add only the lines that are missing", async () => {
        writeFileSync(path.join(dir, "g"), "mine\n");
        const target = path.join(dir, "g");

        await service.add(target, ["a", "b"]);
        const second = await service.add(target, ["b", "c", "c"]);

        expect(second.lines).toEqual(["a", "b", "c"]);
        expect(readFileSync(target, "utf8")).toBe(`mine\n\n${IGNORE_BLOCK_START}\na\nb\nc\n${IGNORE_BLOCK_END}\n`);
        expect((await service.add(target, ["a"])).changed).toBe(false);
    });

    /** Removing drops lines, and the block once it is empty. */
    it("should remove lines and then the block", async () => {
        const target = path.join(dir, "g");

        writeFileSync(target, "mine\n");
        await service.add(target, ["a", "b"]);
        expect((await service.remove(target, ["a"])).lines).toEqual(["b"]);
        await service.remove(target, ["b"]);

        expect(readFileSync(target, "utf8")).toBe("mine\n");
        expect((await service.remove(target, ["b"])).changed).toBe(false);
        expect((await service.remove(path.join(dir, "none"), ["b"])).changed).toBe(false);
    });
});
