/**
 * What the "Send changes" dialog and the proposals page learn for real, before anything is
 * proposed. Nothing here writes, forks, pushes or opens anything.
 *
 * ```text
 * web.contribute-info   the host CLI's sign-in, git's user, each repository's push access and
 *                       upstream HEAD, each recipe's manifest facts, each file's upstream text
 * web.scan-secrets      a secret variable's value in the lines a change adds
 * web.my-prs            the signed-in account's pull requests on the repositories the project uses
 * ```
 *
 * Each fact comes from its owner: the `repository-host` entity for sign-in, push access and reading
 * upstream files; `recipes.active`, `recipes.index-cache` and `recipes.links` for the recipes, their
 * released versions and linked checkouts; `formats.manifests` for manifests; `git.runner` for git;
 * `variables.secrets` for what counts as a secret. What no owner answers yet (the account's login,
 * a repository's default branch and HEAD commit, the account's own pull requests) is asked of
 * GitHub through `gh` on `host.processes`, and only for hosts the `github` entity owns.
 */
import type { Context } from "@sous-io/plugin-api";
import type {} from "@sous-io/plugin-formats/types";
import type {} from "@sous-io/plugin-git/types";
import type {} from "@sous-io/plugin-host/types";
import type { RepositoryHostEntity } from "@sous-io/plugin-recipes/types";
import type {} from "@sous-io/plugin-variables/types";
import type { ContributeInfo, ContributeRecipe, ContributeRepo, GhStatus, MyPr, MyPrs, MyPrsRepo, SecretHit } from "../types.js";
import { scopeOf, workspaceOf, type Workspace, type WorkspaceFile } from "./workspace.js";

type Host = RepositoryHostEntity;
type Repository = ReturnType<Host["canonicalize"]>;
type RecipeOrigin = Extract<WorkspaceFile["origin"], { kind: "recipe" }>;

// ---------------------------------------------------------------------------------------------
// Caching and the owners' handles
// ---------------------------------------------------------------------------------------------

/** Answers from upstream, kept for a minute, so reopening the dialog is instant. */
const cache = new Map<string, { at: number; value: Promise<unknown> }>();

function cached<T>(key: string, compute: () => Promise<T>, ttl = 60_000): Promise<T> {
    const hit = cache.get(key);

    if (hit && Date.now() - hit.at < ttl) return hit.value as Promise<T>;

    const value = compute();

    cache.set(key, { at: Date.now(), value });
    value.catch(() => cache.delete(key));

    return value;
}

/** The `repository-host` entity that owns a host's repositories. */
function entityFor(ctx: Context, host: string): Host | undefined {
    return ctx.entities.list("repository-host").find((candidate) => candidate.matches(`https://${host}/owner/repo`));
}

/** The entity that owns a repository, with the repository canonicalized. */
function repositoryOn(ctx: Context, host: string, owner: string, repo: string): { entity: Host; repository: Repository } | undefined {
    const url = `https://${host}/${owner}/${repo}`;
    const entity = ctx.entities.list("repository-host").find((candidate) => candidate.matches(url));

    if (!entity) return undefined;

    try {
        return { entity, repository: entity.canonicalize(url) };
    } catch {
        return undefined;
    }
}

/** True when the `github` entity owns the repository, so `gh` can be asked about it. */
function onGithub(found: { entity: Host } | undefined): found is { entity: Host; repository: Repository } {
    return found?.entity.id === "github";
}

/** Runs `gh` through `host.processes`; `undefined` when it failed or is missing. */
async function gh(ctx: Context, host: string, args: string[], timeoutMs = 8000): Promise<string | undefined> {
    const env = host === "github.com" ? ctx.env : { ...ctx.env, GH_HOST: host };

    try {
        const result = await ctx.services.get("host.processes").run("gh", args, { env, signal: ctx.signal, timeoutMs, label: `gh ${args.slice(0, 2).join(" ")}` });

        return result.exitCode === 0 ? result.stdout : undefined;
    } catch {
        return undefined;
    }
}

async function ghJson<T>(ctx: Context, repository: Repository, apiPath: string): Promise<T | undefined> {
    const text = await cached(`gh:${repository.host}:${apiPath}`, () => gh(ctx, repository.host, ["api", apiPath]));

    try {
        return text === undefined ? undefined : (JSON.parse(text) as T);
    } catch {
        return undefined;
    }
}

/**
 * One file at upstream HEAD, read the way the host reads its files: each of its read strategies
 * in order, with the first token its token sources find for one that needs it. `null` when every
 * strategy failed. The token never leaves this function.
 */
function readUpstream(ctx: Context, found: { entity: Host; repository: Repository }, path: string): Promise<string | null> {
    const { entity, repository } = found;

    return cached(`file:${repository.host}/${repository.owner}/${repository.name}/${path}`, async () => {
        let token: Awaited<ReturnType<NonNullable<Host["tokenSources"]>[number]["token"]>> | null | undefined = null;

        for (const strategy of entity.readStrategies) {
            if (strategy.usesToken) {
                if (token === null) token = await firstToken(ctx, entity, repository);
                if (token === undefined) continue;
            }

            try {
                const outcome = await strategy.read({ repository, path, ref: "HEAD", ...(strategy.usesToken && token ? { token } : {}) }, ctx);

                if (outcome.ok && "text" in outcome) return outcome.text;
            } catch {
                // the next strategy
            }
        }

        return null;
    });
}

async function firstToken(ctx: Context, entity: Host, repository: Repository) {
    for (const source of entity.tokenSources ?? []) {
        try {
            const token = await source.token(repository, ctx);

            if (token && token.value.length > 0) return token;
        } catch {
            // the next source
        }
    }

    return undefined;
}

// ---------------------------------------------------------------------------------------------
// Sign-in
// ---------------------------------------------------------------------------------------------

/** Whether the host's CLI is installed and signed in, and as whom. Never a token. */
function hostCliStatus(ctx: Context, host: string): Promise<GhStatus> {
    return cached(`auth:${host}`, async () => {
        const started = Date.now();
        const entity = entityFor(ctx, host);
        const cli = entity?.cli;

        if (!entity || !cli || !entity.authStatus) {
            return { installed: false, signedIn: false, host, message: `No plugin that sous has loaded proposes changes on ${host}.`, ms: Date.now() - started };
        }

        const installed = (await ctx.services.get("host.processes").which(cli.command, ctx.env)) !== undefined;
        const auth = installed ? await entity.authStatus(ctx) : { ok: false, detail: `${cli.label} ('${cli.command}') is not installed. Install it from ${cli.install}.` };
        const account = auth.ok && entity.id === "github" ? (await gh(ctx, host, ["api", "user", "--jq", ".login"]))?.trim() || undefined : undefined;
        const message = auth.detail
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)
            .join(" ");

        return { installed, signedIn: auth.ok, ...(account ? { account } : {}), host, message, ms: Date.now() - started };
    });
}

// ---------------------------------------------------------------------------------------------
// web.contribute-info
// ---------------------------------------------------------------------------------------------

/** Each version in order, so the last is the newest. */
function compareVersions(a: string, b: string): number {
    const left = a.split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
    const right = b.split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);

    for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return (left[i] ?? 0) - (right[i] ?? 0);

    return 0;
}

/** The cached index of a repository, by its short name; never goes upstream. */
function cachedIndex(ctx: Context, repo: string | undefined) {
    if (!repo || !ctx.services.has("recipes.index-cache")) return undefined;

    try {
        return ctx.services.get("recipes.index-cache").cached(repo)?.index;
    } catch {
        return undefined;
    }
}

async function repoFacts(ctx: Context, host: string, owner: string, repo: string, shortName: string | undefined): Promise<ContributeRepo> {
    const info: ContributeRepo = { key: `${host}/${owner}/${repo}`, host, owner, repo, manifestSource: null, checkout: null, defaultBranch: null, head: null, canPush: null };
    const manifests = ctx.services.get("formats.manifests");
    const link = shortName && ctx.services.has("recipes.links") ? ctx.services.get("recipes.links").get(shortName) : undefined;

    if (link) {
        const found = await manifests.readRepo(link.path).catch(() => undefined);

        if (found) {
            info.name = found.manifest.name;
            info.contribute = found.manifest.contribute;
            info.manifestSource = "checkout";
        }

        const git = ctx.services.get("git.runner");
        const [log, branch] = await Promise.all([
            git.run(["log", "-1", "--format=%h%x09%cr%x09%s"], { cwd: link.path, reject: false, timeoutMs: 3000, signal: ctx.signal }).catch(() => undefined),
            git.currentBranch(link.path).catch(() => undefined),
        ]);
        const [head = "", when = "", subject = ""] = log?.exitCode === 0 ? log.stdout.trim().split("\t") : [];

        info.checkout = { path: link.path, branch: branch ?? "", head, when, subject };
    }

    const found = repositoryOn(ctx, host, owner, repo);

    if (found) {
        const [canPush, manifestText] = await Promise.all([
            found.entity.canPush ? cached(`push:${info.key}`, () => found.entity.canPush!(found.repository, ctx)).catch(() => undefined) : Promise.resolve(undefined),
            info.manifestSource ? Promise.resolve(null) : readUpstream(ctx, found, "sous.repo.yaml"),
        ]);

        info.canPush = canPush ?? null;

        if (manifestText) {
            try {
                const manifest = manifests.parseText(manifestText, "sous.repo.yaml") as { name?: string; contribute?: string };

                info.name = manifest.name;
                info.contribute = manifest.contribute;
                info.manifestSource = "github";
            } catch {
                // leave it out
            }
        }
    }

    if (onGithub(found)) {
        const meta = await ghJson<{ default_branch: string }>(ctx, found.repository, `repos/${owner}/${repo}`);

        if (meta) {
            info.defaultBranch = meta.default_branch;

            const commit = await ghJson<{ sha: string; commit: { committer: { date: string }; message: string } }>(ctx, found.repository, `repos/${owner}/${repo}/commits/${meta.default_branch}`);

            if (commit) info.head = { sha: commit.sha.slice(0, 7), date: commit.commit.committer.date, message: commit.commit.message.split("\n")[0] ?? "" };
        }
    }

    const generatedAt = cachedIndex(ctx, shortName)?.generatedAt;

    if (generatedAt) info.indexGeneratedAt = generatedAt;

    return info;
}

async function recipeFacts(ctx: Context, origin: RecipeOrigin): Promise<ContributeRecipe | null> {
    const key = `${origin.namespace}/${origin.recipe}`;
    const active = ctx.services.get("recipes.active").get(key);

    if (!active) return null;

    const manifests = ctx.services.get("formats.manifests");
    const manifest = active.manifest;
    const manifestPath = manifests.find(active.dir, "recipe") ?? "";
    const fromIndex = cachedIndex(ctx, active.repo)?.recipes[key];
    const released = Object.entries(fromIndex?.versions ?? {})
        .map(([version, v]) => ({ version, ...(v.releasedAt ? { releasedAt: v.releasedAt } : {}), tag: v.tag }))
        .sort((a, b) => compareVersions(a.version, b.version));
    const repoPath = fromIndex?.path ?? `recipes/${key}`;
    const submissions = manifest.submissions ?? null;
    const found = repositoryOn(ctx, origin.host, origin.owner, origin.repo);

    let headVersion: string | null = null;

    if (found) {
        const fileName = manifestPath ? manifestPath.slice(manifestPath.lastIndexOf("/") + 1) : "sous.recipe.yaml";
        const text = await readUpstream(ctx, found, `${repoPath}/${fileName}`);

        if (text) {
            try {
                headVersion = String((manifests.parseText(text, fileName) as { version?: unknown }).version ?? "") || null;
            } catch {
                headVersion = null;
            }
        }
    }

    // `submissions.instead` names where proposals go instead: "sous-io/sous, under recipes/core/".
    let redirect: ContributeRecipe["redirect"];
    const instead = submissions?.instead;
    const named = instead ? /([\w.-]+)\/([\w.-]+),?\s+under\s+([\w./-]+)/i.exec(instead) : null;

    if (named) {
        const [, owner = "", repo = "", under = ""] = named;
        const target = repositoryOn(ctx, origin.host, owner, repo);
        const canPush = target?.entity.canPush ? await cached(`push:${origin.host}/${owner}/${repo}`, () => target.entity.canPush!(target.repository, ctx)).catch(() => undefined) : undefined;

        redirect = { owner, repo, path: under.replace(/\.$/, ""), canPush: canPush ?? null };
    }

    return {
        key,
        repoKey: `${origin.host}/${origin.owner}/${origin.repo}`,
        pinned: origin.version,
        ...(manifest.description ? { description: manifest.description } : {}),
        manifestPath,
        repoPath,
        variables: (manifest.variables ?? []).map((v) => ({ name: v.name, type: v.type, required: v.required, secret: v.secret, prompt: v.prompt })),
        submissions: submissions ? { allowed: submissions.allowed !== false, ...(submissions.instead ? { instead: submissions.instead } : {}) } : null,
        ...(redirect ? { redirect } : {}),
        released,
        ...(released.length ? { latestReleased: released.at(-1)!.version } : {}),
        headVersion,
        headTagged: headVersion === null ? null : released.some((r) => r.version === headVersion),
    };
}

/** Everything the "Send changes" dialog checks, for the files being sent. */
export async function contributeInfo(ctx: Context, ids: string[]): Promise<ContributeInfo> {
    const started = Date.now();
    const workspace = await workspaceOf(ctx);
    const recipeFiles = ids
        .map((id) => workspace.byId.get(id))
        .filter((file): file is WorkspaceFile & { origin: RecipeOrigin } => file?.origin.kind === "recipe");
    const firstHost = recipeFiles[0]?.origin.host ?? "github.com";
    const git = ctx.services.get("git.runner");
    const gitConfig = (name: string) =>
        git
            .run(["config", name], { cwd: workspace.projectRoot, reject: false, timeoutMs: 2000, signal: ctx.signal })
            .then((result) => (result.exitCode === 0 ? result.stdout.trim() || undefined : undefined))
            .catch(() => undefined);

    const [cliStatus, userName, userEmail] = await Promise.all([hostCliStatus(ctx, firstHost), gitConfig("user.name"), gitConfig("user.email")]);

    // Each repository's short name, for the index cache and links, by its identity.
    const shortNames = new Map(ctx.services.get("recipes.active").list().map((recipe) => [recipe.identity, recipe.repo]));
    const repoKeys = new Map<string, { host: string; owner: string; repo: string }>();
    const byRecipe = new Map<string, RecipeOrigin>();

    for (const file of recipeFiles) {
        repoKeys.set(`${file.origin.host}/${file.origin.owner}/${file.origin.repo}`, file.origin);
        byRecipe.set(`${file.origin.namespace}/${file.origin.recipe}`, file.origin);
    }

    const recipeList = (await Promise.all([...byRecipe.values()].map((origin) => recipeFacts(ctx, origin)))).filter((r): r is ContributeRecipe => r !== null);
    const recipes = Object.fromEntries(recipeList.map((recipe) => [recipe.key, recipe]));

    // A recipe that takes its proposals elsewhere (core/sous-skills to sous-io/sous) needs that repository too.
    for (const recipe of recipeList) {
        if (recipe.redirect && recipe.submissions?.allowed === false) {
            const host = recipe.repoKey.split("/")[0] ?? "github.com";

            repoKeys.set(`${host}/${recipe.redirect.owner}/${recipe.redirect.repo}`, { host, owner: recipe.redirect.owner, repo: recipe.redirect.repo });
        }
    }

    const repoList = await Promise.all([...repoKeys.entries()].map(([key, r]) => repoFacts(ctx, r.host, r.owner, r.repo, shortNames.get(key))));

    const fileEntries = await Promise.all(
        recipeFiles.map(async (file) => {
            const key = `${file.origin.namespace}/${file.origin.recipe}`;
            const recipe = recipes[key];
            const base = recipe?.redirect && recipe.submissions?.allowed === false ? recipe.redirect : null;
            const owner = base?.owner ?? file.origin.owner;
            const repo = base?.repo ?? file.origin.repo;
            const dir = base ? base.path.replace(/\/$/, "") : (recipe?.repoPath ?? `recipes/${key}`);
            const upstreamPath = `${dir}/${file.origin.recipePath}`;
            const found = repositoryOn(ctx, file.origin.host, owner, repo);
            const upstream = found ? await readUpstream(ctx, found, upstreamPath) : null;

            return [file.id, { upstreamPath, upstream, recipe: key }] as const;
        }),
    );

    return {
        gh: cliStatus,
        git: { ...(userName ? { userName } : {}), ...(userEmail ? { userEmail } : {}) },
        repos: Object.fromEntries(repoList.map((r) => [r.key, r])),
        recipes,
        files: Object.fromEntries(fileEntries),
        ms: Date.now() - started,
    };
}

// ---------------------------------------------------------------------------------------------
// web.scan-secrets
// ---------------------------------------------------------------------------------------------

/**
 * Looks for a secret variable's value in the lines a change adds, a secret being what
 * `variables.secrets` says is one (declared, or a secret by its name or its value). Only the
 * variable's name and the line's position come back, never the value. Values shorter than four
 * characters are skipped: they match too much text to mean anything.
 */
export async function scanSecrets(ctx: Context, added: Record<string, string[]>): Promise<{ hits: SecretHit[] }> {
    const workspace: Workspace = await workspaceOf(ctx);
    const secrets = ctx.services.get("variables.secrets");
    const declared = secrets.declared();
    const hits: SecretHit[] = [];

    for (const [id, lines] of Object.entries(added)) {
        const file = workspace.byId.get(id);

        if (!file) continue;

        const values = Object.entries(scopeOf(ctx, file)).filter(([name, value]) => value.length >= 4 && secrets.isSecret(name, value, declared));

        lines.forEach((text, line) => {
            for (const [name, value] of values) if (text.includes(value)) hits.push({ id, line, name });
        });
    }

    return { hits };
}

// ---------------------------------------------------------------------------------------------
// web.my-prs
// ---------------------------------------------------------------------------------------------

type GhPr = {
    number: number;
    title: string;
    state: string;
    isDraft: boolean;
    headRefName: string;
    url: string;
    createdAt: string;
    updatedAt: string;
    mergedAt: string | null;
    reviewDecision: string;
    additions: number;
    deletions: number;
    changedFiles: number;
    statusCheckRollup: { conclusion?: string; status?: string; state?: string }[] | null;
};

const PR_FIELDS = "number,title,state,isDraft,headRefName,url,createdAt,updatedAt,reviewDecision,statusCheckRollup,mergedAt,additions,deletions,changedFiles";

/** Counts a status check rollup: a check run has a status and a conclusion, a commit status a state. */
function checkSummary(rollup: GhPr["statusCheckRollup"]): MyPr["checks"] {
    const out = { passing: 0, failing: 0, pending: 0, skipped: 0 };

    for (const check of rollup ?? []) {
        const value = String(check.conclusion || check.state || check.status || "").toUpperCase();

        if (value === "SUCCESS" || value === "NEUTRAL") out.passing++;
        else if (value === "SKIPPED" || value === "CANCELLED" || value === "STALE") out.skipped++;
        else if (["FAILURE", "ERROR", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(value)) out.failing++;
        else out.pending++;
    }

    return out;
}

function toMyPr(pr: GhPr): MyPr {
    return {
        number: pr.number,
        title: pr.title,
        state: pr.state === "MERGED" ? "merged" : pr.state === "CLOSED" ? "closed" : pr.isDraft ? "draft" : "open",
        branch: pr.headRefName,
        url: pr.url,
        createdAt: pr.createdAt,
        updatedAt: pr.updatedAt,
        mergedAt: pr.mergedAt || null,
        review: pr.reviewDecision === "APPROVED" ? "approved" : pr.reviewDecision === "CHANGES_REQUESTED" ? "changes" : pr.reviewDecision === "REVIEW_REQUIRED" ? "required" : null,
        checks: checkSummary(pr.statusCheckRollup),
        additions: pr.additions,
        deletions: pr.deletions,
        changedFiles: pr.changedFiles,
        madeWithSous: pr.headRefName.startsWith("sous/edit-"),
    };
}

/** The project's own repository: its `origin` remote, else its `githubRepo` variable. */
async function ownRepository(ctx: Context, workspace: Workspace): Promise<Repository | undefined> {
    const remote = await ctx.services
        .get("git.runner")
        .remoteUrl(workspace.projectRoot, "origin")
        .catch(() => undefined);
    const fromRemote = remote ? ctx.entities.list("repository-host").find((entity) => entity.matches(remote)) : undefined;

    if (fromRemote && remote) {
        try {
            return fromRemote.canonicalize(remote);
        } catch {
            // try the variable
        }
    }

    const named = ctx.services.get("variables.resolver").scope().githubRepo;
    const parts = named ? /([\w.-]+)\/([\w.-]+)$/.exec(named.replace(/\.git$/, "")) : null;

    return parts ? repositoryOn(ctx, "github.com", parts[1]!, parts[2]!)?.repository : undefined;
}

async function prsOn(ctx: Context, repository: Repository, role: MyPrsRepo["role"], signedIn: boolean): Promise<MyPrsRepo> {
    const key = `${repository.owner}/${repository.name}`;
    const base = { key, owner: repository.owner, repo: repository.name, role };

    if (!signedIn) return { ...base, ok: false, error: "gh is not signed in", prs: [] };

    const [listed, latest] = await Promise.all([
        gh(ctx, repository.host, ["pr", "list", "--repo", key, "--author", "@me", "--state", "all", "--limit", "20", "--json", PR_FIELDS], 10_000),
        // Issues and pull requests share one counter, so the newest of either is the one to beat.
        gh(ctx, repository.host, ["api", `repos/${key}/issues?state=all&per_page=1`, "--jq", ".[0].number"]),
    ]);
    const latestNumber = latest ? Number.parseInt(latest.trim(), 10) || undefined : undefined;

    if (listed === undefined) return { ...base, ok: false, error: `gh pr list did not succeed for ${key}`, prs: [] };

    try {
        return { ...base, ok: true, prs: (JSON.parse(listed) as GhPr[]).map(toMyPr), ...(latestNumber ? { latestNumber } : {}) };
    } catch {
        return { ...base, ok: false, error: "Couldn't read gh's answer", prs: [] };
    }
}

/** The signed-in account's pull requests on each recipe repository and the project's own. Read-only. */
export function myPrs(ctx: Context, fresh: boolean): Promise<MyPrs> {
    if (fresh) cache.delete("my-prs");

    return cached("my-prs", async () => {
        const started = Date.now();
        const workspace = await workspaceOf(ctx);
        const repos = new Map<string, { repository: Repository; role: MyPrsRepo["role"] }>();

        for (const file of workspace.files) {
            if (file.origin.kind !== "recipe") continue;

            const found = repositoryOn(ctx, file.origin.host, file.origin.owner, file.origin.repo);

            if (onGithub(found)) repos.set(`${found.repository.owner}/${found.repository.name}`, { repository: found.repository, role: "recipes" });
        }

        const own = await ownRepository(ctx, workspace);

        if (own) repos.set(`${own.owner}/${own.name}`, { repository: own, role: "project" });

        const cliStatus = await hostCliStatus(ctx, "github.com");
        const list = await Promise.all([...repos.values()].map((r) => prsOn(ctx, r.repository, r.role, cliStatus.signedIn)));

        // Recipe repositories first; they're what the editor sends to.
        list.sort((a, b) => (a.role === b.role ? a.key.localeCompare(b.key) : a.role === "recipes" ? -1 : 1));

        return { gh: cliStatus, repos: list, ms: Date.now() - started, at: new Date().toISOString() };
    });
}
