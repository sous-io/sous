/**
 * The edit `sous init` makes to the project's `package.json`: sous as a devDependency at the running
 * version. A project that installs sous pins the version its templates were written against, and a
 * global sous hands off to that copy, so the dependency is what makes every build of the project use
 * one version. Nothing is installed: the project's own package manager does that.
 */

import fs from "node:fs";
import path from "node:path";
import { ConfigError } from "@sous-io/plugin-api";
import type { PackageJsonOutcome } from "./types.js";

/** A planned edit: the outcome, and the new file text when the file changes. */
export interface PackageJsonPlan {
    readonly outcome: PackageJsonOutcome;
    /** The complete new file, when there is an edit to write. */
    readonly contents?: string;
    /** The file, when there is one. */
    readonly file?: string;
}

/**
 * Works out the package.json edit: nothing when the project has no package.json or already depends
 * on sous, otherwise the file rewritten with sous in `devDependencies` at exactly the running
 * version. The file's own indentation and trailing newline are kept, and `devDependencies` stays
 * sorted the way npm keeps it. A package.json that is not JSON is refused by name, before anything
 * is written.
 *
 * @param projectRoot - The directory that may hold a package.json.
 * @param packageName - The name sous is installed under (`@sous-io/sous`).
 * @param version - The version to pin.
 */
export function planPackageJson(projectRoot: string, packageName: string, version: string): PackageJsonPlan {
    const file = path.join(projectRoot, "package.json");

    if (!fs.existsSync(file)) {
        return { outcome: { kind: "no-package-json" } };
    }

    const raw = fs.readFileSync(file, "utf8");
    let parsed: unknown;

    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        throw new ConfigError(`'sous init' would add ${packageName} to ${file}, but could not read it as JSON.`, {
            details: [(error as Error).message, "Fix the file, or run 'sous init' in a directory without a package.json."],
            cause: error,
        });
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new ConfigError(`'sous init' would add ${packageName} to ${file}, but it does not hold a JSON object.`);
    }

    const pkg = parsed as Record<string, unknown>;

    for (const section of ["dependencies", "devDependencies"] as const) {
        const deps = pkg[section];

        if (typeof deps === "object" && deps !== null && packageName in deps) {
            return { file, outcome: { kind: "already-declared", section, range: String((deps as Record<string, unknown>)[packageName]) } };
        }
    }

    const existing = typeof pkg.devDependencies === "object" && pkg.devDependencies !== null ? (pkg.devDependencies as Record<string, unknown>) : {};
    const devDependencies = Object.fromEntries(Object.entries({ ...existing, [packageName]: version }).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    const indent = raw.match(/^(\s+)"/m)?.[1] ?? "  ";
    const newline = raw.endsWith("\n") ? "\n" : "";

    return {
        file,
        contents: JSON.stringify({ ...pkg, devDependencies }, null, indent) + newline,
        outcome: { kind: "added", section: "devDependencies", range: version },
    };
}
