/**
 * Counting an output's tokens (`o200k_base`), for the line each written output reports. The
 * encoder loads on first use and is kept for the rest of the process.
 */

import type { Tiktoken } from "tiktoken";

/** A token counter, and how to free it. */
export interface TokenCounter {
    count(text: string): number;
    free(): void;
}

/**
 * The o200k_base encoder, loaded once per process: loading it takes about half a second, which a
 * long-running front end (sous serve, the MCP server) would otherwise pay on every compile.
 */
let shared: Tiktoken | undefined;

export async function createTokenCounter(): Promise<TokenCounter> {
    const { get_encoding } = await import("tiktoken");

    return {
        count(text) {
            shared ??= get_encoding("o200k_base");

            return shared.encode(text).length;
        },
        // The encoder is shared by every counter and lives as long as the process.
        free() {},
    };
}
