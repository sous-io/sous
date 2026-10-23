/**
 * PROOF OF CONCEPT for `sous serve`. Renders one template and reports, for each
 * top-level Liquid section, where it sits in the source and what it rendered to.
 *
 * A section is one `{{ output }}`, one inline tag (`{% assign %}`), or a whole
 * block from its opening tag to its matching end tag (`{% if %}...{% endif %}`).
 * The whole file is rendered at once, because a section's output depends on
 * everything before it; invisible markers around each section let the output
 * be cut back into per-section pieces.
 */
import path from "node:path";
import { Tokenizer, TagToken, TokenKind, type Liquid } from "liquidjs";
import { createLiquidEngine } from "../../templating/init-liquid-engine.js";
import type { Workspace, WorkspaceFile } from "./workspace.js";
import { countTokens } from "./preview-build.js";

export type Region = {
  from: number;
  to: number;
  kind: "output" | "tag" | "block";
  /** Tag name, or the variable expression for an output. */
  label: string;
  /** Source text of the opening tag (or the whole output), e.g. `{% if x == "y" %}`. */
  head: string;
  /** For if/unless/case/for blocks: each branch's tag text (a for's body is "body"). */
  branches?: string[];
  /** How many times each branch ran (a for's body count is its number of loops). */
  ran?: number[];
  /** Where each branch's content starts in the source (not sent to the browser). */
  branchPoints?: number[];
  rendered: string;
};

export type RenderResult = {
  regions: Region[];
  output: string;
  /** Where each region's output sits inside `output`. */
  segments: { start: number; end: number; region: number }[];
  error?: string;
  /** Offset in the source where the error is, when the message says. */
  errorPos?: number;
  ms: number;
  /** Tokens in `output`. */
  tokens: number;
  /** The scope variables the template reads (LiquidJS static analysis), when it could tell. */
  uses?: string[];
  /** A mistake that doesn't stop rendering, such as a filter name that doesn't exist. */
  warning?: string;
  warningPos?: number;
};

const ALWAYS_BLOCKS = new Set(["if", "unless", "for", "case", "capture", "raw", "comment", "tablerow"]);

/** Where a branch's content starts: after the tag, and after the whitespace a `-%}` trims. */
function branchStart(source: string, token: TagToken): number {
  let pos = token.end;
  if (token.getText().endsWith("-%}")) while (pos < source.length && /\s/.test(source[pos])) pos++;
  return pos;
}

export function findRegions(source: string, engine: Liquid): Omit<Region, "rendered">[] {
  const tokens = new Tokenizer(source, engine.options.operators).readTopLevelTokens(engine.options);
  const closers = new Set(
    tokens.filter((t): t is TagToken => t instanceof TagToken && t.name.startsWith("end")).map((t) => t.name.slice(3))
  );
  const isBlock = (name: string) => ALWAYS_BLOCKS.has(name) || closers.has(name);

  const regions: Omit<Region, "rendered">[] = [];
  const stack: { name: string; begin: number; head: string; branches: string[]; points: number[] }[] = [];
  const BRANCHING = new Set(["if", "unless", "case", "for", "tablerow"]);
  const INTERMEDIATE = new Set(["elsif", "else", "when"]);

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
    if (!(token instanceof TagToken)) continue;

    const name = token.name;
    if (name.startsWith("end") && stack.length > 0) {
      const open = name.slice(3);
      while (stack.length > 0) {
        const top = stack.pop()!;
        if (top.name === open) {
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
          break;
        }
      }
      continue;
    }
    if (INTERMEDIATE.has(name) && stack.length === 1 && BRANCHING.has(stack[0].name)) {
      stack[0].branches.push(token.getText());
      stack[0].points.push(branchStart(source, token));
      continue;
    }
    if (isBlock(name)) {
      const opens = stack.length === 0 && BRANCHING.has(name) && name !== "case";
      stack.push({
        name,
        begin: token.begin,
        head: token.getText(),
        branches: opens ? [name === "for" || name === "tablerow" ? "body" : token.getText()] : [],
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

/** LiquidJS's messages for the common mistakes, in plain words. */
function plainError(message: string): string {
  const m = message.replace(/\s+/g, " ").trim();
  const rules: [RegExp, (x: RegExpMatchArray) => string][] = [
    [/expected filter name/i, () => "A | needs a filter name after it, such as upcase."],
    [/output ".*" not closed/i, () => "This {{ has no closing }}."],
    [/tag "?(end\w+)"? not found/i, (x) => `This {% ${x[1]} %} has no opening tag to close.`],
    [/tag "?\{%-?\s*(\w+)[^"]*?"? not closed/i, (x) => (["if", "unless", "for", "case", "capture", "raw", "comment"].includes(x[1]) ? `This {% ${x[1]} %} has no matching {% end${x[1]} %}.` : "This {% has no closing %}.")],
    [/tag .* not closed/i, () => "This {% has no closing %}."],
    [/undefined filter:?\s*(\w+)/i, (x) => `There's no filter called ${x[1]}.`],
    [/tag "?(\w+)"? not found/i, (x) => `There's no tag called ${x[1]}.`],
    [/unexpected "?(end\w+)"?/i, (x) => `This {% ${x[1]} %} has no opening tag to close.`],
    [/expected "?(\w+)"? \(?(?:to be|token)?/i, () => m],
  ];
  for (const [re, say] of rules) {
    const x = m.match(re);
    if (x) return say(x);
  }
  return m;
}

function describeError(error: unknown, source: string): { error: string; errorPos?: number } {
  const raw = (error as Error).message ?? String(error);
  const message = plainError(raw);
  const at = raw.match(/line:(\d+), col:(\d+)/);
  if (!at) return { error: message.replace(/,?\s*line:\d+, col:\d+/, "") };
  const lines = source.split("\n");
  const line = Number(at[1]);
  const col = Number(at[2]);
  let pos = 0;
  for (let i = 0; i < line - 1 && i < lines.length; i++) pos += lines[i].length + 1;
  return { error: message.replace(/,?\s*line:\d+, col:\d+/, "").replace(/\s+$/, ""), errorPos: Math.min(pos + col - 1, source.length) };
}

function maskSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= 4) out = out.split(secret).join("••••••");
  }
  return out;
}

export async function renderTemplate(
  workspace: Workspace,
  file: WorkspaceFile,
  source: string,
  overrides: Record<string, string> = {}
): Promise<RenderResult> {
  const started = performance.now();
  const done = (r: Omit<RenderResult, "ms" | "tokens">): RenderResult => ({
    ...r,
    ms: Math.round((performance.now() - started) * 10) / 10,
    tokens: countTokens(r.output),
  });

  if (!file.isTpl) {
    return done({ regions: [], output: source, segments: [] });
  }

  const dir = path.dirname(file.path);
  const vars = { ...file.vars, ...overrides, sousTemplatePath: file.path, sousTemplateDir: dir };
  const { compilation } = workspace;
  const engine = createLiquidEngine([dir], {
    aliases: compilation.aliases,
    views: compilation.views,
    scope: { ...compilation.includeScope, ...vars },
    namespaceResolver: workspace.namespaceResolver,
    fromFile: file.path,
    secretVariables: compilation.secretVariables,
  });

  let found: Omit<Region, "rendered">[];
  try {
    found = findRegions(source, engine);
  } catch (error) {
    return done({ regions: [], output: source, segments: [], ...describeError(error, source) });
  }

  const nonce = Math.random().toString(36).slice(2, 8);
  const start = (i: number) => `⁣S${nonce}:${i}⁣`;
  const end = (i: number) => `⁣E${nonce}:${i}⁣`;

  const branch = (i: number, b: number) => `\u2063B${nonce}:${i}:${b}\u2063`;
  const inserts: { pos: number; text: string }[] = [];
  found.forEach((region, i) => {
    inserts.push({ pos: region.from, text: start(i) });
    region.branchPoints?.forEach((p, b) => inserts.push({ pos: p, text: branch(i, b) }));
    inserts.push({ pos: region.to, text: end(i) });
  });
  let marked = "";
  let last = 0;
  for (const ins of inserts) {
    marked += source.slice(last, ins.pos) + ins.text;
    last = ins.pos;
  }
  marked += source.slice(last);

  let rendered: string;
  try {
    rendered = await engine.parseAndRender(marked, vars);
  } catch (error) {
    // Parse the unmarked source again, so a syntax error's line and column are right.
    let described = describeError(error, source);
    try {
      engine.parse(source);
    } catch (parseError) {
      described = describeError(parseError, source);
    }
    return done({
      regions: found.map((r) => ({ ...r, rendered: "" })),
      output: source,
      segments: [],
      ...described,
    });
  }

  const secrets = workspace.secretNames.map((name) => vars[name]).filter((v): v is string => typeof v === "string");
  rendered = maskSecrets(rendered, secrets);

  // Cut the rendered text at the markers, building the clean output as we go.
  const regions: Region[] = found.map(({ branchPoints, ...r }) => ({
    ...r,
    rendered: "",
    ...(branchPoints ? { ran: branchPoints.map(() => 0) } : {}),
  }));
  const segments: RenderResult["segments"] = [];
  const markerPattern = new RegExp(`\u2063([SEB])${nonce}:(\\d+)(?::(\\d+))?\u2063`, "g");
  let output = "";
  let cursor = 0;
  const openAt = new Map<number, number>();
  for (const match of rendered.matchAll(markerPattern)) {
    output += rendered.slice(cursor, match.index);
    cursor = match.index! + match[0].length;
    const index = Number(match[2]);
    if (match[1] === "B") {
      const ran = regions[index].ran;
      if (ran) ran[Number(match[3])]++;
    } else if (match[1] === "S") {
      openAt.set(index, output.length);
    } else {
      const begin = openAt.get(index) ?? output.length;
      regions[index].rendered = output.slice(begin);
      segments.push({ start: begin, end: output.length, region: index });
    }
  }
  output += rendered.slice(cursor);

  let uses: string[] | undefined;
  try {
    const assigned = new Set(
      [...source.matchAll(/\{%-?\s*(?:assign|capture|getFiles|for)\s+([A-Za-z_]\w*)/g)].map((m) => m[1])
    );
    uses = engine.globalVariablesSync(source).filter((name) => !assigned.has(name));
  } catch {
    // Some custom tags can't be analysed; the list is then unknown.
  }

  // LiquidJS passes an unknown filter's input through unchanged; say so instead.
  let warning: string | undefined;
  let warningPos: number | undefined;
  const known = (engine as unknown as { filters: Record<string, unknown> }).filters ?? {};
  for (const block of source.matchAll(/\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}/g)) {
    const text = block[0].replace(/"[^"]*"|'[^']*'/g, (m) => " ".repeat(m.length));
    for (const m of text.matchAll(/\|\s*([A-Za-z_]\w*)?/g)) {
      if (text[m.index! + 1] === "|" || text[m.index! - 1] === "|") continue;
      const name = m[1];
      if (!name) {
        warning = "A | needs a filter name after it, such as upcase.";
        warningPos = block.index! + m.index!;
      } else if (!(name in known)) {
        warning = `There's no filter called ${name}, so it does nothing.`;
        warningPos = block.index! + m.index! + m[0].indexOf(name);
      }
      if (warning) break;
    }
    if (warning) break;
  }

  return done({ regions, output, segments, uses, warning, warningPos });
}
