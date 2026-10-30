import { ConfigError, type PluginInfo } from "@sous-io/plugin-api";
import { describe, expect, it } from "vitest";
import type { CliViewContext } from "../../types.js";
import { Printer } from "../printer.js";
import { createStyle } from "../style.js";
import { stripAnsi } from "../text.js";
import { type ConfigGetResult, views } from "./inspect.js";

/** A view context: plain 100 columns, or colored like a terminal. */
function context(intent: string, options: { color?: boolean } = {}): CliViewContext {
    const style = createStyle(options.color ?? false);

    return {
        intent,
        input: {},
        globals: {},
        style,
        columns: 100,
        isTTY: options.color ?? false,
        printer: () => new Printer(style, 100, options.color ?? false),
        render: async () => "",
    };
}

async function show(intent: string, result: unknown, options: { color?: boolean } = {}): Promise<unknown> {
    return views[intent]!(result, context(intent, options));
}

describe("the config views", () => {
    /**
     * `sous config show` prints the config as pretty JSON; colored only on a terminal, so a pipe
     * still parses.
     */
    it("should print the config as JSON, colored only on a terminal", async () => {
        const result = { config: { name: "demo", n: 1 }, passes: 1 };
        const plain = (await show("config.show", result)) as string;
        const colored = (await show("config.show", result, { color: true })) as string;

        expect(JSON.parse(plain)).toEqual({ name: "demo", n: 1 });
        expect(colored).toContain("\u001b[36m\"name\"\u001b[39m");
        expect(stripAnsi(colored)).toBe(plain);
    });

    /** A scalar prints raw, without quotes; an object as JSON. */
    it("should print a scalar raw and an object as JSON", async () => {
        const scalar: ConfigGetResult = { path: "name", exists: true, value: "demo", passes: 1 };
        const object: ConfigGetResult = { path: "tools", exists: true, value: { claude: { enabled: true } }, passes: 1 };

        expect(await show("config.get", scalar)).toBe("demo\n");
        expect(JSON.parse((await show("config.get", object)) as string)).toEqual({ claude: { enabled: true } });
    });

    /** A path with nothing at it is a ConfigError, as before (exit code 1). */
    it("should throw a ConfigError for a missing path", async () => {
        const missing: ConfigGetResult = { path: "nope", exists: false, value: undefined, passes: 1 };

        await expect(show("config.get", missing)).rejects.toThrow(ConfigError);
        await expect(show("config.get", missing)).rejects.toThrow("No value at config path 'nope'.");
    });

    /**
     * `--layers` on a path: each contributor's change, then the result.
     *
     * ```text
     * config-files/sous.config.jsonc   "demo"
     * confd/610-mac.jsonc              "demo-mac"
     * result                           "demo-mac"   (settled after 2 passes)
     * ```
     */
    it("should show each contributor's change to a value, then the result", async () => {
        const result: ConfigGetResult = {
            path: "name",
            exists: true,
            value: "demo-mac",
            passes: 2,
            layers: [
                { contributor: "config-files/sous.config.jsonc", plugin: "p", patch: { op: "setKey", path: "", key: "name", value: "demo" }, helpers: [], applyOrder: 0, actualApplyOrder: 0 },
                {
                    contributor: "confd/610-mac.jsonc",
                    plugin: "p",
                    patch: { op: "setKey", path: "", key: "name", value: "demo-mac" },
                    helpers: [],
                    applyOrder: 0,
                    actualApplyOrder: 0,
                    annotations: { expression: "host.platform == 'darwin'" },
                },
            ],
        };

        expect(await show("config.get", result)).toBe(
            [
                'config-files/sous.config.jsonc   "demo"',
                'confd/610-mac.jsonc              "demo-mac"',
                "                                 expression: host.platform == 'darwin'",
                'result                           "demo-mac"   (settled after 2 passes)',
                "",
            ].join("\n"),
        );
    });

    /**
     * `--layers` with what each config file did to the value: the file on the left, the old value
     * and the new one on the right, as the old CLI printed them.
     *
     * ```text
     * sous.config.json          (unset) -> "primary-name"
     * conf.d/10-override.json   "primary-name" -> "overridden-name"
     * result                    "overridden-name"   (settled after 1 pass)
     * ```
     */
    it("should show each file's change as old -> new", async () => {
        const result: ConfigGetResult = {
            path: "name",
            exists: true,
            value: "overridden-name",
            passes: 1,
            layers: [
                {
                    contributor: "config-files.main",
                    plugin: "p",
                    source: "sous.config.json",
                    patch: { op: "setKey", path: "", key: "name", value: "primary-name" },
                    helpers: [],
                    applyOrder: 0,
                    actualApplyOrder: 0,
                    change: { to: "primary-name" },
                },
                {
                    contributor: "confd/10-override.json",
                    plugin: "p",
                    source: "conf.d/10-override.json",
                    patch: { op: "setKey", path: "", key: "name", value: "overridden-name" },
                    helpers: [],
                    applyOrder: 0,
                    actualApplyOrder: 0,
                    change: { from: "primary-name", to: "overridden-name" },
                },
            ],
        };

        expect(await show("config.get", result)).toBe(
            [
                'sous.config.json          (unset) -> "primary-name"',
                'conf.d/10-override.json   "primary-name" -> "overridden-name"',
                'result                    "overridden-name"   (settled after 1 pass)',
                "",
            ].join("\n"),
        );
    });

    /**
     * `config show --layers` nests each change under the helpers that made it, and names each
     * contributor's apply order, with the number it moved to when `before` or `after` moved it.
     */
    it("should show the whole config's layers as a tree", async () => {
        const result = {
            config: {},
            passes: 1,
            layers: [
                {
                    contributor: "confd/620-no-diagrams.js",
                    plugin: "@sous-io/plugin-confd",
                    patch: { op: "removeIndex", path: "compilation.targets", index: 7 },
                    helpers: ["removeWhere"],
                    applyOrder: 90620,
                    actualApplyOrder: 90620,
                },
                {
                    contributor: "late-fixups",
                    plugin: "plugin-x",
                    patch: { op: "setKey", path: "compilation", key: "overwriteUntracked", value: false },
                    helpers: [],
                    applyOrder: 0,
                    actualApplyOrder: 90621,
                },
            ],
        };

        expect(await show("config.show", result)).toBe(
            [
                "confd/620-no-diagrams.js (@sous-io/plugin-confd, apply order 90620)",
                "  removeWhere",
                "    removeIndex compilation.targets[7]",
                "late-fixups (plugin-x, apply order 0, moved to 90621)",
                "  setKey compilation.overwriteUntracked = false",
                "result  settled after 1 pass",
                "",
            ].join("\n"),
        );
    });

    /** `config validate`: "Config is valid", or each problem and exit code 1. */
    it("should say the config is valid, or list each problem and fail", async () => {
        expect(await show("config.validate", { ok: true, issues: [] })).toContain("▶ Config is valid.".replace(".", ":"));

        const failed = (await show("config.validate", { ok: false, issues: ["tools.x: Expected object (set by confd/1.js)"] })) as { stdout: string; exitCode: number };

        expect(failed.exitCode).toBe(1);
        expect(failed.stdout).toContain("The config has 1 problem:");
        expect(failed.stdout).toContain("✗ tools.x: Expected object (set by confd/1.js)");
    });

    /** A valid config lists what was checked: the file, the layers, the targets and the tools. */
    it("should list what was checked under a valid config", async () => {
        const summary = { configFile: "/p/.sous/sous.config.json", layers: 3, targets: 2, tools: ["claude"] };
        const text = (await show("config.validate", { ok: true, issues: [], summary })) as string;

        expect(text).toContain("Config File: /p/.sous/sous.config.json");
        expect(text).toMatch(/Layers\s*: 3/);
        expect(text).toMatch(/Targets\s*: 2/);
        expect(text).toMatch(/Tools\s*: claude/);
    });

    /** A problem of several lines keeps its lines, indented under the first. */
    it("should indent the later lines of a problem under its first", async () => {
        const failed = (await show("config.validate", { ok: false, issues: ["Unresolved variables in _vars:\n- thing still needs ${bogus}"] })) as { stdout: string };

        expect(failed.stdout).toContain("✗ Unresolved variables in _vars:\n      - thing still needs ${bogus}");
    });
});

describe("the plugins and timings views", () => {
    /** `sous plugins show`, the way it is laid out. */
    it("should list each plugin with what it registered", async () => {
        const plugins: PluginInfo[] = [
            {
                name: "plugin-claude-code",
                version: undefined,
                active: true,
                builtIn: true,
                loadedBy: undefined,
                registrations: [
                    { kind: "entity", name: "harness: claude" },
                    { kind: "entity", name: "skill-target: claude-code" },
                    { kind: "listener", name: "build.after" },
                ],
                options: undefined,
            },
            {
                name: "sous-plugin-mcp-extras",
                version: undefined,
                active: true,
                builtIn: false,
                loadedBy: "sous-plugin-claude-code",
                registrations: [],
                options: { port: 7801 },
            },
        ];

        expect(await show("plugins.show", plugins)).toBe(
            [
                "plugin-claude-code (built in)",
                "  entities           harness: claude    skill-target: claude-code",
                "  listeners          build.after",
                "sous-plugin-mcp-extras (loaded by sous-plugin-claude-code)",
                '  options            { "port": 7801 }',
                "",
            ].join("\n"),
        );
    });

    /** `sous timings show` uses the `--timings` layout, and says so when there are none. */
    it("should list timings, or say there are none", async () => {
        expect(await show("timings.show", [])).toBe("No timings yet.\n");
        expect(
            await show("timings.show", [{ key: "intent:build", category: "intent", name: "build", plugin: "p", count: 1, totalMs: 5, maxMs: 5, budgetMs: 100, overBudget: 0 }]),
        ).toContain("intent:build");
    });

    /** `sous version` prints `v` and the version, as `sous --version` did before the refactor. */
    it("should print the version with a v, and more with --verbose", async () => {
        expect(await show("version", "1.2.3")).toBe("v1.2.3\n");

        const verbose = (await show("version", { name: "@sous-io/sous", version: "1.2.3" })) as string;

        expect(verbose).toMatch(/^v1\.2\.3\n {4}Package : @sous-io\/sous\n {4}Platform: .+\n {4}Node {4}: v\d+/);
    });
});
