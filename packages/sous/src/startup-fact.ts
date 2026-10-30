import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Environment, ProjectInfo } from "@sous-io/plugin-api";
import { resolveSousHomePaths } from "@sous-io/plugin-host";

/** The file the last successful config build leaves its startup fact in. */
export const STARTUP_FACT_FILENAME = "sous.startup.json";

/** Files that change on every build or run and say nothing about what plugins the config loads. */
const IGNORED_FILES = new Set([STARTUP_FACT_FILENAME, "sous.state.json", "sous.pid"]);

/** Directories of the sous home that hold fetched or generated data, not settings. */
const IGNORED_HOME_DIRECTORIES = new Set(["cache", "repos"]);

/** What the last successful config build recorded. */
interface StartupFact {
    /** Digest of everything that decides the plugins a build loads, as it was before that build. */
    readonly key: string;
    /** Whether that build loaded no plugin beyond the built-in ones. */
    readonly builtInsOnly: boolean;
}

/**
 * Where the fact lives: in the sous home's cache (`$SOUS_HOME` or `~/.sous`), one file per project
 * named by a digest of its `.sous/` path, so a run never writes into the project itself.
 */
function factFile(project: ProjectInfo | undefined, env: Environment): string {
    const name = project === undefined ? "no-project" : createHash("sha256").update(project.sousDir).digest("hex").slice(0, 16);

    return path.join(resolveSousHomePaths(env).root, "cache", "startup", `${name}.json`);
}

/** `name size mtime` of a file, or nothing when it is not there. */
function signature(file: string): string {
    try {
        const stats = statSync(file);

        return `${file} ${stats.size} ${stats.mtimeMs}`;
    } catch {
        return `${file} -`;
    }
}

/** The signature of every file in a directory, going into subdirectories unless `skip` names them. */
function signaturesIn(directory: string, recurse: boolean, skip: ReadonlySet<string> = new Set()): string[] {
    let entries: import("node:fs").Dirent[];

    try {
        entries = readdirSync(directory, { withFileTypes: true });
    } catch {
        return [];
    }

    const lines: string[] = [];

    for (const entry of entries) {
        const full = path.join(directory, entry.name);

        if (entry.isDirectory()) {
            if (recurse && !skip.has(entry.name)) {
                lines.push(...signaturesIn(full, true));
            }
        } else if (!IGNORED_FILES.has(entry.name)) {
            lines.push(signature(full));
        }
    }

    return lines;
}

/**
 * A digest of what decides which plugins a config build loads: the sous version and this bundle's
 * own file, the `SOUS_*` environment, the project's files (its config file, `conf.d`, and every
 * file directly in `.sous/` such as the lockfile, the links map and the `.env` files) and the files
 * of the sous home outside its cache. It does not follow files a config module imports.
 */
export function startupKey(project: ProjectInfo | undefined, env: Environment, version: string, bundle: string): string {
    const lines = [version, signature(bundle), JSON.stringify(project ?? null)];

    for (const name of Object.keys(env).sort()) {
        if (name.startsWith("SOUS_")) {
            lines.push(`${name}=${env[name]}`);
        }
    }

    if (project !== undefined) {
        lines.push(...signaturesIn(project.sousDir, false));
        lines.push(...signaturesIn(project.confDir, true));

        if (project.configPath !== undefined) {
            lines.push(signature(project.configPath));
        }
    }

    const home = resolveSousHomePaths(env).root;

    lines.push(...signaturesIn(home, true, IGNORED_HOME_DIRECTORIES));

    return createHash("sha1").update(lines.sort().join("\n")).digest("hex");
}

function readFact(file: string): StartupFact | undefined {
    try {
        const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<StartupFact>;

        return typeof parsed.key === "string" && typeof parsed.builtInsOnly === "boolean" ? { key: parsed.key, builtInsOnly: parsed.builtInsOnly } : undefined;
    } catch {
        return undefined;
    }
}

/** Whether the last successful build, under the same key, loaded no plugin beyond the built-in ones. */
export function loadsOnlyBuiltIns(project: ProjectInfo | undefined, env: Environment, key: string): boolean {
    const fact = readFact(factFile(project, env));

    return fact !== undefined && fact.key === key && fact.builtInsOnly;
}

/**
 * Records what a successful build found, so the next run can skip building the config for a command
 * that only prints text. Written only when it changed, and only when the sous home exists (a run never
 * creates it).
 */
export function recordStartupFact(project: ProjectInfo | undefined, env: Environment, key: string, builtInsOnly: boolean): void {
    const file = factFile(project, env);
    const previous = readFact(file);

    if (previous?.key === key && previous.builtInsOnly === builtInsOnly) {
        return;
    }

    try {
        // A run never creates the sous home itself, only the cache directory inside it.
        if (!existsSync(resolveSousHomePaths(env).root)) {
            return;
        }

        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, `${JSON.stringify({ key, builtInsOnly } satisfies StartupFact)}\n`, "utf8");
    } catch {
        // The fact is an optimization; a read-only directory just means the next run builds the config.
    }
}
