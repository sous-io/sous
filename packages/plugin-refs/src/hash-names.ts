/**
 * The `#` names: the names an include line, a `{% render %}` path or an `entryGlob` may start with,
 * such as `#project`. `~` keeps meaning the home directory and recipe namespaces; `#` is for names
 * sous or a plugin provides. Each is a `hash-name` entity, and a plugin adds one the same way.
 */

import type { SousSchema } from "@sous-io/plugin-api";
import type { HashNameEntity } from "./types.js";

/** The characters a `#` name may hold. */
const VALID_NAME = /^[a-z][a-z0-9-]*$/;

/** The schema every `hash-name` entity is checked against. */
export const hashNameSchema: SousSchema<HashNameEntity, HashNameEntity> = {
    "~standard": {
        version: 1,
        vendor: "sous",
        validate(value: unknown) {
            const entry = value as Partial<HashNameEntity> | null;
            const issues: Array<{ message: string; path?: PropertyKey[] }> = [];

            if (typeof entry !== "object" || entry === null) {
                return { issues: [{ message: "Expected an object." }] };
            }

            if (typeof entry.id !== "string" || !VALID_NAME.test(entry.id)) {
                issues.push({
                    message: `The name '#${String(entry.id)}' is invalid: a name is lowercase kebab-case, a letter then letters, digits or hyphens.`,
                    path: ["id"],
                });
            }

            if (typeof entry.description !== "string") {
                issues.push({ message: "Required, but missing.", path: ["description"] });
            }

            if (entry.bases !== undefined && typeof entry.bases !== "function") {
                issues.push({ message: "Expected a function.", path: ["bases"] });
            }

            if (entry.view !== undefined && typeof entry.view !== "function") {
                issues.push({ message: "Expected a function.", path: ["view"] });
            }

            if (entry.bases !== undefined && entry.view !== undefined) {
                issues.push({ message: "A name either stands for directories ('bases') or lists files ('view'), not both." });
            }

            return issues.length > 0 ? { issues } : { value: entry as HashNameEntity };
        },
    },
};

/** The built-in `#project`: the root of the project being built (the directory holding `.sous/`). */
export const projectHashName: HashNameEntity = {
    id: "project",
    description: "the root directory of the project being built.",
    bases: (ctx) => (ctx.project === undefined ? [] : [ctx.project.root]),
};
