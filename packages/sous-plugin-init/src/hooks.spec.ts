import { describe, expect, it } from "vitest";
import { applyHookBlock, composeScript, HOOK_BLOCK_END, HOOK_BLOCK_START, hookBlock, manualLines } from "./hooks.js";

const PNPM = { command: "pnpm install", via: "husky", script: "prepare" } as const;
const PLAIN = { command: "sous build", via: "git" } as const;

describe("hookBlock()", () => {
    /**
     * With Husky, post-checkout should run the install on a branch checkout only, print a failure,
     * and leave git's exit code alone (an echo succeeds).
     */
    it("should run the install on a branch checkout, printing a failure", () => {
        expect(hookBlock("post-checkout", PNPM)).toBe(
            [
                HOOK_BLOCK_START,
                '# After a checkout, install the dependencies; the "prepare" script then runs `sous build`, so the',
                "# files Sous writes match this checkout. A failure is printed, and git carries on.",
                'if [ "$3" = "1" ]; then',
                "  pnpm install || echo \"sous: 'pnpm install' failed after a checkout; git carried on.\" >&2",
                "fi",
                HOOK_BLOCK_END,
                "",
            ].join("\n"),
        );
    });

    /** Without a package.json, the hook should run sous build only when there is a sous command. */
    it("should run sous build directly, and nothing without a sous command", () => {
        expect(hookBlock("post-checkout", PLAIN)).toContain('if [ "$3" = "1" ] && command -v sous >/dev/null 2>&1; then\n  sous build || echo');
    });

    /** post-merge acts on every merge; post-rewrite only after a rebase, not an amend. */
    it("should act on every merge, and on a rebase but not an amend", () => {
        expect(hookBlock("post-merge", PNPM)).toContain("\npnpm install || echo \"sous: 'pnpm install' failed after a merge; git carried on.\" >&2\n");
        expect(hookBlock("post-merge", PNPM)).not.toContain("if ");
        expect(hookBlock("post-rewrite", PNPM)).toContain('if [ "$1" = "rebase" ]; then');
    });
});

describe("applyHookBlock()", () => {
    const block = hookBlock("post-checkout", PNPM);

    /** A new Husky hook is the block alone; a new hook in git's own folder starts with #!/bin/sh. */
    it("should write a new file, with a first line only for git's own folder", () => {
        expect(applyHookBlock(undefined, block, "husky")).toBe(block);
        expect(applyHookBlock(undefined, block, "git")).toBe(`#!/bin/sh\n${block}`);
    });

    /** An existing hook keeps its lines, and gains the block after them; a second run changes nothing. */
    it("should add the block after an existing hook's lines, once", () => {
        const existing = "#!/bin/sh\nnpx lint-staged\n";
        const once = applyHookBlock(existing, block, "husky");

        expect(once).toBe(`${existing}\n${block}`);
        expect(applyHookBlock(once, block, "husky")).toBe(once);
    });

    /** A block already there is replaced in place, keeping the lines around it. */
    it("should replace the block between its markers", () => {
        const existing = `echo before\n${HOOK_BLOCK_START}\nold line\n${HOOK_BLOCK_END}\necho after\n`;

        expect(applyHookBlock(existing, block, "husky")).toBe(`echo before\n${block}echo after\n`);
    });

    /** An opening marker without a closing one is refused, since the end of the block is unknown. */
    it("should refuse a block with no closing marker", () => {
        expect(() => applyHookBlock(`${HOOK_BLOCK_START}\nold\n`, block, "husky")).toThrow(/is missing/);
    });
});

describe("composeScript()", () => {
    /**
     * composeScript should add Husky and the guarded build, after anything already in the script.
     *
     * composeScript(undefined); // "husky && sous build || exit 0"
     * composeScript("husky");   // "husky && (sous build || exit 0)"
     * composeScript("tsc -b");  // "tsc -b && (husky && sous build || exit 0)"
     */
    it("should add Husky and the guarded build after what is there", () => {
        expect(composeScript(undefined)).toBe("husky && sous build || exit 0");
        expect(composeScript("")).toBe("husky && sous build || exit 0");
        expect(composeScript("husky")).toBe("husky && (sous build || exit 0)");
        expect(composeScript("tsc -b")).toBe("tsc -b && (husky && sous build || exit 0)");
    });

    /** A script that already runs both is left as it is; "huskyish" is not Husky. */
    it("should leave a script that already runs both", () => {
        expect(composeScript("husky && sous build || exit 0")).toBeUndefined();
        expect(composeScript("huskyish")).toBe("huskyish && (husky && sous build || exit 0)");
    });
});

describe("manualLines()", () => {
    /** The lines change into the project's folder first, and name the script with Husky. */
    it("should name the hook line and the script", () => {
        expect(manualLines("apps/web", PNPM)).toEqual([
            "In the repository's post-checkout hook (.husky/post-checkout at the top of the repository, with Husky):",
            "  (cd \"apps/web\" && pnpm install) || echo \"sous: 'pnpm install' failed after a checkout; git carried on.\" >&2",
            'In the "prepare" script of apps/web/package.json, after what is there:',
            "  sous build || exit 0",
        ]);
        expect(manualLines("apps/web", PLAIN)).toHaveLength(2);
    });
});
