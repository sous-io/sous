/**
 * plugin-config-files: sous.config.* as a contributor, config.set, and the .env files.
 *
 * The contract other plugins code against is `./types.ts`.
 */

import fs from "node:fs";
import path from "node:path";
import { type ConfigBuilder, ConfigError, type ContributorDefinition, definePlugin, jsonSchema, type PluginDefinition, type Sous } from "@sous-io/plugin-api";
import { EnvFilesService } from "./env/service.js";
import { ConfigFilesLoaderImpl, mainCandidates } from "./loader.js";
import { MAIN_CONFIG_BASE_NAME } from "./names.js";
import { CONFIG_SET, configSet } from "./set.js";
import type { ConfigSetInput } from "./types.js";
import "./types.js";
import packageJson from "../package.json" with { type: "json" };

/** The plugin's name. */
export const PLUGIN_NAME = "@sous-io/plugin-config-files";

/** The id of the `sous.config.*` contributor. */
export const MAIN_CONTRIBUTOR = "config-files.main";

/** The prefix of the contributors for the patch files beside `sous.config.*`: `config-files/sous.config.patch.json`. */
export const PATCH_CONTRIBUTOR_PREFIX = "config-files/";

/**
 * The apply order of `sous.config.*` and its patch files. Every plugin's contributor uses a lower
 * number, so the user's files apply after them and win; `conf.d` files use 90000 plus the number
 * their names start with, so they apply after these.
 */
export const MAIN_APPLY_ORDER = 89900;

/** The plugin. */
export const configFilesPlugin: PluginDefinition = definePlugin({
    name: PLUGIN_NAME,
    version: packageJson.version,
    description: "sous.config.* as a contributor, config.set, and the .env files.",
    dependsOn: {
        "@sous-io/plugin-expressions": `^${packageJson.version}`,
        "@sous-io/plugin-variables": `^${packageJson.version}`,
        "@sous-io/plugin-host": `^${packageJson.version}`,
    },

    register(sous) {
        const loader = createLoader(sous);

        sous.services.add("config-files.loader", () => loader, { lifetime: "singleton" });
        sous.services.add("config-files.env", (_config, ctx) => new EnvFilesService(ctx.project, ctx.env), { lifetime: "singleton" });

        sous.config.contribute(mainContributor(loader));

        // The patch files beside sous.config.*, in name order. They share its apply order, and their
        // ids (`config-files/…`) sort after `config-files.main` and in file-name order.
        if (sous.project !== undefined) {
            for (const file of loader.findPatches(sous.project.sousDir, MAIN_CONFIG_BASE_NAME)) {
                sous.config.contribute(fileContributor(loader, file, `${PATCH_CONTRIBUTOR_PREFIX}${path.basename(file)}`));
            }
        }

        sous.intents.add({
            intent: CONFIG_SET,
            requiresProject: true,
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
            handle: (input: ConfigSetInput, ctx) => configSet(input, ctx),
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
        // Read on each use: `sous init` sets a project up after the engine started without one.
        get project() {
            return sous.project;
        },
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
 * re-runs whenever anything changes; its apply order puts its patch after every plugin's, so it
 * wins whatever a plugin set.
 */
function mainContributor(loader: ConfigFilesLoaderImpl): ContributorDefinition {
    return {
        id: MAIN_CONTRIBUTOR,
        applyOrder: MAIN_APPLY_ORDER,
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
                    throw new ConfigError(`Duplicate config file baseName '${MAIN_CONFIG_BASE_NAME}':`, {
                        details: [
                            ...candidates.map((candidate) => `  ${candidate}`),
                            "Two config files in one directory must not share a name once the final extension is removed. Delete or rename one of them.",
                        ],
                    });
                }

                // A file is read from disk once per build.
                loader.forget(file);
            }

            await applyFile(loader, file, config);
        },
    };
}

/** A contributor that applies one file, read once per build. A file that is gone contributes nothing. */
export function fileContributor(loader: ConfigFilesLoaderImpl, file: string, id: string): ContributorDefinition {
    const format = loader.formatOf(path.basename(file));
    const isPatch = format === "patch-json" || format === "patch-jsonl";

    return {
        id,
        applyOrder: MAIN_APPLY_ORDER,
        // A patch file reads nothing, so it watches everything to re-apply after every change.
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
