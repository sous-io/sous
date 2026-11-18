import { IntentOutputs, ConflictError, type IntentInfo } from "@sous-io/sous-plugin-api";
import { describe, expect, it } from "vitest";
import { CommandTree } from "./command-tree.js";

const intent = (name: string, plugin: string, cli?: IntentInfo["definition"]["cli"], extra: Partial<IntentInfo["definition"]> = {}): IntentInfo => ({
    plugin,
    definition: { intent: name, handle: () => new IntentOutputs(), ...(cli ? { cli } : {}), ...extra },
});

describe("CommandTree", () => {
    describe("build()", () => {
        /**
         * Each intent is placed at its command words (from `cli.command`, or its name split at dots)
         * and at each alias; a word can be a command and a group at once.
         *
         * repo.add + repo.add.alternate -> repo > add (command) > alternate (command)
         */
        it("should place commands at their words and aliases", () => {
            const tree = CommandTree.build(
                [intent("repo.add", "a"), intent("repo.add.alternate", "a"), intent("namespace.list", "b", { aliases: [["ns", "list"]] })],
                [],
            );

            expect(tree.find(["repo", "add"]).node.command?.intent).toBe("repo.add");
            expect(tree.find(["repo", "add", "alternate"]).node.command?.intent).toBe("repo.add.alternate");
            expect(tree.find(["ns", "list"]).node).toMatchObject({ viaAlias: true });
            expect(tree.find(["ns", "list"]).node.command?.intent).toBe("namespace.list");
            expect(tree.commands().map((command) => command.intent).sort()).toEqual(["namespace.list", "repo.add", "repo.add.alternate"]);
        });

        /** Internal intents get no command. */
        it("should leave internal intents out", () => {
            const tree = CommandTree.build([intent("secret.thing", "a", undefined, { internal: true })], []);

            expect(tree.root.children.size).toBe(0);
        });

        /** Groups reached only through aliases are not canonical, so help leaves them out. */
        it("should mark nodes reached only through aliases as not canonical", () => {
            const tree = CommandTree.build([intent("namespace.list", "b", { aliases: [["list", "namespaces"]] })], []);

            expect(tree.find(["list"]).node.canonical).toBe(false);
            expect(tree.find(["namespace"]).node.canonical).toBe(true);
        });

        /** A cli-group entity gives a group its help, even with no commands under it yet. */
        it("should attach cli-group entities to their groups", () => {
            const tree = CommandTree.build([], [{ id: "repo", command: ["repo"], summary: "Repositories" }]);

            expect(tree.find(["repo"]).node.group?.summary).toBe("Repositories");
            expect(tree.find(["repo"]).node.canonical).toBe(true);
        });

        /**
         * Two intents from different plugins claiming the same words is a ConflictError naming both
         * plugins and the config key that picks one.
         */
        it("should throw a ConflictError naming both plugins when two commands claim the same words", () => {
            const build = () => CommandTree.build([intent("namespace.list", "plugin-a", { aliases: [["ns", "list"]] }), intent("ns.list", "plugin-b")], []);

            expect(build).toThrow(ConflictError);
            expect(build).toThrow('Two commands claim "ns list": intent "namespace.list" (plugin-a) and intent "ns.list" (plugin-b).');

            try {
                build();
            } catch (error) {
                expect((error as ConflictError).plugins).toEqual(["plugin-a", "plugin-b"]);
                expect((error as ConflictError).details).toEqual(['Choose one in the config:  cli.pick."ns list": "plugin-a"']);
            }
        });

        /** `cli.pick` picks the winner of a clash, with a warning naming the ignored plugin. */
        it("should let cli.pick choose between clashing commands, with a warning", () => {
            const tree = CommandTree.build([intent("namespace.list", "plugin-a", { aliases: [["ns", "list"]] }), intent("ns.list", "plugin-b")], [], {
                "ns list": "plugin-b",
            });

            expect(tree.find(["ns", "list"]).node.command?.intent).toBe("ns.list");
            expect(tree.warnings).toEqual(['cli.pick picks plugin-b for "ns list". plugin-a\'s command is ignored there, and may not work as expected.']);
        });

        /** One intent naming the same words as its own alias is not a clash. */
        it("should not treat an intent's own repeated words as a clash", () => {
            const tree = CommandTree.build([intent("a.b", "p", { aliases: [["a", "b"]] })], []);

            expect(tree.find(["a", "b"]).node.command?.intent).toBe("a.b");
        });
    });

    describe("group aliases", () => {
        const namespaceGroup = { id: "namespace", command: ["namespace"], summary: "Namespaces", aliases: [["namespaces"], ["ns"]] };
        const intents = [intent("namespace.list", "b", { aliases: [["namespace", "ls"]] }), intent("namespace.show", "b")];

        /**
         * A group's alias reaches every command under it, the commands' own aliases included, with
         * no command spelling the alias itself.
         *
         * sous ns list   -> namespace.list
         * sous ns ls     -> namespace.list
         * sous ns show   -> namespace.show
         */
        it("should make every command of a group answer to the group's alias, with the commands' own aliases", () => {
            const tree = CommandTree.build(intents, [namespaceGroup]);

            expect(tree.find(["ns", "list"]).node.command?.intent).toBe("namespace.list");
            expect(tree.find(["ns", "ls"]).node.command?.intent).toBe("namespace.list");
            expect(tree.find(["namespaces", "show"]).node.command?.intent).toBe("namespace.show");
            expect(tree.find(["ns"]).node.canonical).toBe(false);
        });

        /**
         * A command's help lists its own aliases, then its words with the group spelled by each
         * of the group's aliases.
         *
         * aliasesOf(namespace.list) -> namespace ls, namespaces list, ns list
         */
        it("should list a command's own aliases and the words its group's aliases give it", () => {
            const tree = CommandTree.build(intents, [namespaceGroup]);
            const list = tree.find(["namespace", "list"]).node.command!;

            expect(tree.aliasesOf(list)).toEqual([
                ["namespace", "ls"],
                ["namespaces", "list"],
                ["ns", "list"],
            ]);
        });

        /** groupAt names the group only at its own words, never at an alias. */
        it("should find a group's entity at its own words only", () => {
            const tree = CommandTree.build(intents, [namespaceGroup]);

            expect(tree.groupAt(["namespace"])?.id).toBe("namespace");
            expect(tree.groupAt(["ns"])).toBeUndefined();
        });
    });

    describe("find()", () => {
        /** find walks as far as the words go and says how many it used. */
        it("should stop at the first unknown word", () => {
            const tree = CommandTree.build([intent("repo.add", "a")], []);

            expect(tree.find(["repo", "nope", "add"]).used).toBe(1);
            expect(tree.find([]).node).toBe(tree.root);
        });
    });
});
