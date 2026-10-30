import { BufferedReporter, ConfigError, type PluginInfo, ReportEntryStyle } from "@sous-io/plugin-api";
import { describe, expect, it } from "vitest";
import type { CliViewContext } from "../../types.js";
import { captureView } from "../testing.js";
import { type ConfigGetResult, views } from "./inspect.js";

/** Runs a view and returns what a terminal would show (colors off). */
async function show(intent: string, result: unknown) {
    return captureView(views[intent]!, result, { intent });
}

/** Runs a view against a buffering reporter, to read the styles and facts it reported. */
async function reported(intent: string, result: unknown): Promise<BufferedReporter> {
    const reporter = new BufferedReporter();
    const context: CliViewContext = { intent, input: {}, globals: {}, reporter, show: async () => {} };

    await views[intent]!(result, context);

    return reporter;
}

describe("the config views", () => {
    /** `sous config show` reports the config as data, which a terminal prints as pretty JSON. */
    it("should print the config as JSON", async () => {
        const result = { config: { name: "demo", n: 1 }, passes: 1 };
        const shown = await show("config.show", result);
        const messages = (await reported("config.show", result)).styled(ReportEntryStyle.Data);

        expect(JSON.parse(shown.stdout)).toEqual({ name: "demo", n: 1 });
        expect(messages).toHaveLength(1);
        expect(messages[0]!.details).toEqual({ value: { name: "demo", n: 1 } });
    });

    /** A scalar prints raw, without quotes; an object as JSON. */
    it("should print a scalar raw and an object as JSON", async () => {
        const scalar: ConfigGetResult = { path: "name", exists: true, value: "demo", passes: 1 };
        const object: ConfigGetResult = { path: "tools", exists: true, value: { claude: { enabled: true } }, passes: 1 };

        expect((await show("config.get", scalar)).stdout.trim()).toBe("demo");
        expect(JSON.parse((await show("config.get", object)).stdout)).toEqual({ claude: { enabled: true } });
        expect((await reported("config.get", scalar)).styled(ReportEntryStyle.Text).map((entry) => entry.message)).toEqual(["demo"]);
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

        const shown = (await show("config.get", result)).stdout;

        expect(shown).toContain("config-files/sous.config.jsonc");
        expect(shown).toContain('"demo"');
        expect(shown).toContain("confd/610-mac.jsonc");
        expect(shown).toContain('"demo-mac"');
        expect(shown).toContain("expression: host.platform == 'darwin'");
        expect(shown.indexOf("confd/610-mac.jsonc")).toBeLessThan(shown.indexOf("result"));
        expect(shown).toMatch(/result\s*:?\s*"demo-mac"/);
        expect(shown).toContain("settled after 2 passes");
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

        const shown = (await show("config.get", result)).stdout;

        expect(shown).toContain('(unset) -> "primary-name"');
        expect(shown).toContain('"primary-name" -> "overridden-name"');
        expect(shown).toContain("conf.d/10-override.json");
        expect(shown).toContain("settled after 1 pass");
        expect(shown).not.toContain("1 passes");
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

        const shown = (await show("config.show", result)).stdout;

        expect(shown).toContain("  • confd/620-no-diagrams.js @sous-io/plugin-confd, apply order 90620\n    • removeWhere\n      • removeIndex compilation.targets[7]\n");
        expect(shown).toContain("  • late-fixups plugin-x, apply order 0, moved to 90621\n    • setKey compilation.overwriteUntracked = false\n");
        expect(shown).toMatch(/result: settled after 1 pass/);
        expect(shown.indexOf("confd/620")).toBeLessThan(shown.indexOf("late-fixups"));
    });

    /** `config validate`: "Config is valid", or each problem and exit code 1. */
    it("should say the config is valid, or list each problem and fail", async () => {
        expect((await show("config.validate", { ok: true, issues: [] })).stdout).toContain("Config is valid");

        const failed = await show("config.validate", { ok: false, issues: ["tools.x: Expected object (set by confd/1.js)"] });

        expect(failed.exitCode).toBe(1);
        expect(failed.stdout + failed.stderr).toContain("The config has 1 problem");
        expect(failed.stdout + failed.stderr).toContain("tools.x: Expected object (set by confd/1.js)");
    });

    /** A valid config lists what was checked: the file, the layers, the targets and the tools. */
    it("should list what was checked under a valid config", async () => {
        const summary = { configFile: "/p/.sous/sous.config.json", layers: 3, targets: 2, tools: ["claude"] };
        const text = (await show("config.validate", { ok: true, issues: [], summary })).stdout;

        expect(text).toContain("/p/.sous/sous.config.json");
        expect(text).toMatch(/Config File\s*:\s*\/p/);
        expect(text).toMatch(/Layers\s*:\s*3/);
        expect(text).toMatch(/Targets\s*:\s*2/);
        expect(text).toMatch(/Tools\s*:\s*claude/);
    });

    /** A problem of several lines keeps its later lines as the problem's cause. */
    it("should keep the later lines of a problem as its cause", async () => {
        const messages = (await reported("config.validate", { ok: false, issues: ["Unresolved variables in _vars:\n- thing still needs ${bogus}"] })).styled(ReportEntryStyle.Problem);

        expect(messages).toHaveLength(1);
        expect(messages[0]!.details).toMatchObject({ summary: "Unresolved variables in _vars:", cause: "- thing still needs ${bogus}" });
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

        const shown = (await show("plugins.show", plugins)).stdout;

        expect(shown).toContain("plugin-claude-code (built in)");
        expect(shown).toMatch(/entities\s*:?\s*harness: claude\s+skill-target: claude-code/);
        expect(shown).toMatch(/listeners\s*:?\s*build\.after/);
        expect(shown).toContain("sous-plugin-mcp-extras (loaded by sous-plugin-claude-code)");
        expect(shown).toMatch(/options\s*:?\s*\{ "port": 7801 \}/);
        expect(shown.indexOf("plugin-claude-code")).toBeLessThan(shown.indexOf("sous-plugin-mcp-extras"));
    });

    /** `sous timings show` uses the `--timings` layout, and says so when there are none. */
    it("should list timings, or say there are none", async () => {
        expect((await show("timings.show", [])).stdout).toContain("No timings yet.");
        expect(
            (await show("timings.show", [{ key: "intent:build", category: "intent", name: "build", plugin: "p", count: 1, totalMs: 5, maxMs: 5, budgetMs: 100, overBudget: 0 }])).stdout,
        ).toContain("intent:build");
    });

    /** `sous version` prints `v` and the version, as `sous --version` did before the refactor. */
    it("should print the version with a v, and more with --verbose", async () => {
        expect((await show("version", "1.2.3")).stdout.trim()).toBe("v1.2.3");

        const verbose = (await show("version", { name: "@sous-io/sous", version: "1.2.3" })).stdout;

        expect(verbose).toMatch(/^v1\.2\.3\n/);
        expect(verbose).toMatch(/Package\s*:\s*@sous-io\/sous/);
        expect(verbose).toMatch(/Platform\s*:\s*\S+/);
        expect(verbose).toMatch(/Node\s*:\s*v\d+/);
    });
});
