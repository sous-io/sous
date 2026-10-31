import { describe, expect, it } from "vitest";
import { resolveUserPath } from "./paths.js";

const project = { root: "/project", sousDir: "/project/.sous", configPath: undefined, confDir: "/project/.sous/conf.d" };

describe("resolveUserPath()", () => {
    /** A relative path resolves against the chain's working directory (ctx.cwd), not the shell's PWD. */
    it("should resolve against the working directory first", () => {
        expect(resolveUserPath("answers.yaml", { cwd: "/work", project })).toBe("/work/answers.yaml");
    });

    /** Without a working directory, the project root. */
    it("should fall back to the project root", () => {
        expect(resolveUserPath("answers.yaml", { project })).toBe("/project/answers.yaml");
    });

    /** An absolute path is kept. */
    it("should keep an absolute path", () => {
        expect(resolveUserPath("/abs/answers.yaml", { cwd: "/work", project })).toBe("/abs/answers.yaml");
    });
});
