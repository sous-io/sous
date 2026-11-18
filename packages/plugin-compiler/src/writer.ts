/**
 * Writing outputs: the one way any plugin writes a build output. A file the
 * compiler did not write is overwritten and taken over, unless `compilation.overwriteUntracked` is
 * `false`. Every write is recorded in the state file.
 *
 * Sous never destroys content it did not produce: before it overwrites or removes a file that it
 * did not write, or that was edited by hand since it wrote it (its content no longer matches the
 * `destHash` the state file recorded), it copies the file to `<sousDir>/backups/` (see `Backups`).
 */

import fs from "node:fs";
import path from "node:path";
import type { VarScope } from "@sous-io/plugin-variables/types";
import { Backups } from "./backups.js";
import { hashContent, isProtectedPath, type StateStore } from "./state.js";
import type { BackedUpFile, CompilerWriter, RemovedFiles, RemoveOptions, StateFileEntry, WriteOptions, WrittenFile } from "./types.js";

/** How the writer behaves. */
export interface WriterSettings {
    /** Overwrite files the compiler did not write. */
    readonly overwriteUntracked: boolean;
    /** Directories nothing may be removed from (linked checkouts, the recipe store). */
    readonly protectedRoots: readonly string[];
    /** Where backups go. Default: a `backups` directory beside the state file, paths kept relative to the state's project. */
    readonly backups?: Backups;
}

/** The `compiler.writer` service over one config's state. */
export class WriterService implements CompilerWriter {
    private readonly backups: Backups;

    constructor(
        private readonly store: StateStore,
        private readonly settings: WriterSettings,
    ) {
        this.backups = settings.backups ?? new Backups(path.join(path.dirname(store.file), "backups"), store.projectRoot);
    }

    async write(file: string, content: string, options: WriteOptions): Promise<WrittenFile> {
        const dest = path.resolve(file);
        const bytes = Buffer.byteLength(content, "utf8");
        const tracked = this.store.entry(dest);
        const exists = fs.existsSync(dest);
        const base = {
            file: dest,
            bytes,
            ...(options.target === undefined ? {} : { target: options.target }),
            ...(options.origin === undefined ? {} : { origin: options.origin }),
        };
        const current = exists ? readText(dest) : undefined;
        const sameContent = current !== undefined && current === content;

        // A file the compiler did not write is left alone when the user said so, even when its
        // content already matches: taking it over would let a later prune delete it.
        if (exists && tracked === undefined && !this.settings.overwriteUntracked) {
            return { ...base, action: "skipped-untracked" };
        }

        // Content sous did not produce is copied away before it is overwritten.
        const backUp = current !== undefined && !sameContent && !isOwnContent(current, tracked);

        if (options.dryRun) {
            const action = !exists ? "would-create" : sameContent && !options.force ? "unchanged" : "would-update";

            return { ...base, action, ...(backUp ? { backup: this.backups.plan(dest, options.run) } : {}) };
        }

        const entry = {
            dest,
            srcHash: options.sourceHash ?? hashContent(options.source),
            destHash: hashContent(content),
            size: bytes,
            builtAt: new Date().toISOString(),
            ...(options.target === undefined ? {} : { target: options.target }),
            ...(options.origin === undefined ? {} : { origin: options.origin }),
        };

        if (sameContent && !options.force) {
            this.store.record(tracked === undefined ? entry : { ...entry, builtAt: tracked.builtAt });

            return { ...base, action: "unchanged" };
        }

        const backup = backUp ? this.backups.copy(dest, options.run) : undefined;

        this.ensureDir(path.dirname(dest));
        fs.writeFileSync(dest, content, "utf8");

        if (options.mode !== undefined) {
            try {
                fs.chmodSync(dest, options.mode);
            } catch {
                // Some platforms cannot change modes; the content is what matters.
            }
        } else if (dest.endsWith(".sh")) {
            fs.chmodSync(dest, 0o755);
        }

        this.store.record(entry);

        return { ...base, action: exists ? "updated" : "created", ...(backup === undefined ? {} : { backup }) };
    }

    async remove(files: readonly string[], options: RemoveOptions = {}): Promise<RemovedFiles> {
        const removed: string[] = [];
        const backedUp: BackedUpFile[] = [];

        for (const file of files) {
            const dest = path.resolve(file);
            const tracked = this.store.entry(dest);

            if (isProtectedPath(dest, this.settings.protectedRoots) || tracked === undefined) {
                continue;
            }

            removed.push(dest);

            // An output edited by hand since sous wrote it is copied away before it is removed.
            const current = fs.existsSync(dest) ? readText(dest) : undefined;
            const backUp = current !== undefined && !isOwnContent(current, tracked);

            if (options.dryRun) {
                if (backUp) {
                    backedUp.push({ file: dest, backup: this.backups.plan(dest, options.run) });
                }

                continue;
            }

            if (backUp) {
                backedUp.push({ file: dest, backup: this.backups.copy(dest, options.run) });
            }

            if (fs.existsSync(dest)) {
                fs.rmSync(dest);
            }

            this.store.forget(dest);
        }

        const dirsRemoved = options.dryRun ? [] : this.removeEmptyDirs();

        return { removed, dirsRemoved, ...(backedUp.length === 0 ? {} : { backedUp }) };
    }

    async commit(options: { dryRun?: boolean; resolvedVars?: VarScope } = {}): Promise<void> {
        this.store.commit(options);
    }

    /** Creates a directory, recording every level the compiler made. */
    private ensureDir(dir: string): void {
        const missing: string[] = [];
        let walk = dir;

        while (!fs.existsSync(walk)) {
            missing.unshift(walk);

            const parent = path.dirname(walk);

            if (parent === walk) {
                break;
            }

            walk = parent;
        }

        if (missing.length === 0) {
            return;
        }

        fs.mkdirSync(dir, { recursive: true });

        for (const created of missing) {
            this.store.recordDir(created);
        }
    }

    /** Removes the directories the compiler created that are now empty, deepest first. */
    private removeEmptyDirs(): string[] {
        const dirs = [...this.store.current().dirs].sort((a, b) => b.split(path.sep).length - a.split(path.sep).length);
        const removed: string[] = [];

        for (const dir of dirs) {
            if (isProtectedPath(dir, this.settings.protectedRoots)) {
                continue;
            }

            try {
                if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
                    fs.rmdirSync(dir);
                    removed.push(dir);
                }
            } catch {
                // A directory that cannot be read or removed stays.
            }
        }

        return removed;
    }
}

/** Whether a file's content is what sous wrote there: the file is tracked and its hash is the one recorded. */
function isOwnContent(current: string, tracked: StateFileEntry | undefined): boolean {
    return tracked !== undefined && hashContent(current) === tracked.destHash;
}

function readText(file: string): string | undefined {
    try {
        return fs.readFileSync(file, "utf8");
    } catch {
        return undefined;
    }
}
