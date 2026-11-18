/**
 * The notice every other command prints when migrations are pending (spec 19, 7-a): one line,
 * once per command, saying they exist and to run `sous doctor`, and the command carries on. It
 * goes through the chain's reporter, which writes messages to standard error under `--json`, so
 * the JSON on standard output stays clean.
 */

import type { Context, IntentBeforeEvent } from "@sous-io/plugin-api";
import type { MigrationsService } from "./types.js";

/**
 * The commands that print no notice: the ones that run migrations or upgrade sous (they deal with
 * them), and the ones that show something about sous rather than work on the project.
 */
export const QUIET_INTENTS: ReadonlySet<string> = new Set(["doctor", "migrations.run", "upgrade", "help", "version", "completion", "completion.words", "mcp.serve"]);

/** The notice, for a number of pending migrations. */
export function noticeText(count: number): string {
    return `${count === 1 ? "A migration" : `${count} migrations`} from a newer version of sous ${count === 1 ? "is" : "are"} waiting to run in this project. Run 'sous doctor' to run ${count === 1 ? "it" : "them"}.`;
}

/**
 * Makes the `*.before` listener. It speaks only for the intent a chain was started with, once per
 * chain, never for an intent another one runs. Anything that goes wrong while looking (no
 * lockfile service, a lockfile that does not parse) is left to the command, which reports it in
 * its own words.
 */
export function pendingNotice(): (event: IntentBeforeEvent, ctx: Context) => void {
    const spoken = new Set<number>();

    return (event, ctx) => {
        const chain = ctx.chain;

        if (chain === undefined || chain.intent !== event.intent || spoken.has(chain.id) || QUIET_INTENTS.has(event.intent)) {
            return;
        }

        spoken.add(chain.id);

        if (ctx.project === undefined || !ctx.services.has("migrations")) {
            return;
        }

        let count = 0;

        try {
            count = (ctx.services.get("migrations") as MigrationsService).pending().length;
        } catch {
            return;
        }

        if (count > 0) {
            ctx.reporter.notice(noticeText(count));
        }
    };
}
