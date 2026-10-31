import { IntentOutput, IntentOutputs, jsonSchema, SousError, type IntentDefinition } from "@sous-io/plugin-api";
import type { CommandTree } from "./command-tree.js";
import { globalSpecs } from "./globals.js";
import { HelpPage } from "./help-page.js";
import { suggest } from "./words.js";

/**
 * The `help` intent: `sous help [command...]` prints what `sous <command> --help` prints. Words
 * that match no command are an error with a "did you mean" hint. The page is a {@link HelpPage},
 * which the terminal reporter paints; its plain form is `{ text }`.
 */
export const helpIntent: IntentDefinition = {
    intent: "help",
    summary: "Print the help for sous, or for one command or topic",
    input: jsonSchema<{ command?: string[] }>({
        type: "object",
        properties: { command: { type: "array", items: { type: "string" }, description: "The command to show help for." } },
    }),
    cli: { positional: ["command"], examples: ["sous help repo add"] },
    parallel: true,
    runsWithoutConfig: true,
    handle: (rawInput, ctx) => {
        const input = rawInput as { command?: string[] };
        const tree = ctx.services.get("cli.commands") as CommandTree;
        const words = input.command ?? [];
        const { node, used } = tree.find(words);

        if (used < words.length) {
            const prefix = used > 0 ? `${words.slice(0, used).join(" ")} ` : "";
            const options = suggest(words[used]!, [...node.children.keys()]);

            throw new SousError(`There is no command "${prefix}${words[used]}".`, {
                exitCode: 2,
                details: options.length > 0 ? [`Did you mean ${options.map((option) => `"${prefix}${option}"`).join(" or ")}?`] : [],
            });
        }

        const page = new HelpPage(node, { appName: ctx.engine.app.name, globals: globalSpecs(ctx.entities.list("cli-global-argument")) });

        return new IntentOutputs(new IntentOutput({ result: page, data: { text: page.toText() } }));
    },
};
