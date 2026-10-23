/**
 * PROOF OF CONCEPT for `sous serve`. A catalog of the recipes in the machine's
 * recipe store (~/.sous/cache), read from each recipe's sous.recipe.yaml, with
 * whether this project subscribes to it and whether a newer version is in the
 * store than the one the project uses.
 */
import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { resolveStoreRoot } from "../sous-home.js";
import type { Workspace } from "./workspace.js";

export type CatalogRecipe = {
  key: string;
  repo: string;
  namespace: string;
  name: string;
  description?: string;
  /** Every version in the store, newest first. */
  versions: string[];
  latest: string;
  /** The version this project uses, if it subscribes. */
  using?: string;
  kinds: string[];
  variables: { name: string; description?: string; secret?: boolean; required?: boolean }[];
  depends: string[];
  /** Number of template files in the version shown. */
  files: number;
  acceptsProposals: boolean;
  proposalsInstead?: string;
};

function semverCompare(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

function countFiles(dir: string): number {
  let n = 0;
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(path.join(d, entry.name));
      else if (entry.name.endsWith(".md")) n++;
    }
  };
  try {
    walk(dir);
  } catch {
    // An unreadable folder counts as empty.
  }
  return n;
}

export function readCatalog(workspace: Workspace): CatalogRecipe[] {
  const store = resolveStoreRoot();
  const using = new Map<string, string>();
  for (const f of workspace.files) {
    if (f.origin.kind === "recipe") using.set(`${f.origin.host}/${f.origin.owner}/${f.origin.repo}/${f.origin.namespace}/${f.origin.recipe}`, f.origin.version);
  }

  const recipes: CatalogRecipe[] = [];
  const dirs = (p: string) => {
    try {
      return fs.readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }
  };
  for (const host of dirs(store))
    for (const owner of dirs(path.join(store, host)))
      for (const repo of dirs(path.join(store, host, owner)))
        for (const namespace of dirs(path.join(store, host, owner, repo)))
          for (const name of dirs(path.join(store, host, owner, repo, namespace))) {
            const base = path.join(store, host, owner, repo, namespace, name);
            const versions = dirs(base)
              .filter((v) => /^\d/.test(v))
              .sort((a, b) => semverCompare(b, a));
            if (versions.length === 0) continue;
            const key = `${host}/${owner}/${repo}/${namespace}/${name}`;
            const current = using.get(key);
            const shown = current ?? versions[0];
            let manifest: Record<string, unknown> = {};
            try {
              manifest = parse(fs.readFileSync(path.join(base, shown, "sous.recipe.yaml"), "utf8")) ?? {};
            } catch {
              // A recipe without a readable manifest still lists.
            }
            const vars = (manifest.variables ?? manifest.vars ?? []) as unknown;
            const variables = Array.isArray(vars)
              ? vars.map((v: Record<string, unknown>) => ({
                  name: String(v.name),
                  description: v.description as string | undefined,
                  secret: Boolean(v.secret),
                  required: v.default === undefined,
                }))
              : Object.entries((vars ?? {}) as Record<string, Record<string, unknown>>).map(([n, v]) => ({
                  name: n,
                  description: v?.description as string | undefined,
                  secret: Boolean(v?.secret),
                  required: v?.default === undefined,
                }));
            const contents = (manifest.contents ?? []) as { kind?: string }[];
            const submissions = (manifest.submissions ?? {}) as { allowed?: boolean; instead?: string };
            const depends = (manifest.depends ?? []) as unknown[];
            recipes.push({
              key,
              repo: `${owner}/${repo}`,
              namespace,
              name,
              description: typeof manifest.description === "string" ? manifest.description.trim() : undefined,
              versions,
              latest: versions[0],
              using: current,
              kinds: [...new Set(contents.map((c) => c.kind).filter((k): k is string => Boolean(k)))],
              variables,
              depends: depends.map((d) => (typeof d === "string" ? d : String((d as Record<string, unknown>).recipe ?? (d as Record<string, unknown>).name ?? ""))).filter(Boolean),
              files: countFiles(path.join(base, shown)),
              acceptsProposals: submissions.allowed !== false,
              proposalsInstead: submissions.instead,
            });
          }
  return recipes.sort((a, b) => Number(Boolean(b.using)) - Number(Boolean(a.using)) || a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name));
}
