/**
 * An engine with the doctor and migrations plugins, a stand-in for the lockfile's owner
 * (`recipes.lock`) that keeps the lockfile in memory, and a plugin that adds the migrations a
 * test gives it through `sous.migrations.add`.
 */

import { BufferedReporter, definePlugin, type Prompter, type Sous } from "@sous-io/plugin-api";
import { createEngine } from "@sous-io/core";
import type { Lockfile } from "@sous-io/plugin-formats/types";
import { doctorPlugin } from "@sous-io/sous-plugin-doctor";
import { migrationsPlugin } from "../src/index.js";
import type { MigrationDefinition } from "../src/types.js";

/** The in-memory lockfile; `undefined` means the project has none yet. */
export interface LockState {
    lockfile: Lockfile | undefined;
}

/** A lockfile with nothing pinned. */
export function emptyLock(migratedVersion?: string): Lockfile {
    return { formatVersion: 1, repos: {}, recipes: {}, ...(migratedVersion === undefined ? {} : { migratedVersion }) };
}

/** Stands in for plugin-recipes' `recipes.lock`: only what migrations use. */
function lockPlugin(state: LockState) {
    return definePlugin({
        name: "test-lock",
        register(sous) {
            sous.services.add(
                "recipes.lock",
                () =>
                    ({
                        path: () => "/project/.sous/sous.lock.json",
                        read: () => state.lockfile ?? emptyLock(),
                        exists: () => state.lockfile !== undefined,
                        migratedVersion: () => state.lockfile?.migratedVersion,
                        setMigratedVersion: async (version: string) => {
                            state.lockfile = { ...(state.lockfile ?? emptyLock()), migratedVersion: version };
                        },
                    }) as never,
                { lifetime: "singleton" },
            );
        },
    });
}

/** A plugin that adds the migrations given, the way any plugin does. */
function adderPlugin(migrations: readonly MigrationDefinition[], extra?: (sous: Sous) => void) {
    return definePlugin({
        name: "test-adder",
        register(sous) {
            for (const migration of migrations) {
                sous.migrations.add(migration);
            }

            extra?.(sous);
        },
    });
}

/** An engine running sous `version`, with the migrations given. */
export async function engineWith(options: {
    version?: string;
    lock: LockState;
    migrations: readonly MigrationDefinition[];
    extra?: (sous: Sous) => void;
    /** The config fails to build (as one using an option a newer sous removed does); the engine keeps going, as the CLI does. */
    configFails?: boolean;
}) {
    const reporter = new BufferedReporter();
    const engine = createEngine({
        builtIns: [doctorPlugin, migrationsPlugin, lockPlugin(options.lock), adderPlugin(options.migrations, options.extra)],
        app: { name: "sous", version: options.version ?? "1.2.0" },
        project: { root: "/project", sousDir: "/project/.sous", configPath: "/project/.sous/sous.config.json", confDir: "/project/.sous/conf.d" },
        reporter,
    });

    await engine.buildConfig().catch((error: unknown) => {
        if (options.configFails !== true) {
            throw error;
        }
    });

    return {
        engine,
        reporter,
        submit: (intent: string, input: Record<string, unknown> = {}, prompter?: Prompter) =>
            engine.handle.submit({ intent: intent as never, input }, { reporter, ...(prompter === undefined ? {} : { prompter }) }),
    };
}
