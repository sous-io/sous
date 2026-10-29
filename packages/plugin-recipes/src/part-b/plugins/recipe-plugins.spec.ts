import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanTemp, tempDir, writeRecipe } from "../../../test/part-b/helpers.js";
import type { ActiveRecipeEntity } from "../../types.js";
import { pluginBundleOf, writeRecipeTypes } from "./recipe-plugins.js";

afterEach(() => cleanTemp());

/** An active recipe shipping a plugin, its files written. */
function recipe(id: string, plugin: ActiveRecipeEntity["manifest"]["plugin"], files: Record<string, string> = { "plugin/index.js": "export default {}", "plugin/index.d.ts": `export type T${id.length} = 1;\n` }): ActiveRecipeEntity {
    const [namespace, name] = id.split("/");
    const dir = writeRecipe(path.join(tempDir(), name), { namespace, name, version: "1.0.0" }, files);

    return {
        id,
        namespace,
        name,
        repo: "acme",
        identity: "fake.test/acme",
        version: "1.0.0",
        hash: "sha256-0",
        kind: "subscribes",
        requestedBy: ["project"],
        dir,
        source: "store",
        manifest: { formatVersion: 1, namespace, name, version: "1.0.0", contents: [], ...(plugin === undefined ? {} : { plugin }) },
    };
}

describe("pluginBundleOf()", () => {
    it("should give the bundle and its types inside the recipe", () => {
        const active = recipe("workflow/alpha", { bundle: "plugin/index.js", types: "plugin/index.d.ts" });

        expect(pluginBundleOf(active)).toEqual({ file: path.join(active.dir, "plugin/index.js"), types: path.join(active.dir, "plugin/index.d.ts") });
    });

    it("should give nothing for a recipe that ships no plugin, and leave out types that are not there", () => {
        expect(pluginBundleOf(recipe("workflow/alpha", undefined))).toBeUndefined();

        const active = recipe("workflow/alpha", { bundle: "plugin/index.js", types: "plugin/missing.d.ts" });

        expect(pluginBundleOf(active)).toEqual({ file: path.join(active.dir, "plugin/index.js") });
    });

    it("should refuse a bundle outside the recipe, by path or absolute", () => {
        expect(pluginBundleOf(recipe("workflow/alpha", { bundle: "../escape.js" }))).toMatchObject({ problem: expect.stringContaining("outside its own files") });
        expect(pluginBundleOf(recipe("workflow/alpha", { bundle: "/etc/passwd" }))).toMatchObject({ problem: expect.stringContaining("outside its own files") });
    });

    it("should refuse a bundle that is a link leading out of the recipe", () => {
        const outside = path.join(tempDir(), "evil.js");
        const active = recipe("workflow/alpha", { bundle: "plugin/link.js" });

        fs.writeFileSync(outside, "export default {}");
        fs.symlinkSync(outside, path.join(active.dir, "plugin/link.js"));

        expect(pluginBundleOf(active)).toMatchObject({ problem: expect.stringContaining("outside its own files") });
    });

    it("should say when the bundle is not there", () => {
        expect(pluginBundleOf(recipe("workflow/alpha", { bundle: "plugin/nope.js" }))).toMatchObject({ problem: expect.stringContaining("not there") });
    });
});

describe("writeRecipeTypes()", () => {
    it("should copy each plugin's .d.ts and write an index referencing them, in order", () => {
        const sousDir = tempDir();
        const report = writeRecipeTypes(sousDir, [
            recipe("workflow/beta", { bundle: "plugin/index.js", types: "plugin/index.d.ts" }),
            recipe("tools/alpha", { bundle: "plugin/index.js", types: "plugin/index.d.ts" }),
        ]);
        const index = fs.readFileSync(path.join(sousDir, "types", "index.d.ts"), "utf8");

        expect(report.written.sort()).toEqual(["index.d.ts", path.join("tools", "alpha.d.ts"), path.join("workflow", "beta.d.ts")].sort());
        expect(index.indexOf("./tools/alpha.d.ts")).toBeLessThan(index.indexOf("./workflow/beta.d.ts"));
        expect(fs.readFileSync(path.join(sousDir, "types", "tools", "alpha.d.ts"), "utf8")).toContain("export type");
    });

    it("should write nothing the second time when nothing changed", () => {
        const sousDir = tempDir();
        const recipes = [recipe("tools/alpha", { bundle: "plugin/index.js", types: "plugin/index.d.ts" })];

        writeRecipeTypes(sousDir, recipes);

        expect(writeRecipeTypes(sousDir, recipes).written).toEqual([]);
    });

    it("should remove the types of a plugin no active recipe ships any more", () => {
        const sousDir = tempDir();

        writeRecipeTypes(sousDir, [recipe("tools/alpha", { bundle: "plugin/index.js", types: "plugin/index.d.ts" })]);

        const report = writeRecipeTypes(sousDir, []);

        expect(report.removed).toEqual([path.join("tools", "alpha.d.ts")]);
        expect(fs.readFileSync(path.join(sousDir, "types", "index.d.ts"), "utf8")).not.toContain("reference");
    });

    it("should make no directory for a project with no recipe plugin types", () => {
        const sousDir = tempDir();

        expect(writeRecipeTypes(sousDir, [recipe("tools/alpha", { bundle: "plugin/index.js" })])).toEqual({ directory: path.join(sousDir, "types"), written: [], removed: [] });
        expect(fs.existsSync(path.join(sousDir, "types"))).toBe(false);
    });
});
