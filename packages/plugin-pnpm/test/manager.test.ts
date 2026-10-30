import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ServiceContext } from "@sous-io/plugin-api";
import { pnpmManager, pnpmPlugin } from "../src/index.js";

let dir: string;

beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sous-pnpm-")));
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

    return { config: { get: () => undefined }, services: { get: () => ({ run }) } } as unknown as ServiceContext;
}

describe("pnpm detect", () => {
    /** pnpm-lock.yaml says the project is pnpm's. */
    it("should detect pnpm from its lockfile", async () => {
        write("pnpm-lock.yaml", "");
        expect(await pnpmManager.detect(dir, context(""))).toEqual({ id: "pnpm", detected: true });
    });

    /** The packageManager field gives the version. */
    it("should read the version from the packageManager field", async () => {
        write("package.json", JSON.stringify({ packageManager: "pnpm@9.1.0" }));
        expect(await pnpmManager.detect(dir, context(""))).toEqual({ id: "pnpm", detected: true, version: "9.1.0" });
    });

    /** pnpm-workspace.yaml marks the workspace root, found from inside a package too. */
    it("should report the workspace root", async () => {
        write("pnpm-workspace.yaml", "packages: []\n");
        write("pkg/pnpm-lock.yaml", "");
        expect(await pnpmManager.detect(dir, context(""))).toEqual({ id: "pnpm", detected: true, workspaceRoot: dir });
        expect((await pnpmManager.detect(path.join(dir, "pkg"), context("")))?.workspaceRoot).toBe(dir);
    });

    /** A project of another manager, or of none, is not pnpm's. */
    it("should pass otherwise", async () => {
        expect(await pnpmManager.detect(dir, context(""))).toBeUndefined();
        write("package-lock.json", "{}");
        expect(await pnpmManager.detect(dir, context(""))).toBeUndefined();
    });
});

describe("pnpm installed", () => {
    /** Symbolic links into the store are followed for the real path. */
    it("should list project packages, following links", async () => {
        write("package.json", JSON.stringify({ dependencies: { plug: "^1.0.0" } }));
        write("node_modules/.pnpm/plug@1.2.3/node_modules/plug/package.json", JSON.stringify({ version: "1.2.3", keywords: ["sous-plugin"] }));
        fs.symlinkSync(path.join(dir, "node_modules/.pnpm/plug@1.2.3/node_modules/plug"), path.join(dir, "node_modules/plug"));

        const found = await pnpmManager.installed("project", dir, context(""));

        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ name: "plug", version: "1.2.3", isSousPlugin: true, declared: { section: "dependencies", range: "^1.0.0" } });
        expect(found[0]?.realPath).toBe(path.join(dir, "node_modules/.pnpm/plug@1.2.3/node_modules/plug"));
    });

    /** Global packages come from the root pnpm names. */
    it("should list global packages through pnpm root -g", async () => {
        const seen: string[][] = [];
        const shells: boolean[] = [];

        write("global/@sous-io/sous/package.json", JSON.stringify({ version: "0.2.0" }));

        const found = await pnpmManager.installed("global", undefined, context(`${path.join(dir, "global")}\n`, 0, seen, shells));

        expect(seen).toEqual([["pnpm", "root", "-g"]]);
        // On Windows pnpm is a `.cmd` shim, which only the shell finds.
        expect(shells).toEqual([true]);
        expect(found.map((p) => p.name)).toEqual(["@sous-io/sous"]);
    });
});

describe("pnpm commands", () => {
    const spec = "@sous-io/sous@0.2.34";

    /** The commands match today's managers.ts. */
    it("should plan adds, with -w at a workspace root", () => {
        expect(pnpmManager.addCommand([spec], { section: "devDependencies", workspaceRoot: true, cwd: "/p" })).toEqual({
            command: "pnpm",
            args: ["add", "-D", "-E", "-w", spec],
            cwd: "/p",
        });
        expect(pnpmManager.addCommand([spec], { section: "dependencies", workspaceRoot: false, cwd: "/p" }).args).toEqual(["add", "-E", spec]);
        expect(pnpmManager.globalInstallCommand?.([spec])).toEqual({ command: "pnpm", args: ["add", "-g", spec] });
    });
});

describe("pnpm plugin", () => {
    /** The plugin is named for its package. */
    it("should be named for its package", () => {
        expect(pnpmPlugin.name).toBe("@sous-io/plugin-pnpm");
    });
});
