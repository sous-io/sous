import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ServiceContext } from "@sous-io/plugin-api";
import { npmManager, npmPlugin } from "../src/index.js";

let dir: string;

beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sous-npm-")));
});

afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
});

/** Writes a file under the temporary directory. */
function write(file: string, content: string): void {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
}

/** A context whose `host.processes.run` is a stand-in answering with `stdout`. */
function context(stdout: string, exitCode = 0, seen: string[][] = [], shells: boolean[] = []): ServiceContext {
    const run = async (command: string, args: readonly string[], options: { windowsShell?: boolean } = {}) => {
        seen.push([command, ...args]);
        shells.push(options.windowsShell === true);

        return { command, args, exitCode, signal: null, stdout, stderr: "", durationMs: 1, timedOut: false };
    };

    return {
        config: { get: () => undefined },
        services: { get: () => ({ run }) },
    } as unknown as ServiceContext;
}

describe("npm detect", () => {
    /** A package-lock.json says the project is npm's. */
    it("should detect npm from package-lock.json", async () => {
        write("package-lock.json", "{}");
        expect(await npmManager.detect(dir, context(""))).toEqual({ id: "npm", detected: true });
    });

    /** The packageManager field gives the version. */
    it("should read the version from the packageManager field", async () => {
        write("package.json", JSON.stringify({ packageManager: "npm@10.2.0+sha1.abc" }));
        expect(await npmManager.detect(dir, context(""))).toEqual({ id: "npm", detected: true, version: "10.2.0" });
    });

    /** Another manager's lockfile or field means the project is not npm's. */
    it("should pass when another manager owns the project", async () => {
        write("pnpm-lock.yaml", "");
        expect(await npmManager.detect(dir, context(""))).toBeUndefined();
        fs.rmSync(path.join(dir, "pnpm-lock.yaml"));
        write("package.json", JSON.stringify({ packageManager: "yarn@4.0.0" }));
        expect(await npmManager.detect(dir, context(""))).toBeUndefined();
    });

    /** With nothing to go on, npm is assumed and says so. */
    it("should assume npm when nothing names a manager", async () => {
        expect(await npmManager.detect(dir, context(""))).toEqual({ id: "npm", detected: false });
    });
});

describe("npm installed", () => {
    /** Installed packages come from node_modules, scopes included, with where they were declared. */
    it("should list project packages", async () => {
        write("package.json", JSON.stringify({ devDependencies: { "@acme/plug": "^1.0.0" } }));
        write("node_modules/@acme/plug/package.json", JSON.stringify({ version: "1.2.3", keywords: ["sous-plugin"] }));
        write("node_modules/left/package.json", JSON.stringify({ version: "0.1.0" }));
        write("node_modules/.bin/x", "");

        const found = await npmManager.installed("project", dir, context(""));

        expect(found.map((p) => [p.name, p.version, p.isSousPlugin])).toEqual([
            ["@acme/plug", "1.2.3", true],
            ["left", "0.1.0", false],
        ]);
        expect(found[0]?.declared).toEqual({ section: "devDependencies", range: "^1.0.0" });
    });

    /** Global packages come from the root npm names. */
    it("should list global packages through npm root -g", async () => {
        const seen: string[][] = [];
        const shells: boolean[] = [];
        const root = path.join(dir, "global");

        write("global/@sous-io/sous/package.json", JSON.stringify({ version: "0.2.0" }));

        const found = await npmManager.installed("global", undefined, context(`${root}\n`, 0, seen, shells));

        expect(seen).toEqual([["npm", "root", "-g"]]);
        // On Windows npm is a `.cmd` shim, which only the shell finds.
        expect(shells).toEqual([true]);
        expect(found.map((p) => p.name)).toEqual(["@sous-io/sous"]);
    });

    /** A failing npm has no global root. */
    it("should return nothing when npm cannot say", async () => {
        expect(await npmManager.globalRoot?.(context("", 1))).toBeUndefined();
        expect(await npmManager.installed("global", undefined, context("", 1))).toEqual([]);
    });
});

describe("npm commands", () => {
    /** The commands match today's managers.ts. */
    it("should plan adds and global installs", () => {
        const spec = "@sous-io/sous@0.2.34";

        expect(npmManager.addCommand([spec], { section: "devDependencies", workspaceRoot: false, cwd: "/p" })).toEqual({
            command: "npm",
            args: ["i", "-D", "-E", spec],
            cwd: "/p",
        });
        expect(npmManager.addCommand([spec], { section: "dependencies", workspaceRoot: true, cwd: "/p" }).args).toEqual(["i", "-E", spec]);
        expect(npmManager.globalInstallCommand?.([spec])).toEqual({ command: "npm", args: ["i", "-g", spec] });
    });
});

describe("npm plugin", () => {
    /** The plugin registers one entity. */
    it("should be named for its package", () => {
        expect(npmPlugin.name).toBe("@sous-io/plugin-npm");
    });
});
