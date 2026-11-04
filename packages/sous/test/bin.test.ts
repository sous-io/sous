import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

describe("the sous bin, on an older Node", () => {
    /**
     * On a Node older than 22 the bin says which Node it needs and exits 1, before the bundle loads,
     * instead of crashing with an ESM SyntaxError. The bin imports node:module as a namespace, so a
     * Node without enableCompileCache (older than 22.1) still reaches the check.
     *
     * node bin.js --version   // on Node 20.20.2
     * // -> "Sous needs Node 22 or later; this is Node 20.20.2.", exit 1
     */
    it("should say Node 22 is needed instead of crashing", () => {
        const where = mkdtempSync(path.join(tmpdir(), "sous-old-node-"));
        const preload = path.join(where, "old-node.cjs");

        try {
            // Pretends to be Node 20 for the bin's version check.
            writeFileSync(preload, 'Object.defineProperty(process.versions, "node", { value: "20.20.2" });\n');

            const run = spawnSync(process.execPath, ["--require", preload, bin, "--version"], { cwd: where, encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });

            expect(run.stderr).toBe("Sous needs Node 22 or later; this is Node 20.20.2.\n");
            expect(run.status).toBe(1);
            expect(readFileSync(bin, "utf8")).toContain('import * as nodeModule from "node:module";');
        } finally {
            rmSync(where, { recursive: true, force: true });
        }
    });
});


describe("the sous bin, counting tokens", () => {
    /**
     * The bundle carries tiktoken's wasm file, so a build reports each written file's size:
     *
     * ✓ /tmp/sous-tokens-x/AGENTS.md (~3 tokens)
     */
    it("should show the token count of a written output", () => {
        const dir = mkdtempSync(path.join(tmpdir(), "sous-tokens-"));

        try {
            mkdirSync(path.join(dir, ".sous", "prompts"), { recursive: true });
            writeFileSync(path.join(dir, ".sous", "prompts", "AGENTS.md"), "# The project\n\nSay hello to the user.\n");
            writeFileSync(
                path.join(dir, ".sous", "sous.config.js"),
                [
                    "export const config = {",
                    '  _vars: { projectRoot: "${sousDir}/.." },',
                    '  repos: { "sous-recipes": { enabled: false } },',
                    "  compilation: {",
                    '    targets: [{ entryPoint: "${sousDir}/prompts/AGENTS.md", outputs: [{ destinationFile: "${projectRoot}/AGENTS.md" }] }],',
                    "  },",
                    "};",
                    "",
                ].join("\n"),
            );

            const run = spawnSync(process.execPath, [bin, "build"], {
                cwd: dir,
                encoding: "utf8",
                env: { PATH: process.env.PATH ?? "", SOUS_HOME: path.join(dir, "home"), NODE_OPTIONS: "" },
            });
            const output = `${run.stdout}${run.stderr}`;

            expect(output).not.toContain("Tokens were not counted");
            expect(output).toMatch(/AGENTS\.md\s+\(~\d+ tokens\)/);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }, 60_000);

    /**
     * The package ships the wasm file the bundle loads at run time: the bundler puts it next to the
     * bundle, and package.json lists it among the files npm publishes. (Checked without `npm pack`,
     * which sees only a `dist/` already built, and the release job runs the tests before it builds.)
     */
    it("should ship tiktoken_bg.wasm next to the bundle", () => {
        const manifest = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8")) as { files?: string[] };

        expect(existsSync(path.join(path.dirname(bin), "tiktoken_bg.wasm"))).toBe(true);
        expect(manifest.files).toContain("dist/tiktoken_bg.wasm");
    });
});
