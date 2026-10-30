/**
 * plugin-confd: The conf.d files, one contributor per file, and surgical edits to the managed conf.d/5xx files.
 *
 * The contract other plugins code against is `./types.ts`.
 */

import fs from "node:fs";
import { ConfigError, type ContributorDefinition, definePlugin, type PluginDefinition, type Sous } from "@sous-io/plugin-api";
import type {} from "@sous-io/plugin-config-files/types";
import type {} from "@sous-io/plugin-host/types";
import { ConfdFilesImpl, contributorId, duplicateBaseNames, listConfdFiles } from "./files.js";
import { ConfdManagedImpl } from "./managed.js";
import type { ConfdFile } from "./types.js";
import "./types.js";

/** The plugin's name. */
export const PLUGIN_NAME = "@sous-io/plugin-confd";

/** The apply order a `conf.d` file adds the number its name starts with to. `sous.config.*` applies just before it. */
const USER_FILES_APPLY_ORDER = 90000;

/** The largest number at the start of a `conf.d` file name that counts (so the highest apply order is 99999). */
const MAX_FILE_NUMBER = 9999;

/** The apply order of a `conf.d` file whose name does not start with a number. */
const UNNUMBERED_APPLY_ORDER = 90500;

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

                const duplicate = duplicateBaseNames(files.map((file) => file.name))[0];

                if (duplicate !== undefined) {
                    throw duplicateBaseNameError(duplicate, files);
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
 * The number a `conf.d` file name starts with, and the number that counts: the one read, held at
 * 9999. `number` is undefined for a name that starts with none.
 *
 * ```ts
 * leadingFileNumber("610-mac.jsonc");      // { read: 610, used: 610 }
 * leadingFileNumber("12345-big.jsonc");    // { read: 12345, used: 9999 }
 * leadingFileNumber("local.jsonc");        // undefined
 * ```
 */
function leadingFileNumber(name: string): { read: number; used: number } | undefined {
    const leading = /^\d+/.exec(name)?.[0];

    return leading === undefined ? undefined : { read: Number(leading), used: Math.min(MAX_FILE_NUMBER, Number(leading)) };
}

/**
 * The apply order of a `conf.d` file: 90000 plus the number its name starts with
 * (`610-browser.jsonc` applies at 90610), or 90500 when it starts with none. A number above 9999
 * counts as 9999, so no file applies after 99999. Every plugin's contributor uses a lower number,
 * and `sous.config.*` applies at 89900, so the user's files apply after them and win; files with
 * the same number apply in id order.
 *
 * ```ts
 * confdApplyOrder("500-repos.jsonc");   // 90500
 * confdApplyOrder("local.jsonc");       // 90500
 * confdApplyOrder("12345-big.jsonc");   // 99999
 * ```
 */
export function confdApplyOrder(name: string): number {
    const number = leadingFileNumber(name);

    return number === undefined ? UNNUMBERED_APPLY_ORDER : USER_FILES_APPLY_ORDER + number.used;
}

/**
 * One `conf.d` file as a contributor: its data as one merge at the root, so it monitors the whole
 * config, or its patches. Its apply order puts it after every plugin's contributor and after
 * `sous.config.*` and its patch files (89900), even when its name starts with `000`. The file is
 * read once per build.
 */
function fileContributor(sous: Sous, file: ConfdFile): ContributorDefinition {
    const isPatch = file.format === "patch-json" || file.format === "patch-jsonl";

    return {
        id: contributorId(file.name),
        applyOrder: confdApplyOrder(file.name),
        // A patch file reads nothing, so it watches everything to re-apply after every change.
        ...(isPatch ? { monitors: [""] } : {}),
        async contribute(config) {
            const loader = sous.services.get("config-files.loader");

            if (config.contributor.run === 1) {
                loader.forget(file.path);

                const number = leadingFileNumber(file.name);

                if (number !== undefined && number.read > number.used) {
                    config.debug(
                        `The conf.d file ${file.name} starts with the number ${number.read}, which is more than ${MAX_FILE_NUMBER}; it is applied as number ${number.used} (apply order ${confdApplyOrder(file.name)}).`,
                    );
                }
            }

            if (!isFile(file.path)) {
                return;
            }

            await loader.contribute(await loader.load(file.path), config);
        },
    };
}

/**
 * Two conf.d files whose names match once the final extension is dropped (`500-repos.json` and
 * `500-repos.yaml`) would merge in an order that depends on their extensions, which is never what
 * was meant, so the build stops and names both, as sous always has.
 */
function duplicateBaseNameError(names: readonly string[], files: readonly ConfdFile[]): ConfigError {
    const dot = names[0]!.lastIndexOf(".");
    const base = dot <= 0 ? names[0]! : names[0]!.slice(0, dot);
    const paths = names.map((name) => files.find((file) => file.name === name)?.path ?? name);

    return new ConfigError(`Duplicate config layer baseName '${base}':`, {
        details: [
            ...paths.map((file) => `  ${file}`),
            "Two config files in one directory must not share a name once the final extension is removed. Delete or rename one of them.",
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
