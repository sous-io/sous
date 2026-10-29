/**
 * The state file (S6, `compiler.state`): every file the compiler wrote, the directories it created,
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

/** Reads a state file; an empty state when it is missing or cannot be read. */
export function loadState(file: string): StateFile {
    try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<StateFile>;

        return {
            lastBuild: typeof parsed.lastBuild === "string" ? parsed.lastBuild : "",
            resolvedVars: parsed.resolvedVars && typeof parsed.resolvedVars === "object" ? { ...parsed.resolvedVars } : {},
            dirs: Array.isArray(parsed.dirs) ? parsed.dirs.filter((dir): dir is string => typeof dir === "string") : [],
            files: Array.isArray(parsed.files) ? parsed.files.filter((entry): entry is StateFileEntry => typeof entry?.dest === "string") : [],
        };
    } catch {
        return emptyState();
    }
}

/** Writes a state file, creating its directory when missing. */
export function saveState(file: string, state: StateFile): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state, null, 2), "utf8");
}

/**
 * The state of one config: what is on disk, plus what this run wrote and has not saved yet. The
 * state service, the writer and the compile and prune intents of one config share it.
 */
export class StateStore {
    private loaded: StateFile | undefined;
    private readonly written = new Map<string, StateFileEntry>();
    private readonly createdDirs = new Set<string>();
    private readonly removed = new Set<string>();

    constructor(readonly file: string) {}

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
        this.loaded ??= loadState(this.file);

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

        return this.written.get(resolved) ?? this.saved().files.find((entry) => path.resolve(entry.dest) === resolved);
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
