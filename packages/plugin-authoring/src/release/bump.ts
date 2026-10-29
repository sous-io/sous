/**
 * Raising the version in a recipe manifest. A manifest is written by hand, and the scaffold is
 * mostly comments, so the file is edited in place through `@sous-io/documents`: only the version's
 * bytes change, comments and layout stay as the author left them.
 */

import fs from "node:fs";
import path from "node:path";
import semver from "semver";
import { parseDocument, type DocumentFormat } from "@sous-io/documents";
import { ConfigError } from "@sous-io/plugin-api";
import type { ReleaseBump } from "../types.js";

/** Every way `--bump` can raise a version. */
export const BUMP_LEVELS: readonly ReleaseBump[] = ["patch", "minor", "major", "prerelease"];

/** What one bump did. */
export interface BumpResult {
    readonly manifestPath: string;
    readonly from: string;
    readonly to: string;
}

/**
 * The version one level up, by npm's own rules.
 *
 * ```ts
 * nextVersion("1.4.0", "minor");   // "1.5.0"
 * ```
 */
export function nextVersion(current: string, level: ReleaseBump): string {
    const next = semver.inc(current, level);

    if (next === null) {
        throw new ConfigError(
            `Cannot raise the version '${current}' by a ${level} step.\n` +
                `  A recipe version is an exact semantic version, such as '1.4.0' or '2.0.0-beta.1'.`,
        );
    }

    return next;
}

/** Raises a recipe manifest's `version` in place. */
export function bumpRecipeVersion(manifestPath: string, level: ReleaseBump): BumpResult {
    return rewriteVersion(manifestPath, (current) => nextVersion(current, level));
}

/** Writes an exact version into a recipe manifest; a manifest already at it is left byte for byte. */
export function setRecipeVersion(manifestPath: string, version: string): BumpResult {
    if (semver.valid(version) === null) {
        throw new ConfigError(
            `Cannot set the recipe version to '${version}'.\n` +
                `  A recipe version is an exact semantic version, such as '1.4.0' or '2.0.0-beta.1'.`,
        );
    }

    return rewriteVersion(manifestPath, () => version);
}

function rewriteVersion(manifestPath: string, nextFrom: (current: string) => string): BumpResult {
    const text = fs.readFileSync(manifestPath, "utf8");
    const document = parseDocument(text, formatOf(manifestPath));
    const value = document.value();
    const from = typeof value === "object" && value !== null && !Array.isArray(value) ? value.version : undefined;

    if (typeof from !== "string") {
        throw new ConfigError(
            `The recipe manifest at ${manifestPath} has no 'version' field to write.\n` +
                `  Every recipe declares an exact semantic version; add one, then try again.`,
        );
    }

    const to = nextFrom(from);

    if (to !== from) {
        document.atPath(["version"]).set(to);
        fs.writeFileSync(manifestPath, document.toString(), "utf8");
    }

    return { manifestPath, from, to };
}

function formatOf(manifestPath: string): DocumentFormat {
    const extension = path.extname(manifestPath).toLowerCase();

    return extension === ".json" || extension === ".jsonc" ? "jsonc" : "yaml";
}
