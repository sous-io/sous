import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findProject } from "./project.js";

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

        expect(findProject(path.join(root, "packages", "a"))?.root).toBe(path.join(root, "packages", "a"));
        expect(findProject(path.join(root, "packages"))?.root).toBe(root);
    });

    /** A `.sous/` without a config file is still a project; a `.sous` file is not. */
    it("should accept a .sous directory without a config file, and ignore a .sous file", () => {
        const root = tmp();

        mkdirSync(path.join(root, "a", ".sous"), { recursive: true });
        mkdirSync(path.join(root, "b"));
        writeFileSync(path.join(root, "b", ".sous"), "");

        expect(findProject(path.join(root, "a"))?.configPath).toBeUndefined();
        expect(findProject(path.join(root, "b"))?.root).not.toBe(path.join(root, "b"));
    });
});
