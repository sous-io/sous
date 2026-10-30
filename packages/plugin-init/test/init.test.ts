import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigError, NonInteractiveError } from "@sous-io/plugin-api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handle } from "../src/init.js";
import { IGNORE_BLOCK_END, IGNORE_BLOCK_START } from "@sous-io/plugin-host";
import { configSchemaUrl, STARTER_PROMPT_RELATIVE_PATH } from "../src/templates.js";
import { initContext } from "./helpers.js";

let tmp: string;
let projectRoot: string;
let sousDir: string;

beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sous-init-")));
    projectRoot = path.join(tmp, "my-app");
    sousDir = path.join(projectRoot, ".sous");
    fs.mkdirSync(projectRoot, { recursive: true });
});

afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
});

/** Every file under `root`, relative to it with `/` separators on every platform, sorted, so two snapshots compare. */
function listTree(root: string): string[] {
    const found: string[] = [];
    const walk = (directory: string): void => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const full = path.join(directory, entry.name);

            if (entry.isDirectory()) {
                walk(full);
            } else {
                found.push(path.relative(root, full).split(path.sep).join("/"));
            }
        }
    };

    if (fs.existsSync(root)) {
        walk(root);
    }

    return found.sort();
}

describe("init", () => {
    /**
     * init should write every file a new project needs under .sous/, the sous-managed directories'
     * READMEs, and report every file written as an absolute path.
     */
    it("should write every file a new project needs", async () => {
        const { ctx } = initContext();
        const result = await handle({ directory: projectRoot, format: "json", noBuild: true }, ctx);

        expect(result).toMatchObject({ root: projectRoot, sousDir, configPath: path.join(sousDir, "sous.config.jsonc"), dryRun: false, kept: [] });
        expect(result.files.every((file) => path.isAbsolute(file))).toBe(true);
        expect(listTree(projectRoot)).toEqual([
            ".sous/.env",
            ".sous/.env.local.example",
            ".sous/.gitignore",
            ".sous/README.md",
            ".sous/conf.d/README.md",
            `.sous/${STARTER_PROMPT_RELATIVE_PATH}`,
            ".sous/sous.config.jsonc",
        ]);
        expect([...result.files].sort()).toEqual([...listTree(projectRoot).map((file) => path.join(projectRoot, file))].sort());
    });

    /**
     * The config should never set projectRoot (sous sets it, and setting it is an error), never name
     * .claude/skills (plugins supply skill targets), and should name the project after the directory
     * unless told otherwise.
     */
    it("should write a config without projectRoot or a skills directory", async () => {
        const { ctx } = initContext();

        await handle({ directory: projectRoot, format: "json", noBuild: true }, ctx);

        const jsonc = fs.readFileSync(path.join(sousDir, "sous.config.jsonc"), "utf8");
        const loaded = await initContext().ctx.services.get("config-files.loader").load(path.join(sousDir, "sous.config.jsonc"));

        expect(jsonc).not.toMatch(/_vars/);
        expect(jsonc).not.toMatch(/projectRoot\s*"?:/);
        expect(jsonc).not.toContain(".claude");
        expect(fs.readFileSync(path.join(sousDir, STARTER_PROMPT_RELATIVE_PATH), "utf8")).not.toContain(".claude");
        expect(loaded).toMatchObject({
            kind: "data",
            data: {
                name: "my-app",
                compilation: { targets: [{ entryPoint: `\${sousDir}/${STARTER_PROMPT_RELATIVE_PATH}`, outputs: [{ destinationFile: "${projectRoot}/AGENTS.md" }] }] },
            },
        });

        const other = path.join(tmp, "other");

        fs.mkdirSync(other);
        await handle({ directory: other, name: "Other Project", format: "json", noBuild: true }, initContext().ctx);
        expect(fs.readFileSync(path.join(other, ".sous/sous.config.jsonc"), "utf8")).toContain('"name": "Other Project"');
    });

    /** The json format should be bound to the shipped schema for this sous version through $schema. */
    it("should bind the JSONC config to the schema for this version", async () => {
        await handle({ directory: projectRoot, format: "json", noBuild: true }, initContext({ version: "0.1.1" }).ctx);

        const parsed = await initContext().ctx.services.get("config-files.loader").load(path.join(sousDir, "sous.config.jsonc"));

        expect((parsed as unknown as { data: { $schema: string } }).data.$schema).toBe(configSchemaUrl("0.1.1"));
        expect(configSchemaUrl("0.1.1")).toContain("/v0.1.1/sous.config.schema.json");
    });

    /** The js format should write sous.config.js, comments and all, and it should load. */
    it("should write a JavaScript config", async () => {
        const result = await handle({ directory: projectRoot, format: "js", noBuild: true }, initContext().ctx);

        expect(result.configPath).toBe(path.join(sousDir, "sous.config.js"));

        const text = fs.readFileSync(result.configPath, "utf8");

        expect(text).toContain('name: "my-app"');
        expect(text).not.toMatch(/_vars|projectRoot:/);
        expect(text).toMatch(/^\/\/ The primary sous config for my-app\./);
    });

    /** A format that is not offered is refused. */
    it("should refuse an unknown format", async () => {
        await expect(handle({ directory: projectRoot, format: "yaml" as never }, initContext().ctx)).rejects.toThrow(/not valid/);
    });

    /** A .sous/ that already holds a primary config is refused by name and nothing is written. */
    it("should refuse a project that already holds a primary config", async () => {
        fs.mkdirSync(sousDir, { recursive: true });

        const existing = path.join(sousDir, "sous.config.yaml");

        fs.writeFileSync(existing, "name: Existing\n");

        const before = listTree(projectRoot);
        const error = await handle({ directory: projectRoot }, initContext().ctx).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(ConfigError);
        expect((error as ConfigError).message).toMatch(/already set up for sous/);
        expect((error as ConfigError).details.join("\n")).toContain(existing);
        expect(listTree(projectRoot)).toEqual(before);
        expect(fs.readFileSync(existing, "utf8")).toBe("name: Existing\n");
    });

    /** Any other file the scaffold would write that already exists is kept as it is and reported. */
    it("should keep files that already exist", async () => {
        fs.mkdirSync(sousDir, { recursive: true });

        const envPath = path.join(sousDir, ".env");

        fs.writeFileSync(envPath, "TEAM=us\n");

        const { ctx } = initContext();
        const result = await handle({ directory: projectRoot, noBuild: true }, ctx);

        expect(result.kept).toEqual([envPath]);
        expect(result.files).not.toContain(envPath);
        expect(fs.readFileSync(envPath, "utf8")).toBe("TEAM=us\n");
    });

    /** A dry run should plan everything, write nothing and run no build (the view says so). */
    it("should write nothing on a dry run", async () => {
        const { ctx, recorded } = initContext();
        const result = await handle({ directory: projectRoot, dryRun: true }, ctx);

        expect(result.dryRun).toBe(true);
        expect(result.files).toHaveLength(5);
        expect(fs.existsSync(sousDir)).toBe(false);
        expect(recorded.runs).toEqual([]);
    });

    /** An existing .sous/.gitignore keeps its own lines and gains the sous-managed block once. */
    it("should merge the managed block into an existing ignore file", async () => {
        fs.mkdirSync(sousDir, { recursive: true });
        fs.writeFileSync(path.join(sousDir, ".gitignore"), "scratch/\n");

        await handle({ directory: projectRoot, noBuild: true }, initContext().ctx);

        const written = fs.readFileSync(path.join(sousDir, ".gitignore"), "utf8");

        expect(written.startsWith("scratch/\n")).toBe(true);
        expect(written.split("\n").filter((line) => line === IGNORE_BLOCK_START)).toHaveLength(1);
        expect(written.split("\n").filter((line) => line === IGNORE_BLOCK_END)).toHaveLength(1);
        expect(written).toContain("sous.state.json");
        expect(written).toContain(".env.local");
    });

    /**
     * A project with a package.json gains @sous-io/sous as a devDependency at exactly the running
     * version, keeping the file's indentation, other fields and trailing newline, sorted as npm
     * keeps them.
     */
    it("should add sous to an existing package.json as an exact devDependency", async () => {
        const file = path.join(projectRoot, "package.json");

        fs.writeFileSync(file, '{\n    "name": "my-app",\n    "scripts": { "test": "vitest" },\n    "devDependencies": { "zod": "^4.0.0" }\n}\n');

        const result = await handle({ directory: projectRoot, noBuild: true }, initContext().ctx);

        expect(result.packageJson).toEqual({ kind: "added", section: "devDependencies", range: "0.1.1" });
        expect(result.files).toContain(file);

        const written = fs.readFileSync(file, "utf8");

        expect(JSON.parse(written)).toEqual({ name: "my-app", scripts: { test: "vitest" }, devDependencies: { "@sous-io/sous": "0.1.1", zod: "^4.0.0" } });
        expect(Object.keys(JSON.parse(written).devDependencies)).toEqual(["@sous-io/sous", "zod"]);
        expect(written.startsWith('{\n    "name"')).toBe(true);
        expect(written.endsWith("}\n")).toBe(true);
    });

    /** A package.json that already depends on sous is left byte for byte, and the result says where. */
    it("should leave a package.json that already depends on sous untouched", async () => {
        const file = path.join(projectRoot, "package.json");
        const before = '{\n  "name": "my-app",\n  "dependencies": { "@sous-io/sous": "^0.1.0" }\n}\n';

        fs.writeFileSync(file, before);

        const result = await handle({ directory: projectRoot, noBuild: true }, initContext().ctx);

        expect(result.packageJson).toEqual({ kind: "already-declared", section: "dependencies", range: "^0.1.0" });
        expect(result.files).not.toContain(file);
        expect(fs.readFileSync(file, "utf8")).toBe(before);
    });

    /** A project with no package.json gets none, and the result says so. */
    it("should not create a package.json where there is none", async () => {
        const result = await handle({ directory: projectRoot, noBuild: true }, initContext().ctx);

        expect(result.packageJson).toEqual({ kind: "no-package-json" });
        expect(fs.existsSync(path.join(projectRoot, "package.json"))).toBe(false);
    });

    /** A package.json that is not JSON is refused by name, before anything is written. */
    it("should refuse a package.json it cannot read as JSON, before writing anything", async () => {
        fs.writeFileSync(path.join(projectRoot, "package.json"), "{ not json");

        await expect(handle({ directory: projectRoot }, initContext().ctx)).rejects.toThrow(/package\.json, but could not read it as JSON/);
        expect(fs.existsSync(sousDir)).toBe(false);
    });

    /** A dry run reports the package.json edit without making it. */
    it("should report the package.json edit on a dry run without writing it", async () => {
        const file = path.join(projectRoot, "package.json");
        const before = '{ "name": "my-app" }\n';

        fs.writeFileSync(file, before);

        const result = await handle({ directory: projectRoot, dryRun: true }, initContext().ctx);

        expect(result.packageJson.kind).toBe("added");
        expect(fs.readFileSync(file, "utf8")).toBe(before);
    });

    /** A config that does not load is reported as a bug in the scaffold. */
    it("should report a scaffold that does not load", async () => {
        const { ctx } = initContext({
            loader: {
                load: async () => {
                    throw new Error("unexpected token");
                },
            },
        });

        await expect(handle({ directory: projectRoot, noBuild: true }, ctx)).rejects.toThrow(/does not load/);
    });
});

describe("init build", () => {
    /**
     * Without noBuild, init marks the config changed, refreshes it for the rest of the chain
     * (ctx.refreshConfig()) so the build reads the config just written, and runs the one build path.
     */
    it("should refresh the config, then run the build through ctx.run", async () => {
        const { ctx, recorded } = initContext();
        const result = await handle({ directory: projectRoot }, ctx);

        expect(recorded.runs).toEqual([{ intent: "build", input: {} }]);
        expect(recorded.configChanged).toBe(1);
        expect(recorded.refreshes).toEqual([0]);
        expect(result.build).toMatchObject({ ok: true });
    });

    /** noBuild skips the build. */
    it("should not build under noBuild", async () => {
        const { ctx, recorded } = initContext();
        const result = await handle({ directory: projectRoot, noBuild: true }, ctx);

        expect(recorded.runs).toEqual([]);
        expect(result.build).toBeUndefined();
    });

    /** A failed build leaves the files in place and says to run sous build again. */
    it("should fail, saying the files are in place, when the first build fails", async () => {
        const { ctx } = initContext({ build: { ok: false } });

        await expect(handle({ directory: projectRoot }, ctx)).rejects.toThrow(/set up, but the first build failed/);
        expect(fs.existsSync(path.join(sousDir, "sous.config.js"))).toBe(true);
    });
});

describe("init inside another project", () => {
    /** Sets up an enclosing project at tmp with a config. */
    function enclosing(): void {
        fs.mkdirSync(path.join(tmp, ".sous"), { recursive: true });
        fs.writeFileSync(path.join(tmp, ".sous", "sous.config.jsonc"), "{}");
    }

    /** Without yes, it warns and asks; yes answers ahead of time. */
    it("should warn, and ask unless yes", async () => {
        enclosing();

        const asked = initContext({ answers: [true] });

        await handle({ directory: projectRoot, noBuild: true }, asked.ctx);

        expect(asked.recorded.asked).toEqual([`Set up ${projectRoot} as a project of its own?`]);
        expect(asked.recorded.reporter.at("warning").join("\n")).toContain("is inside a project that is already set up for sous");
        expect(fs.existsSync(sousDir)).toBe(true);

        fs.rmSync(sousDir, { recursive: true });

        const forced = initContext();

        await handle({ directory: projectRoot, noBuild: true, yes: true }, forced.ctx);

        expect(forced.recorded.asked).toEqual([]);
        expect(forced.recorded.reporter.at("warning").length).toBeGreaterThan(0);
    });

    /** A no writes nothing; with no way to ask the error names --yes. */
    it("should write nothing on a no, and name --yes when it cannot ask", async () => {
        enclosing();

        await expect(handle({ directory: projectRoot }, initContext({ answers: [false] }).ctx)).rejects.toThrow(/Nothing was written/);
        expect(fs.existsSync(sousDir)).toBe(false);

        const error = await handle({ directory: projectRoot }, initContext().ctx).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(NonInteractiveError);
        expect((error as NonInteractiveError).answeredBy).toContain("--yes");
        expect(fs.existsSync(sousDir)).toBe(false);
    });
});
