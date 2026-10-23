/**
 * PROOF OF CONCEPT for `sous serve`. What a recipe update changes for this
 * project: every file of two versions in the recipe store, rendered with this
 * project's variables, so the diff is what the agent would read, not just the
 * template source.
 */
import fs from "node:fs";
import path from "node:path";
import { resolveStoreRoot } from "../sous-home.js";
import { renderTemplate } from "./render.js";
import type { Workspace, WorkspaceFile } from "./workspace.js";

export type RecipeFileDiff = {
  path: string;
  /** "path-only": the output changes only because it names its own versioned path. */
  status: "added" | "removed" | "changed" | "same" | "path-only";
  /** Rendered with this project's variables (the source, for files that aren't templates). */
  before?: string;
  after?: string;
  sourceChanged: boolean;
};

function listFiles(dir: string, base = dir, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, base, out);
    else out.push(path.relative(base, full));
  }
  return out;
}

export async function recipeDiff(workspace: Workspace, key: string, from: string, to: string): Promise<RecipeFileDiff[]> {
  // key: host/owner/repo/namespace/name
  const parts = key.split("/");
  if (parts.length !== 5 || parts.some((p) => !p || p === ".." || p.includes("\\"))) throw new Error("Bad recipe key");
  if (![from, to].every((v) => /^[\w.+-]+$/.test(v))) throw new Error("Bad version");
  const base = path.join(resolveStoreRoot(), ...parts);
  const dirA = path.join(base, from);
  const dirB = path.join(base, to);
  if (!fs.existsSync(dirA) || !fs.existsSync(dirB)) throw new Error("Both versions must be in the recipe store");

  // Render with the variables of a file this project already uses from the recipe.
  const sample = workspace.files.find((f) => f.origin.kind === "recipe" && `${f.origin.host}/${f.origin.owner}/${f.origin.repo}/${f.origin.namespace}/${f.origin.recipe}` === key);
  const vars = sample?.vars ?? workspace.files[0]?.vars ?? {};

  const render = async (file: string, text: string) => {
    if (!/\.tpl\./.test(path.basename(file))) return text;
    const pseudo: WorkspaceFile = {
      id: "diff",
      path: file,
      display: file,
      origin: { kind: "external" },
      isTpl: true,
      role: "entry",
      outputs: [],
      vars,
    };
    const result = await renderTemplate(workspace, pseudo, text);
    return result.error ? text : result.output;
  };

  const a = new Set(listFiles(dirA));
  const b = new Set(listFiles(dirB));
  const all = [...new Set([...a, ...b])].filter((p) => p.endsWith(".md") || p.endsWith(".yaml")).sort();
  const result: RecipeFileDiff[] = [];
  for (const rel of all) {
    const textA = a.has(rel) ? fs.readFileSync(path.join(dirA, rel), "utf8") : undefined;
    const textB = b.has(rel) ? fs.readFileSync(path.join(dirB, rel), "utf8") : undefined;
    const before = textA === undefined ? undefined : await render(path.join(dirA, rel), textA);
    const after = textB === undefined ? undefined : await render(path.join(dirB, rel), textB);
    result.push({
      path: rel,
      status:
        textA === undefined
          ? "added"
          : textB === undefined
            ? "removed"
            : before === after
              ? "same"
              : before!.split(dirA).join(dirB) === after
                ? "path-only"
                : "changed",
      before,
      after,
      sourceChanged: textA !== textB,
    });
  }
  return result;
}
