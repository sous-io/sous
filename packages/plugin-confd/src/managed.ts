/**
 * `confd.managed`: surgical edits to the managed `conf.d/5xx` files (S2, "Sous's edits to the files
 * it manages are surgical").
 *
 * The managed files sit in the 5xx range of `conf.d`, which sous writes rather than a person:
 * `500-repos.jsonc` (the repositories a project trusts), `510-subscriptions.jsonc` (what it
 * subscribes to), `520-var-mappings.jsonc` (variable mappings), and any a plugin manages. They are
 * `.jsonc`, so each opens with a real comment saying what it holds. Sous edits them key by key
 * through the documents package: a comment beside an entry, the order of the keys and the
 * formatting all survive.
 *
 * A file still under its old `.json` name is read as a fallback and moves to `.jsonc` on the next
 * write, so a project never has both.
 *
 * Intents edit these files, never contributors; the engine rebuilds the config after the intent
 * (S2, "Sous always reads the built config"), so nothing reads a managed file back as config.
 */

import fs from "node:fs";
import path from "node:path";
import { isJsonObject, parseDocument, parsePath, type TextDocument } from "@sous-io/documents";
import { ConfigError, type DocumentNode, type JsonObject, type PatchSet } from "@sous-io/plugin-api";
import type { ConfdManaged, ManagedEditOptions, ManagedEditResult, ManagedLayerName } from "./types.js";

/** The policy every managed file states in its header. */
export const MANAGED_FILE_COMMENT =
    "This file is managed by sous. Sous edits these files by key; you may edit them too, and your comments, key order and formatting are kept.";

/** The closing lines of every header, about the format. */
const FORMAT_NOTE = ["It is JSON with comments (.jsonc): line comments, block comments and trailing", "commas are all allowed here."];

/** What the managed files sous writes itself hold, and which commands write them. */
const DESCRIPTIONS: Readonly<Record<string, readonly string[]>> = {
    "500-repos.jsonc": [
        "It records the repositories this project trusts. The 'sous repo add' and",
        "'sous repo remove' commands write the entries under 'repos'.",
    ],
    "510-subscriptions.jsonc": [
        "It records what this project subscribes to. The 'sous subscription add' and",
        "'sous subscription remove' commands write the entries under 'subscriptions'.",
    ],
};

/** Wraps a sentence into lines of at most `width` characters, once `// ` is added. */
function wrap(text: string, width = 78): string[] {
    const lines: string[] = [];
    let current = "";

    for (const word of text.split(/\s+/)) {
        if (current.length === 0) {
            current = word;
        } else if (`${current} ${word}`.length + 3 <= width) {
            current = `${current} ${word}`;
        } else {
            lines.push(current);
            current = word;
        }
    }

    if (current.length > 0) {
        lines.push(current);
    }

    return lines;
}

/**
 * The header comment a managed file opens with: the policy, what it holds, and the format.
 *
 * ```ts
 * managedHeader("500-repos.jsonc", []);
 * // "// This file is managed by sous. Sous edits these files by key; you may edit\n// them too, ...\n//\n// It records ..."
 * ```
 */
export function managedHeader(name: string, description: readonly string[]): string {
    const what = description.length > 0 ? description : (DESCRIPTIONS[name] ?? []);
    const blocks = [wrap(MANAGED_FILE_COMMENT), what, FORMAT_NOTE].filter((block) => block.length > 0);

    return `${blocks.map((block) => block.map((line) => `// ${line}`.trimEnd()).join("\n")).join("\n//\n")}\n`;
}

/** What the managed files need from the engine. */
export interface ManagedHost {
    /** The `conf.d` directory, or `undefined` outside a project. */
    readonly confDir: string | undefined;
    /** Creates `conf.d` with its README (plugin-host's `host.directories`, when present). */
    ensureDirectory(directory: string): Promise<void>;
}

/** `confd.managed`. */
export class ConfdManagedImpl implements ConfdManaged {
    constructor(private readonly host: ManagedHost) {}

    path(name: ManagedLayerName): string {
        if (this.host.confDir === undefined) {
            throw new ConfigError(`There is no sous project here, so there is no ${name} to edit.`, {
                details: ["Run sous init in the project root first."],
            });
        }

        return path.join(this.host.confDir, name);
    }

    header(name: ManagedLayerName, description: readonly string[]): string {
        return managedHeader(name, description);
    }

    async read(name: ManagedLayerName): Promise<JsonObject | undefined> {
        const existing = this.existing(name);

        if (existing === undefined) {
            return undefined;
        }

        return objectOf(parse(readText(existing), existing).value(), existing);
    }

    async edit(name: ManagedLayerName, edit: (root: DocumentNode) => void, options: ManagedEditOptions = {}): Promise<ManagedEditResult> {
        return this.change(name, `edit ${name}`, edit, options);
    }

    async set(name: ManagedLayerName, keyPath: string, value: unknown, options: ManagedEditOptions = {}): Promise<ManagedEditResult> {
        const segments = parsePath(keyPath);

        return this.change(name, `set ${keyPath}`, (root) => root.atPath(segments).set(value), options);
    }

    async delete(name: ManagedLayerName, keyPath: string, options: ManagedEditOptions = {}): Promise<ManagedEditResult> {
        const segments = parsePath(keyPath);

        // Deleting a key that is not there is already done, even when its parent is missing too.
        return this.change(
            name,
            `delete ${keyPath}`,
            (root) => {
                const node = root.atPath(segments);

                if (node.exists()) {
                    node.delete();
                }
            },
            options,
        );
    }

    /** The file that exists: the `.jsonc` one, or the old `.json` one when only that is there. */
    private existing(name: ManagedLayerName): string | undefined {
        const current = this.path(name);

        if (isFile(current)) {
            return current;
        }

        const legacy = legacyPath(current);

        return legacy !== undefined && isFile(legacy) ? legacy : undefined;
    }

    private async change(
        name: ManagedLayerName,
        label: string,
        edit: (root: DocumentNode) => void,
        options: ManagedEditOptions,
    ): Promise<ManagedEditResult> {
        const file = this.path(name);
        const existing = this.existing(name);
        const original = existing === undefined ? `${managedHeader(name, options.description ?? [])}{}\n` : readText(existing);
        const document = parse(original, existing ?? file);

        objectOf(document.value(), existing ?? file);
        edit(document.root());

        let text = document.toString();

        if (!text.endsWith("\n")) {
            text += "\n";
        }

        const patches: PatchSet = { name: label, patches: document.patches().patches };
        const migrating = existing !== undefined && existing !== file;
        const created = existing === undefined;
        const changed = created ? patches.patches.length > 0 : text !== original || migrating;

        if (changed && options.dryRun !== true) {
            await this.write(file, text);

            if (migrating) {
                fs.rmSync(existing, { force: true });
            }
        }

        return { file, created: created && changed, changed, patches, text };
    }

    /** Writes under a temporary name and renames it into place, so a reader never sees half a file. */
    private async write(file: string, text: string): Promise<void> {
        const directory = path.dirname(file);

        await this.host.ensureDirectory(directory);

        const temporary = path.join(directory, `.${path.basename(file)}.tmp-${process.pid}`);

        try {
            fs.writeFileSync(temporary, text, "utf8");
            fs.renameSync(temporary, file);
        } catch (error) {
            fs.rmSync(temporary, { force: true });
            throw new ConfigError(`Sous could not write its config file at ${file}.`, { cause: error, details: [(error as Error).message] });
        }
    }
}

/** The path a managed file had before managed files became `.jsonc`. */
function legacyPath(file: string): string | undefined {
    return file.endsWith(".jsonc") ? file.slice(0, -1) : undefined;
}

function readText(file: string): string {
    try {
        return fs.readFileSync(file, "utf8");
    } catch (error) {
        throw new ConfigError(`Sous could not read its own config file at ${file}.`, { cause: error, details: [(error as Error).message] });
    }
}

/**
 * Parses a managed file. A file that does not parse is an error naming it, since sous is about to
 * edit it: dropping someone's edits silently would be worse than stopping.
 */
function parse(text: string, file: string): TextDocument {
    try {
        return parseDocument(text, "jsonc");
    } catch (error) {
        throw new ConfigError(`Sous could not read its own config file at ${file}.`, {
            cause: error,
            details: [
                "The file is not valid JSON with comments.",
                "Sous writes this file itself. Restoring it from version control, or deleting it and adding the entries again, both fix this.",
            ],
        });
    }
}

function objectOf(value: unknown, file: string): JsonObject {
    if (!isJsonObject(value)) {
        throw new ConfigError(`The config file at ${file} is not a JSON object.`, { details: ["Sous writes this file itself; it always holds one object."] });
    }

    return value;
}

function isFile(file: string): boolean {
    try {
        return fs.statSync(file).isFile();
    } catch {
        return false;
    }
}
