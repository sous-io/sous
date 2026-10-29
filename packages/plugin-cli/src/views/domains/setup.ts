/**
 * The views of project setup and updates: `sous init`, `sous update` and `plugins.install`, ported
 * from the printing in today's `src/commands/init.ts` and `src/lib/self-update/run.ts`.
 *
 * The handlers already report their progress (every file `init` writes, each plan `update` runs,
 * every notice), so these views print what today's commands printed at the end: what was set up,
 * the update plan of a dry run, and the update's summary.
 */

import path from "node:path";
import type { CliViewContext, CliViewEntity } from "../../types.js";
import type { Printer, VariableEntry } from "../printer.js";

/** The package `init` adds to a project's `package.json`. */
const SOUS_PACKAGE_NAME = "@sous-io/sous";

/** The starter prompt `init` writes, relative to `.sous/`. */
const STARTER_PROMPT_RELATIVE_PATH = path.join("memories", "AGENTS.tpl.md");

/** What the starter prompt compiles to, at the project root. */
const STARTER_OUTPUT_NAME = "AGENTS.md";

// ---------------------------------------------------------------------------------------------
// Result shapes (plugin-init and plugin-update own them; these are the parts the views read)
// ---------------------------------------------------------------------------------------------

/** What `init` did to `package.json`. */
export type PackageJsonOutcomeShape =
    | { readonly kind: "already-declared"; readonly section: string; readonly range: string }
    | { readonly kind: "added"; readonly section: string; readonly range: string }
    | { readonly kind: "no-package-json" };

/** The result of `init`. */
export interface InitResultShape {
    readonly root: string;
    readonly sousDir: string;
    readonly configPath: string;
    readonly files: readonly string[];
    readonly kept: readonly string[];
    readonly packageJson: PackageJsonOutcomeShape;
    readonly build?: unknown;
    readonly dryRun: boolean;
}

/** A command to run. */
export interface PlannedCommandShape {
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd?: string;
}

/** One install an update changes. */
export interface UpdatePlanShape {
    readonly scope: "project" | "global";
    readonly location: string;
    readonly projectRoot?: string;
    readonly manager: string;
    readonly managerAssumed: boolean;
    readonly installed: string;
    readonly target: string;
    readonly direction: "upgrade" | "downgrade" | "current";
    readonly declaredIn?: { readonly section: string; readonly range: string };
    readonly command: PlannedCommandShape;
}

/** The result of `update`. */
export interface UpdateResultShape {
    readonly outcomes: ReadonlyArray<{
        readonly plan: UpdatePlanShape;
        readonly result: "updated" | "failed" | "declined" | "current" | "planned";
        readonly exitCode?: number;
    }>;
    readonly notices: readonly unknown[];
    readonly build?: { readonly result: "built" | "failed" | "skipped" | "no-config" | "no-bin"; readonly directory?: string; readonly exitCode?: number };
    readonly failed: boolean;
}

/** The result of `plugins.install`. */
export interface PluginsInstallResultShape {
    readonly manager: string;
    readonly command: PlannedCommandShape;
    readonly installed: ReadonlyArray<{ readonly name: string; readonly range: string }>;
    readonly exitCode?: number;
    readonly declined: boolean;
    readonly dryRun: boolean;
}

// ---------------------------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------------------------

/**
 * `sous init`: the `package.json` change, the first build's report, then what was set up.
 *
 * ```text
 * ▶ What was set up:
 *
 *     Config        : /p/.sous/sous.config.jsonc
 *     Prompt source : /p/.sous/memories/AGENTS.tpl.md
 *     ...
 * ```
 */
export async function initView(result: InitResultShape, view: CliViewContext): Promise<string> {
    const out = view.printer();
    const added = result.packageJson.kind === "added" ? result.packageJson : undefined;

    if (added) {
        const what = `${SOUS_PACKAGE_NAME} ${added.range} to devDependencies in package.json`;

        out.section("Setting up the project");

        if (result.dryRun) {
            out.dryRunNotice(`would add ${what}`);
        } else {
            out.log(`  added ${what}`);
        }
    }

    if (result.dryRun) {
        return out.empty ? "" : out.footer().text();
    }

    const build = result.build === undefined ? "" : await view.render("build", result.build);

    if (build !== "") {
        out.log(build.replace(/\n$/, ""));
    }

    out.section("What was set up");
    out.variables([
        { label: "Config", value: result.configPath },
        { label: "Prompt source", value: path.join(result.sousDir, STARTER_PROMPT_RELATIVE_PATH) },
        { label: "Compiled to", value: path.join(result.root, STARTER_OUTPUT_NAME) },
        { label: "Skills", value: path.join(result.root, ".claude", "skills") },
        ...dependencyRow(result.packageJson),
        { label: "Shared answers", value: path.join(result.sousDir, ".env"), detail: "committed" },
        { label: "Local answers", value: path.join(result.sousDir, ".env.local"), detail: "gitignored; .env.local.example shows the layout" },
    ]);
    out.blank();
    out.paragraph(
        `  ${STARTER_OUTPUT_NAME} and the skills directory are build output, compiled from the prompt source and from the recipes this project subscribes to; a build recompiles them. The config explains each of its blocks in its own comments.`,
    );

    return out.footer().text();
}

/** The "Dependency" row: where sous sits in `package.json`, or nothing without one. */
function dependencyRow(outcome: PackageJsonOutcomeShape): VariableEntry[] {
    if (outcome.kind === "no-package-json") {
        return [];
    }

    const value = `${SOUS_PACKAGE_NAME} ${outcome.range}`;

    if (outcome.kind === "already-declared") {
        return [{ label: "Dependency", value, detail: `already in ${outcome.section} in package.json` }];
    }

    return [{ label: "Dependency", value, detail: "added to devDependencies in package.json; run your package manager's install to fetch it" }];
}

// ---------------------------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------------------------

/**
 * `sous update`: in a dry run, every install's plan; otherwise the summary, one line per install
 * and one for the build. Notices and each step's progress were reported while it ran.
 */
export function updateView(result: UpdateResultShape, view: CliViewContext): string {
    const out = view.printer();
    const plans = result.outcomes.map((outcome) => outcome.plan);
    const globalCount = plans.filter((plan) => plan.scope === "global").length;
    const dryRun = result.outcomes.some((outcome) => outcome.result === "planned");

    if (plans.length === 0) {
        return "";
    }

    if (dryRun) {
        out.heading("Update plan");

        for (const plan of plans) {
            out.subheading(planTitle(plan, globalCount));
            out.variables(planFacts(plan, view.input.noBuild === true));
        }

        out.blank();
        out.dryRunNotice("Nothing was installed. Run the same command without '--dry-run' to update.");

        return out.footer().text();
    }

    printSummary(out, result, globalCount);

    return out.footer().text();
}

/** "Global install", "Global install (pnpm)" when there are several, or "Project install". */
export function planTitle(plan: UpdatePlanShape, globalCount: number): string {
    if (plan.scope === "project") {
        return "Project install";
    }

    return globalCount > 1 ? `Global install (${plan.manager})` : "Global install";
}

/** A command as a person would type it. */
export function formatCommand(command: PlannedCommandShape): string {
    return [command.command, ...command.args].join(" ");
}

function commandFact(label: string, command: PlannedCommandShape): VariableEntry {
    return command.cwd === undefined ? { label, value: formatCommand(command) } : { label, value: formatCommand(command), detail: `in ${command.cwd}` };
}

/** The facts of one plan, as a dry run shows them. */
function planFacts(plan: UpdatePlanShape, noBuild: boolean): VariableEntry[] {
    const facts: VariableEntry[] = [];

    if (plan.projectRoot !== undefined) {
        facts.push({ label: "Project", value: plan.projectRoot });
    }

    facts.push({ label: "Location", value: plan.location });
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
    facts.push(commandFact("Command", plan.command));

    if (plan.scope === "project") {
        facts.push(noBuild ? { label: "Then builds", value: "no", detail: "--no-build was passed" } : { label: "Then builds", value: "yes", detail: "with the new copy" });
    }

    return facts;
}

function printSummary(out: Printer, result: UpdateResultShape, globalCount: number): void {
    out.section("Summary");

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

    out.variables(rows);
}

// ---------------------------------------------------------------------------------------------
// plugins.install
// ---------------------------------------------------------------------------------------------

/**
 * `plugins.install` (new: today's CLI has no such command): the plugins installed, or what a dry
 * run would install. The command itself was reported before it ran.
 */
export function pluginsInstallView(result: PluginsInstallResultShape, view: CliViewContext): string {
    const out = view.printer();

    if (result.declined) {
        out.blank();
        out.log("  Nothing was installed.");

        return out.footer().text();
    }

    out.section(result.dryRun ? "Plugins to install" : "Installed plugins");
    out.variables(result.installed.map((plugin) => ({ label: plugin.name, value: plugin.range })));
    out.blank();
    out.variables([{ ...commandFact(result.dryRun ? "Command" : "Ran", result.command), detail: `through ${result.manager}` }]);

    if (result.dryRun) {
        out.blank();
        out.dryRunNotice("Nothing was installed. Run the same command without '--dry-run' to install.");
    }

    return out.footer().text();
}

/** The views of this domain, by intent. */
export const views: Record<string, CliViewEntity["render"]> = {
    init: initView,
    update: updateView,
    "plugins.install": pluginsInstallView,
};
