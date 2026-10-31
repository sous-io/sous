/**
 * What `update` and `plugins.install` show: the update plan or the summary of an update, and the
 * plugins installed. Each builder returns outputs; the intents add the machine data.
 */

import { IntentOutput, ReportEntryStyle, TextBlock, VariableSet, type VariableEntry } from "@sous-io/plugin-api";
import type { PlannedCommand, PluginsInstallResult, UpdateInput, UpdatePlan, UpdateResult } from "./types.js";

/** A command as a person would type it. */
export function formatCommand(command: PlannedCommand): string {
    return [command.command, ...command.args].join(" ");
}

/** "Global install", "Global install (pnpm)" when there are several, or "Project install". */
export function planTitle(plan: UpdatePlan, globalCount: number): string {
    if (plan.scope === "project") {
        return "Project install";
    }

    return globalCount > 1 ? `Global install (${plan.manager})` : "Global install";
}

function commandFact(label: string, command: PlannedCommand): VariableEntry {
    return command.cwd === undefined ? { label, value: formatCommand(command) } : { label, value: formatCommand(command), detail: `in ${command.cwd}` };
}

/** The facts of one plan. */
function planFacts(plan: UpdatePlan): VariableEntry[] {
    const facts: VariableEntry[] = [];

    if (plan.projectRoot !== undefined) {
        facts.push({ label: "Project", value: plan.projectRoot });
    }

    facts.push(
        plan.pnpRoot === undefined
            ? { label: "Location", value: plan.location }
            : { label: "Location", value: plan.location, detail: "Yarn Plug'n'Play, which keeps no node_modules copy" },
    );
    facts.push(
        plan.managerAssumed
            ? { label: "Package manager", value: plan.manager, detail: "assumed, because the project's files name no package manager" }
            : { label: "Package manager", value: plan.manager },
    );

    if (plan.declaredIn !== undefined) {
        facts.push({ label: "Declared in", value: plan.declaredIn.section, detail: `as ${plan.declaredIn.range}` });
    }

    facts.push({ label: "Installed", value: plan.installed });

    if (plan.direction === "current") {
        facts.push({ label: "Will install", value: "nothing", detail: `${plan.installed} is already the version this update chooses` });

        return facts;
    }

    facts.push(
        plan.direction === "downgrade"
            ? { label: "Will install", value: plan.target, detail: `a downgrade from ${plan.installed}` }
            : { label: "Will install", value: plan.target },
    );

    return facts;
}

/** Whether a project update is followed by a build, and where. */
function buildFact(noBuild: boolean, buildDirectory: string | undefined): VariableEntry {
    if (noBuild) {
        return { label: "Then builds", value: "no", detail: "--no-build was passed" };
    }

    if (buildDirectory === undefined) {
        return { label: "Then builds", value: "no", detail: "the project has no sous config" };
    }

    return { label: "Then builds", value: "yes", detail: `with the new copy, in ${buildDirectory}` };
}

/** The block `sous update` opens with: where it ran, which installs, which version, the registry. */
export function updateCommandEntries(result: UpdateResult, input: UpdateInput, cwd: string | undefined): Record<string, unknown> {
    const installs = input.global === true ? "global only" : input.project === true ? "project only" : "global and project";
    const version =
        typeof input.version === "string" ? input.version : input.major === true ? "the newest published, whatever its major version" : "the newest in each install's major version";
    const prereleases = input.prerelease === undefined ? "counted when the installed version is one" : input.prerelease === true ? "counted" : "not counted";

    return {
        ...(cwd === undefined ? {} : { Directory: cwd }),
        Installs: installs,
        Version: version,
        Prereleases: prereleases,
        ...(result.registry === undefined ? {} : { Registry: result.registry }),
        "Dry Run": input.dryRun === true,
    };
}

/** The summary of a real update: one row per install, then the project build. */
function summaryRows(result: UpdateResult, globalCount: number): VariableEntry[] {
    const rows: VariableEntry[] = result.outcomes.map(({ plan, result: outcome, exitCode }) => {
        const label = planTitle(plan, globalCount);

        switch (outcome) {
            case "updated":
                return { label, value: `updated to ${plan.target}`, detail: `from ${plan.installed}` };
            case "failed":
                return { label, value: "failed", detail: `${plan.manager} exited with code ${exitCode}` };
            case "declined":
                return { label, value: "skipped", detail: `left at ${plan.installed}` };
            default:
                return { label, value: `up to date at ${plan.installed}` };
        }
    });
    const build = result.build;

    if (build !== undefined) {
        const label = "Project build";

        switch (build.result) {
            case "built":
                rows.push({ label, value: "succeeded", detail: `in ${build.directory}` });
                break;
            case "failed":
                rows.push({ label, value: "failed", detail: `exited with code ${build.exitCode}` });
                break;
            case "no-bin":
                rows.push({ label, value: "failed", detail: "the new copy names no bin" });
                break;
            case "skipped":
                rows.push({ label, value: "skipped", detail: "--no-build was passed" });
                break;
            case "no-config":
                rows.push({ label, value: "not run", detail: "the project has no sous config" });
                break;
        }
    }

    return rows;
}

/**
 * `sous update`: the block it opens with, the installs it cannot update, then each install's
 * facts. A dry run ends there, with the command each install would run; a real run adds the
 * summary. The commands of a real run were reported as they ran, since their own output follows them.
 */
export function updateOutputs(result: UpdateResult, input: UpdateInput, opening: IntentOutput): IntentOutput[] {
    const plans = result.outcomes.map((outcome) => outcome.plan);
    const globalCount = plans.filter((plan) => plan.scope === "global").length;
    const dryRun = input.dryRun === true;
    const outputs: IntentOutput[] = [opening];

    if (result.notices.length > 0) {
        outputs.push(new IntentOutput({ title: "Not updated" }));

        for (const notice of result.notices) {
            outputs.push(new IntentOutput({ result: new TextBlock(notice.message), style: ReportEntryStyle.Note }));

            const facts: VariableEntry[] = [];

            if (notice.location !== undefined) {
                facts.push({ label: "Location", value: notice.location });
            }

            if (notice.manualCommand !== undefined) {
                facts.push(commandFact("Run by hand", notice.manualCommand));
            }

            if (facts.length > 0) {
                outputs.push(new IntentOutput({ result: new VariableSet(facts) }));
            }
        }
    }

    if (plans.length === 0) {
        outputs.push(new IntentOutput({ result: new TextBlock("There is no install of sous here that sous can update."), style: ReportEntryStyle.Note }));

        return outputs;
    }

    outputs.push(new IntentOutput({ title: dryRun ? "Update plan" : "Updating" }));

    for (const outcome of result.outcomes) {
        const plan = outcome.plan;
        const title = planTitle(plan, globalCount);
        const facts = planFacts(plan);

        if (plan.direction !== "current" && plan.scope === "project") {
            facts.push(buildFact(input.noBuild === true, result.buildDirectory));
        }

        if (dryRun && plan.direction !== "current") {
            facts.push(commandFact("Would run", plan.command));
        }

        outputs.push(new IntentOutput({ result: new VariableSet(facts, { title }) }));

        if (outcome.result === "declined") {
            outputs.push(new IntentOutput({ result: new TextBlock(`The ${title.toLowerCase()} was left at ${plan.installed}.`) }));
        }
    }

    if (dryRun) {
        outputs.push(new IntentOutput({ result: new TextBlock("Nothing was installed. Run the same command without '--dry-run' to update."), style: ReportEntryStyle.DryRun }));

        return outputs;
    }

    outputs.push(new IntentOutput({ title: "Summary", result: new VariableSet(summaryRows(result, globalCount)) }));

    return outputs;
}

/** `plugins.install`: the plugins installed, or what a dry run would install. The command was reported before it ran. */
export function pluginsInstallOutputs(result: PluginsInstallResult): IntentOutput[] {
    if (result.declined) {
        return [new IntentOutput({ result: new TextBlock("Nothing was installed.") })];
    }

    const outputs = [
        new IntentOutput({
            title: result.dryRun ? "Plugins to install" : "Installed plugins",
            result: new VariableSet([...result.installed.map((plugin) => ({ label: plugin.name, value: plugin.range })), { label: "Package manager", value: result.manager }]),
        }),
    ];

    if (result.dryRun) {
        outputs.push(new IntentOutput({ result: new TextBlock("Nothing was installed. Run the same command without '--dry-run' to install."), style: ReportEntryStyle.DryRun }));
    }

    return outputs;
}
