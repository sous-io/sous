/**
 * PROOF OF CONCEPT for `sous serve`. Runs a real build of every target into a
 * temporary folder, so the GUI can show, without touching the project:
 *
 *   - what each output file would contain, and its token count;
 *   - which source files each output is built from (the include graph);
 *   - whether the output on disk is up to date with that build.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { get_encoding, type Tiktoken } from "tiktoken";
import { parse as parseYaml } from "yaml";
import { CompilationService, resolveOutputPath, type CompilationTarget } from "../markdown-compiler.js";
import { quietly, type Workspace } from "./workspace.js";

export type OutputInfo = {
  /** Output path relative to the project root. */
  output: string;
  /** Id of the entry (target) file that builds it. */
  entryId: string;
  /** Ids of every source file this output is built from, entry first. */
  sources: string[];
  tokens: number;
  bytes: number;
  status: "up-to-date" | "stale" | "missing" | "failed";
  /** Why the build failed, when it did. */
  error?: string;
  /** Agent-facing kind, guessed from the path. */
  kind: "instructions" | "skill" | "reference" | "memory" | "other";
  /** For a skill: the frontmatter `name` and `description`, which agents load up front. */
  skillName?: string;
  description?: string;
  descriptionTokens?: number;
};

export type PreviewBuild = {
  outputs: OutputInfo[];
  /** File id -> output paths it feeds. */
  usedBy: Record<string, string[]>;
  ms: number;
  builtAt: string;
};

let encoder: Tiktoken | null = null;
export function countTokens(text: string): number {
  encoder ??= get_encoding("o200k_base");
  return encoder.encode(text).length;
}

function kindOf(output: string): OutputInfo["kind"] {
  const base = path.basename(output);
  if (/^(CLAUDE|AGENTS|GEMINI)\.md$/i.test(base)) return "instructions";
  if (base === "SKILL.md") return "skill";
  if (output.includes("/references/") || output.includes("/examples/")) return "reference";
  if (output.includes("memor")) return "memory";
  return "other";
}

const contents = new Map<string, string>();
let last: PreviewBuild | null = null;

/** The most recent preview build, if one has finished. */
export function lastPreviewBuild(): PreviewBuild | null {
  return last;
}

/** The built text of one output from the last preview build. */
export function previewContent(output: string): string | undefined {
  return contents.get(output);
}

export async function runPreviewBuild(workspace: Workspace): Promise<PreviewBuild> {
  const started = performance.now();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sous-serve-"));
  const idByPath = new Map(workspace.files.map((f) => [f.path, f.id]));
  const outputs: OutputInfo[] = [];
  const usedBy: Record<string, string[]> = {};

  try {
    for (const target of workspace.compilation.targets) {
      const entryId = idByPath.get(target.rootInputPath);
      if (!entryId) continue;

      // Point every output into the temporary folder, remembering the real path.
      const realPaths: string[] = [];
      const copy: CompilationTarget = {
        ...target,
        runtimeContext: undefined,
        outputs: target.outputs.flatMap((output) => {
          const real = resolveOutputPath(target, output);
          if (!real) return [];
          realPaths.push(real);
          const rel = path.relative(workspace.projectRoot, real);
          const safe = rel.startsWith("..") ? `outside/${rel.replace(/[./\\]+/g, "_")}` : rel;
          return [{ ...output, destinationDir: undefined, destinationFile: path.join(tmp, safe) }];
        }),
      };
      if (copy.outputs.length === 0) continue;

      const compiler = new CompilationService({ rebuild: true, namespaceResolver: workspace.namespaceResolver });
      // Share one tokenizer: creating one per target is most of the build's time.
      encoder ??= get_encoding("o200k_base");
      const shared = encoder;
      // The compiler frees its tokenizer when it finishes, so it gets a wrapper whose free does nothing.
      (compiler as unknown as { encoder: unknown }).encoder = { encode: (t: string) => shared.encode(t), free: () => {} };
      const log: string[] = [];
      const ok = await quietly(
        () => compiler.compile({ ...workspace.compilation, targets: [copy] }, path.join(tmp, `.state-${entryId}.json`)),
        log
      );
      // eslint-disable-next-line no-control-regex
      const plain = log.join("\n").replace(/\u001b\[[0-9;]*m/g, "");
      const errorAt = plain.search(/Error:/);
      let error = errorAt >= 0 ? plain.slice(errorAt).split("\n").slice(0, 4).map((l) => l.trim()).filter(Boolean).join("\n") : undefined;
      if (error) {
        const inc = /Include (?:matched no files|not found): (@\S+)/.exec(error);
        const hash = /no built-in name "(#[\w-]+)"[\s\S]*?Available names: ([^\n]+)/.exec(error);
        if (inc) error = `The include ${inc[1]} ${hash ? `uses ${hash[1]}, which isn't a name sous knows in this project` : "points at nothing"}.\n${error.replace(/^Error:\s*/, "")}`;
        else error = error.replace(/^Error:\s*/, "");
      }

      const sources = [entryId];
      for (const file of compiler.includedFiles()) {
        const id = idByPath.get(file);
        if (id && !sources.includes(id)) sources.push(id);
      }

      copy.outputs.forEach((output, i) => {
        const real = realPaths[i];
        const rel = path.relative(workspace.projectRoot, real);
        const built = fs.existsSync(output.destinationFile!) ? fs.readFileSync(output.destinationFile!, "utf8") : null;
        const onDisk = fs.existsSync(real) ? fs.readFileSync(real, "utf8") : null;
        if (built !== null) contents.set(rel, built);
        // Agents read a skill's frontmatter name and description up front.
        let skillName: string | undefined;
        let description: string | undefined;
        const front = built?.match(/^---\n([\s\S]*?)\n---/)?.[1];
        if (front) {
          try {
            const meta = parseYaml(front) as Record<string, unknown>;
            if (typeof meta?.name === "string") skillName = meta.name;
            if (typeof meta?.description === "string") description = meta.description.replace(/\s+/g, " ").trim();
          } catch {
            // Frontmatter that isn't YAML has no description an agent can read.
          }
        }
        outputs.push({
          output: rel,
          entryId,
          sources,
          tokens: built ? countTokens(built) : 0,
          bytes: built ? Buffer.byteLength(built) : 0,
          status: !ok || built === null ? "failed" : onDisk === null ? "missing" : onDisk === built ? "up-to-date" : "stale",
          error: !ok || built === null ? (error ?? "The build failed.") : undefined,
          kind: kindOf(rel),
          skillName,
          description,
          descriptionTokens: description ? countTokens(`${skillName ?? ""}: ${description}`) : undefined,
        });
        for (const id of sources) (usedBy[id] ??= []).push(rel);
      });
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  last = {
    outputs,
    usedBy,
    ms: Math.round(performance.now() - started),
    builtAt: new Date().toISOString(),
  };
  return last;
}
