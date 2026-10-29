/**
 * The `package-manager` entity for Yarn, Classic and Berry: it only describes and plans.
 * plugin-update runs every command it plans, through `host.processes`.
 */

import fs from "node:fs";
import path from "node:path";
import type { ServiceContext } from "@sous-io/plugin-api";
import type {
    AddOptions,
    InstalledPackage,
    InstallScope,
    PackageManagerDetection,
    PlannedCommand,
} from "@sous-io/plugin-update/types";
import type { YarnPackageManager, YarnPluginOptions } from "./types.js";
import { findUp, lastLine, packageManagerField, packageManagerName, readInstalled, readPackageJson } from "./node-modules.js";
import { PNP_FILE, findPnpFile, pnpInstalled } from "./pnp.js";

/** The name of this plugin, whose options say which command to run. */
const PLUGIN = "@sous-io/plugin-yarn";

/** The command to run: the `command` option, or `yarn`. */
function commandOf(ctx: ServiceContext): string {
    return ctx.config.get<YarnPluginOptions>(["plugins", "options", PLUGIN])?.command ?? "yarn";
}

/** Whether a file exists in a directory. */
function has(dir: string, file: string): boolean {
    return fs.existsSync(path.join(dir, file));
}

/** Whether `package.json` declares workspaces. */
function hasWorkspaces(dir: string): boolean {
    const pkg = readPackageJson(dir);

    return pkg !== undefined && "workspaces" in pkg;
}

/**
 * Whether the files at `dir` are Yarn Berry's rather than Classic's: a `.yarnrc.yml`, a `.pnp.cjs`,
 * a `packageManager` field of Yarn 2 or later, or a `yarn.lock` with Berry's `__metadata` header
 * (Classic's lockfile has none).
 */
export function isBerry(dir: string): boolean {
    if (has(dir, ".yarnrc.yml") || has(dir, PNP_FILE)) return true;

    const version = packageManagerField(readPackageJson(dir), "yarn");

    if (version !== undefined) return !version.startsWith("1.");

    try {
        return /^__metadata:/m.test(fs.readFileSync(path.join(dir, "yarn.lock"), "utf8"));
    } catch {
        return false;
    }
}

/** The `package-manager` entity for Yarn. */
export const yarnManager: YarnPackageManager = {
    id: "yarn",
    description: "Yarn, Classic (1.x) and Berry (2 and later), with Plug'n'Play.",

    async detect(projectRoot): Promise<PackageManagerDetection | undefined> {
        const pkg = readPackageJson(projectRoot);

        if (packageManagerName(pkg) !== "yarn" && !has(projectRoot, "yarn.lock") && !has(projectRoot, ".yarnrc.yml") && !has(projectRoot, PNP_FILE)) {
            return undefined;
        }

        const version = packageManagerField(pkg, "yarn");
        const workspaceRoot = findUp(projectRoot, hasWorkspaces);
        const pnpFile = findPnpFile(projectRoot);

        return {
            id: isBerry(projectRoot) ? "yarn@berry" : "yarn",
            detected: true,
            ...(version === undefined ? {} : { version }),
            ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
            ...(pnpFile === undefined ? {} : { pnpRoot: path.dirname(pnpFile) }),
        };
    },

    async installed(scope: InstallScope, projectRoot, ctx): Promise<InstalledPackage[]> {
        if (scope === "project") {
            if (projectRoot === undefined) return [];

            // Under Plug'n'Play there is no node_modules to read.
            if (findPnpFile(projectRoot) !== undefined && !has(projectRoot, "node_modules")) return pnpInstalled(projectRoot);

            return readInstalled(path.join(projectRoot, "node_modules"), readPackageJson(projectRoot));
        }

        const root = await yarnManager.globalRoot?.(ctx);

        return root === undefined ? [] : readInstalled(root);
    },

    async globalRoot(ctx) {
        try {
            const result = await ctx.services.get("host.processes").run(commandOf(ctx), ["global", "dir"], { label: "yarn global dir" });
            // `yarn global dir` prints the directory above its node_modules; Berry has no such command.
            const dir = result.exitCode === 0 ? lastLine(result.stdout) : undefined;

            return dir === undefined ? undefined : path.join(dir, "node_modules");
        } catch {
            return undefined;
        }
    },

    addCommand(specs, options: AddOptions): PlannedCommand {
        // `-E` pins what is named. Classic needs `-W` to add at a workspace root; Berry needs no flag.
        const classicRoot = options.workspaceRoot && !isBerry(options.cwd);
        const flags = [...(options.section === "devDependencies" ? ["-D"] : []), "-E", ...(classicRoot ? ["-W"] : [])];

        return { command: "yarn", args: ["add", ...flags, ...specs], cwd: options.cwd };
    },

    globalInstallCommand(specs): PlannedCommand {
        return { command: "yarn", args: ["global", "add", ...specs] };
    },
};
