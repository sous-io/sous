/**
 * PROOF OF CONCEPT for `sous serve`. Resolves every `@include` line in a file
 * the way the build does (sous's own include resolver, aliases, `#` names and
 * `~` recipe references), so the editor can show where each one points and
 * flag the ones the build would fail on.
 */
import path from "node:path";
import { resolveIncludeFiles } from "../include-resolver.js";
import { INCLUDE_LINE_PATTERN } from "../markdown-compiler.js";
import { formatNamespaceProblem } from "../repos/namespace-resolver.js";
import type { Workspace, WorkspaceFile } from "./workspace.js";

export type IncludeInfo = {
  /** 1-based line number. */
  line: number;
  /** The path as written, without the `@`. */
  reference: string;
  glob: boolean;
  files: { id?: string; display: string }[];
  /** Why the build would fail on this line, when it would. */
  error?: string;
};

export function resolveIncludes(workspace: Workspace, file: WorkspaceFile, source: string): IncludeInfo[] {
  const byPath = new Map(workspace.files.map((f) => [f.path, f]));
  const { compilation } = workspace;
  const results: IncludeInfo[] = [];
  const lines = source.split("\n");
  let fence = false;

  lines.forEach((raw, index) => {
    const trimmed = raw.trim();
    if (/^(```|~~~)/.test(trimmed)) fence = !fence;
    if (fence) return;
    const match = INCLUDE_LINE_PATTERN.exec(trimmed);
    if (!match) return;
    const reference = match[1].trim();
    const resolution = resolveIncludeFiles(reference, {
      aliases: compilation.aliases ?? {},
      views: compilation.views,
      scope: compilation.includeScope ?? {},
      baseDir: path.dirname(file.path),
      namespaceResolver: workspace.namespaceResolver,
      fromFile: file.path,
    });
    const files = resolution.files.map((p) => {
      const known = byPath.get(p);
      return { id: known?.id, display: known?.display ?? path.relative(workspace.projectRoot, p) };
    });
    let error: string | undefined;
    if (files.length === 0 && !(resolution.view && resolution.glob && !resolution.hashIssue)) {
      const why = resolution.namespaceIssue
        ? formatNamespaceProblem(resolution.namespaceIssue)
        : resolution.hashIssue ?? `Nothing exists at ${resolution.candidates.slice(0, 2).map((c) => path.relative(workspace.projectRoot, c)).join(" or ")}.`;
      error = `${resolution.glob ? "Matches no files" : "Not found"}. ${why.replace(/\s+/g, " ").trim()}`;
    }
    results.push({ line: index + 1, reference, glob: resolution.glob, files, error });
  });
  return results;
}
