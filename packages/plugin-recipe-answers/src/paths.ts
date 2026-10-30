import path from "node:path";
import type { ProjectInfo } from "@sous-io/plugin-api";

/** What resolving a path a user wrote needs. */
export interface PathBase {
    readonly project: ProjectInfo | undefined;
    /** The working directory: a chain's `ctx.cwd` (the front end's), or a service's (the engine's). */
    readonly cwd?: string;
}

/**
 * Resolves a file path a user wrote (`--file`, `--answers-file`). Plugins never read
 * `process.cwd()`, so a relative path resolves against the working directory the
 * front end gave (`ctx.cwd`), else the project root. Intents resolve it with their `ctx` before
 * handing it to a service, so MCP's directory is honoured too.
 *
 * ```ts
 * resolveUserPath("answers.yaml", { cwd: "/work", project: undefined });
 * // -> "/work/answers.yaml"
 * ```
 */
export function resolveUserPath(file: string, base: PathBase): string {
    if (path.isAbsolute(file)) {
        return file;
    }

    const from = base.cwd ?? base.project?.root;

    return from === undefined ? file : path.resolve(from, file);
}
