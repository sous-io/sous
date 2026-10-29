/**
 * Expressions inside the real config loop (S2, "Config expressions are part of the same loop"):
 * each file's contributor evaluates its data before merging it, every variable read re-runs the
 * file when it changes, a filter added later re-runs it, and what is still unknown once the config
 * settles fails the build.
 */

import { createEngine } from "@sous-io/core";
import {
    BufferedReporter,
    ConfigError,
    definePlugin,
    jsonSchema,
    type BuiltConfig,
    type ContributorDefinition,
    type JsonValue,
    type PluginDefinition,
} from "@sous-io/plugin-api";
import { describe, expect, it } from "vitest";
import { expressionsPlugin, type Evaluator } from "../src/index.js";
import { hostPlugin } from "@sous-io/plugin-host";
import { liquidPlugin } from "@sous-io/plugin-liquid";
import { variablesPlugin } from "@sous-io/plugin-variables";
import { answersSource, filterEntity } from "./helpers.js";

/** One contributor per file, as plugin-confd adds them: evaluate, then merge at the root. */
function filesPlugin(files: Array<{ file: string; data: unknown }>, extra: ContributorDefinition[] = [], runs: Record<string, number> = {}): PluginDefinition {
    return definePlugin({
        name: "test-files",
        version: "1.0.0",
        register(sous) {
            for (const key of ["subscriptions", "flags"]) {
                sous.entities.add("config-key", { id: key, schema: jsonSchema({}) });
            }

            for (const { file, data } of files) {
                sous.config.contribute({
                    id: file,
                    contribute(config) {
                        runs[file] = (runs[file] ?? 0) + 1;

                        const evaluated = sous.services.get("expressions.evaluator").evaluateLayer(data as JsonValue, { file, config });

                        if (evaluated.value !== undefined) {
                            config.root().merge(evaluated.value);
                        }
                    },
                });
            }

            for (const contributor of extra) {
                sous.config.contribute(contributor);
            }
        },
    });
}

function engineWith(...plugins: PluginDefinition[]) {
    return createEngine({ builtIns: [hostPlugin, liquidPlugin, variablesPlugin, expressionsPlugin, ...plugins], reporter: new BufferedReporter() });
}

describe("expressions in the config loop", () => {
    it("re-runs a file when a variable it read is set by a later file (S2's machineRole example)", async () => {
        const runs: Record<string, number> = {};
        const engine = engineWith(
            filesPlugin(
                [
                    { file: "a-sous.config.jsonc", data: { _vars: { team: "core" } } },
                    {
                        file: "b-610-browser.jsonc",
                        data: { flags: { browser: { $if: { expr: "machineRole == 'laptop'", then: true }, $else: false } } },
                    },
                    { file: "c-700-ci.jsonc", data: { _vars: { machineRole: "ci" } } },
                ],
                [],
                runs,
            ),
        );

        const built = await engine.buildConfig();

        expect(built.get("flags")).toEqual({ browser: false });
        expect(runs["b-610-browser.jsonc"]).toBeGreaterThanOrEqual(2);
        expect(built.services.get("expressions.evaluator").evaluations("b-610-browser.jsonc")[0]!.reads).toEqual({ machineRole: "ci" });
    });

    it("evaluates a filter added in a later pass, and settles", async () => {
        const engine = engineWith(
            filesPlugin(
                [{ file: "a-610.jsonc", data: { flags: { ci: { $if: "'1' | is_truthy" } } } }],
                [{ id: "z-late-filter", contribute: (config) => config.addEntity("liquid-filter", filterEntity("is_truthy", (value) => value === "1")) }],
            ),
        );

        const built = await engine.buildConfig();

        expect(built.get("flags")).toEqual({ ci: true });
        expect(built.services.get("expressions.evaluator").unsettled()).toEqual([]);
    });

    // The config.built listener throws these errors, but core's buildConfig returns from a
    // `finally` block, which drops an error a config.built listener throws. Until core is fixed,
    // these check what the listener sees and throws.
    it("leaves a filter that never appears unsettled once the config settles, which settle() reports", async () => {
        const engine = engineWith(filesPlugin([{ file: "a-610.jsonc", data: { flags: { ci: { $if: "'1' | is_truthy" } } } }]));
        const built = await engine.buildConfig().catch((error: unknown) => error);

        expect(built).not.toBeInstanceOf(Error);
        const evaluator = (built as BuiltConfig).services.get("expressions.evaluator") as Evaluator;

        expect(evaluator.unsettled()).toEqual([{ file: "a-610.jsonc", path: "flags.ci", unknown: { variables: [], filters: ["is_truthy"] } }]);
        expect(() => evaluator.settle()).toThrow(/flags\.ci uses the Liquid filter is_truthy, which no plugin adds/);
    });

    it("leaves a variable that is never set unsettled once the config settles", async () => {
        const engine = engineWith(filesPlugin([{ file: "a-610.jsonc", data: { flags: { x: { $expr: "machineRole" } } } }]));
        const built = (await engine.buildConfig()) as BuiltConfig;
        const evaluator = built.services.get("expressions.evaluator") as Evaluator;

        expect(evaluator.unsettled()[0]!.unknown.variables).toEqual(["machineRole"]);
        expect(() => evaluator.settle()).toThrow(ConfigError);
    });

    it("refuses a recipe answer read under subscriptions", async () => {
        const answers = definePlugin({
            name: "test-answers",
            version: "1.0.0",
            register: (sous) => sous.entities.add("variable-source", answersSource({ githubProjectId: "42" })),
        });
        const engine = engineWith(
            answers,
            filesPlugin([{ file: "conf.d/610-team.jsonc", data: { subscriptions: { "workflow/github-projects": { enabled: { $if: "githubProjectId" } } } } }]),
        );

        await expect(engine.buildConfig()).rejects.toThrow(/reads githubProjectId, which is an answer to a recipe/);
    });

    it("lists the languages, Liquid first", async () => {
        const engine = engineWith(filesPlugin([]));
        const built = await engine.buildConfig();

        expect(built.services.get("expressions.evaluator").languages()).toEqual(["liquid"]);
    });
});
