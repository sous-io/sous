/**
 * The `plugins.install` intent: installs npm plugins (a recipe's required plugins, say) through the
 * project's package manager. The package-manager entity plans the command; this module asks, runs
 * it through `host.processes`, and reports what was installed.
 */

import path from "node:path";
import { ConfigError, InputError, type Context } from "@sous-io/plugin-api";
import "@sous-io/plugin-host/types";
import { ownerOf } from "./installs.js";
import type { DependencySection, PluginsInstallInput, PluginsInstallResult } from "./types.js";

/** The section plugins are added to when the input names none. */
export const DEFAULT_SECTION: DependencySection = "devDependencies";

/**
 * Splits `name` or `name@range` (scoped names included) into its parts.
 *
 * ```ts
 * parsePluginSpec("@scope/plugin@^1.0.0"); // { name: "@scope/plugin", range: "^1.0.0" }
 * parsePluginSpec("sous-plugin-x");        // { name: "sous-plugin-x" }
 * ```
 */
export function parsePluginSpec(spec: string): { name: string; range?: string } {
    const at = spec.lastIndexOf("@");

    if (at <= 0) {
        return { name: spec };
    }

    const range = spec.slice(at + 1);

    return range === "" ? { name: spec.slice(0, at) } : { name: spec.slice(0, at), range };
}

/** Runs the intent. */
export async function handle(input: PluginsInstallInput, ctx: Context): Promise<PluginsInstallResult> {
    const specs = input.plugins.map((spec) => spec.trim()).filter((spec) => spec !== "");

    if (specs.length === 0) {
        throw new InputError("plugins.install", [{ path: "plugins", message: "name at least one plugin" }]);
    }

    const parsed = specs.map(parsePluginSpec);
    const root = path.resolve(ctx.project?.root ?? ctx.cwd);
    const owner = await ownerOf(root, ctx.entities.list("package-manager"), ctx);

    if (owner === undefined) {
        throw new ConfigError(`No package manager plugin claims the project at ${root}, so sous cannot install ${specs.join(", ")}.`, {
            details: ["Install the plugins by hand with the project's package manager, or load a plugin that drives it."],
        });
    }

    const section = input.section ?? DEFAULT_SECTION;
    const dryRun = input.dryRun === true;
    const command = owner.entity.addCommand(specs, {
        section,
        workspaceRoot: owner.detection.workspaceRoot !== undefined && path.resolve(owner.detection.workspaceRoot) === root,
        cwd: root,
    });
    const requested = parsed.map((plugin) => ({ name: plugin.name, range: plugin.range ?? "latest" }));
    const manager = owner.detection.id;

    ctx.reporter.note(`${dryRun ? "Would run" : "Running"}: ${[command.command, ...command.args].join(" ")}`);

    if (dryRun) {
        return { manager, command, installed: requested, declined: false, dryRun };
    }

    const proceed =
        input.yes === true ||
        (await ctx.prompter.confirm({
            message: `Install ${specs.join(", ")} with ${manager}?`,
            default: true,
            answeredBy: "--yes (or --install-plugins where the command has it)",
        }));

    if (!proceed) {
        return { manager, command, installed: [], declined: true, dryRun };
    }

    const result = await ctx.services.get("host.processes").runInteractive(command.command, command.args, {
        ...(command.cwd === undefined ? {} : { cwd: command.cwd }),
        env: ctx.env,
        label: `${manager} add`,
        // A package manager is a `.cmd` shim on Windows; the command line is one sous planned.
        windowsShell: true,
    });
    const exitCode = result.exitCode ?? 1;

    if (exitCode !== 0) {
        throw new ConfigError(`${manager} exited with code ${exitCode}, so ${specs.join(", ")} ${specs.length === 1 ? "was" : "were"} not installed.`, {
            details: [`The command was: ${[command.command, ...command.args].join(" ")}`],
        });
    }

    // Read back what the manager wrote, so a bare name reports the range it was declared with.
    let declared = new Map<string, string>();

    try {
        const packages = await owner.entity.installed("project", root, ctx);

        declared = new Map(packages.flatMap((pkg) => (pkg.declared === undefined ? [] : [[pkg.name, pkg.declared.range] as const])));
    } catch {
        // The ranges asked for are reported instead.
    }

    return {
        manager,
        command,
        installed: requested.map((plugin) => ({ name: plugin.name, range: declared.get(plugin.name) ?? plugin.range })),
        exitCode,
        declined: false,
        dryRun,
    };
}

export default handle;
