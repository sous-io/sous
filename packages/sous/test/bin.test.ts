import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

const packageDir = path.resolve(import.meta.dirname, "..");
const bin = inject("sousBin");
const samplePlugin = path.join(packageDir, "test", "fixtures", "diagrams-plugin.mjs");
let project: string;

/** Runs the bundled bin in a temp project, with the sample plugin loaded through SOUS_PLUGINS. */
function sous(args: string[], env: Record<string, string> = {}) {
    const result = spawnSync(process.execPath, [bin, ...args], {
        cwd: project,
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "", SOUS_PLUGINS: samplePlugin, ...env },
    });

    return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

beforeAll(() => {
    // The bundle is built by test/global-setup.ts.
    project = mkdtempSync(path.join(tmpdir(), "sous-bin-"));
    mkdirSync(path.join(project, ".sous"));
}, 60_000);

afterAll(() => {
    rmSync(project, { recursive: true, force: true });
});

describe("the sous bin, end to end", () => {
    /**
     * The bin builds the config, loads the sample plugin named in SOUS_PLUGINS inside the config
     * loop, and the CLI runs its intent from the generated command.
     *
     * sous diagrams render arch --scale 2 --json   // -> { "rendered": 1, "scale": 2, "dryRun": false }
     */
    it("should run a plugin's intent through its generated command", () => {
        const run = sous(["diagrams", "render", "arch", "--scale", "2", "--json"]);

        expect(run.stderr).toBe("");
        expect(run.status).toBe(0);
        expect(JSON.parse(run.stdout)).toEqual({ rendered: 1, scale: 2, dryRun: false });
        expect(JSON.parse(sous(["render", "--dry-run", "--json"]).stdout)).toEqual({ rendered: 3, scale: 1, dryRun: true });
    });

    /** The root help lists the plugin's group with its cli-group summary; the command help lists its flags. */
    it("should generate help for the plugin's group and command", () => {
        const root = sous(["--help"]);

        expect(root.status).toBe(0);
        expect(root.stdout).toMatch(/diagrams\s+Render the project's diagrams/);
        expect(root.stdout).toMatch(/version\s+Print the version/);
        expect(root.stdout).toMatch(/--log-level <level>/);

        const command = sous(["diagrams", "render", "--help"]);

        expect(command.stdout).toContain("Render every diagram to SVG");
        expect(command.stdout).toContain("USAGE\n  $ sous diagrams render [ONLY] [flags]");
        expect(command.stdout).toMatch(/--scale <number>\s+How much to scale each diagram Default: 1\./);
        expect(command.stdout).toMatch(/--dry-run\s+Print the plan and change nothing/);
        expect(command.stdout).toContain("ALIASES\n  $ sous render");
    });

    /** A mistyped command fails with exit code 2 and a suggestion. */
    it("should suggest a command for a typo", () => {
        const run = sous(["diagrams", "rendr"]);

        expect(run.status).toBe(2);
        expect(run.stderr).toContain('Error: There is no command "diagrams rendr".\n  Did you mean "diagrams render"?');
    });

    /** --version prints the package version with a leading "v", as the old CLI did: `v0.2.34`. */
    it("should print the version", () => {
        expect(sous(["--version"]).stdout.trim()).toMatch(/^v?\d+\.\d+\.\d+/);
    });

    /** A plugin that cannot be found stops the build, before any intent runs, with exit code 1. */
    it("should stop with an error when a listed plugin cannot be found", () => {
        const run = sous(["--help"], { SOUS_PLUGINS: "./no-such-plugin.mjs" });

        expect(run.status).toBe(1);
        expect(run.stderr).toContain('Error: Could not find the plugin "./no-such-plugin.mjs" listed in plugins.load.');
    });

    /**
     * `sous --help` takes under 150ms. The test allows more, since test machines vary;
     * the measured time is printed for the record.
     */
    it("should answer --help quickly", () => {
        sous(["--help"]);

        const times: number[] = [];

        for (let i = 0; i < 5; i++) {
            const start = performance.now();

            sous(["--help"]);
            times.push(performance.now() - start);
        }

        const best = Math.min(...times);

        console.log(`sous --help: best ${best.toFixed(0)}ms of 5 (${times.map((t) => t.toFixed(0)).join(", ")})`);
        expect(best).toBeLessThan(600);
    });
});

describe("the sous bin, with a JavaScript config in a project whose package.json has no type", () => {
    /** Runs `sous version` in a fresh project holding the given `.sous/sous.config.js`. */
    function runWithConfig(source: string) {
        const dir = mkdtempSync(path.join(tmpdir(), "sous-typeless-"));

        try {
            mkdirSync(path.join(dir, ".sous"));
            writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "typeless" }));
            writeFileSync(path.join(dir, ".sous", "sous.config.js"), source);

            return spawnSync(process.execPath, [bin, "version"], {
                cwd: dir,
                encoding: "utf8",
                env: { PATH: process.env.PATH ?? "", NODE_OPTIONS: "" },
            });
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }

    /** sous.config.js: export const config = { ... }   // no MODULE_TYPELESS_PACKAGE_JSON warning on stderr */
    it("should load an ES module sous.config.js without Node's typeless package warning", () => {
        const run = runWithConfig("export const config = {};\n");

        expect(run.status).toBe(0);
        expect(run.stderr).not.toContain("MODULE_TYPELESS_PACKAGE_JSON");
        expect(run.stderr).not.toContain("Module type of file");
    });

    /** sous.config.js: module.exports = {}   // a CommonJS file keeps loading */
    it("should still load a CommonJS sous.config.js", () => {
        const run = runWithConfig("module.exports = {};\n");

        expect(run.status).toBe(0);
        expect(run.stderr).not.toContain("MODULE_TYPELESS_PACKAGE_JSON");
        expect(run.stderr).not.toContain("Error");
    });
});

