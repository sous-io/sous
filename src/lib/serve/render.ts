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

export type Region = {
  from: number;
  to: number;
  kind: "output" | "tag" | "block";
  /** Tag name, or the variable expression for an output. */
  label: string;
  rendered: string;
};

export type RenderResult = {
  regions: Region[];
  output: string;
  /** Where each region's output sits inside `output`. */
  segments: { start: number; end: number; region: number }[];
  error?: string;
  ms: number;
};

const ALWAYS_BLOCKS = new Set(["if", "unless", "for", "case", "capture", "raw", "comment", "tablerow"]);

export function findRegions(source: string, engine: Liquid): Omit<Region, "rendered">[] {
  const tokens = new Tokenizer(source, engine.options.operators).readTopLevelTokens(engine.options);
  const closers = new Set(
    tokens.filter((t): t is TagToken => t instanceof TagToken && t.name.startsWith("end")).map((t) => t.name.slice(3))
  );
  const isBlock = (name: string) => ALWAYS_BLOCKS.has(name) || closers.has(name);

  const regions: Omit<Region, "rendered">[] = [];
  const stack: { name: string; begin: number }[] = [];

  for (const token of tokens) {
    if (token.kind === TokenKind.Output) {
      if (stack.length === 0) {
        regions.push({ from: token.begin, to: token.end, kind: "output", label: (token as unknown as { content: string }).content.trim() });
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
            regions.push({ from: top.begin, to: token.end, kind: "block", label: open });
          }
          break;
        }
      }
      continue;
    }
    if (isBlock(name)) {
      stack.push({ name, begin: token.begin });
      continue;
    }
    if (stack.length === 0) {
      regions.push({ from: token.begin, to: token.end, kind: "tag", label: name });
    }
  }
  return regions;
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
  source: string
): Promise<RenderResult> {
  const started = performance.now();
  const done = (r: Omit<RenderResult, "ms">): RenderResult => ({ ...r, ms: Math.round((performance.now() - started) * 10) / 10 });

  if (!file.isTpl) {
    return done({ regions: [], output: source, segments: [] });
  }

  const dir = path.dirname(file.path);
  const vars = { ...file.vars, sousTemplatePath: file.path, sousTemplateDir: dir };
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
    return done({ regions: [], output: source, segments: [], error: (error as Error).message });
  }

  const nonce = Math.random().toString(36).slice(2, 8);
  const start = (i: number) => `⁣S${nonce}:${i}⁣`;
  const end = (i: number) => `⁣E${nonce}:${i}⁣`;

  let marked = "";
  let last = 0;
  found.forEach((region, i) => {
    marked += source.slice(last, region.from) + start(i) + source.slice(region.from, region.to) + end(i);
    last = region.to;
  });
  marked += source.slice(last);

  let rendered: string;
  try {
    rendered = await engine.parseAndRender(marked, vars);
  } catch (error) {
    return done({
      regions: found.map((r) => ({ ...r, rendered: "" })),
      output: source,
      segments: [],
      error: (error as Error).message,
    });
  }

  const secrets = workspace.secretNames.map((name) => vars[name]).filter((v): v is string => typeof v === "string");
  rendered = maskSecrets(rendered, secrets);

  // Cut the rendered text at the markers, building the clean output as we go.
  const regions: Region[] = found.map((r) => ({ ...r, rendered: "" }));
  const segments: RenderResult["segments"] = [];
  const markerPattern = new RegExp(`⁣([SE])${nonce}:(\\d+)⁣`, "g");
  let output = "";
  let cursor = 0;
  const openAt = new Map<number, number>();
  for (const match of rendered.matchAll(markerPattern)) {
    output += rendered.slice(cursor, match.index);
    cursor = match.index! + match[0].length;
    const index = Number(match[2]);
    if (match[1] === "S") {
      openAt.set(index, output.length);
    } else {
      const begin = openAt.get(index) ?? output.length;
      regions[index].rendered = output.slice(begin);
      segments.push({ start: begin, end: output.length, region: index });
    }
  }
  output += rendered.slice(cursor);

  return done({ regions, output, segments });
}
