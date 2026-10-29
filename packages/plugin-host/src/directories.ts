/**
 * `host.directories`: the self-describing directories sous makes. Each gets a `README.md` of its
 * own, plus one copy of every `pointer-file` entity's file. Nothing is ever overwritten.
 *
 * Rendered output directories are not covered: what a compilation target writes belongs to the user.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type { EntityReader } from "@sous-io/plugin-api";
import { compareBytewise } from "./globs.js";
import { KNOWN_READMES } from "./readmes.js";
import type { DirectoryReadme, EnsuredDirectory, HostDirectories, HostSousHome, SousDirectoryKind } from "./types.js";

/** The file written into every directory. */
export const README_FILENAME = "README.md";

/** What a pointer file says when its entity gives no text. */
export const DEFAULT_POINTER_LINE = "Read `./README.md` for information about this directory.";

/** What the service needs from the engine. */
export interface DirectoriesDeps {
    entities: EntityReader;
    sousHome: HostSousHome;
}

/** Renders a README. */
export function renderReadme(readme: DirectoryReadme): string {
    return `# ${readme.title}\n\n${readme.body.join("\n\n")}\n`;
}

/** Writes a file only when absent; the exclusive flag makes check and write one step. Returns whether it wrote. */
async function writeIfAbsent(file: string, contents: string): Promise<boolean> {
    try {
        await fs.writeFile(file, contents, { encoding: "utf8", flag: "wx" });

        return true;
    } catch {
        // Already there, or not writable: a missing explanatory file never fails a command.
        return false;
    }
}

/** Whether a path exists. */
async function exists(target: string): Promise<boolean> {
    try {
        await fs.access(target);

        return true;
    } catch {
        return false;
    }
}

/** Makes the `host.directories` service. */
export function createDirectories(deps: DirectoriesDeps): HostDirectories {
    /** The pointer files in force, each once; the first entity naming a file decides its text. */
    const pointers = (): Map<string, string> => {
        const files = new Map<string, string>();

        for (const entity of deps.entities.list("pointer-file")) {
            // A pointer file sits directly in the directory; a name with a separator would not.
            if (!/[\\/]/.test(entity.fileName) && !files.has(entity.fileName)) {
                files.set(entity.fileName, entity.content ?? DEFAULT_POINTER_LINE);
            }
        }

        return files;
    };

    const ensure = async (directory: string, readme: DirectoryReadme): Promise<EnsuredDirectory> => {
        const created = !(await exists(directory));

        await fs.mkdir(directory, { recursive: true });

        const wrote: string[] = [];

        if (await writeIfAbsent(path.join(directory, README_FILENAME), renderReadme(readme))) {
            wrote.push(README_FILENAME);
        }

        const files = pointers();

        for (const name of [...files.keys()].sort(compareBytewise)) {
            if (await writeIfAbsent(path.join(directory, name), `${files.get(name)}\n`)) {
                wrote.push(name);
            }
        }

        return { path: directory, created, wrote };
    };

    const ensureKnown = async (kind: SousDirectoryKind, directory: string): Promise<EnsuredDirectory> => {
            const home = deps.sousHome.paths();

            // Explain the parent too, but only when it really is the sous home: a store rooted
            // somewhere else must never leave files in a directory sous does not own.
            if (kind === "store" || kind === "global-repos") {
                if (path.resolve(path.dirname(directory)) === path.resolve(home.root)) {
                    await ensure(home.root, KNOWN_READMES["sous-home"]);
                }
            }

            if (kind === "index-cache") {
                await ensureKnown("store", path.dirname(directory));
            }

            return ensure(directory, KNOWN_READMES[kind]);
    };

    return {
        ensure,
        ensureKnown,

        pointerFileNames: () => [...pointers().keys()].sort(compareBytewise),
    };
}
