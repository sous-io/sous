/**
 * The `package-manager` entity for npm: it only describes and plans. plugin-update runs every
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
import type { NpmPackageManager, NpmPluginOptions } from "./types.js";
import {
    OTHER_MANAGER_FILES,
    lastLine,
    packageManagerField,
    packageManagerName,
    readInstalled,
    readPackageJson,
} from "./node-modules.js";

/** The name of this plugin, whose options say which command to run. */
const PLUGIN = "@sous-io/plugin-npm";

/** The command to run: the `command` option, or `npm`. */
function commandOf(ctx: ServiceContext): string {
    return ctx.config.get<NpmPluginOptions>(["plugins", "options", PLUGIN])?.command ?? "npm";
}

/** Whether a file exists in a directory. */
function has(dir: string, file: string): boolean {
    return fs.existsSync(path.join(dir, file));
}

/** The `package-manager` entity for npm. */
export const npmManager: NpmPackageManager = {
    id: "npm",
    description: "npm, the package manager that comes with Node.js.",

    async detect(projectRoot): Promise<PackageManagerDetection | undefined> {
        const pkg = readPackageJson(projectRoot);
        const named = packageManagerName(pkg);
        const version = packageManagerField(pkg, "npm");

        if (named === "npm" || has(projectRoot, "package-lock.json") || has(projectRoot, "npm-shrinkwrap.json")) {
            return { id: "npm", detected: true, ...(version === undefined ? {} : { version }) };
        }

        if (named !== undefined || OTHER_MANAGER_FILES.some((file) => has(projectRoot, file))) return undefined;

        // Nothing names a manager: npm is assumed, and says so.
        return { id: "npm", detected: false };
    },

    async installed(scope: InstallScope, projectRoot, ctx): Promise<InstalledPackage[]> {
        if (scope === "project") {
            if (projectRoot === undefined) return [];

            return readInstalled(path.join(projectRoot, "node_modules"), readPackageJson(projectRoot));
        }

        const root = await npmManager.globalRoot?.(ctx);

        return root === undefined ? [] : readInstalled(root);
    },

    async globalRoot(ctx) {
        try {
            const result = await ctx.services.get("host.processes").run(commandOf(ctx), ["root", "-g"], { label: "npm root -g" });

            return result.exitCode === 0 ? lastLine(result.stdout) : undefined;
        } catch {
            return undefined;
        }
    },

    addCommand(specs, options: AddOptions): PlannedCommand {
        // `-E` pins exactly what is named; npm adds to the root package.json when run there.
        const flags = options.section === "devDependencies" ? ["-D", "-E"] : ["-E"];

        return { command: "npm", args: ["i", ...flags, ...specs], cwd: options.cwd };
    },

    globalInstallCommand(specs): PlannedCommand {
        return { command: "npm", args: ["i", "-g", ...specs] };
    },
};
