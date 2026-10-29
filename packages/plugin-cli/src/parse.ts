import { parseArgs, type ParseArgsConfig } from "node:util";
import type { Command, CommandNode, CommandTree } from "./command-tree.js";
import { convertValue, type FlagSpec } from "./flags.js";
import type { GlobalSpec } from "./globals.js";
import { suggest } from "./words.js";

/** What a command line asks for. */
export type ParsedLine =
    | { kind: "help"; node: CommandNode; globals: Record<string, unknown> }
    | { kind: "version"; globals: Record<string, unknown> }
    | { kind: "run"; command: Command; input: Record<string, unknown>; globals: Record<string, unknown> }
    | { kind: "error"; message: string; details: string[]; node: CommandNode; globals: Record<string, unknown> };

/**
 * Turns argv into a command and its input (S1, "The CLI foundation"), on Node's `util.parseArgs`:
 * command words first (global flags may come before them), then the command's flags and positional
 * arguments. `--help` anywhere shows help for the words given so far.
 */
export function parseLine(argv: readonly string[], tree: CommandTree, globalSpecs: readonly GlobalSpec[], appName = "sous"): ParsedLine {
    const globalsByToken = tokenMap(globalSpecs);
    const words: string[] = [];
    const rest: string[] = [];
    let node = tree.root;
    let index = 0;

    for (; index < argv.length; index++) {
        const token = argv[index]!;

        if (token === "--") {
            break;
        }

        if (token.startsWith("-")) {
            const spec = globalsByToken.get(token.split("=")[0]!);

            rest.push(token);

            if (spec && spec.kind !== "boolean" && !token.includes("=") && index + 1 < argv.length) {
                rest.push(argv[++index]!);
            }

            continue;
        }

        const next = node.children.get(token);

        if (!next) {
            break;
        }

        node = next;
        words.push(token);
    }

    rest.push(...argv.slice(index));

    const command = node.command;
    const flags = command ? mergeFlags(command.flags, globalSpecs) : [...globalSpecs];
    const parsed = runParseArgs(rest, flags);
    const globals = collectValues(globalSpecs, parsed.values);

    if (parsed.error) {
        return { kind: "error", message: parsed.error, details: [], node, globals: globals.values };
    }

    if (globals.error) {
        return { kind: "error", message: globals.error, details: [], node, globals: globals.values };
    }

    if (parsed.values.help === true) {
        return { kind: "help", node, globals: globals.values };
    }

    if (parsed.values.version === true && node === tree.root) {
        return { kind: "version", globals: globals.values };
    }

    if (!command) {
        const typed = parsed.positionals[0];

        if (typed === undefined) {
            return { kind: "help", node, globals: globals.values };
        }

        const prefix = node.path.length > 0 ? `${node.path.join(" ")} ` : "";
        const options = suggest(typed, [...node.children.keys()]);

        return {
            kind: "error",
            message: `There is no command "${prefix}${typed}".`,
            details: options.length > 0 ? [`Did you mean ${options.map((option) => `"${prefix}${option}"`).join(" or ")}?`] : [],
            node,
            globals: globals.values,
        };
    }

    const input = collectValues(command.flags, parsed.values);

    if (input.error) {
        return { kind: "error", message: input.error, details: [], node, globals: globals.values };
    }

    const positional = assignPositionals(command, parsed.positionals, input.values, appName);

    if (positional.error) {
        const options = node.children.size > 0 ? suggest(parsed.positionals[0] ?? "", [...node.children.keys()]) : [];

        return {
            kind: "error",
            message: positional.error,
            details: options.length > 0 ? [`Did you mean "${[...node.path, options[0]].join(" ")}"?`] : [],
            node,
            globals: globals.values,
        };
    }

    return { kind: "run", command, input: input.values, globals: globals.values };
}

function tokenMap(specs: readonly FlagSpec[]): Map<string, FlagSpec> {
    const map = new Map<string, FlagSpec>();

    for (const spec of specs) {
        map.set(`--${spec.name}`, spec);

        if (spec.kind === "boolean") {
            map.set(`--no-${spec.name}`, spec);
        }

        if (spec.short) {
            map.set(`-${spec.short}`, spec);
        }
    }

    return map;
}

function mergeFlags(own: readonly FlagSpec[], globals: readonly FlagSpec[]): FlagSpec[] {
    const names = new Set(own.flatMap((flag) => [flag.name, ...flag.aliases]));

    return [...own, ...globals.filter((flag) => !names.has(flag.name))];
}

interface RawParse {
    values: Record<string, unknown>;
    positionals: string[];
    error?: string;
}

function runParseArgs(args: string[], flags: readonly FlagSpec[]): RawParse {
    const options: NonNullable<ParseArgsConfig["options"]> = {
        help: { type: "boolean", short: "h" },
        version: { type: "boolean" },
    };

    for (const flag of flags) {
        const option = {
            type: flag.kind === "boolean" ? ("boolean" as const) : ("string" as const),
            multiple: flag.multiple,
            ...(flag.short ? { short: flag.short } : {}),
        };

        options[flag.name] = option;

        for (const alias of flag.aliases) {
            options[alias] = { type: option.type, multiple: option.multiple };
        }
    }

    try {
        const { values, positionals } = parseArgs({ args, options, strict: true, allowPositionals: true, allowNegative: true });

        for (const flag of flags) {
            for (const alias of flag.aliases) {
                if (values[alias] !== undefined && values[flag.name] === undefined) {
                    values[flag.name] = values[alias];
                }
            }
        }

        return { values: values as Record<string, unknown>, positionals };
    } catch (error) {
        return { values: {}, positionals: [], error: describeParseError(error, flags) };
    }
}

function describeParseError(error: unknown, flags: readonly FlagSpec[]): string {
    const message = error instanceof Error ? error.message : String(error);
    const unknown = /Unknown option '(-{1,2}[^']+)'/.exec(message)?.[1];

    if (unknown) {
        const names = flags.flatMap((flag) => [`--${flag.name}`, ...flag.aliases.map((alias) => `--${alias}`)]);
        const options = suggest(unknown, [...names, "--help"]);
        const hint = options.length > 0 ? ` Did you mean ${options.join(" or ")}?` : "";

        return `There is no flag ${unknown}.${hint}`;
    }

    const missingValue = /Option '(-{1,2}[^' ]+)(?: [^']*)?' argument missing/.exec(message)?.[1];

    if (missingValue) {
        return `${missingValue} needs a value.`;
    }

    return message.replace(/\. To specify a positional argument.*$/, ".");
}

function collectValues(specs: readonly FlagSpec[], values: Record<string, unknown>): { values: Record<string, unknown>; error?: string } {
    const out: Record<string, unknown> = {};

    for (const spec of specs) {
        const raw = values[spec.name];

        if (raw === undefined) {
            continue;
        }

        if (spec.kind === "boolean") {
            out[spec.field] = raw;
            continue;
        }

        const items = Array.isArray(raw) ? raw : [raw];
        const converted: unknown[] = [];

        for (const item of items) {
            const result = convertValue(String(item), spec.kind, `--${spec.name}`);

            if ("error" in result) {
                return { values: out, error: result.error };
            }

            converted.push(result.value);
        }

        out[spec.field] = spec.multiple ? converted : converted[0];
    }

    return { values: out };
}

function assignPositionals(command: Command, positionals: readonly string[], input: Record<string, unknown>, appName: string): { error?: string } {
    let index = 0;

    for (const spec of command.positionals) {
        if (index >= positionals.length) {
            break;
        }

        const taken = spec.variadic ? positionals.slice(index) : [positionals[index]!];
        const converted: unknown[] = [];

        for (const raw of taken) {
            const result = convertValue(raw, spec.kind, `<${spec.name}>`);

            if ("error" in result) {
                return { error: result.error };
            }

            converted.push(result.value);
        }

        if (input[spec.field] !== undefined) {
            return { error: `<${spec.name}> was given both as an argument and as --${spec.name}.` };
        }

        input[spec.field] = spec.variadic ? converted : converted[0];
        index += taken.length;
    }

    if (index < positionals.length) {
        const extra = positionals[index]!;
        const words = [appName, ...command.path].join(" ");

        return { error: `"${words}" takes ${command.positionals.length === 0 ? "no arguments" : `at most ${command.positionals.length} argument${command.positionals.length === 1 ? "" : "s"}`}, but was also given "${extra}".` };
    }

    return {};
}
