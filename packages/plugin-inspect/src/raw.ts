/**
 * Config files as written, for `--raw` (S2, "What `sous config show` and `get` Print").
 */

import { readFile } from "node:fs/promises";
import type { ProjectInfo, ServiceReader } from "@sous-io/plugin-api";
import "@sous-io/plugin-confd/types";
import { KEY_NAME_POLICY, redactText, type SecretPolicy } from "./redact.js";
import type { RawConfigFile } from "./types.js";

/** The contributor of the main config file. */
const MAIN_CONTRIBUTOR = "config-files.main";

/** Reads a file, or `undefined` when it cannot be read. */
async function tryRead(file: string): Promise<string | undefined> {
    try {
        return await readFile(file, "utf8");
    } catch {
        return undefined;
    }
}

/** The `conf.d` files, from `confd.files` when it is there. */
function confdFiles(services: ServiceReader): Array<{ contributor: string; path: string }> {
    return services.has("confd.files") ? services.get("confd.files").list() : [];
}

/** The main config file, then each `conf.d` file in name order, as written, with secrets hidden. */
export async function readRawConfigFiles(
    project: ProjectInfo | undefined,
    services: ServiceReader,
    policy: SecretPolicy = KEY_NAME_POLICY,
): Promise<RawConfigFile[]> {
    if (project === undefined) {
        return [];
    }

    const files: RawConfigFile[] = [];

    if (project.configPath !== undefined) {
        const text = await tryRead(project.configPath);

        if (text !== undefined) {
            files.push({ contributor: MAIN_CONTRIBUTOR, path: project.configPath, text: redactText(text, policy) });
        }
    }

    for (const file of confdFiles(services)) {
        const text = await tryRead(file.path);

        if (text !== undefined) {
            files.push({ contributor: file.contributor, path: file.path, text: redactText(text, policy) });
        }
    }

    return files;
}
