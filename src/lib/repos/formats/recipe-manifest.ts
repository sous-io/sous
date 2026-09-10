/**
 * The recipe manifest: `sous.recipe.yaml` (or `.yml`, or `.json`) in each
 * recipe folder. It is HAND-WRITTEN and is the complete, executable-free
 * description of one publishable unit: what it is called, what version it is,
 * what it depends on, what files it contributes, and what variables it needs
 * answered.
 *
 * Two dependency lists exist, and they mean different things:
 *
 * - `depends` is a build dependency. The target is fetched, pinned and trust
 *   gated, and is addressable from this recipe's own files, but its files do
 *   NOT enter the subscribing project's output.
 * - `subscribes` is a co-subscription. Subscribing to this recipe subscribes
 *   the project to the target too, with full semantics: its questions run and
 *   its files DO enter the output. A curated bundle is simply a recipe made
 *   mostly of `subscribes` entries.
 */

import { z } from "zod";
import {
  envVarNameSchema,
  extensibleObject,
  formatVersionSchema,
  namespaceNameSchema,
  parseFormat,
  recipeNameSchema,
  relativePathSchema,
  semverVersionSchema,
  variableNameSchema,
} from "./common.js";
import { parseRef } from "../ref.js";

// --- Dependency refs ----------------------------------------------------------------------------

/**
 * A ref string in `depends` or `subscribes`. Parsed with the real ref parser so
 * a manifest and the command line never disagree about what a ref means; the
 * parser's message is carried through as the zod issue message.
 */
const dependencyRefSchema = z.string().superRefine((value, ctx) => {
  try {
    parseRef(value);
  } catch (error) {
    ctx.addIssue({ code: "custom", message: (error as Error).message });
  }
});

/** Builds a list-of-refs schema that also rejects the same target listed twice. */
function refListSchema(label: string) {
  return z.array(dependencyRefSchema).superRefine((refs, ctx) => {
    const seen = new Set<string>();
    refs.forEach((entry, index) => {
      const trimmed = entry.trim();
      if (seen.has(trimmed)) {
        ctx.addIssue({
          code: "custom",
          path: [index],
          message: `'${trimmed}' is listed more than once in ${label}`,
        });
      }
      seen.add(trimmed);
    });
  });
}

// --- Contents -----------------------------------------------------------------------------------

/**
 * What a content entry contributes. `skills`, `memories` and `prompts` are
 * compiled or copied into the subscribing project's agent directories; `config`
 * entries name config layer files that are merged into the subscriber's config.
 */
export const CONTENT_KINDS = ["skills", "memories", "prompts", "config"] as const;

/** One group of files this recipe contributes, all of the same kind. */
export const recipeContentSchema = extensibleObject({
  /** What the files are, which decides where they land in a subscribing project. */
  kind: z.enum(CONTENT_KINDS),
  /** Glob patterns, relative to the recipe folder, naming the files to contribute. */
  include: z
    .array(relativePathSchema("an include pattern", true))
    .min(1, "must list at least one include pattern"),
  /** Glob patterns, relative to the recipe folder, removed from the include set. */
  exclude: z.array(relativePathSchema("an exclude pattern", true)).optional(),
});

// --- Variable definitions -----------------------------------------------------------------------

/** The value types a recipe may declare for a variable. */
export const VARIABLE_TYPES = [
  "string",
  "number",
  "boolean",
  "enum",
  "path",
  "url",
] as const;

/** Which env file an answer is written to. */
export const VARIABLE_SCOPES = ["shared", "local"] as const;

/** Constraints checked against an answer before it is accepted or stored. */
export const variableValidationSchema = extensibleObject({
  /** A regular expression the answer must match, as a string. */
  pattern: z
    .string()
    .refine(
      (value) => {
        try {
          new RegExp(value);
          return true;
        } catch {
          return false;
        }
      },
      { message: "must be a valid regular expression" }
    )
    .optional(),
  /** Minimum length of a string answer. */
  minLength: z.number().int().min(0).optional(),
  /** Maximum length of a string answer. */
  maxLength: z.number().int().min(0).optional(),
  /** Minimum value of a numeric answer. */
  min: z.number().optional(),
  /** Maximum value of a numeric answer. */
  max: z.number().optional(),
  /** The allowed answers. Required when the variable's type is 'enum'. */
  enum: z.array(z.string()).min(1, "must list at least one option").optional(),
});

/**
 * A published variable definition: a specification, not a value. Definitions
 * are inert; a question is asked only when a subscribed recipe needs the
 * variable and no valid answer is already in scope.
 */
export const variableDefinitionSchema = extensibleObject({
  /** The variable's camelCase name, as templates refer to it. */
  name: variableNameSchema,
  /**
   * The environment variable an answer binds to. Authors may name an existing
   * variable such as GITHUB_TOKEN to reuse a value already in the environment.
   * When omitted, `sous repo release` derives an upper snake case default from
   * the name; the runtime never derives one.
   */
  env: envVarNameSchema.optional(),
  /** The answer's type, which decides how it is validated and prompted for. */
  type: z.enum(VARIABLE_TYPES),
  /** The question text shown when the variable is asked. */
  prompt: z.string().min(1, "must not be empty"),
  /** Longer explanation, shown alongside the question and by `sous vars`. */
  description: z.string().optional(),
  /** The value offered when the question is asked with nothing else in scope. */
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  /** Whether an answer is needed for a build to run. Defaults to true. */
  required: z.boolean().default(true),
  /**
   * Whether the answer is a secret. A secret is always written to the
   * gitignored `.sous/.env.local`, never to the committed `.sous/.env`.
   */
  secret: z.boolean().default(false),
  /**
   * Which env file the answer is written to: 'shared' is `.sous/.env`, which is
   * committed and shared with the team; 'local' is `.sous/.env.local`, which is
   * gitignored and machine-specific. Defaults to 'shared'.
   */
  scope: z.enum(VARIABLE_SCOPES).default("shared"),
  /** Constraints checked against an answer. */
  validate: variableValidationSchema.optional(),
})
  .superRefine((definition, ctx) => {
    const { type, validate } = definition;

    if (type === "enum" && (validate?.enum === undefined || validate.enum.length === 0)) {
      ctx.addIssue({
        code: "custom",
        path: ["validate", "enum"],
        message:
          "a variable of type 'enum' must list its options under 'validate.enum'",
      });
    }

    if (validate !== undefined) {
      const { minLength, maxLength, min, max } = validate;
      if (minLength !== undefined && maxLength !== undefined && minLength > maxLength) {
        ctx.addIssue({
          code: "custom",
          path: ["validate", "maxLength"],
          message: "must not be smaller than 'validate.minLength'",
        });
      }
      if (min !== undefined && max !== undefined && min > max) {
        ctx.addIssue({
          code: "custom",
          path: ["validate", "max"],
          message: "must not be smaller than 'validate.min'",
        });
      }
    }

    // A secret written to the committed env file would leak, so the two fields
    // are not allowed to contradict each other.
    if (definition.secret && definition.scope === "shared") {
      ctx.addIssue({
        code: "custom",
        path: ["scope"],
        message:
          "a secret variable is stored in the gitignored '.sous/.env.local', so its " +
          "scope must be 'local' (or left unset)",
      });
    }

    if (definition.default !== undefined) {
      const value = definition.default;
      const expected =
        type === "boolean" ? "boolean" : type === "number" ? "number" : "string";
      if (typeof value !== expected) {
        ctx.addIssue({
          code: "custom",
          path: ["default"],
          message: `must be a ${expected}, to match the declared type '${type}'`,
        });
      } else if (
        type === "enum" &&
        validate?.enum !== undefined &&
        !validate.enum.includes(String(value))
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["default"],
          message: "must be one of the options listed under 'validate.enum'",
        });
      }
    }
  });

// --- The manifest -------------------------------------------------------------------------------

/** The recipe manifest schema. */
export const recipeManifestSchema = extensibleObject({
  formatVersion: formatVersionSchema,
  /** The namespace this recipe belongs to. Must be declared by the repo manifest. */
  namespace: namespaceNameSchema,
  /** The recipe's name, unique within its namespace. */
  name: recipeNameSchema,
  /**
   * The published version. Recipe metadata is the source of truth for versions;
   * a git tag of the shape `namespace/recipe@1.2.3` is a convenience ref that
   * `sous repo release` keeps consistent with this field.
   */
  version: semverVersionSchema,
  /** One-paragraph summary, shown by `sous repo search` and `sous repo list`. */
  description: z.string().optional(),
  /** Build dependencies: fetched and addressable here, but not added to the project. */
  depends: refListSchema("'depends'").optional(),
  /** Co-subscriptions: subscribing here subscribes the project to these too. */
  subscribes: refListSchema("'subscribes'").optional(),
  /**
   * The files this recipe contributes. A curated bundle contributes no files of
   * its own, so this may be omitted; it then defaults to an empty list.
   */
  contents: z.array(recipeContentSchema).default([]),
  /** Variable definitions this recipe publishes. */
  variables: z
    .array(variableDefinitionSchema)
    .superRefine((definitions, ctx) => {
      const seenNames = new Set<string>();
      const seenEnv = new Map<string, number>();
      definitions.forEach((definition, index) => {
        if (seenNames.has(definition.name)) {
          ctx.addIssue({
            code: "custom",
            path: [index, "name"],
            message: `the variable '${definition.name}' is defined more than once`,
          });
        }
        seenNames.add(definition.name);

        if (definition.env !== undefined) {
          const first = seenEnv.get(definition.env);
          if (first !== undefined) {
            ctx.addIssue({
              code: "custom",
              path: [index, "env"],
              message:
                `the environment variable '${definition.env}' is already claimed by ` +
                `variables[${first}]; two definitions cannot share one environment variable`,
            });
          } else {
            seenEnv.set(definition.env, index);
          }
        }
      });
    })
    .optional(),
});

/** A validated recipe manifest. */
export type RecipeManifest = z.infer<typeof recipeManifestSchema>;

/** One validated content group from a recipe manifest. */
export type RecipeContent = z.infer<typeof recipeContentSchema>;

/** One validated variable definition from a recipe manifest. */
export type VariableDefinition = z.infer<typeof variableDefinitionSchema>;

/** The constraints attached to a variable definition. */
export type VariableValidation = z.infer<typeof variableValidationSchema>;

/** What a content group contributes. */
export type ContentKind = (typeof CONTENT_KINDS)[number];

/** The value type a variable definition declares. */
export type VariableType = (typeof VARIABLE_TYPES)[number];

/** Which env file an answer is written to. */
export type VariableScope = (typeof VARIABLE_SCOPES)[number];

/**
 * Validates a parsed recipe manifest, throwing a ConfigError that names the
 * file and the path of every bad field.
 *
 * @param value - The parsed contents of the manifest file.
 * @param sourceLabel - The manifest's file path, named in error messages.
 */
export function parseRecipeManifest(
  value: unknown,
  sourceLabel: string
): RecipeManifest {
  return parseFormat(recipeManifestSchema, value, sourceLabel, "recipe manifest");
}

/**
 * The recipe's key (`namespace/name`), which is how it is stored in an index,
 * a lockfile and a project's subscriptions.
 *
 * @param manifest - A validated recipe manifest.
 */
export function recipeManifestKey(manifest: RecipeManifest): string {
  return `${manifest.namespace}/${manifest.name}`;
}
