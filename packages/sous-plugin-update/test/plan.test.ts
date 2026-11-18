import { describe, expect, it } from "vitest";
import type { GlobalInstallInfo, InstallDiscovery, ProjectInstallInfo } from "../src/installs.js";
import { buildUpdatePlans, type BuildUpdatePlansOptions } from "../src/plan.js";
import type { RegistryMetadata } from "../src/versions.js";
import { fakeManager } from "./helpers.js";

const METADATA: RegistryMetadata = {
    name: "@sous-io/sous",
    versions: ["1.0.0", "0.3.0-beta.1", "0.2.34", "0.2.30", "0.2.18"],
    distTags: { latest: "1.0.0" },
};

const DEFAULT: BuildUpdatePlansOptions = { request: { kind: "default" } };

/** A project manager the way discovery describes one. */
function projectManager(id: string, detected = true): ProjectInstallInfo["manager"] {
    return { supported: true, id, entity: fakeManager({ id }), detected, detection: { id, detected } };
}

/** A global npm install at 0.2.30. */
function npmGlobal(overrides: Partial<GlobalInstallInfo> = {}): GlobalInstallInfo {
    return {
        manager: fakeManager({ id: "npm" }),
        location: "/g/npm/@sous-io/sous",
        realPath: "/g/npm/@sous-io/sous",
        installed: "0.2.30",
        ...overrides,
    };
}

/** A pnpm project install at 0.2.18, declared as a devDependency. */
function pnpmProject(overrides: Partial<ProjectInstallInfo> = {}): ProjectInstallInfo {
    return {
        projectRoot: "/p",
        location: "/p/node_modules/@sous-io/sous",
        realPath: "/p/node_modules/.pnpm/sous/node_modules/@sous-io/sous",
        installed: "0.2.18",
        declared: { section: "devDependencies", range: "0.2.18" },
        manager: projectManager("pnpm"),
        workspaceRoot: false,
        ...overrides,
    };
}

/** A discovery with both installs, run from the global copy. */
function both(overrides: Partial<InstallDiscovery> = {}): InstallDiscovery {
    return {
        project: pnpmProject(),
        globals: [npmGlobal()],
        running: { kind: "global", manager: "npm", realPath: "/g/npm/@sous-io/sous", installed: "0.2.30" },
        ...overrides,
    };
}

describe("buildUpdatePlans()", () => {
    /**
     * buildUpdatePlans should plan each install on its own version, global first, with the exact
     * command the install's package-manager entity plans.
     *
     * buildUpdatePlans(both(), METADATA, default)
     * // -> [global npm 0.2.30 -> 0.2.34 (npm i -g), project pnpm 0.2.18 -> 0.2.34 (pnpm add -D -E, cwd /p)]
     */
    it("should plan the global and the project install, each on its own version", () => {
        const { plans, notices } = buildUpdatePlans(both(), METADATA, DEFAULT);

        expect(notices).toEqual([]);
        expect(plans).toEqual([
            {
                scope: "global",
                location: "/g/npm/@sous-io/sous",
                manager: "npm",
                managerAssumed: false,
                installed: "0.2.30",
                target: "0.2.34",
                direction: "upgrade",
                command: { command: "npm", args: ["i", "-g", "@sous-io/sous@0.2.34"] },
            },
            {
                scope: "project",
                location: "/p/node_modules/@sous-io/sous",
                projectRoot: "/p",
                manager: "pnpm",
                managerAssumed: false,
                installed: "0.2.18",
                target: "0.2.34",
                direction: "upgrade",
                declaredIn: { section: "devDependencies", range: "0.2.18" },
                command: { command: "pnpm", args: ["add", "-D", "-E", "@sous-io/sous@0.2.34"], cwd: "/p" },
            },
        ]);
    });

    /**
     * buildUpdatePlans should narrow to one scope with `only`, and report `not-found` when that
     * scope has no install.
     */
    it("should narrow to one scope and report a scope with no install", () => {
        const project = buildUpdatePlans(both(), METADATA, { ...DEFAULT, only: "project" });
        const global = buildUpdatePlans(both(), METADATA, { ...DEFAULT, only: "global" });

        expect(project.plans.map((plan) => plan.scope)).toEqual(["project"]);
        expect(global.plans.map((plan) => plan.scope)).toEqual(["global"]);

        const noGlobal = buildUpdatePlans(both({ globals: [] }), METADATA, { ...DEFAULT, only: "global" });

        expect(noGlobal.plans).toEqual([]);
        expect(noGlobal.notices).toMatchObject([{ kind: "not-found", scope: "global" }]);

        const { project: _dropped, ...withoutProject } = both();
        const noProject = buildUpdatePlans(withoutProject, METADATA, { ...DEFAULT, only: "project" });

        expect(noProject.notices).toMatchObject([{ kind: "not-found", scope: "project" }]);
    });

    /**
     * buildUpdatePlans should pass the request and the prerelease setting to the version choice,
     * report "current" with the command still present, and let a spec downgrade.
     */
    it("should carry the version choice into each plan", () => {
        const major = buildUpdatePlans(both(), METADATA, { request: { kind: "major" } });

        expect(major.plans.map((plan) => plan.target)).toEqual(["1.0.0", "1.0.0"]);

        const pre = buildUpdatePlans(both(), METADATA, { ...DEFAULT, prerelease: true });

        expect(pre.plans.map((plan) => plan.target)).toEqual(["0.3.0-beta.1", "0.3.0-beta.1"]);

        const spec = buildUpdatePlans(both(), METADATA, { request: { kind: "spec", spec: "0.2.18" } });

        expect(spec.plans.map((plan) => [plan.target, plan.direction])).toEqual([
            ["0.2.18", "downgrade"],
            ["0.2.18", "current"],
        ]);
        expect(spec.plans[1]!.command.args).toContain("@sous-io/sous@0.2.18");
    });

    /**
     * buildUpdatePlans should mark a manager as assumed when the project named none, keep a
     * dependencies declaration out of -D, and tell the entity when the project is a workspace root.
     */
    it("should mark an assumed manager and keep the declared section", () => {
        const discovery = both({
            project: pnpmProject({ manager: projectManager("npm", false), declared: { section: "dependencies", range: "^0.2.18" } }),
        });
        const [, project] = buildUpdatePlans(discovery, METADATA, DEFAULT).plans;

        expect(project).toMatchObject({
            manager: "npm",
            managerAssumed: true,
            command: { command: "npm", args: ["i", "-E", "@sous-io/sous@0.2.34"], cwd: "/p" },
        });

        const workspace = both({ project: pnpmProject({ workspaceRoot: true }) });

        expect(buildUpdatePlans(workspace, METADATA, DEFAULT).plans[1]!.command.args).toEqual(["add", "-D", "-E", "-w", "@sous-io/sous@0.2.34"]);
    });

    /**
     * buildUpdatePlans should carry `pnpRoot` for a Yarn Plug'n'Play project, and leave it out for
     * every other project.
     */
    it("should carry the Plug'n'Play root", () => {
        const discovery = both({
            project: pnpmProject({ location: "/p/.pnp.cjs", realPath: "/p/.pnp.cjs", manager: projectManager("yarn@berry"), pnpRoot: "/p" }),
        });
        const [, project] = buildUpdatePlans(discovery, METADATA, DEFAULT).plans;

        expect(project).toMatchObject({ location: "/p/.pnp.cjs", pnpRoot: "/p", manager: "yarn@berry" });
        expect("pnpRoot" in buildUpdatePlans(both(), METADATA, DEFAULT).plans[1]!).toBe(false);
    });

    /**
     * buildUpdatePlans should turn an undeclared copy, a copy with an unknown version and a manager
     * no plugin drives into notices.
     */
    it("should report copies it cannot plan as notices", () => {
        const { declared: _dropped, ...undeclaredProject } = pnpmProject();
        const undeclared = buildUpdatePlans(both({ project: undeclaredProject }), METADATA, DEFAULT);

        expect(undeclared.plans.map((plan) => plan.scope)).toEqual(["global"]);
        expect(undeclared.notices).toMatchObject([{ kind: "undeclared", scope: "project" }]);

        const unknown = buildUpdatePlans(
            both({ project: pnpmProject({ installed: "unknown" }), globals: [npmGlobal({ installed: "unknown" })] }),
            METADATA,
            DEFAULT,
        );

        expect(unknown.plans).toEqual([]);
        expect(unknown.notices.map((notice) => [notice.kind, notice.scope])).toEqual([
            ["unknown-version", "global"],
            ["unknown-version", "project"],
        ]);

        const unsupported = buildUpdatePlans(both({ project: pnpmProject({ manager: { supported: false } }) }), METADATA, DEFAULT);

        expect(unsupported.plans.map((plan) => plan.scope)).toEqual(["global"]);
        expect(unsupported.notices).toMatchObject([{ kind: "unsupported-manager", scope: "project", location: "/p/node_modules/@sous-io/sous" }]);
    });

    /** buildUpdatePlans should always report a run through npx, whatever the narrowing. */
    it("should report npx on every run", () => {
        const discovery = both({ running: { kind: "npx", realPath: "/c/_npx/1", installed: "0.2.30" } });
        const { notices } = buildUpdatePlans(discovery, METADATA, { ...DEFAULT, only: "project" });

        expect(notices).toMatchObject([{ kind: "npx", location: "/c/_npx/1" }]);
        expect(notices[0]).not.toHaveProperty("scope");
    });

    /**
     * buildUpdatePlans should report a Volta copy with Volta's own command at the version the
     * request chooses for it, and an unknown location with none; both are global notices, dropped
     * under `only: "project"`.
     */
    it("should report Volta and unknown locations as global notices", () => {
        const volta = both({ globals: [], running: { kind: "volta", realPath: "/v/.volta/x", installed: "0.2.30" } });

        expect(buildUpdatePlans(volta, METADATA, DEFAULT).notices).toMatchObject([
            { kind: "volta", scope: "global", manualCommand: { command: "volta", args: ["install", "@sous-io/sous@0.2.34"] } },
        ]);
        expect(buildUpdatePlans(volta, METADATA, { ...DEFAULT, only: "project" }).notices).toEqual([]);

        const unreadable = both({ globals: [], running: { kind: "volta", realPath: "/v", installed: "unknown" } });

        expect(buildUpdatePlans(unreadable, METADATA, DEFAULT).notices[0]).not.toHaveProperty("manualCommand");

        const checkout = both({ globals: [], running: { kind: "unknown", realPath: "/src/sous", installed: "0.2.30" } });

        expect(buildUpdatePlans(checkout, METADATA, DEFAULT).notices).toMatchObject([{ kind: "unknown-location", scope: "global", location: "/src/sous" }]);
    });

    /** buildUpdatePlans should let a spec that matches nothing fail the whole plan. */
    it("should throw when a spec matches nothing", () => {
        expect(() => buildUpdatePlans(both(), METADATA, { request: { kind: "spec", spec: "9.9.9" } })).toThrow(/"9\.9\.9" is not a published version/);
    });
});
