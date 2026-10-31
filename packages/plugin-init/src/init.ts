/**
 * The `init` intent: sets a project up for sous. It writes the `.sous/` directory a project needs
 * (a commented primary config (`sous.config.js`), the starter prompt that config compiles, the two answers files and
 * the sous-managed ignore block), then runs the first build through the one build path, which is
 * what seeds the `core` recipe and pins it in the lockfile.
 *
 * Every question has a flag: setting a project up inside another one is answered by `yes`.
 * Nothing prints or prompts directly.
 */

import path from "node:path";
import { ConfigError, type Context, IntentOutput, IntentOutputs, ReportEntryStyle, TextBlock, VariableSet, type VariableEntry } from "@sous-io/plugin-api";
import "@sous-io/plugin-build/types";
import { findEnclosingProject, scaffoldProject } from "./scaffold.js";
import { STARTER_OUTPUT_NAME, STARTER_PROMPT_RELATIVE_PATH } from "./templates.js";
import type { InitInput, InitResult, PackageJsonOutcome } from "./types.js";

/** The package `init` adds to a project's `package.json`. */
const SOUS_PACKAGE_NAME = "@sous-io/sous";

/** The flag spelling the non-interactive error names. */
const YES_FLAG = "--yes (also -y, --force)";

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

/**
 * Reports the files written (or, in a dry run, that would be), the ones kept and the `package.json`
 * change, relative to the project root. Returns whether anything was done.
 */
function reportFiles(ctx: Context, result: InitResult): boolean {
    const added = result.packageJson.kind === "added" ? result.packageJson : undefined;
    const packageJsonFile = path.join(result.root, "package.json");
    const files = result.files.filter((file) => !(added && file === packageJsonFile));
    const anythingDone = files.length > 0 || result.kept.length > 0 || added !== undefined;

    if (anythingDone) {
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

    const scaffold = await scaffoldProject(ctx, { root, name, dryRun });

    const result: InitResult = {
        root,
        sousDir: scaffold.sousDir,
        configPath: scaffold.configPath,
        files: scaffold.files,
        kept: scaffold.kept,
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
                { label: "Prompt source", value: path.join(result.sousDir, STARTER_PROMPT_RELATIVE_PATH) },
                { label: "Compiled to", value: path.join(result.root, STARTER_OUTPUT_NAME) },
                { label: "Skills", value: path.join(result.root, ".claude", "skills") },
                ...dependencyRow(result.packageJson),
                { label: "Shared answers", value: path.join(result.sousDir, ".env"), detail: "committed" },
                { label: "Local answers", value: path.join(result.sousDir, ".env.local"), detail: "gitignored; .env.local.example shows the layout" },
            ]),
        }),
        new IntentOutput({
            summary: `${STARTER_OUTPUT_NAME} and the skills directory are build output, compiled from the prompt source and from the recipes this project subscribes to; a build recompiles them. The config explains each of its blocks in its own comments.`,
            data: result,
        }),
    ];
}

export default handle;
