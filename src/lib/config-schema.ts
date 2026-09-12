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
import { repoUrlSchema, semverRangeSchema } from "./repos/formats/common.js";
import { REF_KEY_PATTERN, REPO_NAME_PATTERN } from "./repos/formats/patterns.js";
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

// --- Repositories -------------------------------------------------------------------------------

/**
 * One trusted repository, keyed by the short name refs use in the `repo:`
 * qualifier. Adding a repo IS trusting it: `sous repo add` writes the entry
 * into the machine-written `conf.d/500-repos.jsonc` layer, and removing the
 * entry withdraws the trust. A user may also hand-write `repos:` in the primary
 * config; the two layers merge like anything else.
 */
const repoEntrySchema = z
  .object({
    /**
     * Where the repository lives. A hosted repository is named by its URL; a
     * repository on this machine, which the `local` provider reads, is named by
     * an absolute path or the same path in `file:///...` form.
     */
    url: repoUrlSchema,
    /**
     * Whether the repository takes part in anything at all. Defaults to true.
     * Setting it to false is how a project opts out of a repository sous
     * provides itself (the official `sous-recipes`), without having to delete an
     * entry it never wrote.
     */
    enabled: z.boolean().optional(),
    /**
     * Which provider handles it. Inferred from the URL when omitted; set it
     * explicitly for a self-hosted instance the URL does not give away.
     * `local` is a repository on this machine, for local development and tests;
     * its trust semantics are identical to a hosted one.
     */
    provider: z.enum(["github", "gitlab", "local"]).optional(),
    /**
     * When true, sous installs a newer in-range version whenever one exists
     * rather than holding the locked one. The flag never widens the range a
     * subscription or a dependency declared.
     */
    alwaysPull: z.boolean().optional(),
    /** When the repo was added, for provenance. */
    addedAt: z.string().optional(),
    /**
     * Who required the repo: the literal "user" for a deliberate add, or the ref
     * of the recipe whose dependency pulled it in. Removal hygiene reads this.
     */
    addedBy: z.string().optional(),
  })
  .strict();

/**
 * One subscription, keyed by a ref key: a bare namespace (every recipe in it,
 * including ones published later) or `namespace/recipe`. Written by
 * `sous subscribe` into the machine-written `conf.d/510-subscriptions.jsonc`
 * layer, and hand-writable in the primary config.
 */
const subscriptionEntrySchema = z
  .object({
    /**
     * Whether the subscription takes part in anything at all. Defaults to true.
     * Setting it to false is how a project opts out of the `core` namespace sous
     * subscribes every project to.
     */
    enabled: z.boolean().optional(),
    /** The semantic version range to resolve within. Defaults to "*". */
    range: semverRangeSchema.optional(),
    /** When true, prerelease versions take part in range matching. */
    prerelease: z.boolean().optional(),
    /** Per-subscription form of the repo-level always-pull flag. */
    alwaysPull: z.boolean().optional(),
    /** When the subscription was added, for provenance. */
    addedAt: z.string().optional(),
    /** Who required it: "user", or the ref of the recipe that co-subscribed it. */
    addedBy: z.string().optional(),
  })
  .strict();

/**
 * Knobs for the machine-wide recipe store under the user-level sous directory.
 * Every value here is a number the user can change; the numbers sous ships are
 * defaults, not assumptions. Phase 2 applies them, so all three are optional
 * here and the defaults live with the store itself: one gigabyte for maxBytes,
 * 300 seconds for freshnessSeconds, and 300 seconds for watchPollSeconds.
 */
const storeSchema = z
  .object({
    /** Size cap for the store, past which least-recently-used entries are collected. */
    maxBytes: z.number().int().positive().optional(),
    /**
     * How long a fetched index stays fresh. A non-watch build checks upstream
     * only once this window has lapsed, and a failed check never breaks a
     * build; the last good answer stands.
     */
    freshnessSeconds: z.number().int().nonnegative().optional(),
    /** How often watch mode polls upstream for a newer in-range version. */
    watchPollSeconds: z.number().int().nonnegative().optional(),
  })
  .strict();

/**
 * Where the files a subscribed recipe contributes are written, one list of
 * destination directories per content kind. Each destination is `${var}`
 * substituted like any other config path, and a kind may name several so the
 * same recipe feeds more than one agent directory (`.claude/skills` and
 * `.codex/skills`, say).
 *
 * Only `skills` has a default: `<project root>/.claude/skills`, the project root
 * being the parent of the discovered `.sous/` directory. A kind with no
 * destination is skipped, with one warning naming this key, because sous cannot
 * guess where a project wants its memories or its prompts. A recipe's `config`
 * contents are not listed here; they are loaded as config layers rather than
 * written anywhere.
 */
const recipeOutputsSchema = z
  .object({
    /** Where recipe skill bundles are written. */
    skills: z.array(z.string()).optional(),
    /** Where recipe memory files are written. */
    memories: z.array(z.string()).optional(),
    /** Where recipe prompt files are written. */
    prompts: z.array(z.string()).optional(),
  })
  .strict();

// --- Variable mappings --------------------------------------------------------------------------

/**
 * A mapping record's target: one variable, named in full, as
 * `namespace/recipe/variableName` with an optional `repo:` qualifier. Mapping
 * records are the top rung of the answer resolution ladder and the universal
 * resolver when two recipes want the same environment variable name.
 */
const mappingTargetSchema = z
  .string()
  .regex(
    /^([a-z][a-z0-9-]*:)?[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*\/[a-z][a-zA-Z0-9]*$/,
    "a variable mapping target must be written as 'namespace/recipe/variableName', " +
      "optionally qualified with a repository as 'repo:namespace/recipe/variableName'"
  );

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
    /** Trusted repositories, keyed by the short name refs use. */
    repos: z
      .record(
        z
          .string()
          .regex(
            REPO_NAME_PATTERN,
            "a repo name must be lowercase kebab-case: a letter, then letters, " +
              "digits or hyphens"
          ),
        repoEntrySchema
      )
      .optional(),
    /** Subscriptions, keyed by ref key (`namespace` or `namespace/recipe`). */
    subscriptions: z
      .record(
        z
          .string()
          .regex(
            REF_KEY_PATTERN,
            "a subscription key must be a namespace such as 'workflow', or a " +
              "namespace and recipe such as 'workflow/task-files', with no repo " +
              "qualifier and no version range"
          ),
        subscriptionEntrySchema
      )
      .optional(),
    /** Knobs for the machine-wide recipe store. */
    store: storeSchema.optional(),
    /** Where the files subscribed recipes contribute are written, per content kind. */
    recipeOutputs: recipeOutputsSchema.optional(),
    /**
     * Variable mapping records, keyed by environment variable name. Each entry
     * binds that name to one recipe variable, which is how an answer is stored
     * under a name of your choosing when the generated names are taken. Written
     * by `sous vars ask` into `conf.d/520-var-mappings.jsonc`, and hand-writable
     * in the primary config.
     */
    varMappings: z
      .record(
        z
          .string()
          .regex(
            /^[A-Z][A-Z0-9_]*$/,
            "an environment variable name must be upper snake case: a capital " +
              "letter, then capitals, digits or underscores"
          ),
        mappingTargetSchema
      )
      .optional(),
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
    } else if (issue.code === "invalid_key") {
      // zod reports a bad record KEY as a bare "Invalid key in record" and hides
      // the reason in a nested issue list. Surface the reason, since that is the
      // part telling the user how to fix the key.
      const reasons = issue.issues.map((inner) => inner.message).join("; ");
      lines.push(`  - ${where}: invalid key; ${reasons}`);
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
