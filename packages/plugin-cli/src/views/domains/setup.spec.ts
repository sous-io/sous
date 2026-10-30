import { describe, expect, it } from "vitest";
import type { CliViewEntity } from "../../types.js";
import { type CaptureOptions, captureView } from "../testing.js";
import { type InitResultShape, initView, pluginsInstallView, type UpdatePlanShape, type UpdateResultShape, updateView } from "./setup.js";

/** Collapses runs of spaces, so the padding of a key and value block does not matter. */
function flat(text: string): string {
    return text.replace(/ +/g, " ");
}

/** Runs a view and returns what a terminal would get (both streams, colors off), spaces collapsed. */
async function render(view: CliViewEntity["render"], result: unknown, options: CaptureOptions = {}): Promise<string> {
    const shown = await captureView(view, result, options);

    return flat(shown.stdout + shown.stderr);
}

/** Matches a label and its value however the reporter separates them. */
function fact(label: string, value: string): RegExp {
    const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    return new RegExp(`${escape(label)}[ :]*${escape(value)}`);
}

const initResult: InitResultShape = {
    root: "/p",
    sousDir: "/p/.sous",
    configPath: "/p/.sous/sous.config.jsonc",
    files: ["/p/.sous/sous.config.jsonc"],
    kept: [],
    packageJson: { kind: "added", section: "devDependencies", range: "0.2.34" },
    build: { ok: true },
    dryRun: false,
};

const globalPlan: UpdatePlanShape = {
    scope: "global",
    location: "/usr/lib/node_modules/@sous-io/sous",
    manager: "npm",
    managerAssumed: false,
    installed: "0.2.30",
    target: "0.2.34",
    direction: "upgrade",
    command: { command: "npm", args: ["i", "-g", "@sous-io/sous@0.2.34"] },
};

const projectPlan: UpdatePlanShape = {
    scope: "project",
    location: "/p/node_modules/@sous-io/sous",
    projectRoot: "/p",
    manager: "yarn@berry",
    managerAssumed: true,
    installed: "0.2.18",
    target: "0.2.34",
    direction: "upgrade",
    declaredIn: { section: "devDependencies", range: "0.2.18" },
    command: { command: "yarn", args: ["add", "-D", "-E", "@sous-io/sous@0.2.34"], cwd: "/p" },
};

describe("initView()", () => {
    /**
     * After a build: the package.json change, the build's own view, then what was set up.
     */
    it("should print the package.json change, the build and what was set up", async () => {
        const shownIntents: string[] = [];
        const text = await render(initView, initResult, {
            intent: "init",
            show: async (intent) => {
                shownIntents.push(intent);
            },
        });

        expect(text).toContain("Setting up the project");
        expect(text).toContain(".sous/sous.config.jsonc");
        expect(text).toContain("added @sous-io/sous 0.2.34 to devDependencies");
        expect(shownIntents).toEqual(["build"]);
        expect(text).toContain("What was set up");
        expect(text).toMatch(fact("Config", "/p/.sous/sous.config.jsonc"));
        expect(text).toMatch(fact("Prompt source", "/p/.sous/memories/AGENTS.tpl.md"));
        expect(text).toMatch(fact("Compiled to", "/p/AGENTS.md"));
        expect(text).toMatch(fact("Dependency", "@sous-io/sous 0.2.34"));
        expect(text).toContain("added to devDependencies in package.json");
        expect(text).toMatch(fact("Local answers", "/p/.sous/.env.local"));
        expect(text).toContain("gitignored; .env.local.example shows the layout");
    });

    /** With no package.json, there is no "Dependency" row; a file kept as it was is listed. */
    it("should leave out the dependency row without a package.json", async () => {
        const text = await render(initView, { ...initResult, packageJson: { kind: "no-package-json" }, kept: ["/p/.sous/.env"], build: undefined });

        expect(text).not.toContain("package.json");
        expect(text).toContain(".sous/.env");
        expect(text).toContain("already exists");
        expect(text).toContain("What was set up");
    });

    /** A dry run says what it would write and add, and that nothing was written. */
    it("should print only what would be written in a dry run", async () => {
        const text = await render(initView, { ...initResult, files: ["/p/.sous/sous.config.jsonc", "/p/package.json"], dryRun: true, build: undefined });

        expect(text).toContain(".sous/sous.config.jsonc");
        expect(text).toContain("would add @sous-io/sous 0.2.34 to devDependencies");
        expect(text).toContain("Nothing was written.");
        expect(text).not.toContain("What was set up");
        expect(await render(initView, { ...initResult, files: [], packageJson: { kind: "no-package-json" }, dryRun: true })).toBe("");
    });
});

describe("updateView()", () => {
    /** A dry run shows each plan's facts, its command included, as today's `sous update --dry-run`. */
    it("should print every plan of a dry run", async () => {
        const result: UpdateResultShape = {
            outcomes: [
                { plan: globalPlan, result: "planned" },
                { plan: projectPlan, result: "planned" },
            ],
            notices: [],
            registry: "https://registry.npmjs.org/@sous-io%2fsous",
            failed: false,
        };
        const text = await render(updateView, result, { intent: "update" });

        expect(text).toMatch(fact("Registry", "https://registry.npmjs.org/@sous-io%2fsous"));
        expect(text).toContain("Update plan");
        expect(text).toContain("Global install");
        expect(text).toContain("npm i -g @sous-io/sous@0.2.34");
        expect(text).toContain("Project install");
        expect(text).toMatch(fact("Package manager", "yarn@berry"));
        expect(text).toContain("assumed");
        expect(text).toMatch(fact("Installed", "0.2.18"));
        expect(text).toContain("yarn add -D -E @sous-io/sous@0.2.34");
        expect(text).toContain("/p");
        expect(text).toMatch(fact("Then builds", "no"));
        expect(text).toContain("the project has no sous config");
        expect(text).toContain("Nothing was installed.");
    });

    /** `--no-build` says so in the plan. */
    it("should say a dry run with --no-build builds nothing", async () => {
        const text = await render(updateView, { outcomes: [{ plan: projectPlan, result: "planned" }], notices: [], failed: false }, { intent: "update", input: { noBuild: true } });

        expect(text).toMatch(fact("Then builds", "no"));
        expect(text).toContain("--no-build was passed");
    });

    /** After a real run, the summary: one line per install and one for the build. */
    it("should print the summary after an update", async () => {
        const result: UpdateResultShape = {
            outcomes: [
                { plan: { ...globalPlan, scope: "global" }, result: "declined" },
                { plan: projectPlan, result: "updated" },
            ],
            notices: [],
            buildDirectory: "/p",
            build: { result: "built", directory: "/p", command: { command: "node", args: ["/p/node_modules/@sous-io/sous/bin/run.js", "build"], cwd: "/p" } },
            failed: false,
        };
        const text = await render(updateView, result, { intent: "update" });

        expect(text).toMatch(fact("Then builds", "yes"));
        expect(text).toContain("with the new copy, in /p");
        expect(text).toContain("yarn add -D -E @sous-io/sous@0.2.34");
        expect(text).toContain("Building the project");
        expect(text).toContain("node /p/node_modules/@sous-io/sous/bin/run.js build");
        expect(text).toContain("The global install was left at 0.2.30.");
        expect(text).toContain("Summary");
        expect(text).toMatch(fact("Global install", "skipped"));
        expect(text).toContain("left at 0.2.30");
        expect(text).toMatch(fact("Project install", "updated to 0.2.34"));
        expect(text).toContain("from 0.2.18");
        expect(text).toMatch(fact("Project build", "succeeded"));
    });

    /** Several global installs are told apart by their manager; nothing to update says so. */
    it("should name the manager of each of several global installs, and say when there is nothing to update", async () => {
        const result: UpdateResultShape = {
            outcomes: [
                { plan: globalPlan, result: "current" },
                { plan: { ...globalPlan, manager: "pnpm" }, result: "failed", exitCode: 3 },
            ],
            notices: [],
            failed: true,
        };
        const text = await render(updateView, result, { intent: "update" });

        expect(text).toMatch(fact("Global install (npm)", "up to date at 0.2.30"));
        expect(text).toMatch(fact("Global install (pnpm)", "failed"));
        expect(text).toContain("pnpm exited with code 3");
        expect(await render(updateView, { outcomes: [], notices: [], failed: false }, { intent: "update" })).toContain("There is no install of sous here that sous can update.");
    });

    /** A config this copy could not load is a warning first; a notice says what to run by hand. */
    it("should warn about a config it could not load, and list what it cannot update", async () => {
        const text = await render(
            updateView,
            {
                outcomes: [],
                notices: [{ message: "This sous was run through npx.", location: "/cache/sous", manualCommand: { command: "npm", args: ["i", "-g", "@sous-io/sous"] } }],
                configProblem: { configPath: "/p/.sous/sous.config.json", message: "The config is not valid (1 problem).\n  futureSetting: Not a known config key" },
                failed: false,
            },
            { intent: "update" },
        );

        expect(text.replace(/\s+/g, " ")).toContain("Sous could not load the project config at /p/.sous/sous.config.json, so this command carries on without it.");
        expect(text).toContain("futureSetting: Not a known config key");
        expect(text).toContain("Not updated");
        expect(text).toMatch(fact("Run by hand", "npm i -g @sous-io/sous"));
    });

    /** A Yarn Plug'n'Play install is located by its .pnp.cjs, and the plan says why. */
    it("should say a Plug'n'Play install keeps no node_modules copy", async () => {
        const plan = { ...projectPlan, location: "/p/.pnp.cjs", pnpRoot: "/p" };
        const text = await render(updateView, { outcomes: [{ plan, result: "planned" }], notices: [], failed: false }, { intent: "update" });

        expect(text).toMatch(fact("Location", "/p/.pnp.cjs"));
        expect(text).toContain("Yarn Plug'n'Play, which keeps no node_modules copy");
    });
});

describe("pluginsInstallView()", () => {
    const base = {
        manager: "pnpm",
        command: { command: "pnpm", args: ["add", "-D", "sous-plugin-x"] },
        installed: [{ name: "sous-plugin-x", range: "^1.2.0" }],
        declined: false,
        dryRun: false,
    };

    /** The plugins installed and the command that installed them. */
    it("should list the installed plugins", async () => {
        const text = await render(pluginsInstallView, { ...base, exitCode: 0 }, { intent: "plugins.install" });

        expect(text).toContain("Installed plugins");
        expect(text).toMatch(fact("sous-plugin-x", "^1.2.0"));
        expect(text).toContain("pnpm add -D sous-plugin-x");
        expect(text).toMatch(fact("Package manager", "pnpm"));
    });

    /** A dry run and a declined install. */
    it("should say what a dry run would install, and that a declined one installed nothing", async () => {
        const dry = await render(pluginsInstallView, { ...base, dryRun: true }, { intent: "plugins.install" });

        expect(dry).toContain("Plugins to install");
        expect(dry).toContain("Nothing was installed.");
        expect(await render(pluginsInstallView, { ...base, declined: true, installed: [] }, { intent: "plugins.install" })).toContain("Nothing was installed.");
    });
});
