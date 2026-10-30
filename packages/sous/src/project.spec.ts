import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findProject, locateProject, readOverrides } from "./project.js";

const made: string[] = [];

function tmp(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "sous-project-"));

    made.push(dir);

    return dir;
}

afterEach(() => {
    for (const dir of made.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

describe("findProject()", () => {
    /**
     * The project is the nearest directory above the working directory that holds a `.sous/`
     * directory; its config file is the first sous.config.* found there (S6, "The project root").
     *
     * findProject("/work/app/src") // -> { root: "/work/app", configPath: "/work/app/.sous/sous.config.jsonc", ... }
     */
    it("should find the nearest .sous directory and its config file", () => {
        const root = tmp();

        mkdirSync(path.join(root, ".sous"));
        mkdirSync(path.join(root, "src", "deep"), { recursive: true });
        writeFileSync(path.join(root, ".sous", "sous.config.jsonc"), "{}");
        writeFileSync(path.join(root, ".sous", "sous.config.yaml"), "");

        expect(findProject(path.join(root, "src", "deep"))).toEqual({
            root,
            sousDir: path.join(root, ".sous"),
            configPath: path.join(root, ".sous", "sous.config.jsonc"),
            confDir: path.join(root, ".sous", "conf.d"),
        });
    });

    /** A monorepo's nested `.sous/` wins for a working directory inside it (S1: one project per process). */
    it("should prefer the nearest .sous directory", () => {
        const root = tmp();

        mkdirSync(path.join(root, ".sous"));
        mkdirSync(path.join(root, "packages", "a", ".sous"), { recursive: true });
        writeFileSync(path.join(root, ".sous", "sous.config.js"), "");
        writeFileSync(path.join(root, "packages", "a", ".sous", "sous.config.js"), "");

        expect(findProject(path.join(root, "packages", "a"))?.root).toBe(path.join(root, "packages", "a"));
        expect(findProject(path.join(root, "packages"))?.root).toBe(root);
    });

    /**
     * A `.sous/` without a config file is passed over, as before 1.0 (the user-level `~/.sous` is
     * one), and so is a `.sous` file.
     */
    it("should pass over a .sous directory without a config file, and a .sous file", () => {
        const root = tmp();

        mkdirSync(path.join(root, ".sous"));
        writeFileSync(path.join(root, ".sous", "sous.config.json"), "{}");
        mkdirSync(path.join(root, "a", ".sous"), { recursive: true });
        mkdirSync(path.join(root, "b"));
        writeFileSync(path.join(root, "b", ".sous"), "");

        expect(findProject(path.join(root, "a"))?.root).toBe(root);
        expect(findProject(path.join(root, "b"))?.root).toBe(root);
    });
});

describe("locateProject()", () => {
    /** --config naming a file makes its directory the .sous directory, and its parent the root. */
    it("should take the project from --config, before SOUS_CONFIG and SOUS_DIR", () => {
        const root = tmp();

        mkdirSync(path.join(root, "alt"));
        writeFileSync(path.join(root, "alt", "sous.config.json"), "{}");
        mkdirSync(path.join(root, "other", ".sous"), { recursive: true });
        writeFileSync(path.join(root, "other", ".sous", "sous.config.js"), "");

        const overrides = readOverrides(["build", "-c", "alt/sous.config.json"], { SOUS_DIR: path.join(root, "other") }, root);

        expect(locateProject(root, overrides)).toEqual({
            root,
            sousDir: path.join(root, "alt"),
            configPath: path.join(root, "alt", "sous.config.json"),
            confDir: path.join(root, "alt", "conf.d"),
        });
        expect(locateProject(root, readOverrides([], { SOUS_DIR: path.join(root, "other") }, root))?.sousDir).toBe(path.join(root, "other", ".sous"));
        expect(readOverrides(["launch", "--", "--config", "x"], {}, root).config).toBeUndefined();
        expect(readOverrides(["--sous-confd=layers"], { SOUS_CONFD: "ignored" }, root).confDir).toBe(path.join(root, "layers"));
    });

    /** An override that points at nothing is an error naming it. */
    it("should refuse an override that points at nothing", () => {
        const root = tmp();

        expect(() => locateProject(root, readOverrides(["--sous-config", "missing.js"], {}, root))).toThrow(`--sous-config path not found: ${path.join(root, "missing.js")}`);
    });
});
