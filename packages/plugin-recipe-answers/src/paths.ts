import path from "node:path";
import type { Environment, ProjectInfo } from "@sous-io/plugin-api";

/** What resolving a path a user wrote needs. */
export interface PathBase {
    readonly env: Environment;
    readonly project: ProjectInfo | undefined;
    /** The front end's global arguments; a string `cwd` among them wins. */
    readonly globals?: Readonly<Record<string, unknown>>;
}

/**
 * Resolves a file path a user wrote (`--file`, `--answers-file`). Services never read
 * `process.cwd()` (S6, rule 6), so a relative path resolves against a `cwd` global when a front end
 * passes one, else the shell's `PWD`, else the project root.
 *
 * ```ts
 * resolveUserPath("answers.yaml", { env: { PWD: "/work" }, project: undefined });
 * // -> "/work/answers.yaml"
 * ```
 */
export function resolveUserPath(file: string, base: PathBase): string {
    if (path.isAbsolute(file)) {
        return file;
    }

    const cwd = base.globals?.cwd;
    const from = typeof cwd === "string" ? cwd : (base.env.PWD ?? base.project?.root);

    return from === undefined ? file : path.resolve(from, file);
}
