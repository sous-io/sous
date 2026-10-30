import { jsonSchema, type IntentInfo } from "@sous-io/plugin-api";
import { describe, expect, it } from "vitest";
import { CommandTree } from "./command-tree.js";
import { globalSpecs } from "./globals.js";
import { parseLine } from "./parse.js";
import { BUILT_IN_GLOBAL_ARGUMENTS } from "./plugin.js";

const info = (intent: string, input?: object, cli?: IntentInfo["definition"]["cli"]): IntentInfo => ({
    plugin: "p",
    definition: { intent, handle: () => undefined, ...(input ? { input: jsonSchema(input as never) } : {}), ...(cli ? { cli } : {}) },
});

const tree = CommandTree.build(
    [
        info("repo.add", { type: "object", properties: { url: { type: "string" }, count: { type: "integer" } } }, { positional: ["url"] }),
        info("build"),
    ],
    [],
);
const globals = globalSpecs([
    ...BUILT_IN_GLOBAL_ARGUMENTS,
    { id: "profile", schema: jsonSchema({ type: "string" }), description: "A profile", short: "p" },
    { id: "jobs", schema: jsonSchema({ type: "integer" }), description: "Jobs" },
]);

describe("parseLine()", () => {
    /**
     * Global flags may come before the command words, with their values.
     *
     * parseLine(["--log-level", "debug", "-p", "x", "repo", "add", "u"]) // -> run repo.add { url: "u" }
     */
    it("should accept global flags and their values before the command words", () => {
        const line = parseLine(["--log-level", "debug", "-p", "x", "repo", "add", "u"], tree, globals);

        expect(line).toMatchObject({ kind: "run", input: { url: "u" }, globals: { "log-level": "debug", profile: "x" } });
    });

    /** Everything after `--` is positional, even when it looks like a flag. */
    it("should treat everything after -- as positional", () => {
        expect(parseLine(["repo", "add", "--", "--weird"], tree, globals)).toMatchObject({ kind: "run", input: { url: "--weird" } });
    });

    /**
     * A passThrough command hands every token it does not know to its last positional, in order,
     * and everything after `--` as it is; its own flags and the global ones still parse.
     *
     * launch dump --no-build --model=opus -p x --resume -- -c  // -> tool: ["dump", "--model=opus", "--resume", "-c"]
     */
    it("should pass unknown tokens through for a passThrough command", () => {
        const launch = CommandTree.build(
            [
                info(
                    "launch",
                    { type: "object", properties: { tool: { type: "array", items: { type: "string" } }, noBuild: { type: "boolean" } } },
                    { positional: ["tool"], passThrough: true },
                ),
            ],
            [],
        );

        expect(parseLine(["launch", "dump", "--no-build", "--model=opus", "-p", "x", "--resume", "--", "-c"], launch, globals)).toMatchObject({
            kind: "run",
            input: { tool: ["dump", "--model=opus", "--resume", "-c"], noBuild: true },
            globals: { profile: "x" },
        });
    });

    /** A global argument's value is converted by its schema type, and a bad one is an error. */
    it("should convert global argument values, rejecting bad ones", () => {
        expect(parseLine(["build", "--jobs", "4"], tree, globals)).toMatchObject({ kind: "run", globals: { jobs: 4 } });
        expect(parseLine(["build", "--jobs", "many"], tree, globals)).toMatchObject({ kind: "error", message: '--jobs takes a whole number, not "many".' });
    });

    /** A positional argument is converted by its field's type. */
    it("should reject a positional value of the wrong type", () => {
        const typed = CommandTree.build([info("n.set", { type: "object", properties: { n: { type: "number" } } }, { positional: ["n"] })], []);

        expect(parseLine(["n", "set", "x"], typed, globals)).toMatchObject({ kind: "error", message: '<n> takes a number, not "x".' });
    });

    /** `--version` counts only at the root; `--help` wins anywhere. */
    it("should answer --version at the root and --help anywhere", () => {
        expect(parseLine(["--version"], tree, globals).kind).toBe("version");
        expect(parseLine(["build", "--version"], tree, globals).kind).toBe("run");
        expect(parseLine(["repo", "add", "u", "-h"], tree, globals)).toMatchObject({ kind: "help" });
    });

    /** An unknown command with nothing close gives no suggestion; extra words after a command suggest a subcommand. */
    it("should explain unknown commands, with suggestions only when something is close", () => {
        expect(parseLine(["zzzzzzzz"], tree, globals)).toMatchObject({ kind: "error", message: 'There is no command "zzzzzzzz".', details: [] });
        expect(parseLine(["build", "extra"], tree, globals)).toMatchObject({ kind: "error", message: "Unexpected argument: extra", details: ['"sous build" takes no arguments.'] });
    });

    /** Any other parse problem is reported as it is. */
    it("should report a flag given a value it cannot take", () => {
        const line = parseLine(["build", "--debug=yes"], tree, globals);

        expect(line.kind).toBe("error");
    });
});
