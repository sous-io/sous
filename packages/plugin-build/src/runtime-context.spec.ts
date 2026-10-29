import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CompilerWriter, WriteOptions } from "@sous-io/plugin-compiler/types";
import type { GitRunner } from "@sous-io/plugin-git/types";
import { renderRuntimeContext, RuntimeContextService } from "./runtime-context.js";

describe("renderRuntimeContext()", () => {
    /**
     * A branch that does not match the pattern names the branch and no task file.
     *
     * renderRuntimeContext({ branch: "main", matched: false });
     * // -> "...Current git branch: `main`\n\n### Current Task File\n\n\n"
     */
    it("should name the branch and leave the task file section empty off a feature branch", () => {
        const text = renderRuntimeContext({ branch: "main", matched: false });

        expect(text).toContain("Current git branch: `main`");
        expect(text.endsWith("### Current Task File\n\n\n")).toBe(true);
    });

    /**
     * A matching branch with no task file says one does not exist yet.
     *
     * renderRuntimeContext({ branch: "PT-1", matched: true, taskFile: "/t/PT-1.md" });
     * // -> "...this branch does not,\nyet, have a task file..."
     */
    it("should say a matching branch has no task file yet", () => {
        expect(renderRuntimeContext({ branch: "PT-1", matched: true, taskFile: "/t/PT-1.md" })).toContain("this branch does not,\nyet, have a task file");
    });

    /**
     * A matching branch with a task file embeds it between markers, trailing newlines trimmed.
     *
     * renderRuntimeContext({ ..., taskContent: "# Task\n\n" });
     * // -> "--- Start Task File: /t/PT-1.md ---\n# Task\n--- End Task File: /t/PT-1.md ---"
     */
    it("should embed an existing task file", () => {
        const text = renderRuntimeContext({ branch: "PT-1", matched: true, taskFile: "/t/PT-1.md", taskContent: "# Task\n\n" });

        expect(text).toContain("--- Start Task File: /t/PT-1.md ---\n# Task\n--- End Task File: /t/PT-1.md ---");
    });
});

describe("RuntimeContextService", () => {
    const writes: Array<{ file: string; content: string; options: WriteOptions }> = [];
    const writer = {
        write: async (file: string, content: string, options: WriteOptions) => {
            writes.push({ file, content, options });

            return { file, action: "created", bytes: content.length };
        },
    } as unknown as CompilerWriter;
    const git = (branch: string | undefined | Error) =>
        ({
            currentBranch: async () => {
                if (branch instanceof Error) throw branch;

                return branch;
            },
        }) as unknown as GitRunner;

    /**
     * With no settings, nothing is generated or written.
     *
     * new RuntimeContextService({ settings: undefined, ... }).generate(); // -> undefined
     */
    it("should do nothing without settings", async () => {
        const service = new RuntimeContextService({ settings: undefined, git: () => git("main"), writer: () => writer, plugin: "p" });

        expect(await service.generate()).toBeUndefined();
        expect(await service.write()).toBeUndefined();
    });

    /**
     * On a branch matching `branchPattern` whose task file exists, the context names both, and
     * write() hands the content to compiler.writer at outputPath.
     *
     * service.generate(); // -> { branch: "PT-7", taskFile: "<root>/PT-7.md", outputPath, content }
     */
    it("should find the task file and write through compiler.writer", async () => {
        const root = mkdtempSync(path.join(tmpdir(), "sous-rc-"));

        writeFileSync(path.join(root, "PT-7.md"), "Do the thing\n");

        const service = new RuntimeContextService({
            settings: { gitRoot: root, outputPath: path.join(root, "out", "ctx.md"), taskFileRoot: root },
            git: () => git("PT-7"),
            writer: () => writer,
            plugin: "@sous-io/plugin-build",
        });
        const context = await service.generate();

        expect(context).toMatchObject({ branch: "PT-7", taskFile: path.join(root, "PT-7.md") });
        expect(context?.content).toContain("Do the thing");

        const written = await service.write({ dryRun: true });

        expect(written?.file).toBe(path.join(root, "out", "ctx.md"));
        expect(writes.at(-1)?.options).toMatchObject({ source: "runtime-context", dryRun: true, origin: { plugin: "@sous-io/plugin-build" } });
    });

    /**
     * A custom branchPattern decides which branches look for a task file; a git failure gives
     * no branch and the file says "unknown".
     *
     * generate() with git failing; // -> { branch: undefined, content: "...`unknown`..." }
     */
    it("should honour branchPattern and say unknown when git fails", async () => {
        const settings = { gitRoot: "/r", outputPath: "/r/ctx.md", taskFileRoot: "/r/tasks", branchPattern: "^feat/" };
        const matching = await new RuntimeContextService({ settings, git: () => git("PT-1"), writer: () => writer, plugin: "p" }).generate();
        const failing = await new RuntimeContextService({ settings, git: () => git(new Error("no repo")), writer: () => writer, plugin: "p" }).generate();

        expect(matching?.taskFile).toBeUndefined();
        expect(matching?.content).not.toContain("task file");
        expect(failing?.branch).toBeUndefined();
        expect(failing?.content).toContain("Current git branch: `unknown`");
    });
});
