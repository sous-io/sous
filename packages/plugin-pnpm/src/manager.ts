/**
 * The `package-manager` entity for pnpm: it only describes and plans. plugin-update runs every
 * command it plans, through `host.processes`.
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
import type { PnpmPackageManager, PnpmPluginOptions } from "./types.js";
import { findUp, lastLine, packageManagerField, packageManagerName, readInstalled, readPackageJson } from "./node-modules.js";

/** The name of this plugin, whose options say which command to run. */
const PLUGIN = "@sous-io/plugin-pnpm";

/** The file that makes a directory a pnpm workspace root. */
const WORKSPACE_FILE = "pnpm-workspace.yaml";

/** The command to run: the `command` option, or `pnpm`. */
function commandOf(ctx: ServiceContext): string {
    return ctx.config.get<PnpmPluginOptions>(["plugins", "options", PLUGIN])?.command ?? "pnpm";
}

/** Whether a file exists in a directory. */
function has(dir: string, file: string): boolean {
    return fs.existsSync(path.join(dir, file));
}

/** The `package-manager` entity for pnpm. */
export const pnpmManager: PnpmPackageManager = {
    id: "pnpm",
    description: "pnpm, with its workspaces.",

    async detect(projectRoot): Promise<PackageManagerDetection | undefined> {
        const pkg = readPackageJson(projectRoot);

        if (packageManagerName(pkg) !== "pnpm" && !has(projectRoot, "pnpm-lock.yaml") && !has(projectRoot, WORKSPACE_FILE)) {
            return undefined;
        }

        const version = packageManagerField(pkg, "pnpm");
        const workspaceRoot = findUp(projectRoot, (dir) => has(dir, WORKSPACE_FILE));

        return {
            id: "pnpm",
            detected: true,
            ...(version === undefined ? {} : { version }),
            ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
        };
    },

    async installed(scope: InstallScope, projectRoot, ctx): Promise<InstalledPackage[]> {
        if (scope === "project") {
            if (projectRoot === undefined) return [];

            return readInstalled(path.join(projectRoot, "node_modules"), readPackageJson(projectRoot));
        }

        const root = await pnpmManager.globalRoot?.(ctx);

        return root === undefined ? [] : readInstalled(root);
    },

    async globalRoot(ctx) {
        try {
            const result = await ctx.services.get("host.processes").run(commandOf(ctx), ["root", "-g"], { label: "pnpm root -g" });

            return result.exitCode === 0 ? lastLine(result.stdout) : undefined;
        } catch {
            return undefined;
        }
    },

    addCommand(specs, options: AddOptions): PlannedCommand {
        // `-E` pins what is named; at a workspace root pnpm refuses to add without `-w`.
        const flags = [...(options.section === "devDependencies" ? ["-D"] : []), "-E", ...(options.workspaceRoot ? ["-w"] : [])];

        return { command: "pnpm", args: ["add", ...flags, ...specs], cwd: options.cwd };
    },

    globalInstallCommand(specs): PlannedCommand {
        return { command: "pnpm", args: ["add", "-g", ...specs] };
    },
};
