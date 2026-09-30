/**
 * The plan an update carries out: for each install, the version it moves to
 * and the exact command that moves it, plus a notice for every copy sous
 * found and cannot act on.
 *
 * Planning has no side effects. What `buildUpdatePlans` returns is exactly
 * what a dry run prints and what a real run executes, one confirmation per
 * plan (sous-io/sous#135).
 */

import { PACKAGE_NAME } from "../project-install.mjs";
import type { GlobalInstallInfo, InstallDiscovery, ProjectInstallInfo } from "./installs.js";
import {
  globalInstall,
  manualProjectAdd,
  packageSpec,
  projectAdd,
  type DependencySection,
} from "./managers.js";
import semver from "semver";
import {
  chooseVersion,
  type RegistryMetadata,
  type VersionDirection,
  type VersionRequest,
} from "./versions.js";

/** Which install a plan or a notice is about. */
export type UpdateScope = "global" | "project";

/** A command to run, where to run it, and nothing run yet. */
export type PlannedCommand = {
  command: string;
  args: string[];
  /** The directory to run it in; undefined for a global install, which runs anywhere. */
  cwd?: string;
};

/** One install, and what an update does to it. */
export type UpdatePlan = {
  scope: UpdateScope;
  /** The copy's path: the global package directory, or the project's `node_modules` copy. */
  location: string;
  /** The project root; set only for a project plan. */
  projectRoot?: string;
  /**
   * Set only for a project that uses Yarn Plug'n'Play: the directory holding
   * its `.pnp.cjs`. `location` is then that file, and the build runs through Yarn.
   */
  pnpRoot?: string;
  /** The package manager that runs `command` (`npm`, `pnpm`, `yarn`, `yarn@berry`). */
  manager: string;
  /**
   * True when the project's files named no manager and npm is assumed; the
   * plan should say so. Always false for a global plan.
   */
  managerAssumed: boolean;
  /** The version installed now. */
  installed: string;
  /** The version the update installs; equal to `installed` when `direction` is `current`. */
  target: string;
  /** `current` means there is nothing to do: report it and ask nothing. */
  direction: VersionDirection;
  /** How the project's package.json declares sous; set only for a project plan. */
  declaredIn?: { section: DependencySection; range: string };
  /** What installs `target`. Present for a `current` plan too, and not to be run then. */
  command: PlannedCommand;
};

/**
 * Why a copy was found and not planned.
 *
 * - `npx`: the running copy is in npx's cache, which no install updates.
 * - `volta`: the running copy is managed by Volta; `manualCommand` is Volta's.
 * - `unknown-location`: the running copy is none of the installs (a source checkout, say).
 * - `undeclared`: the project has the package in `node_modules` but its package.json does not name it.
 * - `unsupported-manager`: the project's manager is one sous does not drive;
 *   `manualCommand` is that manager's own, when known.
 * - `unknown-version`: the copy's package.json names no version sous can compare.
 * - `not-found`: the run was narrowed to a scope that has no install.
 */
export type UpdateNoticeKind =
  | "npx"
  | "volta"
  | "unknown-location"
  | "undeclared"
  | "unsupported-manager"
  | "unknown-version"
  | "not-found";

/** A copy sous will not act on, with the facts and one plain sentence saying why. */
export type UpdateNotice = {
  kind: UpdateNoticeKind;
  /** The install the notice is about; undefined for one about the running copy as a whole (npx). */
  scope?: UpdateScope;
  /** The copy's path, when the notice is about one copy. */
  location?: string;
  /** A complete sentence saying what was found and why nothing is done to it. */
  message: string;
  /** The command a person would run by hand, when there is one; run in `cwd` when set. */
  manualCommand?: PlannedCommand;
};

/** Every plan and every notice. */
export type UpdatePlanSet = {
  /** Global plans first, then the project plan. */
  plans: UpdatePlan[];
  notices: UpdateNotice[];
};

/** Options for `buildUpdatePlans`. */
export type BuildUpdatePlansOptions = {
  request: VersionRequest;
  /** Whether prereleases count; undefined means "on when the installed version is a prerelease", per install. */
  prerelease?: boolean;
  /** Plan only this scope (`--global` or `--project`); undefined plans both. */
  only?: UpdateScope;
};

/**
 * Works out every plan and every notice, one install at a time, each judged on
 * its own installed version.
 *
 * @throws ConfigError when a `spec` request matches nothing for an install
 *   (from `chooseVersion`).
 */
export function buildUpdatePlans(
  discovery: InstallDiscovery,
  metadata: RegistryMetadata,
  options: BuildUpdatePlansOptions
): UpdatePlanSet {
  const plans: UpdatePlan[] = [];
  const notices: UpdateNotice[] = [];
  const wants = (scope: UpdateScope): boolean => options.only === undefined || options.only === scope;

  if (wants("global")) {
    for (const install of discovery.globals) {
      const planned = planGlobal(install, metadata, options);
      if ("kind" in planned) notices.push(planned);
      else plans.push(planned);
    }
  }
  if (wants("project") && discovery.project !== undefined) {
    const planned = planProject(discovery.project, metadata, options);
    if ("kind" in planned) notices.push(planned);
    else plans.push(planned);
  }

  notices.push(...runningNotices(discovery, metadata, options));

  if (options.only === "global" && discovery.globals.length === 0) {
    notices.push({
      kind: "not-found",
      scope: "global",
      message: `No global install of ${PACKAGE_NAME} was found with npm, pnpm or Yarn.`,
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
function planGlobal(
  install: GlobalInstallInfo,
  metadata: RegistryMetadata,
  options: BuildUpdatePlansOptions
): UpdatePlan | UpdateNotice {
  if (semver.valid(install.installed) === null) {
    return unknownVersion("global", install.location, install.installed);
  }
  const choice = choose(install.installed, metadata, options);
  return {
    scope: "global",
    location: install.location,
    manager: install.manager,
    managerAssumed: false,
    installed: install.installed,
    target: choice.target,
    direction: choice.direction,
    command: globalInstall(install.manager, choice.target),
  };
}

/** The plan for the project install, or the notice saying why there is none. */
function planProject(
  install: ProjectInstallInfo,
  metadata: RegistryMetadata,
  options: BuildUpdatePlansOptions
): UpdatePlan | UpdateNotice {
  if (install.declared === undefined) {
    return {
      kind: "undeclared",
      scope: "project",
      location: install.location,
      message:
        `The project at ${install.projectRoot} has ${PACKAGE_NAME} in node_modules, ` +
        "but its package.json does not declare it, so sous leaves it alone.",
    };
  }
  if (semver.valid(install.installed) === null) {
    return unknownVersion("project", install.location, install.installed);
  }
  const choice = choose(install.installed, metadata, options);
  if (!install.manager.supported) {
    const notice: UpdateNotice = {
      kind: "unsupported-manager",
      scope: "project",
      location: install.location,
      message:
        `The project at ${install.projectRoot} uses ${install.manager.agent}, ` +
        "which sous does not drive, so it has to be updated by hand.",
    };
    const manual = manualProjectAdd(install.manager.agent, choice.target, install.declared.section);
    if (manual !== undefined) notice.manualCommand = { ...manual, cwd: install.projectRoot };
    return notice;
  }
  const command = projectAdd(install.manager.agent, choice.target, {
    section: install.declared.section,
    workspaceRoot: install.workspaceRoot,
  });
  const plan: UpdatePlan = {
    scope: "project",
    location: install.location,
    projectRoot: install.projectRoot,
    manager: install.manager.agent,
    managerAssumed: !install.manager.detected,
    installed: install.installed,
    target: choice.target,
    direction: choice.direction,
    declaredIn: install.declared,
    command: { ...command, cwd: install.projectRoot },
  };
  if (install.pnpRoot !== undefined) plan.pnpRoot = install.pnpRoot;
  return plan;
}

/**
 * The notices about the running copy when it is none of the installs planned:
 * npx (always), and Volta or an unknown location (global scope). Volta's
 * command names the version the same request chooses for the running copy.
 */
function runningNotices(
  discovery: InstallDiscovery,
  metadata: RegistryMetadata,
  options: BuildUpdatePlansOptions
): UpdateNotice[] {
  const { running } = discovery;
  if (running.kind === "npx") {
    return [
      {
        kind: "npx",
        location: running.realPath,
        message:
          "This sous is running through npx, which is not an install: " +
          "npx keeps its own cache, and no install sous updates changes it.",
      },
    ];
  }
  if (options.only === "project") return [];
  if (running.kind === "volta") {
    const notice: UpdateNotice = {
      kind: "volta",
      scope: "global",
      location: running.realPath,
      message: "This sous is managed by Volta, which sous does not drive, so Volta has to update it.",
    };
    if (semver.valid(running.installed) !== null) {
      const { target } = choose(running.installed, metadata, options);
      notice.manualCommand = { command: "volta", args: ["install", packageSpec(target)] };
    }
    return [notice];
  }
  if (running.kind === "unknown") {
    return [
      {
        kind: "unknown-location",
        scope: "global",
        location: running.realPath,
        message:
          "This sous is not the project install or a global install of npm, pnpm or Yarn " +
          "(it may be a source checkout), so sous does not update it.",
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
function unknownVersion(scope: UpdateScope, location: string, installed: string): UpdateNotice {
  return {
    kind: "unknown-version",
    scope,
    location,
    message:
      `The ${scope} install at ${location} names its version as "${installed}", ` +
      "which sous cannot compare with the published versions, so it has to be updated by hand.",
  };
}
