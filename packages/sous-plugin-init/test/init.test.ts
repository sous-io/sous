import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigError, NonInteractiveError, ReportEntryStyle, VariableSet } from "@sous-io/sous-plugin-api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handle } from "../src/init.js";
import { IGNORE_BLOCK_END, IGNORE_BLOCK_START } from "@sous-io/sous-plugin-host";
import { MEMORIES_SOURCE_RELATIVE_PATH, STARTER_MEMORY_RELATIVE_PATH } from "../src/templates.js";
import { fakeGitRunner, fakePnpm, fakeProcesses, initContext } from "./helpers.js";

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
        const outputs = await handle({ directory: projectRoot, noBuild: true }, ctx);
        const result = outputs.toPlain();

        expect(result).toMatchObject({ root: projectRoot, sousDir, configPath: path.join(sousDir, "sous.config.jsonc"), dryRun: false, kept: [] });
        expect(result.files.every((file) => path.isAbsolute(file))).toBe(true);
        expect(listTree(projectRoot)).toEqual([
            ".gitignore",
            ".sous/.env",
            ".sous/.env.local.example",
            ".sous/.gitignore",
            `.sous/${MEMORIES_SOURCE_RELATIVE_PATH}`,
            ".sous/README.md",
            ".sous/conf.d/README.md",
            `.sous/${STARTER_MEMORY_RELATIVE_PATH}`,
            ".sous/sous.config.jsonc",
            ".sous/sous.lock.json",
        ]);
        expect([...result.files].sort()).toEqual([...listTree(projectRoot).map((file) => path.join(projectRoot, file))].sort());
    });

    /**
     * The config should never set projectRoot (sous sets it, and setting it is an error), should
     * hold no compile target but the project's own skills (no root AGENTS.md or CLAUDE.md; the
     * memories file is a plugin's), should point at the schema published with the running version,
     * and should name the project after the directory unless told otherwise.
     */
    it("should write a config whose only target is the project's skills", async () => {
        const { ctx } = initContext({ version: "1.2.3" });

        await handle({ directory: projectRoot, noBuild: true }, ctx);

        const text = fs.readFileSync(path.join(sousDir, "sous.config.jsonc"), "utf8");
        const loaded = await initContext().ctx.services.get("config-files.loader").load(path.join(sousDir, "sous.config.jsonc"));

        expect(text).not.toMatch(/_vars/);
        expect(text).not.toMatch(/"projectRoot"\s*:/);
        expect(text).not.toMatch(/AGENTS\.md|CLAUDE\.md|entryPoint/);
        expect(loaded).toMatchObject({ kind: "data", format: "jsonc" });
        expect((loaded as unknown as { data: unknown }).data).toEqual({
            $schema: "https://raw.githubusercontent.com/sous-io/sous/v1.2.3/sous.config.schema.json",
            name: "my-app",
            compilation: {
                targets: [{ entryGlob: "${sousDir}/skills/**/*", globBase: "${sousDir}/skills", outputs: [{ destinationDir: "${projectRoot}/.claude/skills" }] }],
            },
        });

        const other = path.join(tmp, "other");

        fs.mkdirSync(other);
        await handle({ directory: other, name: "Other Project", noBuild: true }, initContext().ctx);
        expect(fs.readFileSync(path.join(other, ".sous/sous.config.jsonc"), "utf8")).toContain('"name": "Other Project"');
    });

    /** The config should be written as sous.config.jsonc, comments and all, and no sous.config.js. */
    it("should write a JSONC config with its comments", async () => {
        const outputs = await handle({ directory: projectRoot, noBuild: true }, initContext().ctx);
        const result = outputs.toPlain();

        expect(result.configPath).toBe(path.join(sousDir, "sous.config.jsonc"));
        expect(fs.existsSync(path.join(sousDir, "sous.config.js"))).toBe(false);

        const text = fs.readFileSync(result.configPath, "utf8");

        expect(text).toMatch(/^\/\/ The primary sous config for my-app\./);
        expect(text).toContain("// Shown in command output. Any string.\n");
        expect(text).toContain(`\`.sous/${MEMORIES_SOURCE_RELATIVE_PATH}\``);
    });

    /**
     * The memories source should hold the two default lines, each on its own line after a comment
     * naming both; the starter memory should hold the generic text and no include line.
     */
    it("should write the memories source with the two default lines, and a starter memory without includes", async () => {
        await handle({ directory: projectRoot, noBuild: true }, initContext().ctx);

        const source = fs.readFileSync(path.join(sousDir, MEMORIES_SOURCE_RELATIVE_PATH), "utf8");
        const starter = fs.readFileSync(path.join(sousDir, STARTER_MEMORY_RELATIVE_PATH), "utf8");

        expect(source.endsWith("{% endcomment -%}\n@memories/**/*.md\n@#memories/**/*.md\n")).toBe(true);
        expect(source).toMatch(/^\{% comment %\}\n/);
        expect(source).toContain("Removing a line removes that part");
        expect(starter).toMatch(/^# my-app\n\n\{% comment %\}\n/);
        expect(starter).toContain("## Working in this project\n\n- Describe the project here: what it is, how it is built, and how it is tested.\n");
        expect(starter).toContain("`.sous/MEMORIES.tpl.md` controls what is included and in what order.\n");
        expect(starter.split("\n").filter((line) => line.startsWith("@"))).toEqual([]);
    });

    /**
     * The project's .gitignore should gain, once, the marked block of what a build writes outside
     * .sous/, keeping the lines already there; .sous/.gitignore should ignore backups/.
     */
    it("should write the ignore entries for the outputs into the project's .gitignore", async () => {
        fs.writeFileSync(path.join(projectRoot, ".gitignore"), "node_modules/\n");

        await handle({ directory: projectRoot, noBuild: true }, initContext().ctx);

        expect(fs.readFileSync(path.join(projectRoot, ".gitignore"), "utf8")).toBe(
            [
                "node_modules/",
                "",
                IGNORE_BLOCK_START,
                "/.claude/rules/SOUS-MEMORIES.md",
                "/.claude/skills/",
                "/.claude/agents/",
                "/AGENTS.override.md",
                IGNORE_BLOCK_END,
                "",
            ].join("\n"),
        );
        expect(fs.readFileSync(path.join(sousDir, ".gitignore"), "utf8").split("\n")).toContain("backups/");
    });

    /**
     * The lockfile should record the running version as migratedVersion, so a new project has no
     * pending migrations; a lockfile already there keeps what it pins.
     */
    it("should store the running version as migratedVersion in the lockfile", async () => {
        await handle({ directory: projectRoot, noBuild: true }, initContext({ version: "1.4.0" }).ctx);

        expect(JSON.parse(fs.readFileSync(path.join(sousDir, "sous.lock.json"), "utf8"))).toEqual({ formatVersion: 1, repos: {}, recipes: {}, migratedVersion: "1.4.0" });

        const other = path.join(tmp, "other");
        const pinned = { formatVersion: 1, repos: { acme: { url: "https://example.test/acme" } }, recipes: {} };

        fs.mkdirSync(path.join(other, ".sous"), { recursive: true });
        fs.writeFileSync(path.join(other, ".sous/sous.lock.json"), JSON.stringify(pinned));
        await handle({ directory: other, noBuild: true }, initContext({ version: "1.4.0" }).ctx);

        expect(JSON.parse(fs.readFileSync(path.join(other, ".sous/sous.lock.json"), "utf8"))).toEqual({ ...pinned, migratedVersion: "1.4.0" });
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
        const outputs = await handle({ directory: projectRoot, noBuild: true }, ctx);
        const result = outputs.toPlain();

        expect(result.kept).toEqual([envPath]);
        expect(result.files).not.toContain(envPath);
        expect(fs.readFileSync(envPath, "utf8")).toBe("TEAM=us\n");
    });

    /** The outputs should say a dry run wrote nothing, and a real run should end with what was set up. */
    it("should end with the dry-run sentence, or with what was set up", async () => {
        const dry = await handle({ directory: projectRoot, dryRun: true }, initContext().ctx);
        const real = await handle({ directory: projectRoot, noBuild: true }, initContext().ctx);

        expect(dry.last()?.style).toBe(ReportEntryStyle.DryRun);
        expect(dry.last()?.result?.toText()).toMatch(/^Nothing was written\./);
        expect(real.first()?.title).toBe("What was set up");
        expect((real.first()?.result as VariableSet).toObject()).toMatchObject({ Config: path.join(sousDir, "sous.config.jsonc"), Memories: path.join(sousDir, MEMORIES_SOURCE_RELATIVE_PATH) });
        expect(real.last()?.summary).toMatch(/build output/);
    });

    /** A real run with a build should show the build's outputs before what was set up. */
    it("should include the build's outputs before what was set up", async () => {
        const outputs = await handle({ directory: projectRoot }, initContext().ctx);

        expect(outputs.toArray().map((output) => output.title)).toEqual([undefined, "What was set up", undefined]);
    });

    /** A dry run should plan everything, write nothing and run no build. */
    it("should write nothing on a dry run", async () => {
        const { ctx, recorded } = initContext();
        const outputs = await handle({ directory: projectRoot, dryRun: true }, ctx);
        const result = outputs.toPlain();

        expect(result.dryRun).toBe(true);
        expect(result.files).toHaveLength(8);
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
        expect(written).toContain("sous.edits.json");
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

        const outputs = await handle({ directory: projectRoot, noBuild: true }, initContext().ctx);
        const result = outputs.toPlain();

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

        const outputs = await handle({ directory: projectRoot, noBuild: true }, initContext().ctx);
        const result = outputs.toPlain();

        expect(result.packageJson).toEqual({ kind: "already-declared", section: "dependencies", range: "^0.1.0" });
        expect(result.files).not.toContain(file);
        expect(fs.readFileSync(file, "utf8")).toBe(before);
    });

    /** A project with no package.json gets none, and the result says so. */
    it("should not create a package.json where there is none", async () => {
        const outputs = await handle({ directory: projectRoot, noBuild: true }, initContext().ctx);
        const result = outputs.toPlain();

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

        const outputs = await handle({ directory: projectRoot, dryRun: true }, initContext().ctx);
        const result = outputs.toPlain();

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
        const outputs = await handle({ directory: projectRoot }, ctx);
        const result = outputs.toPlain();

        expect(recorded.runs).toEqual([{ intent: "build", input: {} }]);
        expect(recorded.configChanged).toBe(1);
        expect(recorded.refreshes).toEqual([0]);
        expect(result.build).toMatchObject({ ok: true });
    });

    /** noBuild skips the build. */
    it("should not build under noBuild", async () => {
        const { ctx, recorded } = initContext();
        const outputs = await handle({ directory: projectRoot, noBuild: true }, ctx);
        const result = outputs.toPlain();

        expect(recorded.runs).toEqual([]);
        expect(result.build).toBeUndefined();
    });

    /** A failed build leaves the files in place and says to run sous build again. */
    it("should fail, saying the files are in place, when the first build fails", async () => {
        const { ctx } = initContext({ build: { ok: false } });

        await expect(handle({ directory: projectRoot }, ctx)).rejects.toThrow(/set up, but the first build failed/);
        expect(fs.existsSync(path.join(sousDir, "sous.config.jsonc"))).toBe(true);
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

describe("init importing a project's agent files", () => {
    /** Writes files under the project root: `{ "docs/a.md": "text" }`. */
    function write(files: Record<string, string>): void {
        for (const [file, content] of Object.entries(files)) {
            fs.mkdirSync(path.dirname(path.join(projectRoot, file)), { recursive: true });
            fs.writeFileSync(path.join(projectRoot, file), content, "utf8");
        }
    }

    /** A stand-in git runner that says every path is tracked, recording each command. */
    function fakeGit(): { runner: unknown; commands: string[][] } {
        const commands: string[][] = [];
        const runner = {
            run: async (args: string[]) => {
                commands.push(args);

                if (args[0] === "rev-parse") {
                    return { args, exitCode: 0, stdout: "true", stderr: "", durationMs: 0 };
                }

                return { args, exitCode: 0, stdout: args[0] === "ls-files" ? args.slice(2).join("\n") : "", stderr: "", durationMs: 0 };
            },
        };

        return { runner, commands };
    }

    /**
     * An existing CLAUDE.md should be imported into .sous/memories/imported/, with no starter memory
     * beside it. Sous no longer writes the root file, so it moves: it is backed up, removed, and
     * git stops tracking it. The root .gitignore does not list it.
     */
    it("should import an existing CLAUDE.md, back it up and move it out of the root", async () => {
        write({ "CLAUDE.md": "# Rules\n\nKeep commits small.\n", ".gitignore": "node_modules/\n" });

        const git = fakeGit();
        const { ctx } = initContext({ services: { "git.runner": git.runner } });
        const result = (await handle({ directory: projectRoot, noBuild: true }, ctx)).toPlain();
        const backups = listTree(path.join(sousDir, "backups"));

        expect(fs.readFileSync(path.join(sousDir, "memories/imported/CLAUDE.md"), "utf8")).toBe("# Rules\n\nKeep commits small.\n");
        expect(fs.existsSync(path.join(sousDir, STARTER_MEMORY_RELATIVE_PATH))).toBe(false);
        expect(fs.readFileSync(path.join(projectRoot, ".gitignore"), "utf8")).not.toContain("CLAUDE.md");
        expect(fs.existsSync(path.join(projectRoot, "CLAUDE.md"))).toBe(false);
        expect(backups).toHaveLength(1);
        expect(backups[0]).toMatch(/^\d{4}-\d{2}-\d{2}\/\d{4}-\d{2}\/CLAUDE\.md$/);
        expect(result.removed).toContain(path.join(projectRoot, "CLAUDE.md"));
        expect(result.untracked).toEqual(["CLAUDE.md"]);
        expect(git.commands).toContainEqual(["rm", "-r", "--cached", "--quiet", "--", "CLAUDE.md"]);
    });

    /** A CLAUDE.md that only points at AGENTS.md is not imported, but moves away with it. */
    it("should move a pointer CLAUDE.md away with the AGENTS.md it points at", async () => {
        write({ "CLAUDE.md": "@AGENTS.md\n", "AGENTS.md": "# Rules\n" });

        await handle({ directory: projectRoot, noBuild: true }, initContext().ctx);

        expect(fs.existsSync(path.join(sousDir, "memories/imported/CLAUDE.md"))).toBe(false);
        expect(fs.readFileSync(path.join(sousDir, "memories/imported/AGENTS.md"), "utf8")).toBe("# Rules\n");
        expect(fs.existsSync(path.join(projectRoot, "CLAUDE.md"))).toBe(false);
        expect(fs.existsSync(path.join(projectRoot, "AGENTS.md"))).toBe(false);
        expect(listTree(path.join(sousDir, "backups")).map((file) => file.split("/").pop())).toEqual(["AGENTS.md", "CLAUDE.md"]);
    });

    /** A dry run plans the move and removes nothing. */
    it("should leave the root instruction files in place on a dry run", async () => {
        write({ "CLAUDE.md": "# Rules\n" });

        const result = (await handle({ directory: projectRoot, dryRun: true }, initContext().ctx)).toPlain();

        expect(result.removed).toEqual([path.join(projectRoot, "CLAUDE.md")]);
        expect(fs.readFileSync(path.join(projectRoot, "CLAUDE.md"), "utf8")).toBe("# Rules\n");
        expect(fs.existsSync(sousDir)).toBe(false);
    });

    /**
     * With included files and no terminal, init should fail naming the three switches and --yes,
     * writing nothing; two switches together should be refused by name.
     */
    it("should name the include switches when it cannot ask, and refuse two of them", async () => {
        write({ "CLAUDE.md": "@docs/a.md\n", "docs/a.md": "A\n" });

        const error = await handle({ directory: projectRoot, noBuild: true }, initContext().ctx).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(NonInteractiveError);
        expect((error as NonInteractiveError).answeredBy).toBe("--move-includes, --copy-includes, --leave-includes or --yes");
        expect(fs.existsSync(sousDir)).toBe(false);

        await expect(handle({ directory: projectRoot, moveIncludes: true, leaveIncludes: true }, initContext().ctx)).rejects.toThrow(/Pass only one of/);
        expect(fs.existsSync(sousDir)).toBe(false);
    });

    /**
     * Asked in a terminal, the user's answer should decide; --yes should move, and --leave-includes
     * should leave the included file where it is with a #project include.
     */
    it("should follow the answer, --yes and the switches", async () => {
        write({ "CLAUDE.md": "@docs/a.md\n", "docs/a.md": "A\n" });

        const asked = initContext({ answers: ["copy"] });

        await handle({ directory: projectRoot, noBuild: true }, asked.ctx);

        expect(asked.recorded.asked).toEqual(["What should happen to the included file?"]);
        expect(fs.existsSync(path.join(sousDir, "includes/docs/a.md"))).toBe(true);
        expect(fs.existsSync(path.join(projectRoot, "docs/a.md"))).toBe(true);

        // Each run moves CLAUDE.md into .sous/, so it is put back before the next one.
        fs.rmSync(sousDir, { recursive: true });
        write({ "CLAUDE.md": "@docs/a.md\n" });
        await handle({ directory: projectRoot, noBuild: true, leaveIncludes: true }, initContext().ctx);

        expect(fs.readFileSync(path.join(sousDir, "memories/imported/CLAUDE.md"), "utf8")).toBe("@#project/docs/a.md\n");

        fs.rmSync(sousDir, { recursive: true });
        write({ "CLAUDE.md": "@docs/a.md\n" });
        await handle({ directory: projectRoot, noBuild: true, yes: true }, initContext().ctx);

        expect(fs.existsSync(path.join(projectRoot, "docs/a.md"))).toBe(false);
        expect(fs.readFileSync(path.join(sousDir, "includes/docs/a.md"), "utf8")).toBe("A\n");
    });

    /** Skills in .claude/skills/ should move to .sous/skills/, which the config compiles back and SKILLS_ROOT names. */
    it("should move existing skills and compile them back", async () => {
        write({ ".claude/skills/deploy/SKILL.md": "---\nname: deploy\n---\n" });

        await handle({ directory: projectRoot, noBuild: true }, initContext().ctx);

        const config = fs.readFileSync(path.join(sousDir, "sous.config.jsonc"), "utf8");

        expect(fs.existsSync(path.join(sousDir, "skills/deploy/SKILL.md"))).toBe(true);
        expect(fs.existsSync(path.join(projectRoot, ".claude/skills/deploy"))).toBe(false);
        expect(config).toContain('"entryGlob": "${sousDir}/skills/**/*"');
        expect(config).toContain('"destinationDir": "${projectRoot}/.claude/skills"');
        expect(fs.readFileSync(path.join(sousDir, ".env"), "utf8")).toContain("\nSKILLS_ROOT=.sous/skills\n");
    });

    /** In a sous recipe repository with nothing to import, the starter memory should say it is a Sous Repo. */
    it("should write the Sous Repo memory in a recipe repository", async () => {
        write({ "sous.repo.yaml": "formatVersion: 1\nname: team\nrecipes: []\n" });

        await handle({ directory: projectRoot, noBuild: true }, initContext().ctx);

        const memory = fs.readFileSync(path.join(sousDir, STARTER_MEMORY_RELATIVE_PATH), "utf8");

        expect(memory).toContain("## This Is a Sous Repo");
        expect(memory).toContain("`about-sous-repos`");
        expect(memory).not.toContain("## Working in this project");
    });
});

describe("init and the git hooks", () => {
    /** A context whose git repository's top is the project root, with a pnpm stand-in. */
    function gitContext(options: { answers?: unknown[]; top?: string } = {}) {
        const git = fakeGitRunner({ top: options.top ?? projectRoot });
        const processes = fakeProcesses();
        const context = initContext({ answers: options.answers ?? [], managers: [fakePnpm], services: { "git.runner": git.runner, "host.processes": processes.processes } });

        return { ...context, ran: processes.ran };
    }

    beforeEach(() => {
        fs.mkdirSync(path.join(projectRoot, ".git"));
    });

    /** With a .git folder, init asks before writing anything; a yes installs post-checkout, then builds. */
    it("should ask whether to install the hooks when there is a .git folder", async () => {
        const { ctx, recorded } = gitContext({ answers: [true, false] });
        const result = (await handle({ directory: projectRoot }, ctx)).toPlain();

        expect(recorded.asked).toEqual([
            "Install git hooks, so each new worktree and each checked-out branch gets Sous's output?",
            "Also install post-merge and post-rewrite, so the same runs after a pull and a rebase?",
        ]);
        expect(result.hooks).toMatchObject({ installed: true, via: "git", hooks: ["post-checkout"] });
        expect(fs.existsSync(path.join(projectRoot, ".git/hooks/post-checkout"))).toBe(true);
        expect(recorded.runs.map((run) => run.intent)).toEqual(["init.hooks", "build"]);
    });

    /** With no terminal and no flag, the error names --hooks, --no-hooks and --yes, and nothing is written. */
    it("should name the hook flags when it cannot ask, writing nothing", async () => {
        const error = await handle({ directory: projectRoot }, gitContext().ctx).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(NonInteractiveError);
        expect((error as NonInteractiveError).answeredBy).toBe("--hooks or --no-hooks (or --yes)");
        expect(fs.existsSync(sousDir)).toBe(false);
    });

    /** --no-hooks installs none and asks nothing; with no .git folder nothing is offered. */
    it("should install no hooks under --no-hooks, or without a .git folder", async () => {
        const declined = gitContext();
        const result = (await handle({ directory: projectRoot, hooks: false, noBuild: true }, declined.ctx)).toPlain();

        expect(result.hooks).toBeUndefined();
        expect(declined.recorded.asked).toEqual([]);

        fs.rmSync(sousDir, { recursive: true });
        fs.rmSync(path.join(projectRoot, ".git"), { recursive: true });

        const bare = gitContext();

        expect((await handle({ directory: projectRoot, noBuild: true }, bare.ctx)).toPlain().hooks).toBeUndefined();
        expect(bare.recorded.asked).toEqual([]);
    });

    /**
     * With a package.json, --yes installs the hooks without the pull hooks and runs the install,
     * whose script runs sous build, so init skips its own build.
     */
    it("should skip its own build when the install it ran builds", async () => {
        fs.writeFileSync(path.join(projectRoot, "package.json"), '{ "name": "my-app" }\n');

        const { ctx, recorded, ran } = gitContext();
        const outputs = await handle({ directory: projectRoot, yes: true }, ctx);
        const result = outputs.toPlain();

        expect(result.hooks).toMatchObject({ installed: true, via: "husky", hooks: ["post-checkout"], install: { outcome: "ran" } });
        expect(ran).toEqual([{ command: "pnpm", args: ["install"] }]);
        expect(recorded.runs.map((run) => run.intent)).toEqual(["init.hooks"]);
        expect(result.build).toBeUndefined();
        expect(outputs.last()?.summary).toMatch(/^The first build ran in 'pnpm install', through the "prepare" script\./);
        expect(JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8")).devDependencies).toEqual({ "@sous-io/sous": "0.1.1", husky: "^9.1.7" });
    });

    /** Declining the install leaves the build to init, as before. */
    it("should build by itself when the install is declined", async () => {
        fs.writeFileSync(path.join(projectRoot, "package.json"), '{ "name": "my-app" }\n');

        const { ctx, recorded, ran } = gitContext();
        const result = (await handle({ directory: projectRoot, hooks: true, pullHooks: false, install: false }, ctx)).toPlain();

        expect(result.hooks).toMatchObject({ installed: true, install: { outcome: "skipped" } });
        expect(ran).toEqual([]);
        expect(recorded.runs.map((run) => run.intent)).toEqual(["init.hooks", "build"]);
    });

    /** Below the top of the repository, init says why it installed no hooks and goes on. */
    it("should report, and go on, when .sous/ is not at the top of the repository", async () => {
        const { ctx, recorded } = gitContext({ top: tmp });
        const result = (await handle({ directory: projectRoot, hooks: true, noBuild: true }, ctx)).toPlain();

        expect(result.hooks).toMatchObject({ installed: false, manual: [expect.stringContaining("post-checkout hook"), expect.stringContaining('(cd "my-app" && sous build)')] });
        expect(recorded.reporter.at("warning").join("\n")).toContain("Sous did not install the git hooks.");
        expect(fs.existsSync(path.join(sousDir, "sous.config.jsonc"))).toBe(true);
    });
});
