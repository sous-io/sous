/**
 * Counting an output's tokens (`o200k_base`), for the line each written output reports. The
 * encoder loads on first use and is freed when the compile ends.
 */

import type { Tiktoken } from "tiktoken";

/** A token counter, and how to free it. */
export interface TokenCounter {
    count(text: string): number;
    free(): void;
}

/** Makes a counter; its encoder loads on the first count. */
export async function createTokenCounter(): Promise<TokenCounter> {
    const { get_encoding } = await import("tiktoken");
    let encoder: Tiktoken | undefined;

    return {
        count(text) {
            encoder ??= get_encoding("o200k_base");

            return encoder.encode(text).length;
        },
        free() {
            encoder?.free();
            encoder = undefined;
        },
    };
}
