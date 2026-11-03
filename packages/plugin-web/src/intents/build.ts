/**
 * The preview build: a dry-run compile of every target, with each output's text and token count,
 * the files each one is built from, and whether the output on disk matches. Writes nothing; the
 * compiler compares each output with the disk itself.
 */
import path from "node:path";
import type { Context } from "@sous-io/plugin-api";
import type { CompiledOutput } from "@sous-io/plugin-compiler/types";
import { parse as parseYaml } from "yaml";
import type { OutputInfo, PreviewBuild } from "../types.js";
import { workspaceOf, type Workspace } from "./workspace.js";

/** The last preview build's text per output (relative path), for web.output and web.drift. */
const contents = new Map<string, string>();
let last: { hash: string; build: Promise<PreviewBuild> } | undefined;

export function previewContent(output: string): string | undefined {
    return contents.get(output);
}

function kindOf(output: string): OutputInfo["kind"] {
    const base = path.basename(output);

    if (/^(CLAUDE|AGENTS|GEMINI)\.md$/i.test(base)) return "instructions";
    if (base === "SKILL.md") return "skill";
    if (output.includes("/references/") || output.includes("/examples/")) return "reference";
    if (output.includes("memor")) return "memory";

    return "other";
}

function statusOf(output: CompiledOutput): OutputInfo["status"] {
    switch (output.action) {
        case "would-create":
        case "created":
            return "missing";
        case "would-update":
        case "updated":
            return "stale";
        default:
            return "up-to-date";
    }
}

/** A skill's frontmatter name and description, which agents read up front. */
function frontmatterOf(text: string): { name?: string; description?: string } {
    const front = /^---\n([\s\S]*?)\n---/.exec(text)?.[1];

    if (!front) return {};

    try {
        const meta = parseYaml(front) as Record<string, unknown> | null;
        const result: { name?: string; description?: string } = {};

        if (typeof meta?.name === "string") result.name = meta.name;
        if (typeof meta?.description === "string") result.description = meta.description.replace(/\s+/g, " ").trim();

        return result;
    } catch {
        // Frontmatter that is not YAML has no description an agent can read.
        return {};
    }
}

/** The preview build for the current config: run once, again with `rerun`. */
export function previewBuild(ctx: Context, rerun: boolean): Promise<PreviewBuild> {
    if (!last || rerun || last.hash !== ctx.config.hash) {
        const build = runPreviewBuild(ctx);

        last = { hash: ctx.config.hash, build };
        build.catch(() => {
            last = undefined;
        });
    }

    return last.build;
}

async function runPreviewBuild(ctx: Context): Promise<PreviewBuild> {
    const started = performance.now();
    const workspace: Workspace = await workspaceOf(ctx);
    const root = workspace.projectRoot;
    const render = ctx.services.get("compiler.render");
    const targetIndexes = [...new Set(ctx.services.get("compiler.targets").expand().entries.map((entry) => entry.targetIndex))];
    const outputs: OutputInfo[] = [];
    const usedBy: Record<string, string[]> = {};

    // One dry run per target, so each output's sources are its own target's includes.
    for (const index of targetIndexes) {
        ctx.signal.throwIfAborted();

        const result = (await ctx.run("compiler.compile", { targets: [index], dryRun: true, includeContent: true, countTokens: true, report: false })).toPlain();
        const failed = result.problems.filter((problem) => problem.level === "error");

        for (const output of result.outputs) {
            const rel = path.relative(root, output.file).split(path.sep).join("/");
            const entry = workspace.byPath.get(output.source);
            const sources = [entry?.id, ...(result.included ?? []).map((file) => workspace.byPath.get(file)?.id)].filter(
                (id, i, all): id is string => id !== undefined && all.indexOf(id) === i,
            );
            const text = output.content ?? "";
            const meta = frontmatterOf(text);
            const info: OutputInfo = {
                output: rel,
                entryId: entry?.id ?? "",
                sources,
                tokens: output.tokens ?? 0,
                bytes: output.bytes,
                status: statusOf(output),
                kind: kindOf(rel),
            };

            if (meta.name) info.skillName = meta.name;

            if (meta.description) {
                info.description = meta.description;
                info.descriptionTokens = await render.countTokens(`${meta.name ?? ""}: ${meta.description}`).catch(() => 0);
            }

            contents.set(rel, text);
            outputs.push(info);

            for (const id of sources) (usedBy[id] ??= []).push(rel);
        }

        // A target whose compile failed has no outputs to list; show each of its outputs as failed.
        if (result.outputs.length === 0 && failed.length > 0) {
            for (const entry of workspace.files.filter((file) => file.target === index)) {
                for (const rel of entry.outputs) {
                    outputs.push({
                        output: rel,
                        entryId: entry.id,
                        sources: [entry.id],
                        tokens: 0,
                        bytes: 0,
                        status: "failed",
                        error: failed.map((problem) => problem.message).join("\n"),
                        kind: kindOf(rel),
                    });
                }
            }
        }
    }

    return { outputs, usedBy, ms: Math.round(performance.now() - started), builtAt: new Date().toISOString() };
}
