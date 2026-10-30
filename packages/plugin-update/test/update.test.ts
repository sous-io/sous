import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigError, NonInteractiveError } from "@sous-io/plugin-api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { binEntryOf, handle, requestOf } from "../src/update.js";
import { fakeManager, installedPackage, recordingContext } from "./helpers.js";

/** A registry answer with the versions the plans choose from. */
const REGISTRY = {
    body: JSON.stringify({
        name: "@sous-io/sous",
        "dist-tags": { latest: "1.0.0" },
        versions: { "0.2.18": {}, "0.2.30": {}, "0.2.34": {}, "1.0.0": {} },
    }),
};

let dir: string;
let previousCwd: string;

beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sous-update-run-")));
    previousCwd = process.cwd();
});

afterEach(() => {
    process.chdir(previousCwd);
    fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * Lays out a project at 0.2.18 with a pnpm stand-in, plus a global npm install at 0.2.30. The
 * working directory moves into the project. A copy of the running sous sits in `own`.
 */
function layout(options: { withConfig?: boolean } = {}) {
    const location = path.join(dir, "node_modules/@sous-io/sous");

    fs.mkdirSync(location, { recursive: true });
    fs.writeFileSync(path.join(location, "package.json"), JSON.stringify({ name: "@sous-io/sous", version: "0.2.18", bin: { sous: "bin/run.js" } }));
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ devDependencies: { "@sous-io/sous": "0.2.18" } }));

    if (options.withConfig) {
        fs.mkdirSync(path.join(dir, ".sous"));
        fs.writeFileSync(path.join(dir, ".sous/sous.config.jsonc"), "{}");
    }

    process.chdir(dir);

    return {
        managers: [
            fakeManager({
                id: "pnpm",
                detect: (directory) => (directory === dir ? { id: "pnpm", detected: true } : undefined),
                project: (directory) =>
                    directory === dir ? [installedPackage({ location, realPath: location, version: "0.2.18", declared: { section: "devDependencies", range: "0.2.18" } })] : [],
            }),
            fakeManager({ id: "npm", detect: undefined, global: [installedPackage({ location: "/g/@sous-io/sous", version: "0.2.30" })] }),
        ],
        location,
    };
}

describe("requestOf()", () => {
    /** requestOf should turn the flags into a version request. */
    it("should read the version, major and default requests", () => {
        expect(requestOf({ version: "next" })).toEqual({ kind: "spec", spec: "next" });
        expect(requestOf({ major: true })).toEqual({ kind: "major" });
        expect(requestOf({})).toEqual({ kind: "default" });
    });
});

describe("binEntryOf()", () => {
    /** binEntryOf should take a string bin, the `sous` entry, or the first entry. */
    it("should read the bin entry", () => {
        expect(binEntryOf({ bin: "run.js" })).toBe("run.js");
        expect(binEntryOf({ bin: { other: "o.js", sous: "s.js" } })).toBe("s.js");
        expect(binEntryOf({ bin: { other: "o.js" } })).toBe("o.js");
        expect(binEntryOf({})).toBeUndefined();
        expect(binEntryOf(undefined)).toBeUndefined();
    });
});

describe("update handler", () => {
    /**
     * A dry run should plan both installs, run nothing, ask nothing, and say that nothing was
     * installed.
     */
    it("should plan every install and run nothing under dryRun", async () => {
        const { managers } = layout();
        const { ctx, recorded } = recordingContext({ managers, registry: REGISTRY, ownRoot: "/src/sous" });
        const result = await handle({ dryRun: true }, ctx);

        expect(result.outcomes.map((outcome) => [outcome.plan.scope, outcome.plan.target, outcome.result])).toEqual([
            ["global", "0.2.34", "planned"],
            ["project", "0.2.34", "planned"],
        ]);
        expect(recorded.commands).toEqual([]);
        expect(result.notices.map((notice) => notice.kind)).toEqual(["unknown-location"]);
    });

    /**
     * With --yes, each install runs through its manager, in order, and the project install is
     * followed by a build with the new copy when the project has a config.
     */
    it("should run each install with yes and build the project afterwards", async () => {
        const { managers, location } = layout({ withConfig: true });
        const { ctx, recorded, prompter } = recordingContext({ managers, registry: REGISTRY, ownRoot: "/src/sous" });
        const result = await handle({ yes: true }, ctx);

        expect(prompter.asked).toEqual([]);
        expect(recorded.commands).toEqual([
            "npm i -g @sous-io/sous@0.2.34",
            "pnpm add -D -E @sous-io/sous@0.2.34",
            `${process.execPath} ${path.join(location, "bin/run.js")} build`,
        ]);
        expect(recorded.runs[2]).toMatchObject({ cwd: dir, env: { SOUS_NO_DELEGATE: "1" } });
        // Every run asks for the shell on Windows, where a package manager is a `.cmd` shim.
        expect(recorded.runs.every((run) => run.windowsShell === true)).toBe(true);
        expect(result.outcomes.map((outcome) => outcome.result)).toEqual(["updated", "updated"]);
        expect(result.build).toMatchObject({ result: "built", directory: dir, exitCode: 0, command: { args: [expect.stringContaining("run.js"), "build"], cwd: dir } });
    });

    /** --no-build and a project without a config both skip the build, saying why. */
    it("should skip the build under noBuild and without a config", async () => {
        const first = layout({ withConfig: true });
        const skipped = await handle({ yes: true, project: true, noBuild: true }, recordingContext({ managers: first.managers, registry: REGISTRY }).ctx);

        expect(skipped.build).toEqual({ result: "skipped" });

        fs.rmSync(path.join(dir, ".sous"), { recursive: true });

        const none = await handle({ yes: true, project: true }, recordingContext({ managers: first.managers, registry: REGISTRY }).ctx);

        expect(none.build).toEqual({ result: "no-config" });
    });

    /** --global and --project each narrow the plans. */
    it("should narrow to the global or the project install", async () => {
        const { managers } = layout();
        const global = await handle({ dryRun: true, global: true }, recordingContext({ managers, registry: REGISTRY }).ctx);
        const project = await handle({ dryRun: true, project: true }, recordingContext({ managers, registry: REGISTRY }).ctx);

        expect(global.outcomes.map((outcome) => outcome.plan.scope)).toEqual(["global"]);
        expect(project.outcomes.map((outcome) => outcome.plan.scope)).toEqual(["project"]);
    });

    /** --major and --version choose the version, and --version may downgrade. */
    it("should honor major and version", async () => {
        const { managers } = layout();
        const major = await handle({ dryRun: true, major: true }, recordingContext({ managers, registry: REGISTRY }).ctx);
        const older = await handle({ dryRun: true, version: "0.2.18" }, recordingContext({ managers, registry: REGISTRY }).ctx);

        expect(major.outcomes.map((outcome) => outcome.plan.target)).toEqual(["1.0.0", "1.0.0"]);
        expect(older.outcomes.map((outcome) => [outcome.plan.direction, outcome.result])).toEqual([
            ["downgrade", "planned"],
            ["current", "current"],
        ]);
    });

    /** Each install asks its own question; a no leaves that install alone and the next still asks. */
    it("should ask once per install and respect a no", async () => {
        const { managers } = layout();
        const { ctx, recorded, prompter } = recordingContext({ managers, registry: REGISTRY, answers: [false, true] });
        const result = await handle({ noBuild: true }, ctx);

        expect(prompter.asked).toHaveLength(2);
        expect(prompter.asked[0]).toMatch(/Update the global install from 0\.2\.30 to 0\.2\.34\? \(1 of 2\)/);
        expect(result.outcomes.map((outcome) => outcome.result)).toEqual(["declined", "updated"]);
        expect(recorded.commands).toEqual(["pnpm add -D -E @sous-io/sous@0.2.34"]);
    });

    /** Without --yes and without a way to ask, the update fails naming the flag. */
    it("should fail naming --yes when it cannot ask", async () => {
        const { managers } = layout();
        const { ctx, recorded } = recordingContext({ managers, registry: REGISTRY });

        await expect(handle({}, ctx)).rejects.toBeInstanceOf(NonInteractiveError);
        await expect(handle({}, ctx)).rejects.toThrow(/--yes/);
        expect(recorded.commands).toEqual([]);
    });

    /** A failed install is reported, the rest still run, and the update ends in an error. */
    it("should keep going after a failed install and then fail", async () => {
        const { managers } = layout();
        const { ctx, recorded } = recordingContext({ managers, registry: REGISTRY, exitCodes: [1, 0] });

        await expect(handle({ yes: true, noBuild: true }, ctx)).rejects.toMatchObject({
            message: "Not every step of the update succeeded.",
            details: expect.arrayContaining([expect.stringMatching(/failed, npm exited with code 1/), expect.stringMatching(/updated to 0\.2\.34/)]),
        });
        expect(recorded.commands).toHaveLength(2);
    });

    /** A failing build after a project update fails the update too. */
    it("should fail when the build after the project update fails", async () => {
        const { managers } = layout({ withConfig: true });
        const { ctx } = recordingContext({ managers, registry: REGISTRY, exitCodes: [0, 3] });

        await expect(handle({ yes: true, project: true }, ctx)).rejects.toMatchObject({ details: expect.arrayContaining(["Project build: failed"]) });
    });

    /** Flags that cannot be combined are refused before anything is read. */
    it("should refuse major with version and global with project", async () => {
        const { ctx } = recordingContext({ managers: [], registry: REGISTRY });

        await expect(handle({ major: true, version: "1.0.0" }, ctx)).rejects.toThrow(/not valid/);
        await expect(handle({ global: true, project: true }, ctx)).rejects.toThrow(/not valid/);
    });

    /** Without any install, the update says so and returns nothing to do. */
    it("should say when there is no install to update", async () => {
        process.chdir(dir);

        const { ctx } = recordingContext({ managers: [fakeManager({ id: "npm", detect: undefined })], registry: REGISTRY, ownRoot: dir });
        const result = await handle({ yes: true }, ctx);

        expect(result.outcomes).toEqual([]);
        expect(result.registry).toMatch(/@sous-io%2fsous$/);
    });

    /**
     * A project config this copy could not load does not stop the update (the new copy may be the
     * one that understands it); the result names the config and the error, for the front end to warn.
     */
    it("should carry on past a config it could not load, naming it in the result", async () => {
        process.chdir(dir);

        const configPath = path.join(dir, ".sous", "sous.config.json");
        const configError = new ConfigError("The config is not valid (1 problem).", { details: ["futureSetting: Not a known config key"] });
        const { ctx } = recordingContext({
            managers: [fakeManager({ id: "npm", detect: undefined })],
            registry: REGISTRY,
            ownRoot: dir,
            configError,
            project: { root: dir, sousDir: path.join(dir, ".sous"), configPath } as never,
        });
        const result = await handle({ yes: true }, ctx);

        expect(result.configProblem).toEqual({ configPath, message: "The config is not valid (1 problem).\n  futureSetting: Not a known config key" });
    });

    /** A registry that cannot be read stops the update before anything runs. */
    it("should stop when the registry cannot be read", async () => {
        const { managers } = layout();
        const { ctx, recorded } = recordingContext({ managers, registry: { status: 503 } });

        await expect(handle({ yes: true }, ctx)).rejects.toThrow(/503/);
        expect(recorded.commands).toEqual([]);
    });
});
