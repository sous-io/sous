import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PluginError } from "@sous-io/plugin-api";
import { createPackage } from "./package-identity.js";

describe("host.package", () => {
    let dir: string;

    beforeEach(() => {
        dir = realpathSync(mkdtempSync(path.join(tmpdir(), "host-package-")));
    });

    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    /** The nearest package.json named like sous gives the root and the version. */
    it("should find the package above a directory", () => {
        mkdirSync(path.join(dir, "lib", "deep"), { recursive: true });
        writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "@sous-io/sous", version: "1.2.3" }));
        writeFileSync(path.join(dir, "lib", "package.json"), JSON.stringify({ name: "other", version: "9.9.9" }));

        const identity = createPackage({ startDir: path.join(dir, "lib", "deep"), bin: undefined }).identity();

        expect(identity).toEqual({ name: "@sous-io/sous", version: "1.2.3", root: dir, realRoot: dir, bin: undefined });
    });

    /** The package is found under its published name. */
    it.each(["@sous-io/sous"])("should find the package named %s by default", (name) => {
        writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0" }));

        expect(createPackage({ startDir: dir, bin: undefined }).identity()).toMatchObject({ name, root: dir });
    });

    /** Links are followed for the real root. */
    it("should give the real root of a linked install", () => {
        const real = path.join(dir, "real");
        const link = path.join(dir, "link");

        mkdirSync(real);
        writeFileSync(path.join(real, "package.json"), JSON.stringify({ name: "@sous-io/sous", version: "1.0.0" }));
        // A junction on Windows, where a directory symlink needs elevated rights; the type is ignored elsewhere.
        symlinkSync(real, link, "junction");

        const identity = createPackage({ startDir: link, bin: undefined }).identity();

        expect(identity.root).toBe(link);
        expect(identity.realRoot).toBe(real);
    });

    /** When nothing is above the module, the bin the process started through is searched. */
    it("should fall back to the bin", () => {
        const install = path.join(dir, "install");
        const elsewhere = path.join(dir, "elsewhere");

        mkdirSync(path.join(install, "bin"), { recursive: true });
        mkdirSync(elsewhere);
        writeFileSync(path.join(install, "package.json"), JSON.stringify({ name: "@sous-io/sous", version: "2.0.0" }));
        writeFileSync(path.join(install, "bin", "sous.js"), "");

        const identity = createPackage({ startDir: elsewhere, bin: path.join(install, "bin", "sous.js"), names: ["@sous-io/sous"] }).identity();

        expect(identity.root).toBe(install);
        expect(identity.bin).toBe(path.join(install, "bin", "sous.js"));
    });

    /** No package is a plain error. */
    it("should fail when sous is nowhere to be found", () => {
        expect(() => createPackage({ startDir: dir, bin: undefined, names: ["not-a-real-package-name"] }).identity()).toThrow(PluginError);
    });

    /** Running from this repository finds the real sous. */
    it("should find the sous this repository holds", () => {
        const identity = createPackage().identity();

        expect(identity.name).toMatch(/^@sous-io\/sous/);
        expect(identity.version).toMatch(/^\d+\.\d+\.\d+/);
    });
});
