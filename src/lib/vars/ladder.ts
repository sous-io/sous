/**
 * The resolution ladder: how sous decides whether a variable already has an
 * answer, and which environment variable supplied it.
 *
 * Five rungs, most specific first:
 *
 *   1. mapping    a record binding an arbitrary name to this exact variable
 *   2. recipe     SOUS_VAR_<NAMESPACE>_<RECIPE>_<VARIABLE>
 *   3. namespace  SOUS_VAR_<NAMESPACE>_<VARIABLE>
 *   4. shared     SOUS_VAR_<VARIABLE>
 *   5. bare       the definition's own `env` name, or the shared form
 *
 * Within a rung the real shell environment wins, then `.sous/.env.local`, then
 * `.sous/.env`; the same order the env file loader uses, so what the ladder
 * reports is what a build actually sees.
 *
 * The three sources are read separately rather than off `process.env`, because
 * by the time a command runs the env files have already been injected into the
 * process environment and the distinction would be lost.
 */

import path from "node:path";
import { ENV_DEFAULTS_NAME, ENV_LOCAL_NAME } from "../config-discovery.js";
import { readEnvFileMap } from "../env-local.js";
import type { Settings } from "../settings.js";
import type { DefinedVariable } from "./definition-source.js";
import { mappedNamesFor } from "./mappings.js";
import {
  bareName,
  namespaceScopedName,
  recipeScopedName,
  sharedName,
} from "./names.js";

/** The rungs of the ladder, most specific first. */
export const LADDER_RUNGS = ["mapping", "recipe", "namespace", "shared", "bare"] as const;

/** One rung of the ladder. */
export type LadderRung = (typeof LADDER_RUNGS)[number];

/** Plain-language names for each rung, used in output. */
export const RUNG_LABELS: Record<LadderRung, string> = {
  mapping: "mapping record",
  recipe: "recipe scope",
  namespace: "namespace scope",
  shared: "shared scope",
  bare: "declared name",
};

/** Where a value was found: the real environment, or one of the two env files. */
export type EnvSourceFile = "shell" | typeof ENV_LOCAL_NAME | typeof ENV_DEFAULTS_NAME;

/** Plain-language names for each place a value can come from. */
export const SOURCE_LABELS: Record<string, string> = {
  shell: "the shell environment",
  [ENV_LOCAL_NAME]: `the ${ENV_LOCAL_NAME} file`,
  [ENV_DEFAULTS_NAME]: `the ${ENV_DEFAULTS_NAME} file`,
};

/** One environment variable name the ladder will look up, and why. */
export interface LadderCandidate {
  /** Which rung generated (or recorded) the name. */
  rung: LadderRung;
  /** The environment variable name. */
  envName: string;
}

/** Where a resolved value came from. */
export interface VariableSource extends LadderCandidate {
  /** Which of the three layers held the value. */
  file: EnvSourceFile;
}

/** A resolved answer: the value, and exactly where it came from. */
export interface ResolvedVariable {
  /** The value as stored, before validation or coercion. */
  value: string;
  /** Which name, on which rung, in which layer, supplied it. */
  source: VariableSource;
}

/**
 * The three separately parsed environment layers plus the mapping records, all
 * the ladder needs to answer a lookup.
 */
export interface LadderContext {
  /** The real shell environment, captured before the env files were injected. */
  shellEnv: Record<string, string>;
  /** The parsed `.sous/.env.local` file. */
  localEnv: Record<string, string>;
  /** The parsed `.sous/.env` file. */
  sharedEnv: Record<string, string>;
  /** The merged `varMappings` block: environment variable name to target. */
  mappings: Record<string, string>;
}

/** Drops undefined entries from a process environment, keeping the strings. */
function sanitizeEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

/** What `loadLadderContext` needs in order to read the layers. */
export interface LadderContextOptions {
  /** The project's `.sous/` directory, which holds both env files. */
  sousDir: string;
  /** The merged config, read for its `varMappings` block. */
  settings?: Settings;
  /**
   * The real shell environment. Commands pass the snapshot BaseCommand takes
   * before it injects the env files; without it the file-supplied values would
   * be reported as though the shell had set them.
   */
  shellEnv?: NodeJS.ProcessEnv;
}

/**
 * Reads the two env files and the mapping records into a ladder context.
 *
 * @param options - Where to read from; see LadderContextOptions.
 */
export function loadLadderContext(options: LadderContextOptions): LadderContext {
  const { sousDir, settings, shellEnv = process.env } = options;
  return {
    shellEnv: sanitizeEnv(shellEnv),
    localEnv: readEnvFileMap(path.join(sousDir, ENV_LOCAL_NAME)),
    sharedEnv: readEnvFileMap(path.join(sousDir, ENV_DEFAULTS_NAME)),
    mappings: settings?.varMappings ?? {},
  };
}

/**
 * Every environment variable name that could answer this variable, most
 * specific rung first. Duplicate names are dropped, keeping the most specific
 * occurrence, so a definition whose `env` field repeats a generated name is
 * reported once.
 *
 * @param defined - The definition and the recipe that published it.
 * @param context - The environment layers and mapping records.
 */
export function variableCandidates(
  defined: DefinedVariable,
  context: LadderContext
): LadderCandidate[] {
  const { namespace, name: recipe } = defined.recipe;
  const variable = defined.definition.name;

  const ordered: LadderCandidate[] = [
    ...mappedNamesFor(context.mappings, defined).map((envName) => ({
      rung: "mapping" as const,
      envName,
    })),
    { rung: "recipe", envName: recipeScopedName(namespace, recipe, variable) },
    { rung: "namespace", envName: namespaceScopedName(namespace, variable) },
    { rung: "shared", envName: sharedName(variable) },
    { rung: "bare", envName: bareName(defined.definition) },
  ];

  const seen = new Set<string>();
  return ordered.filter((candidate) => {
    if (seen.has(candidate.envName)) return false;
    seen.add(candidate.envName);
    return true;
  });
}

/**
 * Looks one environment variable name up across the three layers, in
 * precedence order.
 *
 * @param envName - The name to look up.
 * @param context - The environment layers.
 * @returns The value and the layer that held it, or undefined when nothing did.
 */
export function lookupEnvName(
  envName: string,
  context: LadderContext
): { value: string; file: EnvSourceFile } | undefined {
  const shell = context.shellEnv[envName];
  if (shell !== undefined) return { value: shell, file: "shell" };

  const local = context.localEnv[envName];
  if (local !== undefined) return { value: local, file: ENV_LOCAL_NAME };

  const shared = context.sharedEnv[envName];
  if (shared !== undefined) return { value: shared, file: ENV_DEFAULTS_NAME };

  return undefined;
}

/**
 * Walks the ladder for one variable and returns the first answer it finds.
 *
 * @param defined - The definition and the recipe that published it.
 * @param context - The environment layers and mapping records.
 * @returns The value and its source, or undefined when no rung answered.
 */
export function resolveVariable(
  defined: DefinedVariable,
  context: LadderContext
): ResolvedVariable | undefined {
  for (const candidate of variableCandidates(defined, context)) {
    const hit = lookupEnvName(candidate.envName, context);
    if (hit !== undefined) {
      return {
        value: hit.value,
        source: { rung: candidate.rung, envName: candidate.envName, file: hit.file },
      };
    }
  }
  return undefined;
}

/** A resolution plus the full candidate list, for diagnostics and `sous vars`. */
export interface VariableDiagnosis {
  /** The winning answer, when a rung produced one. */
  resolved?: ResolvedVariable;
  /** Every name the ladder tried, most specific first. */
  candidates: LadderCandidate[];
}

/**
 * Resolves a variable and reports every candidate name it considered, which is
 * what `sous vars <name>` prints and what a non-interactive failure message
 * lists.
 *
 * @param defined - The definition and the recipe that published it.
 * @param context - The environment layers and mapping records.
 */
export function diagnoseVariable(
  defined: DefinedVariable,
  context: LadderContext
): VariableDiagnosis {
  const candidates = variableCandidates(defined, context);
  for (const candidate of candidates) {
    const hit = lookupEnvName(candidate.envName, context);
    if (hit !== undefined) {
      return {
        resolved: {
          value: hit.value,
          source: { rung: candidate.rung, envName: candidate.envName, file: hit.file },
        },
        candidates,
      };
    }
  }
  return { candidates };
}

/**
 * Records a value in the context so later lookups in the same run see it, as
 * they would on the next run once the file is on disk.
 *
 * @param context - The context to update.
 * @param file - Which layer the value was written to.
 * @param envName - The environment variable name.
 * @param value - The value that was stored.
 */
export function recordAnswerInContext(
  context: LadderContext,
  file: EnvSourceFile,
  envName: string,
  value: string
): void {
  if (file === "shell") context.shellEnv[envName] = value;
  else if (file === ENV_LOCAL_NAME) context.localEnv[envName] = value;
  else context.sharedEnv[envName] = value;
}

/**
 * A one-line, plain-language description of where a value came from, such as
 * "the shared scope name SOUS_VAR_API_URL, from the .env file".
 *
 * @param source - The resolved source.
 */
export function describeSource(source: VariableSource): string {
  const where = SOURCE_LABELS[source.file] ?? source.file;
  return `the ${RUNG_LABELS[source.rung]} name ${source.envName}, from ${where}`;
}
