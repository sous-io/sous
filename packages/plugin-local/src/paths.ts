/**
 * Telling a local repository path from a URL, and turning what a person typed into the absolute
 * path that is stored. Two spellings name a local repository, and they mean the same thing:
 *
 * ```text
 * file:///home/me/Projects/my-recipes
 * /home/me/Projects/my-recipes
 * ```
 *
 * A stored entry is always absolute, because one config file serves several working directories.
 */

import { statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** A URL that names its scheme, such as `https://` or `ssh://`. */
const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;

/** The `scp`-style SSH form, as in `git@github.com:owner/name.git`. */
const SCP_PATTERN = /^[^@\s/\\]+@[^@\s/\\:]+:.+$/;

/** A Windows absolute path, as in `C:\Projects\recipes`. */
const WINDOWS_ABSOLUTE_PATTERN = /^[A-Za-z]:[\\/]/;

/**
 * The absolute directory a repository URL names, or `undefined` when it is not a local path.
 *
 * ```ts
 * localRepoPath("file:///home/me/recipes"); // "/home/me/recipes"
 * localRepoPath("https://github.com/o/r");  // undefined
 * localRepoPath("../recipes");               // undefined: relative
 * ```
 */
export function localRepoPath(url: string): string | undefined {
    const trimmed = url.trim();

    if (trimmed.length === 0) {
        return undefined;
    }

    if (trimmed.toLowerCase().startsWith("file://")) {
        try {
            return path.normalize(fileURLToPath(trimmed));
        } catch {
            return undefined;
        }
    }

    return path.isAbsolute(trimmed) ? path.normalize(trimmed) : undefined;
}

/**
 * A directory written as the owner part of a local repository's identity: its segments joined
 * with `/`, starting with `/`.
 *
 * The store and the index cache split an identity on `/` into directory names. A Windows path
 * would otherwise land there as one name holding backslashes and a drive colon, which Windows
 * refuses, so no local repository could be read. A drive (`C:`) or UNC (`\\server\share`) root
 * becomes plain segments. A POSIX path comes back unchanged.
 *
 * ```ts
 * identityOwnerPath("/home/me");                     // "/home/me"
 * identityOwnerPath("C:\\Users\\me", path.win32);    // "/C/Users/me"
 * identityOwnerPath("\\\\srv\\team\\x", path.win32); // "/srv/team/x"
 * ```
 *
 * @param directory - An absolute, normalized directory.
 * @param paths - The platform's path functions; only tests pass them.
 */
export function identityOwnerPath(directory: string, paths: path.PlatformPath = path): string {
    const { root } = paths.parse(directory);
    const rootSegments = root.split(/[\\/]/).map((segment) => segment.replace(/:$/, ""));
    const segments = [...rootSegments, ...directory.slice(root.length).split(paths.sep)];

    return `/${segments.filter((segment) => segment.length > 0).join("/")}`;
}

/**
 * A leading `~` expanded to a home directory. Only `~` and `~/...` are expanded.
 *
 * ```ts
 * expandHomePath("~/recipes", "/home/me"); // "/home/me/recipes"
 * ```
 */
export function expandHomePath(value: string, home: string): string {
    if (value === "~") {
        return home;
    }

    if (value.startsWith("~/") || value.startsWith("~\\")) {
        return path.join(home, value.slice(2));
    }

    return value;
}

/**
 * Whether a repository argument is a path rather than a URL. A `file://` URL, an absolute path, a
 * `~` path and an explicitly relative path count outright; a bare segment counts only when a
 * directory of that name is there.
 *
 * ```ts
 * looksLikeLocalPath("../my-recipes", { cwd: "/work", home: "/home/me" }); // true
 * looksLikeLocalPath("https://github.com/o/r", { cwd: "/work", home: "/home/me" }); // false
 * ```
 */
export function looksLikeLocalPath(value: string, where: { cwd: string; home: string }): boolean {
    const trimmed = value.trim();

    if (trimmed.length === 0) {
        return false;
    }

    if (trimmed.toLowerCase().startsWith("file://")) {
        return true;
    }

    if (SCHEME_PATTERN.test(trimmed)) {
        return false;
    }

    const expanded = expandHomePath(trimmed, where.home);

    if (path.isAbsolute(expanded) || WINDOWS_ABSOLUTE_PATTERN.test(expanded) || expanded !== trimmed) {
        return true;
    }

    if (/^\.\.?([\\/]|$)/.test(trimmed)) {
        return true;
    }

    if (SCP_PATTERN.test(trimmed)) {
        return false;
    }

    try {
        return statSync(path.resolve(where.cwd, trimmed)).isDirectory();
    } catch {
        return false;
    }
}

/**
 * A repository argument made absolute when it is a path, and handed back unchanged otherwise.
 *
 * ```ts
 * resolveRepoArgument("../my-recipes", { cwd: "/home/me/work", home: "/home/me" }); // "/home/me/my-recipes"
 * resolveRepoArgument("https://github.com/o/r", { cwd: "/", home: "/home/me" });    // unchanged
 * ```
 */
export function resolveRepoArgument(value: string, where: { cwd: string; home: string }): string {
    const trimmed = value.trim();

    if (!looksLikeLocalPath(trimmed, where)) {
        return trimmed;
    }

    if (trimmed.toLowerCase().startsWith("file://")) {
        return localRepoPath(trimmed) ?? trimmed;
    }

    return path.resolve(where.cwd, expandHomePath(trimmed, where.home));
}
