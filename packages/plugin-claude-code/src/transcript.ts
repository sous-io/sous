/**
 * Reading the output of `claude -p --output-format stream-json --verbose`: one JSON object per line.
 *
 * - `{"type":"system","subtype":"init",...}` starts it.
 * - `{"type":"assistant","message":{"content":[{"type":"text"|"tool_use",...}]}}` is what Claude said and called.
 * - `{"type":"user","message":{"content":[{"type":"tool_result",...}]}}` is what the tools answered.
 * - `{"type":"result","result":"<final text>","is_error":false}` ends it.
 *
 * Lines that are not JSON, and kinds this does not know, are skipped: the format belongs to Claude Code.
 */

import type { TranscriptEntry } from "@sous-io/plugin-harnesses/types";

/** One parsed line of the stream. */
type StreamLine = Record<string, unknown>;

/** What a headless run keeps of the process, in `HeadlessRun.raw`. */
export interface ClaudeRaw {
    readonly stdout: string;
    readonly stderr: string;
}

/** Parses the lines of a stream, skipping any that are not JSON objects. */
export function parseStream(stdout: string): StreamLine[] {
    const lines: StreamLine[] = [];

    for (const text of stdout.split("\n")) {
        if (!text.trim().startsWith("{")) {
            continue;
        }

        try {
            const value: unknown = JSON.parse(text);

            if (value && typeof value === "object" && !Array.isArray(value)) {
                lines.push(value as StreamLine);
            }
        } catch {
            // Not JSON: skipped.
        }
    }

    return lines;
}

/** The content blocks of a line's message. A plain string becomes one text block. */
function blocksOf(line: StreamLine): Array<Record<string, unknown>> {
    const message = line.message;
    const content = message && typeof message === "object" ? (message as { content?: unknown }).content : undefined;

    if (typeof content === "string") {
        return [{ type: "text", text: content }];
    }

    return Array.isArray(content) ? content.filter((block): block is Record<string, unknown> => !!block && typeof block === "object") : [];
}

/** The text of a tool result, whose content is a string or a list of text blocks. */
function resultText(content: unknown): string {
    if (typeof content === "string") {
        return content;
    }

    if (Array.isArray(content)) {
        return content
            .map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : ""))
            .filter((text) => text !== "")
            .join("\n");
    }

    return "";
}

/** The final answer: the `result` line's text, else the last thing the assistant said. */
export function finalText(lines: readonly StreamLine[]): string {
    const result = [...lines].reverse().find((line) => line.type === "result");

    if (result && typeof result.result === "string") {
        return result.result;
    }

    for (const line of [...lines].reverse()) {
        if (line.type === "assistant") {
            const text = blocksOf(line)
                .filter((block) => block.type === "text" && typeof block.text === "string")
                .map((block) => block.text as string)
                .join("\n");

            if (text !== "") {
                return text;
            }
        }
    }

    return "";
}

/** Turns a stream into transcript entries. */
export function transcriptEntries(lines: readonly StreamLine[]): TranscriptEntry[] {
    const entries: TranscriptEntry[] = [];
    const toolNames = new Map<string, string>();

    for (const line of lines) {
        if (line.type === "system" && line.subtype === "init") {
            const model = typeof line.model === "string" ? ` (${line.model})` : "";

            entries.push({ role: "system", text: `Session started${model}` });
        } else if (line.type === "assistant") {
            for (const block of blocksOf(line)) {
                if (block.type === "text" && typeof block.text === "string") {
                    entries.push({ role: "assistant", text: block.text });
                } else if (block.type === "tool_use" && typeof block.name === "string") {
                    if (typeof block.id === "string") {
                        toolNames.set(block.id, block.name);
                    }

                    entries.push({ role: "assistant", text: "", tool: block.name, input: block.input });
                }
            }
        } else if (line.type === "user") {
            for (const block of blocksOf(line)) {
                if (block.type === "tool_result") {
                    const tool = typeof block.tool_use_id === "string" ? toolNames.get(block.tool_use_id) : undefined;

                    entries.push({ role: "tool", text: resultText(block.content), ...(tool === undefined ? {} : { tool }) });
                } else if (block.type === "text" && typeof block.text === "string") {
                    entries.push({ role: "user", text: block.text });
                }
            }
        }
    }

    return entries;
}
