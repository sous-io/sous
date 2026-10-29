/**
 * Config files as written, for `--raw` (S2, "What `sous config show` and `get` Print").
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { ProjectInfo } from "@sous-io/plugin-api";
import { redactText } from "./redact.js";
import type { RawConfigFile } from "./types.js";

/** The contributor of the main config file. */
const MAIN_CONTRIBUTOR = "config-files.main";

/** Files in `conf.d` that are not config. */
const IGNORED = /^\.|~$|\.(bak|orig|swp)$/;

/** Reads a file, or `undefined` when it cannot be read. */
async function tryRead(file: string): Promise<string | undefined> {
    try {
        return await readFile(file, "utf8");
    } catch {
        return undefined;
    }
}

/** The main config file, then each `conf.d` file in name order, as written, with secrets hidden. */
export async function readRawConfigFiles(project: ProjectInfo | undefined): Promise<RawConfigFile[]> {
    if (project === undefined) {
        return [];
    }

    const files: RawConfigFile[] = [];

    if (project.configPath !== undefined) {
        const text = await tryRead(project.configPath);

        if (text !== undefined) {
            files.push({ contributor: MAIN_CONTRIBUTOR, path: project.configPath, text: redactText(text) });
        }
    }

    let names: string[] = [];

    try {
        const entries = await readdir(project.confDir, { withFileTypes: true });

        names = entries.filter((entry) => entry.isFile() && !IGNORED.test(entry.name)).map((entry) => entry.name);
    } catch {
        // No conf.d directory.
    }

    for (const name of names.sort()) {
        const file = path.join(project.confDir, name);
        const text = await tryRead(file);

        if (text !== undefined) {
            files.push({ contributor: `confd/${name}`, path: file, text: redactText(text) });
        }
    }

    return files;
}
