/**
 * Compiling units into outputs: reading each source and every file it includes, rendering the
 * `.tpl.` files and `content` sources as Liquid, applying transforms, and writing through the
 * writer. Errors are collected, never thrown, so every target compiles and every error is listed;
 * an output whose target had an error is not written, and its previous copy stays.
 */

import { isUtf8 } from "node:buffer";
import fs from "node:fs";
import path from "node:path";
import type { Liquid } from "liquidjs";
import { BufferedReporter, LogLevel, nullReporter, type OperationDetails, ReportEntryStyle, Reporting, type ProblemDetails, type ReportedMessage, type Reporter, type ServiceContext } from "@sous-io/sous-plugin-api";
import type { RefsParser } from "@sous-io/sous-plugin-refs/types";
import type { VarScope } from "@sous-io/sous-plugin-variables/types";
import { reportBackup } from "./backups.js";
import { findImportTokens, scanMarkdown } from "./markdown.js";
import { importPath, isIncludableFile, isSousIncludeForm, splitIncludeQuery, stableVarsFingerprint } from "./paths.js";
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

/** One output as the writer gets it: text, or bytes copied unchanged. */
type OutputFile = Omit<TransformFile, "content"> & { content: string | Uint8Array };

/**
 * One piece of a read file: a piece of its own text, or a file it includes. The pieces join with
 * nothing between them. An include inside a line (`inline`) is trimmed when it is put in place.
 */
type Part = string | { file: string; inline: boolean };

/** A file read for a unit. */
interface FileNode {
    path: string;
    content: string;
    /** True when the file renders as Liquid: its name holds `.tpl.`, or it is a `content` source. */
    isTpl: boolean;
    /** False for a `content` source, which is not on disk. */
    real: boolean;
    parts: Part[];
    /** The file as read, for a real file that is not a template: what an output copies unchanged. */
    bytes?: Buffer;
    /** True when the bytes are not UTF-8 text (an image, say): its includes are not looked for. */
    binary?: boolean;
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
    /** What templates read as `host.platform`. Default: Node's `process.platform`; only tests pass another. */
    readonly platform?: string;
}

/** How a run behaves. */
export interface CompileOptions {
    readonly strict?: boolean;
    readonly rebuild?: boolean;
    readonly dryRun?: boolean;
    /** Which run this is (the chain's id): every backup of one run goes in one timestamp folder. */
    readonly run?: number;
}

/** What a run did. */
export interface CompileRunResult {
    readonly outputs: CompiledOutput[];
    readonly problems: CompileProblem[];
    /** Every output a unit would write, written or not: what prune keeps. */
    readonly produced: Set<string>;
    /** Every file read, as real paths: sources and everything they include. */
    readonly included: Set<string>;
    /** The outputs left unwritten: by an error, or because sous did not write the file already there. */
    readonly notWritten: Set<string>;
}

/** What a problem report says beyond its summary. */
type ProblemFacts = Omit<ProblemDetails, "summary">;

/** One run of the compiler over a list of units. */
export class CompileRun extends Reporting(Object) {
    private readonly problems: CompileProblem[] = [];
    private readonly outputs: CompiledOutput[] = [];
    private readonly produced = new Set<string>();
    private readonly included = new Set<string>();
    private readonly notWrittenFiles = new Set<string>();
    /** What the unit being compiled reported, held until it is known whether the unit changed anything. */
    private unitReport: BufferedReporter | undefined;
    private nodes = new Map<string, FileNode>();
    private includeStack: string[] = [];
    private sourceComments = false;
    private unit: CompileUnit | undefined;
    /** The output being rendered. */
    private output: UnitOutput | undefined;
    private errorCount = 0;

    constructor(
        private readonly deps: CompileDependencies,
        private readonly options: CompileOptions = {},
    ) {
        super();
    }

    protected get reporter(): Reporter {
        return this.unitReport ?? this.deps.reporter;
    }

    /** Compiles every unit. */
    async run(units: readonly CompileUnit[]): Promise<CompileRunResult> {
        for (const unit of units) {
            await this.compileUnit(unit);
        }

        return { outputs: this.outputs, problems: this.problems, produced: this.produced, included: this.included, notWritten: this.notWrittenFiles };
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

    /**
     * Compiles one unit, holding back what it reports until the unit is done. A unit that changed
     * nothing (every output unchanged, no problem) is reported at the `debug` level, so its block
     * shows only in verbose output; any other unit's block is reported as it was written.
     */
    private async compileUnit(unit: CompileUnit): Promise<void> {
        const held = new BufferedReporter();

        this.unitReport = held;

        try {
            await this.compileUnitHeld(unit);
        } finally {
            this.unitReport = undefined;

            if (held.messages.every(isUnchangedEntry)) {
                for (const entry of held.messages) {
                    this.deps.reporter.log(LogLevel.Debug, entry.message, entry.details, entry.style);
                }
            } else {
                held.flushTo(this.deps.reporter);
            }
        }
    }

    private async compileUnitHeld(unit: CompileUnit): Promise<void> {
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

            for (const output of unit.outputs) {
                this.notWrittenFiles.add(output.destination);
            }

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
                graph.map((node) => [path.relative(root, node.path), node.binary ? hashContent(node.bytes!) : node.content]),
                ...(unit.transforms.length > 0 ? [unit.transforms] : []),
            ]),
        );
        const rendersAnything = graph.some((node) => node.isTpl);
        const sourceMode = entry.real ? outputModeOf(entry) : undefined;

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
        // The values sous gives every template (the platform, the output's harness) count too.
        const sourceHash = rendersAnything
            ? hashContent(
                  `${contentHash}\n${stableVarsFingerprint(output.vars)}\n` +
                      `secrets:${JSON.stringify([...this.deps.secretNames].sort())}\n` +
                      `globals:${JSON.stringify(this.templateGlobals(output))}` +
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
            const existing = readBytes(output.destination);

            // Written again unchanged, which records the target and origin of an older entry. An
            // output edited by hand since is compiled again instead, so the edit is backed up and
            // replaced rather than recorded as sous's own.
            if (existing !== undefined && hashContent(existing) === tracked.destHash) {
                await this.write({ source: unit.label, destination: output.destination, content: existing }, sourceHash, base, sourceMode, output.backupExisting);

                return;
            }
        }

        const entry = this.nodes.get(unit.source);

        // A file that is not a template and includes nothing is copied byte for byte, so a binary
        // file is not corrupted by being read as text. (An include that found nothing to include
        // leaves no part of its own, so the parts must also still be the file's text.)
        if (entry?.bytes !== undefined && transforms.length === 0 && entry.parts.every((part) => typeof part === "string") && entry.parts.join("\n") === entry.content) {
            await this.write({ source: unit.label, destination: output.destination, content: entry.bytes }, sourceHash, base, sourceMode, output.backupExisting);

            return;
        }

        const errorsBefore = this.errorCount;

        // What `sousOutputPath`, `sousOutputDir` and `harness.id` read while this output renders,
        // in its own file and in every file it includes.
        this.output = output;

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
                // Not produced, so a copy an earlier build wrote is removed by the prune that follows.
                this.produced.delete(output.destination);
                this.operation("skipped", output.destination, { note: `left out by the transform "${id}"` });

                return;
            }

            file = { ...file, destination: path.resolve(file.destination) };
        }

        if (file.destination !== output.destination) {
            this.produced.add(file.destination);
        }

        await this.write(file, sourceHash, base, sourceMode, output.backupExisting);
    }

    private async write(
        file: OutputFile,
        sourceHash: string,
        base: Pick<CompiledOutput, "source" | "target" | "origin">,
        mode: number | undefined,
        backupExisting?: boolean,
    ): Promise<void> {
        try {
            const written = await this.deps.writer.write(file.destination, file.content, {
                ...(backupExisting === true ? { overwriteUntracked: true } : {}),
                source: base.source,
                sourceHash,
                ...(base.target === undefined ? {} : { target: base.target }),
                ...(base.origin === undefined ? {} : { origin: base.origin }),
                ...(this.options.dryRun ? { dryRun: true } : {}),
                ...(this.options.rebuild ? { force: true } : {}),
                ...(mode === undefined ? {} : { mode }),
                ...(this.options.run === undefined ? {} : { run: this.options.run }),
            });
            const counted = written.action === "created" || written.action === "updated";
            // An unchanged file's count shows only in verbose output, so it is counted only then.
            const shownUnchanged = written.action === "unchanged" && this.deps.reporter.shows(LogLevel.Debug);
            const text = typeof file.content === "string" ? file.content : isUtf8(file.content) ? Buffer.from(file.content).toString("utf8") : undefined;
            const tokens = (counted || shownUnchanged) && this.deps.countTokens && text !== undefined ? this.deps.countTokens(text) : undefined;

            this.outputs.push({ ...base, ...written, ...(tokens === undefined || !counted ? {} : { tokens }) });

            if (written.action === "skipped-untracked") {
                this.notWrittenFiles.add(written.file);
            }

            if (written.backup !== undefined) {
                reportBackup(this.reporter, written.file, written.backup, this.options.dryRun === true);

                // An output that asked for it says so as a warning: a file someone wrote is being replaced.
                if (backupExisting === true) {
                    this.recordWarning(
                        `${written.file} was not written by sous, so it ${this.options.dryRun === true ? "would be" : "was"} backed up to ${written.backup} and replaced.`,
                        { file: written.file },
                    );
                }
            }

            this.reportWritten(written.file, written.action, tokens);
        } catch (error) {
            this.notWrittenFiles.add(file.destination);
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
                this.operation("unchanged", file, tokens === undefined ? {} : { tokens });
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
        this.notWrittenFiles.add(file);
        const verb = this.options.dryRun ? "would not be written" : "not written";

        this.operation("failed", file, { note: fs.existsSync(file) ? `${verb} because of an error; the previous copy stays` : `${verb} because of an error` });
    }

    /**
     * Reads a file and, recursively, everything it includes, rendering nothing. A file read already
     * for this unit is not read again, so a file may be included any number of times; only a cycle
     * is an error. An included file's frontmatter is left out; the entry's is kept.
     */
    private loadFile(file: string, included = false): FileNode | null {
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
            const bytes = fs.readFileSync(file);
            const content = bytes.toString("utf8");
            const isTpl = path.basename(file).includes(".tpl.");
            const binary = !isTpl && !isUtf8(bytes);
            const node: FileNode = { path: file, content, isTpl, real: true, parts: [], ...(isTpl ? {} : { bytes }), ...(binary ? { binary } : {}) };

            // Kept before its includes are read, so the graph lists parents first.
            this.nodes.set(file, node);
            node.parts = binary ? [content] : this.processIncludes(content, path.dirname(file), file, file, included);

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
     * Splits a file into its own text and the files its includes name, each include in its place.
     *
     * A line holding only one of Sous's own forms (a glob, `@~namespace/...`, `@#name/...`, a
     * `${var}`, a `?name=value` query) is checked first, and is an error when it cannot be resolved,
     * except a glob that matches nothing, whose line is removed. Every other `@path` is found by
     * Claude Code's rule wherever it stands in Markdown text (not in code, HTML, comments,
     * frontmatter or link destinations), and is an include only when it names a file of a type an
     * include takes; otherwise it stays as written. An included file's frontmatter is left out.
     */
    private processIncludes(content: string, baseDir: string, fromFile: string, where: string, included = false): Part[] {
        const layout = scanMarkdown(content, { claimLine: isSousIncludeForm });
        const tokens = findImportTokens(content, layout.runs);
        const references = [
            ...layout.claimed.map((line) => ({ at: line.start, line })),
            ...tokens.map((token) => ({ at: token.at, token })),
        ].sort((left, right) => left.at - right.at);
        const out: Part[] = [];
        let cursor = included ? layout.bodyStart : 0;

        for (const reference of references) {
            const lineNumber = lineNumberAt(content, reference.at);

            if ("line" in reference) {
                const { line } = reference;
                const parts = this.includeLine(line.word, content.slice(line.start, line.end), baseDir, fromFile, where, lineNumber);

                out.push(content.slice(cursor, line.start));

                // A glob that matched nothing takes its whole line with it.
                if (parts === null) {
                    cursor = line.next;
                    continue;
                }

                out.push(...parts);
                cursor = line.end;
                continue;
            }

            const { token } = reference;
            const part = this.includeReference(token.run, baseDir, fromFile, lineNumber, isAloneOnLine(content, token.at, token.end));

            if (part === undefined) {
                continue;
            }

            out.push(content.slice(cursor, token.at), part);
            cursor = token.end;
        }

        out.push(content.slice(cursor));

        return out.filter((part) => part !== "");
    }

    /**
     * The part a plain `@path` becomes: the file it names, or `undefined` when it is not an include
     * (Claude Code's rule rejects it, it is written in one of Sous's own forms, which count only on
     * a line of their own, or no file of a type an include takes is there). A cycle is an error.
     */
    private includeReference(run: string, baseDir: string, fromFile: string, lineNumber: number, alone: boolean): Part | undefined {
        const includePath = importPath(run);

        if (includePath === undefined || isSousIncludeForm(includePath)) {
            return undefined;
        }

        const result = this.deps.includes.resolve(includePath, { fromFile, baseDir, scope: this.unit?.scope ?? {} });
        const file = result.files.find((found) => isRegularFile(found) && isIncludableFile(found));

        if (file === undefined) {
            if (result.candidates[0] !== undefined) {
                this.wanted.push(result.candidates[0]);
            }

            return undefined;
        }

        if (this.includeStack.includes(file)) {
            this.recordError(`Circular dependency detected: ${this.includeStack.join(" -> ")} -> ${file}`, { file: fromFile, line: lineNumber }, { subject: fromFile, line: lineNumber });

            return "";
        }

        return this.loadFile(file, true) === null ? "" : { file, inline: !alone };
    }

    /**
     * The parts a line holding one of Sous's own include forms becomes, or `null` when it is a glob
     * that matched nothing, which removes the line. A glob's matches of a type an include does not
     * take are left out.
     */
    private includeLine(includePath: string, line: string, baseDir: string, fromFile: string, where: string, lineNumber: number): Part[] | null {
        const unitScope = this.unit?.scope ?? {};
        const result = this.deps.includes.resolve(includePath, { fromFile, baseDir, scope: unitScope });
        const files = result.glob ? result.files.filter((file) => isIncludableFile(file)) : result.files;
        const asText = `To write this line as text, put it in backticks, or put a backslash before the "@".`;

        if (files.length === 0) {
            // A glob that matches nothing does nothing, unless its recipe or name was not found.
            if (result.glob && result.namespaceProblem === undefined && result.hashProblem === undefined) {
                return null;
            }

            const malformed = this.malformedReference(includePath);

            if (malformed !== undefined) {
                this.recordError(`Malformed include line: ${line}`, { file: fromFile, line: lineNumber }, { subject: where, line: lineNumber, cause: malformed, hint: asText });

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
                { subject: where, line: lineNumber, cause: explanation === undefined ? tried : `${explanation}\n${tried}`, hint: asText },
            );

            return [""];
        }

        const parts: Part[] = [];

        for (const [index, file] of files.entries()) {
            if (index > 0) {
                parts.push("\n");
            }

            if (this.includeStack.includes(file)) {
                this.recordError(`Circular dependency detected: ${this.includeStack.join(" -> ")} -> ${file}`, { file: fromFile, line: lineNumber }, { subject: fromFile, line: lineNumber });
                continue;
            }

            if (this.loadFile(file, true) !== null) {
                parts.push({ file, inline: false });
            }
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
        const markers = new Map<string, Exclude<Part, string>>();
        const chunks = node.parts.map((part) => {
            if (typeof part === "string") {
                return part;
            }

            const marker = `\u0001SOUS-INCLUDE-${nonce}-${markers.size}\u0001`;

            markers.set(marker, part);

            return marker;
        });
        let text = chunks.join("");

        if (node.isTpl) {
            const dir = path.dirname(node.path);

            text = await this.render(text, { ...vars, sousTemplatePath: node.path, sousTemplateDir: dir, ...this.outputPathVars() }, [...new Set([dir, entryDir])], node.path);
        }

        for (const [marker, child] of markers) {
            if (!text.includes(marker)) {
                continue;
            }

            // A file named inside a line is trimmed, so it sits in the line's place without blank lines.
            const expanded = await this.expand(child.file, vars, entryDir);
            const body = child.inline ? expanded.trim() : expanded;
            const from = `<!-- from: ${path.relative(this.deps.projectRoot, child.file)} -->`;
            const comment = this.sourceComments ? (child.inline ? from : `${from}\n`) : "";

            text = text.split(marker).join(comment + body);
        }

        return text;
    }

    /**
     * `sousOutputPath` and `sousOutputDir`: the file the output being rendered is written to, and its
     * directory, from before any transform. An included file sees the output it is included into.
     */
    private outputPathVars(): Record<string, string> {
        if (this.output === undefined) {
            return {};
        }

        return { sousOutputPath: this.output.destination, sousOutputDir: path.dirname(this.output.destination) };
    }

    /**
     * The objects every template can read: `host.platform` (the value config expressions read) and
     * `harness.id` (the harness the output belongs to, or `""`). A variable of the same name the
     * project sets wins over them.
     */
    private templateGlobals(output: UnitOutput | undefined = this.output): { host: { platform: string }; harness: { id: string } } {
        return { host: { platform: this.deps.platform ?? process.platform }, harness: { id: output?.harness ?? "" } };
    }

    private async render(content: string, vars: VarScope, roots: string[], fromFile: string): Promise<string> {
        try {
            const engine = this.deps.createEngine({ roots, scope: { ...(this.unit?.scope ?? {}), ...vars }, fromFile });

            return (await engine.parseAndRender(content, { ...this.templateGlobals(), ...vars })) as string;
        } catch (error) {
            this.recordError("Template rendering error", { file: fromFile }, { subject: fromFile, cause: messageOf(error) });

            return content;
        }
    }
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function readBytes(file: string): Buffer | undefined {
    try {
        return fs.readFileSync(file);
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

function isRegularFile(file: string): boolean {
    try {
        return fs.statSync(file).isFile();
    } catch {
        return false;
    }
}

/** The line number (from 1) of an offset in a text. */
function lineNumberAt(text: string, offset: number): number {
    let line = 1;

    for (let index = text.indexOf("\n"); index !== -1 && index < offset; index = text.indexOf("\n", index + 1)) {
        line += 1;
    }

    return line;
}

/** Whether `[at, end)` starts its line at the first column and only whitespace follows it. */
function isAloneOnLine(text: string, at: number, end: number): boolean {
    const lineEnd = text.indexOf("\n", end);

    return (at === 0 || text[at - 1] === "\n") && text.slice(end, lineEnd === -1 ? text.length : lineEnd).trim() === "";
}

function modeOf(file: string): number | undefined {
    try {
        return fs.statSync(file).mode;
    } catch {
        return undefined;
    }
}

/**
 * The mode an output of a source file gets: an untemplated file keeps its source's mode, and a
 * template's output keeps its source's mode only when the source is executable, so a templated
 * script stays executable whatever its name. Otherwise the writer decides (`.sh` is executable).
 */
function outputModeOf(entry: FileNode): number | undefined {
    const mode = modeOf(entry.path);

    if (!entry.isTpl || mode === undefined) {
        return mode;
    }

    return (mode & 0o111) !== 0 ? mode : undefined;
}

/** A problem as plain text: the summary, then its cause and hint. */
function problemText(summary: string, facts: ProblemFacts): string {
    return [summary, facts.cause, facts.hint].filter((part): part is string => part !== undefined).join("\n  ");
}

/** Whether a held entry is part of an unchanged unit's block: its heading, its entry point, or an output left unchanged. */
function isUnchangedEntry(entry: ReportedMessage): boolean {
    if (entry.style === ReportEntryStyle.StepStart || entry.style === ReportEntryStyle.Variable) {
        return true;
    }

    return entry.style === ReportEntryStyle.Operation && (entry.details as OperationDetails | undefined)?.action === "unchanged";
}
