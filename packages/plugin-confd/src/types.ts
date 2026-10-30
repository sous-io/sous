/**
 * The contract of plugin-confd: the `conf.d` files,
 * one contributor per file (`confd/<file name>`, each `after` the one before, the first after
 * `config-files.main`), patch files in `conf.d`, and surgical edits to the managed `conf.d/5xx`
 * files. Managed files are edited key by key, by intents, never by contributors.
 *
 * Other plugins import this file type-only.
 */

import type { DocumentNode, JsonObject, PatchSet } from "@sous-io/plugin-api";
import type { ConfigFileFormat } from "@sous-io/plugin-config-files/types";

/** One file in `conf.d`. */
export interface ConfdFile {
    /** The file name: `610-mac.jsonc`. */
    readonly name: string;
    readonly path: string;
    readonly format: ConfigFileFormat;
    /** The contributor id that applies it: `confd/610-mac.jsonc`. */
    readonly contributor: string;
    /** True for a file sous manages (`5xx`). */
    readonly managed: boolean;
}

/** Finding the `conf.d` files, in bytewise order. */
export interface ConfdFiles {
    /** The `conf.d` directory, or `undefined` outside a project. */
    directory(): string | undefined;
    /** Every file sous reads there, bytewise. */
    list(): ConfdFile[];
}

/** The managed files sous writes; plugins may manage files of their own in the 5xx range. */
export type ManagedLayerName = "500-repos.jsonc" | "510-subscriptions.jsonc" | "520-var-mappings.jsonc" | (string & {});

/** Options for one surgical edit. */
export interface ManagedEditOptions {
    /** The lines of the header comment written when the file is created. */
    description?: readonly string[];
    /** Computes the change and the new text, writing nothing. */
    dryRun?: boolean;
}

/** What one edit did. */
export interface ManagedEditResult {
    readonly file: string;
    /** True when the file did not exist. */
    readonly created: boolean;
    /** True when its text changed. */
    readonly changed: boolean;
    /** The primitive changes made, under the name of the edit. */
    readonly patches: PatchSet;
    /** The file's text after the edit (written, or what would be written on a dry run). */
    readonly text: string;
}

/**
 * Surgical edits to the managed `conf.d/5xx` files: comments, key order and
 * formatting stay, and user edits outside the keys touched survive. An intent that edits one
 * declares `changesConfig`, so the config is rebuilt after it.
 */
export interface ConfdManaged {
    /** The path of a managed file in this project. */
    path(name: ManagedLayerName): string;
    /** The file's data as written, or `undefined` when it does not exist. */
    read(name: ManagedLayerName): Promise<JsonObject | undefined>;
    /** Edits the file through a document node at its root, creating it with a header when missing. */
    edit(name: ManagedLayerName, edit: (root: DocumentNode) => void, options?: ManagedEditOptions): Promise<ManagedEditResult>;
    /** Sets one value. */
    set(name: ManagedLayerName, path: string, value: unknown, options?: ManagedEditOptions): Promise<ManagedEditResult>;
    /** Deletes one value; deleting a missing key does nothing. */
    delete(name: ManagedLayerName, path: string, options?: ManagedEditOptions): Promise<ManagedEditResult>;
    /** The header comment sous writes at the top of a managed file. */
    header(name: ManagedLayerName, description: readonly string[]): string;
}

declare module "@sous-io/plugin-api" {
    interface SousServices {
        /** The `conf.d` files. */
        "confd.files": ConfdFiles;
        /** Surgical edits to the managed files. */
        "confd.managed": ConfdManaged;
    }
}
