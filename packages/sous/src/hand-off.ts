/**
 * The hand-off from the sous that was invoked to the sous a project installs.
 *
 * A global install is a convenience launcher; a project's own `@sous-io/sous` dependency is the
 * version its templates and its lockfile were written against, and it is the one that has to do
 * the work (the implicit `core` subscription asks for exactly the running version, so two versions
 * taking turns in one project rewrite the committed lockfile back and forth). The bin calls
 * {@link handOffToProjectInstall} before it starts the engine, and when a project copy is found,
 * imports that copy's own bin in this same process and lets it run the command.
 *
 * The rules:
 * - The lookup walks up from the working directory looking for `node_modules/@sous-io/sous`, the
 *   way Node resolves a package, so a copy hoisted to a monorepo root is found from any package
 *   inside it.
 * - A copy whose real path is the invoked install's own root is "self", and self never hands off;
 *   that is what stops the project's copy from handing off to itself after the global copy handed
 *   off to it.
 * - The copy's bin is read from its package.json `bin` field, never assumed, so an older layout
 *   (the bin was once called `xcv`) still works.
 * - Anything unreadable or ambiguous means "run the copy that was invoked". A hand-off is a
 *   convenience; a refusal to run is not.
 * - `SOUS_NO_DELEGATE` (anything but 0/false/no/off) runs the invoked copy.
 * - `sous update` runs the invoked copy: updating the copy that was invoked is its job, and a
 *   project copy may be too old to have the command. The command word is the first entry on the
 *   command line that is not a flag, so `sous subscription update` still hands off.
 * - The notice goes to stderr, so piped stdout stays clean. It prints when the two versions differ,
 *   and on every hand-off under `SOUS_DEBUG` or with `--verbose` anywhere on the command line.
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** The npm package name a project copy is looked up under. */
export const PACKAGE_NAME = "@sous-io/sous";

/** The environment variable that keeps the invoked copy running. */
export const NO_DELEGATE_ENV = "SOUS_NO_DELEGATE";

/** The environment variable that makes every hand-off announce itself. */
export const DEBUG_ENV = "SOUS_DEBUG";

/** The command that always runs in the copy that was invoked. */
export const SELF_UPDATE_COMMAND = "update";

/** A project copy found by {@link findProjectInstall}. */
export type ProjectInstall = { same: true; root: string } | { same: false; root: string; version: string; bin: string };

/** What the bin should do. */
export type HandOffPlan = { kind: "run-self" } | { kind: "hand-off"; install: Extract<ProjectInstall, { same: false }>; notice: string[] };

/** The first entry on the command line that is not a flag. */
export function commandWordOf(argv: readonly string[]): string | undefined {
    return argv.find((arg) => !arg.startsWith("-"));
}

/** Whether an environment flag is on: set, and not one of 0, false, no or off. */
export function isEnvFlagOn(value: string | undefined): boolean {
    return !["", "0", "false", "no", "off"].includes((value ?? "").trim().toLowerCase());
}

interface PackageJson {
    name?: unknown;
    version?: unknown;
    bin?: unknown;
}

/** A directory's package.json, or `undefined` when it cannot be read. */
export function readPackageJson(dir: string): PackageJson | undefined {
    try {
        return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as PackageJson;
    } catch {
        return undefined;
    }
}

/** The sous bin a package.json names: `bin` itself, `bin.sous`, `bin.xcv`, or its only entry. */
export function binEntryOf(pkg: PackageJson | undefined): string | undefined {
    const bin = pkg?.bin;

    if (typeof bin === "string") {
        return bin;
    }

    if (bin === null || typeof bin !== "object") {
        return undefined;
    }

    const entries = bin as Record<string, unknown>;
    const named = entries.sous ?? entries.xcv;

    if (typeof named === "string") {
        return named;
    }

    const values = Object.values(entries);

    return values.length === 1 && typeof values[0] === "string" ? values[0] : undefined;
}

/** The nearest `node_modules/@sous-io/sous` at or above a directory. */
export function findProjectCopy(startDir: string): string | undefined {
    for (let dir = path.resolve(startDir); ; dir = path.dirname(dir)) {
        const candidate = path.join(dir, "node_modules", ...PACKAGE_NAME.split("/"));

        if (fs.existsSync(path.join(candidate, "package.json"))) {
            return candidate;
        }

        if (path.dirname(dir) === dir) {
            return undefined;
        }
    }
}

/** A path's real path, or the path itself when it cannot be resolved. */
export function realpathOr(target: string): string {
    try {
        return fs.realpathSync(target);
    } catch {
        return path.resolve(target);
    }
}

/** What a found copy is: the invoked install itself, another usable install, or nothing usable. */
export function describeInstall(candidate: string, ownRoot: string): ProjectInstall | undefined {
    const root = realpathOr(candidate);

    if (root === realpathOr(ownRoot)) {
        return { same: true, root };
    }

    const pkg = readPackageJson(root);

    if (pkg?.name !== PACKAGE_NAME) {
        return undefined;
    }

    const entry = binEntryOf(pkg);

    if (entry === undefined) {
        return undefined;
    }

    const bin = path.resolve(root, entry);

    if (!fs.existsSync(bin)) {
        return undefined;
    }

    return { same: false, root, version: typeof pkg.version === "string" ? pkg.version : "unknown", bin };
}

/** The project copy above a directory, described against the invoked install. */
export function findProjectInstall(startDir: string, ownRoot: string): ProjectInstall | undefined {
    const candidate = findProjectCopy(startDir);

    return candidate === undefined ? undefined : describeInstall(candidate, ownRoot);
}

/** The lines announcing a hand-off. */
export function formatHandoffNotice(options: { install: { root: string; version: string }; ownVersion: string; ownRoot: string; verbose: boolean }): string[] {
    const lines = [`Handing off to the project-level Sous install: v${options.install.version}`];

    if (options.verbose) {
        lines.push(
            `    Project install: ${options.install.root}`,
            `    Invoked install: v${options.ownVersion} at ${options.ownRoot}`,
            `Set ${NO_DELEGATE_ENV}=1 to run the invoked install instead.`,
        );
    }

    return lines;
}

/** Decides whether to hand off, and what to say. */
export function planHandoff(options: { cwd: string; ownRoot: string; env: Readonly<Record<string, string | undefined>>; argv: readonly string[] }): HandOffPlan {
    const { cwd, ownRoot, env, argv } = options;

    if (isEnvFlagOn(env[NO_DELEGATE_ENV]) || commandWordOf(argv) === SELF_UPDATE_COMMAND) {
        return { kind: "run-self" };
    }

    const install = findProjectInstall(cwd, ownRoot);

    if (install === undefined || install.same) {
        return { kind: "run-self" };
    }

    const ownPkg = readPackageJson(ownRoot);
    const ownVersion = typeof ownPkg?.version === "string" ? ownPkg.version : "unknown";
    const verbose = isEnvFlagOn(env[DEBUG_ENV]) || argv.includes("--verbose");
    const announce = ownVersion !== install.version || verbose;
    const notice = announce ? formatHandoffNotice({ install, ownVersion, ownRoot: realpathOr(ownRoot), verbose }) : [];

    return { kind: "hand-off", install, notice };
}

/**
 * Hands the command off to the project's own sous when there is one: prints the notice, imports
 * that copy's bin (which runs the command) and resolves `true`. Resolves `false` when the invoked
 * copy should run.
 */
export async function handOffToProjectInstall(options: {
    ownRoot: string;
    cwd: string;
    env: Readonly<Record<string, string | undefined>>;
    argv: readonly string[];
    stderr: { write(text: string): unknown };
}): Promise<boolean> {
    const plan = planHandoff(options);

    if (plan.kind !== "hand-off") {
        return false;
    }

    for (const line of plan.notice) {
        options.stderr.write(`${line}\n`);
    }

    await import(pathToFileURL(plan.install.bin).href);

    return true;
}
