/**
 * Rendering one template for the editor: plugin-liquid marks its sections, plugin-compiler
 * renders it as the build would (with any values the person is trying out), and plugin-liquid cuts
 * the output back into one piece per section.
 */
import type { Context } from "@sous-io/plugin-api";
import type {} from "@sous-io/plugin-compiler/types";
import type { LiquidRegions, MarkedSource } from "@sous-io/plugin-liquid/types";
import type { RenderResult } from "../types.js";
import { scopeOf, type WorkspaceFile } from "./workspace.js";

/** The marker characters plugin-liquid adds, to map a position in the marked source back. */
const MARKER = /⁣[^⁣]*⁣/g;

/** An offset in the marked source, as an offset in the original (the markers taken out). */
function unmarkedOffset(marked: string, offset: number): number {
    let removed = 0;

    for (const match of marked.matchAll(MARKER)) {
        if (match.index >= offset) break;

        removed += Math.min(match[0].length, offset - match.index);
    }

    return offset - removed;
}

/** An offset from a 1-based line and column. */
function offsetOf(text: string, line: number, column: number): number {
    let offset = 0;

    for (let i = 1; i < line; i++) {
        const next = text.indexOf("\n", offset);

        if (next === -1) return text.length;

        offset = next + 1;
    }

    return Math.min(text.length, offset + Math.max(0, column - 1));
}

let regionsService: LiquidRegions | undefined;
let regionsHash = "";

/** The regions service, held per config: it builds a Liquid engine the first time it needs one. */
function regionsOf(ctx: Context): LiquidRegions {
    if (!regionsService || regionsHash !== ctx.config.hash) {
        regionsService = ctx.services.get("liquid.regions");
        regionsHash = ctx.config.hash;
    }

    return regionsService;
}

export async function renderFile(ctx: Context, file: WorkspaceFile, source: string, overrides?: Record<string, string>): Promise<RenderResult> {
    const started = performance.now();
    const regions = regionsOf(ctx);
    const render = ctx.services.get("compiler.render");
    const done = async (result: Omit<RenderResult, "ms" | "tokens" | "uses">): Promise<RenderResult> => {
        const uses = safely(() => regions.uses(source));
        const warning = safely(() => regions.warning(source));
        const tokens = await render.countTokens(result.output).catch(() => 0);
        const full: RenderResult = { ...result, ms: Math.round(performance.now() - started), tokens };

        if (uses) full.uses = uses;

        if (warning && full.error === undefined) {
            full.warning = warning.message;

            if (warning.pos !== null) full.warningPos = warning.pos;
        }

        return full;
    };

    let marked: MarkedSource;

    try {
        marked = regions.mark(source);
    } catch (error) {
        const problem = regions.describeError(error, source);

        return done({ regions: [], output: source, segments: [], error: problem.message, ...(problem.pos === null ? {} : { errorPos: problem.pos }) });
    }

    // The sample and generated targets render with the file's own scope; the rest as the build does.
    const scope = { ...(file.origin.kind === "sample" ? scopeOf(ctx, file) : {}), ...overrides };
    const rendered = await render.render({
        file: file.path,
        source: marked.source,
        ...(Object.keys(scope).length > 0 ? { scope } : {}),
        ...(file.target === undefined ? {} : { target: file.target, output: file.outputIndex ?? 0 }),
    });
    const failure = rendered.problems.find((problem) => problem.level === "error");

    if (failure) {
        const pos =
            failure.line === undefined || (failure.file !== undefined && failure.file !== file.path)
                ? undefined
                : unmarkedOffset(marked.source, offsetOf(marked.source, failure.line, failure.column ?? 1));

        return done({
            regions: marked.regions.map(({ branchPoints: _points, ...region }) => ({ ...region, rendered: "" })),
            output: source,
            segments: [],
            error: failure.message,
            ...(pos === undefined ? {} : { errorPos: pos }),
        });
    }

    return done(regions.split(rendered.text, marked));
}

function safely<T>(fn: () => T): T | undefined {
    try {
        return fn();
    } catch {
        return undefined;
    }
}
