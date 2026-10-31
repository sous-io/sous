/**
 * Runs one intent in this process, against a real project, with every built-in plugin and a
 * prompter that answers from a function. For the few tests that need a terminal to be asked on,
 * which a spawned bin never has.
 *
 * ```ts
 * const run = await runInProcess(projectRoot, { SOUS_HOME: sousHome }, "subscription.add", { ref: "workflow/x" }, (message) => message.startsWith("Subscribe"));
 * // run.printed holds every message the chain reported, then the text of the intent's outputs; run.error the error it failed with, if any
 * ```
 */

import { createEngine } from "@sous-io/core";
import { createReporter, type IntentOutputs, messageText, ReportEntryStyle, type Prompter, type Reporter } from "@sous-io/plugin-api";
import { BUILT_IN_PLUGINS } from "../../src/built-ins.js";
import { sousVersion } from "../../src/main.js";
import { findProject } from "../../src/project.js";

/** What one in-process run did. */
export interface InProcessRun {
    /** Every message the chain reported, in order, then the text of the outputs the intent returned. */
    readonly printed: string[];
    /** Every question it asked, in order. */
    readonly asked: string[];
    /** The intent's result, when it succeeded. */
    readonly result?: IntentOutputs;
    /** The error it failed with, when it failed. */
    readonly error?: Error;
}

/**
 * Runs `intent` with `input` in the project at `projectRoot`. Every yes-or-no question is answered
 * by `confirm`; any other question fails, as it would with nobody to answer it.
 */
export async function runInProcess(
    projectRoot: string,
    env: Readonly<Record<string, string | undefined>>,
    intent: string,
    input: Record<string, unknown>,
    confirm: (message: string) => boolean,
): Promise<InProcessRun> {
    const printed: string[] = [];
    const asked: string[] = [];
    const reporter: Reporter = createReporter((_level, message, _details, style) => {
        if (style !== ReportEntryStyle.Progress) {
            printed.push(messageText(message));
        }
    });
    const prompter: Prompter = {
        interactive: true,
        askValue: (question) => Promise.reject(new Error(`unexpected question: ${question.message}`)),
        askChoice: (question) => Promise.reject(new Error(`unexpected question: ${question.message}`)),
        confirm: (question) => {
            asked.push(question.message);

            return Promise.resolve(confirm(question.message));
        },
    };
    const engine = createEngine({
        project: findProject(projectRoot),
        env: { ...process.env, ...env, SOUS_BUDGETS: "off" },
        cwd: projectRoot,
        app: { name: "sous", version: sousVersion() },
        builtIns: BUILT_IN_PLUGINS,
        reporter,
        locateProject: (directory) => findProject(directory),
    });

    await engine.buildConfig();

    try {
        const result = await engine.submit({ intent, input }, { reporter, prompter, cwd: projectRoot });

        // A command's result is returned, not reported; its text is what the command shows, so it counts as printed.
        printed.push(result.toText());

        return { printed, asked, result };
    } catch (error) {
        return { printed, asked, error: error instanceof Error ? error : new Error(String(error)) };
    }
}
