/**
 * One-line descriptions of patches, as `sous config show --layers` lists them (S2, "Patches").
 */
import { formatPath, parsePath } from "./path.js";
import { isPatchSet } from "./patch-set.js";
import type { Patch, PatchSet } from "./types.js";

/**
 * The operation and the place it acts on.
 *
 * ```ts
 * describePatch({ op: "removeIndex", path: "compilation.targets", index: 7 });
 * // "removeIndex compilation.targets[7]"
 * describePatch({ op: "renameKey", path: "tools", key: "codex", to: "openai" });
 * // "renameKey tools.codex → tools.openai"
 * ```
 */
export function describePatch(patch: Patch): string {
    const base = parsePath(patch.path);

    switch (patch.op) {
        case "setKey":
        case "deleteKey":
            return `${patch.op} ${formatPath([...base, patch.key])}`;
        case "renameKey":
            return `renameKey ${formatPath([...base, patch.key])} → ${formatPath([...base, patch.to])}`;
        case "insertAt":
            return patch.index === "end"
                ? `insertAt ${patch.path}[end]`
                : `insertAt ${formatPath([...base, patch.index])}`;
        case "setIndex":
        case "removeIndex":
            return `${patch.op} ${formatPath([...base, patch.index])}`;
    }
}

/**
 * A patch set as indented lines: the set's name and path, then what it holds, two spaces deeper
 * per level.
 *
 * ```ts
 * describePatchSet({ name: "removeWhere", path: "compilation.targets", patches: [removeIndex7] });
 * // "removeWhere compilation.targets\n  removeIndex compilation.targets[7]"
 * ```
 */
export function describePatchSet(set: PatchSet, indent = 0): string {
    const lines: string[] = [];

    describeInto(set, indent, lines);

    return lines.join("\n");
}

function describeInto(set: PatchSet, indent: number, lines: string[]): void {
    const pad = " ".repeat(indent);

    lines.push(set.path === undefined || set.path === "" ? `${pad}${set.name}` : `${pad}${set.name} ${set.path}`);

    for (const item of set.patches) {
        if (isPatchSet(item)) {
            describeInto(item, indent + 2, lines);
        } else {
            lines.push(`${pad}  ${describePatch(item)}`);
        }
    }
}
