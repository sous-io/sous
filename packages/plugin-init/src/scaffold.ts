/**
 * Scaffolding a project's `.sous/` directory, which is what `sous init` does.
 *
 * The scaffold is planned in memory first and only then written. It refuses to touch a project that
 * is already set up: a `.sous/` directory holding a primary config is left exactly as it is. Any
 * other file the scaffold would write that already exists is kept as it is and reported. Two files
 * are merged rather than replaced: `.sous/.gitignore`, whose sous-managed block is applied by
 * `host.gitignore`, so running the scaffold over an existing ignore file never duplicates an entry;
 * and the project's `package.json`, when there is one.
 *
 * Once written, the config is read back through `config-files.loader`, so a scaffold sous itself
 * cannot load is never reported as a success.
 */

import fs from "node:fs";
import path from "node:path";
import { ConfigError, type Context } from "@sous-io/plugin-api";
import "@sous-io/plugin-config-files/types";
import "@sous-io/plugin-host/types";
import { planPackageJson } from "./package-json.js";
import {
    buildConfig,
    buildEnvDefaults,
    buildEnvLocalExample,
    buildStarterPrompt,
    CONFD_DIR_NAME,
    CONFIG_FILE_NAMES,
    ENV_DEFAULTS_NAME,
    ENV_LOCAL_NAME,
    SOUS_DIR_NAME,
    STARTER_PROMPT_RELATIVE_PATH,
    type ScaffoldContext,
} from "./templates.js";
import type { InitConfigFormat, PackageJsonOutcome } from "./types.js";

/** The lines of the sous-managed block in `.sous/.gitignore`: what stays on this machine. */
export const IGNORE_BLOCK_LINES: readonly string[] = ["sous.links.json", "sous.state.json", "sous.pid", ENV_LOCAL_NAME, "repos/"];

/** What to scaffold, and where. */
export interface ScaffoldOptions {
    /** The project root; the `.sous/` directory goes inside it. */
    root: string;
    format: InitConfigFormat;
    name: string;
    dryRun: boolean;
}

/** What a scaffold did. */
export interface ScaffoldOutcome {
    readonly sousDir: string;
    readonly configPath: string;
    /** Every file written (or, in a dry run, that would be), absolute. */
    readonly files: string[];
    /** Files left as they were because they existed. */
    readonly kept: string[];
    readonly packageJson: PackageJsonOutcome;
}

/** The `.sous/` directory a project root would hold. */
export function sousDirFor(root: string): string {
    return path.join(path.resolve(root), SOUS_DIR_NAME);
}

/** The directories from `start` up to the filesystem root. */
export function ancestors(start: string): string[] {
    const found: string[] = [];
    let directory = path.resolve(start);

    for (;;) {
        found.push(directory);

        const parent = path.dirname(directory);

        if (parent === directory) {
            return found;
        }

        directory = parent;
    }
}

/**
 * Refuses to scaffold a `.sous/` directory that already holds a primary config. The config is what
 * makes a directory a sous project, so that is what is checked; a `.sous/` holding only, say, task
 * files is a fine place to set one up.
 *
 * @throws ConfigError when a config is there.
 */
export function assertNoExistingConfig(ctx: Context, root: string): void {
    const existing = ctx.services.get("config-files.loader").findMain(sousDirFor(root));

    if (existing !== undefined) {
        throw new ConfigError(`${root} is already set up for sous.`, {
            details: [`${existing} exists, and sous will not overwrite it.`, "Edit that config instead, or run 'sous init' in another directory."],
        });
    }
}

/**
 * The config of the nearest project above `root`, when `root` would sit inside one; its project
 * root comes with it.
 */
export function findEnclosingProject(ctx: Context, root: string): { root: string; configPath: string } | undefined {
    const loader = ctx.services.get("config-files.loader");

    for (const directory of ancestors(root).slice(1)) {
        const configPath = loader.findMain(sousDirFor(directory));

        if (configPath !== undefined) {
            return { root: directory, configPath };
        }
    }

    return undefined;
}

/**
 * Writes the scaffold (or, in a dry run, works out what it would write).
 *
 * @throws ConfigError when a config is already there, the package.json cannot be read, or the
 *   written config does not load.
 */
export async function scaffoldProject(ctx: Context, options: ScaffoldOptions): Promise<ScaffoldOutcome> {
    const identity = ctx.services.get("host.package").identity();
    const root = path.resolve(options.root);
    const sousDir = sousDirFor(root);
    const configPath = path.join(sousDir, CONFIG_FILE_NAMES[options.format]);
    const context: ScaffoldContext = { name: options.name, sousVersion: identity.version };

    assertNoExistingConfig(ctx, root);

    // Planned first, so a package.json that cannot be read stops the run before anything is written.
    const dependency = planPackageJson(root, identity.name, identity.version);
    const planned: Array<{ file: string; contents: string }> = [
        { file: configPath, contents: buildConfig(options.format, context) },
        { file: path.join(sousDir, STARTER_PROMPT_RELATIVE_PATH), contents: buildStarterPrompt(context) },
        { file: path.join(sousDir, ENV_DEFAULTS_NAME), contents: buildEnvDefaults(context) },
        { file: path.join(sousDir, `${ENV_LOCAL_NAME}.example`), contents: buildEnvLocalExample(context) },
    ];
    const files: string[] = [];
    const kept: string[] = [];

    if (!options.dryRun) {
        // sous's own directories, each with its README and pointer files.
        for (const [kind, directory] of [["sous-dir", sousDir], ["confd", path.join(sousDir, CONFD_DIR_NAME)]] as const) {
            const ensured = await ctx.services.get("host.directories").ensureKnown(kind, directory);

            files.push(...ensured.wrote.map((name) => path.join(ensured.path, name)));
        }
    }

    for (const { file, contents } of planned) {
        if (fs.existsSync(file)) {
            kept.push(file);
            continue;
        }

        if (!options.dryRun) {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, contents, "utf8");
        }

        files.push(file);
    }

    const ignore = await ctx.services.get("host.gitignore").write(path.join(sousDir, ".gitignore"), IGNORE_BLOCK_LINES, { dryRun: options.dryRun });

    if (ignore.changed) {
        files.push(ignore.file);
    }

    if (dependency.contents !== undefined && dependency.file !== undefined) {
        if (!options.dryRun) {
            fs.writeFileSync(dependency.file, dependency.contents, "utf8");
        }

        files.push(dependency.file);
    }

    if (!options.dryRun && !kept.includes(configPath)) {
        await verifyScaffold(ctx, configPath);
    }

    return { sousDir, configPath, files, kept, packageJson: dependency.outcome };
}

/**
 * Loads the written config through the loader every build uses, so the scaffold is never reported
 * as a success unless sous can actually read it. A failure here is a bug in the scaffold, and is
 * reported as one.
 */
async function verifyScaffold(ctx: Context, configPath: string): Promise<void> {
    try {
        await ctx.services.get("config-files.loader").load(configPath);
    } catch (error) {
        throw new ConfigError(`The config 'sous init' wrote at ${configPath} does not load.`, {
            details: ["This is a bug in sous; please report it. The loader said:", ...(error instanceof Error ? error.message : String(error)).split("\n").map((line) => `  ${line}`)],
            cause: error,
        });
    }
}
