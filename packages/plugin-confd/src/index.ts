/**
 * plugin-confd: The conf.d files, one contributor per file, and surgical edits to the managed conf.d/5xx files.
 *
 * S6, "Config files: plugin-config-files and plugin-confd". The contract other plugins code against is `./types.ts`.
 */

import fs from "node:fs";
import { type ContributorDefinition, definePlugin, type PluginDefinition, type Sous } from "@sous-io/plugin-api";
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
        const confDir = sous.project?.confDir;
        const compare = (left: string, right: string): number => sous.services.get("host.globs").compareBytewise(left, right);
        const loader = () => sous.services.get("config-files.loader");
        const added = new Set<string>();

        /** Adds a contributor for each file not added yet, each after the file before it (S2). */
        const addContributors = (files: readonly ConfdFile[]): void => {
            let previous: readonly string[] = [MAIN_CONTRIBUTOR, MAIN_PATCH_CONTRIBUTORS];

            for (const file of files) {
                if (!added.has(file.contributor)) {
                    added.add(file.contributor);
                    sous.config.contribute(fileContributor(sous, file, previous));
                }

                previous = [file.contributor];
            }
        };

        addContributors(listConfdFiles(confDir, loader(), compare));

        // Files added later (watch mode, an intent that creates one) join the next pass; a file that
        // is gone contributes nothing. Reads nothing, so it runs once per build.
        sous.config.contribute({
            id: SCAN_CONTRIBUTOR,
            after: [MAIN_CONTRIBUTOR],
            contribute(config) {
                const files = listConfdFiles(confDir, loader(), compare);

                for (const group of duplicateBaseNames(files.map((file) => file.name))) {
                    config.log(
                        "warning",
                        `conf.d holds ${group.join(" and ")}, which differ only in their extension, so the order they merge in depends on it. Both are read; rename one.`,
                    );
                }

                addContributors(files);
            },
        });

        sous.services.add("confd.files", () => new ConfdFilesImpl(confDir, loader(), compare), { lifetime: "config" });
        sous.services.add(
            "confd.managed",
            (_config, ctx) =>
                new ConfdManagedImpl({
                    confDir,
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
 * config and lands on top (S2; C70, C74), or its patches. The file is read once per build.
 */
function fileContributor(sous: Sous, file: ConfdFile, after: readonly string[]): ContributorDefinition {
    const isPatch = file.format === "patch-json" || file.format === "patch-jsonl";

    return {
        id: contributorId(file.name),
        after,
        // A patch file reads nothing, so it watches everything to keep landing on top (S2).
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
