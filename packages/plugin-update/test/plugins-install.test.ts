import { describe, expect, it } from "vitest";
import { handle, parsePluginSpec } from "../src/plugins-install.js";
import { fakeManager, installedPackage, recordingContext } from "./helpers.js";

/** A project at /p owned by pnpm, which lists what it installed after the command ran. */
function pnpm(declared: Record<string, string> = {}) {
    return fakeManager({
        id: "pnpm",
        detect: { id: "pnpm", detected: true, workspaceRoot: "/p" },
        project: () => Object.entries(declared).map(([name, range]) => installedPackage({ name, location: `/p/node_modules/${name}`, declared: { section: "devDependencies", range } })),
    });
}

/** A project info for /p. */
const PROJECT = { root: "/p", sousDir: "/p/.sous", configPath: undefined, confDir: "/p/.sous/conf.d" };

describe("parsePluginSpec()", () => {
    /** parsePluginSpec should split a name from its range, scoped names included. */
    it("should split name and range", () => {
        expect(parsePluginSpec("sous-plugin-x")).toEqual({ name: "sous-plugin-x" });
        expect(parsePluginSpec("sous-plugin-x@^1.0.0")).toEqual({ name: "sous-plugin-x", range: "^1.0.0" });
        expect(parsePluginSpec("@scope/plugin")).toEqual({ name: "@scope/plugin" });
        expect(parsePluginSpec("@scope/plugin@~2")).toEqual({ name: "@scope/plugin", range: "~2" });
        expect(parsePluginSpec("x@")).toEqual({ name: "x" });
    });
});

describe("plugins.install handler", () => {
    /**
     * With yes, it should run the command the owning manager plans, in the project root, and
     * report the ranges the manager declared.
     */
    it("should install through the project's manager", async () => {
        const { ctx, recorded, prompter } = recordingContext({ managers: [pnpm({ "sous-plugin-x": "^1.2.0" })], project: PROJECT });
        const result = await handle({ plugins: ["sous-plugin-x@^1.0.0", "@s/y"], yes: true }, ctx);

        expect(prompter.asked).toEqual([]);
        expect(recorded.commands).toEqual(["pnpm add -D -E -w sous-plugin-x@^1.0.0 @s/y"]);
        expect(recorded.runs[0]!.cwd).toBe("/p");
        expect(result).toMatchObject({
            manager: "pnpm",
            declined: false,
            dryRun: false,
            exitCode: 0,
            installed: [
                { name: "sous-plugin-x", range: "^1.2.0" },
                { name: "@s/y", range: "latest" },
            ],
        });
    });

    /** The section is the input's, and dependencies drops -D. */
    it("should use the section it is given", async () => {
        const { ctx, recorded } = recordingContext({ managers: [pnpm()], project: PROJECT });

        await handle({ plugins: ["p"], section: "dependencies", yes: true }, ctx);

        expect(recorded.commands).toEqual(["pnpm add -E -w p"]);
    });

    /** A dry run plans the command and runs and asks nothing. */
    it("should only plan under dryRun", async () => {
        const { ctx, recorded } = recordingContext({ managers: [pnpm()], project: PROJECT });
        const result = await handle({ plugins: ["p@1"], dryRun: true }, ctx);

        expect(recorded.commands).toEqual([]);
        expect(result).toMatchObject({ dryRun: true, declined: false, command: { command: "pnpm" }, installed: [{ name: "p", range: "1" }] });
    });

    /** Without yes it asks; a no installs nothing, and no way to ask names --yes. */
    it("should ask unless yes, and name the flag when it cannot", async () => {
        const declined = recordingContext({ managers: [pnpm()], project: PROJECT, answers: [false] });
        const result = await handle({ plugins: ["p"] }, declined.ctx);

        expect(result).toMatchObject({ declined: true, installed: [] });
        expect(declined.recorded.commands).toEqual([]);

        const silent = recordingContext({ managers: [pnpm()], project: PROJECT });

        await expect(handle({ plugins: ["p"] }, silent.ctx)).rejects.toThrow(/--yes/);
    });

    /** A failing command is an error naming the exit code. */
    it("should fail when the manager fails", async () => {
        const { ctx } = recordingContext({ managers: [pnpm()], project: PROJECT, exitCodes: [1] });

        await expect(handle({ plugins: ["p"], yes: true }, ctx)).rejects.toThrow(/pnpm exited with code 1/);
    });

    /** No plugins, or a project no manager claims, are refused clearly. */
    it("should refuse an empty list and an unclaimed project", async () => {
        await expect(handle({ plugins: [" "] }, recordingContext({ managers: [pnpm()], project: PROJECT }).ctx)).rejects.toThrow(/not valid/);
        await expect(handle({ plugins: ["p"], yes: true }, recordingContext({ managers: [fakeManager({ id: "npm", detect: undefined })], project: PROJECT }).ctx)).rejects.toThrow(
            /No package manager plugin claims the project at \/p/,
        );
    });
});
