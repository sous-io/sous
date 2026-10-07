import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { get_encoding, type Tiktoken } from "tiktoken";
import { displayError, log, showVariable, subheading, warning } from "../utils/formatting.js";
import { createLiquidEngine } from "../templating/init-liquid-engine.js";
import {
  StateService,
  type StateFile,
  type StateFileEntry,
  hashContent,
  recordDirCreation,
} from "./state.js";
import {
  resolveIncludeFiles,
  splitIncludeQuery,
  type AliasMap,
  type ViewMap,
} from "./include-resolver.js";
import { RefSource, sharedRefResolver } from "../services/ref-resolver/index.js";
import {
  formatNamespaceProblem,
  type NamespaceResolver,
} from "./repos/namespace-resolver.js";

export type ResolvedOutput = {
  destinationFile?: string;
  destinationDir?: string;
  /** Resolved variable scope for this output; ${varName} references in compiled content are substituted. */
  vars?: Record<string, string>;
};

/** Resolved runtime context configuration for AGENTS-style compilation targets. */
export type ResolvedRuntimeContext = {
  /** Absolute path to the git repo used for branch detection. */
  gitRoot: string;
  /** Absolute path where the generated session context file is written. */
  outputPath: string;
  /** Root directory for task files; branch name is appended to find the active task file. */
  taskFileRoot: string;
  /** Pattern used to determine whether the current branch has a task file. */
  branchPattern: RegExp;
};

export type CompilationTarget = {
  rootInputPath: string;
  outputs: ResolvedOutput[];
  includeSourceComments?: boolean;
  /**
   * Base directory used to compute relative output paths when mirroring source structure
   * under a destinationDir. Populated by the settings resolver (inferred from the entryGlob
   * pattern, or set explicitly via globBase in the target config).
   */
  globBase?: string;
  /**
   * When set, generates a runtime session context file (branch name, task file) before
   * compilation. Only set for AGENTS-style targets that have runtimeContext configured.
   */
  runtimeContext?: ResolvedRuntimeContext;
};

export type CompilationConfig = {
  includeSourceComments?: boolean;
  targets: CompilationTarget[];
  /** Resolved `@include` alias map (name → ordered base dirs). */
  aliases?: Record<string, string[]>;
  /** The files each view lists (`#memories`), keyed by the name with its `#`. */
  views?: ViewMap;
  /** Variable scope for `${var}` substitution in `@include` paths. */
  includeScope?: Record<string, string>;
  /**
   * Every variable name a recipe declares `secret: true`. The tags that dump a
   * whole scope hide these (and anything that very probably is a secret); a
   * template that names one explicitly still renders it.
   */
  secretVariables?: string[];
};

export type CompilationServiceOptions = {
  /**
   * Treat compile warnings as errors. An error always fails the compile; this
   * only decides whether a warning (a `.tpl.` file copied without being
   * rendered, a git branch that could not be read) does too.
   */
  strict?: boolean;
  rebuild?: boolean;
  dryRun?: boolean;
  /**
   * Resolves `@~<namespace>/<recipe>/<path>` includes and the matching
   * `{% render %}` paths against recipe namespaces. Omit it and the `~` sigil
   * only ever means an alias, which is the behavior for projects that use no
   * repositories.
   */
  namespaceResolver?: NamespaceResolver;
};

/**
 * Infers the static base directory from a glob pattern.
 * Returns the longest path prefix before the first glob character (* ? { [).
 *
 * Examples:
 *   "/foo/bar/**\/*"     → "/foo/bar"
 *   "/foo/bar/*\/baz.md" → "/foo/bar"
 *   "/**\/*"             → "/"
 */
/**
 * The file one output of one target writes, or undefined when the output names
 * neither a destination file nor a destination directory.
 *
 * A `destinationFile` is used as it stands. A `destinationDir` mirrors the
 * source tree underneath it, relative to the target's `globBase`, with `.tpl.`
 * stripped from the name.
 *
 * Exported because prune needs the same answer without compiling: a group of
 * targets that share one destination directory (every subscribed recipe writing
 * into `.claude/skills`, say) can only be pruned precisely if the exact set of
 * files they write is known.
 *
 * @param target - The compilation target.
 * @param output - One of its outputs.
 */
export function resolveOutputPath(
  target: Pick<CompilationTarget, "rootInputPath" | "globBase">,
  output: ResolvedOutput
): string | undefined {
  if (output.destinationFile) return output.destinationFile;
  if (!output.destinationDir) return undefined;

  const sourceRelative = target.globBase
    ? path.relative(target.globBase, target.rootInputPath)
    : path.basename(target.rootInputPath);

  return path.join(output.destinationDir, sourceRelative.replace(/\.tpl\./, "."));
}

export function inferGlobBase(pattern: string): string {
  const parts = pattern.split("/");
  const staticParts: string[] = [];
  for (const part of parts) {
    if (/[*?{[]/.test(part)) break;
    staticParts.push(part);
  }
  // Remove trailing empty string from a trailing slash (e.g. "/foo/bar/")
  if (staticParts.length > 0 && staticParts[staticParts.length - 1] === "") {
    staticParts.pop();
  }
  const joined = staticParts.join("/");
  return joined || "/";
}

/**
 * A stable text form of an output's variable scope, for the source hash of a
 * rendered output. Keys are sorted so two scopes holding the same values hash
 * the same whatever order they were assembled in.
 *
 * @param vars - The variable scope an output renders with.
 */
export function stableVarsFingerprint(vars: Record<string, string>): string {
  return JSON.stringify(Object.keys(vars).sort().map((key) => [key, vars[key]]));
}

/**
 * An include line: `@`, a path that ends in `.md` and an optional
 * `?name=value` query, and nothing else. The first character is a sigil, a
 * variable, a dot or a letter, a digit or a glob character; the rest may hold
 * the characters of a path, a `${var}`, a glob and a recipe reference's `repo:`
 * qualifier.
 */
export const INCLUDE_LINE_PATTERN =
  /^@([~#a-zA-Z0-9_.${}*?[][a-zA-Z0-9_\-/.:${}*?[\],!~#%+^()]*\.md(?:\?[^?\s]*=\S*)?)$/;

/**
 * Whether a line that is not a well-formed include still looks like one: it
 * starts with `@` and is a single path-like word, meaning it holds a `/` or a
 * `.md`, or starts with a sigil or a variable (`@~`, `@#`, `@.`, `@$`). A line
 * that merely starts with `@` (a mention or an email address followed by
 * words, or a lone `@name`) does not.
 *
 * looksLikeIncludeLine("@docs/notes.txt"); // -> true, the include has no .md
 * looksLikeIncludeLine("@alice thanks for the review"); // -> false
 * looksLikeIncludeLine("@alice"); // -> false
 *
 * @param line - One line of a file, with trailing whitespace already removed.
 */
export function looksLikeIncludeLine(line: string): boolean {
  if (!/^@\S+$/.test(line)) return false;
  const word = line.slice(1);
  return /[/]/.test(word) || /\.md\b/.test(word) || /^[~#.$]/.test(word);
}

/** One piece of a read file: a line of its own text, or a file it includes. */
type Part = string | { file: string };

/** A file read for a target: its text, whether its name makes it a template, and its pieces. */
type FileNode = {
  path: string;
  content: string;
  /** True when the file's own name contains `.tpl.`: the only files that render as Liquid. */
  isTpl: boolean;
  parts: Part[];
};

export class CompilationService {
  private strict: boolean;
  private rebuild: boolean;
  private dryRun: boolean;
  private includeStack: string[];
  private nodes: Map<string, FileNode>;
  private views: ViewMap;
  private includedFilesSeen: Set<string>;
  private errors: string[];
  private includeSourceComments: boolean;
  private currentIncludeSourceComments: boolean;
  private encoder: Tiktoken | null;
  private numberFormatter: Intl.NumberFormat;
  private aliases: AliasMap;
  private includeScope: Record<string, string>;
  /** Every variable name a recipe declares secret, for the scope-dumping tags. */
  private secretVariables: string[];
  private namespaceResolver?: NamespaceResolver;
  /**
   * `.tpl.` outputs that were written without a variable scope, so LiquidJS never
   * ran and the template shipped with its tags intact. Reported at the end of the
   * compile run. Each entry is `<source> → <destination>`.
   */
  private unrenderedTemplates: string[];

  constructor(options: CompilationServiceOptions = {}) {
    this.strict = options.strict ?? false;
    this.rebuild = options.rebuild ?? false;
    this.dryRun = options.dryRun ?? false;
    this.includeStack = [];
    this.nodes = new Map();
    this.views = {};
    this.includedFilesSeen = new Set();
    this.errors = [];
    this.includeSourceComments = false;
    this.currentIncludeSourceComments = false;
    this.encoder = null;
    this.numberFormatter = new Intl.NumberFormat("en-US");
    this.aliases = {};
    this.includeScope = {};
    this.secretVariables = [];
    this.namespaceResolver = options.namespaceResolver;
    this.unrenderedTemplates = [];
  }

  /** Lazily initialize the tokenizer. */
  private initializeEncoder(): void {
    if (this.encoder) return;
    this.encoder = get_encoding("o200k_base");
  }

  /**
   * Records a compile error and prints it. The compile carries on, so every
   * target is compiled and every error is listed; the output the error belongs
   * to is not written, and the compile as a whole reports failure.
   */
  private handleError(message: string): void {
    this.errors.push(message);
    displayError(message);
  }

  /**
   * Records a compile warning: printed as a warning, or, in strict mode,
   * recorded as an error, with everything an error brings.
   */
  private handleWarning(message: string): void {
    if (this.strict) {
      this.handleError(message);
      return;
    }
    warning(message);
  }

  /**
   * Process @<path> includes in content.
   *
   * Matches an `@`-prefixed `.md` path on its own line, optionally followed by
   * a `?name=value` query (read by the ref service and otherwise ignored). The
   * path may be:
   *   - relative to the including file (`@sections/intro.md`),
   *   - a `${var}`-substituted path (`@${sousRootPath}/x.md`),
   *   - a `#name` path (`@#project/memories/x.md`), or an alias path
   *     (`@docs/x.md`), where the first segment (up to `/` or `:`) names a
   *     registered alias,
   *   - a home-relative path (`@~/notes/x.md`),
   *   - or a recipe reference (`@~workflow/task-files/_partials/x.md`), where
   *     the `~` sigil is followed by a namespace, a recipe and a file inside it.
   *     Recipe references are only consulted when a namespace resolver was
   *     supplied.
   * Any of them may use glob syntax, and then includes every file it matches,
   * in sorted path order; a glob that matches nothing is an error.
   *
   * A file may be included any number of times; only a file that includes
   * itself (directly or through others) is an error.
   *
   * Lines inside fenced code blocks (``` or ~~~, per CommonMark) are left
   * verbatim, so include syntax can be documented without being executed.
   *
   * A line that starts with `@` and looks like an include (see
   * {@link looksLikeIncludeLine}) but is not a well-formed one is a compile
   * error naming the file and the line, never text copied to the output.
   *
   * Resolution produces ordered groups of candidates (see include-resolver);
   * the first group that names a file is used. If none does, it errors, naming
   * the including file and listing every path tried, plus what went wrong with
   * a `~` or `#` reference when one was attempted.
   *
   * @param content - The file's raw text.
   * @param baseDir - Directory the relative candidate resolves against.
   * @param projectRoot - Root used to render source comments as relative paths.
   * @param fromFile - Absolute path of the file being processed; defaults to `baseDir`.
   */
  private processIncludes(
    content: string,
    baseDir: string,
    projectRoot: string,
    fromFile?: string
  ): Part[] {
    const fenceOpenPattern = /^ {0,3}(`{3,}|~{3,})/;
    const fenceClosePattern = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
    const where = fromFile ?? baseDir;

    const out: Part[] = [];
    let fenceChar: string | null = null;
    let fenceLength = 0;

    for (const [lineIndex, line] of content.split("\n").entries()) {
      if (fenceChar !== null) {
        // Inside a fence: emit verbatim; only a matching closing fence ends it.
        const close = fenceClosePattern.exec(line);
        if (close && close[1][0] === fenceChar && close[1].length >= fenceLength) {
          fenceChar = null;
        }
        out.push(line);
        continue;
      }

      const open = fenceOpenPattern.exec(line);
      if (open) {
        fenceChar = open[1][0];
        fenceLength = open[1].length;
        out.push(line);
        continue;
      }

      const trimmed = line.trimEnd();
      const match = INCLUDE_LINE_PATTERN.exec(trimmed);
      if (!match) {
        if (looksLikeIncludeLine(trimmed)) {
          this.handleError(
            `Malformed include line: ${trimmed}\n  in file: ${where}, line ${lineIndex + 1}\n` +
              `  An include is "@" followed by a path that ends in .md, optionally followed by ` +
              `"?name=value". The path may hold letters, digits and . _ - / : $ { } * ? [ ] , ~ #.\n` +
              `  To write a line that starts with "@" as text, put a word after it.`
          );
        }
        out.push(line);
        continue;
      }

      const includePath = match[1].trim();
      const { files, glob, candidates, namespaceIssue, hashIssue, view } = resolveIncludeFiles(
        includePath,
        {
          aliases: this.aliases,
          views: this.views,
          scope: this.includeScope,
          baseDir,
          namespaceResolver: this.namespaceResolver,
          fromFile: where,
        }
      );

      if (files.length === 0) {
        // A view is a list that may be empty: a glob over it that selects
        // nothing includes nothing, and the line leaves no trace.
        if (view === true && glob && hashIssue === undefined) continue;
        if (this.namespaceResolver === undefined && includePath.startsWith("~")) {
          // Without a resolver the reference is only a relative path, so say
          // what is wrong with a malformed one instead of "not found".
          const reference = splitIncludeQuery(includePath).path.slice(1);
          if (reference.includes("/") && !reference.includes("${")) {
            try {
              sharedRefResolver().parse(reference, RefSource.Include);
            } catch (error) {
              this.handleError(
                `Malformed include line: ${trimmed}\n  in file: ${where}, line ${lineIndex + 1}\n  ${
                  error instanceof Error ? error.message : String(error)
                }`
              );
              out.push("");
              continue;
            }
          }
        }
        const explanation = namespaceIssue
          ? `\n${formatNamespaceProblem(namespaceIssue)}`
          : hashIssue
            ? `\n  in file: ${where}\n  ${hashIssue.split("\n").join("\n  ")}`
            : `\n  in file: ${where}`;
        this.handleError(
          `${glob ? "Include matched no files" : "Include not found"}: @${includePath}${explanation}\n  tried:\n${candidates
            .map((c) => `    - ${c}`)
            .join("\n")}`
        );
        out.push("");
        continue;
      }

      for (const fullPath of files) {
        if (this.includeStack.includes(fullPath)) {
          this.handleError(
            `Circular dependency detected: ${this.includeStack.join(" -> ")} -> ${fullPath}`
          );
          out.push("");
          continue;
        }

        out.push(this.loadFile(fullPath, projectRoot) === null ? "" : { file: fullPath });
      }
    }

    return out;
  }

  /**
   * Reads a file and, recursively, every file it includes, without rendering
   * anything. A file already read for this target is not read again (its
   * includes resolve the same way whoever includes it), so a file may be
   * included any number of times; only a cycle is an error.
   */
  private loadFile(filePath: string, projectRoot: string): FileNode | null {
    const known = this.nodes.get(filePath);
    if (known !== undefined) return known;

    if (!fs.existsSync(filePath)) {
      this.handleError(`File not found: ${filePath}`);
      return null;
    }

    this.includeStack.push(filePath);

    try {
      const content = fs.readFileSync(filePath, "utf8");
      const baseDir = path.dirname(filePath);
      const node: FileNode = {
        path: filePath,
        content,
        isTpl: path.basename(filePath).includes(".tpl."),
        parts: [],
      };
      // Registered before its includes are read so the graph lists parents
      // first; the cycle check uses the stack, not this map.
      this.nodes.set(filePath, node);
      node.parts = this.processIncludes(content, baseDir, projectRoot, filePath);
      return node;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.handleError(`Failed to read file ${filePath}: ${message}`);
      this.nodes.delete(filePath);
      return null;
    } finally {
      this.includeStack.pop();
    }
  }

  /**
   * Turns a read file into its final text.
   *
   * A file whose own name contains `.tpl.` is rendered as Liquid with the
   * given variables; no other file ever is. Each include is left as a unique
   * marker while the file renders, so a condition around an include line is
   * honored, and an included file's own output is never rendered again. Every
   * marker that survives the render is then replaced by that file's final text,
   * produced the same way.
   *
   * @param filePath - The file to expand.
   * @param vars - The output's variable scope; undefined means templates stay unrendered.
   * @param entryDir - The directory of the target's entry point, also searched by `{% render %}`.
   * @param projectRoot - Root used to render source comments as relative paths.
   */
  private async expand(
    filePath: string,
    vars: Record<string, string> | undefined,
    entryDir: string,
    projectRoot: string
  ): Promise<string> {
    const node = this.nodes.get(filePath)!;
    const nonce = `${process.pid}-${Math.random().toString(36).slice(2)}`;
    const markers = new Map<string, string>();
    const chunks = node.parts.map((part) => {
      if (typeof part === "string") return part;
      const marker = `\u0001SOUS-INCLUDE-${nonce}-${markers.size}\u0001`;
      markers.set(marker, part.file);
      return marker;
    });

    let text = chunks.join("\n");
    if (node.isTpl && vars !== undefined) {
      const dir = path.dirname(node.path);
      text = await this.renderContent(
        text,
        { ...vars, sousTemplatePath: node.path, sousTemplateDir: dir },
        [...new Set([dir, entryDir])],
        node.path
      );
    }

    for (const [marker, child] of markers) {
      if (!text.includes(marker)) continue;
      const body = await this.expand(child, vars, entryDir, projectRoot);
      const comment = this.currentIncludeSourceComments
        ? `<!-- from: ${path.relative(projectRoot, child)} -->\n`
        : "";
      text = text.split(marker).join(comment + body);
    }
    return text;
  }

  /** Every file read for the current target, parents before the files they include. */
  private graphNodes(): FileNode[] {
    return [...this.nodes.values()];
  }

  /**
   * Render template content using LiquidJS with the given variable scope.
   *
   * @param content - The template text.
   * @param vars - Variable scope handed to LiquidJS and to `${var}` path substitution.
   * @param roots - Filesystem roots searched by `{% render %}`.
   * @param fromFile - Absolute path of the template, so `~namespace` render paths are scoped correctly.
   */
  private async renderContent(
    content: string,
    vars: Record<string, string>,
    roots: string[],
    fromFile?: string
  ): Promise<string> {
    const engine = createLiquidEngine(roots, {
      aliases: this.aliases,
      views: this.views,
      scope: { ...this.includeScope, ...vars },
      namespaceResolver: this.namespaceResolver,
      fromFile,
      secretVariables: this.secretVariables,
    });
    try {
      return await engine.parseAndRender(content, vars);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.handleError(`Template rendering error: ${message}`);
      return content;
    }
  }

  /** Generate and write the runtime session context include file. */
  private generateRuntimeSessionContext(target: CompilationTarget): void {
    const ctx = target.runtimeContext!;
    const runtimeDir = path.dirname(ctx.outputPath);

    if (!fs.existsSync(runtimeDir)) {
      fs.mkdirSync(runtimeDir, { recursive: true });
    }

    let branchName = "unknown";

    try {
      branchName = execFileSync(
        "git",
        ["-C", ctx.gitRoot, "rev-parse", "--abbrev-ref", "HEAD"],
        { encoding: "utf8" }
      ).trim();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.handleWarning(
        `Sous could not read the current git branch, so the runtime context says ` +
          `"unknown": ${message}`
      );
    }

    const runtimeHeader = `## Runtime Session Context

The following information is specific to this chat session. It was generated automatically and
embedded into this AGENTS.md file in order to save you and the user some effort in setting up
to begin work.

### Environment Info

Current git branch: \`${branchName}\`

### Current Task File

`;

    let taskFileBlock = "";

    if (ctx.branchPattern.test(branchName)) {
      const taskFilePath = path.join(ctx.taskFileRoot, `${branchName}.md`);

      if (!fs.existsSync(taskFilePath)) {
        taskFileBlock = `
Although we're currently on a feature branch that is tied to a Jira ticket, this branch does not,
yet, have a task file. It's likely that one of the first things we'll be doing in this session is
instantiating a task file, but be sure to ask before you do that.
`;
      } else {
        const taskFileContents = fs.readFileSync(taskFilePath, "utf8").replace(/\n+$/u, "");
        taskFileBlock = `
We're currently on a feature branch that has an existing task file. The full contents of the task
file are included below:

--- Start Task File: ${taskFilePath} ---
${taskFileContents}
--- End Task File: ${taskFilePath} ---
`;
      }
    }

    fs.writeFileSync(ctx.outputPath, `${runtimeHeader}${taskFileBlock}\n`, "utf8");
  }

  /**
   * Says that an output was not written because its target had an error, and
   * what that leaves on disk.
   *
   * @param destFile - The output that was not written.
   */
  private reportNotWritten(destFile: string): void {
    const verb = this.dryRun ? "would not be written" : "not written";
    log(
      fs.existsSync(destFile)
        ? `  ✗ ${destFile} (${verb} because of an error; the previous copy stays)`
        : `  ✗ ${destFile} (${verb} because of an error)`
    );
  }

  /** Compile a single target, writing to all of its outputs. */
  private async compileTarget(
    target: CompilationTarget,
    state: StateFile,
    stateFileEntries: StateFileEntry[]
  ): Promise<boolean> {
    subheading(path.basename(target.rootInputPath), "▷");
    showVariable("Entry Point", target.rootInputPath);

    this.initializeEncoder();

    this.includeStack = [];
    this.nodes = new Map();
    this.currentIncludeSourceComments =
      typeof target.includeSourceComments === "boolean"
        ? target.includeSourceComments
        : this.includeSourceComments;

    const errorsBefore = this.errors.length;

    if (target.runtimeContext) {
      this.generateRuntimeSessionContext(target);
    }

    const promptsRoot = path.dirname(target.rootInputPath);
    const entry = this.loadFile(target.rootInputPath, promptsRoot);

    if (entry === null) {
      displayError(`Failed to compile ${target.rootInputPath}`);
      return false;
    }

    // An include that failed left a hole in the assembled content (and in strict
    // mode, a warning counts as an error), so none of this target's outputs may
    // be written: the previous copy stays in place.
    const assembled = this.errors.length === errorsBefore;

    // Compute the source hash once per target from every file read: the entry
    // point and everything it includes, whatever a condition decides later.
    const graph = this.graphNodes();
    for (const node of graph) this.includedFilesSeen.add(realPathOf(node.path));
    const templates = graph.filter((node) => node.isTpl);
    const contentHash = hashContent(
      JSON.stringify([
        this.currentIncludeSourceComments,
        graph.map((node) => [path.relative(promptsRoot, node.path), node.content]),
      ])
    );

    let allSucceeded = true;

    const isTpl = entry.isTpl;
    // Whether any file of this target renders as Liquid, which makes the
    // output depend on its variables.
    const rendersAnything = templates.length > 0;

    for (const output of target.outputs) {
      // Resolve destination path: prefer destinationFile, fall back to destinationDir mirroring
      let destFile: string;

      const resolvedDest = resolveOutputPath(target, output);
      // Neither destinationFile nor destinationDir set — skip
      if (resolvedDest === undefined) continue;
      destFile = resolvedDest;

      if (!assembled) {
        this.reportNotWritten(destFile);
        allSucceeded = false;
        continue;
      }

      // A rendered output depends on its variables as much as on its source: a
      // changed answer or `_vars` value with the same template must re-render,
      // so the variable scope is part of a `.tpl.` output's source hash. A
      // verbatim copy hashes its content alone. The secret names are part of it
      // too, because they decide what a scope-dumping tag hides.
      const srcHash = rendersAnything && output.vars
        ? hashContent(
            `${contentHash}\n${stableVarsFingerprint(output.vars)}\n` +
              `secrets:${JSON.stringify([...this.secretVariables].sort())}`
          )
        : contentHash;

      // Skip if content is unchanged and file already exists (unless --rebuild)
      const existingEntry = state.files.find(f => f.dest === destFile);
      if (
        !this.rebuild &&
        existingEntry?.srcHash === srcHash &&
        fs.existsSync(destFile)
      ) {
        log(`  ⊘ ${destFile} (unchanged)`);
        stateFileEntries.push(existingEntry);
        continue;
      }

      // Dry-run: report what would be written
      if (this.dryRun) {
        log(`  ○ ${destFile} (would write)`);
        continue;
      }

      // A `.tpl.` source with no variable scope never reaches LiquidJS, so its
      // tags would ship verbatim. Record it; reported loudly after the run.
      //
      // NOTE: a config-driven build cannot reach this, because the settings
      // resolver always sets `vars` on every output (at minimum the inherited
      // scope). It is a real guard for callers that build a CompilationConfig
      // directly, and it stays as a tripwire in case the resolver ever changes.
      if (rendersAnything && !output.vars) {
        for (const template of templates) {
          this.unrenderedTemplates.push(`${template.path} → ${destFile}`);
        }
        // In strict mode this warning is an error, so the output is not written.
        if (this.strict) {
          this.reportNotWritten(destFile);
          allSucceeded = false;
          continue;
        }
      }

      const errorsBeforeRender = this.errors.length;
      const resolvedContent = await this.expand(
        target.rootInputPath,
        output.vars,
        promptsRoot,
        promptsRoot
      );

      // A template that failed to render is not written either.
      if (this.errors.length > errorsBeforeRender) {
        this.reportNotWritten(destFile);
        allSucceeded = false;
        continue;
      }

      const fileContent = resolvedContent;
      const outputDir = path.dirname(destFile);

      // Record all ancestor directories that Sous is about to create, from shallowest to deepest.
      // mkdirSync({ recursive }) may create multiple levels; we must track each new one.
      const dirsToCreate: string[] = [];
      let walkDir = outputDir;
      while (!fs.existsSync(walkDir)) {
        dirsToCreate.unshift(walkDir);
        const parent = path.dirname(walkDir);
        if (parent === walkDir) break;
        walkDir = parent;
      }
      if (dirsToCreate.length > 0) {
        fs.mkdirSync(outputDir, { recursive: true });
        for (const dir of dirsToCreate) {
          recordDirCreation(dir, state);
        }
      }

      try {
        fs.writeFileSync(destFile, fileContent, "utf8");

        if (destFile.endsWith(".sh")) {
          fs.chmodSync(destFile, 0o755);
        }

        if (!isTpl) {
          try {
            const srcStat = fs.statSync(target.rootInputPath);
            fs.chmodSync(destFile, srcStat.mode);
          } catch {
            // Ignore chmod failures on unsupported platforms
          }
        }

        const destHash = hashContent(fileContent);
        const entry: StateFileEntry = {
          dest: destFile,
          srcHash,
          destHash,
          size: Buffer.byteLength(fileContent, "utf8"),
          builtAt: new Date().toISOString(),
        };
        stateFileEntries.push(entry);

        const tokenCount = this.encoder!.encode(fileContent).length;
        const formattedTokenCount = this.numberFormatter.format(tokenCount);
        log(`  ✓ ${destFile} (~${formattedTokenCount} tokens)`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.handleError(`Failed to write ${destFile}: ${message}`);
        allSucceeded = false;
      }
    }

    return allSucceeded;
  }

  /**
   * Every file the last compile read, as real paths: the entry points and every
   * file any include line of any target named, by any route (exact path, glob
   * or view). Includes inside an unmet condition count, since they are read.
   */
  includedFiles(): ReadonlySet<string> {
    return this.includedFilesSeen;
  }

  /**
   * Compile all targets from the given config. Every target is compiled even
   * after an error, so every error is listed; an output whose target had an
   * error is not written and keeps its previous copy and its state entry.
   *
   * @returns True when nothing reported an error; false after any error.
   */
  async compile(config: CompilationConfig, stateFilePath?: string): Promise<boolean> {
    const stateService = new StateService();
    let state: StateFile = stateFilePath
      ? ((await stateService.load(stateFilePath)) ?? {
          lastBuild: "",
          resolvedVars: {},
          dirs: [],
          files: [],
        })
      : { lastBuild: "", resolvedVars: {}, dirs: [], files: [] };

    try {
      // Only complain about a value that is actually present and wrong. The
      // settings resolver always sets the key (to undefined when the config omits
      // it), so a hasOwnProperty check alone fired on every single build.
      if (
        config.includeSourceComments !== undefined &&
        typeof config.includeSourceComments !== "boolean"
      ) {
        this.handleError("Config option 'includeSourceComments' must be a boolean");
      }

      this.includeSourceComments = config.includeSourceComments === true;
      this.aliases = config.aliases ?? {};
      this.views = config.views ?? {};
      this.includedFilesSeen = new Set();
      this.includeScope = config.includeScope ?? {};
      this.secretVariables = config.secretVariables ?? [];

      this.initializeEncoder();

      let allSucceeded = true;
      const stateFileEntries: StateFileEntry[] = [];
      this.unrenderedTemplates = [];

      for (const target of config.targets) {
        const success = await this.compileTarget(target, state, stateFileEntries);
        if (!success) allSucceeded = false;
      }

      if (this.unrenderedTemplates.length > 0) {
        const count = this.unrenderedTemplates.length;
        const message =
          `${count} TEMPLATE FILE(S) WERE COPIED WITHOUT BEING RENDERED.\n` +
          `Each of these is a '.tpl.' source written to an output that has no vars, so\n` +
          `LiquidJS never ran and the {{ tags }} are still in the output file:\n` +
          this.unrenderedTemplates.map((entry) => `  - ${entry}`).join("\n") +
          `\nFix: add a '_vars' block to the output (an empty '_vars: {}' is enough to\n` +
          `enable rendering), or rename the source so it does not contain '.tpl.'.`;

        this.handleWarning(message);
      }

      if (this.errors.length > 0) {
        subheading(`Done with ${this.errors.length} error(s).`, "⚠");
      } else {
        subheading("Done.", "✓");
      }

      // Update state: fresh entries for everything compiled this pass, plus
      // carried-forward entries for outputs this pass did not touch — other
      // targets' outputs during a partial rebuild, and outputs dropped from the
      // config, which must stay tracked so prune/clear can still find them.
      // Entries whose files are gone from disk are released.
      const writtenDests = new Set(stateFileEntries.map((e) => e.dest));
      state.files = [
        ...stateFileEntries,
        ...state.files.filter((f) => !writtenDests.has(f.dest) && fs.existsSync(f.dest)),
      ];
      state.lastBuild = new Date().toISOString();

      if (stateFilePath && !this.dryRun) {
        await stateService.save(stateFilePath, state);
      }

      // Any error fails the compile, including one that belongs to no single
      // target (a bad config option).
      return allSucceeded && this.errors.length === 0;
    } finally {
      if (this.encoder) {
        this.encoder.free();
        this.encoder = null;
      }
    }
  }
}

// Backward-compat alias so existing imports of MarkdownCompiler keep working
export { CompilationService as MarkdownCompiler };
export type { CompilationServiceOptions as MarkdownCompilerOptions };

/** The path with symbolic links resolved, or the path itself when it cannot be read. */
function realPathOf(filePath: string): string {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return filePath;
  }
}
