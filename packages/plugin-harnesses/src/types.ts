/**
 * The contract of plugin-harnesses (S6, "Harnesses: plugin-harnesses"): the `harness` entity (one
 * per tool, with `launch`, `runHeadless` and `readTranscript` each optional; ruled 2026-10-29),
 * launching a harness after a build, headless runs, and the `tools` settings, for which the
 * `harnesses.tools` contributor adds a `harness` entity per tool no plugin provides (C41, C56).
 *
 * Other plugins import this file type-only.
 */

import type { Context } from "@sous-io/plugin-api";
import type { BuildResult } from "@sous-io/plugin-build/types";

/** How an interactive session ended. */
export interface HarnessLaunchResult {
    readonly exitCode: number | null;
    readonly signal: string | null;
    readonly durationMs: number;
}

/** One headless run to start. */
export interface HeadlessRequest {
    /** The prompt. */
    prompt: string;
    /** The directory it runs in. Default: the project root. */
    cwd?: string;
    /** A model, when the harness lets one be chosen. */
    model?: string;
    /** Stops it after this long. */
    timeoutMs?: number;
    signal?: AbortSignal;
    /** Anything harness-specific, passed through. */
    options?: Readonly<Record<string, unknown>>;
}

/** What a headless run gave. `raw` is the harness's own result, for its `readTranscript`. */
export interface HeadlessRun {
    readonly harness: string;
    readonly exitCode: number | null;
    /** The final text it answered with. */
    readonly output: string;
    readonly durationMs: number;
    readonly raw?: unknown;
}

/** Who said one transcript entry. */
export type TranscriptRole = "system" | "user" | "assistant" | "tool";

/** One entry of a transcript. */
export interface TranscriptEntry {
    readonly role: TranscriptRole;
    readonly text: string;
    /** The tool called or answering, for `tool` entries and assistant tool calls. */
    readonly tool?: string;
    /** The tool call's input, as JSON. */
    readonly input?: unknown;
    readonly at?: string;
}

/** A headless run's transcript. */
export interface Transcript {
    readonly harness: string;
    readonly entries: readonly TranscriptEntry[];
}

/**
 * A `harness` entity: the program that wraps a model, used interactively, headless, or both (C41).
 * Anything that depends on the config, such as a user's launch arguments, is read by the method when
 * it runs (`ctx.config.get("tools.<id>")`).
 */
export interface HarnessEntity {
    /** `claude`, `codex`; what `sous launch <id>` names. */
    id: string;
    /** What it is, for `--help` and errors. */
    description?: string;
    /** Starts an interactive session with more arguments, sharing the terminal. */
    launch?(args: readonly string[], ctx: Context): Promise<HarnessLaunchResult>;
    /** Runs it with no person at the keyboard. */
    runHeadless?(request: HeadlessRequest, ctx: Context): Promise<HeadlessRun>;
    /** Reads a headless run's transcript. */
    readTranscript?(run: HeadlessRun, ctx: Context): Transcript | Promise<Transcript>;
}

/** One tool under the `tools` config key: launchable with no plugin (C56). */
export interface ToolSettings {
    /** The command. */
    command: string;
    /** Arguments always passed, before the user's. */
    args?: string[];
    /** A file whose content is passed as the last argument. */
    promptFile?: string;
    /** The command and arguments for a headless run; the prompt is appended. */
    headless?: { command?: string; args?: string[] };
}

/** `launch`: builds, then starts a harness. */
export interface LaunchInput {
    /** The harness id, then any arguments passed through to it (`sous launch claude -- -c`). */
    tool: string[];
    /** Skips the build first. */
    noBuild?: boolean;
    /** Starts the harness again whenever it exits. */
    continuous?: boolean;
}

/** The result of `launch`. */
export interface LaunchResult {
    readonly harness: string;
    /** How the last session ended. */
    readonly last: HarnessLaunchResult;
    /** How many sessions ran (more than one with `continuous`). */
    readonly sessions: number;
    /** The build's result, unless `noBuild`. */
    readonly build?: BuildResult;
}

/** `harness.run-headless`. */
export interface RunHeadlessInput {
    /** The harness id. Default: the only harness with `runHeadless`, else an error listing them. */
    harness?: string;
    prompt: string;
    cwd?: string;
    model?: string;
    timeoutMs?: number;
    /** Also reads the transcript. */
    transcript?: boolean;
}

/** The result of `harness.run-headless`. */
export interface RunHeadlessResult {
    readonly run: HeadlessRun;
    readonly transcript?: Transcript;
}

/** The payload of `harnesses.launched`: a session is about to start. */
export interface HarnessesLaunchedPayload {
    readonly harness: string;
    readonly args: readonly string[];
    /** Counts sessions of one `launch`, from 1. */
    readonly session: number;
}

declare module "@sous-io/plugin-api" {
    interface SousIntents {
        launch: { input: LaunchInput; result: LaunchResult };
        "harness.run-headless": { input: RunHeadlessInput; result: RunHeadlessResult };
    }

    interface SousEvents {
        "harnesses.launched": HarnessesLaunchedPayload;
    }

    interface SousEntities {
        /** A harness: a program that wraps a model. */
        harness: HarnessEntity;
    }

    interface SousConfig {
        tools: Record<string, ToolSettings>;
    }
}
