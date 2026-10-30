import { parseArgs, type ParseArgsConfig } from "node:util";
import type { Command, CommandNode, CommandTree } from "./command-tree.js";
import { convertValue, type FlagSpec } from "./flags.js";
import type { GlobalSpec } from "./globals.js";
import { suggest } from "./words.js";

/** What a command line asks for. */
export type ParsedLine =
    | { kind: "help"; node: CommandNode; globals: Record<string, unknown> }
    | { kind: "version"; globals: Record<string, unknown> }
    | { kind: "run"; command: Command; node: CommandNode; input: Record<string, unknown>; globals: Record<string, unknown> }
    | {
          kind: "error";
          message: string;
          details: string[];
          node: CommandNode;
          globals: Record<string, unknown>;
          /** True when the command's help should follow the message: the command was found, but not its flags or arguments. */
          showHelp?: boolean;
      };

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
    const passThrough = command?.info.definition.cli?.passThrough === true ? splitPassThrough(rest, flags) : undefined;
    const parsed = runParseArgs(passThrough?.own ?? rest, flags);

    if (passThrough) {
        parsed.positionals = passThrough.passed;
    }
    const globals = collectValues(globalSpecs, parsed.values);

    if (parsed.error) {
        return { kind: "error", message: parsed.error.message, details: parsed.error.details, node, globals: globals.values, showHelp: true };
    }

    if (globals.error) {
        return { kind: "error", message: globals.error, details: [], node, globals: globals.values, showHelp: true };
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

    const input = collectValues(command.flags, parsed.values, true);

    if (input.error) {
        return { kind: "error", message: input.error, details: [], node, globals: globals.values, showHelp: true };
    }

    const positional = assignPositionals(command, parsed.positionals, input.values, appName);

    if (positional.error) {
        const options = node.children.size > 0 ? suggest(parsed.positionals[0] ?? "", [...node.children.keys()]) : [];

        return {
            kind: "error",
            message: positional.error,
            details: [...(positional.details ?? []), ...(options.length > 0 ? [`Did you mean "${[...node.path, options[0]].join(" ")}"?`] : [])],
            node,
            globals: globals.values,
            showHelp: true,
        };
    }

    const missing = missingRequired(command, input.values);

    if (missing) {
        return { kind: "error", ...missing, node, globals: globals.values, showHelp: true };
    }

    return { kind: "run", command, node, input: input.values, globals: globals.values };
}

function tokenMap(specs: readonly FlagSpec[]): Map<string, FlagSpec> {
    const map = new Map<string, FlagSpec>();

    for (const spec of specs) {
        map.set(`--${spec.name}`, spec);

        if (spec.kind === "boolean") {
            map.set(`--no-${spec.name}`, spec);
        }

        for (const letter of [spec.short, ...spec.shorts]) {
            if (letter) {
                map.set(`-${letter}`, spec);
            }
        }
    }

    return map;
}

/**
 * For a `passThrough` command: splits its arguments into the flags it knows (with their values),
 * and everything else in the order typed, plus every token after the first `--` as it is.
 *
 * ```ts
 * splitPassThrough(["claude", "--no-build", "--model", "opus", "--", "-c"], flags);
 * // -> { own: ["--no-build"], passed: ["claude", "--model", "opus", "-c"] }
 * ```
 */
function splitPassThrough(args: readonly string[], flags: readonly FlagSpec[]): { own: string[]; passed: string[] } {
    const known = tokenMap(flags);
    const own: string[] = [];
    const passed: string[] = [];

    for (const flag of flags) {
        for (const alias of flag.aliases) {
            known.set(`--${alias}`, flag);
        }
    }

    for (let index = 0; index < args.length; index++) {
        const token = args[index]!;

        if (token === "--") {
            passed.push(...args.slice(index + 1));
            break;
        }

        const name = token.split("=")[0]!;
        const spec = known.get(name);

        if (!token.startsWith("-") || token === "-" || (spec === undefined && !["-h", "--help", "--version"].includes(name))) {
            passed.push(token);
            continue;
        }

        own.push(token);

        if (spec && spec.kind !== "boolean" && !token.includes("=") && index + 1 < args.length) {
            own.push(args[++index]!);
        }
    }

    return { own, passed };
}

function mergeFlags(own: readonly FlagSpec[], globals: readonly FlagSpec[]): FlagSpec[] {
    const names = new Set(own.flatMap((flag) => [flag.name, ...flag.aliases]));

    return [...own, ...globals.filter((flag) => !names.has(flag.name))];
}

interface RawParse {
    values: Record<string, unknown>;
    positionals: string[];
    error?: { message: string; details: string[] };
}

function runParseArgs(args: string[], flags: readonly FlagSpec[]): RawParse {
    const options: NonNullable<ParseArgsConfig["options"]> = {
        help: { type: "boolean", short: "h" },
        version: { type: "boolean" },
    };
    const used = new Set(["h", ...flags.flatMap((flag) => (flag.short ? [flag.short] : []))]);
    const extraNames = new Map<string, string[]>();

    for (const flag of flags) {
        const option = {
            type: flag.kind === "boolean" ? ("boolean" as const) : ("string" as const),
            multiple: flag.multiple,
            ...(flag.short ? { short: flag.short } : {}),
        };

        options[flag.name] = option;

        const names = [...flag.aliases];

        for (const alias of flag.aliases) {
            options[alias] = { type: option.type, multiple: option.multiple };
        }

        for (const letter of flag.shorts) {
            if (used.has(letter)) {
                continue;
            }

            used.add(letter);
            names.push(`\u0000${flag.name}:${letter}`);
            options[`\u0000${flag.name}:${letter}`] = { type: option.type, multiple: option.multiple, short: letter };
        }

        extraNames.set(flag.name, names);
    }

    try {
        const { values, positionals } = parseArgs({ args, options, strict: true, allowPositionals: true, allowNegative: true });

        // With allowNegative, Node reads `--no-build` as `build: false` even when `no-build` is a
        // flag of its own. Give the value back to that flag when no `build` flag exists.
        for (const flag of flags) {
            const positive = flag.name.startsWith("no-") ? flag.name.slice(3) : undefined;

            if (flag.kind === "boolean" && positive !== undefined && options[positive] === undefined && values[positive] !== undefined) {
                values[flag.name] = !values[positive];
                delete values[positive];
            }
        }

        for (const flag of flags) {
            for (const alias of extraNames.get(flag.name) ?? []) {
                if (values[alias] !== undefined && values[flag.name] === undefined) {
                    values[flag.name] = values[alias];
                }

                if (alias.startsWith("\u0000")) {
                    delete values[alias];
                }
            }
        }

        return { values: values as Record<string, unknown>, positionals };
    } catch (error) {
        return { values: {}, positionals: [], error: describeParseError(error, flags) };
    }
}

/** Node's parse error, in the words the CLI used before the refactor: `Nonexistent flag: --nope`. */
function describeParseError(error: unknown, flags: readonly FlagSpec[]): { message: string; details: string[] } {
    const message = error instanceof Error ? error.message : String(error);
    const unknown = /Unknown option '(-{1,2}[^']+)'/.exec(message)?.[1];

    if (unknown) {
        const names = flags.flatMap((flag) => [`--${flag.name}`, ...flag.aliases.map((alias) => `--${alias}`)]);
        const options = suggest(unknown, [...names, "--help"]);

        return { message: `Nonexistent flag: ${unknown}`, details: options.length > 0 ? [`Did you mean ${options.join(" or ")}?`] : [] };
    }

    const missingValue = /Option '(-{1,2}[^' ]+)(?: [^']*)?' argument missing/.exec(message)?.[1];

    if (missingValue) {
        return { message: `Flag ${missingValue} expects a value`, details: [] };
    }

    return { message: message.replace(/\. To specify a positional argument.*$/, "."), details: [] };
}

/**
 * The required arguments and flags the command line left out, worded as before the refactor:
 *
 * ```text
 * Missing 1 required arg:
 *   ref  What to subscribe to
 * ```
 */
function missingRequired(command: Command, input: Record<string, unknown>): { message: string; details: string[] } | undefined {
    const args = command.positionals.filter((spec) => spec.required && input[spec.field] === undefined);

    if (args.length > 0) {
        const width = Math.max(...args.map((spec) => spec.name.length));

        return {
            message: `Missing ${args.length} required arg${args.length === 1 ? "" : "s"}:`,
            details: args.map((spec) => (spec.description ? `${spec.name.padEnd(width)}  ${spec.description}` : spec.name)),
        };
    }

    const flag = command.flags.find((spec) => spec.required && input[spec.field] === undefined && !command.positionals.some((p) => p.field === spec.field));

    return flag ? { message: `Missing required flag --${flag.name}`, details: [] } : undefined;
}

/**
 * Converts each flag's raw values by its kind. With `checkChoices`, a value outside a flag's choices
 * is an error (global arguments skip it: an unknown `--log-level` falls back to `info`).
 */
function collectValues(specs: readonly FlagSpec[], values: Record<string, unknown>, checkChoices = false): { values: Record<string, unknown>; error?: string } {
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

            if (checkChoices && spec.choices && spec.choices.length > 0 && !spec.choices.includes(result.value)) {
                return { values: out, error: `Expected --${spec.name}=${String(item)} to be one of: ${spec.choices.map(String).join(", ")}` };
            }

            converted.push(result.value);
        }

        out[spec.field] = spec.multiple ? converted : converted[0];
    }

    return { values: out };
}

function assignPositionals(command: Command, positionals: readonly string[], input: Record<string, unknown>, appName: string): { error?: string; details?: string[] } {
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

        return { error: `Unexpected argument: ${extra}`, details: [`"${words}" takes ${command.positionals.length === 0 ? "no arguments" : `at most ${command.positionals.length} argument${command.positionals.length === 1 ? "" : "s"}`}.`] };
    }

    return {};
}
