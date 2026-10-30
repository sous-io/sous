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
    readonly pnpRoot?: string;
}

/** Something an update could not do itself, and how to do it by hand. */
export interface UpdateNoticeShape {
    readonly message: string;
    readonly location?: string;
    readonly manualCommand?: PlannedCommandShape;
}

/** The result of `update`. */
export interface UpdateResultShape {
    readonly registry?: string;
    readonly outcomes: ReadonlyArray<{
        readonly plan: UpdatePlanShape;
        readonly result: "updated" | "failed" | "declined" | "current" | "planned";
        readonly exitCode?: number;
    }>;
    readonly notices: readonly UpdateNoticeShape[];
    readonly buildDirectory?: string;
    readonly configProblem?: { readonly configPath?: string; readonly message: string };
    readonly build?: {
        readonly result: "built" | "failed" | "skipped" | "no-config" | "no-bin";
        readonly directory?: string;
        readonly command?: PlannedCommandShape;
        readonly exitCode?: number;
    };
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
 * `sous init`: the files written (or, in a dry run, that would be), the `package.json` change, the
 * first build's report, then what was set up. Files are shown relative to the project root, as
 * today's CLI showed them.
 *
 * ```text
 * ▶ Setting up the project:
 *
 *     wrote .sous/sous.config.js
 *     wrote .sous/memories/AGENTS.tpl.md
 *     added @sous-io/sous 0.2.34 to devDependencies in package.json
 *
 * ▶ What was set up:
 *
 *     Config        : /p/.sous/sous.config.js
 *     Prompt source : /p/.sous/memories/AGENTS.tpl.md
 *     ...
 * ```
 */
export async function initView(result: InitResultShape, view: CliViewContext): Promise<string> {
    const out = view.printer();
    const added = result.packageJson.kind === "added" ? result.packageJson : undefined;
    const packageJsonFile = path.join(result.root, "package.json");
    const files = result.files.filter((file) => !(added && file === packageJsonFile));

    if (files.length > 0 || result.kept.length > 0 || added) {
        out.section("Setting up the project");
    }

    for (const file of files) {
        const relative = path.relative(result.root, file) || file;

        if (result.dryRun) {
            out.dryRunNotice(`would write ${relative}`);
        } else {
            out.log(`  wrote ${relative}`);
        }
    }

    for (const file of result.kept) {
        out.log(`  kept ${path.relative(result.root, file) || file}, which already exists`);
    }

    if (added) {
        const what = `${SOUS_PACKAGE_NAME} ${added.range} to devDependencies in package.json`;

        if (result.dryRun) {
            out.dryRunNotice(`would add ${what}`);
        } else {
            out.log(`  added ${what}`);
        }
    }

    if (result.dryRun) {
        if (out.empty) {
            return "";
        }

        out.blank();
        out.dryRunNotice("Nothing was written. Run the same command without '--dry-run' to set the project up.");

        return out.footer().text();
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
 * `sous update`, laid out as today's command printed it: a warning for a project config this copy
 * could not load, the registry, the installs it cannot update, then each install's facts. A dry
 * run ends there; a real run adds the commands that ran and the summary. The commands were also
 * reported as they ran, since their own output follows them.
 *
 * ```text
 * ▶ Updating:
 *
 * ➔ Global install
 *     Location        : /usr/lib/node_modules/@sous-io/sous
 *     Package manager : npm
 *     Installed       : 0.2.30
 *     Will install    : 0.2.34
 *     Running         : npm i -g @sous-io/sous@0.2.34
 *
 * ▶ Summary:
 *
 *     Global install: updated to 0.2.34 from 0.2.30
 * ```
 */
export function updateView(result: UpdateResultShape, view: CliViewContext): string {
    const out = view.printer();
    const plans = result.outcomes.map((outcome) => outcome.plan);
    const globalCount = plans.filter((plan) => plan.scope === "global").length;
    const dryRun = view.input.dryRun === true || result.outcomes.some((outcome) => outcome.result === "planned");
    const noBuild = view.input.noBuild === true;

    if (result.configProblem !== undefined) {
        const where = result.configProblem.configPath === undefined ? "the project config" : `the project config at ${result.configProblem.configPath}`;

        out.warning(`Sous could not load ${where}, so this command carries on without it.\n\nThe error was:\n${result.configProblem.message}`);
    }

    out.subheading("Command Variables", "$");
    out.variables(commandVariables(result, view));

    if (result.notices.length > 0) {
        out.section("Not updated");

        for (const notice of result.notices) {
            out.note(notice.message, { indent: 2 });

            const facts: VariableEntry[] = [];

            if (notice.location !== undefined) {
                facts.push({ label: "Location", value: notice.location });
            }

            if (notice.manualCommand !== undefined) {
                facts.push(commandFact("Run by hand", notice.manualCommand));
            }

            out.variables(facts);
            out.blank();
        }
    }

    if (plans.length === 0) {
        out.blank();
        out.note("There is no install of sous here that sous can update.", { indent: 2 });

        return out.footer().text();
    }

    out.heading(dryRun ? "Update plan" : "Updating");

    for (const outcome of result.outcomes) {
        const plan = outcome.plan;

        out.subheading(planTitle(plan, globalCount));
        out.variables(planFacts(plan, { dryRun, noBuild, buildDirectory: result.buildDirectory }));

        if (outcome.result === "updated" || outcome.result === "failed") {
            out.blank();
            out.variables([commandFact("Running", plan.command)]);
        }

        if (outcome.result === "declined") {
            out.blank();
            out.log(`  The ${planTitle(plan, globalCount).toLowerCase()} was left at ${plan.installed}.`);
        }
    }

    if (dryRun) {
        out.blank();
        out.dryRunNotice("Nothing was installed. Run the same command without '--dry-run' to update.");

        return out.footer().text();
    }

    if (result.build?.command !== undefined) {
        out.section("Building the project");
        out.variables([commandFact("Running", result.build.command)]);
    }

    printSummary(out, result, globalCount);

    return out.footer().text();
}

/** The block `sous update` opens with: where it ran, which installs, which version, the registry. */
function commandVariables(result: UpdateResultShape, view: CliViewContext): VariableEntry[] {
    const input = view.input;
    const installs = input.global === true ? "global only" : input.project === true ? "project only" : "global and project";
    const version =
        typeof input.version === "string"
            ? input.version
            : input.major === true
              ? "the newest published, whatever its major version"
              : "the newest in each install's major version";
    const prereleases = input.prerelease === undefined ? "counted when the installed version is one" : input.prerelease === true ? "counted" : "not counted";

    return [
        ...(view.cwd === undefined ? [] : [{ label: "Directory", value: view.cwd }]),
        { label: "Installs", value: installs },
        { label: "Version", value: version },
        { label: "Prereleases", value: prereleases },
        ...(result.registry === undefined ? [] : [{ label: "Registry", value: result.registry }]),
        { label: "Dry Run", value: input.dryRun === true },
    ];
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

/** The facts of one plan; the command is shown only in a dry run (a real run shows what ran). */
function planFacts(plan: UpdatePlanShape, context: { dryRun: boolean; noBuild: boolean; buildDirectory: string | undefined }): VariableEntry[] {
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
    if (context.dryRun) {
        facts.push(commandFact("Command", plan.command));
    }

    if (plan.scope === "project") {
        facts.push(buildFact(context.noBuild, context.buildDirectory));
    }

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
