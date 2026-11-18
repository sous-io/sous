/**
 * The `/reload-plugins` line (spec 01). Claude Code loads a project's plugins when a session starts
 * or on `/reload-plugins`, so when a build adds, changes or removes any file of a Claude Code plugin
 * the build ends with one line saying to reload:
 *
 * ```text
 * A Claude Code plugin changed (session-harness). Run /reload-plugins in any open Claude Code session.
 * ```
 *
 * A plugin is any folder holding `.claude-plugin/plugin.json`, whichever way the recipe shipped it
 * (the `claude-code-plugin` kind, or listed among its skills). This line is the only thing that
 * recognition drives.
 */

import fs from "node:fs";
import path from "node:path";
import type { Sous } from "@sous-io/plugin-api";
import type {} from "@sous-io/sous-plugin-build/types";
import type { WriteAction } from "@sous-io/sous-plugin-compiler/types";

/** The manifest that makes a folder a Claude Code plugin, relative to the folder. */
export const PLUGIN_MANIFEST = path.join(".claude-plugin", "plugin.json");

/** The write actions that change a file. */
const CHANGING: ReadonlySet<WriteAction> = new Set(["created", "updated", "would-create", "would-update"]);

/**
 * The plugin folder a changed file belongs to: the nearest folder at or above it, inside `root`,
 * that holds `.claude-plugin/plugin.json`, or that did until this build removed it.
 *
 * ```ts
 * pluginFolderOf("/p/.claude/skills/sh/hooks/hooks.json", "/p", exists);
 * // -> "/p/.claude/skills/sh"   (when /p/.claude/skills/sh/.claude-plugin/plugin.json exists)
 * ```
 */
export function pluginFolderOf(file: string, root: string, exists: (file: string) => boolean, removed: ReadonlySet<string> = new Set()): string | undefined {
    const resolvedRoot = path.resolve(root);
    let dir = path.dirname(path.resolve(file));

    while (dir === resolvedRoot || dir.startsWith(resolvedRoot + path.sep)) {
        const manifest = path.join(dir, PLUGIN_MANIFEST);

        if (exists(manifest) || removed.has(manifest)) {
            return dir;
        }

        if (dir === resolvedRoot) {
            break;
        }

        dir = path.dirname(dir);
    }

    return undefined;
}

/**
 * The line, or `undefined` when no plugin changed.
 *
 * ```ts
 * reloadLine(["sh"], false);
 * // -> "A Claude Code plugin changed (sh). Run /reload-plugins in any open Claude Code session."
 * reloadLine(["kw", "sh"], true);
 * // -> "Claude Code plugins would change (kw, sh). Run /reload-plugins in any open Claude Code session after the build."
 * ```
 */
export function reloadLine(names: readonly string[], dryRun: boolean): string | undefined {
    if (names.length === 0) {
        return undefined;
    }

    const sorted = [...new Set(names)].sort();
    const one = sorted.length === 1;
    const subject = one ? "A Claude Code plugin" : "Claude Code plugins";
    const verb = dryRun ? "would change" : "changed";
    const when = dryRun ? " after the build" : "";

    return `${subject} ${verb} (${sorted.join(", ")}). Run /reload-plugins in any open Claude Code session${when}.`;
}

/** What one build changed, until it ends. */
interface Changes {
    readonly files: Set<string>;
    readonly removed: Set<string>;
    dryRun: boolean;
}

/**
 * Listens to what the compiler writes and the prune removes, and prints the line when the build
 * ends. Changes are kept per command chain, so two builds in one process do not mix.
 */
export function registerReloadLine(sous: Pick<Sous, "on">, exists: (file: string) => boolean = fs.existsSync): void {
    const pending = new Map<number | "none", Changes>();
    const changesFor = (chain: number | undefined): Changes => {
        const key = chain ?? "none";
        let changes = pending.get(key);

        if (changes === undefined) {
            changes = { files: new Set(), removed: new Set(), dryRun: false };
            pending.set(key, changes);
        }

        return changes;
    };

    sous.on("compiler.wrote", (event, ctx) => {
        const changes = changesFor(ctx.chain?.id);

        changes.dryRun ||= event.payload.dryRun;

        for (const file of event.payload.files) {
            if (CHANGING.has(file.action)) {
                changes.files.add(path.resolve(file.file));
            }
        }
    });

    sous.on("compiler.pruned", (event, ctx) => {
        const changes = changesFor(ctx.chain?.id);

        changes.dryRun ||= event.payload.dryRun;

        for (const file of event.payload.removed) {
            changes.files.add(path.resolve(file));
            changes.removed.add(path.resolve(file));
        }
    });

    sous.on("build.after", (_event, ctx) => {
        const key = ctx.chain?.id ?? "none";
        const changes = pending.get(key);

        pending.delete(key);

        if (changes === undefined || ctx.project === undefined) {
            return;
        }

        const folders = new Set<string>();

        for (const file of changes.files) {
            const folder = pluginFolderOf(file, ctx.project.root, exists, changes.removed);

            if (folder !== undefined) {
                folders.add(path.basename(folder));
            }
        }

        const line = reloadLine([...folders], changes.dryRun);

        if (line !== undefined) {
            ctx.reporter.notice(line);
        }
    });
}
