/**
 * Finding the `conf.d` files: every file sous reads directly inside `conf.d`
 * (not in folders inside it), listed in bytewise order of their names on every machine. They
 * apply by the number their names start with (see `confdApplyOrder` in `index.ts`).
 */

import fs from "node:fs";
import path from "node:path";
import type { ConfigFilesLoader } from "@sous-io/plugin-config-files/types";
import type { ConfdFile, ConfdFiles } from "./types.js";

/** The prefix of each file's contributor id: `confd/610-mac.jsonc`. */
export const CONTRIBUTOR_PREFIX = "confd/";

/** A managed file's name: `5xx-…`. */
const MANAGED_NAME = /^5\d\d-/;

/** Whether sous manages a file: the 5xx range. */
export function isManagedName(name: string): boolean {
    return MANAGED_NAME.test(name);
}

/** The contributor id of a `conf.d` file. */
export function contributorId(name: string): string {
    return `${CONTRIBUTOR_PREFIX}${name}`;
}

/**
 * Lists the `conf.d` files sous reads, bytewise. A missing directory has none.
 *
 * ```ts
 * listConfdFiles("/work/app/.sous/conf.d", loader, compare).map((file) => file.name);
 * // ["10-early.json", "2-late.json", "500-repos.jsonc", "720-x.patch.json"]
 * ```
 */
export function listConfdFiles(
    confDir: string | undefined,
    loader: Pick<ConfigFilesLoader, "formatOf">,
    compare: (left: string, right: string) => number,
): ConfdFile[] {
    if (confDir === undefined) {
        return [];
    }

    let names: string[];

    try {
        names = fs.readdirSync(confDir);
    } catch {
        return [];
    }

    const files: ConfdFile[] = [];

    for (const name of [...names].sort(compare)) {
        const format = loader.formatOf(name);
        const full = path.join(confDir, name);

        if (format === undefined || !isFile(full)) {
            continue;
        }

        files.push({ name, path: full, format, contributor: contributorId(name), managed: isManagedName(name) });
    }

    return files;
}

/**
 * Names that collide once the final extension is dropped (`500-repos.json` and
 * `500-repos.jsonc`): such files merge in an order that depends on their extensions, which is
 * never what was meant. The build stops and names them.
 */
export function duplicateBaseNames(names: readonly string[]): string[][] {
    const byBase = new Map<string, string[]>();

    for (const name of names) {
        const dot = name.lastIndexOf(".");
        const base = dot <= 0 ? name : name.slice(0, dot);

        byBase.set(base, [...(byBase.get(base) ?? []), name]);
    }

    return [...byBase.values()].filter((group) => group.length > 1);
}

/** `confd.files`. */
export class ConfdFilesImpl implements ConfdFiles {
    constructor(
        private readonly confDir: string | undefined,
        private readonly loader: Pick<ConfigFilesLoader, "formatOf">,
        private readonly compare: (left: string, right: string) => number,
    ) {}

    directory(): string | undefined {
        return this.confDir;
    }

    list(): ConfdFile[] {
        return listConfdFiles(this.confDir, this.loader, this.compare);
    }
}

function isFile(file: string): boolean {
    try {
        return fs.statSync(file).isFile();
    } catch {
        return false;
    }
}
