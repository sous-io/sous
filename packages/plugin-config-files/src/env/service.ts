/**
 * `config-files.env`: reading and writing `.sous/.env` and `.sous/.env.local` (S6).
 */

import path from "node:path";
import { type Environment, type ProjectInfo, SousError } from "@sous-io/plugin-api";
import { ENV_LOCAL_NAME, ENV_SHARED_NAME } from "../names.js";
import type { ConfigFilesEnv, EnvFileChange, EnvFileKind, EnvFilePaths, EnvFileValues, EnvFileWriteOptions } from "../types.js";
import { parseEnv, readEnvFile, readEnvFileMap, removeEntry, renderEnvFile, setEntry, writeEnvFile } from "./env-file.js";

/** The env files of one project. Never reads `process.env`: the environment is given (S6, rule 6). */
export class EnvFilesService implements ConfigFilesEnv {
    constructor(
        private readonly project: ProjectInfo | undefined,
        private readonly env: Environment,
    ) {}

    paths(): EnvFilePaths | undefined {
        if (this.project === undefined) {
            return undefined;
        }

        return {
            shared: path.join(this.project.sousDir, ENV_SHARED_NAME),
            local: path.join(this.project.sousDir, ENV_LOCAL_NAME),
        };
    }

    async read(): Promise<EnvFileValues> {
        return this.readSync();
    }

    readSync(): EnvFileValues {
        const paths = this.paths();
        const shared = paths ? readEnvFileMap(paths.shared) : {};
        const local = paths ? readEnvFileMap(paths.local) : {};
        const merged: Record<string, string | undefined> = { ...shared, ...local };

        // The environment sous was started with wins: it was set on purpose.
        for (const [key, value] of Object.entries(this.env)) {
            if (value !== undefined) {
                merged[key] = value;
            }
        }

        return { shared, local, merged: Object.freeze(merged) };
    }

    async write(
        kind: EnvFileKind,
        entries: Readonly<Record<string, string | undefined>>,
        options: EnvFileWriteOptions = {},
    ): Promise<EnvFileChange> {
        const paths = this.paths();

        if (paths === undefined) {
            throw new SousError("There is no sous project here, so there is no env file to write.", { details: ["Run sous init in the project root first."] });
        }

        const file = kind === "shared" ? paths.shared : paths.local;
        const model = readEnvFile(file);
        const before = renderEnvFile(model);
        const old = parseEnv(before);
        const set: string[] = [];
        const removed: string[] = [];

        for (const [key, value] of Object.entries(entries)) {
            if (value === undefined) {
                if (removeEntry(model, key) > 0) {
                    removed.push(key);
                }

                continue;
            }

            if (old[key] !== value) {
                setEntry(model, key, value, options.comment === undefined ? {} : { header: options.comment });
                set.push(key);
            }
        }

        const after = renderEnvFile(model);
        const changed = after !== before;

        if (changed && options.dryRun !== true) {
            writeEnvFile(file, model);
        }

        return { file, changed, set, removed };
    }

    parse(text: string): Record<string, string> {
        return parseEnv(text);
    }
}
