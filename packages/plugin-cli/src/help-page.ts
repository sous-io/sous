import { Payload, type PlainObject } from "@sous-io/plugin-api";
import type { CommandNode } from "./command-tree.js";
import { type HelpContext, renderHelp } from "./help.js";
import type { Style } from "./views/style.js";

/**
 * A help page as an output's result. It holds the command node and what help needs, so the
 * terminal reporter draws it with the colors of the stream it goes to, while `toText()` and
 * `toPlain()` give the same page without colors for `--json`, MCP and a calling intent.
 */
export class HelpPage extends Payload {
    readonly kind = "help-page";

    constructor(
        readonly node: CommandNode,
        readonly context: Omit<HelpContext, "style">,
    ) {
        super();
    }

    /** The page painted with `style`. */
    render(style: Style): string {
        return renderHelp(this.node, { ...this.context, style });
    }

    toText(): string {
        return renderHelp(this.node, this.context);
    }

    toPlain(): PlainObject {
        return { text: this.toText() };
    }
}
