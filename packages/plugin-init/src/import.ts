/**
 * Importing a project's existing agent files into `.sous/`, which `sous init` does before the first
 * build, so the build that compiles `CLAUDE.md`, `AGENTS.md` and `.claude/skills/` never loses what a
 * person wrote there.
 *
 * - **Instruction files.** A root `CLAUDE.md` or `AGENTS.md` is copied, as plain markdown (no
 *   `.tpl.`, so a `{{` in it stays literal), to `.sous/memories/imported/`. A file that is only a
 *   link to the other, only points at it, or holds the same text is skipped.
 * - **Included files.** A line holding only `@path.md` is an include, for Claude Code and for sous
 *   alike. Every file the instructions include, and every file those include, is moved or copied
 *   to `.sous/includes/<its path from the project root>`, or left where it is, as the user chooses.
 *   The included files live outside `.sous/memories/` because the starter source includes every
 *   file under that folder, and an included file must be pulled in only where its include line is.
 * - **References.** Every `@path` a copied file holds is rewritten so it still finds its file:
 *   includes relative to the file's new place, and other references (which Claude Code resolves
 *   from the compiled file at the project root) relative to the project root.
 * - **Skills.** Every skill folder in `.claude/skills/` moves to `.sous/skills/`, and the config
 *   compiles them back.
 *
 * Planning reads only. Nothing is written until {@link applyImport}, which backs up every file it
 * moves to `.sous/backups/<date>/<time>/`, so a move can always be undone.
 */

import fs from "node:fs";
import path from "node:path";

/** The instruction files sous compiles at the project root, in the order they are imported. */
export const INSTRUCTION_FILES = ["CLAUDE.md", "AGENTS.md"] as const;

/** Where imported instruction files go, relative to `.sous/`. */
export const IMPORTED_DIR = "memories/imported";

/** Where moved or copied included files go, relative to `.sous/`. */
export const INCLUDES_DIR = "includes";

/** Where a project's own skills live, relative to `.sous/`. */
export const PROJECT_SKILLS_DIR = "skills";

/** Where Claude Code reads skills from, relative to the project root. */
export const CLAUDE_SKILLS_DIR = ".claude/skills";

/** Where backups go, relative to `.sous/`. */
export const BACKUPS_DIR = "backups";

/** What happens to a file the instructions include. */
export type IncludeFate = "move" | "copy" | "leave";

/** An instruction file that will be imported. */
export interface InstructionImport {
    /** `CLAUDE.md` or `AGENTS.md`. */
    readonly name: string;
    readonly source: string;
    readonly dest: string;
}

/** An instruction file that will not be imported, and why. */
export interface InstructionSkip {
    readonly source: string;
    readonly reason: string;
}

/** A file the instructions include, directly or through another included file. */
export interface IncludedFile {
    readonly source: string;
    /** Its path from the project root, with `/` separators. */
    readonly relative: string;
    /** The files whose include lines name it. */
    readonly includedBy: string[];
    /** Why it always stays where it is, when it does. */
    pinned?: string;
}

/** A skill folder in `.claude/skills/`. */
export interface SkillImport {
    readonly name: string;
    readonly source: string;
    readonly dest: string;
}

/** What an import would do, before any include has a fate. */
export interface ImportScan {
    readonly root: string;
    readonly sousDir: string;
    readonly instructions: InstructionImport[];
    readonly skipped: InstructionSkip[];
    /** In the order they were found: parents before the files they include. */
    readonly includes: IncludedFile[];
    readonly skills: SkillImport[];
}

/** One step of an applied import, for the report. */
export interface ImportStep {
    readonly kind: "imported" | "moved" | "copied" | "left" | "skipped" | "turned-off";
    readonly source: string;
    readonly dest?: string;
    readonly backup?: string;
    readonly note?: string;
}

/** What an import did (or, in a dry run, would do). */
export interface ImportOutcome {
    readonly steps: ImportStep[];
    /** Every file written, absolute. */
    readonly written: string[];
    /** Every path removed from where it was, absolute (moved files and skill folders). */
    readonly removed: string[];
    /** The paths, relative to the project root, that git should stop tracking. */
    readonly untrack: string[];
    /** Whether a starter memory is still needed: nothing was imported. */
    readonly nothingImported: boolean;
}

/** An `@` reference in a file. */
interface Reference {
    /** The line, from 0. */
    readonly line: number;
    /** Whether the reference is the whole line. */
    readonly whole: boolean;
    /** The path as written. */
    readonly token: string;
    /** Where the token starts in the line, after the `@`. */
    readonly start: number;
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/** How short a file must be, without whitespace, to count as only pointing at the other one. */
const POINTER_MAX_CHARACTERS = 400;

/** How many non-blank lines a file may have and still count as only pointing at the other one. */
const POINTER_MAX_LINES = 3;

/** Path separators as `/`, on every platform. */
function posix(file: string): string {
    return file.split(path.sep).join("/");
}

/** Whether `file` is inside `root`. */
function inside(root: string, file: string): boolean {
    const relative = path.relative(root, file);

    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * Every `@` reference outside fenced code blocks and inline code. A line holding only `@path` is a
 * whole-line reference; anything else is a mention inside text.
 *
 * ```ts
 * findReferences("@docs/testing.md\nSee @package.json for scripts.\n```\n@not-this.md\n```");
 * // -> [{ line: 0, whole: true, token: "docs/testing.md" }, { line: 1, whole: false, token: "package.json" }]
 * ```
 */
export function findReferences(content: string): Reference[] {
    const found: Reference[] = [];
    let fence: string | null = null;

    for (const [index, line] of content.split("\n").entries()) {
        if (fence !== null) {
            const close = FENCE_CLOSE.exec(line);

            if (close && close[1]![0] === fence[0] && close[1]!.length >= fence.length) {
                fence = null;
            }

            continue;
        }

        const open = FENCE_OPEN.exec(line);

        if (open) {
            fence = open[1]!;
            continue;
        }

        const trimmed = line.trim();

        if (/^@\S+$/.test(trimmed)) {
            found.push({ line: index, whole: true, token: trimmed.slice(1), start: line.indexOf("@") + 1 });
            continue;
        }

        const code: Array<[number, number]> = [];

        for (const span of line.matchAll(/`+[^`]*`+/g)) {
            code.push([span.index, span.index + span[0].length]);
        }

        for (const mention of line.matchAll(/(^|[\s(])@([^\s`()[\]<>"']+)/g)) {
            const at = mention.index + mention[1]!.length;

            if (code.some(([from, to]) => at >= from && at < to)) {
                continue;
            }

            const token = mention[2]!.replace(/[.,;:!?]+$/, "");

            if (token !== "") {
                found.push({ line: index, whole: false, token, start: at + 1 });
            }
        }
    }

    return found;
}

/**
 * The file a reference names, resolved from the folder of the file holding it, or `undefined` when
 * it names no file on disk or is not a plain path (a sous sigil, a variable, a glob, a home path).
 */
export function resolveReference(token: string, fromDir: string): string | undefined {
    if (/^[~#$]/.test(token) || /[*?[\]{}]/.test(token) || token.includes("${")) {
        return undefined;
    }

    const file = path.isAbsolute(token) ? token : path.resolve(fromDir, token);

    try {
        return fs.statSync(file).isFile() ? file : undefined;
    } catch {
        return undefined;
    }
}

/** Whether a whole-line reference names a markdown file, which makes it an include. */
function isMarkdown(token: string): boolean {
    return token.toLowerCase().endsWith(".md");
}

/**
 * Whether `content` only points at `other`: a few short lines that name it.
 *
 * ```ts
 * onlyPointsAt("Read `CLAUDE.md`; it holds the instructions.\n", "CLAUDE.md"); // -> true
 * onlyPointsAt("@CLAUDE.md\n", "CLAUDE.md");                                 // -> true
 * ```
 */
function onlyPointsAt(content: string, other: string): boolean {
    const lines = content.split("\n").filter((line) => line.trim() !== "");

    return lines.length <= POINTER_MAX_LINES && content.replace(/\s+/g, "").length <= POINTER_MAX_CHARACTERS && content.includes(other);
}

/** The instruction files to import, and the ones to skip. */
function scanInstructions(root: string, sousDir: string): { instructions: InstructionImport[]; skipped: InstructionSkip[] } {
    const present = INSTRUCTION_FILES.map((name) => ({ name, source: path.join(root, name) })).filter(({ source }) => {
        try {
            return fs.statSync(source).isFile();
        } catch {
            return false;
        }
    });
    const instructions: InstructionImport[] = [];
    const skipped: InstructionSkip[] = [];
    const real = (file: string) => fs.realpathSync(file);
    const text = (file: string) => fs.readFileSync(file, "utf8");

    for (const { name, source } of present) {
        const other = present.find((candidate) => candidate.name !== name);

        if (other !== undefined) {
            if (fs.lstatSync(source).isSymbolicLink() && real(source) === real(other.source)) {
                skipped.push({ source, reason: `a link to ${other.name}` });
                continue;
            }

            const imported = instructions.find((candidate) => candidate.name === other.name);

            if (imported !== undefined && text(source) === text(other.source)) {
                skipped.push({ source, reason: `the same text as ${other.name}` });
                continue;
            }

            if (onlyPointsAt(text(source), other.name) && !onlyPointsAt(text(other.source), name)) {
                skipped.push({ source, reason: `it only points at ${other.name}` });
                continue;
            }
        }

        instructions.push({ name, source, dest: path.join(sousDir, IMPORTED_DIR, name) });
    }

    return { instructions, skipped };
}

/** The skill folders in `.claude/skills/`. */
function scanSkills(root: string, sousDir: string): SkillImport[] {
    const directory = path.join(root, CLAUDE_SKILLS_DIR);

    if (!fs.existsSync(directory)) {
        return [];
    }

    return fs
        .readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
        .map((name) => ({ name, source: path.join(directory, name), dest: path.join(sousDir, PROJECT_SKILLS_DIR, name) }));
}

/**
 * Works out what importing would do: which instruction files are imported, every file they include
 * (following includes all the way down), and the skill folders. Reads only.
 */
export function scanImport(root: string, sousDir: string): ImportScan {
    const { instructions, skipped } = scanInstructions(root, sousDir);
    const includes = new Map<string, IncludedFile>();
    const instructionSources = new Set(INSTRUCTION_FILES.map((name) => path.join(root, name)));
    const queue = instructions.map((instruction) => instruction.source);

    while (queue.length > 0) {
        const file = queue.shift()!;
        const content = fs.readFileSync(file, "utf8");

        for (const reference of findReferences(content)) {
            if (!reference.whole || !isMarkdown(reference.token)) {
                continue;
            }

            const target = resolveReference(reference.token, path.dirname(file));

            if (target === undefined || instructionSources.has(target)) {
                continue;
            }

            const known = includes.get(target);

            if (known !== undefined) {
                if (!known.includedBy.includes(file)) {
                    known.includedBy.push(file);
                }

                continue;
            }

            const included: IncludedFile = { source: target, relative: posix(path.relative(root, target)), includedBy: [file] };

            if (!inside(root, target)) {
                included.pinned = "it is outside the project";
            } else if (path.basename(target).toLowerCase() === "readme.md") {
                included.pinned = "a README stays where people look for it";
            }

            includes.set(target, included);
            queue.push(target);
        }
    }

    return { root, sousDir, instructions, skipped, includes: [...includes.values()], skills: scanSkills(root, sousDir) };
}

/**
 * Settles every include's fate from the user's answer. A pinned file stays. A file included by a
 * file that stays must not move (the file that stays is never edited, so its include line must keep
 * finding it), so a move becomes a copy there.
 *
 * @param choose - Asked for each file when the answer was "choose for each file"; parents first.
 */
export async function settleFates(
    scan: ImportScan,
    answer: IncludeFate | "choose",
    choose: (file: IncludedFile) => Promise<IncludeFate>,
): Promise<Map<string, IncludeFate>> {
    const fates = new Map<string, IncludeFate>();
    const stays = (file: string) => fates.get(file) === "leave";

    for (const file of scan.includes) {
        if (file.pinned !== undefined) {
            fates.set(file.source, "leave");
            continue;
        }

        let fate = answer === "choose" ? await choose(file) : answer;

        if (fate === "move" && file.includedBy.some(stays)) {
            fate = "copy";
        }

        fates.set(file.source, fate);
    }

    return fates;
}

/** Where a file will be once the import is done. */
function finalPlace(scan: ImportScan, fates: Map<string, IncludeFate>, file: string): string {
    const instruction = scan.instructions.find((candidate) => candidate.source === file);

    if (instruction !== undefined) {
        return instruction.dest;
    }

    const fate = fates.get(file);

    return fate === "move" || fate === "copy" ? path.join(scan.sousDir, INCLUDES_DIR, path.relative(scan.root, file)) : file;
}

/** A path for Claude Code, read from the compiled file at the project root. */
function fromRoot(root: string, file: string): string {
    return inside(root, file) ? posix(path.relative(root, file)) : file;
}

/** Whether sous would read a line as a malformed include, which fails the build. */
function looksLikeInclude(line: string): boolean {
    if (!/^@\S+$/.test(line)) {
        return false;
    }

    const word = line.slice(1);

    return word.includes("/") || /\.md\b/.test(word) || /^[~#.$]/.test(word);
}

/**
 * A copied file's text with every reference rewritten to work from its new place, and the include
 * lines that name a missing file turned into comments (Claude Code ignores a missing file, sous
 * stops the build on one).
 */
export function rewriteReferences(
    scan: ImportScan,
    fates: Map<string, IncludeFate>,
    source: string,
    dest: string,
    content: string,
): { content: string; turnedOff: string[] } {
    const lines = content.split("\n");
    const turnedOff: string[] = [];
    const references = findReferences(content);
    const importedInstructions = new Set(scan.instructions.map((instruction) => instruction.source));

    // Right to left within a line, so earlier offsets stay valid.
    for (const reference of [...references].reverse()) {
        const line = lines[reference.line]!;
        const target = resolveReference(reference.token, path.dirname(source));

        if (reference.whole) {
            if (target === undefined) {
                if (isMarkdown(reference.token) || looksLikeInclude(line.trim())) {
                    lines[reference.line] = `<!-- ${line.trim()} (sous init turned this include off: no such file) -->`;
                    turnedOff.push(reference.token);
                }

                continue;
            }

            if (isMarkdown(reference.token) && importedInstructions.has(target)) {
                // Both instruction files are included by the starter source already.
                lines[reference.line] = "";
                continue;
            }

            if (isMarkdown(reference.token)) {
                const place = finalPlace(scan, fates, target);
                const moved = place !== target;
                const rewritten = moved ? posix(path.relative(path.dirname(dest), place)) : inside(scan.root, target) ? `#project/${posix(path.relative(scan.root, target))}` : target;

                lines[reference.line] = `@${rewritten}`;
                continue;
            }

            const rewritten = `@${fromRoot(scan.root, finalPlace(scan, fates, target))}`;

            lines[reference.line] = looksLikeInclude(rewritten) ? `See ${rewritten}` : rewritten;
            continue;
        }

        if (target === undefined) {
            continue;
        }

        const rewritten = fromRoot(scan.root, finalPlace(scan, fates, target));

        lines[reference.line] = line.slice(0, reference.start) + rewritten + line.slice(reference.start + reference.token.length);
    }

    return { content: lines.join("\n"), turnedOff: turnedOff.reverse() };
}

/** The backup folder for one run: `.sous/backups/<YYYY-MM-DD>/<HHMM-SS>`, in local time. */
export function backupFolder(sousDir: string, now: Date): string {
    const pad = (value: number) => String(value).padStart(2, "0");
    const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const time = `${pad(now.getHours())}${pad(now.getMinutes())}-${pad(now.getSeconds())}`;

    return path.join(sousDir, BACKUPS_DIR, day, time);
}

/** Every file under a folder, absolute. */
function filesUnder(directory: string): string[] {
    return fs.readdirSync(directory, { withFileTypes: true, recursive: true }).filter((entry) => entry.isFile()).map((entry) => path.join(entry.parentPath, entry.name));
}

/** Options for {@link applyImport}. */
export interface ApplyOptions {
    readonly dryRun: boolean;
    readonly now?: Date;
}

/**
 * Writes the import: the instruction copies, the moved and copied includes, the moved skills, and a
 * backup of everything moved. In a dry run, works out the same steps and writes nothing.
 */
export function applyImport(scan: ImportScan, fates: Map<string, IncludeFate>, options: ApplyOptions): ImportOutcome {
    const steps: ImportStep[] = [];
    const written: string[] = [];
    const removed: string[] = [];
    const untrack: string[] = [];
    const backups = backupFolder(scan.sousDir, options.now ?? new Date());
    const write = (file: string, content: string) => {
        if (!options.dryRun) {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, content, "utf8");
        }

        written.push(file);
    };
    const backUp = (file: string): string => {
        const backup = path.join(backups, path.relative(scan.root, file));

        if (!options.dryRun) {
            fs.mkdirSync(path.dirname(backup), { recursive: true });
            fs.cpSync(file, backup, { recursive: true });
        }

        return backup;
    };
    const copyOver = (source: string, dest: string, kind: "imported" | "moved" | "copied", note?: string) => {
        const rewritten = rewriteReferences(scan, fates, source, dest, fs.readFileSync(source, "utf8"));

        write(dest, rewritten.content);

        for (const token of rewritten.turnedOff) {
            steps.push({ kind: "turned-off", source, note: `the include @${token} names no file, so it is now a comment` });
        }

        return { kind, source, dest, ...(note === undefined ? {} : { note }) };
    };

    // Both root files become build output, so git stops tracking both, imported or not.
    for (const skip of scan.skipped) {
        steps.push({ kind: "skipped", source: skip.source, note: skip.reason });
        untrack.push(posix(path.relative(scan.root, skip.source)));
    }

    for (const instruction of scan.instructions) {
        steps.push(copyOver(instruction.source, instruction.dest, "imported"));
        untrack.push(posix(path.relative(scan.root, instruction.source)));
    }

    for (const file of scan.includes) {
        const fate = fates.get(file.source) ?? "leave";

        if (fate === "leave") {
            steps.push({ kind: "left", source: file.source, ...(file.pinned === undefined ? {} : { note: `left where it is: ${file.pinned}` }) });
            continue;
        }

        const dest = finalPlace(scan, fates, file.source);
        const step = copyOver(file.source, dest, fate === "move" ? "moved" : "copied");

        if (fate === "move") {
            const backup = backUp(file.source);

            if (!options.dryRun) {
                fs.rmSync(file.source);
            }

            removed.push(file.source);
            steps.push({ ...step, backup });
        } else {
            steps.push(step);
        }
    }

    for (const skill of scan.skills) {
        if (fs.existsSync(skill.dest)) {
            steps.push({ kind: "skipped", source: skill.source, note: `${posix(path.relative(scan.root, skill.dest))} already exists` });
            continue;
        }

        for (const file of filesUnder(skill.source)) {
            written.push(path.join(skill.dest, path.relative(skill.source, file)));
        }

        const backup = backUp(skill.source);

        if (!options.dryRun) {
            fs.mkdirSync(path.dirname(skill.dest), { recursive: true });
            fs.cpSync(skill.source, skill.dest, { recursive: true });
            fs.rmSync(skill.source, { recursive: true });
        }

        removed.push(skill.source);
        untrack.push(posix(path.relative(scan.root, skill.source)));
        steps.push({ kind: "moved", source: skill.source, dest: skill.dest, backup });
    }

    return { steps, written, removed, untrack, nothingImported: scan.instructions.length === 0 };
}
