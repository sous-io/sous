/**
 * The `editor` config key: `editor.edits`, the master list, and where the history is kept. Each
 * entry is checked by the same code that applies it (`normalizeEntry`), so a misspelt operation,
 * a missing parameter or a short form is a `ConfigError` naming the entry.
 */

import type { ConfigKeyEntity } from "@sous-io/plugin-api";
import { z } from "zod";
import { normalizeEntry } from "./entries.js";

/** One entry: an object, checked against the operations and checks the editor knows. */
export const entrySchema = z.record(z.string(), z.unknown()).superRefine((entry, ctx) => {
    try {
        normalizeEntry(entry);
    } catch (error) {
        ctx.addIssue({ code: "custom", message: error instanceof Error ? error.message : String(error) });
    }
});

/** The `editor` key. */
export const editorSchema = z
    .object({
        edits: z
            .array(entrySchema)
            .default([])
            .describe(
                "The master list of edits to files Sous does not own: each entry names a file and one or more operations, an assertion or a silence. Sous applies them after the compiler, records them, and undoes the ones no longer declared.",
            ),
        historyFile: z
            .string()
            .optional()
            .describe("Where Sous records the edits it applied, so it can undo them. Default: <sousDir>/sous.edits.json (git-ignored)."),
    })
    .strict();

/** The config key this plugin owns. */
export const EDITOR_CONFIG_KEY: ConfigKeyEntity = {
    id: "editor",
    schema: editorSchema.optional(),
    description: "Edits to files Sous does not own (editor.edits), applied, recorded and undone by the editor.",
};
