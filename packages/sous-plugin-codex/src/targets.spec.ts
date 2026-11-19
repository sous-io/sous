import { describe, expect, it } from "vitest";
import { configPath, ignoreLine } from "./targets.js";

describe("configPath", () => {
    it("puts a relative path under ${projectRoot}", () => {
        expect(configPath("docs/AGENTS.override.md")).toBe("${projectRoot}/docs/AGENTS.override.md");
        expect(configPath("./AGENTS.override.md")).toBe("${projectRoot}/AGENTS.override.md");
    });

    it("leaves a path that starts with a variable, or is absolute, as it is", () => {
        expect(configPath("${projectRoot}/AGENTS.override.md")).toBe("${projectRoot}/AGENTS.override.md");
        expect(configPath("${sousDir}/out.md")).toBe("${sousDir}/out.md");
        expect(configPath("/srv/app/AGENTS.override.md")).toBe("/srv/app/AGENTS.override.md");
    });
});

describe("ignoreLine", () => {
    it("anchors a path under ${projectRoot} at the root", () => {
        expect(ignoreLine("${projectRoot}/AGENTS.override.md", "/work/app")).toBe("/AGENTS.override.md");
        expect(ignoreLine("${projectRoot}/docs/CODEX.md", undefined)).toBe("/docs/CODEX.md");
    });

    it("anchors an absolute path inside the project at the root", () => {
        expect(ignoreLine("/work/app/docs/AGENTS.override.md", "/work/app")).toBe("/docs/AGENTS.override.md");
    });

    it("gives nothing for a file outside the project, the root itself, or another variable", () => {
        expect(ignoreLine("/elsewhere/AGENTS.override.md", "/work/app")).toBeUndefined();
        expect(ignoreLine("/work/app", "/work/app")).toBeUndefined();
        expect(ignoreLine("${sousDir}/out.md", "/work/app")).toBeUndefined();
        expect(ignoreLine("${projectRoot}/${name}.md", "/work/app")).toBeUndefined();
    });
});
