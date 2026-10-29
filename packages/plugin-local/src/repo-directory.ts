/**
 * Checking that a path typed for `sous repo add` really is a sous repository (ported from
 * `assertLocalRepoDirectory` in `src/lib/repos/providers/local.ts`). A person who typed a path made
 * a path mistake, so the message names what they typed, where sous looked and what it expected to
 * find there; hosts and providers do not come into it.
 *
 * ```ts
 * assertLocalRepoDirectory("../nope", "/home/me/nope", manifests);
 * // ConfigError: There is no directory at '../nope'.
 * ```
 */

import { statSync, type Stats } from "node:fs";
import { ConfigError } from "@sous-io/plugin-api";
import { MANIFEST_EXTENSIONS, REPO_MANIFEST_BASENAME } from "@sous-io/plugin-formats";
import type { FormatsManifests } from "@sous-io/plugin-formats/types";

/**
 * Throws a `ConfigError` explaining the mistake when `resolved` is not the root of a sous
 * repository: nothing there, a file, or a directory with no repository manifest.
 *
 * @param typed - The path exactly as the user typed it.
 * @param resolved - The absolute path sous resolved it to.
 * @param manifests - `formats.manifests`, which knows every spelling of the manifest.
 */
export function assertLocalRepoDirectory(typed: string, resolved: string, manifests: Pick<FormatsManifests, "find">): void {
    const manifestName = `${REPO_MANIFEST_BASENAME}${MANIFEST_EXTENSIONS[0]}`;
    const spellings = MANIFEST_EXTENSIONS.map((extension) => `${REPO_MANIFEST_BASENAME}${extension}`).join(", ");
    let stats: Stats;

    try {
        stats = statSync(resolved);
    } catch {
        throw new ConfigError(`There is no directory at '${typed}'.`, {
            details: [
                `Sous read that as the path ${resolved}, and nothing is there.`,
                `A repository on this machine is a directory holding a '${manifestName}' file at its root. Check the path, or create one with 'sous repo init'.`,
            ],
        });
    }

    if (!stats.isDirectory()) {
        throw new ConfigError(`'${typed}' is a file, not a directory.`, {
            details: [`Sous read that as the path ${resolved}.`, `Name the root directory of a repository: the directory holding its '${manifestName}' file.`],
        });
    }

    if (manifests.find(resolved, "repo") === undefined) {
        throw new ConfigError(`The directory '${typed}' is not a sous repository.`, {
            details: [
                `Sous read that as the path ${resolved}, and it holds no repository manifest.`,
                `A repository declares itself with one of ${spellings} at its root. Check the path, or create a repository there with 'sous repo init'.`,
            ],
        });
    }
}
