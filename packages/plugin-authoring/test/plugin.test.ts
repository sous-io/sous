/**
 * plugin-authoring loaded into the real engine, beside stand-ins for the plugins it depends on
 * (registered under their real names, so `dependsOn` is satisfied): its intents and their command
 * line shape, a handler run through `engine.submit`, and the events a release fires.
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEngine } from "@sous-io/core";
import { cliPlugin, type CommandTree } from "@sous-io/plugin-cli";
import { BufferedReporter, definePlugin, toJsonSchema, type PluginDefinition } from "@sous-io/plugin-api";
import type { RepositoryHostEntity } from "@sous-io/plugin-recipes/types";
import { authoringPlugin } from "../src/index.js";
import type { AuthoringReleasedPayload } from "../src/types.js";
import { commitAll, initRepo, makeTmpDir, type TmpDir } from "./support/git-repo.js";
import {
    indexFileParser,
    manifests,
    realGit,
    recipeHash,
    recipeManifestParser,
    refsFormat,
    refsLocations,
    refsPicker,
    refsResolver,
    repoManifestParser,
    variableNames,
} from "./support/standins.js";

/** A stand-in plugin, named as the real one, adding the given services. */
function standIn(name: string, services: Record<string, unknown>, entities: Array<[string, { id: string }]> = []): PluginDefinition {
    return definePlugin({
        name,
        version: "0.2.34",
        register(sous) {
            for (const [service, value] of Object.entries(services)) {
                sous.services.add(service, () => value, { lifetime: "singleton" });
            }

            for (const [kind, entry] of entities) {
                if (!sous.entities.kinds().includes(kind)) {
                    sous.entities.define(kind, { "~standard": { version: 1, vendor: "test", validate: (value: unknown) => ({ value }) } });
                }

                sous.entities.add(kind, entry as never);
            }
        },
    });
}

/** A host that scaffolds one CI file. */
const host = {
    id: "github",
    features: ["fetch"],
    readStrategies: [],
    readLocation: () => [],
    formatLocator: () => "",
    matches: (url: string) => url.includes("github.com"),
    canonicalize: (url: string) => ({ host: "github.com", owner: "o", name: "r", httpsUrl: url, sshUrl: url }),
    fetchRecipeTree: async () => {},
    scaffoldFiles: () => [{ path: ".github/workflows/sous-release.yml", content: "name: sous release\n" }],
} satisfies RepositoryHostEntity;

/** An engine with the plugin and its stand-ins. */
function engineWith(extra: PluginDefinition[] = [], reporter = new BufferedReporter()) {
    const plugins = [
        standIn("@sous-io/plugin-git", { "git.runner": realGit() }),
        standIn("@sous-io/plugin-formats", {
            "formats.manifests": manifests,
            "formats.recipe-manifest": recipeManifestParser,
            "formats.repo-manifest": repoManifestParser,
            "formats.index-file": indexFileParser,
            "formats.recipe-hash": recipeHash,
        }),
        standIn("@sous-io/plugin-refs", {
            "refs.resolver": refsResolver(),
            "refs.format": refsFormat,
            "refs.locations": refsLocations(() => [host]),
            "refs.picker": refsPicker,
        }),
        standIn("@sous-io/plugin-variables", { "variables.names": variableNames }),
        standIn("@sous-io/plugin-recipes", {}, [["repository-host", host]]),
        authoringPlugin,
        ...extra,
    ];

    return createEngine({ builtIns: plugins, reporter, app: { name: "sous", version: "1.0.0-test" } });
}

let tmp: TmpDir;

beforeEach(() => {
    tmp = makeTmpDir("sous-authoring-plugin-");
});

afterEach(() => {
    tmp.cleanup();
});

describe("plugin-authoring", () => {
    /** The four intents S6 names, each with today's command words, aliases and arguments. */
    it("should register repo.release, repo.submit, repo.contribute and repo.init", async () => {
        const engine = engineWith();

        await engine.buildConfig();

        const intents = engine.handle.intents;

        for (const name of ["repo.release", "repo.submit", "repo.contribute", "repo.init"]) {
            expect(intents.get(name)?.plugin, name).toBe("@sous-io/plugin-authoring");
        }

        expect(intents.get("repo.submit")?.definition.cli?.positional).toEqual(["repo"]);
        expect(intents.get("repo.contribute")?.definition.cli?.aliases).toContainEqual(["repo", "contrib"]);
        expect(intents.get("repo.release")?.definition.cli?.flags?.yes).toEqual({ short: "y", aliases: ["force"] });
    });

    /** Every input is a flag (L4): each question's answer is a field of the input schema. */
    it("should take every answer to a question as an input field", async () => {
        const engine = engineWith();

        await engine.buildConfig();

        const fields = (name: string) => Object.keys(toJsonSchema(engine.handle.intents.get(name)?.definition.input)?.properties ?? {});

        expect(fields("repo.release")).toEqual(expect.arrayContaining(["yes", "bump", "noBump", "namespace", "recipe", "check", "ci"]));
        expect(fields("repo.submit")).toEqual(expect.arrayContaining(["title", "body", "yes", "nextBranch", "repo"]));
        expect(fields("repo.contribute")).toEqual(expect.arrayContaining(["submit", "yes", "acceptFirst", "title", "body"]));
        expect(fields("repo.init")).toEqual(expect.arrayContaining(["name", "namespace", "force", "host"]));
    });

    /** `repo.init` runs through the engine and writes the host's CI file it is pointed at. */
    it("should scaffold a repository through the engine", async () => {
        const engine = engineWith();
        const directory = path.join(tmp.path, "my-recipes");

        await engine.buildConfig();

        const result = await engine.handle.submit({ intent: "repo.init", input: { directory, host: "github" } });

        expect(result.files).toContain(".github/workflows/sous-release.yml");
        expect(fs.existsSync(path.join(directory, "sous.repo.yaml"))).toBe(true);
    });

    /** A release run through the engine fires `authoring.released` with what it published. */
    it("should fire authoring.released after a release", async () => {
        const directory = path.join(tmp.path, "my-recipes");
        const fired: AuthoringReleasedPayload[] = [];
        const listener = definePlugin({
            name: "listener",
            register(sous) {
                sous.on("authoring.released", (event) => {
                    fired.push(event.payload);
                });
            },
        });
        const engine = engineWith([listener]);

        await engine.buildConfig();
        await engine.handle.submit({ intent: "repo.init", input: { directory } });
        initRepo(directory);
        commitAll(directory, "scaffold");
        await engine.handle.submit({ intent: "repo.release", input: { directory, yes: true } });

        expect(fired).toEqual([{ repository: directory, recipes: [{ key: "my-recipes/example", version: "0.1.0", tag: "my-recipes/example@0.1.0" }], pushed: false }]);
    });
});

describe("plugin-authoring on the command line", () => {
    /** One command of today's CLI, as packages/sous/test/fixtures/command-inventory.json records it. */
    interface InventoryCommand {
        command: string[];
        aliases: string[][];
        args: Array<{ name: string; required: boolean; variadic: boolean }>;
        flags: Array<{ name: string; char?: string; type: string; options?: string[]; multiple?: boolean; aliases?: string[] }>;
    }

    const inventory = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "../../sous/test/fixtures/command-inventory.json"), "utf8")) as {
        commands: InventoryCommand[];
    };
    const mine = inventory.commands.filter((entry) => entry.command[0] === "repo" && ["release", "submit", "contribute", "init"].includes(entry.command[1]!));

    /** Every command, alias, argument and flag of today's `repo release`, `submit`, `contribute` and `init` survives. */
    it.each(mine.map((entry) => [entry.command.join(" "), entry] as const))("should keep every argument and flag of sous %s", async (_name, entry) => {
        const engine = engineWith([cliPlugin]);

        await engine.buildConfig();

        const tree = engine.config.services.get("cli.commands") as CommandTree;
        const lookup = (words: readonly string[]) => {
            const { node, used } = tree.find(words);

            return used === words.length ? node.command : undefined;
        };
        const command = lookup(entry.command)!;

        expect(command, "command").toBeDefined();

        for (const alias of entry.aliases) {
            expect(lookup(alias)?.intent, `alias ${alias.join(" ")}`).toBe(command.intent);
        }

        entry.args.forEach((arg, index) => {
            expect(command.positionals[index]?.name, `argument ${arg.name}`).toBe(arg.name);
        });

        for (const flag of entry.flags) {
            const found = command.flags.find((spec) => spec.name === flag.name || spec.aliases.includes(flag.name));

            expect(found, `--${flag.name}`).toBeDefined();
            expect(found!.kind === "boolean", `--${flag.name} is a boolean`).toBe(flag.type === "boolean");

            for (const alias of flag.aliases ?? []) {
                expect(found!.aliases, `--${alias}`).toContain(alias);
            }

            if (flag.char !== undefined) {
                expect(found!.short, `-${flag.char}`).toBe(flag.char);
            }

            if (flag.options !== undefined) {
                expect(found!.choices, `--${flag.name} options`).toEqual(expect.arrayContaining(flag.options));
            }

            if (flag.multiple === true) {
                expect(found!.multiple, `--${flag.name} repeatable`).toBe(true);
            }
        }
    });
});
