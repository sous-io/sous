/**
 * The contract of plugin-host: the machine sous runs on. Every
 * service here is a `singleton`; none reads the config. Other plugins import this file type-only.
 */

import type { Environment } from "@sous-io/plugin-api";

// ---------------------------------------------------------------------------------------------
// host.processes
// ---------------------------------------------------------------------------------------------

/** How to run one subprocess. */
export interface ProcessOptions {
    /** The directory it runs in. Default: the project root, or the process's own directory outside a project. */
    cwd?: string;
    /** The environment it gets. Default: `ctx.env` of the caller, never `process.env` read directly. */
    env?: Environment;
    /** Text written to its standard input, which is then closed. */
    input?: string;
    /** Kills it after this long and fails with a timeout. Default: no limit. */
    timeoutMs?: number;
    /** Kills it when aborted. */
    signal?: AbortSignal;
    /** The name its timing is recorded under (`git fetch`); default: the command and its first argument. */
    label?: string;
    /** Throws a `SousError` holding the result when it exits non-zero. Default `false`. */
    reject?: boolean;
    /**
     * On Windows, start a bare command name through the shell, which is the only way Windows finds
     * a `.cmd` shim such as npm's, pnpm's or yarn's. An absolute path is still started directly, and
     * nothing changes on other platforms. Only for a command line sous wrote itself: the shell reads
     * the arguments.
     */
    windowsShell?: boolean;
}

/** What a finished subprocess gave back. */
export interface ProcessResult {
    /** The command as run. */
    readonly command: string;
    readonly args: readonly string[];
    /** Its exit code, or `null` when a signal ended it. */
    readonly exitCode: number | null;
    /** The signal that ended it, or `null`. */
    readonly signal: string | null;
    readonly stdout: string;
    readonly stderr: string;
    /** How long it ran. */
    readonly durationMs: number;
    /** True when it was killed for passing `timeoutMs`. */
    readonly timedOut: boolean;
}

/** How to run a subprocess that shares the terminal (a harness, an installer). */
export interface InteractiveProcessOptions {
    cwd?: string;
    env?: Environment;
    signal?: AbortSignal;
    label?: string;
    /**
     * On Windows, start a bare command name through the shell, which is the only way Windows finds
     * a `.cmd` shim such as npm's, pnpm's or yarn's. An absolute path is still started directly, and
     * nothing changes on other platforms. Only for a command line sous wrote itself: the shell reads
     * the arguments.
     */
    windowsShell?: boolean;
}

/** How an interactive subprocess ended. */
export interface InteractiveProcessResult {
    readonly exitCode: number | null;
    readonly signal: string | null;
    readonly durationMs: number;
}

/** Running subprocesses, every one timed. The one owner of `spawn`. */
export interface HostProcesses {
    /** Runs a command to completion, capturing its output. */
    run(command: string, args: readonly string[], options?: ProcessOptions): Promise<ProcessResult>;
    /** The same, blocking; only for callers whose own interface is synchronous (a Liquid tag). */
    runSync(command: string, args: readonly string[], options?: ProcessOptions): ProcessResult;
    /** Runs a command with the terminal's own input and output, until it exits. */
    runInteractive(command: string, args: readonly string[], options?: InteractiveProcessOptions): Promise<InteractiveProcessResult>;
    /** The absolute path a command resolves to on `PATH`, or `undefined` when it is not installed. */
    which(command: string, env?: Environment): Promise<string | undefined>;
}

// ---------------------------------------------------------------------------------------------
// host.http
// ---------------------------------------------------------------------------------------------

/** An HTTP method sous uses. */
export type HttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";

/** One HTTP request. */
export interface HttpRequest {
    url: string;
    /** Default `GET`. */
    method?: HttpMethod;
    headers?: Readonly<Record<string, string>>;
    body?: string | Uint8Array;
    /** Fails after this long. Default 15 000 ms. */
    timeoutMs?: number;
    signal?: AbortSignal;
    /** What to do with a redirect. Default `follow`; `manual` lets a caller see a 302 to a sign-in page. */
    redirect?: "follow" | "manual" | "error";
    /** The name its timing is recorded under; default: the method and host. */
    label?: string;
}

/** One HTTP response; the body is read once, by one of the three readers. */
export interface HttpResponse {
    readonly status: number;
    readonly statusText: string;
    /** The final URL, after any redirects followed. */
    readonly url: string;
    readonly redirected: boolean;
    /** Header names in lowercase. */
    readonly headers: Readonly<Record<string, string>>;
    /** How long the request took, up to the headers. */
    readonly durationMs: number;
    text(): Promise<string>;
    json<T = unknown>(): Promise<T>;
    bytes(): Promise<Uint8Array>;
}

/** HTTP requests, every one timed. Never throws for a status code; only for a failed connection. */
export interface HostHttp {
    request(request: HttpRequest): Promise<HttpResponse>;
    /** Shorthand for a `GET`. */
    get(url: string, options?: Omit<HttpRequest, "url" | "method" | "body">): Promise<HttpResponse>;
}

// ---------------------------------------------------------------------------------------------
// host.globs
// ---------------------------------------------------------------------------------------------

/** Options for matching files on disk. */
export interface GlobOptions {
    /** The directory patterns are relative to. */
    cwd: string;
    /** Matches names starting with a dot. Default `false`. */
    dot?: boolean;
    /** Returns absolute paths. Default `false`: paths relative to `cwd`, `/`-separated. */
    absolute?: boolean;
    /** Only files, not directories. Default `true`. */
    onlyFiles?: boolean;
    /** Patterns to leave out. */
    ignore?: readonly string[];
    /** Follows symbolic links into directories. Default `true`. */
    followSymlinks?: boolean;
}

/** Options for matching one path against a pattern. */
export interface GlobMatchOptions {
    dot?: boolean;
    /** Ignores case. Default `false`. */
    nocase?: boolean;
}

/** Globs and paths: matching, a pattern's static base, bytewise order, containment. */
export interface HostGlobs {
    /** Every path matching the patterns, in bytewise order. */
    match(patterns: string | readonly string[], options: GlobOptions): Promise<string[]>;
    /** The same, blocking. */
    matchSync(patterns: string | readonly string[], options: GlobOptions): string[];
    /** Whether a path matches a pattern. */
    isMatch(path: string, pattern: string | readonly string[], options?: GlobMatchOptions): boolean;
    /** Whether text holds glob syntax. */
    hasGlob(text: string): boolean;
    /** The directory part of a pattern before its first glob segment: `docs/**\/*.md` → `docs` (`inferGlobBase`). */
    staticBase(pattern: string): string;
    /** Compares two strings by their UTF-8 bytes, the order `conf.d` and every listing use. */
    compareBytewise(left: string, right: string): number;
    /** A copy sorted bytewise. */
    sortBytewise(items: Iterable<string>): string[];
    /** Whether `child` is `parent` or inside it, after resolving both; with `realPath`, symbolic links too. */
    isInside(child: string, parent: string, options?: { realPath?: boolean }): boolean;
    /** The real path of `path` when it lies inside `root` after following links, else `undefined` (`realPathInside`). */
    realPathInside(path: string, root: string): string | undefined;
    /** A path with `/` separators. */
    toPosix(path: string): string;
}

// ---------------------------------------------------------------------------------------------
// host.sous-home
// ---------------------------------------------------------------------------------------------

/** Where machine-wide data lives. */
export interface SousHomePaths {
    /** `$SOUS_HOME`, or `~/.sous`. */
    readonly root: string;
    /** The recipe store (`<root>/cache`). */
    readonly store: string;
    /** Cached repository indexes (`<root>/cache/_indexes`). */
    readonly indexCache: string;
    /** Machine-wide repository checkouts (`<root>/repos`). */
    readonly repos: string;
    /** The machine-wide links map (`<root>/sous.links.json`). */
    readonly links: string;
    /** What reading each repository last worked with (`<root>/cache/read-strategies.json`). */
    readonly readStrategies: string;
}

/** Sous home: `SOUS_HOME` and everything under it. */
export interface HostSousHome {
    /** The paths, for an environment (default: the engine's `ctx.env`). */
    paths(env?: Environment): SousHomePaths;
    /** A path under the root. */
    resolve(...segments: string[]): string;
}

// ---------------------------------------------------------------------------------------------
// host.directories and the pointer-file entity
// ---------------------------------------------------------------------------------------------

/** What a self-describing directory's `README.md` says. */
export interface DirectoryReadme {
    /** The heading: `Sous recipe store`. */
    title: string;
    /** Paragraphs under it. */
    body: readonly string[];
}

/** What creating a directory did. */
export interface EnsuredDirectory {
    readonly path: string;
    /** True when the directory did not exist before. */
    readonly created: boolean;
    /** Every file written into it this time (`README.md`, pointer files); existing files are never overwritten. */
    readonly wrote: readonly string[];
}

/** The well-known self-describing directories sous makes. */
export type SousDirectoryKind = "sous-dir" | "confd" | "project-repos" | "sous-home" | "store" | "global-repos" | "index-cache";

/**
 * Creating the self-describing directories sous makes: each gets its own `README.md`, plus one copy
 * of every `pointer-file` entity's file.
 */
export interface HostDirectories {
    /** Creates a directory with a README of its own and the pointer files. */
    ensure(path: string, readme: DirectoryReadme): Promise<EnsuredDirectory>;
    /** Creates one of the well-known directories, with its standard README. */
    ensureKnown(kind: SousDirectoryKind, path: string): Promise<EnsuredDirectory>;
    /** The pointer file names in force, each once, in bytewise order. */
    pointerFileNames(): string[];
}

/** A `pointer-file` entity: a one-line file telling an agent to read the directory's README. */
export interface PointerFileEntity {
    /** Unique; several entities may still name the same file, which is written once. */
    id: string;
    /** The file name: `CLAUDE.md`, `AGENTS.md`. */
    fileName: string;
    /** The file's text. Default: ``Read `./README.md` for information about this directory.`` */
    content?: string;
}

// ---------------------------------------------------------------------------------------------
// host.gitignore
// ---------------------------------------------------------------------------------------------

/** What changing a `.gitignore` block did. */
export interface GitignoreChange {
    readonly file: string;
    /** True when the file changed on disk. */
    readonly changed: boolean;
    /** The block's lines after the change. */
    readonly lines: readonly string[];
}

/** The sous-managed block in a `.gitignore` file, between sous's marker comments. */
export interface HostGitignore {
    /** The lines in the block, or `[]` when the file or the block is missing. */
    read(file: string): Promise<string[]>;
    /** Replaces the whole block, creating the file or the block when missing. Lines outside it are untouched. */
    write(file: string, lines: readonly string[], options?: { dryRun?: boolean }): Promise<GitignoreChange>;
    /** Adds lines to the block that are not in it yet. */
    add(file: string, lines: readonly string[], options?: { dryRun?: boolean }): Promise<GitignoreChange>;
    /** Removes lines from the block; an empty block is removed. */
    remove(file: string, lines: readonly string[], options?: { dryRun?: boolean }): Promise<GitignoreChange>;
}

// ---------------------------------------------------------------------------------------------
// host.package
// ---------------------------------------------------------------------------------------------

/** The installed sous: where it is, and its version. */
export interface PackageIdentity {
    /** `@sous-io/sous`. */
    readonly name: string;
    readonly version: string;
    /** The package's root directory (today's `CLI_ROOT`, the `sousRootPath` auto-variable). */
    readonly root: string;
    /** The real path of the root, links followed. */
    readonly realRoot: string;
    /** The bin sous was started through. */
    readonly bin: string | undefined;
}

/** Package identity. */
export interface HostPackage {
    identity(): PackageIdentity;
}

// ---------------------------------------------------------------------------------------------
// Declarations
// ---------------------------------------------------------------------------------------------

declare module "@sous-io/plugin-api" {
    interface SousServices {
        /** Running a subprocess, timed. */
        "host.processes": HostProcesses;
        /** HTTP requests, timed. */
        "host.http": HostHttp;
        /** Globs and paths. */
        "host.globs": HostGlobs;
        /** Sous home. */
        "host.sous-home": HostSousHome;
        /** Creating the self-describing directories. */
        "host.directories": HostDirectories;
        /** The sous block in a `.gitignore`. */
        "host.gitignore": HostGitignore;
        /** Package identity. */
        "host.package": HostPackage;
    }

    interface SousEntities {
        /** A pointer file written once into every self-describing directory. */
        "pointer-file": PointerFileEntity;
    }
}
