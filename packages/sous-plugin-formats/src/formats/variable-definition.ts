/**
 * A recipe's variable definitions: what each variable is called, what shape an
 * answer takes, and what question to ask. A recipe manifest declares them
 * (`recipe-manifest.ts` re-exports everything here), and `sous repo release`
 * copies each version's definitions into the index, so the same fields and the
 * same rules read both copies.
 *
 * This module imports nothing but the shared primitives, because the index
 * reads it, and the index sits below the ref parser the manifest needs.
 */

import { z } from "zod";
import {
  envVarNameSchema,
  extensibleObject,
  forwardCompatibleObject,
  variableNameSchema,
} from "./common.js";

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
const variableValidationShape = {
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
};

/** Constraints checked against an answer before it is accepted or stored. */
export const variableValidationSchema = extensibleObject(variableValidationShape);

/**
 * The fields of a variable definition, shared by the two schemas that read
 * one: the hand-written manifest, and the copy a release records in the index.
 *
 * @param validate - The schema for the `validate` block, strict or forward compatible.
 */
function variableDefinitionShape<Validate extends z.ZodType>(validate: Validate) {
  return {
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
    /** The one-line question shown when the variable is asked. */
    prompt: z.string().min(1, "must not be empty"),
    /**
     * The paragraph that explains the variable: what it is for, what a good
     * answer looks like, and what changes when it is set. Shown above the
     * question when sous asks, and by `sous vars <name>`. Required, because a
     * consumer reading the question has no other way to learn what a publisher
     * meant by it.
     */
    description: z
      .string({
        error:
          "is required: every published variable must explain itself in a sentence or " +
          "two. The description is shown above the question when sous asks, and by " +
          "'sous vars <name>'",
      })
      .min(1, "must not be empty"),
    /**
     * A realistic sample answer. It is documentation and prompt copy only; sous
     * never stores it, never offers it as the answer, and never falls back to it.
     * Use `default` for a value a project should actually start with.
     */
    example: z.union([z.string(), z.number(), z.boolean()], {
      error:
        "is required: every published variable must show what a real answer looks like. " +
        "The example is shown with the question and by 'sous vars <name>'; it is " +
        "documentation only and is never stored as the answer (use 'default' for that)",
    }),
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
    validate: validate.optional(),
  };
}

/** What `checkVariableDefinition` reads from a definition. */
type CheckedDefinition = {
  type: VariableType;
  secret: boolean;
  scope: VariableScope;
  default?: string | number | boolean | undefined;
  example: string | number | boolean;
  validate?:
    | { minLength?: number; maxLength?: number; min?: number; max?: number; enum?: string[] }
    | undefined;
};

/**
 * The rules a variable definition obeys beyond the shape of each field, shared
 * by both schemas so a definition the index records is held to exactly the rules
 * its manifest was.
 *
 * @param definition - The definition, already parsed field by field.
 * @param ctx - The refinement context issues are added to.
 */
function checkVariableDefinition(definition: CheckedDefinition, ctx: z.RefinementCtx): void {
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

  // `default` and `example` are both literal values written by the publisher,
  // so both have to fit the variable they describe; an example that could
  // never be a valid answer is worse than no example at all.
  checkDeclaredValue(definition.default, "default");
  checkDeclaredValue(definition.example, "example");

  /**
   * Checks one publisher-written literal against the declared type and the
   * 'validate.enum' options.
   *
   * @param value - The literal to check, or undefined when it was omitted.
   * @param field - The field name, used as the issue path.
   */
  function checkDeclaredValue(
    value: string | number | boolean | undefined,
    field: "default" | "example"
  ): void {
    if (value === undefined) return;

    const expected =
      type === "boolean" ? "boolean" : type === "number" ? "number" : "string";
    if (typeof value !== expected) {
      ctx.addIssue({
        code: "custom",
        path: [field],
        message: `must be a ${expected}, to match the declared type '${type}'`,
      });
    } else if (
      type === "enum" &&
      validate?.enum !== undefined &&
      !validate.enum.includes(String(value))
    ) {
      ctx.addIssue({
        code: "custom",
        path: [field],
        message: "must be one of the options listed under 'validate.enum'",
      });
    }
  }
}

/**
 * A published variable definition: a specification, not a value. Definitions
 * are inert; a question is asked only when a subscribed recipe needs the
 * variable and no valid answer is already in scope.
 */
export const variableDefinitionSchema = extensibleObject(
  variableDefinitionShape(variableValidationSchema)
).superRefine(checkVariableDefinition);

/**
 * A variable definition as a release records it in the index, so a consumer
 * can list a recipe's questions before its files are fetched. It is the
 * manifest's definition, field for field and rule for rule; the one difference
 * is that a field this sous does not define is kept rather than refused,
 * because the index is read by every sous a project happens to pin, and a
 * later one may add a field.
 */
export const publishedVariableDefinitionSchema = forwardCompatibleObject(
  variableDefinitionShape(forwardCompatibleObject(variableValidationShape))
).superRefine(checkVariableDefinition);

/** One validated variable definition from a recipe manifest. */
export type VariableDefinition = z.infer<typeof variableDefinitionSchema>;

/** The constraints attached to a variable definition. */
export type VariableValidation = z.infer<typeof variableValidationSchema>;

/** The value type a variable definition declares. */
export type VariableType = (typeof VARIABLE_TYPES)[number];

/** Which env file an answer is written to. */
export type VariableScope = (typeof VARIABLE_SCOPES)[number];
