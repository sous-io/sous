import fs from "node:fs";
import path from "node:path";
import type { CompilerWriter, WrittenFile } from "@sous-io/plugin-compiler/types";
import type { GitRunner } from "@sous-io/plugin-git/types";
import { DEFAULT_BRANCH_PATTERN } from "./schemas.js";
import type { BuildRuntimeContext, RuntimeContext, RuntimeContextSettings } from "./types.js";

/** The branch the file names when git cannot tell, as before the refactor. */
export const UNKNOWN_BRANCH = "unknown";

/** The source name the state file records for the runtime context file. */
export const RUNTIME_CONTEXT_SOURCE = "runtime-context";

/** What {@link RuntimeContextService} needs. */
export interface RuntimeContextDeps {
    /** The settings, `${var}` substituted, or `undefined` when none are set. */
    settings: RuntimeContextSettings | undefined;
    git: () => GitRunner;
    writer: () => CompilerWriter;
    /** The plugin that writes the file, for the state file's origin. */
    plugin: string;
}

/**
 * The runtime context file (S6, `build.runtime-context`): the current git branch and, on a branch
 * that matches `branchPattern`, the task file named after it. A target with
 * `generateRuntimeContext` includes it. Written through `compiler.writer`, the one way a build
 * output is written.
 */
export class RuntimeContextService implements BuildRuntimeContext {
    constructor(private readonly deps: RuntimeContextDeps) {}

    settings(): RuntimeContextSettings | undefined {
        return this.deps.settings;
    }

    async generate(): Promise<RuntimeContext | undefined> {
        const settings = this.deps.settings;

        if (!settings) {
            return undefined;
        }

        const branch = await this.readBranch(settings.gitRoot);
        const pattern = new RegExp(settings.branchPattern ?? DEFAULT_BRANCH_PATTERN);
        let taskFile: string | undefined;
        let taskContent: string | undefined;

        if (branch !== undefined && pattern.test(branch)) {
            taskFile = path.join(settings.taskFileRoot, `${branch}.md`);
            taskContent = readIfExists(taskFile);
        }

        const content = renderRuntimeContext({
            branch: branch ?? UNKNOWN_BRANCH,
            matched: taskFile !== undefined,
            ...(taskFile === undefined ? {} : { taskFile }),
            ...(taskContent === undefined ? {} : { taskContent }),
        });

        return {
            ...(branch === undefined ? {} : { branch }),
            ...(taskFile !== undefined && taskContent !== undefined ? { taskFile } : {}),
            outputPath: settings.outputPath,
            content,
        };
    }

    async write(options: { dryRun?: boolean } = {}): Promise<WrittenFile | undefined> {
        const context = await this.generate();

        if (!context) {
            return undefined;
        }

        return this.deps.writer().write(context.outputPath, context.content, {
            source: RUNTIME_CONTEXT_SOURCE,
            origin: { plugin: this.deps.plugin },
            ...(options.dryRun ? { dryRun: true } : {}),
        });
    }

    /** The branch, or `undefined` when git cannot tell (not a repository, a detached head). */
    private async readBranch(gitRoot: string): Promise<string | undefined> {
        try {
            return await this.deps.git().currentBranch(gitRoot);
        } catch {
            return undefined;
        }
    }
}

function readIfExists(file: string): string | undefined {
    try {
        return fs.readFileSync(file, "utf8");
    } catch {
        return undefined;
    }
}

/** What the file says. */
export interface RuntimeContextFacts {
    branch: string;
    /** Whether the branch matched `branchPattern`. */
    matched: boolean;
    taskFile?: string;
    /** The task file's contents, when it exists. */
    taskContent?: string;
}

/**
 * The runtime context file's text, worded exactly as before the refactor.
 *
 * ```ts
 * renderRuntimeContext({ branch: "main", matched: false });
 * // "## Runtime Session Context\n\n...Current git branch: `main`\n\n### Current Task File\n\n\n"
 * ```
 */
export function renderRuntimeContext(facts: RuntimeContextFacts): string {
    const header = `## Runtime Session Context

The following information is specific to this chat session. It was generated automatically and
embedded into this AGENTS.md file in order to save you and the user some effort in setting up
to begin work.

### Environment Info

Current git branch: \`${facts.branch}\`

### Current Task File

`;

    let block = "";

    if (facts.matched && facts.taskFile !== undefined) {
        block =
            facts.taskContent === undefined
                ? `
Although we're currently on a feature branch that is tied to a Jira ticket, this branch does not,
yet, have a task file. It's likely that one of the first things we'll be doing in this session is
instantiating a task file, but be sure to ask before you do that.
`
                : `
We're currently on a feature branch that has an existing task file. The full contents of the task
file are included below:

--- Start Task File: ${facts.taskFile} ---
${facts.taskContent.replace(/\n+$/u, "")}
--- End Task File: ${facts.taskFile} ---
`;
    }

    return `${header}${block}\n`;
}
