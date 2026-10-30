/**
 * The one check every token command's output passes: it exited `0` and
 * printed exactly one non-empty line holding no whitespace. Anything else (help text, a prompt, a
 * warning) is never taken as a token.
 */

/** What a token command gave back. */
export interface TokenCommandOutput {
    readonly exitCode: number | null;
    readonly stdout: string;
}

/**
 * The token a command printed, or `undefined` when its output fails the check.
 *
 * ```ts
 * tokenFromOutput({ exitCode: 0, stdout: "glpat-abc123\n" });          // "glpat-abc123"
 * tokenFromOutput({ exitCode: 0, stdout: "Usage: glab auth <cmd>\n" }); // undefined
 * ```
 */
export function tokenFromOutput(output: TokenCommandOutput): string | undefined {
    if (output.exitCode !== 0) {
        return undefined;
    }

    return singleWord(output.stdout);
}

/**
 * The text when it is exactly one non-empty line with no whitespace, a final newline allowed.
 *
 * ```ts
 * singleWord("abc\n");   // "abc"
 * singleWord("a b\n");   // undefined
 * singleWord("a\nb\n");  // undefined
 * ```
 */
export function singleWord(text: string): string | undefined {
    const body = text.replace(/\r?\n$/, "");

    if (body.length === 0 || /\s/.test(body)) {
        return undefined;
    }

    return body;
}
