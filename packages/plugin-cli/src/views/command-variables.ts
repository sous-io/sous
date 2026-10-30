import path from "node:path";
import type { CliViewContext } from "../types.js";

/**
 * The project lines of the "Command Variables" block most commands open their output with, as
 * before 1.0: the project's name (the config's `name`, else its directory's) and its config file.
 * Empty outside a project.
 *
 * ```ts
 * projectVariables(view);   // { Project: "my-app", Config: "/work/my-app/.sous/sous.config.js" }
 * ```
 */
export function projectVariables(view: Pick<CliViewContext, "project" | "projectName">): Record<string, unknown> {
    const entries: Record<string, unknown> = {};

    if (view.project !== undefined) {
        entries.Project = view.projectName ?? path.basename(view.project.root);

        if (view.project.configPath !== undefined) {
            entries.Config = view.project.configPath;
        }
    }

    return entries;
}
