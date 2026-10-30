import { readFileSync } from "node:fs";
import { type Budget, createEngine, DEFAULT_BUDGETS, type Engine } from "@sous-io/core";
import type { Environment, ProjectInfo, TimingCategory } from "@sous-io/plugin-api";
import { isSousError } from "@sous-io/plugin-api";
import { projectEnvironment } from "@sous-io/plugin-config-files";
import { BUILT_IN_PLUGINS } from "./built-ins.js";
import { findProject, locateProject, readOverrides } from "./project.js";

declare const __SOUS_VERSION__: string | undefined;

/**
 * The version of this package: the one its package.json (the directory above this module, in the
 * published layout and from source) states, which is the version npm installed; otherwise the one
 * the bundler set, for a bundle built outside the package's root.
 */
export function sousVersion(): string {
    try {
        const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { name?: unknown; version?: unknown };

        if (manifest.name === "@sous-io/sous" && typeof manifest.version === "string") {
            return manifest.version;
        }
    } catch {
        // No package.json beside the bundle: the version the bundler set.
    }

    return typeof __SOUS_VERSION__ === "string" ? __SOUS_VERSION__ : "0.0.0";
}

/** What {@link main} reads from the process; tests pass their own. */
export interface MainOptions {
    readonly cwd: string;
    readonly env: Environment;
    readonly stderr: { write(text: string): unknown };
    setExitCode(code: number): void;
}

/**
 * The whole of the bin (S1, "The Shape"): find the project, start the engine with the built-in
 * plugins, build the config, and hand argv to the CLI front end.
 *
 * The project is found from `--config`/`-c`/`--sous-config`/`--sous-dir`/`--sous-confd` and their
 * `SOUS_*` variables when given, else by walking up from the working directory; the project's
 * `.env` files fill in the environment before the engine starts. `SOUS_BUDGETS=off` turns every
 * time-budget warning off (the test suites set it, since busy test machines run slow).
 */
export async function main(argv: readonly string[], options: MainOptions): Promise<void> {
    const overrides = readOverrides(argv, options.env, options.cwd);
    let project: ProjectInfo | undefined;

    try {
        project = locateProject(options.cwd, overrides);
    } catch (error) {
        options.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
        options.setExitCode(1);

        return;
    }

    const engine = createEngine({
        project,
        env: projectEnvironment(project, options.env),
        cwd: options.cwd,
        app: { name: "sous", version: sousVersion() },
        builtIns: BUILT_IN_PLUGINS,
        budgets: budgetsOff(options.env.SOUS_BUDGETS) ? noBudgets() : undefined,
        locateProject: (directory) => findProject(directory, overrides.confDir),
    });

    try {
        await engine.buildConfig();
    } catch (error) {
        // A failed build still reaches the CLI when the partial config has it: the CLI reports the
        // error for every command except one that can run without the config (`sous update`).
        if (hasFrontEnd(engine, "cli")) {
            await engine.frontEnd("cli").start(argv);
            await engine.whenBackgroundIntentsReturn();

            return;
        }

        // The CLI front end is not available, so the bin reports a failed build itself.
        const message = error instanceof Error ? error.message : String(error);
        const details = isSousError(error) ? error.details.map((line) => `\n  ${line}`).join("") : "";

        options.stderr.write(`Error: ${message}${details}\n`);
        options.setExitCode(isSousError(error) ? error.exitCode : 1);

        return;
    }

    await engine.frontEnd("cli").start(argv);
    await engine.whenBackgroundIntentsReturn();
}

/** Whether `SOUS_BUDGETS` turns the time budgets off. */
function budgetsOff(value: string | undefined): boolean {
    return ["0", "false", "no", "off"].includes((value ?? "").trim().toLowerCase());
}

/** Every timing category with its warning turned off. */
function noBudgets(): Partial<Record<TimingCategory, Budget>> {
    return Object.fromEntries(Object.keys(DEFAULT_BUDGETS).map((category) => [category, false])) as Partial<Record<TimingCategory, Budget>>;
}

/** Whether an active plugin adds a front end. */
function hasFrontEnd(engine: Engine, id: string): boolean {
    try {
        engine.frontEnd(id);

        return true;
    } catch {
        return false;
    }
}
