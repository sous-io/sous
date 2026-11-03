/**
 * The picture of a project the editor shows: every source file sous reads, where each one comes
 * from (this project, a recipe, or elsewhere), what it builds, and whose variables it renders
 * with. Built from the owners: `compiler.targets` for the sources and outputs, a dry-run
 * `compiler.compile` for the partials, `recipes.active` for the origins.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Context } from "@sous-io/plugin-api";
import type {} from "@sous-io/plugin-compiler/types";
import type {} from "@sous-io/plugin-git/types";
import type {} from "@sous-io/plugin-recipes/types";
import type {} from "@sous-io/plugin-variables/types";
import type { FileOrigin, WebFile, WorkspaceInfo } from "../types.js";
import { SAMPLE_CONTENT, SAMPLE_DISPLAY } from "./sample.js";

/** A file plus what the server keeps about it: whose scope it renders with, and text held in memory. */
export interface WorkspaceFile extends WebFile {
    /** The target and output whose variables it renders with. */
    target?: number;
    outputIndex?: number;
    /** Text that is not on disk: the sample, or a target's `content`. */
    virtualContent?: string;
}

export interface Workspace extends WorkspaceInfo {
    files: WorkspaceFile[];
    byId: Map<string, WorkspaceFile>;
    byPath: Map<string, WorkspaceFile>;
    /** The config this was built from. */
    hash: string;
}

/** An id that stays the same for a path across rebuilds, so open tabs survive them. */
function idFor(file: string): string {
    return createHash("sha1").update(file).digest("hex").slice(0, 10);
}

function originOf(ctx: Context, file: string): FileOrigin {
    const root = ctx.project?.root ?? ctx.cwd;

    for (const recipe of ctx.services.get("recipes.active").list()) {
        const dir = recipe.dir.endsWith(path.sep) ? recipe.dir : recipe.dir + path.sep;

        if (file.startsWith(dir)) {
            const [host = "", owner = "", repo = ""] = recipe.identity.split("/");

            return {
                kind: "recipe",
                host,
                owner,
                repo,
                namespace: recipe.namespace,
                recipe: recipe.name,
                version: recipe.version,
                recipePath: path.relative(recipe.dir, file).split(path.sep).join("/"),
                source: recipe.source,
            };
        }
    }

    const rel = path.relative(root, file);

    return rel.startsWith("..") || path.isAbsolute(rel) ? { kind: "external" } : { kind: "project" };
}

function displayOf(ctx: Context, file: string, origin: FileOrigin): string {
    if (origin.kind === "recipe") return `${origin.namespace}/${origin.recipe}/${origin.recipePath}`;
    if (origin.kind === "project") return path.relative(ctx.project?.root ?? ctx.cwd, file).split(path.sep).join("/");

    return file;
}

let cached: Promise<Workspace> | undefined;
let cachedHash = "";

/** The workspace for the current config; built once per config. */
export function workspaceOf(ctx: Context): Promise<Workspace> {
    if (!cached || cachedHash !== ctx.config.hash) {
        cachedHash = ctx.config.hash;
        cached = loadWorkspace(ctx);
        cached.catch(() => {
            cached = undefined;
        });
    }

    return cached;
}

async function loadWorkspace(ctx: Context): Promise<Workspace> {
    const root = ctx.project?.root ?? ctx.cwd;
    const files: WorkspaceFile[] = [];
    const byPath = new Map<string, WorkspaceFile>();

    const add = (file: string, role: WebFile["role"], extra: Partial<WorkspaceFile> = {}): WorkspaceFile => {
        const existing = byPath.get(file);

        if (existing) return existing;

        const origin = extra.origin ?? originOf(ctx, file);
        const entry: WorkspaceFile = {
            id: idFor(file),
            path: file,
            display: extra.display ?? displayOf(ctx, file, origin),
            origin,
            isTpl: /\.tpl\./.test(path.basename(file)) || extra.virtualContent !== undefined,
            role,
            outputs: [],
            ...extra,
        };

        byPath.set(file, entry);
        files.push(entry);

        return entry;
    };

    const { entries } = ctx.services.get("compiler.targets").expand();

    for (const entry of entries) {
        const file = add(
            entry.source,
            "entry",
            entry.content === undefined
                ? { target: entry.targetIndex, outputIndex: entry.outputIndex }
                : { target: entry.targetIndex, outputIndex: entry.outputIndex, virtualContent: entry.content, origin: { kind: "generated" }, display: `${entry.target} (written by ${entry.origin?.plugin ?? "a plugin"})` },
        );

        file.role = "entry";

        const output = path.relative(root, entry.output).split(path.sep).join("/");

        if (!file.outputs.includes(output)) file.outputs.push(output);
    }

    // A dry run reads every file the targets include, and writes nothing.
    const compiled = (await ctx.run("compiler.compile", { dryRun: true, report: false })).toPlain();

    for (const included of compiled.included ?? []) {
        if (!byPath.has(included) && existsSync(included)) add(included, "partial");
    }

    const sample: WorkspaceFile = {
        id: "sample",
        path: path.join(ctx.project?.sousDir ?? root, SAMPLE_DISPLAY),
        display: SAMPLE_DISPLAY,
        origin: { kind: "sample" },
        isTpl: true,
        role: "entry",
        outputs: [],
        virtualContent: SAMPLE_CONTENT,
    };

    const all = [sample, ...files];
    const branch = await ctx.services
        .get("git.runner")
        .currentBranch(root)
        .catch(() => undefined);

    return {
        projectName: (ctx.config.get("name") as string | undefined) ?? path.basename(root),
        projectRoot: root,
        branch: branch ?? "(no git)",
        files: all,
        byId: new Map(all.map((file) => [file.id, file])),
        byPath: new Map(all.map((file) => [file.path, file])),
        hash: ctx.config.hash,
    };
}

/** A file's text: in memory for the sample and generated targets, else on disk. */
export function contentOf(file: WorkspaceFile): string {
    return file.virtualContent ?? readFileSync(file.path, "utf8");
}

/** Hides secrets the way the rest of sous does. */
export function visibleScope(ctx: Context, scope: Readonly<Record<string, string>>): Record<string, string> {
    return ctx.services.get("variables.secrets").hide(scope);
}

/** The variables a file renders with: its output's, else the root scope. */
export function scopeOf(ctx: Context, file: WorkspaceFile): Readonly<Record<string, string>> {
    const resolver = ctx.services.get("variables.resolver");

    if (file.target !== undefined) {
        return resolver.scope({ level: "output", target: file.target, output: file.outputIndex ?? 0 });
    }

    if (file.origin.kind === "recipe") {
        return resolver.scope({ scopeKey: `${file.origin.namespace}/${file.origin.recipe}` });
    }

    return resolver.scope();
}

/** What the browser gets for a file: everything but the server's own fields. */
export function toWebFile(file: WorkspaceFile): WebFile {
    const { target: _target, outputIndex: _output, virtualContent: _content, ...web } = file;

    return web;
}
