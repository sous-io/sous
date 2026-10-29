/**
 * The file system Liquid reads `{% render %}` and `{% include %}` paths through: the same alias,
 * `#` name, recipe and `${var}` resolution as an include line, so `{% render "#project/x.md" %}`,
 * `{% render "@docs/y.md" %}` and `{% render "~workflow/task-files/x.md" %}` all work. The leading
 * `@` is optional for a `~` or `#` path. Any other path resolves against Liquid's roots as usual.
 */

import fs from "node:fs";
import path from "node:path";
import type { FS } from "liquidjs";
import type { VarScope } from "@sous-io/plugin-variables/types";
import type { CompilerIncludes } from "../types.js";

/** Where a render is written. */
export interface RenderFsOptions {
    readonly includes: CompilerIncludes;
    /** The variables `${var}` in a render path is substituted from. */
    readonly scope: VarScope;
    /** The template being rendered, for the namespace resolver's scoping. */
    readonly fromFile?: string;
}

/**
 * Makes the file system. A `~` or `#` path that resolves to nothing throws with the reason, so it
 * reaches the user instead of a bare "file not found".
 */
export function createRenderFs(options: RenderFsOptions): FS {
    const resolveSymbolic = (file: string, dir: string): string | null => {
        const isAt = file.startsWith("@");

        if (!isAt && !file.startsWith("~") && !file.startsWith("#")) {
            return null;
        }

        const rawPath = isAt ? file.slice(1) : file;
        const result = options.includes.resolve(rawPath, { fromFile: options.fromFile ?? dir, baseDir: dir, scope: options.scope });

        if (result.files[0] !== undefined) {
            return result.files[0];
        }

        if (result.hashProblem) {
            throw new Error(`Cannot render "${file}"\n  ${result.hashProblem.split("\n").join("\n  ")}`);
        }

        if (result.namespaceProblem) {
            throw new Error(
                `Cannot render "${file}"\n${options.includes.describeNamespaceProblem(result.namespaceProblem)}\n  tried:\n${result.candidates
                    .map((candidate) => `    - ${candidate}`)
                    .join("\n")}`,
            );
        }

        return result.candidates[0] ?? null;
    };

    return {
        resolve(dir: string, file: string, ext: string): string {
            const symbolic = resolveSymbolic(file, dir);

            if (symbolic) {
                return symbolic;
            }

            const joined = path.resolve(dir, file);

            return ext && !path.extname(joined) ? joined + ext : joined;
        },
        existsSync: (file: string) => fs.existsSync(file),
        exists: async (file: string) => fs.existsSync(file),
        readFileSync: (file: string) => fs.readFileSync(file, "utf8"),
        readFile: async (file: string) => fs.promises.readFile(file, "utf8"),
        dirname: (file: string) => path.dirname(file),
        sep: path.sep,
    };
}
