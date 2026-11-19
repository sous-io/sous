/**
 * A project with a real engine, for tests that go through `editor.apply` itself: a test plugin
 * declares entries in `editor.edits` (as objects, or with the chain and `expect`), the config is
 * built, and the `editor.apply` intent applies the list to real files in a temporary folder.
 *
 * ```ts
 * const project = editorProject(tmp.path);
 *
 * project.write("a.jsonc", '{ "a": 1 }\n');
 * const { result, warnings } = await project.apply([{ file: "a.jsonc", set: { path: "a", value: 2 } }]);
 * ```
 */

import fs from "node:fs";
import path from "node:path";
import { BufferedReporter, definePlugin, jsonSchema, type ConfigBuilder, type JsonObject, type JsonValue } from "@sous-io/sous-plugin-api";
import { createEngine } from "@sous-io/sous-lib-core";
import { doctorPlugin } from "@sous-io/sous-plugin-doctor";
import editorPlugin from "../src/index.js";
import type { EditorApplyResult } from "../src/types.js";

/** What one run of `editor.apply` gave. */
export interface EditorRun {
    readonly result: EditorApplyResult;
    readonly warnings: string[];
    readonly errors: string[];
    /** `editor.edits` as the config built it. */
    readonly edits: JsonValue[];
}

/** What a run declares: entries as objects, or a contributor that uses the chain and `expect`. */
export type Declaration = readonly JsonObject[] | ((config: ConfigBuilder) => void);

/** A project whose edits are applied by the real `editor.apply`. */
export interface EditorProject {
    readonly root: string;
    /** Declares this (replacing what the last run declared), builds the config and runs `editor.apply`. */
    apply(declaration: Declaration, input?: { dryRun?: boolean; ignoreFailedAssertions?: boolean }): Promise<EditorRun>;
    /** Writes a file under the root, creating its folders. */
    write(file: string, text: string): void;
    /** Reads a file under the root, or `undefined`. */
    read(file: string): string | undefined;
}

/** Stands in for sous-plugin-compiler and sous-plugin-variables, which the editor depends on. */
const standIns = (["@sous-io/sous-plugin-compiler", "@sous-io/sous-plugin-variables"] as const).map((name) =>
    definePlugin({ name, version: editorPlugin.version, register() {} }),
);

/** A project in `root` (an empty temporary folder). */
export function editorProject(root: string): EditorProject {
    let declaration: Declaration = [];

    const declaring = definePlugin({
        name: "test-declarer",
        version: "1.0.0",
        register(sous) {
            sous.config.contribute({
                id: "test-declarer/edits",
                contribute(config) {
                    if (typeof declaration === "function") {
                        declaration(config);

                        return;
                    }

                    for (const entry of declaration) {
                        config.atPath("editor.edits").appendValue(structuredClone(entry));
                    }
                },
            });
        },
    });

    const runner = definePlugin({
        name: "test-runner",
        version: "1.0.0",
        register(sous) {
            sous.intents.add({
                intent: "test.apply",
                input: jsonSchema({ type: "object" }),
                handle: async (input, ctx) => (await ctx.run("editor.apply", input as Record<string, unknown>)) as never,
            });
        },
    });

    const reporter = new BufferedReporter();
    const sousDir = path.join(root, ".sous");

    fs.mkdirSync(sousDir, { recursive: true });

    const engine = createEngine({
        builtIns: [...standIns, doctorPlugin, editorPlugin, runner, declaring],
        reporter,
        project: { root, sousDir, configPath: undefined, confDir: path.join(sousDir, "conf.d") },
        cwd: root,
    });

    return {
        root,
        async apply(next, input = {}) {
            declaration = next;
            reporter.messages.length = 0;

            const built = await engine.buildConfig();
            const result = (await engine.submit({ intent: "test.apply", input })).toPlain() as unknown as EditorApplyResult;

            return {
                result,
                warnings: reporter.at("warning"),
                errors: reporter.at("error"),
                edits: (built.get("editor.edits") as JsonValue[] | undefined) ?? [],
            };
        },
        write(file, text) {
            const full = path.join(root, file);

            fs.mkdirSync(path.dirname(full), { recursive: true });
            fs.writeFileSync(full, text, "utf8");
        },
        read(file) {
            try {
                return fs.readFileSync(path.join(root, file), "utf8");
            } catch {
                return undefined;
            }
        },
    };
}
