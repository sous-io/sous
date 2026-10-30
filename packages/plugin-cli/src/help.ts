import type { Command, CommandNode } from "./command-tree.js";
import type { FlagSpec, PositionalSpec } from "./flags.js";
import type { GlobalSpec } from "./globals.js";

/** What help needs besides the node. */
export interface HelpContext {
    readonly appName: string;
    readonly appDescription?: string;
    readonly globals: readonly GlobalSpec[];
}

/**
 * The `--help` text for a command, a group, or the root (S1, "The CLI foundation"), laid out as the
 * CLI's help looked before the refactor: upper-case section titles, `$ sous ...` usage lines and
 * upper-case argument names. Each line of a command or flag describes exactly that thing
 * (about-cli-command-design, "Help Text").
 *
 * ```text
 * Add a recipe repository, which trusts it
 *
 * USAGE
 *   $ sous repo add URL [flags]
 *
 * ARGUMENTS
 *   URL  The repository's URL, or a path on this machine
 * ```
 */
export function renderHelp(node: CommandNode, context: HelpContext): string {
    const sections: string[] = [];
    const command = node.command;
    const path = command && node.viaAlias ? command.path : node.path;
    const words = [context.appName, ...path].join(" ");

    const about = command?.info.definition.description ?? command?.info.definition.summary ?? node.group?.description ?? node.group?.summary;

    if (about) {
        sections.push(about);
    } else if (node.path.length === 0 && context.appDescription) {
        sections.push(context.appDescription);
    }

    const children = visibleChildren(node);
    const usage: string[] = [];

    if (command) {
        usage.push(`$ ${words}${positionalUsage(command.positionals)}${command.flags.some((flag) => !flag.hidden) ? " [flags]" : ""}`);
    }

    if (children.length > 0) {
        usage.push(`$ ${words} COMMAND`);
    }

    sections.push(block("USAGE", usage));

    if (command && command.positionals.length > 0) {
        sections.push(table("ARGUMENTS", command.positionals.map((spec) => [argumentName(spec), positionalText(spec)])));
    }

    if (command) {
        const visible = command.flags.filter((flag) => !flag.hidden && !command.positionals.some((p) => p.field === flag.field));

        if (visible.length > 0) {
            sections.push(table("FLAGS", visible.map((flag) => [flagLabel(flag), flagText(flag)])));
        }
    }

    const topics = children.filter((child) => !child.command || child.viaAlias);
    const commands = children.filter((child) => child.command && !child.viaAlias);
    const listed = (child: CommandNode): [string, string] => [child.path.join(" "), summaryOf(child)];

    if (topics.length > 0) {
        sections.push(table("TOPICS", topics.map(listed)));
    }

    if (commands.length > 0) {
        sections.push(table("COMMANDS", commands.map(listed)));
    }

    if (command && command.aliases.length > 0) {
        sections.push(block("ALIASES", command.aliases.map((alias) => `$ ${[context.appName, ...alias].join(" ")}`)));
    }

    const examples = command?.info.definition.cli?.examples ?? [];

    if (examples.length > 0) {
        sections.push(block("EXAMPLES", examples.map((example) => (example.startsWith("$ ") ? example : `$ ${example}`))));
    }

    const globals = context.globals.filter((spec) => !spec.hidden);

    sections.push(
        table("GLOBAL FLAGS", [
            ...globals.map((spec): [string, string] => [globalLabel(spec), flagText(spec)]),
            ["-h, --help", "Show help for this command."],
            ...(node.path.length === 0 ? [["--version", `Print the version of ${context.appName}.`] as [string, string]] : []),
        ]),
    );

    return `${sections.join("\n\n")}\n`;
}

/** A positional argument's name as help and errors write it: `URL`, `REF`. */
export function argumentName(spec: PositionalSpec): string {
    return spec.name.toUpperCase().replaceAll("-", "_");
}

function visibleChildren(node: CommandNode): CommandNode[] {
    return [...node.children.values()]
        .filter((child) => child.canonical && !child.group?.hidden && !(child.command?.hidden && child.children.size === 0 && !child.group))
        .sort((a, b) => (a.path.at(-1)! < b.path.at(-1)! ? -1 : 1));
}

function summaryOf(node: CommandNode): string {
    if (node.group) {
        return node.group.summary;
    }

    if (node.command && !node.viaAlias) {
        return node.command.info.definition.summary ?? "";
    }

    const count = countCommands(node);

    return `${count} command${count === 1 ? "" : "s"}`;
}

function countCommands(node: CommandNode): number {
    let count = node.command && !node.viaAlias ? 1 : 0;

    for (const child of node.children.values()) {
        count += countCommands(child);
    }

    return count;
}

function positionalUsage(positionals: readonly PositionalSpec[]): string {
    return positionals
        .map((spec) => {
            const name = spec.variadic ? `${argumentName(spec)}...` : argumentName(spec);

            return spec.required ? ` ${name}` : ` [${name}]`;
        })
        .join("");
}

function positionalText(spec: PositionalSpec): string {
    return spec.description ?? "";
}

function flagLabel(flag: FlagSpec): string {
    const value = flag.kind === "boolean" ? "" : ` <${valueName(flag)}>`;
    const short = flag.short ? `-${flag.short}, ` : "";

    return `${short}--${flag.name}${value}`;
}

function globalLabel(spec: GlobalSpec): string {
    const value = spec.kind === "boolean" ? "" : ` <${spec.valueName}>`;
    const short = spec.short ? `-${spec.short}, ` : "";

    return `${short}--${spec.name}${value}`;
}

function valueName(flag: FlagSpec): string {
    switch (flag.kind) {
        case "number":
        case "integer":
            return "number";
        case "json":
            return "json";
        default:
            return flag.choices ? "choice" : "value";
    }
}

function flagText(flag: FlagSpec): string {
    const parts = [flag.description ?? ""];
    const others = [...flag.shorts.map((letter) => `-${letter}`), ...flag.aliases.map((alias) => `--${alias}`)];

    if (others.length > 0) {
        parts.push(`(also ${others.join(", ")})`);
    }

    if (flag.choices && flag.choices.length > 0) {
        parts.push(`One of: ${flag.choices.map(String).join(", ")}.`);
    }

    if (flag.required) {
        parts.push("Required.");
    } else if (flag.defaultValue !== undefined && !(flag.kind === "boolean" && flag.defaultValue === false)) {
        parts.push(`Default: ${JSON.stringify(flag.defaultValue)}.`);
    }

    if (flag.multiple) {
        parts.push("May be given more than once.");
    }

    return parts.filter((part) => part !== "").join(" ");
}

function block(title: string, lines: readonly string[]): string {
    return [title, ...lines.map((line) => `  ${line}`)].join("\n");
}

function table(title: string, rows: ReadonlyArray<readonly [string, string]>): string {
    const width = Math.min(32, Math.max(...rows.map(([left]) => left.length)));

    return [
        title,
        ...rows.map(([left, right]) => (right === "" ? `  ${left}` : left.length > width ? `  ${left}\n  ${" ".repeat(width)}  ${right}` : `  ${left.padEnd(width)}  ${right}`)),
    ].join("\n");
}

export type { Command };
