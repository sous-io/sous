/**
 * `liquid.regions`: finds a template's top-level Liquid sections, wraps them in invisible markers
 * for one render of the whole file, and cuts the output back into one piece per section. A
 * section's output depends on everything before it, so the file renders once, whole; the markers
 * say where each section's output starts and ends, and which branch of an if or a loop ran.
 */

import { TagToken, Tokenizer, TokenKind, type Liquid } from "liquidjs";
import type {
    LiquidEngines,
    LiquidProblem,
    LiquidRegion,
    LiquidRegionOptions,
    LiquidRegions,
    MarkedSource,
    RegionRender,
    RegionSegment,
    RenderedRegion,
} from "./types.js";

/** Tags that always have an end tag. A custom tag is a block when the source closes it. */
const ALWAYS_BLOCKS = new Set(["if", "unless", "for", "case", "capture", "raw", "comment", "tablerow"]);

/** Blocks whose branches are counted. */
const BRANCHING = new Set(["if", "unless", "case", "for", "tablerow"]);

/** Tags that start a new branch inside a branching block. */
const INTERMEDIATE = new Set(["elsif", "else", "when"]);

/** The invisible separator markers are made of; it prints as nothing. */
const INVISIBLE = "⁣";

/** The names template authors most often set, which `uses` leaves out. */
const ASSIGNED = /\{%-?\s*(?:assign|capture|getFiles|for)\s+([A-Za-z_]\w*)/g;

/** One marker and where it goes in the original source. */
interface Insert {
    pos: number;
    text: string;
}

/** The service object, with a template engine built from `liquid.engine` the first time a method needs one. */
export function createLiquidRegions(engines: () => LiquidEngines): LiquidRegions {
    let fallback: Liquid | undefined;
    const engineOf = (options: LiquidRegionOptions | undefined): Liquid => {
        if (options?.engine) {
            return options.engine;
        }

        fallback ??= engines().create();

        return fallback;
    };

    return {
        find: (source, options) => findRegions(source, engineOf(options)),
        mark: (source, options) => markRegions(source, engineOf(options)),
        split: splitRender,
        uses: (source, options) => usedVariables(source, engineOf(options)),
        describeError,
        warning: (source, options) => filterWarning(source, engineOf(options)),
    };
}

/** The top-level sections of a source, in order. */
export function findRegions(source: string, engine: Liquid): LiquidRegion[] {
    const tokens = new Tokenizer(source, engine.options.operators).readTopLevelTokens(engine.options);
    const closers = new Set(
        tokens.filter((t): t is TagToken => t instanceof TagToken && t.name.startsWith("end")).map((t) => t.name.slice(3)),
    );
    const isBlock = (name: string) => ALWAYS_BLOCKS.has(name) || closers.has(name);

    const regions: LiquidRegion[] = [];
    const stack: { name: string; begin: number; head: string; branches: string[]; points: number[] }[] = [];

    for (const token of tokens) {
        if (token.kind === TokenKind.Output) {
            if (stack.length === 0) {
                regions.push({
                    from: token.begin,
                    to: token.end,
                    kind: "output",
                    label: (token as unknown as { content: string }).content.trim(),
                    head: token.getText(),
                });
            }

            continue;
        }

        if (!(token instanceof TagToken)) {
            continue;
        }

        const name = token.name;

        if (name.startsWith("end") && stack.length > 0) {
            closeBlock(stack, name.slice(3), token, regions);
            continue;
        }

        if (INTERMEDIATE.has(name) && stack.length === 1 && BRANCHING.has(stack[0]!.name)) {
            stack[0]!.branches.push(token.getText());
            stack[0]!.points.push(branchStart(source, token));
            continue;
        }

        if (isBlock(name)) {
            // A case's first branch is its first `when`, so the case tag itself opens none.
            const opens = stack.length === 0 && BRANCHING.has(name) && name !== "case";
            const loop = name === "for" || name === "tablerow";

            stack.push({
                name,
                begin: token.begin,
                head: token.getText(),
                branches: opens ? [loop ? "body" : token.getText()] : [],
                points: opens ? [branchStart(source, token)] : [],
            });
            continue;
        }

        if (stack.length === 0) {
            regions.push({ from: token.begin, to: token.end, kind: "tag", label: name, head: token.getText() });
        }
    }

    return regions;
}

/** Pops the stack down to the block an end tag closes, and records it when it was top-level. */
function closeBlock(
    stack: { name: string; begin: number; head: string; branches: string[]; points: number[] }[],
    open: string,
    token: TagToken,
    regions: LiquidRegion[],
): void {
    while (stack.length > 0) {
        const top = stack.pop()!;

        if (top.name !== open) {
            continue;
        }

        if (stack.length === 0) {
            const branching = BRANCHING.has(open) && top.points.length > 0;

            regions.push({
                from: top.begin,
                to: token.end,
                kind: "block",
                label: open,
                head: top.head,
                ...(branching ? { branches: top.branches, branchPoints: top.points } : {}),
            });
        }

        return;
    }
}

/** Where a branch's content starts: after the tag, and after the whitespace a `-%}` trims. */
function branchStart(source: string, token: TagToken): number {
    return token.getText().endsWith("-%}") ? skipWhitespace(source, token.end) : token.end;
}

/** The first offset at or after `pos` that is not whitespace. */
function skipWhitespace(source: string, pos: number): number {
    while (pos < source.length && /\s/.test(source[pos]!)) pos++;

    return pos;
}

/** The first offset at or before `pos` whose preceding character is not whitespace. */
function backOverWhitespace(source: string, pos: number): number {
    while (pos > 0 && /\s/.test(source[pos - 1]!)) pos--;

    return pos;
}

/** Wraps every section of a source in markers. */
export function markRegions(source: string, engine: Liquid): MarkedSource {
    const regions = findRegions(source, engine);
    const nonce = Math.random().toString(36).slice(2, 8);
    let marked = "";
    let last = 0;

    for (const insert of insertsOf(source, { nonce, regions })) {
        marked += source.slice(last, insert.pos) + insert.text;
        last = insert.pos;
    }

    return { source: marked + source.slice(last), nonce, regions };
}

/**
 * Every marker and its place in the original source, in order. A marker never sits in whitespace a
 * `{%-` or `-%}` trims, since LiquidJS would then stop trimming at the marker: a start marker goes
 * before the whitespace a `{%-` trims, and an end marker after the whitespace a `-%}` trims.
 */
function insertsOf(source: string, marked: Pick<MarkedSource, "nonce" | "regions">): Insert[] {
    const { nonce, regions } = marked;
    const inserts: Insert[] = [];
    let previousEnd = 0;

    regions.forEach((region, i) => {
        const trimsLeft = /^(\{%-|\{\{-)/.test(region.head);
        const trimsRight = /(-%\}|-\}\})$/.test(source.slice(region.from, region.to));
        const start = trimsLeft ? Math.max(backOverWhitespace(source, region.from), previousEnd) : region.from;
        const end = trimsRight ? skipWhitespace(source, region.to) : region.to;

        inserts.push({ pos: start, text: `${INVISIBLE}S${nonce}:${i}${INVISIBLE}` });
        region.branchPoints?.forEach((point, b) => inserts.push({ pos: point, text: `${INVISIBLE}B${nonce}:${i}:${b}${INVISIBLE}` }));
        inserts.push({ pos: end, text: `${INVISIBLE}E${nonce}:${i}${INVISIBLE}` });
        previousEnd = end;
    });

    return inserts;
}

/** Cuts a marked render's output at its markers, building the clean output as it goes. */
export function splitRender(rendered: string, marked: Pick<MarkedSource, "nonce" | "regions">): RegionRender {
    const regions: RenderedRegion[] = marked.regions.map(({ branchPoints, ...region }) => ({
        ...region,
        rendered: "",
        ...(branchPoints ? { ran: branchPoints.map(() => 0) } : {}),
    }));
    const segments: RegionSegment[] = [];
    const pattern = new RegExp(`${INVISIBLE}([SEB])${marked.nonce}:(\\d+)(?::(\\d+))?${INVISIBLE}`, "g");
    const openAt = new Map<number, number>();
    let output = "";
    let cursor = 0;

    for (const match of rendered.matchAll(pattern)) {
        output += rendered.slice(cursor, match.index);
        cursor = match.index + match[0].length;

        const index = Number(match[2]);
        const region = regions[index];

        if (!region) {
            continue;
        }

        if (match[1] === "B") {
            const ran = region.ran;
            const branch = Number(match[3]);

            if (ran && branch < ran.length) ran[branch]!++;
        } else if (match[1] === "S") {
            openAt.set(index, output.length);
        } else {
            const begin = openAt.get(index) ?? output.length;

            region.rendered = output.slice(begin);
            segments.push({ start: begin, end: output.length, region: index });
        }
    }

    return { output: output + rendered.slice(cursor), regions, segments };
}

/** The variables a template reads and does not set itself, or undefined when LiquidJS cannot tell. */
export function usedVariables(source: string, engine: Liquid): string[] | undefined {
    try {
        const assigned = new Set([...source.matchAll(ASSIGNED)].map((m) => m[1]!));

        return engine.globalVariablesSync(source).filter((name) => !assigned.has(name));
    } catch {
        // Some custom tags cannot be analysed; the list is then unknown.
        return undefined;
    }
}

/** LiquidJS's messages for the common mistakes, in plain words. */
function plainMessage(message: string): string {
    const m = message.replace(/\s+/g, " ").trim();
    const closable = ["if", "unless", "for", "case", "capture", "raw", "comment"];
    const rules: [RegExp, (x: RegExpMatchArray) => string][] = [
        [/expected filter name/i, () => "A | needs a filter name after it, such as upcase."],
        [/output ".*" not closed/i, () => "This {{ has no closing }}."],
        [/tag "?(end\w+)"? not found/i, (x) => `This {% ${x[1]} %} has no opening tag to close.`],
        [
            /tag "?\{%-?\s*(\w+)[^"]*?"? not closed/i,
            (x) => (closable.includes(x[1]!) ? `This {% ${x[1]} %} has no matching {% end${x[1]} %}.` : "This {% has no closing %}."),
        ],
        [/tag .* not closed/i, () => "This {% has no closing %}."],
        [/undefined filter:?\s*(\w+)/i, (x) => `There's no filter called ${x[1]}.`],
        [/tag "?(\w+)"? not found/i, (x) => `There's no tag called ${x[1]}.`],
        [/unexpected "?(end\w+)"?/i, (x) => `This {% ${x[1]} %} has no opening tag to close.`],
    ];

    for (const [re, say] of rules) {
        const x = m.match(re);

        if (x) return say(x);
    }

    return m;
}

/** A LiquidJS error in plain words, with its offset in the original source. */
export function describeError(error: unknown, source: string, marked?: MarkedSource): LiquidProblem {
    const raw = error instanceof Error ? error.message : String(error);
    const markers = new RegExp(`${INVISIBLE}[SEB]\\w+:\\d+(?::\\d+)?${INVISIBLE}`, "g");
    const message = plainMessage(raw)
        .replace(markers, "")
        .replace(/,?\s*line:\d+, col:\d+/, "")
        .replace(/\s+$/, "");
    const at = raw.match(/line:(\d+), col:(\d+)/);

    if (!at) {
        return { message, pos: null };
    }

    const rendered = marked ? marked.source : source;
    const pos = offsetOf(rendered, Number(at[1]), Number(at[2]));

    return { message, pos: Math.min(marked ? unmark(pos, source, marked) : pos, source.length) };
}

/** The offset of a 1-based line and column. */
function offsetOf(text: string, line: number, col: number): number {
    let pos = 0;
    let current = 1;

    while (current < line) {
        const newline = text.indexOf("\n", pos);

        if (newline < 0) break;
        pos = newline + 1;
        current++;
    }

    return Math.min(pos + col - 1, text.length);
}

/** An offset in a marked source, as an offset in the original. */
function unmark(pos: number, source: string, marked: MarkedSource): number {
    let shift = 0;
    let at = 0;

    for (const insert of insertsOf(source, marked)) {
        const markedAt = insert.pos + shift;

        if (pos < markedAt) break;
        if (pos < markedAt + insert.text.length) return insert.pos;
        shift += insert.text.length;
        at = insert.pos;
    }

    return Math.max(pos - shift, at);
}

/**
 * The first filter the engine does not have, or `|` with no filter name. LiquidJS passes an
 * unknown filter's input through unchanged, so the render alone would not show the mistake.
 */
export function filterWarning(source: string, engine: Liquid): LiquidProblem | undefined {
    const known = engine.filters;

    for (const block of source.matchAll(/\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}/g)) {
        // Blank out strings, so a | inside quotes is not read as a filter.
        const text = block[0].replace(/"[^"]*"|'[^']*'/g, (m) => " ".repeat(m.length));

        for (const m of text.matchAll(/\|\s*([A-Za-z_]\w*)?/g)) {
            // `||` is an operator in some expressions, not a filter.
            if (text[m.index + 1] === "|" || text[m.index - 1] === "|") continue;

            const name = m[1];

            if (!name) {
                return { message: "A | needs a filter name after it, such as upcase.", pos: block.index + m.index };
            }

            if (!(name in known)) {
                return { message: `There's no filter called ${name}, so it does nothing.`, pos: block.index + m.index + m[0].indexOf(name) };
            }
        }
    }

    return undefined;
}
