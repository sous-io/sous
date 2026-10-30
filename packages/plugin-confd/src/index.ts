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

/** The contributor of `sous.config.*`, which every `conf.d` file applies after. */
const MAIN_CONTRIBUTOR = "config-files.main";

/** The patch files beside `sous.config.*`, which also apply before `conf.d`. */
const MAIN_PATCH_CONTRIBUTORS = "config-files/*";

/** The apply order of `sous.config.*`; a `conf.d` file adds the number its name starts with. */
const USER_FILES_APPLY_ORDER = 90000;

/** The apply order of a `conf.d` file whose name does not start with a number. */
const UNNUMBERED_APPLY_ORDER = 90500;

/** The highest apply order a contributor may declare. */
const MAX_APPLY_ORDER = 99999;

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

        /** Adds a contributor for each file not added yet. */
        const addContributors = (files: readonly ConfdFile[]): void => {
            for (const file of files) {
                if (!added.has(file.contributor)) {
                    added.add(file.contributor);
                    sous.config.contribute(fileContributor(sous, file));
                }
            }
        };

        addContributors(listConfdFiles(confDir(), loader(), compare));

        // Files added later (watch mode, an intent that creates one) join the next pass; a file that
        // is gone contributes nothing. Reads nothing, so it runs once per build; it applies nothing,
        // and runs with the user's files.
        sous.config.contribute({
            id: SCAN_CONTRIBUTOR,
            applyOrder: USER_FILES_APPLY_ORDER,
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
 * The apply order of a `conf.d` file: 90000 plus the number its name starts with
 * (`610-browser.jsonc` applies at 90610), or 90500 when it starts with none, and never more than
 * 99999. Every plugin's contributor uses a lower number, so the user's files apply after them and
 * win; files with the same number apply in name order.
 *
 * ```ts
 * confdApplyOrder("500-repos.jsonc");   // 90500
 * confdApplyOrder("local.jsonc");       // 90500
 * ```
 */
export function confdApplyOrder(name: string): number {
    const leading = /^\d+/.exec(name)?.[0];

    return leading === undefined ? UNNUMBERED_APPLY_ORDER : Math.min(MAX_APPLY_ORDER, USER_FILES_APPLY_ORDER + Number(leading));
}

/**
 * One `conf.d` file as a contributor: its data as one merge at the root, so it monitors the whole
 * config, or its patches. Its apply order puts it after every plugin's contributor, and its `after`
 * after `sous.config.*` and its patch files even when its name starts with `000`. The file is read
 * once per build.
 */
function fileContributor(sous: Sous, file: ConfdFile): ContributorDefinition {
    const isPatch = file.format === "patch-json" || file.format === "patch-jsonl";

    return {
        id: contributorId(file.name),
        applyOrder: confdApplyOrder(file.name),
        after: [MAIN_CONTRIBUTOR, MAIN_PATCH_CONTRIBUTORS],
        // A patch file reads nothing, so it watches everything to re-apply after every change.
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
