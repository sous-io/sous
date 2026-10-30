/**
 * plugin-host: The machine sous runs on: processes, HTTP, globs and paths, sous home, self-describing directories, the .gitignore block, package identity.
 *
 * The contract other plugins code against is `./types.ts`.
 * Services read the environment and the project from the engine, never from `process.env` or
 * `process.cwd()`.
 */

import { definePlugin, jsonSchema, type PluginDefinition } from "@sous-io/plugin-api";
import { createDirectories } from "./directories.js";
import { createGitignore } from "./gitignore.js";
import { hostGlobs } from "./globs.js";
import { createHttp } from "./http.js";
import { createPackage } from "./package-identity.js";
import { createProcesses } from "./processes.js";
import { createSousHome } from "./sous-home.js";
import "./types.js";

/** The plugin's name. */
export const PLUGIN_NAME = "@sous-io/plugin-host";

/** The schema every `pointer-file` entity is checked against. */
const pointerFileSchema = jsonSchema({
    type: "object",
    properties: {
        id: { type: "string" },
        fileName: { type: "string", minLength: 1 },
        content: { type: "string" },
    },
    required: ["id", "fileName"],
});

/** The plugin. */
export const hostPlugin: PluginDefinition = definePlugin({
    name: PLUGIN_NAME,
    version: "0.2.34",
    description: "The machine sous runs on: processes, HTTP, globs and paths, sous home, self-describing directories, the .gitignore block, package identity.",
    dependsOn: {},

    register(sous) {
        sous.entities.define("pointer-file", pointerFileSchema, {
            description: "A one-line file written once into every self-describing directory, telling an agent to read its README.",
        });

        sous.services.add("host.processes", (_config, ctx) => createProcesses({ env: ctx.env }), { lifetime: "singleton" });
        sous.services.add("host.http", () => createHttp(), { lifetime: "singleton" });
        sous.services.add("host.globs", () => hostGlobs, { lifetime: "singleton" });
        sous.services.add("host.sous-home", (_config, ctx) => createSousHome(() => ctx.env), { lifetime: "singleton" });
        sous.services.add("host.gitignore", () => createGitignore(), { lifetime: "singleton" });
        sous.services.add("host.package", () => createPackage(), { lifetime: "singleton" });
        // Reads the pointer-file entities, so it is made once per config.
        sous.services.add(
            "host.directories",
            (_config, ctx) => createDirectories({ entities: ctx.entities, sousHome: ctx.services.get("host.sous-home") }),
            { lifetime: "config" },
        );
    },
});

export default hostPlugin;

export { createDirectories, DEFAULT_POINTER_LINE, README_FILENAME, renderReadme } from "./directories.js";
export { applyManagedBlock, createGitignore, IGNORE_BLOCK_END, IGNORE_BLOCK_START, readManagedBlock } from "./gitignore.js";
export { compareBytewise, hasGlob, hostGlobs, staticBase, toGlobPattern, toPosix } from "./globs.js";
export { createHttp, DEFAULT_HTTP_TIMEOUT_MS, HttpError } from "./http.js";
export { createPackage, SOUS_PACKAGE_NAMES } from "./package-identity.js";
export { createProcesses, NOT_FOUND_EXIT_CODE, ProcessError } from "./processes.js";
export { KNOWN_READMES } from "./readmes.js";
export {
    createSousHome,
    GLOBAL_LINKS_FILENAME,
    GLOBAL_REPOS_DIR_NAME,
    INDEX_CACHE_DIR_NAME,
    READ_STRATEGIES_FILENAME,
    resolveSousHomePaths,
    SOUS_HOME_DIR_NAME,
    SOUS_HOME_ENV_VAR,
    STORE_DIR_NAME,
} from "./sous-home.js";
export type * from "./types.js";
