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
 * Nothing here prints or prompts directly (L3): messages go to `ctx.reporter` and questions to
 * `ctx.prompter`; the installs run through `host.processes`.
 */

import fs from "node:fs";
import path from "node:path";
import { ConfigError, InputError, type Context } from "@sous-io/plugin-api";
import "@sous-io/plugin-host/types";
import { discoverInstalls, readPackageJson, realpathOr } from "./installs.js";
import { buildUpdatePlans, type PlannedUpdate } from "./plan.js";
import { fetchPublishedVersions } from "./registry.js";
import type { InstallScope, PlannedCommand, UpdateInput, UpdateNotice, UpdateOutcome, UpdatePlan, UpdateResult } from "./types.js";
import type { VersionRequest } from "./versions.js";

/** The environment variable that keeps the invoked copy running instead of handing off to a project copy. */
export const NO_DELEGATE_ENV = "SOUS_NO_DELEGATE";

/** A command as a person would type it. */
export function formatCommand(command: PlannedCommand): string {
    return [command.command, ...command.args].join(" ");
}

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

/** "Global install", "Global install (pnpm)" when there are several, or "Project install". */
export function planTitle(plan: UpdatePlan, globalCount: number): string {
    if (plan.scope === "project") {
        return "Project install";
    }

    return globalCount > 1 ? `Global install (${plan.manager})` : "Global install";
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
    const result = await ctx.services.get("host.processes").runInteractive(command.command, command.args, {
        ...(command.cwd === undefined ? {} : { cwd: command.cwd }),
        env,
        label: formatCommand(command),
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

    ctx.reporter.note("Building the project with the new copy.");

    let command: PlannedCommand;

    if (plan.pnpRoot !== undefined) {
        command = { command: "yarn", args: ["run", "--binaries-only", "sous", "build"], cwd: directory };
    } else {
        const root = realpathOr(plan.location);
        const entry = binEntryOf(readPackageJson(root));

        if (entry === undefined) {
            ctx.reporter.log("error", `The update stands, but the new copy at ${root} names no bin sous can run, so the project was not built. Run 'sous build' in the project.`);

            return { result: "no-bin", directory };
        }

        command = { command: process.execPath, args: [path.resolve(root, entry), "build"], cwd: directory };
    }

    const exitCode = await execute(ctx, command, { ...ctx.env, [NO_DELEGATE_ENV]: "1" });

    if (exitCode !== 0) {
        ctx.reporter.log(
            "error",
            `The update stands, but the build that followed it exited with code ${exitCode}. Fix what the build reported above and run 'sous build' again.` +
                (plan.pnpRoot === undefined ? "" : PNP_BUILD_HINT),
        );

        return { result: "failed", directory, exitCode };
    }

    return { result: "built", directory, exitCode };
}

/** What a failed build under Yarn Plug'n'Play adds: sous cannot run from inside Yarn's zip cache. */
const PNP_BUILD_HINT =
    " Under Yarn Plug'n'Play, sous runs only from an unpacked copy: if the error above is 'EBADF: bad file descriptor', add \"dependenciesMeta\": { \"@sous-io/sous\": { \"unplugged\": true } } to package.json, then run 'yarn install'.";

/** Reports what a notice says, and the command to run by hand. */
function reportNotice(notice: UpdateNotice, ctx: Context): void {
    ctx.reporter.warning(notice.message, {
        ...(notice.location === undefined ? {} : { location: notice.location }),
        ...(notice.manualCommand === undefined ? {} : { runByHand: formatCommand(notice.manualCommand) }),
    });

    if (notice.manualCommand !== undefined) {
        ctx.reporter.note(`Run by hand: ${formatCommand(notice.manualCommand)}`);
    }
}

/** Runs the intent. */
export async function handle(input: UpdateInput, ctx: Context): Promise<UpdateResult> {
    checkInput(input);

    const dryRun = input.dryRun === true;
    const only: InstallScope | undefined = input.global ? "global" : input.project ? "project" : undefined;
    const metadata = await fetchPublishedVersions(ctx.services.get("host.http"), ctx.env);
    const discovery = await discoverInstalls({ cwd: ctx.cwd, ownRoot: ctx.services.get("host.package").identity().realRoot }, ctx);
    const { plans, notices } = buildUpdatePlans(discovery, metadata, {
        request: requestOf(input),
        ...(only === undefined ? {} : { only }),
        ...(input.prerelease === undefined ? {} : { prerelease: input.prerelease }),
    });

    for (const notice of notices) {
        reportNotice(notice, ctx);
    }

    const outcomes: UpdateOutcome[] = [];
    let build: UpdateResult["build"];
    let failed = false;

    if (plans.length === 0) {
        ctx.reporter.note("There is no install of sous here that sous can update.");

        return { outcomes, notices, failed };
    }

    const actionable = plans.filter((plan) => plan.direction !== "current");
    const globalCount = plans.filter((plan) => plan.scope === "global").length;

    for (const plan of plans) {
        const title = planTitle(plan, globalCount);

        ctx.reporter.note(`${title}: ${plan.installed} at ${plan.location}, through ${plan.manager}${plan.managerAssumed ? " (assumed)" : ""}.`);

        if (plan.direction === "current") {
            ctx.reporter.note(`${plan.installed} is already the version this update chooses.`);
            outcomes.push({ plan, result: "current" });
            continue;
        }

        ctx.reporter.note(`Will install ${plan.target}${plan.direction === "downgrade" ? ` (a downgrade from ${plan.installed})` : ""}: ${formatCommand(plan.command)}`);

        if (dryRun) {
            outcomes.push({ plan, result: "planned" });
            continue;
        }

        const proceed =
            input.yes === true ||
            (await ctx.prompter.confirm({
                message: `${questionFor(plan, title)} (${actionable.indexOf(plan) + 1} of ${actionable.length})`,
                default: true,
                answeredBy: "--yes (also -y, --force) to update every install listed",
            }));

        if (!proceed) {
            outcomes.push({ plan, result: "declined" });
            ctx.reporter.note(`The ${title.toLowerCase()} was left at ${plan.installed}.`);
            continue;
        }

        ctx.reporter.note(`Running ${formatCommand(plan.command)}`);

        const exitCode = await execute(ctx, plan.command);

        if (exitCode !== 0) {
            failed = true;
            outcomes.push({ plan, result: "failed", exitCode });
            ctx.reporter.log("error", `${plan.manager} exited with code ${exitCode}, so the ${title.toLowerCase()} is still at ${plan.installed}. Its own output is above.`);
            continue;
        }

        outcomes.push({ plan, result: "updated", exitCode });
        ctx.reporter.note(`The ${title.toLowerCase()} is now at ${plan.target}.`);

        if (plan.scope === "project" && plan.projectRoot !== undefined) {
            build = await buildProject(plan, buildDirFor(plan.projectRoot, ctx), input, ctx);

            if (build.result === "failed" || build.result === "no-bin") {
                failed = true;
            }
        }
    }

    if (dryRun) {
        ctx.reporter.note("Nothing was installed. Run the same command without '--dry-run' to update.");
    }

    // The CLI turns an error into exit code 1, as `sous update` always did when a step failed.
    if (failed) {
        throw new ConfigError("Not every step of the update succeeded.", {
            details: [...outcomes.map(describeOutcome), ...(build === undefined ? [] : [`Project build: ${build.result}`])],
        });
    }

    return { outcomes, notices, ...(build === undefined ? {} : { build }), failed };
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
