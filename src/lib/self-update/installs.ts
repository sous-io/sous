/**
 * Finds every copy of sous an update could move: the project's own install,
 * each global install, and the copy that is running now.
 *
 * Discovery only reads. The package managers are asked through an injectable
 * command runner (capturing output, never installing anything), and the
 * project's manager is read from its files by package-manager-detector, so a
 * test drives every case with a fake runner and a temporary directory.
 */

import fs from "node:fs";
import path from "node:path";
import { detect } from "package-manager-detector/detect";
import {
  PACKAGE_NAME,
  findProjectCopy,
  readPackageJson,
  realpathOr,
} from "../project-install.mjs";
import { spawnCommand, type CommandRunner } from "../repos/providers/git.js";
import {
  GLOBAL_MANAGERS,
  isProjectManager,
  type DependencySection,
  type GlobalManager,
  type ProjectManager,
} from "./managers.js";

/** The version reported for a copy whose package.json names none. */
export const UNKNOWN_VERSION = "unknown";

/** How the project's package.json declares sous. */
export type DeclaredDependency = {
  section: DependencySection;
  /** The range as written, for example `0.2.18` or `^0.2.18`. */
  range: string;
};

/**
 * Which manager owns a project, as far as its files say.
 *
 * - `supported: true`: a manager sous drives. `detected` is false when the
 *   project's files named none and npm is assumed, which the plan says.
 * - `supported: false`: a manager package-manager-detector recognized that
 *   sous does not drive (`bun`, `deno`, `pnpm-rush`, ...), named by its agent.
 */
export type ProjectManagerInfo =
  | { supported: true; agent: ProjectManager; detected: boolean }
  | { supported: false; agent: string };

/** The project's own install of sous. */
export type ProjectInstallInfo = {
  /**
   * The directory holding the project's package.json: the one holding the
   * `node_modules` the copy is in, or under Yarn Plug'n'Play the nearest one
   * that declares the package.
   */
  projectRoot: string;
  /**
   * The copy's path under `node_modules`, as found (not resolved through
   * links), or under Yarn Plug'n'Play the `.pnp.cjs` file that maps it, since
   * the package itself stays in Yarn's cache.
   */
  location: string;
  /** The copy's real path, which is what is compared with other copies. */
  realPath: string;
  /**
   * The version in the copy's package.json (under Yarn Plug'n'Play, the one
   * `yarn.lock` resolves the declared range to), or `UNKNOWN_VERSION`.
   */
  installed: string;
  /** How package.json declares sous; undefined when it is installed but not declared. */
  declared?: DeclaredDependency;
  manager: ProjectManagerInfo;
  /** Whether the project is a workspace root, as its manager reads one. */
  workspaceRoot: boolean;
  /**
   * Set only when the project uses Yarn Plug'n'Play: the directory holding
   * `.pnp.cjs` and `yarn.lock` (the project root, or its workspace's root).
   */
  pnpRoot?: string;
};

/** One global install of sous, and the manager whose global root holds it. */
export type GlobalInstallInfo = {
  manager: GlobalManager;
  /** The copy's path under the manager's global root, as found. */
  location: string;
  /** The copy's real path. */
  realPath: string;
  /** The version in the copy's package.json, or `UNKNOWN_VERSION`. */
  installed: string;
};

/**
 * What the running copy is.
 *
 * - `project` / `global`: one of the installs found (`global` names its manager).
 * - `npx`: a copy in npx's cache, which no install updates.
 * - `volta`: a copy Volta manages, which only Volta updates.
 * - `unknown`: anywhere else, such as a source checkout.
 */
export type RunningInstall = {
  kind: "project" | "global" | "npx" | "volta" | "unknown";
  /** The global manager, set only when `kind` is `global`. */
  manager?: GlobalManager;
  /** The running copy's real path. */
  realPath: string;
  /** The version in the running copy's package.json, or `UNKNOWN_VERSION`. */
  installed: string;
};

/** Everything discovery found. */
export type InstallDiscovery = {
  /** The project's own install, when the working directory is inside a project that has one. */
  project?: ProjectInstallInfo;
  /** Every global install found, one per manager whose global root holds a copy. */
  globals: GlobalInstallInfo[];
  running: RunningInstall;
};

/** Options for `discoverInstalls`. */
export type DiscoverInstallsOptions = {
  /** Where the project lookup starts. */
  cwd: string;
  /** The package root of the running copy. */
  ownRoot: string;
  /** How the managers are asked for their global roots. Defaults to spawning them. */
  run?: CommandRunner;
};

/**
 * Finds the project install, the global installs and what the running copy is.
 * No step fails the run: a manager that is not installed or cannot answer is
 * skipped, and a copy whose package.json is unreadable is left out.
 */
export async function discoverInstalls(options: DiscoverInstallsOptions): Promise<InstallDiscovery> {
  const run = options.run ?? spawnCommand;
  const project = await findProjectInstallInfo(options.cwd);
  const globals = await findGlobalInstalls(run);
  const running = classifyRunning(options.ownRoot, project, globals);
  return project === undefined ? { globals, running } : { project, globals, running };
}

/**
 * The project install nearest `cwd`: the copy the hand-off finds
 * (`findProjectCopy`), and when there is none, a Yarn Plug'n'Play project
 * that declares the package (`findPnpInstall`). Undefined when there is
 * neither, or the `node_modules` copy found is some other package.
 */
export async function findProjectInstallInfo(cwd: string): Promise<ProjectInstallInfo | undefined> {
  const location = findProjectCopy(cwd);
  if (location === undefined) return findPnpInstall(cwd);
  const copy = readPackageJson(location);
  if (copy?.name !== PACKAGE_NAME) return undefined;

  // <projectRoot>/node_modules/@sous-io/sous
  const projectRoot = path.resolve(location, "..", "..", "..");
  return describeProject(projectRoot, await projectManager(projectRoot), {
    location,
    realPath: realpathOr(location),
    installed: versionOf(copy),
  });
}

/** The file Yarn Plug'n'Play writes in place of `node_modules`. */
export const PNP_FILE = ".pnp.cjs";

/**
 * A Yarn Plug'n'Play install, which has no `node_modules` copy to find: the
 * nearest package.json at or above `cwd` that declares the package, with a
 * `.pnp.cjs` in its directory or above it. The version is the one `yarn.lock`
 * (beside `.pnp.cjs`) resolves the declared range to, and the manager is Yarn
 * Berry, the only Yarn that writes `.pnp.cjs`. Undefined when either is missing.
 */
export function findPnpInstall(cwd: string): ProjectInstallInfo | undefined {
  const projectRoot = findUp(cwd, (dir) => declaredDependency(readPackageJson(dir)) !== undefined);
  if (projectRoot === undefined) return undefined;
  const pnpRoot = findUp(projectRoot, (dir) => fs.existsSync(path.join(dir, PNP_FILE)));
  if (pnpRoot === undefined) return undefined;

  const range = declaredDependency(readPackageJson(projectRoot))?.range ?? "";
  let lockfile = "";
  try {
    lockfile = fs.readFileSync(path.join(pnpRoot, "yarn.lock"), "utf8");
  } catch {
    // No lockfile: the version is unknown, and the plan says so.
  }
  const location = path.join(pnpRoot, PNP_FILE);
  const info = describeProject(
    projectRoot,
    { supported: true, agent: "yarn@berry", detected: true },
    {
      location,
      realPath: realpathOr(location),
      installed: yarnLockVersion(lockfile, range) ?? UNKNOWN_VERSION,
    }
  );
  info.pnpRoot = pnpRoot;
  return info;
}

/**
 * The version a Yarn Berry `yarn.lock` resolves the package's declared
 * `range` to. Each entry opens with an unindented key listing the
 * descriptors it answers (`"@sous-io/sous@npm:0.2.28, @sous-io/sous@npm:^0.2.0":`)
 * and holds an indented `version:` line. The entry whose key names the range
 * wins; when none does and the lockfile holds exactly one version of the
 * package, that version is the answer. Undefined otherwise.
 *
 * yarnLockVersion('"@sous-io/sous@npm:0.2.28":\n  version: 0.2.28\n', "0.2.28") -> "0.2.28"
 */
export function yarnLockVersion(lockfile: string, range: string): string | undefined {
  const prefix = `${PACKAGE_NAME}@`;
  const wanted = new Set([`${prefix}${range}`, `${prefix}npm:${range}`]);
  const entries: { descriptors: string[]; version?: string }[] = [];
  let entry: { descriptors: string[]; version?: string } | undefined;
  for (const line of lockfile.split(/\r?\n/)) {
    if (/^[^\s#].*:$/.test(line)) {
      const descriptors = line
        .slice(0, -1)
        .split(",")
        .map((part) => part.trim().replace(/^"|"$/g, ""))
        .filter((descriptor) => descriptor.startsWith(prefix));
      entry = descriptors.length > 0 ? { descriptors } : undefined;
      if (entry !== undefined) entries.push(entry);
      continue;
    }
    const version = /^\s+version:\s*"?([^"\s]+)"?\s*$/.exec(line);
    if (entry !== undefined && version !== null && entry.version === undefined) {
      entry.version = version[1];
    }
  }
  const exact = entries.find((candidate) => candidate.descriptors.some((d) => wanted.has(d)));
  if (exact !== undefined) return exact.version;
  const versions = new Set(entries.flatMap((candidate) => candidate.version ?? []));
  return versions.size === 1 ? [...versions][0] : undefined;
}

/** A project install, from its root, its manager and the facts about its copy. */
function describeProject(
  projectRoot: string,
  manager: ProjectManagerInfo,
  copy: { location: string; realPath: string; installed: string }
): ProjectInstallInfo {
  const pkg = readPackageJson(projectRoot);
  const declared = declaredDependency(pkg);
  const info: ProjectInstallInfo = {
    projectRoot,
    ...copy,
    manager,
    workspaceRoot: isWorkspaceRoot(manager.agent, projectRoot, pkg),
  };
  if (declared !== undefined) info.declared = declared;
  return info;
}

/** The nearest directory at or above `start` that `test` accepts, or undefined. */
function findUp(start: string, test: (dir: string) => boolean): string | undefined {
  let dir = path.resolve(start);
  for (;;) {
    if (test(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * How a package.json declares sous: `devDependencies` first, then
 * `dependencies`; undefined when neither names it.
 */
export function declaredDependency(pkg: unknown): DeclaredDependency | undefined {
  if (pkg === null || typeof pkg !== "object") return undefined;
  for (const section of ["devDependencies", "dependencies"] as const) {
    const block = (pkg as Record<string, unknown>)[section];
    if (block === null || typeof block !== "object") continue;
    const range = (block as Record<string, unknown>)[PACKAGE_NAME];
    if (typeof range === "string") return { section, range };
  }
  return undefined;
}

/**
 * Which manager owns the project at `projectRoot`, read by
 * package-manager-detector from that directory alone (its `packageManager`
 * and `devEngines` fields and its lockfile). Nothing found means npm, marked
 * as not detected.
 *
 * Two corrections are made on top: a `yarn` answer from a lockfile is Yarn
 * Berry when the project has a `.yarnrc.yml` or its `yarn.lock` carries Berry's
 * `__metadata` header (the detector reads a lockfile as classic unless the
 * `packageManager` field says otherwise), and `pnpm@6` is plain pnpm, whose
 * `add` flags have not changed.
 */
export async function projectManager(projectRoot: string): Promise<ProjectManagerInfo> {
  const found = await detect({ cwd: projectRoot, stopDir: projectRoot });
  if (found === null) return { supported: true, agent: "npm", detected: false };
  let agent: string = found.agent;
  if (agent === "yarn" && isYarnBerryProject(projectRoot)) agent = "yarn@berry";
  if (agent === "pnpm@6") agent = "pnpm";
  return isProjectManager(agent)
    ? { supported: true, agent, detected: true }
    : { supported: false, agent };
}

/** Whether the files at `projectRoot` are Yarn Berry's rather than Yarn classic's. */
function isYarnBerryProject(projectRoot: string): boolean {
  if (fs.existsSync(path.join(projectRoot, ".yarnrc.yml"))) return true;
  try {
    return /^__metadata:/m.test(fs.readFileSync(path.join(projectRoot, "yarn.lock"), "utf8"));
  } catch {
    return false;
  }
}

/**
 * Whether `projectRoot` is a workspace root in the sense its manager needs a
 * flag for: pnpm, when it holds a `pnpm-workspace.yaml`; Yarn classic, when
 * its package.json has `workspaces`. Every other manager reads as false.
 */
export function isWorkspaceRoot(agent: string, projectRoot: string, pkg: unknown): boolean {
  if (agent === "pnpm") return fs.existsSync(path.join(projectRoot, "pnpm-workspace.yaml"));
  if (agent === "yarn") {
    return pkg !== null && typeof pkg === "object" && "workspaces" in pkg;
  }
  return false;
}

/** The command that prints each global manager's global `node_modules`, and how to read it. */
const GLOBAL_ROOT_QUERIES: Record<GlobalManager, { args: string[]; suffix?: string }> = {
  npm: { args: ["root", "-g"] },
  pnpm: { args: ["root", "-g"] },
  // `yarn global dir` prints the directory ABOVE its node_modules.
  yarn: { args: ["global", "dir"], suffix: "node_modules" },
};

/**
 * Asks each global manager where its global `node_modules` is, and returns a
 * global install for each one that holds a copy of the package. A manager that
 * is not installed (exit 127), exits non-zero or prints nothing is skipped. Two
 * managers naming the same copy (by real path) count once, under the first.
 */
export async function findGlobalInstalls(run: CommandRunner): Promise<GlobalInstallInfo[]> {
  const installs: GlobalInstallInfo[] = [];
  for (const manager of GLOBAL_MANAGERS) {
    const root = await globalRoot(manager, run);
    if (root === undefined) continue;
    const location = path.join(root, ...PACKAGE_NAME.split("/"));
    const pkg = readPackageJson(location);
    if (pkg?.name !== PACKAGE_NAME) continue;
    const realPath = realpathOr(location);
    if (installs.some((install) => install.realPath === realPath)) continue;
    installs.push({ manager, location, realPath, installed: versionOf(pkg) });
  }
  return installs;
}

/** One manager's global `node_modules`, or undefined when it cannot say. */
async function globalRoot(manager: GlobalManager, run: CommandRunner): Promise<string | undefined> {
  const query = GLOBAL_ROOT_QUERIES[manager];
  let output: string;
  try {
    const result = await run(manager, query.args, {});
    if (result.code !== 0) return undefined;
    output = result.stdout.trim().split(/\r?\n/).pop()?.trim() ?? "";
  } catch {
    return undefined;
  }
  if (output.length === 0) return undefined;
  return query.suffix === undefined ? output : path.join(output, query.suffix);
}

/**
 * What the running copy at `ownRoot` is: the project install or a global one
 * when its real path is theirs, otherwise read from where it lives.
 */
export function classifyRunning(
  ownRoot: string,
  project: ProjectInstallInfo | undefined,
  globals: readonly GlobalInstallInfo[]
): RunningInstall {
  const realPath = realpathOr(ownRoot);
  const pkg = readPackageJson(ownRoot);
  const installed = pkg === undefined ? UNKNOWN_VERSION : versionOf(pkg);
  if (project !== undefined && (project.realPath === realPath || isPnpCopy(project, realPath))) {
    return { kind: "project", realPath, installed };
  }
  const global = globals.find((install) => install.realPath === realPath);
  if (global !== undefined) return { kind: "global", manager: global.manager, realPath, installed };
  const slashed = realPath.split(path.sep).join("/");
  if (slashed.includes("/_npx/")) return { kind: "npx", realPath, installed };
  if (slashed.includes("/.volta/")) return { kind: "volta", realPath, installed };
  return { kind: "unknown", realPath, installed };
}

/**
 * Whether `realPath` is the Plug'n'Play project's own copy, unpacked by Yarn
 * into `<pnpRoot>/.yarn/unplugged/` (a copy still inside Yarn's zip cache
 * cannot run sous at all).
 */
function isPnpCopy(project: ProjectInstallInfo, realPath: string): boolean {
  if (project.pnpRoot === undefined) return false;
  const unplugged = path.join(realpathOr(project.pnpRoot), ".yarn", "unplugged");
  const relative = path.relative(unplugged, realPath);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/** The `version` a package.json names, or `UNKNOWN_VERSION`. */
function versionOf(pkg: Record<string, unknown>): string {
  return typeof pkg.version === "string" ? pkg.version : UNKNOWN_VERSION;
}
