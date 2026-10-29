import { describe, expect, it } from "vitest";
import { builtConfig } from "../../test/part-a/helpers.js";
import { destinationsFor } from "./destinations.js";

const project = { root: "/project", sousDir: "/project/.sous", configPath: undefined, confDir: "/project/.sous/conf.d" };

function contextWith(entities: Record<string, Array<{ id: string } & Record<string, unknown>>>, data: Record<string, unknown> = {}) {
    const config = builtConfig(data as never, { entities });

    return { config, entities: config.entities, project };
}

describe("destinationsFor()", () => {
    it("should list every skill target's directory under the project root, and recipes.skills.outputs", () => {
        const ctx = contextWith(
            { "skill-target": [{ id: "claude-code", directory: ".claude/skills" }, { id: "elsewhere", directory: "/abs/skills" }] },
            { recipes: { skills: { outputs: ["${projectRoot}/more-skills"] } } },
        );

        expect(destinationsFor(ctx, "skills")).toEqual(["${projectRoot}/more-skills", "/abs/skills", "/project/.claude/skills"]);
    });

    it("should list every memory target's file", () => {
        const ctx = contextWith({ "memory-target": [{ id: "claude-code", fileName: "CLAUDE.md" }, { id: "codex", fileName: "AGENTS.md", directory: "docs" }] });

        expect(destinationsFor(ctx, "memories")).toEqual(["/project/CLAUDE.md", "/project/docs/AGENTS.md"]);
    });

    it("should list nothing when no plugin adds a target, and nothing for config layers", () => {
        const ctx = contextWith({});

        expect(destinationsFor(ctx, "skills")).toEqual([]);
        expect(destinationsFor(ctx, "memories")).toEqual([]);
        expect(destinationsFor(ctx, "config")).toEqual([]);
    });
});
