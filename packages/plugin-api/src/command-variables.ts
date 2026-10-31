import type { Context } from "./context.js";
import { IntentOutput, VariableSet } from "./outputs.js";
import { ReportEntryStyle } from "./report-styles.js";

/**
 * The "Command Variables" output most commands open their result with: the project's name (the
 * config's `name`, else its directory's name), its config file, then `extra` in its key order.
 * Outside a project it holds only `extra`.
 *
 * ```ts
 * return new IntentOutputs([commandVariables(ctx, { Reading: "the cached indexes" }), listing]);
 * // Project: my-app / Config: /work/my-app/.sous/sous.config.js / Reading: the cached indexes
 * ```
 */
export function commandVariables(ctx: Pick<Context, "project" | "config">, extra: Readonly<Record<string, unknown>> = {}): IntentOutput {
    const entries: Record<string, unknown> = {};

    if (ctx.project !== undefined) {
        const name = ctx.config.get<string>(["name"]);

        entries.Project = typeof name === "string" && name !== "" ? name : baseName(ctx.project.root);

        if (ctx.project.configPath !== undefined) {
            entries.Config = ctx.project.configPath;
        }
    }

    return new IntentOutput({ title: "Command Variables", result: new VariableSet({ ...entries, ...extra }), style: ReportEntryStyle.CommandVariables });
}

/** The last segment of a path, on any platform. */
function baseName(directory: string): string {
    const parts = directory.split(/[\\/]/).filter((part) => part !== "");

    return parts[parts.length - 1] ?? directory;
}
