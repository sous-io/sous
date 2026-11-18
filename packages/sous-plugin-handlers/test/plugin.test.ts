import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IntentOutputs, jsonSchema } from "@sous-io/plugin-api";
import type { DoctorCheckResult } from "@sous-io/sous-plugin-doctor";
import { checkHandlersCheck } from "../src/doctor-check.js";
import type { HandlerRunResult } from "../src/types.js";
import { diff, makeEngine, makeTmpDir, plugin, recipe, run, write, type RecipesState } from "./stand-ins.js";

let tmp: { path: string; cleanup(): void };
let state: RecipesState;

beforeEach(() => {
    tmp = makeTmpDir();
    state = { recipes: [], repos: { fixtures: { url: "https://example.com/fixtures.git" } } };
});

afterEach(() => {
    tmp.cleanup();
});

/** A plugin that adds handlers, each reporting its own id at `level`. */
const reporting = (name: string, handlers: Array<{ purpose: string; id: string; level?: "error" | "warn" | "info"; order?: number }>) =>
    plugin(name, (sous) => {
        for (const { purpose, id, level = "info", order } of handlers) {
            sous.handlers.add(purpose as never, {
                id,
                ...(order === undefined ? {} : { order }),
                handle: ((tools: { report: Record<string, (message: string) => void> }) => tools.report[level]!(`ran ${id}`)) as never,
            });
        }
    });

/** The ids of the handlers that ran, in order. */
const ranIds = (result: HandlerRunResult) => result.ran.map((one) => one.id);

describe("check handlers from plugins", () => {
    /**
     * `sous.handlers.add("check", { id, handle })` adds a handler; `handlers.check` runs it. An error
     * fails the checks (exit code 1); a warning does not. What a handler reports reaches the
     * command's reporter.
     *
     * check: a (error), b (warn)  // -> failed: true, errors: 1, warnings: 1
     */
    it("should fail on an error and not on a warning, and hand every report to the reporter", async () => {
        const { engine, reporter } = makeEngine(tmp.path, state, [
            reporting("sous-plugin-a", [
                { purpose: "check", id: "a/needs-jq", level: "error" },
                { purpose: "check", id: "a/likes-pandoc", level: "warn" },
            ]),
        ]);
        await engine.buildConfig();

        const outputs = await engine.submit({ intent: "handlers.check", input: {} } as never, { reporter });
        const result = outputs.toPlain() as unknown as HandlerRunResult;

        expect(result).toMatchObject({ purpose: "check", errors: 1, warnings: 1, failed: true });
        expect(outputs.exitCode).toBe(1);
        expect(reporter.at("error")).toContain("ran a/needs-jq");
        expect(reporter.at("warning")).toContain("ran a/likes-pandoc");
    });

    /**
     * `ignoreFailedChecks` turns errors into warnings: the run does not fail, and the error is
     * shown as a warning saying it was ignored.
     *
     * { ignoreFailedChecks: true }  // -> failed: false, ignoredErrors: 1
     */
    it("should report errors as warnings and not fail when failed checks are ignored", async () => {
        const { engine, reporter } = makeEngine(tmp.path, state, [reporting("sous-plugin-a", [{ purpose: "check", id: "a/needs-jq", level: "error" }])]);
        await engine.buildConfig();

        const result = await run<HandlerRunResult>(engine, reporter, "handlers.check", { ignoreFailedChecks: true });

        expect(result).toMatchObject({ errors: 1, ignoredErrors: 1, failed: false });
        expect(reporter.at("error")).toEqual([]);
        expect(reporter.at("warning").join("\n")).toMatch(/ran a\/needs-jq.*ignored/);
    });

    /**
     * A handler that throws counts as an error naming it; the handlers after it still run. Every
     * call is timed, named by the handler's id.
     */
    it("should report a handler that throws as an error, carry on, and time every call by id", async () => {
        const { engine, reporter } = makeEngine(tmp.path, state, [
            plugin("sous-plugin-a", (sous) => {
                sous.handlers.add("beforeBuild", {
                    id: "a/broken",
                    handle: () => {
                        throw new Error("no network");
                    },
                });
            }),
            reporting("sous-plugin-b", [{ purpose: "beforeBuild", id: "b/after-broken" }]),
        ]);
        await engine.buildConfig();

        const result = await run<HandlerRunResult>(engine, reporter, "handlers.beforeBuild");

        expect(ranIds(result)).toEqual(["a/broken", "b/after-broken"]);
        expect(result.ran[0]?.threw).toBe("no network");
        expect(reporter.at("error").join("\n")).toMatch(/beforeBuild handler a\/broken failed: no network/);
        expect(engine.timings.get("entity.method:handler:a/broken.handle")?.count).toBe(1);
        expect(engine.timings.get("entity.method:handler:b/after-broken.handle")?.count).toBe(1);
    });
});

describe("the order handlers run in", () => {
    /**
     * Plugins' handlers run in the order the plugins loaded, then the order each registered them;
     * recipes' follow, in the lockfile's order and each manifest's order. `order` (default 500)
     * moves one: lower runs earlier.
     */
    it("should run plugins' handlers in load and registration order, then recipes' in lockfile and manifest order, moved by order", async () => {
        const handlerFile = "export function one(sous) { sous.report.info('one'); }\nexport function two(sous) { sous.report.info('two'); }\n";

        state.recipes = [
            recipe(tmp.path, "z/last", { files: { "h.js": handlerFile }, handlers: { afterBuild: [{ file: "h.js", handler: "two" }, { file: "h.js", handler: "one" }] } }),
            recipe(tmp.path, "a/first", { files: { "h.js": handlerFile }, handlers: { afterBuild: [{ file: "h.js", handler: "one" }] } }),
        ];

        const { engine, reporter } = makeEngine(tmp.path, state, [
            reporting("sous-plugin-b", [
                { purpose: "afterBuild", id: "b/1" },
                { purpose: "afterBuild", id: "b/2" },
            ]),
            reporting("sous-plugin-a", [
                { purpose: "afterBuild", id: "a/1" },
                { purpose: "afterBuild", id: "a/early", order: 100 },
            ]),
        ]);
        await engine.buildConfig();

        const result = await run<HandlerRunResult>(engine, reporter, "handlers.afterBuild");

        expect(ranIds(result)).toEqual(["a/early", "b/1", "b/2", "a/1", "z/last/afterBuild/two", "z/last/afterBuild/one", "a/first/afterBuild/one"]);
    });
});

describe("handlers from a recipe's manifest", () => {
    /**
     * A recipe's `handlers` become `recipes.handlers` values, then `handler` entities whose
     * function is the named export of the file, imported when it first runs.
     *
     * handlers: { check: [{ file: "handlers/prerequisites.js", handler: "checkCommands" }] }
     * // -> recipes.handlers: [{ recipe: "voltagrid/knowledge-worker", purpose: "check", ... }]
     * // -> handler entity "voltagrid/knowledge-worker/check/checkCommands"
     */
    it("should add the manifest's handlers to the config and run the named exports", async () => {
        state.recipes = [
            recipe(tmp.path, "voltagrid/knowledge-worker", {
                files: {
                    "handlers/prerequisites.js": [
                        "export async function checkCommands(sous) {",
                        "    if (!(await sous.utils.system.isAppAvailable('node'))) sous.report.error('node is not installed.');",
                        "    if (!(await sous.utils.system.isAppAvailable('sous-test-no-such-command'))) sous.report.warn('sous-test-no-such-command is not installed.');",
                        "}",
                    ].join("\n"),
                },
                handlers: { check: [{ file: "handlers/prerequisites.js", handler: "checkCommands" }] },
            }),
        ];

        const { engine, reporter } = makeEngine(tmp.path, state);
        const built = await engine.buildConfig();

        expect(built.get("recipes.handlers")).toEqual([
            { recipe: "voltagrid/knowledge-worker", purpose: "check", file: "handlers/prerequisites.js", handler: "checkCommands" },
        ]);

        const result = await run<HandlerRunResult>(engine, reporter, "handlers.check");

        expect(ranIds(result)).toEqual(["voltagrid/knowledge-worker/check/checkCommands"]);
        expect(result).toMatchObject({ errors: 0, warnings: 1, failed: false });
        expect(reporter.at("warning")).toContain("sous-test-no-such-command is not installed.");
    });

    /**
     * Only a recipe held through `subscribes`, from a trusted and switched-on repository, adds
     * handlers. A file outside the recipe is refused with a warning.
     */
    it("should leave out recipes held only through depends, recipes from untrusted or switched-off repositories, and files outside the recipe", async () => {
        const handlers = { check: [{ file: "h.js", handler: "check" }] };
        const files = { "h.js": "export function check(sous) { sous.report.info('ran'); }\n" };

        state.repos.off = { url: "https://example.com/off.git", enabled: false };
        state.recipes = [
            recipe(tmp.path, "lib/only-depends", { kind: "depends", files, handlers }),
            recipe(tmp.path, "un/trusted", { repo: "nobody", files, handlers }),
            recipe(tmp.path, "switched/off", { repo: "off", files, handlers }),
            recipe(tmp.path, "out/side", { handlers: { check: [{ file: "../../../../escape.js", handler: "check" }] } }),
        ];

        const { engine, reporter } = makeEngine(tmp.path, state);
        await engine.buildConfig();

        const result = await run<HandlerRunResult>(engine, reporter, "handlers.check");

        expect(result.ran).toEqual([]);
        expect(reporter.at("warning").join("\n")).toMatch(/out\/side names a handler file outside its own files/);
    });

    /** A listed export that does not exist fails that handler with a message naming the recipe. */
    it("should report a handler whose file does not export the named function", async () => {
        state.recipes = [recipe(tmp.path, "a/r", { files: { "h.js": "export const x = 1;\n" }, handlers: { check: [{ file: "h.js", handler: "missing" }] } })];

        const { engine, reporter } = makeEngine(tmp.path, state);
        await engine.buildConfig();

        const result = await run<HandlerRunResult>(engine, reporter, "handlers.check");

        expect(result.failed).toBe(true);
        expect(reporter.at("error").join("\n")).toMatch(/a\/r lists the handler missing in h\.js, which does not export a function by that name/);
    });
});

describe("what a handler receives", () => {
    /**
     * The full context (`run`, `services`, the finished config) plus the helpers: `project.root`,
     * `config.get`, `vars.get`, `utils.process.run`, `utils.file.*` and `utils.files.removeMatching`.
     */
    it("should give the context and the helpers, working on the project's files", async () => {
        write(tmp.path, "keep.txt", "kept");
        write(tmp.path, "docs/context/.kw-session-1", "x");
        write(tmp.path, "docs/context/.kw-session-2", "x");
        write(tmp.path, "gone.txt", "x");

        let seen: Record<string, unknown> = {};
        const { engine, reporter } = makeEngine(tmp.path, state, [
            plugin("sous-plugin-a", (sous) => {
                sous.config.contribute({ id: "a/settings", contribute: (config) => config.atPath("recipes.example").set("value") });
                sous.handlers.add("afterBuild", {
                    id: "a/everything",
                    handle: (async (tools: any) => {
                        const node = await tools.utils.process.run("node", ["-e", "process.stdout.write(process.cwd())"]);

                        seen = {
                            root: tools.project.root,
                            config: tools.config.get("recipes.example"),
                            variable: tools.vars.get("anything"),
                            hasServices: tools.services.has("handlers.system"),
                            canRun: typeof tools.run,
                            cwd: node.stdout,
                            exitCode: node.exitCode,
                            exists: await tools.utils.file.exists("keep.txt"),
                            missing: await tools.utils.file.exists("nope.txt"),
                            read: await tools.utils.file.read("keep.txt"),
                            readMissing: await tools.utils.file.read("nope.txt"),
                            removed: await tools.utils.file.remove("gone.txt"),
                            removedMissing: await tools.utils.file.remove("gone.txt"),
                            matched: await tools.utils.files.removeMatching("docs/context/.kw-session-*"),
                            version: await tools.utils.system.appVersion("node"),
                        };
                    }) as never,
                });
            }),
        ]);
        await engine.buildConfig();
        await run(engine, reporter, "handlers.afterBuild");

        expect(seen).toMatchObject({
            root: tmp.path,
            config: "value",
            variable: undefined,
            hasServices: true,
            canRun: "function",
            cwd: tmp.path,
            exitCode: 0,
            exists: true,
            missing: false,
            read: "kept",
            readMissing: undefined,
            removed: true,
            removedMissing: false,
            matched: ["docs/context/.kw-session-1", "docs/context/.kw-session-2"],
            version: process.versions.node,
        });
        expect(fs.existsSync(path.join(tmp.path, "docs/context/.kw-session-1"))).toBe(false);
    });

    /**
     * `sous.editor.file` goes to the `editor` service when one is registered, and fails with a
     * message naming sous-plugin-editor when none is.
     */
    it("should edit through the editor service when there is one, and say which plugin is missing when there is not", async () => {
        const handler = plugin("sous-plugin-a", (sous) => {
            sous.handlers.add("afterBuild", { id: "a/edit", handle: ((tools: any) => tools.report.info(String(tools.editor.file("CLAUDE.md")))) as never });
        });

        const without = makeEngine(tmp.path, state, [handler]);
        await without.engine.buildConfig();
        await run(without.engine, without.reporter, "handlers.afterBuild");

        expect(without.reporter.at("error").join("\n")).toMatch(/sous\.editor\.file needs the document editor .*sous-plugin-editor/);

        const editor = plugin("@sous-io/sous-plugin-editor", (sous) => {
            sous.services.add("editor" as never, (() => ({ file: (file: string) => `editing ${file}` })) as never);
        });
        const withEditor = makeEngine(tmp.path, state, [editor, handler]);
        await withEditor.engine.buildConfig();
        await run(withEditor.engine, withEditor.reporter, "handlers.afterBuild");

        expect(withEditor.reporter.at("info")).toContain("editing CLAUDE.md");
    });
});

describe("configure handlers", () => {
    /**
     * A recipe's `configure` handler runs while the config is built, as a contributor Sous adds on
     * the recipe's behalf, and receives the config builder.
     *
     * export function declareEdits(sous, { config }) { config.atPath("recipes.declared").set(...) }
     * // -> the finished config holds recipes.declared
     */
    it("should run during config building with the builder, and its values reach the config", async () => {
        state.recipes = [
            recipe(tmp.path, "voltagrid/knowledge-worker", {
                files: {
                    "handlers/edits.js": [
                        "export function declareEdits(sous, { config }) {",
                        "    config.atPath('recipes.declared').set({ root: sous.project.root, seen: sous.config.get('recipes.example') ?? null });",
                        "}",
                    ].join("\n"),
                },
                handlers: { configure: [{ file: "handlers/edits.js", handler: "declareEdits" }] },
            }),
        ];

        const { engine } = makeEngine(tmp.path, state, [
            plugin("sous-plugin-a", (sous) => sous.config.contribute({ id: "a/settings", contribute: (config) => config.atPath("recipes.example").set("value") })),
        ]);
        const built = await engine.buildConfig();

        expect(built.get("recipes.declared")).toEqual({ root: tmp.path, seen: "value" });
    });
});

describe("migrate, uninstall and check on subscribing", () => {
    const migrateFile = "export function migrate(sous, { from, to }) { sous.report.info(`migrated from ${from} to ${to}`); }\n";

    /**
     * When the lockfile's pin for a recipe moves, its `migrate` handlers run once the config holds
     * the new version, given `{ from, to }`, and only once.
     *
     * acme/tool 1.0.0 -> 2.0.0  // -> "migrated from 1.0.0 to 2.0.0", once
     */
    it("should run the new version's migrate handlers once, after the pin moved and its files are in place", async () => {
        state.recipes = [recipe(tmp.path, "acme/tool", { version: "1.0.0", files: { "m.js": migrateFile }, handlers: { migrate: [{ file: "m.js", handler: "migrate" }] } })];

        const next = {
            diff: diff({ updated: [{ key: "acme/tool", from: "1.0.0", to: "2.0.0" }] }),
            recipes: [recipe(tmp.path, "acme/tool", { version: "2.0.0", files: { "m.js": migrateFile }, handlers: { migrate: [{ file: "m.js", handler: "migrate" }] } })],
        };
        const { engine, reporter } = makeEngine(tmp.path, state, [], next);
        await engine.buildConfig();

        await run(engine, reporter, "subscription.update");
        await engine.buildConfig();

        expect(reporter.at("info").filter((line) => line.startsWith("migrated"))).toEqual(["migrated from 1.0.0 to 2.0.0"]);
    });

    /**
     * `sous subscription remove` runs the removed recipe's `uninstall` handlers once the lockfile no
     * longer pins it, while its files and handlers are still there. A dry run runs nothing.
     */
    it("should run a removed recipe's uninstall handlers, and nothing on a dry run", async () => {
        const files = { "u.js": "export function removeSessionFiles(sous) { sous.report.info('uninstalled ' + sous.project.root); }\n" };

        state.recipes = [recipe(tmp.path, "acme/tool", { files, handlers: { uninstall: [{ file: "u.js", handler: "removeSessionFiles" }] } })];

        const { engine, reporter } = makeEngine(tmp.path, state, [], { diff: diff({ removed: [{ key: "acme/tool", from: "1.0.0" }] }), recipes: [] });
        await engine.buildConfig();

        await run(engine, reporter, "subscription.remove", { dryRun: true });
        expect(reporter.at("info").filter((line) => line.startsWith("uninstalled"))).toEqual([]);

        await run(engine, reporter, "subscription.remove");
        expect(reporter.at("info").filter((line) => line.startsWith("uninstalled"))).toEqual([`uninstalled ${tmp.path}`]);
    });

    /**
     * `sous subscription add --no-build` has no build to run the checks, so the new recipes'
     * `check` handlers run on their own.
     */
    it("should run the new recipes' checks after subscribing without a build", async () => {
        const files = { "c.js": "export function check(sous) { sous.report.warn('checked on subscribing'); }\n" };
        const added = recipe(tmp.path, "acme/tool", { files, handlers: { check: [{ file: "c.js", handler: "check" }] } });

        const { engine, reporter } = makeEngine(tmp.path, state, [], { diff: diff({ added: [{ key: "acme/tool", to: "1.0.0" }] }), recipes: [added] });
        await engine.buildConfig();

        await run(engine, reporter, "subscription.add", { noBuild: true });

        expect(reporter.at("warning")).toContain("checked on subscribing");
    });
});

describe("the check handlers doctor check", () => {
    /** A plugin whose intent runs the doctor check, as `sous doctor` would. */
    const doctor = plugin("test-doctor", (sous) => {
        sous.intents.add({
            intent: "test.doctor",
            input: jsonSchema({ type: "object" }),
            handle: async (input, ctx) =>
                IntentOutputs.of((await checkHandlersCheck.check(ctx, { dryRun: true, yes: false, answers: [], configFailed: (input as { configFailed?: boolean }).configFailed === true })) as never),
        });
    });

    /**
     * The check runs the check handlers without printing, and reports their errors as a problem and
     * their warnings as a warning, one line each.
     *
     * check: a (error), b (warn)  // -> problem, details ["a/needs-jq: ran a/needs-jq", "a/likes-pandoc: ..."]
     */
    it("should report errors as a problem and warnings as a warning, printing nothing", async () => {
        const { engine, reporter } = makeEngine(tmp.path, state, [
            reporting("sous-plugin-a", [
                { purpose: "check", id: "a/needs-jq", level: "error" },
                { purpose: "check", id: "a/likes-pandoc", level: "warn" },
            ]),
            doctor,
        ]);
        await engine.buildConfig();

        const found = await run<DoctorCheckResult>(engine, reporter, "test.doctor");

        expect(found).toMatchObject({ status: "problem", details: ["a/needs-jq: ran a/needs-jq", "a/likes-pandoc: ran a/likes-pandoc"] });
        expect(reporter.at("error")).toEqual([]);
        expect(reporter.at("warning")).toEqual([]);
    });

    /**
     * Only warnings is a warning; no check handler, or a config that did not load, is said plainly.
     */
    it("should report a warning, nothing to run, and a config that did not load", async () => {
        const warned = makeEngine(tmp.path, state, [reporting("sous-plugin-a", [{ purpose: "check", id: "a/likes-pandoc", level: "warn" }]), doctor]);
        await warned.engine.buildConfig();
        expect(await run<DoctorCheckResult>(warned.engine, warned.reporter, "test.doctor")).toMatchObject({ status: "warning" });

        const none = makeEngine(tmp.path, state, [doctor]);
        await none.engine.buildConfig();
        expect(await run<DoctorCheckResult>(none.engine, none.reporter, "test.doctor")).toMatchObject({ status: "ok" });
        expect(await run<DoctorCheckResult>(none.engine, none.reporter, "test.doctor", { configFailed: true })).toMatchObject({ status: "skipped" });
    });
});
