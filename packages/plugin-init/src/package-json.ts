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

    return {
        file,
        contents: serialize(raw, { ...pkg, devDependencies: withDevDependency(pkg, packageName, version) }),
        outcome: { kind: "added", section: "devDependencies", range: version },
    };
}

/** `devDependencies` with one more entry, sorted the way npm keeps it. */
function withDevDependency(pkg: Record<string, unknown>, name: string, range: string): Record<string, unknown> {
    const existing = typeof pkg.devDependencies === "object" && pkg.devDependencies !== null ? (pkg.devDependencies as Record<string, unknown>) : {};

    return Object.fromEntries(Object.entries({ ...existing, [name]: range }).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** The object as the file's text, keeping the file's indentation and trailing newline. */
function serialize(raw: string, pkg: Record<string, unknown>): string {
    const indent = raw.match(/^(\s+)"/m)?.[1] ?? "  ";
    const newline = raw.endsWith("\n") ? "\n" : "";

    return JSON.stringify(pkg, null, indent) + newline;
}

/** Whether the package declares a dependency, in either section. */
function declares(pkg: Record<string, unknown>, name: string): boolean {
    return (["dependencies", "devDependencies"] as const).some((section) => {
        const deps = pkg[section];

        return typeof deps === "object" && deps !== null && name in deps;
    });
}

/** The `package.json` edit `sous init hooks` makes. */
export interface HooksPackageJsonPlan {
    readonly file: string;
    /** The complete new file, when it changes. */
    readonly contents?: string;
    /** Whether Husky was added to `devDependencies`. */
    readonly huskyAdded: boolean;
    /** The script that runs `sous build` after an install, as it will read. */
    readonly script: { readonly name: string; readonly text: string; readonly changed: boolean };
}

/**
 * Works out the edit `sous init hooks` makes to a `package.json`: Husky in `devDependencies` when
 * neither section has it, and the script the package manager runs after an install
 * (`scriptName`) running Husky and `sous build`, added to the script already there.
 *
 * @param compose - Works out the script's new text from its current one; `undefined` when it already does both.
 * @throws ConfigError when the file is not a JSON object.
 */
export function planHooksPackageJson(projectRoot: string, scriptName: string, huskyRange: string, compose: (existing: string | undefined) => string | undefined): HooksPackageJsonPlan {
    const file = path.join(projectRoot, "package.json");
    const raw = fs.readFileSync(file, "utf8");
    let pkg: Record<string, unknown>;

    try {
        pkg = JSON.parse(raw) as Record<string, unknown>;
    } catch (error) {
        throw new ConfigError(`'sous init hooks' would add a script to ${file}, but could not read it as JSON.`, { details: [(error as Error).message], cause: error });
    }

    if (typeof pkg !== "object" || pkg === null || Array.isArray(pkg)) {
        throw new ConfigError(`'sous init hooks' would add a script to ${file}, but it does not hold a JSON object.`);
    }

    const scripts = typeof pkg.scripts === "object" && pkg.scripts !== null ? (pkg.scripts as Record<string, unknown>) : {};
    const current = typeof scripts[scriptName] === "string" ? (scripts[scriptName] as string) : undefined;
    const composed = compose(current);
    const huskyAdded = !declares(pkg, "husky");
    let next = pkg;

    if (huskyAdded) {
        next = { ...next, devDependencies: withDevDependency(next, "husky", huskyRange) };
    }

    if (composed !== undefined) {
        next = { ...next, scripts: { ...scripts, [scriptName]: composed } };
    }

    return {
        file,
        ...(next === pkg ? {} : { contents: serialize(raw, next) }),
        huskyAdded,
        script: { name: scriptName, text: composed ?? current ?? "", changed: composed !== undefined },
    };
}
