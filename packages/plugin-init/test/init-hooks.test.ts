import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigError, NonInteractiveError } from "@sous-io/plugin-api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HOOK_BLOCK_START } from "../src/hooks.js";
import { handle } from "../src/init-hooks.js";
import { fakeGitRunner, fakePnpm, fakeProcesses, initContext } from "./helpers.js";

let tmp: string;
let root: string;

beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sous-init-hooks-")));
    root = path.join(tmp, "app");
    fs.mkdirSync(path.join(root, ".sous"), { recursive: true });
    fs.mkdirSync(path.join(root, ".git"), { recursive: true });
    fs.writeFileSync(path.join(root, ".sous", "sous.config.jsonc"), "{}");
});

afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
});

/** A context with a git repository whose top is `top` (the project root by default). */
function hooksContext(options: { top?: string | null; answers?: unknown[]; exitCode?: number } = {}) {
    const git = fakeGitRunner({ ...(options.top === null ? {} : { top: options.top ?? root }) });
    const processes = fakeProcesses(options.exitCode ?? 0);
    const context = initContext({
        answers: options.answers ?? [],
        managers: [fakePnpm],
        services: { "git.runner": git.runner, "host.processes": processes.processes },
    });

    return { ...context, git, ran: processes.ran };
}

describe("init hooks without a package.json", () => {
    /** The repository's own post-checkout hook should run sous build, executable, and nothing else is written. */
    it("should write the repository's post-checkout hook", async () => {
        const { ctx, ran } = hooksContext();
        const result = (await handle({ directory: root, yes: true }, ctx)).toPlain();
        const file = path.join(root, ".git/hooks/post-checkout");

        expect(result).toMatchObject({ installed: true, via: "git", hooks: ["post-checkout"], hookCommand: "sous build", install: undefined });
        expect(fs.readFileSync(file, "utf8")).toMatch(/^#!\/bin\/sh\n# >>> sous managed: init hooks/);
        expect(fs.statSync(file).mode & 0o111).not.toBe(0);
        expect(fs.existsSync(path.join(root, ".husky"))).toBe(false);
        expect(ran).toEqual([]);
    });

    /** An existing hook keeps its lines, and Sous's block goes after them. */
    it("should add its block to an existing hook", async () => {
        const file = path.join(root, ".git/hooks/post-checkout");

        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, "#!/bin/sh\necho mine\n");

        const result = (await handle({ directory: root, yes: true }, hooksContext().ctx)).toPlain();

        expect(fs.readFileSync(file, "utf8")).toMatch(/^#!\/bin\/sh\necho mine\n\n# >>> sous managed: init hooks/);
        expect(result.installed && result.files).toEqual([{ file, change: "added" }]);
    });
});

describe("init hooks with a package.json", () => {
    beforeEach(() => {
        fs.writeFileSync(path.join(root, "package.json"), '{\n  "name": "app",\n  "scripts": { "prepare": "tsc -b" }\n}\n');
    });

    /**
     * Husky should be added, .husky/post-checkout should run the install, the prepare script should
     * keep what it had and gain Husky and the guarded build, and --yes should run the install.
     */
    it("should set up Husky, the script and the hook, and run the install under --yes", async () => {
        const { ctx, ran } = hooksContext();
        const result = (await handle({ directory: root, yes: true }, ctx)).toPlain();
        const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

        expect(result).toMatchObject({
            installed: true,
            via: "husky",
            manager: "pnpm",
            hooks: ["post-checkout"],
            hookCommand: "pnpm install",
            script: { name: "prepare", text: "tsc -b && (husky && sous build || exit 0)" },
            install: { command: "pnpm install", outcome: "ran", exitCode: 0 },
        });
        expect(pkg).toEqual({ name: "app", scripts: { prepare: "tsc -b && (husky && sous build || exit 0)" }, devDependencies: { husky: "^9.1.7" } });
        expect(fs.readFileSync(path.join(root, ".husky/post-checkout"), "utf8")).toContain("  pnpm install || echo");
        expect(ran).toEqual([{ command: "pnpm", args: ["install"] }]);
    });

    /** Without flags, it should ask about the pull hooks and the install; a no to the install runs nothing. */
    it("should ask about the pull hooks and the install", async () => {
        const { ctx, ran, recorded } = hooksContext({ answers: [true, false] });
        const result = (await handle({ directory: root }, ctx)).toPlain();

        expect(recorded.asked).toEqual([
            "Also install post-merge and post-rewrite, so the same runs after a pull and a rebase?",
            "Run 'pnpm install' now? It installs Husky, which turns the hooks on, and its \"prepare\" script runs 'sous build'.",
        ]);
        expect(result).toMatchObject({ hooks: ["post-checkout", "post-merge", "post-rewrite"], install: { outcome: "declined" } });
        expect(fs.readdirSync(path.join(root, ".husky")).sort()).toEqual(["post-checkout", "post-merge", "post-rewrite"]);
        expect(ran).toEqual([]);
    });

    /** With no terminal and no flags, the error names the flags that answer the question. */
    it("should name the flags when it cannot ask", async () => {
        const error = await handle({ directory: root }, hooksContext().ctx).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(NonInteractiveError);
        expect((error as NonInteractiveError).answeredBy).toBe("--pull-hooks or --no-pull-hooks (--yes leaves them out)");
    });

    /** --no-install skips the install; a failed install is a warning, not an error. */
    it("should skip the install under --no-install, and warn when it fails", async () => {
        const skipped = hooksContext();

        expect((await handle({ directory: root, yes: true, install: false }, skipped.ctx)).toPlain()).toMatchObject({ install: { outcome: "skipped" } });
        expect(skipped.ran).toEqual([]);

        const failed = hooksContext({ exitCode: 1 });

        expect((await handle({ directory: root, yes: true }, failed.ctx)).toPlain()).toMatchObject({ install: { outcome: "failed", exitCode: 1 } });
        expect(failed.recorded.reporter.at("warning").join("\n")).toContain("'pnpm install' exited with code 1");
    });

    /** A dry run plans everything and writes nothing. */
    it("should write nothing on a dry run", async () => {
        const before = fs.readFileSync(path.join(root, "package.json"), "utf8");
        const { ctx, ran } = hooksContext();
        const result = (await handle({ directory: root, dryRun: true }, ctx)).toPlain();

        expect(result).toMatchObject({ installed: true, dryRun: true, install: { outcome: "planned" } });
        expect(fs.existsSync(path.join(root, ".husky"))).toBe(false);
        expect(fs.readFileSync(path.join(root, "package.json"), "utf8")).toBe(before);
        expect(ran).toEqual([]);
    });

    /** A second run changes nothing it already wrote. */
    it("should change nothing on a second run", async () => {
        await handle({ directory: root, yes: true, install: false }, hooksContext().ctx);

        const pkg = fs.readFileSync(path.join(root, "package.json"), "utf8");
        const result = (await handle({ directory: root, yes: true, install: false }, hooksContext().ctx)).toPlain();

        expect(result.installed && result.files).toEqual([{ file: path.join(root, ".husky/post-checkout"), change: "unchanged" }]);
        expect(fs.readFileSync(path.join(root, "package.json"), "utf8")).toBe(pkg);
        expect(fs.readFileSync(path.join(root, ".husky/post-checkout"), "utf8").split(HOOK_BLOCK_START)).toHaveLength(2);
    });
});

describe("init hooks where it stops", () => {
    /** A .sous/ below the top of the repository is refused, naming the lines to add by hand. */
    it("should stop when .sous/ is not at the top of the repository, naming the lines to add", async () => {
        const error = await handle({ directory: root, yes: true }, hooksContext({ top: tmp }).ctx).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(ConfigError);
        expect((error as ConfigError).message).toContain("but this project's .sous/ is in app/");
        expect((error as ConfigError).details.join("\n")).toContain('(cd "app" && sous build)');
        expect(fs.existsSync(path.join(root, ".git/hooks"))).toBe(false);
    });

    /** Outside a git repository, and in a directory not set up for sous, it stops and says why. */
    it("should stop outside a git repository, or a project not set up", async () => {
        await expect(handle({ directory: root, yes: true }, hooksContext({ top: null }).ctx)).rejects.toThrow(/not inside a git repository/);

        fs.rmSync(path.join(root, ".sous"), { recursive: true });
        await expect(handle({ directory: root, yes: true }, hooksContext().ctx)).rejects.toThrow(/not set up for sous/);
    });
});
