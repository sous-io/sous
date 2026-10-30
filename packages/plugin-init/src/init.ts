/**
 * The `init` intent: sets a project up for sous. It writes the `.sous/` directory a project needs
 * (a commented primary config, the starter prompt that config compiles, the two answers files and
 * the sous-managed ignore block), then runs the first build through the one build path, which is
 * what seeds the `core` recipe and pins it in the lockfile.
 *
 * Every question has a flag (L4): setting a project up inside another one is answered by `yes`.
 * Nothing prints or prompts directly (L3).
 */

import path from "node:path";
import { ConfigError, InputError, type Context } from "@sous-io/plugin-api";
import "@sous-io/plugin-build/types";
import { findEnclosingProject, scaffoldProject } from "./scaffold.js";
import { INIT_CONFIG_FORMATS } from "./templates.js";
import type { InitInput, InitResult } from "./types.js";

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

    ctx.reporter.warning(`${root} is inside a project that is already set up for sous.`, { enclosing: enclosing.root, config: enclosing.configPath });
    ctx.reporter.warning(
        `The enclosing project's config is ${enclosing.configPath}. Setting this directory up too gives it a config of its own: commands run here will find this one, and commands run from ${enclosing.root} will keep finding the other.`,
    );

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

/** Runs the intent. */
export async function handle(input: InitInput, ctx: Context): Promise<InitResult> {
    const format = input.format ?? INIT_CONFIG_FORMATS[0];

    if (!(INIT_CONFIG_FORMATS as readonly string[]).includes(format)) {
        throw new InputError("init", [{ path: "format", message: `must be one of ${INIT_CONFIG_FORMATS.join(", ")}` }]);
    }

    const dryRun = input.dryRun === true;
    const root = path.resolve(ctx.cwd, input.directory ?? ".");
    const name = (input.name ?? path.basename(root)).trim() || path.basename(root);

    await confirmNesting(ctx, root, input.yes === true);

    const scaffold = await scaffoldProject(ctx, { root, format, name, dryRun });

    for (const file of scaffold.files) {
        ctx.reporter.note(`${dryRun ? "Would write" : "Wrote"} ${file}`);
    }

    for (const file of scaffold.kept) {
        ctx.reporter.note(`Kept ${file}, which already exists.`);
    }

    const result = {
        root,
        sousDir: scaffold.sousDir,
        configPath: scaffold.configPath,
        files: scaffold.files,
        kept: scaffold.kept,
        packageJson: scaffold.packageJson,
        dryRun,
    };

    if (dryRun) {
        ctx.reporter.note("Nothing was written. Run the same command without '--dry-run' to set the project up.");

        return result;
    }

    if (input.noBuild) {
        return result;
    }

    // The build must read the config just written: rebuild it for the rest of this chain.
    ctx.configChanged();

    if (ctx.chain !== undefined && !ctx.chain.parallel) {
        await ctx.refreshConfig({ locateProjectFrom: root });
    }

    const build = await ctx.run("build", {});

    if (!build.ok) {
        throw new ConfigError(
            "The project is set up, but the first build failed, so its outputs may be incomplete. Everything 'sous init' wrote is in place; fix what the build reported above and run 'sous build' again.",
        );
    }

    return { ...result, build };
}

export default handle;
