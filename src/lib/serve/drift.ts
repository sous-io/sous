/**
 * PROOF OF CONCEPT for `sous serve`. Finds hand edits to built output files: an
 * output on disk that differs from what a fresh build writes. Someone (often an
 * agent) edited CLAUDE.md or a SKILL.md directly, and the next build would
 * silently throw that edit away.
 *
 * For the in-memory sample there is no file on disk, so its "on-disk copy" is
 * simulated: the fresh build with two hand edits applied.
 */
import fs from "node:fs";
import path from "node:path";
import { previewContent, type PreviewBuild } from "./preview-build.js";
import { renderTemplate } from "./render.js";
import type { Workspace } from "./workspace.js";

export type Drift = {
  output: string;
  /** What a fresh build writes. */
  built: string;
  /** What is on disk now. */
  disk: string;
  simulated: boolean;
};

const SAMPLE_EDITS: [string, string][] = [
  [
    "Put the cursor inside any highlighted section to see its Liquid source, edit it,",
    "Click any highlighted section to see its Liquid source and edit it,",
  ],
  [
    "Agents in this project open pull requests without asking.",
    "Agents in this project open pull requests without asking, and link the issue each one fixes.",
  ],
];

export async function findDrift(workspace: Workspace, build: PreviewBuild, fileId: string): Promise<Drift | null> {
  const file = workspace.files.find((f) => f.id === fileId);
  if (!file) return null;

  if (file.origin.kind === "sample") {
    const render = await renderTemplate(workspace, file, file.virtualContent ?? "");
    let disk = render.output;
    for (const [from, to] of SAMPLE_EDITS) disk = disk.replace(from, to);
    return { output: "poc-samples/liquid-showcase.md", built: render.output, disk, simulated: true };
  }

  const out = build.outputs.find((o) => o.entryId === fileId && o.status === "stale");
  if (!out) return null;
  const built = previewContent(out.output);
  const real = path.join(workspace.projectRoot, out.output);
  if (built === undefined || !fs.existsSync(real)) return null;
  return { output: out.output, built, disk: fs.readFileSync(real, "utf8"), simulated: false };
}
