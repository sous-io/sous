/**
 * The `init` intent: sets a project up for sous. It imports the project's existing agent files
 * (a root `CLAUDE.md` or `AGENTS.md`, the files they include, and the skills in `.claude/skills/`)
 * into `.sous/`, writes the `.sous/` directory a project needs (a commented primary config, the
 * memories source, a starter memory when there was nothing to import, the two answers files and
 * the sous-managed ignore blocks), stops git tracking the files it moved, then runs the first build through the one build path, which is what seeds the
 * `core` recipe and pins it in the lockfile.
 *
 * Every question has a flag: setting a project up inside another one is answered by `yes`, and what
 * happens to the files the instructions include by `moveIncludes`, `copyIncludes` or
 * `leaveIncludes` (`yes` picks the default, move). Nothing prints or prompts directly.
 */

import path from "node:path";
import { ConfigError, type Context, IntentOutput, IntentOutputs, ReportEntryStyle, TextBlock, VariableSet, type VariableEntry } from "@sous-io/plugin-api";
import "@sous-io/plugin-build/types";
import type { GitRunner } from "@sous-io/plugin-git/types";
import { applyImport, type ImportOutcome, type ImportScan, INCLUDES_DIR, type IncludeFate, type IncludedFile, scanImport, settleFates } from "./import.js";
import { assertNoExistingConfig, findEnclosingProject, scaffoldProject, sousDirFor } from "./scaffold.js";
import { MEMORIES_SOURCE_RELATIVE_PATH } from "./templates.js";
import type { InitInput, InitResult, PackageJsonOutcome } from "./types.js";

/** The package `init` adds to a project's `package.json`. */
const SOUS_PACKAGE_NAME = "@sous-io/sous";

/** The flag spelling the non-interactive error names. */
const YES_FLAG = "--yes (also -y, --force)";

/** The flags that answer what happens to the included files. */
const INCLUDE_FLAGS = "--move-includes, --copy-includes, --leave-includes or --yes";

/**
 * A project set up inside another one is a real choice, not a mistake sous should prevent: a
 * subproject may want its own instructions. So when a project above the target already has a
 * config, the facts are stated and the question is asked once; `yes` answers it ahead of time.
 *
 * @throws NonInteractiveError when it has to ask and cannot, and ConfigError on a no.
 */
async function confirmNesting(ctx: Context, root: string, yes: boolean): Promise<void> {
    const enclosing = findEnclosingProject(ctx, root);

    if (enclosing === undefined) {
        return;
    }

    ctx.reporter.problem(`${root} is inside a project that is already set up for sous.`, {
        subject: root,
        cause: `The enclosing project's config is ${enclosing.configPath}. Setting this directory up too gives it a config of its own: commands run here will find this one, and commands run from ${enclosing.root} will keep finding the other.`,
    });

    if (yes) {
        return;
    }

    const proceed = await ctx.prompter.confirm({
        message: `Set up ${root} as a project of its own?`,
        default: false,
        answeredBy: YES_FLAG,
    });

    if (!proceed) {
        throw new ConfigError(`Nothing was written. Run 'sous init' from a directory outside ${enclosing.root}, or pass --yes to set this one up anyway.`);
    }
}

/** The include answer the flags give, if any. */
function flaggedFate(input: InitInput): IncludeFate | undefined {
    const flagged = [
        ...(input.moveIncludes === true ? (["move"] as const) : []),
        ...(input.copyIncludes === true ? (["copy"] as const) : []),
        ...(input.leaveIncludes === true ? (["leave"] as const) : []),
    ];

    if (flagged.length > 1) {
        throw new ConfigError("Pass only one of --move-includes, --copy-includes and --leave-includes.", {
            details: ["Each one says what happens to every file the existing instructions include, so two of them contradict each other."],
        });
    }

    return flagged[0];
}

/** Lists the included files, nested under the files that include them, before the question. */
function reportIncludes(ctx: Context, scan: ImportScan): void {
    const relative = (file: string) => path.relative(scan.root, file) || file;

    ctx.reporter.operationStart("Files the existing instructions include");

    for (const file of scan.includes) {
        const by = file.includedBy.map(relative).join(", ");

        ctx.reporter.detail(`${file.relative}, included by ${by}${file.pinned === undefined ? "" : ` (stays where it is: ${file.pinned})`}`);
    }
}

/**
 * What happens to the files the existing instructions include: the flag's answer, the default
 * (move) under `yes` or in a dry run, or the user's answer.
 *
 * @throws NonInteractiveError when it has to ask and cannot.
 */
async function includeAnswer(ctx: Context, input: InitInput, scan: ImportScan, dryRun: boolean): Promise<IncludeFate | "choose"> {
    const flagged = flaggedFate(input);
    const movable = scan.includes.filter((file) => file.pinned === undefined);

    if (flagged !== undefined) {
        return flagged;
    }

    if (movable.length === 0 || input.yes === true || dryRun) {
        return "move";
    }

    reportIncludes(ctx, scan);

    return ctx.prompter.askChoice<IncludeFate | "choose">({
        message: `What should happen to the ${movable.length === 1 ? "included file" : `${movable.length} included files`}?`,
        choices: [
            { label: "Move them into .sous/", value: "move", description: `to .sous/${INCLUDES_DIR}/, keeping their paths; each original is backed up, then removed` },
            { label: "Copy them into .sous/", value: "copy", description: "the originals stay, so the two copies can drift apart" },
            { label: "Leave them where they are", value: "leave", description: "sous includes them from where they are at every build" },
            { label: "Choose for each file", value: "choose" },
        ],
        defaultIndex: 0,
        answeredBy: INCLUDE_FLAGS,
    });
}

/** Asks what happens to one included file. */
function askForFile(ctx: Context): (file: IncludedFile) => Promise<IncludeFate> {
    return (file) =>
        ctx.prompter.askChoice<IncludeFate>({
            message: `What should happen to ${file.relative}?`,
            choices: [
                { label: "Move it into .sous/", value: "move" },
                { label: "Copy it into .sous/", value: "copy" },
                { label: "Leave it where it is", value: "leave" },
            ],
            defaultIndex: 0,
            answeredBy: INCLUDE_FLAGS,
        });
}

/**
 * Stops git tracking the paths that are now build output (the root instruction files) or moved
 * (the skill folders), keeping the files on disk. Does nothing outside a git working tree, or
 * without git. Returns the paths git stopped tracking, relative to the project root.
 */
async function untrack(ctx: Context, root: string, paths: readonly string[], dryRun: boolean): Promise<string[]> {
    if (paths.length === 0 || !ctx.services.has("git.runner")) {
        return [];
    }

    const git = ctx.services.get("git.runner") as GitRunner;
    const inside = await git.run(["rev-parse", "--is-inside-work-tree"], { cwd: root, reject: false });

    if (inside.exitCode !== 0 || inside.stdout.trim() !== "true") {
        return [];
    }

    const listed = await git.run(["ls-files", "--", ...paths], { cwd: root, reject: false });
    const tracked = paths.filter((candidate) => listed.stdout.split("\n").some((line: string) => line === candidate || line.startsWith(`${candidate}/`)));

    if (tracked.length > 0 && !dryRun) {
        await git.run(["rm", "-r", "--cached", "--quiet", "--", ...tracked], { cwd: root });
    }

    return tracked;
}

/** The "Dependency" row: where sous sits in `package.json`, or nothing without one. */
function dependencyRow(outcome: PackageJsonOutcome): VariableEntry[] {
    if (outcome.kind === "no-package-json") {
        return [];
    }

    const value = `${SOUS_PACKAGE_NAME} ${outcome.range}`;

    if (outcome.kind === "already-declared") {
        return [{ label: "Dependency", value, detail: `already in ${outcome.section} in package.json` }];
    }

    return [{ label: "Dependency", value, detail: "added to devDependencies in package.json; run your package manager's install to fetch it" }];
}

/** Reports what the import did (or, in a dry run, would do). */
function reportImport(ctx: Context, root: string, outcome: ImportOutcome, untracked: readonly string[], dryRun: boolean): void {
    if (outcome.steps.length === 0 && untracked.length === 0) {
        return;
    }

    const relative = (file: string) => path.relative(root, file) || file;
    const would = (done: string, planned: string) => (dryRun ? planned : done);

    ctx.reporter.operationStart("Importing the project's agent files");

    for (const step of outcome.steps) {
        const backup = step.backup === undefined ? "" : `; ${would("backed up to", "would back up to")} ${relative(step.backup)}`;

        switch (step.kind) {
            case "imported":
                ctx.reporter.operation(dryRun ? "would-write" : "written", relative(step.dest!), { note: `${would("imported from", "would import from")} ${relative(step.source)}${backup}` });
                ctx.reporter.operation(dryRun ? "would-remove" : "removed", relative(step.source), { note: `${would("moved", "would move")} into .sous/; a build no longer writes it` });
                break;
            case "moved":
                ctx.reporter.operation(dryRun ? "would-write" : "written", relative(step.dest!), { note: `${would("moved from", "would move from")} ${relative(step.source)}${backup}` });
                break;
            case "copied":
                ctx.reporter.operation(dryRun ? "would-write" : "written", relative(step.dest!), { note: `${would("copied from", "would copy from")} ${relative(step.source)}; the original stays` });
                break;
            case "left":
                ctx.reporter.operation("skipped", relative(step.source), { note: step.note ?? "left where it is; sous includes it from there" });
                break;
            case "skipped":
                if (step.backup === undefined) {
                    ctx.reporter.operation("skipped", relative(step.source), { note: `not imported: ${step.note}` });
                } else {
                    ctx.reporter.operation(dryRun ? "would-remove" : "removed", relative(step.source), { note: `not imported: ${step.note}${backup}` });
                }
                break;
            case "turned-off":
                ctx.reporter.warn(`${relative(step.source)}: ${step.note}.`);
                break;
        }
    }

    for (const file of untracked) {
        ctx.reporter.operation(dryRun ? "would-remove" : "removed", file, { note: `${would("git no longer tracks it", "git would stop tracking it")}; the file stays on disk` });
    }
}

/**
 * Reports the files written (or, in a dry run, that would be), the ones kept and the `package.json`
 * change, relative to the project root. Returns whether anything was done.
 */
function reportFiles(ctx: Context, result: InitResult): boolean {
    const added = result.packageJson.kind === "added" ? result.packageJson : undefined;
    const packageJsonFile = path.join(result.root, "package.json");
    const imported = new Set(result.imported);
    const files = result.files.filter((file) => !(added && file === packageJsonFile) && !imported.has(file));
    const anythingDone = files.length > 0 || result.kept.length > 0 || added !== undefined || result.imported.length > 0;

    if (files.length > 0 || result.kept.length > 0 || added !== undefined) {
        ctx.reporter.operationStart("Setting up the project");
    }

    for (const file of files) {
        ctx.reporter.operation(result.dryRun ? "would-write" : "written", path.relative(result.root, file) || file);
    }

    for (const file of result.kept) {
        ctx.reporter.operation("skipped", path.relative(result.root, file) || file, { note: "kept, because it already exists" });
    }

    if (added) {
        const what = `${SOUS_PACKAGE_NAME} ${added.range} to devDependencies`;

        ctx.reporter.operation(result.dryRun ? "would-write" : "written", "package.json", { note: result.dryRun ? `would add ${what}` : `added ${what}` });
    }

    return anythingDone;
}

/** Runs the intent. */
export async function handle(input: InitInput, ctx: Context): Promise<IntentOutputs<InitResult>> {
    const dryRun = input.dryRun === true;
    const root = path.resolve(ctx.cwd, input.directory ?? ".");
    const name = (input.name ?? path.basename(root)).trim() || path.basename(root);

    await confirmNesting(ctx, root, input.yes === true);
    assertNoExistingConfig(ctx, root);

    // Planned and answered before anything is written, so a "no" or a missing flag writes nothing.
    const scan = scanImport(root, sousDirFor(root));
    const answer = await includeAnswer(ctx, input, scan, dryRun);
    const fates = await settleFates(scan, answer, askForFile(ctx));

    const scaffold = await scaffoldProject(ctx, { root, name, dryRun, starterMemory: scan.instructions.length === 0 });
    const imported = applyImport(scan, fates, { dryRun });
    const untracked = await untrack(ctx, root, imported.untrack, dryRun);

    reportImport(ctx, root, imported, untracked, dryRun);

    const result: InitResult = {
        root,
        sousDir: scaffold.sousDir,
        configPath: scaffold.configPath,
        files: [...scaffold.files, ...imported.written],
        kept: scaffold.kept,
        imported: imported.written,
        removed: imported.removed,
        untracked,
        packageJson: scaffold.packageJson,
        dryRun,
    };

    const anythingDone = reportFiles(ctx, result);

    if (dryRun) {
        return anythingDone
            ? new IntentOutputs<InitResult>(
                  new IntentOutput({
                      result: new TextBlock("Nothing was written. Run the same command without '--dry-run' to set the project up."),
                      style: ReportEntryStyle.DryRun,
                      data: result,
                  }),
              )
            : IntentOutputs.of<InitResult>(result);
    }

    if (input.noBuild) {
        return new IntentOutputs<InitResult>([...whatWasSetUp(result)]);
    }

    // The build must read the config just written: rebuild it for the rest of this chain.
    ctx.configChanged();

    if (ctx.chain !== undefined && !ctx.chain.parallel) {
        await ctx.refreshConfig({ locateProjectFrom: root });
    }

    const built = await ctx.run("build", {});
    const build = built.toPlain();

    if (!build.ok) {
        throw new ConfigError(
            "The project is set up, but the first build failed, so its outputs may be incomplete. Everything 'sous init' wrote is in place; fix what the build reported above and run 'sous build' again.",
        );
    }

    return new IntentOutputs<InitResult>([...built.toArray(), ...whatWasSetUp({ ...result, build })]);
}

/** The closing outputs: what was set up, then the note about build output. The last carries the result. */
function whatWasSetUp(result: InitResult): IntentOutput[] {
    return [
        new IntentOutput({
            title: "What was set up",
            result: new VariableSet([
                { label: "Config", value: result.configPath },
                { label: "Memories", value: path.join(result.sousDir, MEMORIES_SOURCE_RELATIVE_PATH), detail: "what the memories file includes, and in what order" },
                { label: "Project memories", value: path.join(result.sousDir, "memories") },
                { label: "Skills", value: path.join(result.root, ".claude", "skills") },
                ...dependencyRow(result.packageJson),
                { label: "Shared answers", value: path.join(result.sousDir, ".env"), detail: "committed" },
                { label: "Local answers", value: path.join(result.sousDir, ".env.local"), detail: "gitignored; .env.local.example shows the layout" },
            ]),
        }),
        new IntentOutput({
            summary: `The memories file and .claude/skills/ are build output, gitignored and compiled from the sources under .sous/ and from the recipes this project subscribes to; a build recompiles them. The config explains each of its blocks in its own comments.`,
            data: result,
        }),
    ];
}

export default handle;
