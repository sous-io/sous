/**
 * Writing outputs: the one way any plugin writes a build output. A file the
 * compiler did not write is overwritten and taken over, unless `compilation.overwriteUntracked` is
 * `false`. Every write is recorded in the state file.
 */

import fs from "node:fs";
import path from "node:path";
import type { VarScope } from "@sous-io/plugin-variables/types";
import { hashContent, isProtectedPath, type StateStore } from "./state.js";
import type { CompilerWriter, WriteOptions, WrittenFile } from "./types.js";

/** How the writer behaves. */
export interface WriterSettings {
    /** Overwrite files the compiler did not write. */
    readonly overwriteUntracked: boolean;
    /** Directories nothing may be removed from (linked checkouts, the recipe store). */
    readonly protectedRoots: readonly string[];
}

/** The `compiler.writer` service over one config's state. */
export class WriterService implements CompilerWriter {
    constructor(
        private readonly store: StateStore,
        private readonly settings: WriterSettings,
    ) {}

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
        const sameContent = exists && readText(dest) === content;

        // A file the compiler did not write is left alone when the user said so, even when its
        // content already matches: taking it over would let a later prune delete it.
        if (exists && tracked === undefined && !this.settings.overwriteUntracked) {
            return { ...base, action: "skipped-untracked" };
        }

        if (options.dryRun) {
            return { ...base, action: !exists ? "would-create" : sameContent && !options.force ? "unchanged" : "would-update" };
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

        return { ...base, action: exists ? "updated" : "created" };
    }

    async remove(files: readonly string[], options: { dryRun?: boolean } = {}): Promise<{ removed: string[]; dirsRemoved: string[] }> {
        const removed: string[] = [];

        for (const file of files) {
            const dest = path.resolve(file);

            if (isProtectedPath(dest, this.settings.protectedRoots) || this.store.entry(dest) === undefined) {
                continue;
            }

            removed.push(dest);

            if (options.dryRun) {
                continue;
            }

            if (fs.existsSync(dest)) {
                fs.rmSync(dest);
            }

            this.store.forget(dest);
        }

        const dirsRemoved = options.dryRun ? [] : this.removeEmptyDirs();

        return { removed, dirsRemoved };
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

function readText(file: string): string | undefined {
    try {
        return fs.readFileSync(file, "utf8");
    } catch {
        return undefined;
    }
}
