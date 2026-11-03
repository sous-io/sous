/**
 * Where each `@include` line in a file points, resolved by the compiler's own resolver, so the
 * editor can link them and flag the ones the build would fail on.
 */
import path from "node:path";
import type { Context } from "@sous-io/plugin-api";
import type {} from "@sous-io/plugin-compiler/types";
import type { IncludeInfo } from "../types.js";
import { scopeOf, type Workspace, type WorkspaceFile } from "./workspace.js";

export function resolveIncludes(ctx: Context, workspace: Workspace, file: WorkspaceFile, source: string): IncludeInfo[] {
    const includes = ctx.services.get("compiler.includes");
    const scope = scopeOf(ctx, file);
    const results: IncludeInfo[] = [];
    let fence = false;

    source.split("\n").forEach((raw, index) => {
        const trimmed = raw.trim();

        if (/^(```|~~~)/.test(trimmed)) fence = !fence;
        if (fence || !includes.isIncludeLine(trimmed)) return;

        const reference = trimmed.slice(1).trim();
        const resolution = includes.resolve(reference, { fromFile: file.path, scope });
        const files = resolution.files.map((found) => {
            const known = workspace.byPath.get(found);

            return known ? { id: known.id, display: known.display } : { display: path.relative(workspace.projectRoot, found) };
        });
        const info: IncludeInfo = { line: index + 1, reference, glob: resolution.glob, files };

        if (files.length === 0 && !(resolution.view && resolution.glob && !resolution.hashProblem)) {
            const why = resolution.namespaceProblem
                ? includes.describeNamespaceProblem(resolution.namespaceProblem)
                : (resolution.hashProblem ?? `Nothing exists at ${resolution.candidates.slice(0, 2).map((candidate) => path.relative(workspace.projectRoot, candidate)).join(" or ")}.`);

            info.error = `${resolution.glob ? "Matches no files" : "No such file"}. ${why.replace(/\s+/g, " ").trim()}`;
        }

        results.push(info);
    });

    return results;
}
