import { readFileSync } from "node:fs";
import path from "node:path";
import { createEngine } from "@sous-io/core";
import { type CommandTree, globalSpecs, type FlagSpec } from "@sous-io/plugin-cli";
import { beforeAll, describe, expect, it } from "vitest";
import { BUILT_IN_PLUGINS } from "../src/built-ins.js";

/** One flag of the old CLI, as `fixtures/command-inventory.json` records it. */
interface InventoryFlag {
    name: string;
    char?: string;
    type: "boolean" | "string" | "integer" | "option";
    options?: string[];
    multiple?: boolean;
    required?: boolean;
    aliases?: string[];
    charAliases?: string[];
}

/** One command of the old CLI. */
interface InventoryCommand {
    command: string[];
    aliases: string[][];
    hiddenAliases: string[][];
    args: Array<{ name: string; required: boolean; variadic: boolean }>;
    flags: InventoryFlag[];
    hidden: boolean;
}

interface Inventory {
    globalFlags: InventoryFlag[];
    topics: string[];
    topicAliases: string[];
    commands: InventoryCommand[];
}

const inventory = JSON.parse(readFileSync(path.join(import.meta.dirname, "fixtures", "command-inventory.json"), "utf8")) as Inventory;

/**
 * Every command, alias, argument and flag of the CLI before the refactor must still exist (Luke's
 * rule: additions are free). Plugins that carry the commands are not all written yet, so this runs
 * only in the final full check:
 *
 *     SOUS_CHECK_INVENTORY=1 pnpm --filter @sous-io/sous exec vitest run test/command-inventory.test.ts
 */
describe.skipIf(process.env.SOUS_CHECK_INVENTORY !== "1")("the command inventory", () => {
    let tree: CommandTree;
    let globals: FlagSpec[];

    beforeAll(async () => {
        const engine = createEngine({
            project: undefined,
            env: {},
            cwd: process.cwd(),
            app: { name: "sous", version: "0.0.0" },
            builtIns: BUILT_IN_PLUGINS,
        });

        await engine.buildConfig();
        tree = engine.config.services.get("cli.commands") as CommandTree;
        globals = globalSpecs(engine.config.entities.list("cli-global-argument"));
    }, 60_000);

    /** The command that the words run, or undefined. */
    function lookup(words: string[]) {
        const { node, used } = tree.find(words);

        return used === words.length ? node.command : undefined;
    }

    /** Every flag the command accepts: its own, then the global ones. */
    function acceptedFlags(words: string[]): FlagSpec[] {
        return [...(lookup(words)?.flags ?? []), ...globals];
    }

    /** Checks one inventoried flag against the flags a command accepts. */
    function expectFlag(accepted: FlagSpec[], flag: InventoryFlag): void {
        const found = accepted.find((spec) => spec.name === flag.name || spec.aliases.includes(flag.name));

        expect(found, `flag --${flag.name}`).toBeDefined();

        if (!found) {
            return;
        }

        for (const alias of flag.aliases ?? []) {
            expect(found.name === alias || found.aliases.includes(alias) || accepted.some((spec) => spec.name === alias), `alias --${alias} of --${flag.name}`).toBe(true);
        }

        if (flag.char) {
            expect(found.short, `-${flag.char} of --${flag.name}`).toBe(flag.char);
        }

        if (flag.type === "boolean") {
            expect(found.kind, `type of --${flag.name}`).toBe("boolean");
        } else if (flag.type === "integer") {
            expect(["integer", "number"], `type of --${flag.name}`).toContain(found.kind);
        } else {
            expect(["string", "json"], `type of --${flag.name}`).toContain(found.kind);
        }

        if (flag.options) {
            expect(found.choices ?? [], `options of --${flag.name}`).toEqual(expect.arrayContaining(flag.options));
        }

        if (flag.multiple) {
            expect(found.multiple, `--${flag.name} repeatable`).toBe(true);
        }
    }

    it("should have every global flag on every command", () => {
        for (const flag of inventory.globalFlags) {
            for (const entry of inventory.commands) {
                expectFlag(acceptedFlags(entry.command), flag);
            }
        }
    });

    describe.each(inventory.commands.map((entry) => [entry.command.join(" "), entry] as const))("sous %s", (_name, entry) => {
        it("should exist", () => {
            expect(lookup(entry.command), "command").toBeDefined();
        });

        it("should keep every alias, running the same command", () => {
            const command = lookup(entry.command);

            for (const alias of [...entry.aliases, ...entry.hiddenAliases]) {
                expect(lookup(alias)?.intent, `alias ${alias.join(" ")}`).toBe(command?.intent);
            }
        });

        it("should keep every argument, in order", () => {
            const positionals = lookup(entry.command)?.positionals ?? [];

            entry.args.forEach((arg, index) => {
                const found = positionals[index];

                expect(found?.name, `argument ${index + 1}`).toBe(arg.name);
                if (arg.required) {
                    expect(found?.required, `${arg.name} required`).toBe(true);
                }
                expect(found?.variadic ?? false, `${arg.name} variadic`).toBe(arg.variadic);
            });
        });

        it("should keep every flag", () => {
            const accepted = acceptedFlags(entry.command);

            for (const flag of entry.flags) {
                expectFlag(accepted, flag);
            }
        });
    });

    it("should keep the groups", () => {
        for (const topic of inventory.topics) {
            expect(tree.find([topic]).used, `group ${topic}`).toBe(1);
        }
    });

    it("should keep the group words that stand for another group", () => {
        for (const topic of inventory.topicAliases) {
            expect(tree.find([topic]).used, `group word ${topic}`).toBe(1);
        }
    });
});
