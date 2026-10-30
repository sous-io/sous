/**
 * plugin-config-files: sous.config.* as a contributor, config.set, and the .env files.
 *
 * S6, "Config files: plugin-config-files and plugin-confd". The contract other plugins code against is `./types.ts`.
 */

import fs from "node:fs";
import path from "node:path";
import { type ConfigBuilder, type ContributorDefinition, definePlugin, jsonSchema, type PluginDefinition, type Sous } from "@sous-io/plugin-api";
import { EnvFilesService } from "./env/service.js";
import { ConfigFilesLoaderImpl, mainCandidates } from "./loader.js";
import { MAIN_CONFIG_BASE_NAME } from "./names.js";
import { CONFIG_SET, configSet } from "./set.js";
import type { ConfigSetInput, ConfigSetResult } from "./types.js";
import "./types.js";

/** The plugin's name. */
export const PLUGIN_NAME = "@sous-io/plugin-config-files";

/** The id of the `sous.config.*` contributor. */
export const MAIN_CONTRIBUTOR = "config-files.main";

/** The prefix of the contributors for the patch files beside `sous.config.*`: `config-files/sous.config.patch.json`. */
export const PATCH_CONTRIBUTOR_PREFIX = "config-files/";

/**
 * `*` in `after`: after every contributor that is not one of the user's files, in its stage. The
 * user's files declare it, then their own chain, so their patches land on top.
 */
export const EVERY_CONTRIBUTOR = "*";

/** The plugin. */
export const configFilesPlugin: PluginDefinition = definePlugin({
    name: PLUGIN_NAME,
    version: "0.2.34",
    description: "sous.config.* as a contributor, config.set, and the .env files.",
    dependsOn: {
        "@sous-io/plugin-expressions": "^0.2.34",
        "@sous-io/plugin-variables": "^0.2.34",
        "@sous-io/plugin-host": "^0.2.34",
    },

    register(sous) {
        const loader = createLoader(sous);

        sous.services.add("config-files.loader", () => loader, { lifetime: "singleton" });
        sous.services.add("config-files.env", (_config, ctx) => new EnvFilesService(ctx.project, ctx.env), { lifetime: "singleton" });

        sous.config.contribute(mainContributor(loader));

        // The patch files beside sous.config.*, each after the one before (S2, "Patch files").
        if (sous.project !== undefined) {
            let previous = MAIN_CONTRIBUTOR;

            for (const file of loader.findPatches(sous.project.sousDir, MAIN_CONFIG_BASE_NAME)) {
                const id = `${PATCH_CONTRIBUTOR_PREFIX}${path.basename(file)}`;

                sous.config.contribute(fileContributor(loader, file, id, [EVERY_CONTRIBUTOR, previous]));
                previous = id;
            }
        }

        sous.intents.add({
            intent: CONFIG_SET,
            summary: "Set one value in a config file",
            description:
                "Writes one value into sous.config.* (or the file --file names), changing only that key: comments, key order and formatting stay. The value is read as JSON when it is valid JSON, else as text.",
            input: jsonSchema<ConfigSetInput>({
                type: "object",
                properties: {
                    path: { type: "string", description: 'The key path: compilation.includeSourceComments, subscriptions."workflow/x".enabled.' },
                    value: { type: "string", description: "The value: JSON when it is valid JSON, else text." },
                    unset: { type: "boolean", description: "Remove the key instead." },
                    file: { type: "string", description: "The file to write: a conf.d file name, or a path from the project root. Default: sous.config.*." },
                    dryRun: { type: "boolean", description: "Show what would change, writing nothing." },
                },
                required: ["path"],
            }),
            changesConfig: true,
            cli: {
                command: ["config", "set"],
                positional: ["path", "value"],
                examples: [
                    "sous config set compilation.includeSourceComments false",
                    'sous config set subscriptions."workflow/x".enabled false --file 610-mac.jsonc',
                    "sous config set name --unset",
                ],
            },
            agent: {
                tool: "sous_config_set",
                usage: "Call this to change one config value without rewriting the file.",
                whenNotToUse: "Not for subscriptions or repositories: use their own intents, which keep the lockfile in step.",
            },
            handle: (input: ConfigSetInput, ctx): Promise<ConfigSetResult> => configSet(input, ctx),
        });

        sous.entities.add("config-key", {
            id: "$schema",
            description: "The JSON Schema the file declares, for editors. Sous ignores it.",
            schema: jsonSchema({ type: "string" }),
        });
        sous.entities.add("config-key", {
            id: "version",
            description: "The config format version. This sous understands version 1.",
            schema: jsonSchema({ const: 1 }),
        });
        sous.entities.add("config-key", {
            id: "name",
            description: "A display name for the project.",
            schema: jsonSchema({ type: "string" }),
        });
    },
});

/** The loader, wired to the services it uses, each looked up when needed. */
function createLoader(sous: Sous): ConfigFilesLoaderImpl {
    return new ConfigFilesLoaderImpl({
        project: sous.project,
        globs: () => sous.services.get("host.globs"),
        evaluator: () => (sous.services.has("expressions.evaluator") ? sous.services.get("expressions.evaluator") : undefined),
        pathVariables: () => {
            const variables: Record<string, string> = {};

            if (sous.project !== undefined) {
                variables.sousDir = sous.project.sousDir;
                variables.sousConfDir = sous.project.confDir;
            }

            if (sous.services.has("host.package")) {
                const identity = sous.services.get("host.package").identity();

                variables.sousRootPath = identity.root;
                variables.sousVersion = identity.version;
            }

            return variables;
        },
    });
}

/**
 * `config-files.main`: `sous.config.*` as one merge at the root, so it monitors the whole config and
 * re-runs whenever anything changes; declared after every other contributor, its patch lands on top
 * whatever a plugin set.
 */
function mainContributor(loader: ConfigFilesLoaderImpl): ContributorDefinition {
    return {
        id: MAIN_CONTRIBUTOR,
        after: [EVERY_CONTRIBUTOR],
        async contribute(config) {
            const project = config.project;

            if (project === undefined) {
                return;
            }

            const candidates = mainCandidates(project.sousDir);
            const file = project.configPath ?? candidates[0];

            if (file === undefined) {
                return;
            }

            if (config.contributor.run === 1) {
                if (candidates.length > 1) {
                    config.log(
                        "warning",
                        `${project.sousDir} holds ${candidates.length} main config files (${candidates.map((c) => path.basename(c)).join(", ")}); only ${path.basename(file)} is read. Move the others into conf.d or delete them.`,
                    );
                }

                // A file is read from disk once per build (S2).
                loader.forget(file);
            }

            await applyFile(loader, file, config);
        },
    };
}

/** A contributor that applies one file, read once per build. A file that is gone contributes nothing. */
export function fileContributor(loader: ConfigFilesLoaderImpl, file: string, id: string, after: readonly string[]): ContributorDefinition {
    const format = loader.formatOf(path.basename(file));
    const isPatch = format === "patch-json" || format === "patch-jsonl";

    return {
        id,
        after,
        // A patch file reads nothing, so it watches everything to keep landing on top (S2).
        ...(isPatch ? { monitors: [""] } : {}),
        async contribute(config) {
            if (config.contributor.run === 1) {
                loader.forget(file);
            }

            await applyFile(loader, file, config);
        },
    };
}

async function applyFile(loader: ConfigFilesLoaderImpl, file: string, config: ConfigBuilder): Promise<void> {
    if (!isFile(file)) {
        return;
    }

    await loader.contribute(await loader.load(file), config);
}

function isFile(file: string): boolean {
    try {
        return fs.statSync(file).isFile();
    } catch {
        return false;
    }
}

export default configFilesPlugin;

export { parseEnv } from "./env/env-file.js";
export { projectEnvironment } from "./env/load.js";
export { MAIN_CONFIG_FILE_NAMES, formatOf } from "./names.js";

export type * from "./types.js";
