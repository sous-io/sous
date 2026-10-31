/**
 * The `update` intent: moves sous itself to a newer (or a chosen) version, for the global install,
 * the project's own install, or both, through whichever package manager owns each one.
 *
 * Every plan is worked out before anything runs: the registry is read, the installs are found and
 * the planner decides each one's version. Then the plans are taken one at a time, in the order the
 * planner returns them (the global installs, then the project's): each reports its facts, asks its
 * own question, and runs when the answer is yes. Asking the second question after the first
 * install has run means its answer can take the first result into account.
 *
 * Nothing here prints or prompts directly: messages go to `ctx.reporter` and questions to
 * `ctx.prompter`; the installs run through `host.processes`.
 */

import fs from "node:fs";
import path from "node:path";
import { commandVariables, ConfigError, InputError, IntentOutputs, LogLevel, SousError, type Context } from "@sous-io/plugin-api";
import "@sous-io/plugin-host/types";
import { discoverInstalls, readPackageJson, realpathOr } from "./installs.js";
import { buildUpdatePlans, type PlannedUpdate } from "./plan.js";
import { fetchPublishedVersions, registryUrl } from "./registry.js";
import { formatCommand, planTitle, updateCommandEntries, updateOutputs, withData } from "./report.js";
import type { InstallScope, PlannedCommand, UpdateInput, UpdateOutcome, UpdatePlan, UpdateResult } from "./types.js";
import type { VersionRequest } from "./versions.js";

/** The environment variable that keeps the invoked copy running instead of handing off to a project copy. */
export const NO_DELEGATE_ENV = "SOUS_NO_DELEGATE";

/** The flag spellings a question that cannot be asked names. */
const YES_FLAG = "--yes (also -y, --force)";

/** Reads the version request out of the input. */
export function requestOf(input: UpdateInput): VersionRequest {
    if (input.version !== undefined) {
        return { kind: "spec", spec: input.version };
    }

    return input.major ? { kind: "major" } : { kind: "default" };
}

/** Checks the flags that cannot be combined. */
function checkInput(input: UpdateInput): void {
    if (input.major && input.version !== undefined) {
        throw new InputError("update", [{ path: "major", message: "cannot be combined with version" }]);
    }

    if (input.global && input.project) {
        throw new InputError("update", [{ path: "global", message: "cannot be combined with project" }]);
    }
}

/** The question one plan asks. */
function questionFor(plan: UpdatePlan, title: string): string {
    const verb = plan.direction === "downgrade" ? "Downgrade" : "Update";

    return `${verb} the ${title.toLowerCase()} from ${plan.installed} to ${plan.target}?`;
}

/** Whether a `.sous/` directory holds a primary config. */
function holdsPrimaryConfig(sousDir: string): boolean {
    try {
        return fs.readdirSync(sousDir).some((name) => /^sous\.config\./.test(name));
    } catch {
        return false;
    }
}

/**
 * Where a build after a project update runs: the project root when the engine's own project lies
 * inside it with a config, and otherwise the root when its `.sous/` holds a primary config.
 * Undefined means the project has no sous config, so nothing is built.
 */
function buildDirFor(projectRoot: string, ctx: Context): string | undefined {
    const found = ctx.project;

    if (found?.configPath !== undefined) {
        const relative = path.relative(projectRoot, found.root);

        if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
            return found.root;
        }
    }

    return holdsPrimaryConfig(path.join(projectRoot, ".sous")) ? projectRoot : undefined;
}

/** The bin entry a package.json names for sous, relative to its root. */
export function binEntryOf(pkg: Record<string, unknown> | undefined): string | undefined {
    const bin = pkg?.bin;

    if (typeof bin === "string") {
        return bin;
    }

    if (typeof bin === "object" && bin !== null) {
        const entries = bin as Record<string, unknown>;
        const named = entries.sous ?? Object.values(entries)[0];

        return typeof named === "string" ? named : undefined;
    }

    return undefined;
}

/** Runs one command with the terminal handed to it, and returns its exit code. */
async function execute(ctx: Context, command: PlannedCommand, env = ctx.env): Promise<number> {
    ctx.reporter.command(command.command, command.args, command.cwd === undefined ? {} : { cwd: command.cwd });

    const result = await ctx.services.get("host.processes").runInteractive(command.command, command.args, {
        ...(command.cwd === undefined ? {} : { cwd: command.cwd }),
        env,
        label: formatCommand(command),
        // A package manager is a `.cmd` shim on Windows; the command line is one sous planned.
        windowsShell: true,
    });

    return result.exitCode ?? 1;
}

/**
 * Runs the newly installed project copy's own build, so the lockfile's pins move to the version
 * just installed, with the hand-off switched off so no other copy takes the build over. The copy's
 * bin is read from its package.json again, now that the install has replaced it, and runs under
 * this Node. Under Yarn Plug'n'Play there is no bin on disk to run that way, so Yarn runs the
 * dependency's bin itself.
 */
async function buildProject(plan: PlannedUpdate, directory: string | undefined, input: UpdateInput, ctx: Context): Promise<NonNullable<UpdateResult["build"]>> {
    if (input.noBuild) {
        return { result: "skipped" };
    }

    if (directory === undefined) {
        return { result: "no-config" };
    }

    let command: PlannedCommand;

    if (plan.pnpRoot !== undefined) {
        command = { command: "yarn", args: ["run", "--binaries-only", "sous", "build"], cwd: directory };
    } else {
        const root = realpathOr(plan.location);
        const entry = binEntryOf(readPackageJson(root));

        if (entry === undefined) {
            ctx.reporter.problem(`The update stands, but the new copy at ${root} names no bin sous can run, so the project was not built.`, {
                hint: "Run 'sous build' in the project.",
            }, LogLevel.Error);

            return { result: "no-bin", directory };
        }

        command = { command: process.execPath, args: [path.resolve(root, entry), "build"], cwd: directory };
    }

    ctx.reporter.operationStart("Building the project");

    const exitCode = await execute(ctx, command, { ...ctx.env, [NO_DELEGATE_ENV]: "1" });

    if (exitCode !== 0) {
        ctx.reporter.problem(
            `The update stands, but the build that followed it exited with code ${exitCode}.`,
            { hint: `Fix what the build reported above and run 'sous build' again.${plan.pnpRoot === undefined ? "" : PNP_BUILD_HINT}` },
            LogLevel.Error,
        );

        return { result: "failed", directory, command, exitCode };
    }

    return { result: "built", directory, command, exitCode };
}

/** What a failed build under Yarn Plug'n'Play adds: sous cannot run from inside Yarn's zip cache. */
const PNP_BUILD_HINT =
    " Under Yarn Plug'n'Play, sous runs only from an unpacked copy: if the error above is 'EBADF: bad file descriptor', add \"dependenciesMeta\": { \"@sous-io/sous\": { \"unplugged\": true } } to package.json, then run 'yarn install'.";

/** The project config this copy could not load, from the engine's failed config build. */
function configProblemOf(ctx: Context): UpdateResult["configProblem"] {
    const error = ctx.engine.configError;

    if (error === undefined) {
        return undefined;
    }

    const message = error instanceof Error ? error.message : String(error);
    const details = error instanceof SousError ? error.details : [];
    const configPath = ctx.project?.configPath;

    return { ...(configPath === undefined ? {} : { configPath }), message: [message, ...details.map((detail) => `  ${detail}`)].join("\n") };
}

/** The question for one plan, numbered when there are several. */
function questionText(plan: UpdatePlan, title: string, index: number, count: number): string {
    return count > 1 ? `${questionFor(plan, title)} (${index} of ${count})` : questionFor(plan, title);
}

/**
 * Runs the intent. While it runs it reports only what has to be seen as it happens: each command
 * just before it runs (its own output follows), a failure, and the plan a question is about. The
 * result holds the rest (the plans, the notices, the summary), which the front end shows.
 */
export async function handle(input: UpdateInput, ctx: Context): Promise<IntentOutputs<UpdateResult>> {
    checkInput(input);

    const dryRun = input.dryRun === true;
    const only: InstallScope | undefined = input.global ? "global" : input.project ? "project" : undefined;
    const registry = registryUrl(ctx.env);
    const configProblem = configProblemOf(ctx);

    if (configProblem !== undefined) {
        const where = configProblem.configPath === undefined ? "the project config" : `the project config at ${configProblem.configPath}`;

        ctx.reporter.problem(`Sous could not load ${where}, so this command carries on without it.`, { cause: `The error was:\n${configProblem.message}` });
    }

    const metadata = await fetchPublishedVersions(ctx.services.get("host.http"), ctx.env);
    const discovery = await discoverInstalls({ cwd: ctx.cwd, ownRoot: ctx.services.get("host.package").identity().realRoot }, ctx);
    const { plans, notices } = buildUpdatePlans(discovery, metadata, {
        request: requestOf(input),
        ...(only === undefined ? {} : { only }),
        ...(input.prerelease === undefined ? {} : { prerelease: input.prerelease }),
    });
    const projectPlan = plans.find((plan) => plan.scope === "project" && plan.projectRoot !== undefined);
    const buildDirectory = projectPlan?.projectRoot === undefined ? undefined : buildDirFor(projectPlan.projectRoot, ctx);
    const base = {
        registry,
        notices,
        ...(buildDirectory === undefined ? {} : { buildDirectory }),
        ...(configProblem === undefined ? {} : { configProblem }),
    };
    const outcomes: UpdateOutcome[] = [];
    let build: UpdateResult["build"];
    let failed = false;

    const finish = (result: UpdateResult): IntentOutputs<UpdateResult> =>
        new IntentOutputs<UpdateResult>(
            withData(updateOutputs(result, input, commandVariables(ctx, updateCommandEntries(result, input, ctx.cwd))), result),
        );

    if (plans.length === 0) {
        return finish({ ...base, outcomes, failed });
    }

    const actionable = plans.filter((plan) => plan.direction !== "current");
    const globalCount = plans.filter((plan) => plan.scope === "global").length;

    for (const plan of plans) {
        const title = planTitle(plan, globalCount);

        if (plan.direction === "current") {
            outcomes.push({ plan, result: "current" });
            continue;
        }

        if (dryRun) {
            outcomes.push({ plan, result: "planned" });
            continue;
        }

        let proceed = input.yes === true;

        if (!proceed) {
            if (ctx.prompter.interactive) {
                ctx.reporter.notice(`${title}: ${plan.installed} at ${plan.location}, through ${plan.manager}${plan.managerAssumed ? " (assumed)" : ""}. Will install ${plan.target}: ${formatCommand(plan.command)}`);
            }

            proceed = await ctx.prompter.confirm({
                message: questionText(plan, title, actionable.indexOf(plan) + 1, actionable.length),
                default: true,
                answeredBy: YES_FLAG,
            });
        }

        if (!proceed) {
            outcomes.push({ plan, result: "declined" });
            continue;
        }

        const exitCode = await execute(ctx, plan.command);

        if (exitCode !== 0) {
            failed = true;
            outcomes.push({ plan, result: "failed", exitCode });
            ctx.reporter.problem(
                `${plan.manager} exited with code ${exitCode}, so the ${title.toLowerCase()} is still at ${plan.installed}.`,
                { hint: "Its own output is above." },
                LogLevel.Error,
            );
            continue;
        }

        outcomes.push({ plan, result: "updated", exitCode });

        if (plan.scope === "project" && plan.projectRoot !== undefined) {
            build = await buildProject(plan, buildDirectory, input, ctx);

            if (build.result === "failed" || build.result === "no-bin") {
                failed = true;
            }
        }
    }

    const result: UpdateResult = { ...base, outcomes, ...(build === undefined ? {} : { build }), failed };

    // The CLI turns an error into exit code 1, as `sous update` always did when a step failed.
    if (failed) {
        throw new ConfigError("Not every step of the update succeeded.", {
            details: [...outcomes.map(describeOutcome), ...(build === undefined ? [] : [`Project build: ${build.result}`])],
        });
    }

    return finish(result);
}

/** One line saying what became of a plan. */
function describeOutcome(outcome: UpdateOutcome): string {
    const { plan } = outcome;
    const title = plan.scope === "project" ? "Project install" : `Global install (${plan.manager})`;

    switch (outcome.result) {
        case "updated":
            return `${title}: updated to ${plan.target} from ${plan.installed}`;
        case "failed":
            return `${title}: failed, ${plan.manager} exited with code ${outcome.exitCode}`;
        case "declined":
            return `${title}: skipped, left at ${plan.installed}`;
        default:
            return `${title}: up to date at ${plan.installed}`;
    }
}

export default handle;
