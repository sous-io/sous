/**
 * PROOF OF CONCEPT for `sous serve`. Everything the "Send changes" dialog can
 * learn for real, before it proposes anything:
 *
 * - each recipe's manifest from the store (version, variables, `submissions`),
 * - its released versions from the cached repository index,
 * - the repository manifest's `contribute:` pointer (a linked checkout, or GitHub),
 * - upstream HEAD: the recipe's manifest version there and each edited file's text,
 * - whether `gh` is signed in (the account name only, never a token) and whether
 *   that account can push to the repository.
 *
 * GET /api/contribute-info?ids=1,2
 *
 * Nothing here writes, forks, pushes or opens anything.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { resolveSousHome, resolveStoreRoot } from "../sous-home.js";
import type { Workspace, WorkspaceFile } from "./workspace.js";

type Run = { ok: boolean; stdout: string; stderr: string; ms: number };

function run(cmd: string, args: string[], timeout = 4000, cwd?: string): Promise<Run> {
  const started = Date.now();
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, cwd, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), ms: Date.now() - started });
    });
  });
}

// gh answers are cached for a minute, so reopening the dialog is instant.
const cache = new Map<string, { at: number; value: Promise<unknown> }>();
function cached<T>(key: string, fn: () => Promise<T>, ttl = 60_000): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.value as Promise<T>;
  const value = fn();
  cache.set(key, { at: Date.now(), value });
  return value;
}

export type GhStatus = {
  installed: boolean;
  signedIn: boolean;
  account?: string;
  host: string;
  message: string;
  ms: number;
};

async function ghStatus(host: string): Promise<GhStatus> {
  return cached(`auth:${host}`, async () => {
    const r = await run("gh", ["auth", "status", "--hostname", host], 3000);
    const text = `${r.stdout}\n${r.stderr}`;
    const installed = !/ENOENT|not found/i.test(text) || r.ok;
    const account = /account\s+([A-Za-z0-9-]+)/.exec(text)?.[1] ?? /as\s+([A-Za-z0-9-]+)/.exec(text)?.[1];
    // Never pass token lines on.
    const message = text
      .split("\n")
      .filter((l) => l.trim() && !/token/i.test(l))
      .map((l) => l.trim())
      .slice(0, 3)
      .join(" · ");
    return { installed: r.ok || installed, signedIn: r.ok, account, host, message, ms: r.ms };
  });
}

async function ghJson<T>(key: string, args: string[]): Promise<T | null> {
  return cached(key, async () => {
    const r = await run("gh", ["api", ...args], 5000);
    if (!r.ok) return null;
    try {
      return JSON.parse(r.stdout) as T;
    } catch {
      return null;
    }
  });
}

async function ghRaw(key: string, apiPath: string): Promise<string | null> {
  return cached(key, async () => {
    const r = await run("gh", ["api", "-H", "Accept: application/vnd.github.raw", apiPath], 5000);
    return r.ok ? r.stdout : null;
  });
}

function readYaml(file: string): Record<string, unknown> | null {
  try {
    return parseYaml(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function semverCompare(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

export type RecipeInfo = {
  key: string;
  repoKey: string;
  pinned: string;
  description?: string;
  manifestPath: string;
  /** Path of the recipe inside its repository, from the index (e.g. recipes/workflow/task-files). */
  repoPath: string;
  variables: { name: string; type?: string; required?: boolean; secret?: boolean; prompt?: string }[];
  submissions: { allowed: boolean; instead?: string } | null;
  /** Where `submissions.instead` points, when it names an owner/repo and a path. */
  redirect?: { owner: string; repo: string; path: string; canPush: boolean | null };
  released: { version: string; releasedAt?: string; tag?: string }[];
  latestReleased?: string;
  /** The version in the manifest at upstream HEAD, or null when GitHub couldn't be asked. */
  headVersion: string | null;
  /** True when the HEAD version already has a tag (so a change must raise it). */
  headTagged: boolean | null;
};

export type RepoInfo = {
  key: string;
  host: string;
  owner: string;
  repo: string;
  name?: string;
  contribute?: string;
  manifestSource: "checkout" | "github" | null;
  checkout: { path: string; branch: string; head: string; when: string; subject: string } | null;
  defaultBranch: string | null;
  head: { sha: string; date: string; message: string } | null;
  canPush: boolean | null;
  indexGeneratedAt?: string;
};

export type ContributeInfo = {
  gh: GhStatus;
  git: { userName?: string; userEmail?: string };
  repos: Record<string, RepoInfo>;
  recipes: Record<string, RecipeInfo>;
  files: Record<string, { upstreamPath: string; upstream: string | null; recipe: string }>;
  ms: number;
};

function findCheckout(projectRoot: string, owner: string, repo: string): string | null {
  const candidates = [
    path.join(projectRoot, ".sous", "repos", owner, repo),
    path.join(resolveSousHome(), "repos", owner, repo),
  ];
  return candidates.find((c) => fs.existsSync(path.join(c, "sous.repo.yaml"))) ?? null;
}

async function repoInfo(workspace: Workspace, host: string, owner: string, repo: string): Promise<RepoInfo> {
  const key = `${host}/${owner}/${repo}`;
  const info: RepoInfo = {
    key,
    host,
    owner,
    repo,
    manifestSource: null,
    checkout: null,
    defaultBranch: null,
    head: null,
    canPush: null,
  };
  const checkoutDir = findCheckout(workspace.projectRoot, owner, repo);
  if (checkoutDir) {
    const manifest = readYaml(path.join(checkoutDir, "sous.repo.yaml"));
    if (manifest) {
      info.name = manifest.name as string;
      info.contribute = manifest.contribute as string | undefined;
      info.manifestSource = "checkout";
    }
    const log = await run("git", ["log", "-1", "--format=%h%x09%cr%x09%s"], 3000, checkoutDir);
    const branch = await run("git", ["branch", "--show-current"], 3000, checkoutDir);
    const [head, when, subject] = log.stdout.trim().split("\t");
    info.checkout = { path: checkoutDir, branch: branch.stdout.trim(), head: head ?? "", when: when ?? "", subject: subject ?? "" };
  }
  if (host === "github.com") {
    const [meta, manifestText] = await Promise.all([
      ghJson<{ default_branch: string; permissions?: { push?: boolean } }>(`repo:${key}`, [`repos/${owner}/${repo}`]),
      info.manifestSource ? Promise.resolve(null) : ghRaw(`repoyaml:${key}`, `repos/${owner}/${repo}/contents/sous.repo.yaml`),
    ]);
    if (meta) {
      info.defaultBranch = meta.default_branch;
      info.canPush = meta.permissions?.push ?? false;
      const commit = await ghJson<{ sha: string; commit: { committer: { date: string }; message: string } }>(
        `head:${key}`,
        [`repos/${owner}/${repo}/commits/${meta.default_branch}`]
      );
      if (commit)
        info.head = { sha: commit.sha.slice(0, 7), date: commit.commit.committer.date, message: commit.commit.message.split("\n")[0] };
    }
    if (manifestText) {
      try {
        const manifest = parseYaml(manifestText) as Record<string, unknown>;
        info.name = manifest.name as string;
        info.contribute = manifest.contribute as string | undefined;
        info.manifestSource = "github";
      } catch {
        // leave it out
      }
    }
  }
  const index = path.join(resolveStoreRoot(), "_indexes", host, owner, `${repo}.json`);
  try {
    info.indexGeneratedAt = (JSON.parse(fs.readFileSync(index, "utf8")) as { generatedAt?: string }).generatedAt;
  } catch {
    // no cached index
  }
  return info;
}

function indexRecipe(host: string, owner: string, repo: string, key: string) {
  try {
    const index = JSON.parse(
      fs.readFileSync(path.join(resolveStoreRoot(), "_indexes", host, owner, `${repo}.json`), "utf8")
    ) as { recipes?: Record<string, { path?: string; versions?: Record<string, { releasedAt?: string; tag?: string }> }> };
    return index.recipes?.[key] ?? null;
  } catch {
    return null;
  }
}

async function recipeInfo(file: WorkspaceFile): Promise<RecipeInfo | null> {
  const o = file.origin;
  if (o.kind !== "recipe") return null;
  const key = `${o.namespace}/${o.recipe}`;
  const versionDir = file.path.slice(0, file.path.length - o.recipePath.length).replace(/[\\/]$/, "");
  const manifestPath = ["sous.recipe.yaml", "sous.recipe.yml"].map((n) => path.join(versionDir, n)).find(fs.existsSync) ?? "";
  const manifest = manifestPath ? readYaml(manifestPath) : null;
  const fromIndex = indexRecipe(o.host, o.owner, o.repo, key);
  const released = Object.entries(fromIndex?.versions ?? {})
    .map(([version, v]) => ({ version, releasedAt: v.releasedAt, tag: v.tag }))
    .sort((a, b) => semverCompare(a.version, b.version));
  const repoPath = fromIndex?.path ?? `recipes/${key}`;
  const submissions = (manifest?.submissions as { allowed?: boolean; instead?: string } | undefined) ?? null;

  let headVersion: string | null = null;
  if (o.host === "github.com") {
    const text = await ghRaw(`manifest:${o.owner}/${o.repo}/${repoPath}`, `repos/${o.owner}/${o.repo}/contents/${repoPath}/sous.recipe.yaml`);
    if (text) {
      try {
        headVersion = String((parseYaml(text) as { version?: string }).version ?? "") || null;
      } catch {
        headVersion = null;
      }
    }
  }

  let redirect: RecipeInfo["redirect"];
  const instead = submissions?.instead;
  const m = instead ? /([\w.-]+)\/([\w.-]+),?\s+under\s+([\w./-]+)/i.exec(instead) : null;
  if (m) {
    const meta = await ghJson<{ permissions?: { push?: boolean } }>(`repo:github.com/${m[1]}/${m[2]}`, [`repos/${m[1]}/${m[2]}`]);
    redirect = { owner: m[1], repo: m[2], path: m[3].replace(/\.$/, ""), canPush: meta ? (meta.permissions?.push ?? false) : null };
  }

  const variables = ((manifest?.variables as Record<string, unknown>[] | undefined) ?? []).map((v) => ({
    name: String(v.name),
    type: v.type as string | undefined,
    required: v.required as boolean | undefined,
    secret: v.secret as boolean | undefined,
    prompt: v.prompt as string | undefined,
  }));

  return {
    key,
    repoKey: `${o.host}/${o.owner}/${o.repo}`,
    pinned: o.version,
    description: manifest?.description as string | undefined,
    manifestPath,
    repoPath,
    variables,
    submissions: submissions ? { allowed: submissions.allowed !== false, instead: submissions.instead } : null,
    redirect,
    released,
    latestReleased: released.at(-1)?.version,
    headVersion,
    headTagged: headVersion === null ? null : released.some((r) => r.version === headVersion),
  };
}

export async function contributeInfo(workspace: Workspace, ids: string[]): Promise<ContributeInfo> {
  const started = Date.now();
  const files = ids.map((id) => workspace.files.find((f) => f.id === id)).filter((f): f is WorkspaceFile => !!f);
  const recipeFiles = files.filter((f) => f.origin.kind === "recipe");
  const hosts = new Set(recipeFiles.map((f) => (f.origin.kind === "recipe" ? f.origin.host : "")));

  const [gh, userName, userEmail] = await Promise.all([
    ghStatus([...hosts][0] ?? "github.com"),
    run("git", ["config", "user.name"], 2000, workspace.projectRoot),
    run("git", ["config", "user.email"], 2000, workspace.projectRoot),
  ]);

  const repoKeys = new Map<string, { host: string; owner: string; repo: string }>();
  const recipeByKey = new Map<string, WorkspaceFile>();
  for (const f of recipeFiles) {
    if (f.origin.kind !== "recipe") continue;
    repoKeys.set(`${f.origin.host}/${f.origin.owner}/${f.origin.repo}`, f.origin);
    recipeByKey.set(`${f.origin.namespace}/${f.origin.recipe}`, f);
  }

  const recipeList = await Promise.all([...recipeByKey.values()].map(recipeInfo));
  // A recipe that takes its proposals elsewhere (core/sous-skills → sous-io/sous) needs that repo too.
  for (const r of recipeList)
    if (r?.redirect && r.submissions?.allowed === false)
      repoKeys.set(`github.com/${r.redirect.owner}/${r.redirect.repo}`, { host: "github.com", owner: r.redirect.owner, repo: r.redirect.repo });
  const repoList = await Promise.all([...repoKeys.values()].map((r) => repoInfo(workspace, r.host, r.owner, r.repo)));
  const recipes = Object.fromEntries(recipeList.filter((r): r is RecipeInfo => !!r).map((r) => [r.key, r]));

  const fileEntries = await Promise.all(
    recipeFiles.map(async (f) => {
      if (f.origin.kind !== "recipe") return null;
      const key = `${f.origin.namespace}/${f.origin.recipe}`;
      const recipe = recipes[key];
      const base = recipe?.redirect && recipe.submissions?.allowed === false ? recipe.redirect : null;
      const owner = base?.owner ?? f.origin.owner;
      const repo = base?.repo ?? f.origin.repo;
      const dir = base ? base.path.replace(/\/$/, "") : (recipe?.repoPath ?? `recipes/${key}`);
      const upstreamPath = `${dir}/${f.origin.recipePath}`;
      const upstream =
        f.origin.host === "github.com" ? await ghRaw(`file:${owner}/${repo}/${upstreamPath}`, `repos/${owner}/${repo}/contents/${upstreamPath}`) : null;
      return [f.id, { upstreamPath, upstream, recipe: key }] as const;
    })
  );

  return {
    gh,
    git: { userName: userName.stdout.trim() || undefined, userEmail: userEmail.stdout.trim() || undefined },
    repos: Object.fromEntries(repoList.map((r) => [r.key, r])),
    recipes,
    files: Object.fromEntries(fileEntries.filter((e): e is NonNullable<typeof e> => !!e)),
    ms: Date.now() - started,
  };
}

/**
 * Looks for the value of a secret variable in the lines a change adds. Only the
 * variable's name and the line's position come back, never the value.
 *
 * POST /api/contribute-info {added: {<file id>: string[]}}
 */
export function scanSecrets(
  workspace: Workspace,
  added: Record<string, string[]>
): { hits: { id: string; line: number; name: string }[] } {
  const secret = new Set(workspace.secretNames);
  const looksSecret = /(secret|token|password|api[_-]?key|private)/i;
  const hits: { id: string; line: number; name: string }[] = [];
  for (const [id, lines] of Object.entries(added)) {
    const file = workspace.files.find((f) => f.id === id);
    if (!file) continue;
    const secrets = Object.entries(file.vars).filter(
      ([name, value]) => (secret.has(name) || looksSecret.test(name)) && typeof value === "string" && value.length >= 4
    );
    lines.forEach((text, line) => {
      for (const [name, value] of secrets) if (text.includes(value)) hits.push({ id, line, name });
    });
  }
  return { hits };
}
