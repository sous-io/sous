import { writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, NonInteractiveError, NotFoundError, scriptedPrompter } from "@sous-io/plugin-api";
import type { CompilerPruneResult } from "@sous-io/plugin-compiler/types";
import type { BuildResult, ClearResult, CompileCommandResult } from "../src/types.js";
import { entry, harness, target } from "./helpers.js";

/** Ported in spirit from src/test/integration/build-service.test.ts: the compiler's half moved to plugin-compiler. */
describe("the build intent", () => {
    /**
     * A plain build prepares, compiles and prunes, through the compiler's intents by name (C10).
     *
     * sous build; // -> compiler.compile {}, compiler.prune { dryRun: false }, ok: true
     */
    it("should prepare, compile and prune", async () => {
        const h = await harness();
        const result = await h.run<BuildResult>("build");

        expect(result).toMatchObject({ ok: true, dryRun: false, watching: false });
        expect(h.world.compileCalls).toEqual([{}]);
        expect(h.world.pruneCalls).toEqual([{ dryRun: false }]);
        expect(result.prepared.locked.unchanged).toBe(true);
    });

    /**
     * A compile error fails the build and skips the prune; the next build can succeed.
     *
     * sous build; // -> ok: false, no prune
     */
    it("should return ok false on a compile error and let the next build succeed", async () => {
        const h = await harness();
        let ok = false;

        h.world.compileResult = () => ({ ok, outputs: [], problems: [{ level: "error", message: "bad include" }], durationMs: 1 });

        expect((await h.run<BuildResult>("build")).ok).toBe(false);
        expect(h.world.pruneCalls).toEqual([]);

        ok = true;
        expect((await h.run<BuildResult>("build")).ok).toBe(true);
        expect(h.world.pruneCalls).toHaveLength(1);
    });

    /**
     * --no-compile only prunes; --no-prune only compiles.
     *
     * sous build --no-compile; // -> no compile call
     */
    it("should skip the compile or the prune step when asked", async () => {
        const h = await harness();

        await h.run("build", { noCompile: true });
        expect(h.world.compileCalls).toEqual([]);
        expect(h.world.pruneCalls).toHaveLength(1);

        await h.run("build", { noPrune: true });
        expect(h.world.compileCalls).toHaveLength(1);
        expect(h.world.pruneCalls).toHaveLength(1);
    });

    /**
     * A dry run passes dryRun on, writes no lockfile, restores nothing and never goes upstream.
     *
     * sous build --dry-run; // -> compile { dryRun: true }, prune { dryRun: true }
     */
    it("should write nothing on a dry run", async () => {
        const h = await harness({
            world: (world) => {
                world.config = { subscriptions: { acme: {} } };
                world.published = { "acme/jira": { repo: "acme", namespace: "acme", version: "1.0.0" } };
            },
        });
        const result = await h.run<BuildResult>("build", { dryRun: true });

        expect(result.dryRun).toBe(true);
        expect(h.world.compileCalls).toEqual([{ dryRun: true }]);
        expect(h.world.pruneCalls).toEqual([{ dryRun: true }]);
        expect(h.world.lockWrites).toEqual([expect.objectContaining({ dryRun: true })]);
        expect(h.world.restoreCalls).toEqual([]);
        expect(h.world.indexCalls).toBe(0);
    });

    /**
     * --rebuild removes everything written before, then compiles every output.
     *
     * sous build --rebuild; // -> prune { all: true }, compile { rebuild: true }, prune { dryRun: false }
     */
    it("should start from a clean slate on --rebuild", async () => {
        const h = await harness();

        await h.run("build", { rebuild: true, strict: true });
        expect(h.world.pruneCalls).toEqual([{ all: true }, { dryRun: false }]);
        expect(h.world.compileCalls).toEqual([{ strict: true, rebuild: true }]);
    });

    /**
     * A partial rebuild (watch mode) prepares nothing and compiles only what the files reach.
     *
     * build { changedFiles: ["/p/AGENTS.md"] }; // -> compile { changedFiles }, no build.prepared
     */
    it("should prepare nothing on a partial rebuild", async () => {
        const h = await harness();
        const result = await h.run<BuildResult>("build", { changedFiles: ["/p/AGENTS.md"] });

        expect(h.world.compileCalls).toEqual([{ changedFiles: ["/p/AGENTS.md"] }]);
        expect(h.world.resolveCalls).toEqual([]);
        expect(result.prepared.seeded).toEqual([]);
    });

    /**
     * S4, 3: one line per skipped recipe, saying why, and how many of its outputs were pruned.
     *
     * $ sous build
     * Skipped tool-usage/automated-browser-tasks: its subscription is switched off (conf.d/610-mac.jsonc).
     * Pruned 2 outputs it had written.
     */
    it("should report each skipped recipe and the outputs pruned for it", async () => {
        const h = await harness({
            world: (world) => {
                world.skipped = [
                    { key: "tool-usage/automated-browser-tasks", reason: "subscription-disabled", setBy: "conf.d/610-mac.jsonc", message: "" },
                    { key: "acme/other", reason: "untrusted", message: "Its repository is not trusted." },
                ];
                world.state.files = [entry("/p/a.md", "tool-usage/automated-browser-tasks"), entry("/p/b.md", "tool-usage/automated-browser-tasks"), entry("/p/c.md")];
                world.pruneResult = () => ({ removed: ["/p/a.md", "/p/b.md", "/p/c.md"], dirsRemoved: [], dryRun: false });
            },
        });

        await h.run("build");

        const notes = h.reporter.at("notice");

        expect(notes).toContain(
            "Skipped tool-usage/automated-browser-tasks: its subscription is switched off (conf.d/610-mac.jsonc).\nPruned 2 outputs it had written.",
        );
        expect(notes).toContain("Skipped acme/other: its repository is not trusted.");
    });

    /**
     * Linked repositories are announced on every full build; required variables with no answer
     * are warned about.
     *
     * sous build; // -> warning "One repository is LINKED...", warning "1 required recipe variable..."
     */
    it("should announce linked repositories and unanswered variables", async () => {
        const h = await harness({
            world: (world) => {
                world.links = { acme: { repo: "acme", path: "/src/acme", origin: "existing", linkedAt: "", scope: "project" } as never };
                world.unanswered = [{ definition: { name: "jiraKey" }, recipe: { namespace: "acme", name: "jira" } } as never];
            },
        });

        await h.run("build");

        const warnings = h.reporter.at("warning").join("\n");

        expect(warnings).toContain("acme -> /src/acme");
        expect(warnings).toContain("jiraKey (asked by acme/jira)");
    });

    /**
     * A target with generateRuntimeContext gets the runtime context file written through
     * compiler.writer before anything compiles, with `${var}` in its settings substituted.
     *
     * runtimeContext: { outputPath: "${sousDir}/runtime/ctx.md", ... }; // -> written at <sousDir>/runtime/ctx.md
     */
    it("should write the runtime context file when a target asks for it", async () => {
        const h = await harness({
            world: (world) => {
                world.branch = "PT-9";
                world.config = {
                    compilation: { targets: [target({ entryPoint: "/p/AGENTS.md", generateRuntimeContext: true })] },
                    runtimeContext: { gitRoot: "${projectRoot}", outputPath: "${sousDir}/runtime/ctx.md", taskFileRoot: "${projectRoot}/tasks" },
                };
            },
        });
        const result = await h.run<BuildResult>("build");

        expect(result.runtimeContext?.file).toBe(path.join(h.project.sousDir, "runtime", "ctx.md"));
        expect(h.world.writes[0]?.content).toContain("Current git branch: `PT-9`");
        expect(h.world.writes[0]?.content).toContain("does not,\nyet, have a task file");
        expect(h.world.commits).toBe(1);
    });

    /**
     * A target asking for the runtime context with no runtimeContext set is warned about; a git
     * failure says "unknown".
     *
     * sous build; // -> warning "...the config sets no runtimeContext..."
     */
    it("should warn when the runtime context cannot be written as asked", async () => {
        const without = await harness({
            world: (world) => {
                world.config = { compilation: { targets: [target({ entryPoint: "/p/A.md", generateRuntimeContext: true })] } };
            },
        });

        await without.run("build");
        expect(without.reporter.at("warning").join("\n")).toContain("the config sets no runtimeContext");

        const noBranch = await harness({
            world: (world) => {
                world.branch = undefined;
                world.config = {
                    compilation: { targets: [target({ entryPoint: "/p/A.md", generateRuntimeContext: true })] },
                    runtimeContext: { gitRoot: "/r", outputPath: "/r/ctx.md", taskFileRoot: "/r" },
                };
            },
        });

        await noBranch.run("build");
        expect(noBranch.reporter.at("warning").join("\n")).toContain('says "unknown"');
    });

    /**
     * --watch refuses to start when another live process holds the PID file.
     *
     * sous build --watch; // -> "A watcher is already running for project '<name>' (PID 1)..."
     */
    it("should refuse to watch when a watcher is already running", async () => {
        const h = await harness({ plugin: { isProcessAlive: () => true } });

        writeFileSync(path.join(h.project.sousDir, "sous.pid"), "1");
        await expect(h.run("build", { watch: true })).rejects.toThrow(/A watcher is already running for project '.*' \(PID 1\)/u);
        expect(h.world.compileCalls).toEqual([]);
    });
});

describe("the compile intent", () => {
    /**
     * compile compiles every target, without preparing or pruning.
     *
     * sous compile --strict; // -> compiler.compile { strict: true }; no prune, no resolve
     */
    it("should compile without preparing or pruning", async () => {
        const h = await harness({
            world: (world) => {
                world.config = { subscriptions: { acme: {} }, compilation: { targets: [target({ entryPoint: "/p/A.md" })] } };
                world.published = { "acme/jira": { repo: "acme", namespace: "acme", version: "1.0.0" } };
            },
        });
        const result = await h.run<CompileCommandResult>("compile", { strict: true });

        expect(result.ok).toBe(true);
        expect(h.world.compileCalls).toEqual([{ strict: true }]);
        expect(h.world.pruneCalls).toEqual([]);
        expect(h.world.resolveCalls).toEqual([]);
    });

    /**
     * With no compilation targets, compile fails as before the refactor.
     *
     * sous compile; // -> ConfigError "No compilation config found in <config>."
     */
    it("should fail when there is nothing to compile", async () => {
        const h = await harness();

        await expect(h.run("compile")).rejects.toThrow(ConfigError);
        await expect(h.run("compile")).rejects.toThrow(/No compilation config found in .*sous\.config\.jsonc/u);
    });
});

describe("the prune intent", () => {
    /**
     * prune is the build path with compiling switched off: it prepares, then prunes.
     *
     * sous prune --dry-run; // -> compiler.prune { dryRun: true }, no compile
     */
    it("should prepare and prune without compiling", async () => {
        const h = await harness({
            world: (world) => {
                world.pruneResult = (input) => ({ removed: ["/p/old.md"], dirsRemoved: [], dryRun: input.dryRun === true });
            },
        });
        const result = await h.run<CompilerPruneResult>("prune", { dryRun: true });

        expect(result).toEqual({ removed: ["/p/old.md"], dirsRemoved: [], dryRun: true });
        expect(h.world.compileCalls).toEqual([]);
    });
});

describe("the clear intent", () => {
    const withState = (h: Awaited<ReturnType<typeof harness>>) => {
        writeFileSync(h.world.statePath, "{}");
        h.world.state.files = [entry("/p/a.md"), entry("/p/b.md")];
        h.world.state.dirs = ["/p/dir"];
    };

    /**
     * With no state file there is nothing to clear, and the error says how to recover.
     *
     * sous clear; // -> "No state file found at <path>. Run 'sous build' first, then 'sous clear' to recover."
     */
    it("should fail when there is no state file", async () => {
        const h = await harness();

        await expect(h.run("clear", { force: true })).rejects.toThrow(NotFoundError);
        await expect(h.run("clear", { force: true })).rejects.toThrow(/Run 'sous build' first, then 'sous clear' to recover\./u);
    });

    /**
     * Without --force it asks, naming the counts and the project; a "no" removes nothing.
     *
     * sous clear; // "Delete 2 file(s) and 1 director(ies) for '<project>'?" -> no -> "Aborted."
     */
    it("should ask first and stop when the answer is no", async () => {
        const h = await harness();

        withState(h);

        const prompter = scriptedPrompter([false]);
        const result = await h.run<ClearResult>("clear", {}, { prompter });

        expect(prompter.asked).toEqual([`Delete 2 file(s) and 1 director(ies) for '${path.basename(h.project.root)}'?`]);
        expect(result.confirmed).toBe(false);
        expect(h.world.pruneCalls).toEqual([]);
        expect(h.reporter.at("notice")).toContain("Aborted.");
    });

    /**
     * --force removes everything through compiler.prune with `all`, asking nothing; with no way
     * to ask, the error names --force (L4).
     *
     * sous clear --force; // -> compiler.prune { all: true }
     */
    it("should clear without asking when forced, and name --force when it cannot ask", async () => {
        const h = await harness();

        withState(h);
        await expect(h.run("clear")).rejects.toThrow(NonInteractiveError);
        await expect(h.run("clear")).rejects.toThrow(/--force/u);

        h.world.pruneResult = () => ({ removed: ["/p/a.md", "/p/b.md"], dirsRemoved: ["/p/dir"], dryRun: false });

        const result = await h.run<ClearResult>("clear", { force: true });

        expect(result).toEqual({ removed: ["/p/a.md", "/p/b.md"], dirsRemoved: ["/p/dir"], dryRun: false, confirmed: true });
        expect(h.world.pruneCalls).toEqual([{ all: true }]);
    });
});

describe("the intents' CLI declarations", () => {
    /**
     * Every flag of the old commands survives: build -w, compile -w, clear -f/--yes.
     *
     * engine.handle.intents.get("clear").definition.cli.flags.force; // -> { short: "f", aliases: ["yes"] }
     */
    it("should keep the old commands' short flags and aliases", async () => {
        const h = await harness();
        const intents = h.engine.handle.intents;

        expect(intents.get("build")?.definition.cli?.flags?.watch).toEqual({ short: "w" });
        expect(intents.get("compile")?.definition.cli?.flags?.watch).toEqual({ short: "w" });
        expect(intents.get("clear")?.definition.cli?.flags?.force).toEqual({ short: "f", aliases: ["yes"] });
        expect(intents.get("build.prepare")?.definition.internal).toBe(true);
        expect(intents.get("build.watch")?.definition.background).toBe(true);
    });
});
