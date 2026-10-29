import { ConflictError, type IntentInfo, toJsonSchema } from "@sous-io/plugin-api";
import { argumentsFromSchema, type CommandArguments } from "./flags.js";
import type { CliGroupEntity } from "./types.js";

/** One command: an intent, as the CLI runs it. */
export interface Command extends CommandArguments {
    readonly intent: string;
    readonly plugin: string;
    readonly info: IntentInfo;
    /** The command words. */
    readonly path: readonly string[];
    /** Other command words that run it. */
    readonly aliases: ReadonlyArray<readonly string[]>;
    readonly hidden: boolean;
}

/** One node of the tree: a word, which may be a command, a group, or both. */
export interface CommandNode {
    readonly path: readonly string[];
    readonly children: Map<string, CommandNode>;
    /** The command these words run, if any. */
    command: Command | undefined;
    /** Whether the command here is reached through an alias. */
    viaAlias: boolean;
    /** The group's help, from a `cli-group` entity. */
    group: CliGroupEntity | undefined;
    /** Whether any command below (or here) is reached by its own words, not an alias. */
    canonical: boolean;
}

/** What the config picks when two commands claim the same words: `cli.pick."<words>": "<plugin>"`. */
export type CommandPicks = Readonly<Record<string, string>>;

/**
 * The command tree (S6, `cli.commands`): every intent the CLI shows, by its words and its aliases,
 * with group help. Built once per config; `--help` reads it without loading any handler (G9).
 */
export class CommandTree {
    readonly root: CommandNode = newNode([]);
    /** Warnings about picks the config made between clashing commands. */
    readonly warnings: string[] = [];

    /** Builds the tree. Two intents claiming the same words is a `ConflictError` naming both plugins. */
    static build(intents: readonly IntentInfo[], groups: readonly CliGroupEntity[], picks: CommandPicks = {}): CommandTree {
        const tree = new CommandTree();
        const claims = new Map<string, Array<{ command: Command; viaAlias: boolean }>>();

        for (const info of intents) {
            const definition = info.definition;

            if (definition.internal) {
                continue;
            }

            const cli = definition.cli ?? {};
            const path = cli.command ?? definition.intent.split(".");
            const command: Command = {
                intent: definition.intent,
                plugin: info.plugin,
                info,
                path,
                aliases: cli.aliases ?? [],
                hidden: cli.hidden ?? false,
                ...argumentsFromSchema(toJsonSchema(definition.input), cli),
            };

            for (const [words, viaAlias] of [[path, false] as const, ...command.aliases.map((alias) => [alias, true] as const)]) {
                const key = words.join(" ");
                const list = claims.get(key) ?? [];

                list.push({ command, viaAlias });
                claims.set(key, list);
            }
        }

        for (const [key, list] of claims) {
            const winner = tree.pick(key, list, picks);
            const node = tree.ensure(key.split(" "));

            node.command = winner.command;
            node.viaAlias = winner.viaAlias;
        }

        for (const group of groups) {
            tree.ensure(group.command).group = group;
        }

        markCanonical(tree.root);

        return tree;
    }

    /** The deepest node the words reach, and how many words it used. */
    find(words: readonly string[]): { node: CommandNode; used: number } {
        let node = this.root;
        let used = 0;

        for (const word of words) {
            const next = node.children.get(word);

            if (!next) {
                break;
            }

            node = next;
            used += 1;
        }

        return { node, used };
    }

    /** Every command, once each, by its own words. */
    commands(): Command[] {
        const found = new Set<Command>();
        const visit = (node: CommandNode): void => {
            if (node.command && !node.viaAlias) {
                found.add(node.command);
            }

            node.children.forEach(visit);
        };

        visit(this.root);

        return [...found];
    }

    private pick(key: string, list: Array<{ command: Command; viaAlias: boolean }>, picks: CommandPicks): { command: Command; viaAlias: boolean } {
        const distinct = list.filter((claim, index) => list.findIndex((other) => other.command === claim.command) === index);

        if (distinct.length === 1) {
            return distinct[0]!;
        }

        const plugins = distinct.map((claim) => claim.command.plugin);
        const described = distinct.map((claim) => `intent "${claim.command.intent}" (${claim.command.plugin})`).join(" and ");
        const picked = picks[key];
        const chosen = distinct.find((claim) => claim.command.plugin === picked);

        if (!chosen) {
            throw new ConflictError(`cli:${key}`, plugins, `Two commands claim "${key}": ${described}.`, {
                details: [`Choose one in the config:  cli.pick."${key}": "${plugins[0]}"`],
            });
        }

        const others = distinct.filter((claim) => claim !== chosen).map((claim) => claim.command.plugin).join(" and ");

        this.warnings.push(`cli.pick picks ${chosen.command.plugin} for "${key}". ${others}'s command is ignored there, and may not work as expected.`);

        return chosen;
    }

    private ensure(words: readonly string[]): CommandNode {
        let node = this.root;

        for (const word of words) {
            let next = node.children.get(word);

            if (!next) {
                next = newNode([...node.path, word]);
                node.children.set(word, next);
            }

            node = next;
        }

        return node;
    }
}

function newNode(path: readonly string[]): CommandNode {
    return { path, children: new Map(), command: undefined, viaAlias: false, group: undefined, canonical: false };
}

function markCanonical(node: CommandNode): boolean {
    let canonical = node.command !== undefined && !node.viaAlias;

    for (const child of node.children.values()) {
        canonical = markCanonical(child) || canonical;
    }

    node.canonical = canonical || node.group !== undefined;

    return node.canonical;
}
