/**
 * The plan an update carries out: for each install, the version it moves to and the exact command
 * that moves it, plus a notice for every copy sous found and cannot act on.
 *
 * Planning has no side effects. What {@link buildUpdatePlans} returns is exactly what a dry run
 * reports and what a real run executes, one confirmation per plan. The commands come from the
 * package-manager entities; this module only asks for them.
 */

import semver from "semver";
import { PACKAGE_NAME, type GlobalInstallInfo, type InstallDiscovery, type ProjectInstallInfo } from "./installs.js";
import type { InstallScope, UpdateNotice, UpdatePlan } from "./types.js";
import { chooseVersion, type RegistryMetadata, type VersionRequest } from "./versions.js";

/**
 * A plan, with the one fact the contract's `UpdatePlan` leaves out: the directory holding
 * `.pnp.cjs` for a Yarn Plug'n'Play project, whose `location` is then that file and whose build
 * runs through Yarn.
 */
export interface PlannedUpdate extends UpdatePlan {
    readonly pnpRoot?: string;
}

/** Every plan and every notice. */
export interface UpdatePlanSet {
    /** Global plans first, then the project plan. */
    plans: PlannedUpdate[];
    notices: UpdateNotice[];
}

/** Options for {@link buildUpdatePlans}. */
export interface BuildUpdatePlansOptions {
    request: VersionRequest;
    /** Whether prereleases count; undefined means "on when the installed version is a prerelease", per install. */
    prerelease?: boolean;
    /** Plan only this scope (`--global` or `--project`); undefined plans both. */
    only?: InstallScope;
}

/** The package spec an install names: `@sous-io/sous@<version>`. */
export function packageSpec(version: string): string {
    return `${PACKAGE_NAME}@${version}`;
}

/**
 * Works out every plan and every notice, one install at a time, each judged on its own installed
 * version.
 *
 * @throws ConfigError when a `spec` request matches nothing for an install.
 */
export function buildUpdatePlans(discovery: InstallDiscovery, metadata: RegistryMetadata, options: BuildUpdatePlansOptions): UpdatePlanSet {
    const plans: PlannedUpdate[] = [];
    const notices: UpdateNotice[] = [];
    const wants = (scope: InstallScope): boolean => options.only === undefined || options.only === scope;

    if (wants("global")) {
        for (const install of discovery.globals) {
            const planned = planGlobal(install, metadata, options);

            if ("kind" in planned) {
                notices.push(planned);
            } else {
                plans.push(planned);
            }
        }
    }

    if (wants("project") && discovery.project !== undefined) {
        const planned = planProject(discovery.project, metadata, options);

        if ("kind" in planned) {
            notices.push(planned);
        } else {
            plans.push(planned);
        }
    }

    notices.push(...runningNotices(discovery, metadata, options));

    if (options.only === "global" && discovery.globals.length === 0) {
        notices.push({
            kind: "not-found",
            scope: "global",
            message: `No global install of ${PACKAGE_NAME} was found with any package manager.`,
        });
    }

    if (options.only === "project" && discovery.project === undefined) {
        notices.push({
            kind: "not-found",
            scope: "project",
            message: `No project install of ${PACKAGE_NAME} was found in this directory or above it.`,
        });
    }

    return { plans, notices };
}

/** The plan for one global install, or the notice saying why there is none. */
function planGlobal(install: GlobalInstallInfo, metadata: RegistryMetadata, options: BuildUpdatePlansOptions): PlannedUpdate | UpdateNotice {
    if (semver.valid(install.installed) === null) {
        return unknownVersion("global", install.location, install.installed);
    }

    const choice = choose(install.installed, metadata, options);

    return {
        scope: "global",
        location: install.location,
        manager: install.manager.id,
        managerAssumed: false,
        installed: install.installed,
        target: choice.target,
        direction: choice.direction,
        command: install.manager.globalInstallCommand!([packageSpec(choice.target)]),
    };
}

/** The plan for the project install, or the notice saying why there is none. */
function planProject(install: ProjectInstallInfo, metadata: RegistryMetadata, options: BuildUpdatePlansOptions): PlannedUpdate | UpdateNotice {
    if (install.declared === undefined) {
        return {
            kind: "undeclared",
            scope: "project",
            location: install.location,
            message: `The project at ${install.projectRoot} has ${PACKAGE_NAME} in node_modules, but its package.json does not declare it, so sous leaves it alone.`,
        };
    }

    if (semver.valid(install.installed) === null) {
        return unknownVersion("project", install.location, install.installed);
    }

    const choice = choose(install.installed, metadata, options);

    if (!install.manager.supported) {
        return {
            kind: "unsupported-manager",
            scope: "project",
            location: install.location,
            message: `The project at ${install.projectRoot} uses a package manager that no loaded plugin drives, so it has to be updated by hand.`,
        };
    }

    const command = install.manager.entity.addCommand([packageSpec(choice.target)], {
        section: install.declared.section,
        workspaceRoot: install.workspaceRoot,
        cwd: install.projectRoot,
    });

    return {
        scope: "project",
        location: install.location,
        projectRoot: install.projectRoot,
        manager: install.manager.id,
        managerAssumed: !install.manager.detected,
        installed: install.installed,
        target: choice.target,
        direction: choice.direction,
        declaredIn: install.declared,
        command: { ...command, cwd: install.projectRoot },
        ...(install.pnpRoot === undefined ? {} : { pnpRoot: install.pnpRoot }),
    };
}

/**
 * The notices about the running copy when it is none of the installs planned: npx (always), and
 * Volta or an unknown location (global scope). Volta's command names the version the same request
 * chooses for the running copy.
 */
function runningNotices(discovery: InstallDiscovery, metadata: RegistryMetadata, options: BuildUpdatePlansOptions): UpdateNotice[] {
    const { running } = discovery;

    if (running.kind === "npx") {
        return [
            {
                kind: "npx",
                location: running.realPath,
                message: "This sous is running through npx, which is not an install: npx keeps its own cache, and no install sous updates changes it.",
            },
        ];
    }

    if (options.only === "project") {
        return [];
    }

    if (running.kind === "volta") {
        const notice: UpdateNotice = {
            kind: "volta",
            scope: "global",
            location: running.realPath,
            message: "This sous is managed by Volta, which sous does not drive, so Volta has to update it.",
        };

        if (semver.valid(running.installed) !== null) {
            const { target } = choose(running.installed, metadata, options);

            return [{ ...notice, manualCommand: { command: "volta", args: ["install", packageSpec(target)] } }];
        }

        return [notice];
    }

    if (running.kind === "unknown") {
        return [
            {
                kind: "unknown-location",
                scope: "global",
                location: running.realPath,
                message: "This sous is not the project install or a global install of a package manager sous drives (it may be a source checkout), so sous does not update it.",
            },
        ];
    }

    return [];
}

/** Chooses a version for one install. */
function choose(installed: string, metadata: RegistryMetadata, options: BuildUpdatePlansOptions) {
    return chooseVersion({
        current: installed,
        versions: metadata.versions,
        distTags: metadata.distTags,
        request: options.request,
        ...(options.prerelease === undefined ? {} : { prerelease: options.prerelease }),
    });
}

/** The notice for a copy whose version cannot be compared. */
function unknownVersion(scope: InstallScope, location: string, installed: string): UpdateNotice {
    return {
        kind: "unknown-version",
        scope,
        location,
        message: `The ${scope} install at ${location} names its version as "${installed}", which sous cannot compare with the published versions, so it has to be updated by hand.`,
    };
}
