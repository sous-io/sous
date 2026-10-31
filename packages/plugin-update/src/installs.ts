/**
 * Finds every copy of sous an update could move: the project's own install, each global install,
 * and the copy that is running now.
 *
 * Discovery only reads. The package-manager entities say which manager owns the project and list
 * what each has installed (they run nothing that installs); this module only decides which copy is
 * sous.
 */

import fs from "node:fs";
import path from "node:path";
import type { ServiceContext } from "@sous-io/plugin-api";
import type {
    DependencySection,
    InstalledPackage,
    PackageManagerDetection,
    PackageManagerEntity,
} from "./types.js";

/** The npm package name of sous. */
export const PACKAGE_NAME = "@sous-io/sous";

/** The version reported for a copy whose package.json names none. */
export const UNKNOWN_VERSION = "unknown";

/** How the project's package.json declares sous. */
export interface DeclaredDependency {
    section: DependencySection;
    /** The range as written, for example `0.2.18` or `^0.2.18`. */
    range: string;
}

/**
 * Which manager owns a project, as far as its files say.
 *
 * - `supported: true`: a package-manager entity claimed the project. `detected` is false when the
 *   project's files named none and the manager is assumed, which the plan says.
 * - `supported: false`: no package-manager entity claimed the project, so something else (Bun,
 *   Deno) owns it, and the update is left to a person.
 */
export type ProjectManagerInfo =
    | { supported: true; id: string; entity: PackageManagerEntity; detected: boolean; detection: PackageManagerDetection }
    | { supported: false };

/** The project's own install of sous. */
export interface ProjectInstallInfo {
    /** The directory holding the package.json whose `node_modules` holds the copy. */
    projectRoot: string;
    /** The copy's path, as found (not resolved through links). */
    location: string;
    /** The copy's real path, which is what is compared with other copies. */
    realPath: string;
    /** The version in the copy's package.json, or `UNKNOWN_VERSION`. */
    installed: string;
    /** How package.json declares sous; undefined when it is installed but not declared. */
    declared?: DeclaredDependency;
    manager: ProjectManagerInfo;
    /** Whether the project is the root of a workspace, which some managers need a flag for. */
    workspaceRoot: boolean;
    /** Set only when the project uses Yarn Plug'n'Play: the directory holding `.pnp.cjs`. */
    pnpRoot?: string;
}

/** One global install of sous, and the manager whose global root holds it. */
export interface GlobalInstallInfo {
    manager: PackageManagerEntity;
    location: string;
    realPath: string;
    installed: string;
}

/**
 * What the running copy is.
 *
 * - `project` / `global`: one of the installs found (`global` names its manager).
 * - `npx`: a copy in npx's cache, which no install updates.
 * - `volta`: a copy Volta manages, which only Volta updates.
 * - `unknown`: anywhere else, such as a source checkout.
 */
export interface RunningInstall {
    kind: "project" | "global" | "npx" | "volta" | "unknown";
    manager?: string;
    realPath: string;
    installed: string;
}

/** Everything discovery found. */
export interface InstallDiscovery {
    project?: ProjectInstallInfo;
    globals: GlobalInstallInfo[];
    running: RunningInstall;
}

/** Options for {@link discoverInstalls}. */
export interface DiscoverInstallsOptions {
    /** Where the project lookup starts. */
    cwd: string;
    /** The real path of the running copy's package root. */
    ownRoot: string;
}

/** Reads a directory's package.json, or `undefined`. */
export function readPackageJson(directory: string): Record<string, unknown> | undefined {
    try {
        const parsed: unknown = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"));

        return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : undefined;
    } catch {
        return undefined;
    }
}

/** A path with links followed, or the path itself when it cannot be. */
export function realpathOr(target: string): string {
    try {
        return fs.realpathSync(target);
    } catch {
        return target;
    }
}

/** The `version` a package.json names, or `UNKNOWN_VERSION`. */
function versionOf(pkg: Record<string, unknown> | undefined): string {
    return typeof pkg?.version === "string" ? pkg.version : UNKNOWN_VERSION;
}

/**
 * How a package.json declares sous: `devDependencies` first, then `dependencies`; undefined when
 * neither names it.
 */
export function declaredDependency(pkg: unknown): DeclaredDependency | undefined {
    if (pkg === null || typeof pkg !== "object") {
        return undefined;
    }

    for (const section of ["devDependencies", "dependencies"] as const) {
        const block = (pkg as Record<string, unknown>)[section];

        if (block === null || typeof block !== "object") {
            continue;
        }

        const range = (block as Record<string, unknown>)[PACKAGE_NAME];

        if (typeof range === "string") {
            return { section, range };
        }
    }

    return undefined;
}

/** The directories from `start` up to the filesystem root. */
function ancestors(start: string): string[] {
    const found: string[] = [];
    let directory = path.resolve(start);

    for (;;) {
        found.push(directory);

        const parent = path.dirname(directory);

        if (parent === directory) {
            return found;
        }

        directory = parent;
    }
}

/**
 * Finds the project install, the global installs and what the running copy is. No step fails the
 * run: a manager that cannot answer is skipped.
 */
export async function discoverInstalls(options: DiscoverInstallsOptions, ctx: ServiceContext): Promise<InstallDiscovery> {
    const managers = ctx.entities.list("package-manager");
    const project = await findProjectInstall(options.cwd, managers, ctx);
    const globals = await findGlobalInstalls(managers, ctx);

    return { ...(project === undefined ? {} : { project }), globals, running: classifyRunning(options.ownRoot, project, globals) };
}

/** Asks every manager whether it owns the project at a directory; the first sure answer wins. */
export async function ownerOf(
    directory: string,
    managers: readonly PackageManagerEntity[],
    ctx: ServiceContext,
): Promise<{ entity: PackageManagerEntity; detection: PackageManagerDetection } | undefined> {
    const answers: Array<{ entity: PackageManagerEntity; detection: PackageManagerDetection }> = [];

    for (const entity of managers) {
        try {
            const detection = await entity.detect(directory, ctx);

            if (detection !== undefined) {
                answers.push({ entity, detection });
            }
        } catch {
            // A manager that cannot answer does not own the project.
        }
    }

    return answers.find((answer) => answer.detection.detected) ?? answers[0];
}

/**
 * The project install nearest `cwd`: the first directory, walking up, whose owning manager lists
 * sous among its installed packages. When no manager owns a directory but `node_modules` holds
 * sous, the install is reported with an unsupported manager.
 */
export async function findProjectInstall(
    cwd: string,
    managers: readonly PackageManagerEntity[],
    ctx: ServiceContext,
): Promise<ProjectInstallInfo | undefined> {
    for (const directory of ancestors(cwd)) {
        const owner = await ownerOf(directory, managers, ctx);

        if (owner === undefined) {
            const location = path.join(directory, "node_modules", ...PACKAGE_NAME.split("/"));
            const copy = readPackageJson(location);

            if (copy?.name === PACKAGE_NAME) {
                return describeProject(directory, { supported: false }, { location, realPath: realpathOr(location), installed: versionOf(copy) });
            }

            continue;
        }

        let packages: InstalledPackage[];

        try {
            packages = await owner.entity.installed("project", directory, ctx);
        } catch {
            continue;
        }

        const found = packages.find((candidate) => candidate.name === PACKAGE_NAME);

        if (found === undefined) {
            continue;
        }

        const manager: ProjectManagerInfo = {
            supported: true,
            id: owner.detection.id,
            entity: owner.entity,
            detected: owner.detection.detected,
            detection: owner.detection,
        };

        return describeProject(directory, manager, { location: found.location, realPath: found.realPath, installed: found.version }, found);
    }

    return undefined;
}

/** A project install, from its root, its manager and the facts about its copy. */
function describeProject(
    projectRoot: string,
    manager: ProjectManagerInfo,
    copy: { location: string; realPath: string; installed: string },
    found?: InstalledPackage,
): ProjectInstallInfo {
    const declared = found?.declared ?? declaredDependency(readPackageJson(projectRoot));
    const detection = manager.supported ? manager.detection : undefined;
    const info: ProjectInstallInfo = {
        projectRoot,
        ...copy,
        manager,
        workspaceRoot: detection?.workspaceRoot !== undefined && realpathOr(detection.workspaceRoot) === realpathOr(projectRoot),
    };

    if (declared !== undefined) {
        info.declared = declared;
    }

    if (detection?.pnpRoot !== undefined) {
        info.pnpRoot = detection.pnpRoot;
    }

    return info;
}

/**
 * Asks each manager that can install globally what it has installed globally, and returns an
 * install for each one that holds sous. A manager that cannot answer is skipped. Two managers
 * naming the same copy (by real path) count once, under the first.
 */
export async function findGlobalInstalls(managers: readonly PackageManagerEntity[], ctx: ServiceContext): Promise<GlobalInstallInfo[]> {
    const installs: GlobalInstallInfo[] = [];

    for (const manager of managers) {
        if (manager.globalInstallCommand === undefined) {
            continue;
        }

        let packages: InstalledPackage[];

        try {
            packages = await manager.installed("global", undefined, ctx);
        } catch {
            continue;
        }

        const found = packages.find((candidate) => candidate.name === PACKAGE_NAME);

        if (found === undefined || installs.some((install) => install.realPath === found.realPath)) {
            continue;
        }

        installs.push({ manager, location: found.location, realPath: found.realPath, installed: found.version });
    }

    return installs;
}

/**
 * What the running copy at `ownRoot` is: the project install or a global one when its real path is
 * theirs, otherwise read from where it lives.
 */
export function classifyRunning(
    ownRoot: string,
    project: ProjectInstallInfo | undefined,
    globals: readonly GlobalInstallInfo[],
): RunningInstall {
    const realPath = realpathOr(ownRoot);
    const installed = versionOf(readPackageJson(ownRoot));

    if (project !== undefined && (project.realPath === realPath || isPnpCopy(project, realPath))) {
        return { kind: "project", realPath, installed };
    }

    const global = globals.find((install) => install.realPath === realPath);

    if (global !== undefined) {
        return { kind: "global", manager: global.manager.id, realPath, installed };
    }

    const slashed = realPath.split(path.sep).join("/");

    if (slashed.includes("/_npx/")) {
        return { kind: "npx", realPath, installed };
    }

    if (slashed.includes("/.volta/")) {
        return { kind: "volta", realPath, installed };
    }

    return { kind: "unknown", realPath, installed };
}

/**
 * Whether `realPath` is the Plug'n'Play project's own copy, unpacked by Yarn into
 * `<pnpRoot>/.yarn/unplugged/` (a copy still inside Yarn's zip cache cannot run sous at all).
 */
function isPnpCopy(project: ProjectInstallInfo, realPath: string): boolean {
    if (project.pnpRoot === undefined) {
        return false;
    }

    const relative = path.relative(path.join(realpathOr(project.pnpRoot), ".yarn", "unplugged"), realPath);

    return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}
