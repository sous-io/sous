import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { locateWithNode } from "./resolve.js";

let dir: string;

function pkg(name: string, manifest: object, files: string[]): void {
    const root = path.join(dir, "node_modules", name);

    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ name, ...manifest }));

    for (const file of files) {
        mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        writeFileSync(path.join(root, file), "export default {};\n");
    }
}

beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "sous-resolve-"));
    writeFileSync(path.join(dir, "local.mjs"), "export default {};\n");
    pkg("string-exports", { type: "module", exports: "./main.js" }, ["main.js"]);
    pkg("import-only", { type: "module", exports: { ".": { import: "./esm.js" }, "./types": { types: "./t.d.ts" } } }, ["esm.js"]);
    pkg("sugar", { type: "module", exports: { node: { import: "./node.js" } } }, ["node.js"]);
    pkg("@scope/sub", { type: "module", exports: { "./extra": { default: "./extra.js" }, ".": { import: "./i.js" } } }, ["extra.js", "i.js"]);
    pkg("no-exports", { type: "module", module: "./mod.js" }, ["mod.js"]);
    pkg("bare-index", { type: "module", exports: null }, ["index.js"]);
    pkg("odd", { type: "module", exports: { ".": { import: null, require: "./c.cjs" } } }, ["c.cjs"]);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const url = (...parts: string[]) => pathToFileURL(path.join(dir, ...parts)).href;

describe("locateWithNode()", () => {
    /**
     * Paths resolve from the directory; missing ones give undefined; file: URLs pass through.
     */
    it("should resolve paths and file URLs", () => {
        expect(locateWithNode("./local.mjs", dir)).toBe(url("local.mjs"));
        expect(locateWithNode(path.join(dir, "local.mjs"), "/")).toBe(url("local.mjs"));
        expect(locateWithNode("./missing.mjs", dir)).toBeUndefined();
        expect(locateWithNode("file:///x.mjs", dir)).toBe("file:///x.mjs");
    });

    /**
     * Packages resolve through node_modules above the directory, ES-module-only `exports` included.
     */
    it("should find packages, including ES-module-only exports", () => {
        const nested = path.join(dir, "a", "b");

        mkdirSync(nested, { recursive: true });

        expect(locateWithNode("string-exports", nested)).toBe(url("node_modules", "string-exports", "main.js"));
        expect(locateWithNode("import-only", nested)).toBe(url("node_modules", "import-only", "esm.js"));
        expect(locateWithNode("sugar", dir)).toBe(url("node_modules", "sugar", "node.js"));
        expect(locateWithNode("@scope/sub/extra", dir)).toBe(url("node_modules", "@scope", "sub", "extra.js"));
        expect(locateWithNode("@scope/sub", dir)).toBe(url("node_modules", "@scope", "sub", "i.js"));
        expect(locateWithNode("no-exports", dir)).toBe(url("node_modules", "no-exports", "mod.js"));
        expect(locateWithNode("bare-index", dir)).toBe(url("node_modules", "bare-index", "index.js"));
        expect(locateWithNode("odd", dir)).toBe(url("node_modules", "odd", "c.cjs"));
        expect(locateWithNode("sous-plugin-not-installed", dir)).toBeUndefined();
    });
});
