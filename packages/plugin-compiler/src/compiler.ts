/**
 * Compiling units into outputs: reading each source and every file it includes, rendering the
 * `.tpl.` files and `content` sources as Liquid, applying transforms, and writing through the
 * writer. Errors are collected, never thrown, so every target compiles and every error is listed;
 * an output whose target had an error is not written, and its previous copy stays.
 */

import fs from "node:fs";
import path from "node:path";
import type { Liquid } from "liquidjs";
import { LogLevel, nullReporter, Reporting, type ProblemDetails, type Reporter, type ServiceContext } from "@sous-io/plugin-api";
import type { RefsParser } from "@sous-io/plugin-refs/types";
import type { VarScope } from "@sous-io/plugin-variables/types";
import { INCLUDE_LINE_PATTERN, looksLikeIncludeLine, splitIncludeQuery, stableVarsFingerprint } from "./paths.js";
import { hashContent } from "./state.js";
import type { CompileUnit, UnitOutput } from "./targets.js";
import type {
    CompilationTransformEntity,
    CompiledOutput,
    CompileProblem,
    CompilerIncludes,
    CompilerWriter,
    StateFileEntry,
    TransformFile,
} from "./types.js";

/** One piece of a read file: a line of its own text, or a file it includes. */
type Part = string | { file: string };

/** A file read for a unit. */
interface FileNode {
    path: string;
    content: string;
    /** True when the file renders as Liquid: its name holds `.tpl.`, or it is a `content` source. */
    isTpl: boolean;
    /** False for a `content` source, which is not on disk. */
    real: boolean;
    parts: Part[];
}

/** How to make a Liquid engine for one render. */
export interface EngineRequest {
    /** Directories `{% render %}` looks in. */
    readonly roots: string[];
    /** The variables `${var}` in a render path is substituted from. */
    readonly scope: VarScope;
    /** The template rendered. */
    readonly fromFile: string;
}

/** What a run needs. */
export interface CompileDependencies {
    readonly includes: CompilerIncludes;
    /** Whether a namespace resolver is registered (`~` then means a recipe). */
    readonly hasNamespaceResolver: boolean;
    readonly createEngine: (request: EngineRequest) => Liquid;
    readonly writer: CompilerWriter;
    /** The state file's entries, by absolute destination. */
    readonly tracked: ReadonlyMap<string, StateFileEntry>;
    readonly transform: (id: string) => CompilationTransformEntity | undefined;
    /** What a transform gets. */
    readonly serviceContext: ServiceContext;
    /** Names declared secret; part of a rendered output's source hash. */
    readonly secretNames: readonly string[];
    readonly reporter: Reporter;
    /** Counts tokens, when given. */
    readonly countTokens?: (text: string) => number;
    /** Explains a malformed `~` reference when no namespace resolver is registered. */
    readonly refsParser?: RefsParser;
    /** Writes `<!-- from: -->` comments relative to it. */
    readonly projectRoot: string;
}

/** How a run behaves. */
export interface CompileOptions {
    readonly strict?: boolean;
    readonly rebuild?: boolean;
    readonly dryRun?: boolean;
}

/** What a run did. */
export interface CompileRunResult {
    readonly outputs: CompiledOutput[];
    readonly problems: CompileProblem[];
    /** Every output a unit would write, written or not: what prune keeps. */
    readonly produced: Set<string>;
    /** Every file read, as real paths: sources and everything they include. */
    readonly included: Set<string>;
}

/** What a problem report says beyond its summary. */
type ProblemFacts = Omit<ProblemDetails, "summary">;

/** One run of the compiler over a list of units. */
export class CompileRun extends Reporting(Object) {
    private readonly problems: CompileProblem[] = [];
    private readonly outputs: CompiledOutput[] = [];
    private readonly produced = new Set<string>();
    private readonly included = new Set<string>();
    private nodes = new Map<string, FileNode>();
    private includeStack: string[] = [];
    private sourceComments = false;
    private unit: CompileUnit | undefined;
    private errorCount = 0;

    constructor(
        private readonly deps: CompileDependencies,
        private readonly options: CompileOptions = {},
    ) {
        super();
    }

    protected get reporter(): Reporter {
        return this.deps.reporter;
    }

    /** Compiles every unit. */
    async run(units: readonly CompileUnit[]): Promise<CompileRunResult> {
        for (const unit of units) {
            await this.compileUnit(unit);
        }

        return { outputs: this.outputs, problems: this.problems, produced: this.produced, included: this.included };
    }

    /**
     * Whether a unit reads any of the files: its source, or anything its includes name, found or
     * not. Reports nothing.
     */
    reads(unit: CompileUnit, files: ReadonlySet<string>): boolean {
        const quiet = new CompileRun({ ...this.deps, reporter: nullReporter });

        quiet.unit = unit;
        quiet.loadUnit(unit);

        if ([...quiet.nodes.keys()].some((file) => files.has(file))) {
            return true;
        }

        return quiet.wanted.some((file) => files.has(file));
    }

    /** First candidates of includes that found nothing, for `reads`. */
    private readonly wanted: string[] = [];

    /** Records an error and reports it. The record keeps the summary with its cause and hint, the report shows them as facts. */
    private recordError(summary: string, extra: Partial<CompileProblem> = {}, facts: ProblemFacts = {}): void {
        this.errorCount += 1;
        this.problems.push({ level: "error", message: problemText(summary, facts), ...this.where(), ...extra });
        this.problem(summary, facts, LogLevel.Error);
    }

    /** Records a warning and reports it; under `--strict` it is an error instead. */
    private recordWarning(summary: string, extra: Partial<CompileProblem> = {}, facts: ProblemFacts = {}): void {
        if (this.options.strict) {
            this.recordError(summary, extra, facts);

            return;
        }

        this.problems.push({ level: "warning", message: problemText(summary, facts), ...this.where(), ...extra });
        this.problem(summary, facts, LogLevel.Warning);
    }

    private where(): { target?: string } {
        return this.unit === undefined ? {} : { target: this.unit.targetName };
    }

    /** Reads a unit's source and everything it includes. */
    private loadUnit(unit: CompileUnit): FileNode | null {
        this.nodes = new Map();
        this.includeStack = [];

        if (unit.content !== undefined) {
            const node: FileNode = { path: unit.source, content: unit.content, isTpl: true, real: false, parts: [] };

            this.nodes.set(unit.source, node);
            this.includeStack.push(unit.source);
            node.parts = this.processIncludes(unit.content, unit.globBase ?? path.dirname(unit.source), unit.source, unit.label);
            this.includeStack.pop();

            return node;
        }

        return this.loadFile(unit.source);
    }

    private async compileUnit(unit: CompileUnit): Promise<void> {
        this.unit = unit;
        this.sourceComments = unit.includeSourceComments;
        this.stepStart(unit.content !== undefined ? unit.label : path.basename(unit.source));
        this.variable("Entry Point", unit.label);

        const errorsBefore = this.errorCount;
        const entry = this.loadUnit(unit);

        for (const output of unit.outputs) {
            this.produced.add(output.destination);
        }

        if (entry === null) {
            this.recordError(`Failed to compile ${unit.label}`);

            return;
        }

        // An include that failed left a hole in the content, so none of this unit's outputs is
        // written: the previous copy stays.
        const assembled = this.errorCount === errorsBefore;
        const graph = [...this.nodes.values()];

        for (const node of graph) {
            if (node.real) {
                this.included.add(realPathOf(node.path));
            }
        }

        const root = unit.content !== undefined ? (unit.globBase ?? path.dirname(unit.source)) : path.dirname(unit.source);
        const contentHash = hashContent(
            JSON.stringify([
                this.sourceComments,
                graph.map((node) => [path.relative(root, node.path), node.content]),
                ...(unit.transforms.length > 0 ? [unit.transforms] : []),
            ]),
        );
        const rendersAnything = graph.some((node) => node.isTpl);
        const sourceMode = !entry.isTpl && entry.real ? modeOf(unit.source) : undefined;

        for (const output of unit.outputs) {
            if (!assembled) {
                this.notWritten(output.destination);
                continue;
            }

            await this.compileOutput(unit, output, contentHash, rendersAnything, root, sourceMode);
        }
    }

    private async compileOutput(
        unit: CompileUnit,
        output: UnitOutput,
        contentHash: string,
        rendersAnything: boolean,
        root: string,
        sourceMode: number | undefined,
    ): Promise<void> {
        const transforms = [...unit.transforms, ...output.transforms];
        // A rendered output depends on its variables as much as on its source, so they are part of
        // its source hash; so are the secret names, which decide what a scope-dumping tag hides.
        const sourceHash = rendersAnything
            ? hashContent(
                  `${contentHash}\n${stableVarsFingerprint(output.vars)}\n` +
                      `secrets:${JSON.stringify([...this.deps.secretNames].sort())}` +
                      (output.transforms.length > 0 ? `\ntransforms:${JSON.stringify(output.transforms)}` : ""),
              )
            : output.transforms.length > 0
              ? hashContent(`${contentHash}\ntransforms:${JSON.stringify(output.transforms)}`)
              : contentHash;
        const tracked = this.deps.tracked.get(output.destination);
        const base = {
            source: unit.label,
            target: unit.targetName,
            ...(unit.origin === undefined ? {} : { origin: unit.origin }),
        };

        if (!this.options.rebuild && transforms.length === 0 && tracked?.srcHash === sourceHash) {
            const existing = readText(output.destination);

            // Written again unchanged, which records the target and origin of an older entry.
            if (existing !== undefined) {
                await this.write({ source: unit.label, destination: output.destination, content: existing }, sourceHash, base, undefined);

                return;
            }
        }

        const errorsBefore = this.errorCount;
        const content = await this.expand(unit.source, output.vars, root);

        if (this.errorCount > errorsBefore) {
            this.notWritten(output.destination);

            return;
        }

        let file: TransformFile | undefined = { source: unit.label, destination: output.destination, content };

        for (const id of transforms) {
            const transform = this.deps.transform(id);

            if (transform === undefined) {
                this.recordError(`The compilation transform "${id}" is not registered.`, {}, { cause: `in target: ${unit.targetName}` });
                this.notWritten(output.destination);

                return;
            }

            try {
                file = await transform.transform(file, this.deps.serviceContext);
            } catch (error) {
                this.recordError(`The compilation transform "${id}" failed on ${unit.label}`, {}, { subject: unit.label, cause: messageOf(error) });
                this.notWritten(output.destination);

                return;
            }

            if (file === undefined) {
                this.operation("skipped", output.destination, { note: `left out by the transform "${id}"` });

                return;
            }

            file = { ...file, destination: path.resolve(file.destination) };
        }

        if (file.destination !== output.destination) {
            this.produced.add(file.destination);
        }

        await this.write(file, sourceHash, base, sourceMode);
    }

    private async write(
        file: TransformFile,
        sourceHash: string,
        base: Pick<CompiledOutput, "source" | "target" | "origin">,
        mode: number | undefined,
    ): Promise<void> {
        try {
            const written = await this.deps.writer.write(file.destination, file.content, {
                source: base.source,
                sourceHash,
                ...(base.target === undefined ? {} : { target: base.target }),
                ...(base.origin === undefined ? {} : { origin: base.origin }),
                ...(this.options.dryRun ? { dryRun: true } : {}),
                ...(this.options.rebuild ? { force: true } : {}),
                ...(mode === undefined ? {} : { mode }),
            });
            const counted = written.action === "created" || written.action === "updated";
            const tokens = counted && this.deps.countTokens ? this.deps.countTokens(file.content) : undefined;

            this.outputs.push({ ...base, ...written, ...(tokens === undefined ? {} : { tokens }) });
            this.reportWritten(written.file, written.action, tokens);
        } catch (error) {
            this.recordError(`Failed to write ${file.destination}`, { file: file.destination }, { subject: file.destination, cause: messageOf(error) });
        }
    }

    private reportWritten(file: string, action: CompiledOutput["action"], tokens: number | undefined): void {
        switch (action) {
            case "created":
            case "updated":
                this.operation("written", file, tokens === undefined ? {} : { tokens });
                break;
            case "unchanged":
                this.operation("unchanged", file);
                break;
            case "would-create":
            case "would-update":
                this.operation("would-write", file);
                break;
            case "skipped-untracked":
                this.recordWarning(
                    `Not overwritten: ${file}`,
                    { file },
                    {
                        subject: file,
                        cause: "The file exists and sous did not write it, and compilation.overwriteUntracked is false.",
                        hint: "Remove the file, or set compilation.overwriteUntracked to true to let sous take it over.",
                    },
                );
                break;
        }
    }

    /** Says an output was not written because of an error, and what that leaves on disk. */
    private notWritten(file: string): void {
        const verb = this.options.dryRun ? "would not be written" : "not written";

        this.operation("failed", file, { note: fs.existsSync(file) ? `${verb} because of an error; the previous copy stays` : `${verb} because of an error` });
    }

    /**
     * Reads a file and, recursively, everything it includes, rendering nothing. A file read already
     * for this unit is not read again, so a file may be included any number of times; only a cycle
     * is an error.
     */
    private loadFile(file: string): FileNode | null {
        const known = this.nodes.get(file);

        if (known !== undefined) {
            return known;
        }

        if (!fs.existsSync(file)) {
            this.recordError(`File not found: ${file}`, { file }, { subject: file });

            return null;
        }

        this.includeStack.push(file);

        try {
            const content = fs.readFileSync(file, "utf8");
            const node: FileNode = { path: file, content, isTpl: path.basename(file).includes(".tpl."), real: true, parts: [] };

            // Kept before its includes are read, so the graph lists parents first.
            this.nodes.set(file, node);
            node.parts = this.processIncludes(content, path.dirname(file), file, file);

            return node;
        } catch (error) {
            this.recordError(`Failed to read file ${file}`, { file }, { subject: file, cause: messageOf(error) });
            this.nodes.delete(file);

            return null;
        } finally {
            this.includeStack.pop();
        }
    }

    /**
     * Splits a file into its own lines and the files its include lines name. Lines inside fenced
     * code blocks (``` or ~~~) stay as written, so include syntax can be shown in a document.
     * A line that looks like an include but is not well formed is an error naming the line.
     */
    private processIncludes(content: string, baseDir: string, fromFile: string, where: string): Part[] {
        const fenceOpen = /^ {0,3}(`{3,}|~{3,})/;
        const fenceClose = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
        const out: Part[] = [];
        let fenceChar: string | null = null;
        let fenceLength = 0;

        for (const [lineIndex, line] of content.split("\n").entries()) {
            if (fenceChar !== null) {
                const close = fenceClose.exec(line);

                if (close && close[1]![0] === fenceChar && close[1]!.length >= fenceLength) {
                    fenceChar = null;
                }

                out.push(line);
                continue;
            }

            const open = fenceOpen.exec(line);

            if (open) {
                fenceChar = open[1]![0]!;
                fenceLength = open[1]!.length;
                out.push(line);
                continue;
            }

            const trimmed = line.trimEnd();
            const match = INCLUDE_LINE_PATTERN.exec(trimmed);

            if (!match) {
                if (looksLikeIncludeLine(trimmed)) {
                    this.recordError(
                        `Malformed include line: ${trimmed}`,
                        { file: fromFile, line: lineIndex + 1 },
                        {
                            subject: where,
                            line: lineIndex + 1,
                            cause:
                                `An include is "@" followed by a path that ends in .md, optionally followed by ` +
                                `"?name=value". The path may hold letters, digits and . _ - / : $ { } * ? [ ] , ~ #.`,
                            hint: `To write a line that starts with "@" as text, put a word after it.`,
                        },
                    );
                }

                out.push(line);
                continue;
            }

            out.push(...this.includeLine(match[1]!.trim(), trimmed, baseDir, fromFile, where, lineIndex + 1));
        }

        return out;
    }

    /** The parts one include line becomes. */
    private includeLine(includePath: string, line: string, baseDir: string, fromFile: string, where: string, lineNumber: number): Part[] {
        const unitScope = this.unit?.scope ?? {};
        const result = this.deps.includes.resolve(includePath, { fromFile, baseDir, scope: unitScope });

        if (result.files.length === 0) {
            // A view is a list that may be empty: a glob over it that selects nothing includes nothing.
            if (result.view && result.glob && result.hashProblem === undefined) {
                return [];
            }

            const malformed = this.malformedReference(includePath);

            if (malformed !== undefined) {
                this.recordError(`Malformed include line: ${line}`, { file: fromFile, line: lineNumber }, { subject: where, line: lineNumber, cause: malformed });

                return [""];
            }

            if (result.candidates[0] !== undefined) {
                this.wanted.push(result.candidates[0]);
            }

            const explanation = result.namespaceProblem
                ? this.deps.includes.describeNamespaceProblem(result.namespaceProblem)
                : result.hashProblem
                  ? result.hashProblem
                  : undefined;
            const tried = `tried:\n${result.candidates.map((candidate) => `  - ${candidate}`).join("\n")}`;

            this.recordError(
                `${result.glob ? "Include matched no files" : "Include not found"}: @${includePath}`,
                { file: fromFile, line: lineNumber },
                { subject: where, line: lineNumber, cause: explanation === undefined ? tried : `${explanation}\n${tried}` },
            );

            return [""];
        }

        const parts: Part[] = [];

        for (const file of result.files) {
            if (this.includeStack.includes(file)) {
                this.recordError(`Circular dependency detected: ${this.includeStack.join(" -> ")} -> ${file}`, { file: fromFile, line: lineNumber }, { subject: fromFile, line: lineNumber });
                parts.push("");
                continue;
            }

            parts.push(this.loadFile(file) === null ? "" : { file });
        }

        return parts;
    }

    /**
     * Without a namespace resolver a `~` reference is only a relative path, so say what is wrong
     * with a malformed one instead of "not found".
     */
    private malformedReference(includePath: string): string | undefined {
        if (this.deps.hasNamespaceResolver || !includePath.startsWith("~") || this.deps.refsParser === undefined) {
            return undefined;
        }

        const reference = splitIncludeQuery(includePath).path.slice(1);

        if (!reference.includes("/") || reference.includes("${")) {
            return undefined;
        }

        try {
            const parsed = this.deps.refsParser.parse(reference);

            return parsed.readings.length === 0 ? (parsed.problems.join("\n  ") || `"${reference}" is not a recipe reference.`) : undefined;
        } catch (error) {
            return messageOf(error);
        }
    }

    /**
     * A read file's final text. A file that renders as Liquid is rendered with the output's
     * variables. Each include is a unique marker while the file renders, so a condition around an
     * include line is honored and an included file's output is never rendered twice; every marker
     * that survives is then replaced by that file's own final text.
     */
    private async expand(file: string, vars: VarScope, entryDir: string): Promise<string> {
        const node = this.nodes.get(file)!;
        const nonce = Math.random().toString(36).slice(2);
        const markers = new Map<string, string>();
        const chunks = node.parts.map((part) => {
            if (typeof part === "string") {
                return part;
            }

            const marker = `\u0001SOUS-INCLUDE-${nonce}-${markers.size}\u0001`;

            markers.set(marker, part.file);

            return marker;
        });
        let text = chunks.join("\n");

        if (node.isTpl) {
            const dir = path.dirname(node.path);

            text = await this.render(text, { ...vars, sousTemplatePath: node.path, sousTemplateDir: dir }, [...new Set([dir, entryDir])], node.path);
        }

        for (const [marker, child] of markers) {
            if (!text.includes(marker)) {
                continue;
            }

            const body = await this.expand(child, vars, entryDir);
            const comment = this.sourceComments ? `<!-- from: ${path.relative(this.deps.projectRoot, child)} -->\n` : "";

            text = text.split(marker).join(comment + body);
        }

        return text;
    }

    private async render(content: string, vars: VarScope, roots: string[], fromFile: string): Promise<string> {
        try {
            const engine = this.deps.createEngine({ roots, scope: { ...(this.unit?.scope ?? {}), ...vars }, fromFile });

            return (await engine.parseAndRender(content, vars)) as string;
        } catch (error) {
            this.recordError("Template rendering error", { file: fromFile }, { subject: fromFile, cause: messageOf(error) });

            return content;
        }
    }
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function readText(file: string): string | undefined {
    try {
        return fs.readFileSync(file, "utf8");
    } catch {
        return undefined;
    }
}

function realPathOf(file: string): string {
    try {
        return fs.realpathSync(file);
    } catch {
        return file;
    }
}

function modeOf(file: string): number | undefined {
    try {
        return fs.statSync(file).mode;
    } catch {
        return undefined;
    }
}

/** A problem as plain text: the summary, then its cause and hint. */
function problemText(summary: string, facts: ProblemFacts): string {
    return [summary, facts.cause, facts.hint].filter((part): part is string => part !== undefined).join("\n  ");
}
