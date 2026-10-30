import { definePlugin, SousError } from "@sous-io/plugin-api";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { askingPlugin, loudPlugin, namespacesPlugin, reposPlugin, verbosePlugin } from "./fixtures.js";
import { fakeIo, runCli } from "./helpers.js";

describe("the CLI front end", () => {
    describe("commands generated from intents (C8, C68)", () => {
        /**
         * An intent's command words come from `cli.command`, and its flags and positional arguments
         * from its input schema; the handler gets the parsed input and the result is printed as JSON.
         *
         * sous namespace list github.com/x --json
         * // -> { "listed": "github.com/x", "json": true }
         */
        it("should run an intent from its command words, positional argument and flags", async () => {
            const run = await runCli([namespacesPlugin], ["namespace", "list", "github.com/x", "--json"]);

            expect(run.exitCode).toBeUndefined();
            expect(JSON.parse(run.stdout)).toEqual({ listed: "github.com/x", json: true });
        });

        /**
         * Without a `cli.command`, the words come from the intent name split at dots, and a
         * positional field is also accepted as a flag.
         *
         * sous repo add --url https://x
         */
        it("should derive the command words from the intent name and accept a positional as a flag", async () => {
            const run = await runCli([reposPlugin], ["repo", "add", "--url", "https://x"]);

            expect(JSON.parse(run.stdout)).toMatchObject({ url: "https://x", priority: 10, tags: [], mode: "trusted", yes: false });
        });

        /**
         * Numbers, integers, enums, repeated array flags, short flags, flag aliases and `--no-`
         * negation are all parsed from the schema.
         */
        it("should parse every kind of flag the schema describes", async () => {
            const run = await runCli([reposPlugin], ["repo", "add", "https://x", "--priority", "3", "--tags", "a", "--tags", "b", "--mode", "untrusted", "-y", "--as", "main"]);

            expect(JSON.parse(run.stdout)).toEqual({ url: "https://x", name: "main", priority: 3, tags: ["a", "b"], mode: "untrusted", yes: true });

            const negated = await runCli([reposPlugin], ["repo", "add", "https://x", "--yes", "--no-yes"]);

            expect(JSON.parse(negated.stdout).yes).toBe(false);
        });

        /**
         * Groups nest to any depth: `sous repo add alternate <repo> <urls>...`, with a variadic last
         * positional for an array field.
         */
        it("should run a command nested three groups deep with a variadic positional", async () => {
            const run = await runCli([reposPlugin], ["repo", "add", "alternate", "main", "https://a", "https://b"]);

            expect(JSON.parse(run.stdout)).toEqual({ repo: "main", urls: ["https://a", "https://b"] });
        });

        /**
         * Aliases run the same intent, in any group, including across groups (`list namespaces`).
         */
        it("should run an intent through each of its aliases, across groups too", async () => {
            for (const words of [["namespaces", "list"], ["ns", "list"], ["list", "namespaces"]]) {
                const run = await runCli([namespacesPlugin], [...words, "repo-a"]);

                expect(JSON.parse(run.stdout)).toEqual({ listed: "repo-a", json: false });
            }
        });

        /** A hidden intent still runs; an internal one has no command at all (C9). */
        it("should run hidden commands and give internal intents no command", async () => {
            expect((await runCli([reposPlugin], ["repo", "secret"])).stdout).toBe("hidden ran\n");

            const internal = await runCli([reposPlugin], ["repo", "internal"]);

            expect(internal.exitCode).toBe(2);
            expect(internal.stderr).toContain('There is no command "repo internal"');
        });

        /** A wrong value type is a usage error naming the flag, exit code 2. */
        it("should reject a value of the wrong type, naming the flag", async () => {
            const run = await runCli([reposPlugin], ["repo", "add", "https://x", "--priority", "high"]);

            expect(run.exitCode).toBe(2);
            expect(run.stderr).toContain('Error: --priority takes a whole number, not "high".');
        });

        /**
         * A value outside a flag's choices, and a missing required argument, are usage errors in the
         * old CLI's words, followed by the command's help.
         */
        it("should report a bad choice and a missing argument in the old CLI's words", async () => {
            const choice = await runCli([reposPlugin], ["repo", "add", "x", "--mode", "maybe"]);

            expect(choice.exitCode).toBe(2);
            expect(choice.stderr).toContain("Error: Expected --mode=maybe to be one of: trusted, untrusted\n");
            expect(choice.stderr).toContain("USAGE\n  $ sous repo add URL [flags]");

            const missing = await runCli([reposPlugin], ["repo", "add"]);

            expect(missing.exitCode).toBe(2);
            expect(missing.stderr).toMatch(/^Error: Missing 1 required arg:\n {2}url/);
        });

        /** Too many positional arguments is an error that says what was extra. */
        it("should reject extra positional arguments", async () => {
            const run = await runCli([namespacesPlugin], ["namespace", "list", "a", "b"]);

            expect(run.exitCode).toBe(2);
            expect(run.stderr).toContain('Error: Unexpected argument: b\n  "sous namespace list" takes at most 1 argument.');
        });

        /** A value given both as a positional and as its flag is an error. */
        it("should reject a value given twice", async () => {
            const run = await runCli([namespacesPlugin], ["namespace", "list", "a", "--repository", "b"]);

            expect(run.stderr).toContain("<repository> was given both as an argument and as --repository.");
        });

        /** A text result prints as text; `undefined` prints nothing. */
        it("should print text results as they are and nothing for undefined", async () => {
            const plugin = definePlugin({
                name: "p",
                register(sous) {
                    sous.intents.add({ intent: "quiet", handle: () => undefined });
                },
            });

            const run = await runCli([plugin], ["quiet"]);

            expect(run.stdout).toBe("");
            expect(run.exitCode).toBeUndefined();
        });

        /** A handler that throws a SousError prints `Error: ` and its details, with its exit code. */
        it("should turn a failing intent into an Error line and an exit code", async () => {
            const plugin = definePlugin({
                name: "p",
                register(sous) {
                    sous.intents.add({
                        intent: "fail",
                        handle: () => {
                            throw new SousError("The lockfile is damaged.", { details: ["Run sous lock repair."], exitCode: 3 });
                        },
                    });
                },
            });

            const run = await runCli([plugin], ["fail"]);

            expect(run.stderr).toBe("Error: The lockfile is damaged.\n  Run sous lock repair.\n");
            expect(run.exitCode).toBe(3);
        });
    });

    describe("help (C8, C69)", () => {
        /**
         * `sous --help` lists the top-level commands and groups, with each group's summary from its
         * `cli-group` entity, and the global flags from the `cli-global-argument` entities.
         */
        it("should list commands, groups and global flags at the root", async () => {
            const run = await runCli([namespacesPlugin, reposPlugin], ["--help"]);

            expect(run.stdout).toContain("USAGE\n  $ sous COMMAND");
            expect(run.stdout).toMatch(/namespace\s+Browse the namespaces the trusted repositories publish/);
            expect(run.stdout).toMatch(/repo\s+Manage the recipe repositories this project trusts/);
            expect(run.stdout).toMatch(/--debug\s+Show every message/);
            expect(run.stdout).toMatch(/--log-level <level>\s+Show messages at this level and above/);
            expect(run.stdout).toMatch(/--timings\s+Print every timing/);
            expect(run.stdout).toContain("--version");
            expect(run.stdout).not.toMatch(/^\s+namespaces\s/m);
            expect(run.stdout).not.toMatch(/^\s+ns\s/m);
            expect(run.stdout).not.toMatch(/^\s+list\s/m);
        });

        /** No arguments shows the root help, exit code 0. */
        it("should show help when given no arguments", async () => {
            const run = await runCli([reposPlugin], []);

            expect(run.stdout).toContain("COMMANDS");
            expect(run.exitCode).toBeUndefined();
        });

        /** A group's help lists its commands; hidden ones are left out. */
        it("should show a group's help with its commands, without hidden ones", async () => {
            const run = await runCli([reposPlugin], ["repo", "--help"]);

            expect(run.stdout.startsWith("Manage the recipe repositories this project trusts")).toBe(true);
            expect(run.stdout).toMatch(/add\s+Add a recipe repository, or an alternate location/);
            expect(run.stdout).not.toContain("secret");
            expect(run.stdout).not.toContain("internal");
        });

        /** A group with no `cli-group` entity shows how many commands it has. */
        it("should count the commands of a group with no help entity", async () => {
            const plugin = definePlugin({
                name: "p",
                register(sous) {
                    sous.intents.add({ intent: "things.list", summary: "List", handle: () => 1 });
                    sous.intents.add({ intent: "things.show", summary: "Show", handle: () => 1 });
                },
            });

            expect((await runCli([plugin], ["--help"])).stdout).toMatch(/things\s+2 commands/);
        });

        /**
         * A command's help shows its usage with positional arguments, its flags with descriptions,
         * choices and defaults, its aliases and its examples.
         */
        it("should show a command's arguments, flags, aliases and examples", async () => {
            const run = await runCli([namespacesPlugin], ["ns", "list", "--help"]);

            expect(run.stdout).toContain("List the namespaces in your subscribed repositories");
            expect(run.stdout).toContain("USAGE\n  $ sous namespace list [REPOSITORY] [flags]");
            expect(run.stdout).toMatch(/REPOSITORY\s+Only this repository/);
            expect(run.stdout).toMatch(/--json\s+Print JSON/);
            expect(run.stdout).toContain("ALIASES\n  $ sous namespaces list\n  $ sous ns list\n  $ sous list namespaces");
            expect(run.stdout).toContain("EXAMPLES\n  $ sous ns list github.com/sous-io/sous-recipes");

            const repo = await runCli([reposPlugin], ["repo", "add", "-h"]);

            expect(repo.stdout).toContain("USAGE\n  $ sous repo add URL [flags]\n  $ sous repo add COMMAND");
            expect(repo.stdout).toMatch(/--mode <choice>\s+Whether to trust it One of: trusted, untrusted. Default: "trusted"./);
            expect(repo.stdout).toMatch(/--tags <value>\s+Tags to give it Default: \[\]. May be given more than once./);
            expect(repo.stdout).toMatch(/-y, --yes\s+Add it without asking/);
            expect(repo.stdout).toMatch(/repo add alternate\s+Add an alternate location/);
        });

        /** `--help` never loads a lazy handler (G9). */
        it("should show help without loading a lazily loaded handler", async () => {
            let loaded = false;
            const plugin = definePlugin({
                name: "p",
                register(sous) {
                    sous.intents.add({
                        intent: "build",
                        summary: "Build the project",
                        load: async () => {
                            loaded = true;

                            return () => "built";
                        },
                    });
                },
            });

            expect((await runCli([plugin], ["build", "--help"])).stdout).toContain("Build the project");
            expect(loaded).toBe(false);
            expect((await runCli([plugin], ["build"])).stdout).toBe("built\n");
            expect(loaded).toBe(true);
        });
    });

    describe("mistakes", () => {
        /** A mistyped command suggests the closest one ("did you mean"). */
        it("should suggest the closest command for a mistyped one", async () => {
            const run = await runCli([reposPlugin], ["rpeo"]);

            expect(run.exitCode).toBe(2);
            expect(run.stderr).toContain('Error: There is no command "rpeo".\n  Did you mean "repo"?');

            const nested = await runCli([reposPlugin], ["repo", "ad"]);

            expect(nested.stderr).toContain('Did you mean "repo add"?');
        });

        /** A mistyped flag suggests the closest flag. */
        it("should suggest the closest flag for a mistyped one", async () => {
            const run = await runCli([reposPlugin], ["repo", "add", "x", "--priorty", "2"]);

            expect(run.exitCode).toBe(2);
            expect(run.stderr).toContain("Error: Nonexistent flag: --priorty\n  Did you mean --priority?");
        });

        /** A string flag with no value says it needs one. */
        it("should say when a flag needs a value", async () => {
            const run = await runCli([reposPlugin], ["repo", "add", "x", "--name"]);

            expect(run.stderr).toContain("Error: Flag --name expects a value");
        });

        /**
         * Two intents claiming the same words is an error naming both plugins, unless
         * `cli.pick` picks one (S1: "Two intents claiming the same command or alias is an error
         * naming both plugins").
         */
        it("should report an alias clash naming both plugins", async () => {
            const other = definePlugin({
                name: "sous-plugin-other",
                register(sous) {
                    sous.intents.add({ intent: "other.list", cli: { command: ["ns", "list"] }, handle: () => "other" });
                },
            });

            const run = await runCli([namespacesPlugin, other], ["ns", "list"]);

            expect(run.exitCode).toBe(1);
            expect(run.stderr).toContain(
                'Error: Two commands claim "ns list": intent "namespace.list" (sous-plugin-namespaces) and intent "other.list" (sous-plugin-other).',
            );
            expect(run.stderr).toContain('cli.pick."ns list": "sous-plugin-namespaces"');
        });
    });

    describe("global arguments (C61, C69, C52)", () => {
        /** A plugin's own global argument is accepted before or after the command words and reaches ctx.globals. */
        it("should pass plugin-added global arguments to the handler", async () => {
            const before = await runCli([verbosePlugin], ["--verbose", "show", "globals"]);
            const after = await runCli([verbosePlugin], ["show", "globals", "--verbose", "--debug"]);

            expect(JSON.parse(before.stdout)).toEqual({ verbose: true, debug: false });
            expect(JSON.parse(after.stdout)).toEqual({ verbose: true, debug: true });
            expect((await runCli([verbosePlugin], ["--help"])).stdout).toMatch(/--verbose\s+Print more detail/);
        });

        /**
         * The reporter shows info and above by default; `--log-level <level>` shows that level and
         * above; `--debug` shows everything. Each message has its literal prefix.
         */
        it("should filter messages by --log-level and --debug", async () => {
            const normal = await runCli([loudPlugin], ["loud"]);

            expect(normal.stderr).not.toContain("a debug message");
            expect(normal.stderr).toContain("a info message\na notice message\nWarning: a warning message\nError: a error message\n");
            expect(normal.stderr).toContain("Critical: a critical message\nAlert: a alert message\nEmergency: a emergency message");

            const errorsOnly = await runCli([loudPlugin], ["--log-level", "error", "loud"]);

            expect(errorsOnly.stderr).toBe("Error: a error message\nCritical: a critical message\nAlert: a alert message\nEmergency: a emergency message\n");

            const equals = await runCli([loudPlugin], ["loud", "--log-level=critical"]);

            expect(equals.stderr).toBe("Critical: a critical message\nAlert: a alert message\nEmergency: a emergency message\n");

            const debug = await runCli([loudPlugin], ["loud", "--debug"]);

            expect(debug.stderr.startsWith("Debug: a debug message\n")).toBe(true);
        });

        /** An unknown log level is rejected by its schema. */
        it("should ignore an unknown log level and fall back to info", async () => {
            const run = await runCli([loudPlugin], ["loud", "--log-level", "loud"]);

            expect(run.stderr).toContain("a info message");
            expect(run.stderr).not.toContain("Debug:");
        });

        /** `--timings` prints every timing to standard error after the command. */
        it("should print every timing with --timings", async () => {
            const run = await runCli([reposPlugin], ["repo", "secret", "--timings"]);

            expect(run.stdout).toBe("hidden ran\n");
            expect(run.stderr).toContain("Timings:");
            expect(run.stderr).toMatch(/config\.build:config\s+1 call/);
            expect(run.stderr).toMatch(/intent:repo\.secret\s+1 call/);
        });

        /**
         * `sous --version` prints `v` and the version, as before the refactor; the `version` intent
         * can say more, and `--json` gives its plain result.
         */
        it("should print the version", async () => {
            expect((await runCli([], ["--version"])).stdout).toBe("v9.8.7\n");
            expect((await runCli([], ["version"])).stdout).toBe("v9.8.7\n");
            expect((await runCli([], ["--version", "--verbose"])).stdout).toMatch(/^v9\.8\.7\n {4}Package : sous\n/);
            expect(JSON.parse((await runCli([], ["version", "--verbose", "--json"])).stdout)).toEqual({ name: "sous", version: "9.8.7" });
        });
    });

    describe("prompts (L4, C46)", () => {
        /** Without a terminal the question fails with NonInteractiveError naming the flag that answers it. */
        it("should fail a question it cannot ask, naming the flag", async () => {
            const run = await runCli([askingPlugin], ["prune"]);

            expect(run.exitCode).toBe(1);
            expect(run.stderr).toMatch(
                /^Error: sous needed to ask "Remove the 3 files listed above\?" but cannot ask questions in this run. Pass --yes to answer it ahead of time.\n {2}Why: neither input nor output is a terminal\.\n\n.*\n\nUSAGE\n {2}\$ sous prune/s,
            );
        });

        /** The flag answers the question without a prompt. */
        it("should let the flag answer instead", async () => {
            expect((await runCli([askingPlugin], ["prune", "--yes"])).stdout).toBe("removed\n");
        });

        /** In a terminal, the question is asked and answered. */
        it("should ask in an interactive terminal", async () => {
            const io = fakeIo({ tty: true, input: "n\n" });
            const run = await runCli([askingPlugin], ["prune"], { io });

            expect(run.stdout).toBe("kept\n");
            expect(run.stderr).toContain("Remove the 3 files listed above? [y/n]");
        });

        /** A CI variable or `--non-interactive` turns prompts off even in a terminal. */
        it("should not ask in CI or with --non-interactive", async () => {
            const ci = await runCli([askingPlugin], ["prune"], { io: fakeIo({ tty: true, input: "y\n" }), env: { CI: "true" } });

            expect(ci.stderr).toContain("Pass --yes");

            const flagged = await runCli([askingPlugin], ["prune", "--non-interactive"], { io: fakeIo({ tty: true, input: "y\n" }) });

            expect(flagged.stderr).toContain("Pass --yes");
        });
    });

    describe("engine messages", () => {
        /** Warnings from building the config, kept before the CLI started, reach standard error. */
        it("should show warnings kept from building the config", async () => {
            const plugin = definePlugin({
                name: "p",
                register(sous) {
                    sous.entities.add("not-a-kind", { id: "x" });
                    sous.intents.add({ intent: "noop", input: z.object({}), handle: () => undefined });
                },
            });

            const run = await runCli([plugin], ["noop"]);

            expect(run.stderr).toContain('Warning: p added a "not-a-kind" entity, but no plugin defines that kind.');
        });
    });
});

describe("built-in groups, globals and help intent", () => {
    const commandPlugin = definePlugin({
        name: "p",
        register(sous) {
            sous.intents.add({ intent: "config.show", summary: "Show the config", cli: { aliases: [["configs", "show"]] }, handle: () => "shown" });
        },
    });

    /** The plural group word shows the group's help, and is not listed at the root. */
    it("should answer to a group's plural word", async () => {
        const run = await runCli([commandPlugin], ["configs", "--help"]);

        expect(run.stdout.startsWith("Inspect the merged configuration")).toBe(true);
        expect(run.stdout).toMatch(/show\s+Show the config/);
        expect((await runCli([commandPlugin], ["--help"])).stdout).not.toMatch(/^\s+configs\s/m);
        expect((await runCli([commandPlugin], ["configs", "show"])).stdout).toBe("shown\n");
    });

    /** `sous help <words>` prints what `--help` prints. */
    it("should print help for the words after help", async () => {
        const viaHelp = await runCli([commandPlugin], ["help", "config", "show"]);
        const viaFlag = await runCli([commandPlugin], ["config", "show", "--help"]);

        expect(viaHelp.stdout).toBe(viaFlag.stdout);
        expect((await runCli([commandPlugin], ["help"])).stdout).toContain("TOPICS");
        expect((await runCli([commandPlugin], ["help", "confg"])).stderr).toContain('There is no command "confg".');
    });

    /** Every global argument of the old CLI parses on any command. */
    it("should accept the old global arguments", async () => {
        const plugin = definePlugin({
            name: "g",
            register(sous) {
                sous.intents.add({ intent: "g", summary: "G", handle: (_i, ctx) => ctx.globals });
            },
        });
        const run = await runCli([plugin], ["g", "-c", "x.json", "--sous-dir", "d", "--sous-confd", "c", "--sous-config", "y"]);

        expect(JSON.parse(run.stdout)).toMatchObject({ config: "x.json", "sous-dir": "d", "sous-confd": "c", "sous-config": "y" });
    });
});
