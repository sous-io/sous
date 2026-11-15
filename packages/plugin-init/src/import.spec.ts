import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyImport, backupFolder, findReferences, type IncludeFate, rewriteReferences, scanImport, settleFates } from "./import.js";

let tmp: string;
let root: string;
let sousDir: string;

beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sous-import-")));
    root = path.join(tmp, "app");
    sousDir = path.join(root, ".sous");
    fs.mkdirSync(root, { recursive: true });
});

afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
});

/** Writes files under the project root: `{ "docs/a.md": "text" }`. */
function write(files: Record<string, string>): void {
    for (const [file, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        fs.writeFileSync(path.join(root, file), content, "utf8");
    }
}

/** Every include gets the same fate. */
async function all(fate: IncludeFate) {
    const scan = scanImport(root, sousDir);

    return { scan, fates: await settleFates(scan, fate, async () => fate) };
}

describe("findReferences()", () => {
    /**
     * findReferences should return every `@` reference outside fenced code and inline code, telling
     * a reference that is the whole line from a mention inside text, and dropping the sentence's
     * closing punctuation.
     *
     * findReferences("@docs/a.md\nSee @package.json.");
     * // -> [{ whole: true, token: "docs/a.md" }, { whole: false, token: "package.json" }]
     */
    it("should find whole-line references and mentions, skipping code", () => {
        const found = findReferences(["@docs/a.md", "See @package.json.", "```", "@inside-a-fence.md", "```", "Run `@not-this` or mail me@example.com."].join("\n"));

        expect(found.map(({ line, whole, token }) => ({ line, whole, token }))).toEqual([
            { line: 0, whole: true, token: "docs/a.md" },
            { line: 1, whole: false, token: "package.json" },
        ]);
    });
});

describe("scanImport()", () => {
    /**
     * scanImport should import a CLAUDE.md with real content and skip an AGENTS.md that only points
     * at it, saying why.
     *
     * CLAUDE.md: "# Rules ..."; AGENTS.md: "Read CLAUDE.md."
     * // -> instructions: [CLAUDE.md]; skipped: [AGENTS.md, "it only points at CLAUDE.md"]
     */
    it("should skip an instruction file that only points at the other", () => {
        write({ "CLAUDE.md": "# Rules\n\nAlways run the tests before pushing, and keep commits small.\n".repeat(10), "AGENTS.md": "Read `CLAUDE.md` in this directory.\n" });

        const scan = scanImport(root, sousDir);

        expect(scan.instructions.map((instruction) => instruction.name)).toEqual(["CLAUDE.md"]);
        expect(scan.skipped).toEqual([{ source: path.join(root, "AGENTS.md"), reason: "it only points at CLAUDE.md" }]);
    });

    /**
     * scanImport should skip an AGENTS.md that is a link to CLAUDE.md, or that holds the same text.
     */
    it("should skip a link to the other file, and a copy of its text", () => {
        write({ "CLAUDE.md": "# Rules\n" });
        fs.symlinkSync("CLAUDE.md", path.join(root, "AGENTS.md"));

        expect(scanImport(root, sousDir).skipped.map((skip) => skip.reason)).toEqual(["a link to CLAUDE.md"]);

        fs.rmSync(path.join(root, "AGENTS.md"));
        write({ "AGENTS.md": "# Rules\n" });

        expect(scanImport(root, sousDir).skipped.map((skip) => skip.reason)).toEqual(["the same text as CLAUDE.md"]);
    });

    /**
     * scanImport should follow includes all the way down, listing parents before the files they
     * include, and should pin a README and a file outside the project in place.
     *
     * CLAUDE.md -> docs/a.md -> docs/b.md; CLAUDE.md -> README.md; CLAUDE.md -> ../shared.md
     */
    it("should follow includes recursively and pin what must stay", () => {
        write({ "CLAUDE.md": "@docs/a.md\n@README.md\n@../shared.md\n@missing.md\n", "docs/a.md": "A\n@b.md\n", "docs/b.md": "B\n", "README.md": "Readme\n" });
        fs.writeFileSync(path.join(tmp, "shared.md"), "Shared\n");

        const scan = scanImport(root, sousDir);

        expect(scan.includes.map((file) => [file.relative, file.pinned])).toEqual([
            ["docs/a.md", undefined],
            ["README.md", "a README stays where people look for it"],
            ["../shared.md", "it is outside the project"],
            ["docs/b.md", undefined],
        ]);
    });
});

describe("settleFates()", () => {
    /**
     * settleFates should turn a move into a copy for a file that a file left in place includes, so
     * the left file's include line keeps finding it, and should ask for each file parents first.
     *
     * choose: docs/a.md -> leave, then docs/b.md (included by a.md) -> move
     * // -> docs/b.md is copied
     */
    it("should copy, not move, a file that a left file includes", async () => {
        write({ "CLAUDE.md": "@docs/a.md\n", "docs/a.md": "@b.md\n", "docs/b.md": "B\n" });

        const scan = scanImport(root, sousDir);
        const asked: string[] = [];
        const fates = await settleFates(scan, "choose", async (file) => {
            asked.push(file.relative);

            return file.relative === "docs/a.md" ? "leave" : "move";
        });

        expect(asked).toEqual(["docs/a.md", "docs/b.md"]);
        expect(fates.get(path.join(root, "docs/b.md"))).toBe("copy");
    });
});

describe("rewriteReferences()", () => {
    /**
     * rewriteReferences should point a moved include at its new place relative to the copy, a left
     * include at its project path through #project, a mention at its path from the project root,
     * turn an include of a missing file into a comment, and drop an include of the other imported
     * instruction file.
     */
    it("should rewrite every reference to work from the new place", async () => {
        write({
            "CLAUDE.md": "@docs/a.md\n@README.md\n@missing.md\n@AGENTS.md\nSee @docs/a.md for more.\n",
            "AGENTS.md": "# Agents\n\nThe agent rules, which are long enough not to be a pointer.\n".repeat(10),
            "docs/a.md": "A\n",
            "README.md": "Readme\n",
        });

        const { scan, fates } = await all("move");
        const claude = scan.instructions.find((instruction) => instruction.name === "CLAUDE.md")!;
        const rewritten = rewriteReferences(scan, fates, claude.source, claude.dest, fs.readFileSync(claude.source, "utf8"));

        expect(rewritten.content.split("\n")).toEqual([
            "@../../includes/docs/a.md",
            "@#project/README.md",
            "<!-- @missing.md (sous init turned this include off: no such file) -->",
            "",
            "See @.sous/includes/docs/a.md for more.",
            "",
        ]);
        expect(rewritten.turnedOff).toEqual(["missing.md"]);
    });
});

describe("applyImport()", () => {
    /**
     * applyImport should copy the instruction file, move a moved include (backing the original up
     * first), copy a copied one, move each skill folder into .sous/skills/, and list the paths git
     * should stop tracking.
     */
    it("should import, move, back up and list what git should stop tracking", async () => {
        write({ "CLAUDE.md": "# Rules {{ not liquid }}\n@docs/a.md\n", "docs/a.md": "A\n", ".claude/skills/deploy/SKILL.md": "---\nname: deploy\n---\n", ".claude/skills/deploy/run.sh": "echo hi\n" });

        const now = new Date(2026, 10, 15, 9, 12, 4);
        const { scan, fates } = await all("move");
        const outcome = applyImport(scan, fates, { dryRun: false, now });
        const backups = path.join(sousDir, "backups", "2026-11-15", "0912-04");

        expect(fs.readFileSync(path.join(sousDir, "memories/imported/CLAUDE.md"), "utf8")).toBe("# Rules {{ not liquid }}\n@../../includes/docs/a.md\n");
        expect(fs.readFileSync(path.join(sousDir, "includes/docs/a.md"), "utf8")).toBe("A\n");
        expect(fs.existsSync(path.join(root, "docs/a.md"))).toBe(false);
        expect(fs.readFileSync(path.join(backups, "docs/a.md"), "utf8")).toBe("A\n");
        expect(fs.readFileSync(path.join(sousDir, "skills/deploy/run.sh"), "utf8")).toBe("echo hi\n");
        expect(fs.existsSync(path.join(root, ".claude/skills/deploy"))).toBe(false);
        expect(fs.existsSync(path.join(backups, ".claude/skills/deploy/SKILL.md"))).toBe(true);
        expect(outcome.untrack).toEqual(["CLAUDE.md", ".claude/skills/deploy"]);
        expect(outcome.nothingImported).toBe(false);
    });

    /** A copy should leave the original in place, and a dry run should write nothing at all. */
    it("should keep the original on a copy, and write nothing on a dry run", async () => {
        write({ "CLAUDE.md": "@docs/a.md\n", "docs/a.md": "A\n" });

        const copied = await all("copy");
        const dry = applyImport(copied.scan, copied.fates, { dryRun: true });

        expect(dry.written).toEqual([path.join(sousDir, "memories/imported/CLAUDE.md"), path.join(sousDir, "includes/docs/a.md")]);
        expect(fs.existsSync(sousDir)).toBe(false);

        applyImport(copied.scan, copied.fates, { dryRun: false });

        expect(fs.readFileSync(path.join(root, "docs/a.md"), "utf8")).toBe("A\n");
        expect(fs.existsSync(path.join(sousDir, "backups"))).toBe(false);
    });
});

describe("backupFolder()", () => {
    /**
     * backupFolder should name one run's folder by local date, then time.
     *
     * backupFolder("/p/.sous", new Date(2026, 10, 15, 9, 12, 4));
     * // -> "/p/.sous/backups/2026-11-15/0912-04"
     */
    it("should name the folder by date, then time", () => {
        expect(backupFolder("/p/.sous", new Date(2026, 10, 15, 9, 12, 4))).toBe(path.join("/p/.sous", "backups", "2026-11-15", "0912-04"));
    });
});
