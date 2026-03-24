import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { get_encoding, type Tiktoken } from "tiktoken";
import { displayError, log, showVar, subheading } from "../utils/formatting.js";
import { createLiquidEngine } from "../templating/init-liquid-engine.js";
import {
  StateService,
  type StateFile,
  type StateFileEntry,
  hashContent,
  recordDirCreation,
} from "./state.js";

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
};

export type CompilationServiceOptions = {
  strict?: boolean;
  rebuild?: boolean;
  dryRun?: boolean;
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

export class CompilationService {
  private strict: boolean;
  private rebuild: boolean;
  private dryRun: boolean;
  private visited: Set<string>;
  private includeStack: string[];
  private errors: string[];
  private includeSourceComments: boolean;
  private currentIncludeSourceComments: boolean;
  private encoder: Tiktoken | null;
  private numberFormatter: Intl.NumberFormat;

  constructor(options: CompilationServiceOptions = {}) {
    this.strict = options.strict ?? false;
    this.rebuild = options.rebuild ?? false;
    this.dryRun = options.dryRun ?? false;
    this.visited = new Set();
    this.includeStack = [];
    this.errors = [];
    this.includeSourceComments = false;
    this.currentIncludeSourceComments = false;
    this.encoder = null;
    this.numberFormatter = new Intl.NumberFormat("en-US");
  }

  /** Lazily initialize the tokenizer. */
  private initializeEncoder(): void {
    if (this.encoder) return;
    this.encoder = get_encoding("o200k_base");
  }

  /** Handle errors according to strict mode. */
  private handleError(message: string): void {
    this.errors.push(message);
    displayError(message);

    if (this.strict) {
      process.exit(1);
    }
  }

  /**
   * Process @<path> includes in content.
   * Only matches @ at start of line followed by a .md file path.
   */
  private processIncludes(content: string, baseDir: string, projectRoot: string): string {
    const includePattern = /^@([a-zA-Z0-9_\-/.]+\.md)$/gm;
    let result = content;
    let match: RegExpExecArray | null;

    while ((match = includePattern.exec(content)) !== null) {
      const includePath = match[1].trim();
      const fullPath = path.resolve(baseDir, includePath);

      if (this.includeStack.includes(fullPath)) {
        this.handleError(
          `Circular dependency detected: ${this.includeStack.join(" -> ")} -> ${fullPath}`
        );
        result = result.replace(match[0], "");
        continue;
      }

      const includedContent = this.loadFile(fullPath, projectRoot);
      if (includedContent !== null) {
        const relativePath = path.relative(projectRoot, fullPath);
        const sourceComment = this.currentIncludeSourceComments
          ? `<!-- from: ${relativePath} -->\n`
          : "";
        result = result.replace(match[0], sourceComment + includedContent);
      } else {
        result = result.replace(match[0], "");
      }
    }

    return result;
  }

  /** Load a file and recursively process its includes. */
  private loadFile(filePath: string, projectRoot: string): string | null {
    if (!fs.existsSync(filePath)) {
      this.handleError(`File not found: ${filePath}`);
      return null;
    }

    if (this.visited.has(filePath)) {
      return "";
    }

    this.includeStack.push(filePath);

    try {
      const content = fs.readFileSync(filePath, "utf8");
      const baseDir = path.dirname(filePath);
      const processedContent = this.processIncludes(content, baseDir, projectRoot);
      this.visited.add(filePath);
      return processedContent;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.handleError(`Failed to read file ${filePath}: ${message}`);
      return null;
    } finally {
      this.includeStack.pop();
    }
  }

  /** Render template content using LiquidJS with the given variable scope. */
  private renderContent(content: string, vars: Record<string, string>, roots: string[]): string {
    const engine = createLiquidEngine(roots);
    try {
      return engine.parseAndRenderSync(content, vars);
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
      this.handleError(`Failed to resolve current git branch: ${message}`);
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

  /** Compile a single target, writing to all of its outputs. */
  private compileTarget(
    target: CompilationTarget,
    state: StateFile,
    stateFileEntries: StateFileEntry[]
  ): boolean {
    subheading(path.basename(target.rootInputPath), "▷");
    showVar("Entry Point", target.rootInputPath);

    this.initializeEncoder();

    this.visited.clear();
    this.includeStack = [];
    this.currentIncludeSourceComments =
      typeof target.includeSourceComments === "boolean"
        ? target.includeSourceComments
        : this.includeSourceComments;

    if (target.runtimeContext) {
      this.generateRuntimeSessionContext(target);
    }

    const promptsRoot = path.dirname(target.rootInputPath);
    const content = this.loadFile(target.rootInputPath, promptsRoot);

    if (content === null) {
      displayError(`Failed to compile ${target.rootInputPath}`);
      return false;
    }

    // Compute source hash once per target from the assembled content
    const srcHash = hashContent(content);

    let allSucceeded = true;

    const isTpl = path.basename(target.rootInputPath).includes(".tpl.");

    for (const output of target.outputs) {
      // Resolve destination path: prefer destinationFile, fall back to destinationDir mirroring
      let destFile: string;

      if (output.destinationFile) {
        destFile = output.destinationFile;
      } else if (output.destinationDir) {
        // Mirror source path structure under destinationDir
        const sourceRelative = target.globBase
          ? path.relative(target.globBase, target.rootInputPath)
          : path.basename(target.rootInputPath);

        // Strip .tpl. from the output filename (e.g. foo.tpl.md -> foo.md)
        const outputRelative = sourceRelative.replace(/\.tpl\./, ".");

        destFile = path.join(output.destinationDir, outputRelative);
      } else {
        // Neither set — skip
        continue;
      }

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

      const resolvedContent = (isTpl && output.vars)
        ? this.renderContent(content, {
            ...output.vars,
            sousTemplatePath: target.rootInputPath,
            sousTemplateDir: promptsRoot,
          }, [promptsRoot])
        : content;
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
   * Compile all targets from the given config.
   * Returns true if all targets compiled successfully.
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
      if (
        Object.prototype.hasOwnProperty.call(config, "includeSourceComments") &&
        typeof config.includeSourceComments !== "boolean"
      ) {
        this.handleError("Config option 'includeSourceComments' must be a boolean");
      }

      this.includeSourceComments = config.includeSourceComments === true;

      this.initializeEncoder();

      let allSucceeded = true;
      const stateFileEntries: StateFileEntry[] = [];

      for (const target of config.targets) {
        const success = this.compileTarget(target, state, stateFileEntries);
        if (!success) allSucceeded = false;
      }

      if (this.errors.length > 0) {
        subheading(`Done with ${this.errors.length} error(s).`, "⚠");
      } else {
        subheading("Done.", "✓");
      }

      // Update state with fresh entries
      state.files = stateFileEntries;
      state.lastBuild = new Date().toISOString();

      if (stateFilePath && !this.dryRun) {
        await stateService.save(stateFilePath, state);
      }

      return allSucceeded;
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
