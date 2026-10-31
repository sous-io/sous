import type { IntentOutputs, Reporter } from "@sous-io/plugin-api";
import type { OutputStream } from "../io.js";

/** What showing a command's outputs needs. */
export interface ShowOptions {
    /** Shows the outputs when `json` is off. */
    readonly reporter: Reporter;
    /** Where `--json` prints the result. */
    readonly stdout: OutputStream;
    /** Whether `--json` was given. */
    readonly json: boolean;
}

/**
 * Shows what an intent returned: under `--json`, the last output's plain object on standard output;
 * otherwise through the reporter, which sends it to standard output.
 */
export function showOutputs(outputs: IntentOutputs<object>, options: ShowOptions): void {
    if (options.json) {
        options.stdout.write(`${JSON.stringify(outputs.toPlain(), null, 2)}\n`);

        return;
    }

    if (outputs.length > 0) {
        options.reporter.result(outputs);
    }
}
