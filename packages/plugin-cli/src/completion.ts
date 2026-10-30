import { jsonSchema, type IntentDefinition } from "@sous-io/plugin-api";
import type { CommandNode, CommandTree } from "./command-tree.js";
import { globalSpecs } from "./globals.js";

/** The shells `sous completion` writes a script for. */
export const COMPLETION_SHELLS = ["bash", "zsh", "fish"] as const;

/** One of {@link COMPLETION_SHELLS}. */
export type CompletionShell = (typeof COMPLETION_SHELLS)[number];

/** The hidden command the scripts call to list the words that may come next. */
export const COMPLETE_COMMAND = "__complete";

/**
 * The words that may follow `words` on a command line: the subcommands of the command they name, or,
 * when the last word starts with `-`, its flags and the global flags. Reads only the command tree,
 * as `--help` does, so no command's code loads.
 *
 * ```ts
 * completeWords(tree, ["repo", ""], []);       // -> ["add", "list", ...]
 * completeWords(tree, ["repo", "add", "--d"], globals); // -> ["--dry-run", "--debug"]
 * ```
 *
 * @param words - The words typed after the app name, the last one being the word being completed
 *   (`""` when the cursor follows a space).
 */
export function completeWords(tree: CommandTree, words: readonly string[], globalNames: readonly string[]): string[] {
    const typed = words.at(-1) ?? "";
    let node: CommandNode = tree.root;

    for (const word of words.slice(0, -1)) {
        if (word.startsWith("-")) {
            continue;
        }

        const next = node.children.get(word);

        if (!next) {
            break;
        }

        node = next;
    }

    const candidates = typed.startsWith("-")
        ? [
              ...(node.command?.flags ?? []).filter((flag) => !flag.hidden).flatMap((flag) => [`--${flag.name}`, ...flag.aliases.map((alias) => `--${alias}`)]),
              ...globalNames.map((name) => `--${name}`),
              "--help",
          ]
        : [...node.children.values()].filter((child) => child.canonical && !child.group?.hidden && !child.command?.hidden).map((child) => child.path.at(-1)!);

    return [...new Set(candidates)].filter((word) => word.startsWith(typed)).sort();
}

/** The completion script for one shell; each calls `<app> __complete <words...>`. */
export function completionScript(shell: CompletionShell, appName: string): string {
    const fn = `_${appName.replace(/[^A-Za-z0-9_]/g, "_")}_complete`;

    switch (shell) {
        case "bash":
            return [
                `# ${appName} completion for bash. Add to ~/.bashrc:  eval "$(${appName} completion bash)"`,
                `${fn}() {`,
                `    local IFS=$'\\n'`,
                `    COMPREPLY=($(${appName} ${COMPLETE_COMMAND} "\${COMP_WORDS[@]:1:COMP_CWORD}" 2>/dev/null))`,
                `}`,
                `complete -o default -F ${fn} ${appName}`,
                ``,
            ].join("\n");
        case "zsh":
            return [
                `# ${appName} completion for zsh. Add to ~/.zshrc:  eval "$(${appName} completion zsh)"`,
                `${fn}() {`,
                `    local -a words_next`,
                `    words_next=("\${(@f)$(${appName} ${COMPLETE_COMMAND} "\${(@)words[2,CURRENT]}" 2>/dev/null)}")`,
                `    compadd -a words_next`,
                `}`,
                `compdef ${fn} ${appName}`,
                ``,
            ].join("\n");
        case "fish":
            return [
                `# ${appName} completion for fish. Add to ~/.config/fish/config.fish:  ${appName} completion fish | source`,
                `function ${fn}`,
                `    set -l words (commandline -opc) (commandline -ct)`,
                `    ${appName} ${COMPLETE_COMMAND} $words[2..-1] 2>/dev/null`,
                `end`,
                `complete -c ${appName} -f -a '(${fn})'`,
                ``,
            ].join("\n");
    }
}

/** `sous completion <shell>`: prints the shell completion script. */
export const completionIntent: IntentDefinition = {
    intent: "completion",
    summary: "Print a shell completion script",
    description: "Print a shell completion script for bash, zsh or fish",
    input: jsonSchema<{ shell: CompletionShell }>({
        type: "object",
        properties: { shell: { type: "string", enum: [...COMPLETION_SHELLS], description: "The shell to write the script for" } },
        required: ["shell"],
    }),
    cli: { positional: ["shell"], examples: ['eval "$(sous completion bash)"', "sous completion fish | source"] },
    parallel: true,
    handle: (rawInput, ctx) => completionScript((rawInput as { shell: CompletionShell }).shell, ctx.engine.app.name),
};

/** The hidden `sous __complete <words...>`, which the scripts call: one word per line. */
export const completeIntent: IntentDefinition = {
    intent: "completion.words",
    summary: "List the words that may come next on a command line",
    input: jsonSchema<{ words?: string[] }>({
        type: "object",
        properties: { words: { type: "array", items: { type: "string" }, description: "The words typed so far, the last one being completed" } },
    }),
    cli: { command: [COMPLETE_COMMAND], positional: ["words"], hidden: true },
    parallel: true,
    handle: (rawInput, ctx) => {
        const tree = ctx.services.get("cli.commands") as CommandTree;
        const globals = globalSpecs(ctx.entities.list("cli-global-argument")).filter((spec) => !spec.hidden);
        const words = completeWords(tree, (rawInput as { words?: string[] }).words ?? [""], globals.map((spec) => spec.name));

        return words.length > 0 ? `${words.join("\n")}\n` : "";
    },
};
