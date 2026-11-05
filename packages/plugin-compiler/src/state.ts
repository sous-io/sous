/**
 * The state file: every file the compiler wrote, the directories it created,
 * and which target, plugin, recipe and repository each file came from. Only the compiler writes it;
 * `prune`, `clear` and removing a repository read it.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { CompilerState, StateFile, StateFileEntry, StateFilter } from "./types.js";

/** A SHA-256 hex hash of a string. */
export function hashContent(content: string): string {
    return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

/** An empty state. */
export function emptyState(): StateFile {
    return { lastBuild: "", resolvedVars: {}, dirs: [], files: [] };
}

/**
 * Whether a path is one of the protected roots or inside one. Both sides are resolved first, so a
 * different spelling of the same directory is still caught.
 *
 * ```ts
 * isProtectedPath("/home/me/.sous/cache/r/x.md", ["/home/me/.sous/cache"]);   // true
 * ```
 */
export function isProtectedPath(target: string, protectedRoots: readonly string[]): boolean {
    const candidate = path.resolve(target);

    return protectedRoots.some((root) => {
        const resolved = path.resolve(root);

        return candidate === resolved || candidate.startsWith(resolved + path.sep);
    });
}

/** Whether a path is the directory `root` or inside it. */
function isInside(target: string, root: string): boolean {
    const relative = path.relative(root, target);

    return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/**
 * A state file read for one project. `state` holds what belongs to the project, every path
 * absolute. `foreign` holds the files recorded outside the project by a state file that does not
 * name this project as the one it was written for: a state file copied from another project
 * (`cp -r`), or one written before state files named their project. A foreign file is never
 * removed; it stays known only so a build may overwrite it, and the next save forgets it unless
 * the build wrote it again.
 */
export interface ReadState {
    state: StateFile;
    foreign: StateFileEntry[];
}

/**
 * Reads a state file for the project at `projectRoot`:
 *
 * - A relative path is read against `projectRoot`, and is the project's.
 * - An absolute path inside `projectRoot` is the project's.
 * - An absolute path outside `projectRoot` is the project's only when the file's own
 *   `projectRoot` is this one; otherwise it is foreign (see `ReadState`), and a directory is dropped.
 *
 * Without `projectRoot`, every path is kept as written. A missing or unreadable file reads as empty.
 *
 * ```ts
 * // /p/project-b/.sous/sous.state.json, copied from project-a, which also wrote /home/me/.claude/x.md:
 * // { "projectRoot": "/p/project-a", "files": [{ "dest": "AGENTS.md" }, { "dest": "/home/me/.claude/x.md" }] }
 * readState(file, "/p/project-b");
 * // -> state.files: [/p/project-b/AGENTS.md], foreign: [/home/me/.claude/x.md]
 * ```
 */
export function readState(file: string, projectRoot?: string): ReadState {
    const root = projectRoot === undefined ? undefined : path.resolve(projectRoot);
    let parsed: Partial<StateFile>;

    try {
        parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<StateFile>;
    } catch {
        return { state: root === undefined ? emptyState() : { ...emptyState(), projectRoot: root }, foreign: [] };
    }

    const sameProject = root !== undefined && typeof parsed.projectRoot === "string" && path.resolve(parsed.projectRoot) === root;
    // Where a recorded path is, and whether it is this project's.
    const place = (recorded: string): { at: string; own: boolean } => {
        if (root === undefined) {
            return { at: recorded, own: true };
        }

        if (!path.isAbsolute(recorded)) {
            return { at: path.resolve(root, recorded), own: true };
        }

        const at = path.resolve(recorded);

        return { at, own: sameProject || isInside(at, root) };
    };
    const files: StateFileEntry[] = [];
    const foreign: StateFileEntry[] = [];

    for (const entry of Array.isArray(parsed.files) ? parsed.files : []) {
        if (typeof entry?.dest === "string") {
            const { at, own } = place(entry.dest);

            (own ? files : foreign).push({ ...entry, dest: at });
        }
    }

    const dirs: string[] = [];

    for (const dir of Array.isArray(parsed.dirs) ? parsed.dirs : []) {
        if (typeof dir === "string") {
            const { at, own } = place(dir);

            if (own) {
                dirs.push(at);
            }
        }
    }

    return {
        state: {
            ...(root === undefined ? {} : { projectRoot: root }),
            lastBuild: typeof parsed.lastBuild === "string" ? parsed.lastBuild : "",
            resolvedVars: parsed.resolvedVars && typeof parsed.resolvedVars === "object" ? { ...parsed.resolvedVars } : {},
            dirs,
            files,
        },
        foreign,
    };
}

/** Reads a state file: what belongs to the project at `projectRoot` (see `readState`). */
export function loadState(file: string, projectRoot?: string): StateFile {
    return readState(file, projectRoot).state;
}

/**
 * Writes a state file, creating its directory when missing. When the state names its project
 * (`projectRoot`), every path inside the project is written relative to it, so a copy of the
 * project reads them as its own files rather than the original's.
 *
 * ```ts
 * saveState(file, { projectRoot: "/p/a", files: [{ dest: "/p/a/AGENTS.md" }, { dest: "/home/me/x.md" }], ... });
 * // -> "dest": "AGENTS.md" and "dest": "/home/me/x.md"
 * ```
 */
export function saveState(file: string, state: StateFile): void {
    const root = state.projectRoot === undefined ? undefined : path.resolve(state.projectRoot);
    const written = (target: string): string => (root !== undefined && isInside(target, root) ? path.relative(root, target) || "." : target);
    const onDisk: StateFile = {
        ...state,
        dirs: state.dirs.map(written),
        files: state.files.map((entry) => ({ ...entry, dest: written(entry.dest) })),
    };

    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(onDisk, null, 2), "utf8");
}

/**
 * The state of one config: what is on disk, plus what this run wrote and has not saved yet. The
 * state service, the writer and the compile and prune intents of one config share it.
 */
export class StateStore {
    private loaded: StateFile | undefined;
    private readonly foreign = new Map<string, StateFileEntry>();
    private readonly written = new Map<string, StateFileEntry>();
    private readonly createdDirs = new Set<string>();
    private readonly removed = new Set<string>();

    /**
     * `projectRoot` is the project the state file belongs to: paths inside it are saved relative
     * to it, and a path outside it that another project recorded is never removed (see `readState`).
     */
    constructor(
        readonly file: string,
        readonly projectRoot?: string,
    ) {}

    /** Re-reads the file, when nothing is waiting to be saved. */
    refresh(): void {
        if (!this.pending()) {
            this.loaded = undefined;
        }
    }

    /** Whether writes or removals are waiting to be saved. */
    pending(): boolean {
        return this.written.size > 0 || this.removed.size > 0 || this.createdDirs.size > 0;
    }

    /** The state on disk. */
    saved(): StateFile {
        if (!this.loaded) {
            const read = readState(this.file, this.projectRoot);

            this.loaded = read.state;
            this.foreign.clear();

            for (const entry of read.foreign) {
                this.foreign.set(entry.dest, entry);
            }
        }

        return this.loaded;
    }

    /** The state as it is now: what is saved, with this run's writes and removals laid over it. */
    current(): StateFile {
        const saved = this.saved();
        const files = [
            ...this.written.values(),
            ...saved.files.filter((entry) => !this.written.has(path.resolve(entry.dest)) && !this.removed.has(path.resolve(entry.dest))),
        ];

        return { ...saved, dirs: [...new Set([...saved.dirs, ...this.createdDirs])], files };
    }

    /** The entry of a file, or `undefined`. */
    entry(file: string): StateFileEntry | undefined {
        const resolved = path.resolve(file);

        if (this.removed.has(resolved)) {
            return undefined;
        }

        return this.written.get(resolved) ?? this.saved().files.find((entry) => path.resolve(entry.dest) === resolved) ?? this.foreign.get(resolved);
    }

    /** Records a file written. */
    record(entry: StateFileEntry): void {
        const resolved = path.resolve(entry.dest);

        this.removed.delete(resolved);
        this.written.set(resolved, { ...entry, dest: resolved });
    }

    /** Records a directory the compiler created. */
    recordDir(dir: string): void {
        this.createdDirs.add(path.resolve(dir));
    }

    /** Forgets a file removed. */
    forget(file: string): void {
        const resolved = path.resolve(file);

        this.written.delete(resolved);
        this.removed.add(resolved);
    }

    /**
     * Saves the state: this run's entries, then earlier entries whose files still exist (outputs a
     * partial compile did not touch, and outputs no target produces any more, which stay tracked
     * so prune can find them). Directories that no longer exist are dropped.
     */
    commit(options: { dryRun?: boolean; resolvedVars?: Readonly<Record<string, string>> } = {}): StateFile {
        const now = this.current();
        const next: StateFile = {
            ...(this.projectRoot === undefined ? {} : { projectRoot: path.resolve(this.projectRoot) }),
            lastBuild: new Date().toISOString(),
            resolvedVars: options.resolvedVars ? { ...options.resolvedVars } : now.resolvedVars,
            dirs: now.dirs.filter((dir) => fs.existsSync(dir)),
            files: [
                ...this.written.values(),
                ...now.files.filter((entry) => !this.written.has(path.resolve(entry.dest)) && fs.existsSync(entry.dest)),
            ],
        };

        if (options.dryRun) {
            return next;
        }

        saveState(this.file, next);
        this.loaded = next;
        this.foreign.clear();
        this.written.clear();
        this.createdDirs.clear();
        this.removed.clear();

        return next;
    }

    /** Deletes the state file itself, and forgets everything. */
    delete(): boolean {
        this.written.clear();
        this.createdDirs.clear();
        this.removed.clear();
        this.foreign.clear();
        this.loaded = emptyState();

        if (!fs.existsSync(this.file)) {
            return false;
        }

        fs.rmSync(this.file);

        return true;
    }
}

/** Whether an entry matches a filter: every field given must match. */
export function matchesFilter(entry: StateFileEntry, filter: StateFilter): boolean {
    return (
        (filter.repository === undefined || entry.origin?.repository === filter.repository) &&
        (filter.recipe === undefined || entry.origin?.recipe === filter.recipe) &&
        (filter.plugin === undefined || entry.origin?.plugin === filter.plugin) &&
        (filter.target === undefined || entry.target === filter.target)
    );
}

/** The `compiler.state` service. */
export class StateService implements CompilerState {
    constructor(private readonly store: StateStore) {}

    path(): string {
        return this.store.file;
    }

    read(): StateFile {
        return this.store.current();
    }

    entries(): StateFileEntry[] {
        return this.store.current().files;
    }

    filesFrom(filter: StateFilter): StateFileEntry[] {
        return this.entries().filter((entry) => matchesFilter(entry, filter));
    }

    isTracked(file: string): boolean {
        return this.store.entry(file) !== undefined;
    }
}
