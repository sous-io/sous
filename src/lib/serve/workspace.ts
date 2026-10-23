/**
 * PROOF OF CONCEPT for `sous serve`. Builds the read-only picture of a project
 * that the web editor shows: every source file sous reads, where each one comes
 * from (this project or a recipe in the store), what it compiles to, and the
 * variables it renders with.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { CompilationService, resolveOutputPath, type CompilationConfig } from "../markdown-compiler.js";
import { resolveCompilation, resolveRootScope, type ConfigContext, type Settings } from "../settings.js";
import { resolveProjectAnswers, resolveRecipeTargets, withRecipeTargets } from "../build-service.js";
import { createProjectNamespaceResolver } from "../repos/locked-namespace-resolver.js";
import type { NamespaceResolver } from "../repos/namespace-resolver.js";
import { resolveStoreRoot } from "../sous-home.js";
import { SAMPLE_CONTENT, SAMPLE_DISPLAY } from "./sample.js";

export type FileOrigin =
  | { kind: "project" }
  | {
      kind: "recipe";
      host: string;
      owner: string;
      repo: string;
      namespace: string;
      recipe: string;
      version: string;
      /** Path inside the recipe directory. */
      recipePath: string;
    }
  | { kind: "external" }
  | { kind: "sample" };

export type WorkspaceFile = {
  id: string;
  /** Absolute path on disk. */
  path: string;
  /** Short path for display: relative to the project, or to the store. */
  display: string;
  origin: FileOrigin;
  isTpl: boolean;
  /** "entry" files are compile targets; "partial" files are only included by one. */
  role: "entry" | "partial";
  /** Output files (relative to the project root) this file is the entry point of. */
  outputs: string[];
  /** The variables this file renders with. */
  vars: Record<string, string>;
  /** Content for a file that exists only in memory (the POC sample). */
  virtualContent?: string;
};

export type Workspace = {
  projectName: string;
  projectRoot: string;
  branch: string;
  files: WorkspaceFile[];
  secretNames: string[];
  compilation: CompilationConfig;
  namespaceResolver: NamespaceResolver;
};

function gitBranch(cwd: string): string {
  try {
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, encoding: "utf8" }).trim();
  } catch {
    return "(no git)";
  }
}

/**
 * Reads a store path apart: `<store>/<host>/<owner>/<repo>/<namespace>/<recipe>/<version>/<rest>`.
 */
function originOf(file: string, projectRoot: string, storeRoot: string): FileOrigin {
  const rel = path.relative(storeRoot, file);
  if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
    const [host, owner, repo, namespace, recipe, version, ...rest] = rel.split(path.sep);
    if (rest.length > 0) {
      return { kind: "recipe", host, owner, repo, namespace, recipe, version, recipePath: rest.join("/") };
    }
  }
  const projectRel = path.relative(projectRoot, file);
  if (!projectRel.startsWith("..")) return { kind: "project" };
  return { kind: "external" };
}

/** Runs `fn` with console output swallowed (the compiler logs as it goes). */
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const saved = { log: console.log, warn: console.warn, error: console.error, write: process.stdout.write };
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    return await fn();
  } finally {
    console.log = saved.log;
    console.warn = saved.warn;
    console.error = saved.error;
    process.stdout.write = saved.write;
  }
}

export async function loadWorkspace(settings: Settings, configContext: ConfigContext): Promise<Workspace> {
  const answers = resolveProjectAnswers(settings, configContext);
  const scope = resolveRootScope(settings, configContext, { answers });
  const recipes = resolveRecipeTargets(settings, scope, configContext, answers);
  const compilation = withRecipeTargets(resolveCompilation(settings, scope), recipes, settings, scope);
  if (!compilation) throw new Error(`No compilation config found in ${configContext.configPath}`);

  const namespaceResolver = createProjectNamespaceResolver({ sousDir: configContext.sousDir, settings });
  const projectRoot = path.dirname(configContext.sousDir);
  const storeRoot = resolveStoreRoot();

  const byPath = new Map<string, WorkspaceFile>();
  const add = (file: string, role: WorkspaceFile["role"], vars: Record<string, string>) => {
    const existing = byPath.get(file);
    if (existing) return existing;
    const origin = originOf(file, projectRoot, storeRoot);
    const display =
      origin.kind === "recipe"
        ? `${origin.namespace}/${origin.recipe}/${origin.recipePath}`
        : origin.kind === "project"
          ? path.relative(projectRoot, file)
          : file;
    const entry: WorkspaceFile = {
      id: String(byPath.size + 1),
      path: file,
      display,
      origin,
      isTpl: /\.tpl\./.test(path.basename(file)),
      role,
      outputs: [],
      vars,
    };
    byPath.set(file, entry);
    return entry;
  };

  for (const target of compilation.targets) {
    const vars = target.outputs.find((o) => o.vars)?.vars ?? scope;
    const entry = add(target.rootInputPath, "entry", vars);
    entry.role = "entry";
    for (const output of target.outputs) {
      const dest = resolveOutputPath(target, output);
      if (dest) entry.outputs.push(path.relative(projectRoot, dest));
    }
  }

  // A dry-run compile reads every file the targets include, without writing.
  const compiler = new CompilationService({ dryRun: true, namespaceResolver });
  await quietly(() => compiler.compile(compilation));
  const entries = [...byPath.values()];
  for (const included of compiler.includedFiles()) {
    if (byPath.has(included) || !fs.existsSync(included)) continue;
    // Render a partial with the variables of an entry file from the same place.
    const sibling =
      entries.find((e) => included.startsWith(path.dirname(path.dirname(e.path)))) ?? entries[0];
    add(included, "partial", sibling?.vars ?? scope);
  }

  const rootVars = entries.find((e) => e.origin.kind === "project")?.vars ?? scope;
  const sample: WorkspaceFile = {
    id: "sample",
    path: path.join(configContext.sousDir, SAMPLE_DISPLAY),
    display: SAMPLE_DISPLAY,
    origin: { kind: "sample" },
    isTpl: true,
    role: "entry",
    outputs: [],
    vars: rootVars,
    virtualContent: SAMPLE_CONTENT,
  };

  return {
    projectName: settings.name ?? path.basename(projectRoot),
    projectRoot,
    branch: gitBranch(projectRoot),
    files: [sample, ...byPath.values()],
    secretNames: compilation.secretVariables ?? [],
    compilation,
    namespaceResolver,
  };
}
