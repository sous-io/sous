/**
 * Zod schema for a merged sous config.
 *
 * This mirrors the hand-written `Settings` / `RawProjectCompilation` /
 * `RawTarget` / `RawOutput` / `RawRuntimeContext` / `ToolConfig` types in
 * settings.ts — those remain the exported TypeScript types; this schema is the
 * RUNTIME validator. Keep the two in sync: when a config field changes in
 * settings.ts, change it here too.
 *
 * Every object level is STRICT (unknown keys are rejected), so a typo like
 * `compilaton` is caught the moment the merged config is loaded rather than
 * silently ignored. Validation runs on the MERGED config only (in
 * loadSettingsWithLayers, after the kernel merges every conf.d layer and after
 * assertFlatConfig); a single conf.d fragment need not be a complete config.
 *
 * The schema also drives `npm run schema:build`, which emits the committed
 * `sous.config.schema.json` artifact via `z.toJSONSchema`.
 */

import { z } from "zod";
import { ConfigError } from "./errors.js";
import type { Settings } from "./settings.js";

/** The only config version this sous understands. */
export const SUPPORTED_CONFIG_VERSION = 1;

/** A record of string → string (used for _env and every _vars block). */
const stringRecord = z.record(z.string(), z.string());

const outputSchema = z
  .object({
    _if: z.record(z.string(), z.object({ eq: z.string() }).strict()).optional(),
    _vars: stringRecord.optional(),
    destinationFile: z.string().optional(),
    destinationDir: z.string().optional(),
  })
  .strict();

const runtimeContextSchema = z
  .object({
    gitRoot: z.string(),
    outputPath: z.string(),
    taskFileRoot: z.string(),
    branchPattern: z.string().optional(),
  })
  .strict();

const targetSchema = z
  .object({
    _vars: stringRecord.optional(),
    entryPoint: z.string().optional(),
    entryGlob: z.string().optional(),
    globBase: z.string().optional(),
    generateRuntimeContext: z.boolean().optional(),
    outputs: z.array(outputSchema),
  })
  .strict()
  .refine((t) => (t.entryPoint !== undefined) !== (t.entryGlob !== undefined), {
    message: "a target must have exactly one of 'entryPoint' or 'entryGlob'",
  });

const compilationSchema = z
  .object({
    _vars: stringRecord.optional(),
    includeSourceComments: z.boolean().optional(),
    targets: z.array(targetSchema),
  })
  .strict();

const toolSchema = z
  .object({
    command: z.string(),
    args: z.array(z.string()).optional(),
    promptFile: z.string().optional(),
  })
  .strict();

/**
 * The full merged-config schema. `version`, when present, must be exactly
 * `SUPPORTED_CONFIG_VERSION` — but validateSettings pre-checks it with a clearer
 * message before this schema runs, so a bad version never reaches the generic
 * literal error here.
 */
export const settingsSchema = z
  .object({
    // Allowed so a JSON config can bind itself to the shipped
    // `sous.config.schema.json` via the standard `"$schema": "..."` property
    // for editor autocompletion / external validation. Editors treat `$schema`
    // as reserved and never flag it, so rejecting it here would break the
    // documented workflow. sous itself ignores the value.
    $schema: z.string().optional(),
    version: z.literal(SUPPORTED_CONFIG_VERSION).optional(),
    _env: stringRecord.optional(),
    _vars: stringRecord.optional(),
    _aliases: z
      .record(z.string(), z.union([z.string(), z.array(z.string())]))
      .optional(),
    name: z.string().optional(),
    compilation: compilationSchema.optional(),
    runtimeContext: runtimeContextSchema.optional(),
    tools: z.record(z.string(), toolSchema).optional(),
  })
  .strict();

/** Renders a zod issue path (e.g. `["compilation","targets",0,"entryPoint"]`) as `compilation.targets[0].entryPoint`. */
function formatIssuePath(parts: ReadonlyArray<PropertyKey>): string {
  let out = "";
  for (const part of parts) {
    if (typeof part === "number") out += `[${part}]`;
    else out += out.length > 0 ? `.${String(part)}` : String(part);
  }
  return out;
}

/**
 * Turns a ZodError into a readable, per-issue ConfigError message. Never leaks
 * the raw zod JSON dump. Unknown-key issues are surfaced as likely typos and
 * name the config file.
 */
function formatZodError(error: z.ZodError, configPath: string): ConfigError {
  const lines: string[] = [`Invalid sous config at ${configPath}:`];

  for (const issue of error.issues) {
    const where = formatIssuePath(issue.path);
    if (issue.code === "unrecognized_keys") {
      const keys = issue.keys.map((k) => `'${k}'`).join(", ");
      const loc = where.length > 0 ? `under '${where}'` : "at the top level";
      lines.push(
        `  - unknown key(s) ${keys} ${loc} — likely a typo. Check ${configPath}.`
      );
    } else {
      lines.push(`  - ${where.length > 0 ? where : "(root)"}: ${issue.message}`);
    }
  }

  return new ConfigError(lines.join("\n"));
}

/**
 * Validates a merged config object against the schema, returning it typed as
 * `Settings`. Throws a ConfigError (never a raw ZodError) on any problem.
 *
 * @param raw - The merged config produced by the kernel (post assertFlatConfig).
 * @param configPath - The primary config file path, named in error messages.
 */
export function validateSettings(raw: unknown, configPath: string): Settings {
  // Version gets a dedicated, friendlier message than the generic literal error.
  if (raw !== null && typeof raw === "object" && "version" in raw) {
    const version = (raw as { version: unknown }).version;
    if (version !== SUPPORTED_CONFIG_VERSION) {
      throw new ConfigError(
        `Config at ${configPath} declares version ${JSON.stringify(version)}, which is not ` +
          `supported by this version of sous.\n` +
          `  This sous understands config version ${SUPPORTED_CONFIG_VERSION}. Omit the ` +
          `'version' field or set it to ${SUPPORTED_CONFIG_VERSION}.`
      );
    }
  }

  const result = settingsSchema.safeParse(raw);
  if (!result.success) {
    throw formatZodError(result.error, configPath);
  }

  return result.data as Settings;
}
