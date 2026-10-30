/**
 * plugin-confd: The conf.d files, one contributor per file, and surgical edits to the managed conf.d/5xx files.
 *
 * The contract other plugins code against is `./types.ts`.
 */

import fs from "node:fs";
import path from "node:path";
import { ConfigError, type ContributorDefinition, definePlugin, type PluginDefinition, type Sous } from "@sous-io/plugin-api";
import type {} from "@sous-io/plugin-config-files/types";
import type {} from "@sous-io/plugin-host/types";
import { ConfdFilesImpl, contributorId, duplicateBaseNames, listConfdFiles } from "./files.js";
import { ConfdManagedImpl } from "./managed.js";
import type { ConfdFile } from "./types.js";
import "./types.js";

/** The plugin's name. */
export const PLUGIN_NAME = "@sous-io/plugin-confd";

/** The contributor of `sous.config.*`, which the first `conf.d` file runs after. */
const MAIN_CONTRIBUTOR = "config-files.main";

/** The patch files beside `sous.config.*`, which also run before `conf.d`. */
const MAIN_PATCH_CONTRIBUTORS = "config-files/*";

/** `*` in `after`: after every contributor that is not one of the user's files, so the files' patches land on top. */
const EVERY_CONTRIBUTOR = "*";

/** The id of the contributor that looks for `conf.d` files added since the plugin loaded. */
export const SCAN_CONTRIBUTOR = "confd.files";

/** The plugin. */
export const confdPlugin: PluginDefinition = definePlugin({
    name: PLUGIN_NAME,
    version: "0.2.34",
    description: "The conf.d files, one contributor per file, and surgical edits to the managed conf.d/5xx files.",
    dependsOn: {
        "@sous-io/plugin-config-files": "^0.2.34",
        "@sous-io/plugin-expressions": "^0.2.34",
        "@sous-io/plugin-variables": "^0.2.34",
        "@sous-io/plugin-host": "^0.2.34",
    },

    register(sous) {
        // Read on each use: `sous init` sets a project up after the engine started without one.
        const confDir = (): string | undefined => sous.project?.confDir;
        const compare = (left: string, right: string): number => sous.services.get("host.globs").compareBytewise(left, right);
        const loader = () => sous.services.get("config-files.loader");
        const added = new Set<string>();

        /** Adds a contributor for each file not added yet, each after the file before it. */
        const addContributors = (files: readonly ConfdFile[]): void => {
            let previous: readonly string[] = [MAIN_CONTRIBUTOR, MAIN_PATCH_CONTRIBUTORS];

            for (const file of files) {
                if (!added.has(file.contributor)) {
                    added.add(file.contributor);
                    sous.config.contribute(fileContributor(sous, file, [EVERY_CONTRIBUTOR, ...previous]));
                }

                previous = [file.contributor];
            }
        };

        addContributors(listConfdFiles(confDir(), loader(), compare));

        // Files added later (watch mode, an intent that creates one) join the next pass; a file that
        // is gone contributes nothing. Reads nothing, so it runs once per build.
        sous.config.contribute({
            id: SCAN_CONTRIBUTOR,
            after: [EVERY_CONTRIBUTOR, MAIN_CONTRIBUTOR],
            contribute(config) {
                const files = listConfdFiles(confDir(), loader(), compare);

                const mainName = sous.project?.configPath === undefined ? [] : [path.basename(sous.project.configPath)];
                const duplicate = duplicateBaseNames([...mainName, ...files.map((file) => file.name)])[0];

                if (duplicate !== undefined) {
                    throw duplicateBaseNameError(duplicate, files, sous.project?.configPath);
                }

                addContributors(files);
            },
        });

        sous.services.add("confd.files", () => new ConfdFilesImpl(confDir(), loader(), compare), { lifetime: "config" });
        sous.services.add(
            "confd.managed",
            (_config, ctx) =>
                new ConfdManagedImpl({
                    confDir: confDir(),
                    ensureDirectory: async (directory) => {
                        if (ctx.services.has("host.directories")) {
                            await ctx.services.get("host.directories").ensureKnown("confd", directory);
                        } else {
                            fs.mkdirSync(directory, { recursive: true });
                        }
                    },
                }),
            { lifetime: "config" },
        );
    },
});

/**
 * One `conf.d` file as a contributor: its data as one merge at the root, so it monitors the whole
 * config and lands on top, or its patches. The file is read once per build.
 */
function fileContributor(sous: Sous, file: ConfdFile, after: readonly string[]): ContributorDefinition {
    const isPatch = file.format === "patch-json" || file.format === "patch-jsonl";

    return {
        id: contributorId(file.name),
        after,
        // A patch file reads nothing, so it watches everything to keep landing on top.
        ...(isPatch ? { monitors: [""] } : {}),
        async contribute(config) {
            const loader = sous.services.get("config-files.loader");

            if (config.contributor.run === 1) {
                loader.forget(file.path);
            }

            if (!isFile(file.path)) {
                return;
            }

            await loader.contribute(await loader.load(file.path), config);
        },
    };
}

/**
 * Two config files whose names match once the final extension is dropped (`500-repos.json` and
 * `500-repos.yaml`) would merge in an order that depends on their extensions, which is never what
 * was meant, so the build stops and names both, as sous always has.
 */
function duplicateBaseNameError(names: readonly string[], files: readonly ConfdFile[], mainPath: string | undefined): ConfigError {
    const dot = names[0]!.lastIndexOf(".");
    const base = dot <= 0 ? names[0]! : names[0]!.slice(0, dot);
    const paths = names.map((name) => files.find((file) => file.name === name)?.path ?? mainPath ?? name);

    return new ConfigError(`Duplicate config layer baseName '${base}':`, {
        details: [
            ...paths.map((file) => `  ${file}`),
            "Every loaded config file (the primary config and all conf.d/ layers) must have a unique filename once its final extension is removed. Rename one of them.",
        ],
    });
}

function isFile(file: string): boolean {
    try {
        return fs.statSync(file).isFile();
    } catch {
        return false;
    }
}

export default confdPlugin;

export { managedHeader, MANAGED_FILE_COMMENT } from "./managed.js";

export type * from "./types.js";
