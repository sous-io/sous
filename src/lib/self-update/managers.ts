/**
 * The command each package manager needs to install a version of sous.
 *
 * The commands come from package-manager-detector's table (`resolveCommand`),
 * so sous spells nothing a manager already publishes; this module adds the
 * flags an update needs on top (an exact pin, the dependency section, the
 * workspace root) and runs nothing.
 */

import { resolveCommand } from "package-manager-detector/commands";
import type { Agent } from "package-manager-detector";
import { PACKAGE_NAME } from "../project-install.mjs";

/** The managers that can update a project's own install. */
export const PROJECT_MANAGERS = ["npm", "pnpm", "yarn", "yarn@berry"] as const;

/** The managers that can update a global install (Yarn Berry has no global installs). */
export const GLOBAL_MANAGERS = ["npm", "pnpm", "yarn"] as const;

/** A manager that can update a project install; `yarn` is Yarn classic (1.x). */
export type ProjectManager = (typeof PROJECT_MANAGERS)[number];

/** A manager that can update a global install; `yarn` is Yarn classic (1.x). */
export type GlobalManager = (typeof GLOBAL_MANAGERS)[number];

/** A command and its arguments, not yet run. */
export type ManagerCommand = { command: string; args: string[] };

/** The section of package.json a project declares sous in. */
export type DependencySection = "devDependencies" | "dependencies";

/** Options for `projectAdd`. */
export type ProjectAddOptions = {
  /** The section the dependency is declared in; it stays there. */
  section: DependencySection;
  /**
   * Whether the project is a workspace root, as its manager reads one (see
   * `isWorkspaceRoot` in installs.ts). pnpm and Yarn classic then need a flag
   * to add a dependency there at all.
   */
  workspaceRoot: boolean;
};

/** Whether `agent` is one of `PROJECT_MANAGERS`. */
export function isProjectManager(agent: string): agent is ProjectManager {
  return (PROJECT_MANAGERS as readonly string[]).includes(agent);
}

/** Whether `agent` is one of `GLOBAL_MANAGERS`. */
export function isGlobalManager(agent: string): agent is GlobalManager {
  return (GLOBAL_MANAGERS as readonly string[]).includes(agent);
}

/**
 * The package spec an install names: `@sous-io/sous@<version>`.
 *
 * packageSpec("0.2.34") -> "@sous-io/sous@0.2.34"
 */
export function packageSpec(version: string): string {
  return `${PACKAGE_NAME}@${version}`;
}

/**
 * The command that installs `version` globally with `manager`.
 *
 * globalInstall("pnpm", "0.2.34")
 * // -> { command: "pnpm", args: ["add", "-g", "@sous-io/sous@0.2.34"] }
 */
export function globalInstall(manager: GlobalManager, version: string): ManagerCommand {
  return resolve(manager, "global", [packageSpec(version)]);
}

/**
 * The command that pins a project's dependency on sous to exactly `version`
 * and updates its lockfile, run in the project root.
 *
 * `-E` pins the exact version with every supported manager; `-D` is added only
 * for a devDependency, so a dependency declared under `dependencies` stays
 * there. At a workspace root, pnpm gets `-w` and Yarn classic `-W`; npm adds
 * to the root package.json when run there, and Yarn Berry needs no flag.
 *
 * projectAdd("pnpm", "0.2.34", { section: "devDependencies", workspaceRoot: true })
 * // -> { command: "pnpm", args: ["add", "-D", "-E", "-w", "@sous-io/sous@0.2.34"] }
 */
export function projectAdd(
  manager: ProjectManager,
  version: string,
  options: ProjectAddOptions
): ManagerCommand {
  const flags: string[] = [];
  if (options.section === "devDependencies") flags.push("-D");
  flags.push("-E");
  if (options.workspaceRoot) {
    if (manager === "pnpm") flags.push("-w");
    if (manager === "yarn") flags.push("-W");
  }
  return resolve(manager, "add", [...flags, packageSpec(version)]);
}

/**
 * The command a person would run by hand to pin a project's dependency with a
 * manager sous does not drive (bun, deno), or undefined when
 * package-manager-detector knows no `add` command for it.
 */
export function manualProjectAdd(
  agent: string,
  version: string,
  section: DependencySection
): ManagerCommand | undefined {
  const flags = section === "devDependencies" ? ["-D"] : [];
  try {
    return resolveCommand(agent as Agent, "add", [...flags, packageSpec(version)]) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Resolves a command the table is known to hold for every supported manager. */
function resolve(agent: Agent, command: "add" | "global", args: string[]): ManagerCommand {
  const resolved = resolveCommand(agent, command, args);
  /* c8 ignore next 3 */
  if (resolved === null) {
    throw new Error(`package-manager-detector has no '${command}' command for ${agent}.`);
  }
  return { command: resolved.command, args: resolved.args };
}
