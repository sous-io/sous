import { describe, expect, it } from "vitest";
import type { CliViewContext } from "../../types.js";
import { Printer } from "../printer.js";
import { createStyle } from "../style.js";
import { type InitResultShape, initView, pluginsInstallView, type UpdatePlanShape, type UpdateResultShape, updateView } from "./setup.js";

/** A plain, 100-column view context; nested results render as `[<intent> view]`. */
function context(intent: string, input: Record<string, unknown> = {}): CliViewContext {
    const style = createStyle(false);

    return {
        intent,
        input,
        globals: {},
        style,
        columns: 200,
        isTTY: false,
        printer: () => new Printer(style, 200, false),
        render: async (other) => `[${other} view]\n`,
    };
}

/** Collapses runs of spaces, so the padding of a key and value block does not matter. */
function flat(text: string): string {
    return text.replace(/ +/g, " ");
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
        const text = flat(await initView(initResult, context("init")));

        expect(text).toContain("▶ Setting up the project:");
        expect(text).toContain("wrote .sous/sous.config.jsonc");
        expect(text).toContain("added @sous-io/sous 0.2.34 to devDependencies in package.json");
        expect(text).toContain("[build view]");
        expect(text).toContain("▶ What was set up:");
        expect(text).toContain("Config : /p/.sous/sous.config.jsonc");
        expect(text).toContain("Prompt source : /p/.sous/memories/AGENTS.tpl.md");
        expect(text).toContain("Compiled to : /p/AGENTS.md");
        expect(text).toContain("Dependency : @sous-io/sous 0.2.34 added to devDependencies");
        expect(text).toContain("Local answers : /p/.sous/.env.local gitignored; .env.local.example shows the layout");
        expect(text.indexOf("[build view]")).toBeLessThan(text.indexOf("What was set up"));
    });

    /** With no package.json, there is no "Dependency" row; a file kept as it was is listed. */
    it("should leave out the dependency row without a package.json", async () => {
        const text = await initView({ ...initResult, packageJson: { kind: "no-package-json" }, kept: ["/p/.sous/.env"], build: undefined }, context("init"));

        expect(text).not.toContain("package.json");
        expect(text).toContain("kept .sous/.env, which already exists");
        expect(text).toContain("What was set up");
    });

    /** A dry run says what it would write and add, and that nothing was written. */
    it("should print only what would be written in a dry run", async () => {
        const text = await initView({ ...initResult, files: ["/p/.sous/sous.config.jsonc", "/p/package.json"], dryRun: true, build: undefined }, context("init"));

        expect(text).toContain("[Dry Run] would write .sous/sous.config.jsonc");
        expect(text).not.toContain("would write package.json");
        expect(text).toContain("[Dry Run] would add @sous-io/sous 0.2.34 to devDependencies in package.json");
        expect(text).toContain("[Dry Run] Nothing was written.");
        expect(text).not.toContain("What was set up");
        expect(await initView({ ...initResult, files: [], packageJson: { kind: "no-package-json" }, dryRun: true }, context("init"))).toBe("");
    });
});

describe("updateView()", () => {
    /** A dry run shows each plan's facts, its command included, as today's `sous update --dry-run`. */
    it("should print every plan of a dry run", () => {
        const result: UpdateResultShape = {
            outcomes: [
                { plan: globalPlan, result: "planned" },
                { plan: projectPlan, result: "planned" },
            ],
            notices: [],
            registry: "https://registry.npmjs.org/@sous-io%2fsous",
            failed: false,
        };
        const text = flat(updateView(result, context("update")));

        expect(text).toContain("Registry : https://registry.npmjs.org/@sous-io%2fsous");
        expect(text).toContain("▶ Update plan:");
        expect(text).toContain("➔ Global install:");
        expect(text).toContain("Command : npm i -g @sous-io/sous@0.2.34");
        expect(text).toContain("➔ Project install:");
        expect(text).toContain("Package manager: yarn@berry assumed");
        expect(text).toContain("Installed : 0.2.18");
        expect(text).toContain("Command : yarn add -D -E @sous-io/sous@0.2.34 in /p");
        expect(text).toContain("Then builds : no the project has no sous config");
        expect(text).toContain("Nothing was installed.");
    });

    /** `--no-build` says so in the plan. */
    it("should say a dry run with --no-build builds nothing", () => {
        const text = flat(updateView({ outcomes: [{ plan: projectPlan, result: "planned" }], notices: [], failed: false }, context("update", { noBuild: true })));

        expect(text).toContain("Then builds : no --no-build was passed");
    });

    /** After a real run, the summary: one line per install and one for the build. */
    it("should print the summary after an update", () => {
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
        const text = flat(updateView(result, context("update")));

        expect(text).toContain("Then builds : yes with the new copy, in /p");
        expect(text).toContain("Running: yarn add -D -E @sous-io/sous@0.2.34 in /p");
        expect(text).toContain("▶ Building the project:");
        expect(text).toContain("Running: node /p/node_modules/@sous-io/sous/bin/run.js build in /p");
        expect(text).toContain("The global install was left at 0.2.30.");
        expect(text).toContain("▶ Summary:");
        expect(text).toContain("Global install : skipped left at 0.2.30");
        expect(text).toContain("Project install: updated to 0.2.34 from 0.2.18");
        expect(text).toContain("Project build : succeeded in /p");
    });

    /** Several global installs are told apart by their manager; nothing to update says so. */
    it("should name the manager of each of several global installs, and say when there is nothing to update", () => {
        const result: UpdateResultShape = {
            outcomes: [
                { plan: globalPlan, result: "current" },
                { plan: { ...globalPlan, manager: "pnpm" }, result: "failed", exitCode: 3 },
            ],
            notices: [],
            failed: true,
        };
        const text = flat(updateView(result, context("update")));

        expect(text).toContain("Global install (npm) : up to date at 0.2.30");
        expect(text).toContain("Global install (pnpm): failed pnpm exited with code 3");
        expect(flat(updateView({ outcomes: [], notices: [], failed: false }, context("update")))).toContain("There is no install of sous here that sous can update.");
    });

    /** A config this copy could not load is a warning first; a notice says what to run by hand. */
    it("should warn about a config it could not load, and list what it cannot update", () => {
        const text = flat(
            updateView(
                {
                    outcomes: [],
                    notices: [{ message: "This sous was run through npx.", location: "/cache/sous", manualCommand: { command: "npm", args: ["i", "-g", "@sous-io/sous"] } }],
                    configProblem: { configPath: "/p/.sous/sous.config.json", message: "The config is not valid (1 problem).\n  futureSetting: Not a known config key" },
                    failed: false,
                },
                context("update"),
            ),
        );

        expect(text).toContain("WARNING:");
        expect(text).toContain("Sous could not load the project config at /p/.sous/sous.config.json, so this command carries on without it.");
        expect(text).toContain("futureSetting: Not a known config key");
        expect(text).toContain("▶ Not updated:");
        expect(text).toContain("Run by hand: npm i -g @sous-io/sous");
    });

    /** A Yarn Plug'n'Play install is located by its .pnp.cjs, and the plan says why. */
    it("should say a Plug'n'Play install keeps no node_modules copy", () => {
        const plan = { ...projectPlan, location: "/p/.pnp.cjs", pnpRoot: "/p" };
        const text = flat(updateView({ outcomes: [{ plan, result: "planned" }], notices: [], failed: false }, context("update")));

        expect(text).toContain("Location : /p/.pnp.cjs Yarn Plug'n'Play, which keeps no node_modules copy");
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
    it("should list the installed plugins", () => {
        const text = flat(pluginsInstallView({ ...base, exitCode: 0 }, context("plugins.install")));

        expect(text).toContain("▶ Installed plugins:");
        expect(text).toContain("sous-plugin-x: ^1.2.0");
        expect(text).toContain("Ran: pnpm add -D sous-plugin-x through pnpm");
    });

    /** A dry run and a declined install. */
    it("should say what a dry run would install, and that a declined one installed nothing", () => {
        const dry = flat(pluginsInstallView({ ...base, dryRun: true }, context("plugins.install")));

        expect(dry).toContain("▶ Plugins to install:");
        expect(dry).toContain("[Dry Run] Nothing was installed.");
        expect(pluginsInstallView({ ...base, declined: true, installed: [] }, context("plugins.install"))).toContain("Nothing was installed.");
    });
});
