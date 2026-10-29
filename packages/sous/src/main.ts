import { readFileSync } from "node:fs";
import { createEngine } from "@sous-io/core";
import type { Environment } from "@sous-io/plugin-api";
import { isSousError } from "@sous-io/plugin-api";
import { BUILT_IN_PLUGINS } from "./built-ins.js";
import { findProject } from "./project.js";

declare const __SOUS_VERSION__: string | undefined;

/** The version of this package: set by the bundler, or read from package.json when run from source. */
export function sousVersion(): string {
    if (typeof __SOUS_VERSION__ === "string") {
        return __SOUS_VERSION__;
    }

    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

    return manifest.version;
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
 */
export async function main(argv: readonly string[], options: MainOptions): Promise<void> {
    const engine = createEngine({
        project: findProject(options.cwd),
        env: options.env,
        cwd: options.cwd,
        app: { name: "sous", version: sousVersion() },
        builtIns: BUILT_IN_PLUGINS,
    });

    try {
        await engine.buildConfig();
    } catch (error) {
        // The CLI front end is not running yet, so the bin reports a failed build itself.
        const message = error instanceof Error ? error.message : String(error);
        const details = isSousError(error) ? error.details.map((line) => `\n  ${line}`).join("") : "";

        options.stderr.write(`Error: ${message}${details}\n`);
        options.setExitCode(isSousError(error) ? error.exitCode : 1);

        return;
    }

    await engine.frontEnd("cli").start(argv);
    await engine.whenBackgroundIntentsReturn();
}
