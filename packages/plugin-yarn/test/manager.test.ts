import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ServiceContext } from "@sous-io/plugin-api";
import { yarnManager, yarnPlugin, yarnPnpLocator } from "../src/index.js";

let dir: string;

beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sous-yarn-")));
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

/** A stand-in `.pnp.cjs` exporting a resolver with one package, `plug`, unplugged beside it. */
function writePnp(): string {
    const plug = path.join(dir, ".yarn/unplugged/plug-npm-1.2.3/node_modules/plug");

    write(".yarn/unplugged/plug-npm-1.2.3/node_modules/plug/package.json", JSON.stringify({ version: "1.2.3", keywords: ["sous-plugin"] }));
    write("package.json", JSON.stringify({ name: "app", devDependencies: { plug: "^1.0.0", zipped: "^2.0.0" } }));
    write(
        ".pnp.cjs",
        `const top = { name: "app", reference: "workspace:." };
const packages = {
  "app": { packageLocation: ${JSON.stringify(dir + "/")}, packageDependencies: new Map([["plug", "npm:1.2.3"], ["zipped", ["zipped", "virtual:ab#npm:2.0.0"]], ["peer", null]]) },
  "plug": { packageLocation: ${JSON.stringify(plug + "/")}, packageDependencies: new Map() },
  "zipped": { packageLocation: ${JSON.stringify(dir + "/.yarn/cache/zipped-npm-2.0.0.zip/node_modules/zipped/")}, packageDependencies: new Map() },
};
module.exports = {
  findPackageLocator: () => top,
  getPackageInformation: (locator) => packages[locator.name] ?? null,
  resolveRequest: (request) => {
    if (request === "plug") return ${JSON.stringify(plug + "/index.js")};
    if (request === "zipped") return ${JSON.stringify(dir + "/.yarn/cache/zipped-npm-2.0.0.zip/node_modules/zipped/index.js")};
    throw new Error("not found");
  },
};
`,
    );

    return plug;
}

describe("yarn detect", () => {
    /** yarn.lock without a Berry header is Classic. */
    it("should detect Classic from yarn.lock", async () => {
        write("yarn.lock", "# yarn lockfile v1\n");
        expect(await yarnManager.detect(dir, context(""))).toEqual({ id: "yarn", detected: true });
    });

    /** A Berry lockfile, .yarnrc.yml, or packageManager field makes it yarn@berry. */
    it("should report yarn@berry for Yarn 2 and later", async () => {
        write("yarn.lock", "__metadata:\n  version: 8\n");
        expect((await yarnManager.detect(dir, context("")))?.id).toBe("yarn@berry");
        fs.rmSync(path.join(dir, "yarn.lock"));
        write(".yarnrc.yml", "nodeLinker: node-modules\n");
        expect((await yarnManager.detect(dir, context("")))?.id).toBe("yarn@berry");
        fs.rmSync(path.join(dir, ".yarnrc.yml"));
        write("package.json", JSON.stringify({ packageManager: "yarn@4.1.0" }));
        expect(await yarnManager.detect(dir, context(""))).toEqual({ id: "yarn@berry", detected: true, version: "4.1.0" });
        write("package.json", JSON.stringify({ packageManager: "yarn@1.22.0" }));
        expect((await yarnManager.detect(dir, context("")))?.id).toBe("yarn");
    });

    /** Workspaces and Plug'n'Play roots are reported. */
    it("should report the workspace and Plug'n'Play roots", async () => {
        write("package.json", JSON.stringify({ workspaces: ["pkg/*"] }));
        write(".pnp.cjs", "module.exports = {};");
        write("pkg/a/package.json", "{}");
        write("pkg/a/yarn.lock", "");

        expect(await yarnManager.detect(path.join(dir, "pkg/a"), context(""))).toEqual({
            id: "yarn",
            detected: true,
            workspaceRoot: dir,
            pnpRoot: dir,
        });
    });

    /** Another manager's project is not Yarn's. */
    it("should pass otherwise", async () => {
        expect(await yarnManager.detect(dir, context(""))).toBeUndefined();
        write("package-lock.json", "{}");
        expect(await yarnManager.detect(dir, context(""))).toBeUndefined();
    });
});

describe("yarn installed", () => {
    /** With node_modules, packages are read from it. */
    it("should list project packages from node_modules", async () => {
        write("package.json", JSON.stringify({ dependencies: { plug: "1.0.0" } }));
        write("node_modules/plug/package.json", JSON.stringify({ version: "1.0.0", keywords: ["sous-plugin"] }));

        const found = await yarnManager.installed("project", dir, context(""));

        expect(found.map((p) => [p.name, p.isSousPlugin, p.declared?.section])).toEqual([["plug", true, "dependencies"]]);
    });

    /** Under Plug'n'Play the resolver lists them; zipped ones keep the version from their reference. */
    it("should list Plug'n'Play packages through the resolver", async () => {
        const plug = writePnp();
        const found = await yarnManager.installed("project", dir, context(""));

        expect(found).toHaveLength(2);
        expect(found[0]).toMatchObject({ name: "plug", version: "1.2.3", location: plug, isSousPlugin: true });
        expect(found[0]?.declared).toEqual({ section: "devDependencies", range: "^1.0.0" });
        expect(found[1]).toMatchObject({ name: "zipped", version: "2.0.0", isSousPlugin: false });
    });

    /**
     * A `.pnp.cjs` whose resolver cannot be loaded still leaves the declared packages, at the
     * versions yarn.lock resolved them to, each located at the `.pnp.cjs` file.
     */
    it("should fall back to yarn.lock when the resolver cannot be loaded", async () => {
        write("package.json", JSON.stringify({ devDependencies: { "@sous-io/sous": "0.2.18" }, dependencies: { other: "^1.0.0" } }));
        write(".pnp.cjs", "// stub\n");
        write("yarn.lock", '__metadata:\n  version: 8\n\n"@sous-io/sous@npm:0.2.18":\n  version: 0.2.18\n');

        const found = await yarnManager.installed("project", dir, context(""));

        expect(found).toEqual([
            {
                name: "@sous-io/sous",
                version: "0.2.18",
                location: path.join(dir, ".pnp.cjs"),
                realPath: path.join(dir, ".pnp.cjs"),
                isSousPlugin: false,
                declared: { section: "devDependencies", range: "0.2.18" },
            },
            {
                name: "other",
                version: "unknown",
                location: path.join(dir, ".pnp.cjs"),
                realPath: path.join(dir, ".pnp.cjs"),
                isSousPlugin: false,
                declared: { section: "dependencies", range: "^1.0.0" },
            },
        ]);
    });

    /** Classic's global dir has node_modules below it. */
    it("should find the global root through yarn global dir", async () => {
        const seen: string[][] = [];
        const shells: boolean[] = [];

        write("global/node_modules/@sous-io/sous/package.json", JSON.stringify({ version: "0.2.0" }));

        const found = await yarnManager.installed("global", undefined, context(`${path.join(dir, "global")}\n`, 0, seen, shells));

        expect(seen).toEqual([["yarn", "global", "dir"]]);
        // On Windows yarn is a `.cmd` shim, which only the shell finds.
        expect(shells).toEqual([true]);
        expect(found.map((p) => p.name)).toEqual(["@sous-io/sous"]);
    });

    /** Berry has no global installs. */
    it("should have no global root when yarn cannot say", async () => {
        expect(await yarnManager.globalRoot?.(context("", 1))).toBeUndefined();
    });
});

describe("yarn commands", () => {
    const spec = "@sous-io/sous@0.2.34";

    /** Classic needs -W at a workspace root; Berry needs no flag. */
    it("should plan adds", () => {
        write("yarn.lock", "# yarn lockfile v1\n");
        expect(yarnManager.addCommand([spec], { section: "devDependencies", workspaceRoot: true, cwd: dir }).args).toEqual(["add", "-D", "-E", "-W", spec]);
        expect(yarnManager.addCommand([spec], { section: "dependencies", workspaceRoot: false, cwd: dir }).args).toEqual(["add", "-E", spec]);

        fs.rmSync(path.join(dir, "yarn.lock"));
        write("yarn.lock", "__metadata:\n  version: 8\n");
        expect(yarnManager.addCommand([spec], { section: "devDependencies", workspaceRoot: true, cwd: dir }).args).toEqual(["add", "-D", "-E", spec]);
        expect(yarnManager.globalInstallCommand?.([spec])).toEqual({ command: "yarn", args: ["global", "add", spec] });
    });
});

describe("yarn-pnp locator", () => {
    const project = (root: string) => ({ project: { root, sousDir: `${root}/.sous`, configPath: undefined, confDir: `${root}/.sous/conf.d` } });

    /** A bare specifier is resolved by the project's resolver. */
    it("should resolve a plugin through .pnp.cjs", async () => {
        const plug = writePnp();

        expect(await yarnPnpLocator.locate("plug", project(dir))).toEqual(pathToFileURL(`${plug}/index.js`));
    });

    /** It passes on paths, unknown packages, zipped packages and projects without Plug'n'Play. */
    it("should pass when it cannot answer", async () => {
        expect(await yarnPnpLocator.locate("plug", project(dir))).toBeUndefined();
        writePnp();
        expect(await yarnPnpLocator.locate("./local.js", project(dir))).toBeUndefined();
        expect(await yarnPnpLocator.locate("file:///x.js", project(dir))).toBeUndefined();
        expect(await yarnPnpLocator.locate("missing", project(dir))).toBeUndefined();
        expect(await yarnPnpLocator.locate("zipped", project(dir))).toBeUndefined();
        expect(await yarnPnpLocator.locate("plug", { project: undefined })).toBeUndefined();
    });
});

describe("yarn plugin", () => {
    /** The plugin is named for its package. */
    it("should be named for its package", () => {
        expect(yarnPlugin.name).toBe("@sous-io/plugin-yarn");
    });
});
