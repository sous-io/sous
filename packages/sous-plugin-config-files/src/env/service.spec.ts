import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeProject, type TestProject } from "../../test/helpers.js";
import { projectEnvironment } from "./load.js";
import { EnvFilesService } from "./service.js";

let project: TestProject;

beforeEach(() => {
    project = makeProject();
});

afterEach(() => {
    project.cleanup();
});

describe("EnvFilesService", () => {
    /**
     * paths() names both files in `.sous/`, or nothing outside a project.
     *
     * service.paths();   // { shared: "<root>/.sous/.env", local: "<root>/.sous/.env.local" }
     */
    it("should name both env files of the project", () => {
        expect(new EnvFilesService(project.info(), {}).paths()).toEqual({
            shared: path.join(project.sousDir, ".env"),
            local: path.join(project.sousDir, ".env.local"),
        });
        expect(new EnvFilesService(undefined, {}).paths()).toBeUndefined();
    });

    /** read() gives each file and the merge: the environment, then .env.local, then .env. */
    it("should merge the environment over .env.local over .env", async () => {
        project.write(".env", "A=shared\nB=shared\nC=shared\n");
        project.write(".env.local", "B=local\nC=local\n");

        const values = await new EnvFilesService(project.info(), { C: "process" }).read();

        expect(values.shared).toEqual({ A: "shared", B: "shared", C: "shared" });
        expect(values.local).toEqual({ B: "local", C: "local" });
        expect(values.merged).toMatchObject({ A: "shared", B: "local", C: "process" });
    });

    /** write() changes one line and keeps the rest of the file as written. */
    it("should set and remove values surgically", async () => {
        const file = project.write(".env.local", "# mine\nexport A=1  # keep\nB=2\n");
        const service = new EnvFilesService(project.info(), {});

        const change = await service.write("local", { A: "10", B: undefined, C: "new value" }, { comment: "Set by sous" });

        expect(change).toEqual({ file, changed: true, set: ["A", "C"], removed: ["B"] });
        expect(fs.readFileSync(file, "utf8")).toBe('# mine\nexport A=10  # keep\n\n# Set by sous\nC="new value"\n');
    });

    /** Writing values the file already holds changes nothing. */
    it("should report no change when the values are already there", async () => {
        project.write(".env", "A=1\n");

        const change = await new EnvFilesService(project.info(), {}).write("shared", { A: "1", Z: undefined });

        expect(change.changed).toBe(false);
        expect(change.set).toEqual([]);
    });

    /** A dry run computes the change and writes nothing. */
    it("should write nothing on a dry run", async () => {
        const change = await new EnvFilesService(project.info(), {}).write("shared", { A: "1" }, { dryRun: true });

        expect(change.changed).toBe(true);
        expect(fs.existsSync(path.join(project.sousDir, ".env"))).toBe(false);
    });

    /** Outside a project there is nothing to write. */
    it("should refuse to write outside a project", async () => {
        await expect(new EnvFilesService(undefined, {}).write("local", { A: "1" })).rejects.toThrow(/no sous project/);
    });

    /** parse() is the one env parser. */
    it("should parse env text", () => {
        expect(new EnvFilesService(undefined, {}).parse("A=1\nB='two'\n")).toEqual({ A: "1", B: "two" });
    });
});

describe("projectEnvironment()", () => {
    /** The environment the engine starts with: the given one, with the env files filling gaps. */
    it("should fill in the env files under the given environment, changing nothing", () => {
        project.write(".env", "A=shared\nB=shared\n");
        project.write(".env.local", "B=local\n");

        const given = { A: "process" };
        const env = projectEnvironment(project.info(), given);

        expect(env).toEqual({ A: "process", B: "local" });
        expect(given).toEqual({ A: "process" });
        expect(projectEnvironment(undefined, given)).toEqual(given);
    });
});
