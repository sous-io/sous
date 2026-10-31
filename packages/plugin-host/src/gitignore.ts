/**
 * `host.gitignore`: the block sous manages in a `.gitignore` file, between two marker comments.
 * Only the lines between the markers are ever rewritten; everything else is left as it was.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { ConfigError } from "@sous-io/plugin-api";
import type { GitignoreChange, HostGitignore } from "./types.js";

/** Opening marker of the managed block. */
export const IGNORE_BLOCK_START = "# >>> sous managed (do not edit between these markers)";

/** Closing marker of the managed block. */
export const IGNORE_BLOCK_END = "# <<< sous managed";

/** Where the block is in a file's lines: both marker indexes, or `undefined` when there is none. */
function locate(lines: string[], label: string): { start: number; end: number } | undefined {
    const start = lines.findIndex((line) => line.trim() === IGNORE_BLOCK_START);

    if (start === -1) {
        return undefined;
    }

    const end = lines.findIndex((line, index) => index > start && line.trim() === IGNORE_BLOCK_END);

    if (end === -1) {
        throw new ConfigError(`The sous managed block in ${label} has no closing marker.`, {
            details: [
                `It opens with '${IGNORE_BLOCK_START}' but the line '${IGNORE_BLOCK_END}' is missing, so sous cannot tell where the block ends.`,
                "Add the closing marker back, or delete the opening one, and run the command again.",
            ],
        });
    }

    return { start, end };
}

/** The lines inside the block of a file's text, or `[]`. */
export function readManagedBlock(existing: string | undefined, label = ".gitignore"): string[] {
    if (existing === undefined) {
        return [];
    }

    const lines = existing.split("\n");
    const found = locate(lines, label);

    return found === undefined ? [] : lines.slice(found.start + 1, found.end);
}

/**
 * The text of a file with its managed block set to `entries`, leaving every line outside the
 * markers as it was. An empty `entries` removes the block. Pure, so it needs no file system.
 *
 * @param existing - The file's current text, or `undefined` when there is no file.
 * @param entries - The lines the block should hold.
 * @param label - The file's path, named if the block is damaged.
 */
export function applyManagedBlock(existing: string | undefined, entries: readonly string[], label = ".gitignore"): string {
    const block = [IGNORE_BLOCK_START, ...entries, IGNORE_BLOCK_END];
    const removing = entries.length === 0;

    if (existing === undefined || existing.trim() === "") {
        return removing ? (existing ?? "") : `${block.join("\n")}\n`;
    }

    const lines = existing.split("\n");
    const found = locate(lines, label);

    if (found === undefined) {
        if (removing) {
            return existing;
        }

        const prefix = existing.endsWith("\n") ? existing : `${existing}\n`;
        const separator = prefix.endsWith("\n\n") ? "" : "\n";

        return `${prefix}${separator}${block.join("\n")}\n`;
    }

    if (removing) {
        // Take away the blank line that separated the block from what came before it.
        const from = found.start > 0 && lines[found.start - 1]!.trim() === "" ? found.start - 1 : found.start;
        const rest = [...lines.slice(0, from), ...lines.slice(found.end + 1)].join("\n");

        return rest.trim() === "" ? "" : rest.endsWith("\n") ? rest : `${rest}\n`;
    }

    const joined = [...lines.slice(0, found.start), ...block, ...lines.slice(found.end + 1)].join("\n");

    return joined.endsWith("\n") ? joined : `${joined}\n`;
}

/** Reads a file, or `undefined` when it does not exist. */
async function readIfPresent(file: string): Promise<string | undefined> {
    try {
        return await fs.readFile(file, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return undefined;
        }

        throw error;
    }
}

/** Sets the block of a file to `entries`, writing only when the text changes. */
async function setBlock(file: string, entries: readonly string[], dryRun: boolean | undefined): Promise<GitignoreChange> {
    const existing = await readIfPresent(file);
    const next = applyManagedBlock(existing, entries, file);
    const changed = next !== (existing ?? "") && !(existing === undefined && next === "");

    if (changed && dryRun !== true) {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, next, "utf8");
    }

    return { file, changed, lines: [...entries] };
}

/** Makes the `host.gitignore` service. */
export function createGitignore(): HostGitignore {
    return {
        async read(file) {
            return readManagedBlock(await readIfPresent(file), file);
        },

        write: (file, lines, options) => setBlock(file, lines, options?.dryRun),

        async add(file, lines, options) {
            const current = readManagedBlock(await readIfPresent(file), file);
            const added = lines.filter((line, index) => !current.includes(line) && lines.indexOf(line) === index);

            return setBlock(file, [...current, ...added], options?.dryRun);
        },

        async remove(file, lines, options) {
            const current = readManagedBlock(await readIfPresent(file), file);

            return setBlock(
                file,
                current.filter((line) => !lines.includes(line)),
                options?.dryRun,
            );
        },
    };
}
