import type { IntentOutputs } from "@sous-io/plugin-api";
import type { InputStream } from "./io.js";

/** The line watch mode shows under its output, as before the refactor. */
export const WATCH_KEYS_HINT = "[ Press Q to quit  |  any other key: rebuild ]";

/** What the keys do. */
export interface WatchKeyActions {
    /** Q, q or Ctrl+C. */
    quit(): void;
    /** Any other key. */
    rebuild(): void;
}

/**
 * Reads single keys from a terminal while watch mode runs: Q (or Ctrl+C, which raw mode turns into
 * a key) quits, and any other key rebuilds. Does nothing when standard input is not a terminal.
 * Returns a function that puts the terminal back.
 */
export function listenForWatchKeys(stdin: InputStream, actions: WatchKeyActions): () => void {
    const terminal = stdin as InputStream & { setRawMode?: (on: boolean) => unknown; setEncoding?: (encoding: BufferEncoding) => unknown };

    if (stdin.isTTY !== true) {
        return () => {};
    }

    const onData = (chunk: string | Buffer) => {
        const key = String(chunk);

        if (key === "q" || key === "Q" || key === "\u0003") {
            actions.quit();
        } else {
            actions.rebuild();
        }
    };

    terminal.setRawMode?.(true);
    terminal.setEncoding?.("utf8");
    stdin.on("data", onData);
    stdin.resume();

    let stopped = false;

    return () => {
        if (stopped) {
            return;
        }

        stopped = true;
        stdin.off("data", onData);
        terminal.setRawMode?.(false);
        stdin.pause();
    };
}

/** Whether an intent's outputs say watch mode started (`build --watch`, `compile --watch`): the plain result has `watching: true`. */
export function startedWatching(outputs: IntentOutputs<object>): boolean {
    return (outputs.toPlain() as { watching?: unknown }).watching === true;
}
