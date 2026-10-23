/**
 * PROOF OF CONCEPT for `sous serve`. The same facts `sous vars list` prints, as
 * data: every variable the project's recipes define, who asks for it, its
 * value, and which environment variable and file answered it. Plus, for every
 * variable name, the source files that use it.
 */
import fs from "node:fs";
import { loadProjectDefinitions } from "../vars/definition-source.js";
import { diagnoseVariable, loadLadderContext } from "../vars/ladder.js";
import { definingRecipeKey } from "../vars/definition-source.js";
import type { ConfigContext, Settings } from "../settings.js";
import type { Workspace } from "./workspace.js";

export type VarFact = {
  name: string;
  /** The recipe that asks for it (namespace/recipe@version). */
  recipe?: string;
  description?: string;
  type?: string;
  secret: boolean;
  /** The value sous uses ("••••••" for a secret). */
  value: string | null;
  /** How it was answered, in sous's own words, e.g. "shared scope, the .env file". */
  answeredBy?: string;
  envName?: string;
  /** Ids of source files that use this variable. */
  usedIn: string[];
};

export async function variableReport(
  workspace: Workspace,
  settings: Settings,
  configContext: ConfigContext,
  shellEnv: NodeJS.ProcessEnv
): Promise<VarFact[]> {
  const facts = new Map<string, VarFact>();

  try {
    const defined = await loadProjectDefinitions(settings, configContext.sousDir).load();
    const context = loadLadderContext({ sousDir: configContext.sousDir, settings, shellEnv });
    for (const entry of defined) {
      const def = entry.definition as Record<string, unknown> & { name: string; secret?: boolean };
      const { resolved } = diagnoseVariable(entry, context);
      facts.set(def.name, {
        name: def.name,
        recipe: `${definingRecipeKey(entry.recipe)}`,
        description: (def.description ?? def.question ?? def.prompt) as string | undefined,
        type: def.type as string | undefined,
        secret: Boolean(def.secret),
        value: resolved ? (def.secret ? "••••••" : String(resolved.value)) : null,
        answeredBy: resolved
          ? `${resolved.source.file === "shell" ? "your shell" : resolved.source.file} (${resolved.source.envName})`
          : undefined,
        envName: resolved?.source.envName,
        usedIn: [],
      });
    }
  } catch {
    // Definitions are optional; the scope below still lists every variable.
  }

  // Every variable in a template's scope, including those set in config.
  const sample = workspace.files.find((f) => f.origin.kind === "project") ?? workspace.files[0];
  const secret = new Set(workspace.secretNames);
  for (const [name, value] of Object.entries(sample?.vars ?? {})) {
    if (facts.has(name)) continue;
    facts.set(name, {
      name,
      secret: secret.has(name),
      value: secret.has(name) ? "••••••" : value,
      answeredBy: name.startsWith("sous") || name === "projectRoot" ? "built in to sous" : "sous.config.js (_vars)",
      usedIn: [],
    });
  }

  // Where each variable is used.
  const names = [...facts.keys()];
  const pattern = new RegExp(`\\b(${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`, "g");
  for (const file of workspace.files) {
    if (!file.isTpl) continue;
    let text: string;
    try {
      text = file.virtualContent ?? fs.readFileSync(file.path, "utf8");
    } catch {
      continue;
    }
    const seen = new Set<string>();
    for (const block of text.matchAll(/\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}|\$\{[^}]+\}/g)) {
      for (const m of block[0].matchAll(pattern)) seen.add(m[1]);
    }
    for (const name of seen) facts.get(name)?.usedIn.push(file.id);
  }

  return [...facts.values()].sort((a, b) => b.usedIn.length - a.usedIn.length || a.name.localeCompare(b.name));
}
