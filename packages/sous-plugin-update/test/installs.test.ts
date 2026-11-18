import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    classifyRunning,
    declaredDependency,
    discoverInstalls,
    findGlobalInstalls,
    findProjectInstall,
    type GlobalInstallInfo,
    type ProjectInstallInfo,
} from "../src/installs.js";
import { fakeManager, installedPackage, serviceContext } from "./helpers.js";

let dir: string;

beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sous-update-")));
});

afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
});

/** Writes a package.json under the temporary directory. */
function writePackage(directory: string, pkg: Record<string, unknown>): void {
    fs.mkdirSync(path.join(dir, directory), { recursive: true });
    fs.writeFileSync(path.join(dir, directory, "package.json"), JSON.stringify(pkg));
}

describe("declaredDependency()", () => {
    /** declaredDependency should read devDependencies first, then dependencies, and nothing else. */
    it("should read the section and range", () => {
        expect(declaredDependency({ devDependencies: { "@sous-io/sous": "0.2.18" }, dependencies: { "@sous-io/sous": "^1" } })).toEqual({
            section: "devDependencies",
            range: "0.2.18",
        });
        expect(declaredDependency({ dependencies: { "@sous-io/sous": "^0.2.18" } })).toEqual({ section: "dependencies", range: "^0.2.18" });
        expect(declaredDependency({ dependencies: { other: "1" } })).toBeUndefined();
        expect(declaredDependency(null)).toBeUndefined();
    });
});

describe("findProjectInstall()", () => {
    /**
     * findProjectInstall should ask the manager that owns the directory, walking up from the
     * working directory, and describe what that manager lists.
     */
    it("should find a hoisted install above the working directory", async () => {
        writePackage("repo/pkgs/a", {});

        const location = path.join(dir, "repo/node_modules/@sous-io/sous");
        const pnpm = fakeManager({
            id: "pnpm",
            detect: (directory) => (directory === path.join(dir, "repo") ? { id: "pnpm", detected: true, workspaceRoot: path.join(dir, "repo") } : undefined),
            project: (directory) =>
                directory === path.join(dir, "repo")
                    ? [installedPackage({ location, version: "0.2.18", declared: { section: "devDependencies", range: "0.2.18" } })]
                    : [],
        });
        const found = await findProjectInstall(path.join(dir, "repo/pkgs/a"), [pnpm], serviceContext([pnpm]));

        expect(found).toMatchObject({
            projectRoot: path.join(dir, "repo"),
            installed: "0.2.18",
            declared: { section: "devDependencies", range: "0.2.18" },
            workspaceRoot: true,
            manager: { supported: true, id: "pnpm", detected: true },
        });
    });

    /** findProjectInstall should prefer a manager that is sure over one that only assumes. */
    it("should prefer a detected manager to an assumed one", async () => {
        const location = path.join(dir, "node_modules/@sous-io/sous");
        const project = (directory: string) => (directory === dir ? [installedPackage({ location })] : []);
        const npm = fakeManager({ id: "npm", detect: { id: "npm", detected: false }, project });
        const yarn = fakeManager({ id: "yarn", detect: { id: "yarn@berry", detected: true, pnpRoot: dir }, project });
        const found = await findProjectInstall(dir, [npm, yarn], serviceContext([npm, yarn]));

        expect(found?.manager).toMatchObject({ supported: true, id: "yarn@berry", detected: true });
        expect(found?.pnpRoot).toBe(dir);
    });

    /**
     * findProjectInstall should report an install no manager plugin claims, read from node_modules,
     * as having an unsupported manager.
     */
    it("should report an unsupported manager when no entity claims the project", async () => {
        writePackage("node_modules/@sous-io/sous", { name: "@sous-io/sous", version: "0.2.18" });
        writePackage(".", { devDependencies: { "@sous-io/sous": "0.2.18" } });

        const npm = fakeManager({ id: "npm", detect: undefined });
        const found = await findProjectInstall(dir, [npm], serviceContext([npm]));

        expect(found).toMatchObject({ projectRoot: dir, installed: "0.2.18", manager: { supported: false }, declared: { section: "devDependencies" } });
    });

    /** findProjectInstall should return undefined without a usable copy, and survive a manager that throws. */
    it("should return undefined without a usable copy", async () => {
        const broken = fakeManager({ id: "npm", detect: () => { throw new Error("boom"); } });

        expect(await findProjectInstall(dir, [broken], serviceContext([broken]))).toBeUndefined();

        const empty = fakeManager({ id: "pnpm", detect: { id: "pnpm", detected: true }, project: () => [installedPackage({ name: "other", location: "/x" })] });

        expect(await findProjectInstall(dir, [empty], serviceContext([empty]))).toBeUndefined();
    });
});

describe("findGlobalInstalls()", () => {
    /**
     * findGlobalInstalls should find a copy under each manager's global root, skip managers that
     * hold none or cannot install globally, and count a shared copy once.
     */
    it("should find each manager's copy and count a shared one once", async () => {
        const npm = fakeManager({ id: "npm", global: [installedPackage({ location: "/g/npm/@sous-io/sous", realPath: "/real/sous" })] });
        const pnpm = fakeManager({ id: "pnpm", global: [installedPackage({ location: "/g/pnpm/@sous-io/sous", realPath: "/real/sous" })] });
        const yarn = fakeManager({ id: "yarn", global: [installedPackage({ location: "/g/yarn/@sous-io/sous", realPath: "/other" })] });
        const berry = fakeManager({ id: "berry", canInstallGlobally: false, global: [installedPackage({ location: "/never" })] });
        const none = fakeManager({ id: "none", global: [] });
        const found = await findGlobalInstalls([npm, pnpm, yarn, berry, none], serviceContext([]));

        expect(found.map((install) => [install.manager.id, install.location])).toEqual([
            ["npm", "/g/npm/@sous-io/sous"],
            ["yarn", "/g/yarn/@sous-io/sous"],
        ]);
    });

    /** findGlobalInstalls should skip a manager that cannot answer. */
    it("should skip a manager that throws", async () => {
        const broken = fakeManager({ id: "npm" });
        broken.installed = async () => {
            throw new Error("not installed");
        };

        expect(await findGlobalInstalls([broken], serviceContext([]))).toEqual([]);
    });
});

describe("classifyRunning()", () => {
    /** Writes the running copy's package.json and returns its root. */
    function copy(name: string, version = "0.2.30"): string {
        writePackage(name, { name: "@sous-io/sous", version });

        return path.join(dir, name);
    }

    /** classifyRunning should match the project install and the global installs by real path. */
    it("should match the project install and the global installs by real path", () => {
        const own = copy("own");
        const project = { realPath: own } as ProjectInstallInfo;
        const global = { manager: fakeManager({ id: "pnpm" }), realPath: own } as GlobalInstallInfo;

        expect(classifyRunning(own, project, [])).toEqual({ kind: "project", realPath: own, installed: "0.2.30" });
        expect(classifyRunning(own, undefined, [global])).toEqual({ kind: "global", manager: "pnpm", realPath: own, installed: "0.2.30" });
    });

    /** classifyRunning should match a Plug'n'Play project's unplugged copy. */
    it("should match a Plug'n'Play project's unplugged copy", () => {
        const unplugged = copy("p/.yarn/unplugged/sous-npm-0.2.30/node_modules/@sous-io/sous");
        const project = { realPath: path.join(dir, "p/.pnp.cjs"), pnpRoot: path.join(dir, "p") } as ProjectInstallInfo;

        expect(classifyRunning(unplugged, project, []).kind).toBe("project");
        expect(classifyRunning(copy("elsewhere"), project, []).kind).toBe("unknown");
    });

    /** classifyRunning should read npx, Volta and unknown locations from the path. */
    it("should read npx, Volta and unknown locations from the path", () => {
        expect(classifyRunning(copy("c/_npx/1/node_modules/@sous-io/sous"), undefined, []).kind).toBe("npx");
        expect(classifyRunning(copy(".volta/tools/x"), undefined, []).kind).toBe("volta");
        expect(classifyRunning(copy("src/sous"), undefined, []).kind).toBe("unknown");
        expect(classifyRunning(path.join(dir, "missing"), undefined, [])).toMatchObject({ kind: "unknown", installed: "unknown" });
    });
});

describe("discoverInstalls()", () => {
    /** discoverInstalls should report the project, the globals and the running copy. */
    it("should report the project, the globals and the running copy", async () => {
        const location = path.join(dir, "node_modules/@sous-io/sous");

        writePackage("node_modules/@sous-io/sous", { name: "@sous-io/sous", version: "0.2.30" });

        const npm = fakeManager({
            id: "npm",
            detect: { id: "npm", detected: true },
            project: (directory) => (directory === dir ? [installedPackage({ location, realPath: location })] : []),
            global: [installedPackage({ location: "/g/@sous-io/sous", version: "0.2.18" })],
        });
        const discovery = await discoverInstalls({ cwd: dir, ownRoot: location }, serviceContext([npm]));

        expect(discovery.project?.installed).toBe("0.2.30");
        expect(discovery.globals.map((install) => install.installed)).toEqual(["0.2.18"]);
        expect(discovery.running.kind).toBe("project");
    });

    /** discoverInstalls should leave `project` out when there is none. */
    it("should leave project out when there is none", async () => {
        const discovery = await discoverInstalls({ cwd: dir, ownRoot: dir }, serviceContext([fakeManager({ id: "npm" })]));

        expect("project" in discovery).toBe(false);
        expect(discovery.globals).toEqual([]);
    });
});
