/**
 * The contract of plugin-update (S6, "Project setup and updates"): updating sous itself
 * (`sous update`), installing plugins a recipe requires (`plugins.install`, `--install-plugins`),
 * the `package-manager` entity, and the `update.scan` contributor, which adds installed plugins to
 * the `plugins` key when `plugins.discover` is `scan` (S1, "Loading"; C5).
 *
 * Package managers only describe and plan; plugin-update runs every command, through
 * `host.processes`. Other plugins import this file type-only.
 */

import type { ServiceContext } from "@sous-io/plugin-api";

/** Where a package is installed. */
export type InstallScope = "project" | "global";

/** The `package.json` section a dependency is in. */
export type DependencySection = "dependencies" | "devDependencies";

/** A command to run. */
export interface PlannedCommand {
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd?: string;
}

/** What a package manager found about a project. */
export interface PackageManagerDetection {
    /** The manager's id (`yarn@berry` for Yarn 2 and later, when it differs). */
    readonly id: string;
    /** True when a lockfile or `packageManager` field says so, false when assumed. */
    readonly detected: boolean;
    readonly version?: string;
    /** The workspace root, when the project is inside a workspace. */
    readonly workspaceRoot?: string;
    /** The Plug'n'Play root, for Yarn PnP. */
    readonly pnpRoot?: string;
}

/** One installed package. */
export interface InstalledPackage {
    readonly name: string;
    readonly version: string;
    /** Its directory (or, under Plug'n'Play, its virtual location). */
    readonly location: string;
    /** Its real path, links followed. */
    readonly realPath: string;
    /** Whether it declares itself a sous plugin (`keywords` holds `sous-plugin`, or it exports a plugin). */
    readonly isSousPlugin: boolean;
    readonly declared?: { readonly section: DependencySection; readonly range: string };
}

/** How to add a package to a project. */
export interface AddOptions {
    readonly section: DependencySection;
    /** True when the project is a workspace root, for managers that need a flag for that. */
    readonly workspaceRoot: boolean;
    readonly cwd: string;
}

/** A `package-manager` entity: detecting one, listing installed packages, planning installs. */
export interface PackageManagerEntity {
    /** `npm`, `pnpm`, `yarn`. */
    id: string;
    description?: string;
    /** Whether it manages the project at a root; `undefined` when not. */
    detect(projectRoot: string, ctx: ServiceContext): Promise<PackageManagerDetection | undefined>;
    /** The packages installed in a project, or globally. */
    installed(scope: InstallScope, projectRoot: string | undefined, ctx: ServiceContext): Promise<InstalledPackage[]>;
    /** Where its global packages live, when it has any. */
    globalRoot?(ctx: ServiceContext): Promise<string | undefined>;
    /** The command that adds packages (`name@range`) to a project. */
    addCommand(specs: readonly string[], options: AddOptions): PlannedCommand;
    /** The command that installs packages globally. */
    globalInstallCommand?(specs: readonly string[]): PlannedCommand;
}

/** Which version an update moves to. */
export type VersionDirection = "upgrade" | "downgrade" | "current";

/** One install an update changes. */
export interface UpdatePlan {
    readonly scope: InstallScope;
    readonly location: string;
    readonly projectRoot?: string;
    readonly manager: string;
    readonly managerAssumed: boolean;
    readonly installed: string;
    readonly target: string;
    readonly direction: VersionDirection;
    readonly declaredIn?: { readonly section: DependencySection; readonly range: string };
    readonly command: PlannedCommand;
}

/** Something an update could not do itself, and how to do it by hand. */
export interface UpdateNotice {
    readonly kind: "npx" | "volta" | "unknown-location" | "undeclared" | "unsupported-manager" | "unknown-version" | "not-found";
    readonly scope?: InstallScope;
    readonly location?: string;
    readonly message: string;
    readonly manualCommand?: PlannedCommand;
}

/** `update`: updates sous itself. */
export interface UpdateInput {
    /** Allows a new major version. */
    major?: boolean;
    /** An exact version or range. */
    version?: string;
    /** Allows prereleases (`--prerelease`, `--pre`). */
    prerelease?: boolean;
    /** Only the global install. */
    global?: boolean;
    /** Only the project's install. */
    project?: boolean;
    yes?: boolean;
    dryRun?: boolean;
    noBuild?: boolean;
}

/** What happened to one planned install. */
export interface UpdateOutcome {
    readonly plan: UpdatePlan;
    readonly result: "updated" | "failed" | "declined" | "current" | "planned";
    readonly exitCode?: number;
}

/** The result of `update`. */
export interface UpdateResult {
    readonly outcomes: readonly UpdateOutcome[];
    readonly notices: readonly UpdateNotice[];
    readonly build?: { readonly result: "built" | "failed" | "skipped" | "no-config" | "no-bin"; readonly directory?: string; readonly exitCode?: number };
    readonly failed: boolean;
}

/** `plugins.install`: installs npm plugins through the project's package manager. */
export interface PluginsInstallInput {
    /** Plugins to install, as `name` or `name@range`. */
    plugins: string[];
    /** Default `devDependencies`. */
    section?: DependencySection;
    /** Installs without asking. */
    yes?: boolean;
    dryRun?: boolean;
}

/** The result of `plugins.install`. */
export interface PluginsInstallResult {
    readonly manager: string;
    readonly command: PlannedCommand;
    readonly installed: ReadonlyArray<{ readonly name: string; readonly range: string }>;
    readonly exitCode?: number;
    readonly declined: boolean;
    readonly dryRun: boolean;
}

declare module "@sous-io/plugin-api" {
    interface SousIntents {
        update: { input: UpdateInput; result: UpdateResult };
        "plugins.install": { input: PluginsInstallInput; result: PluginsInstallResult };
    }

    interface SousEntities {
        /** A package manager. */
        "package-manager": PackageManagerEntity;
    }
}
