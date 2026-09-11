/**
 * Validating an answer against the definition that asked for it.
 *
 * A recipe declares a small, deliberately boring constraint vocabulary (a type,
 * plus `pattern`, `minLength`, `maxLength`, `min`, `max` and `enum`), all of it
 * expressible in plain JSON so a manifest never has to carry code. This module
 * turns that vocabulary into a zod schema and reports a failure in the same
 * plain language the question was asked in, naming the constraint that was
 * violated rather than dumping a schema error.
 *
 * Answers are stored as text in env files, so validation always starts from a
 * string and hands back the coerced value.
 */

import { z } from "zod";
import type { VariableDefinition } from "../repos/formats/recipe-manifest.js";

/** The value an answer coerces to, once it has been validated. */
export type AnswerValue = string | number | boolean;

/** A validated answer, or the reason it was refused. */
export type AnswerValidation =
  | { ok: true; value: AnswerValue }
  | { ok: false; message: string };

/** The strings accepted as a true answer for a boolean variable. */
const TRUE_WORDS = new Set(["true", "yes", "y", "on", "1"]);

/** The strings accepted as a false answer for a boolean variable. */
const FALSE_WORDS = new Set(["false", "no", "n", "off", "0"]);

/**
 * Builds the zod schema for one definition. The schema's input is the trimmed
 * answer text and its output is the coerced value, so callers get the number or
 * boolean a `number` or `boolean` variable promised.
 *
 * @param definition - The variable definition to build a schema for.
 */
export function validationSchemaFor(definition: VariableDefinition): z.ZodType<AnswerValue> {
  const rules = definition.validate;

  switch (definition.type) {
    case "number": {
      const schema = z
        .string()
        .refine((value) => value.length > 0 && Number.isFinite(Number(value)), {
          message: "must be a number",
        })
        .transform((value) => Number(value))
        .pipe(numberRules());
      return schema as unknown as z.ZodType<AnswerValue>;
    }

    case "boolean": {
      const schema = z
        .string()
        .refine((value) => TRUE_WORDS.has(value.toLowerCase()) || FALSE_WORDS.has(value.toLowerCase()), {
          message: "must be 'true' or 'false'",
        })
        .transform((value) => TRUE_WORDS.has(value.toLowerCase()));
      return schema as unknown as z.ZodType<AnswerValue>;
    }

    case "enum": {
      const options = rules?.enum ?? [];
      const schema = z.string().refine((value) => options.includes(value), {
        message: `must be one of: ${options.join(", ")}`,
      });
      return stringRules(schema) as unknown as z.ZodType<AnswerValue>;
    }

    case "url": {
      const schema = z.string().refine(
        (value) => {
          try {
            const parsed = new URL(value);
            return parsed.protocol.length > 1;
          } catch {
            return false;
          }
        },
        { message: "must be a URL, including its scheme (for example 'https://example.com')" }
      );
      return stringRules(schema) as unknown as z.ZodType<AnswerValue>;
    }

    case "path": {
      const schema = z.string().refine((value) => !value.includes("\0"), {
        message: "must be a filesystem path, with no null characters in it",
      });
      return stringRules(schema) as unknown as z.ZodType<AnswerValue>;
    }

    case "string":
    default:
      return stringRules(z.string()) as unknown as z.ZodType<AnswerValue>;
  }

  /** Applies the numeric constraints to a number schema. */
  function numberRules(): z.ZodType<number, number> {
    let schema = z.number();
    if (rules?.min !== undefined) schema = schema.min(rules.min, `must be at least ${rules.min}`);
    if (rules?.max !== undefined) schema = schema.max(rules.max, `must be at most ${rules.max}`);
    return schema;
  }

  /** Applies the string constraints, including the required-means-non-empty rule. */
  function stringRules(base: z.ZodType<string>): z.ZodType<string> {
    let schema: z.ZodType<string> = base;

    if (definition.required) {
      schema = schema.refine((value) => value.length > 0, { message: "must not be empty" });
    }
    if (rules?.minLength !== undefined) {
      schema = schema.refine((value) => value.length >= rules.minLength!, {
        message: `must be at least ${rules.minLength} characters long`,
      });
    }
    if (rules?.maxLength !== undefined) {
      schema = schema.refine((value) => value.length <= rules.maxLength!, {
        message: `must be at most ${rules.maxLength} characters long`,
      });
    }
    if (rules?.pattern !== undefined) {
      const pattern = new RegExp(rules.pattern);
      schema = schema.refine((value) => pattern.test(value), {
        message: `must match the pattern ${rules.pattern}`,
      });
    }

    return schema;
  }
}

/**
 * Validates one answer against its definition.
 *
 * @param definition - The variable definition the answer is for.
 * @param raw - The answer as text, as typed or as read from an env file.
 * @returns The coerced value, or a plain-language message naming what is wrong.
 */
export function validateAnswer(
  definition: VariableDefinition,
  raw: string
): AnswerValidation {
  const trimmed = typeof raw === "string" ? raw.trim() : "";

  if (trimmed.length === 0 && !definition.required) {
    return { ok: true, value: "" };
  }

  const result = validationSchemaFor(definition).safeParse(trimmed);
  if (result.success) return { ok: true, value: result.data };

  const first = result.error.issues[0];
  const reason = first?.message ?? "is not valid";
  return { ok: false, message: `${definition.name} ${reason}.` };
}

/**
 * The form an answer is STORED in. Env files hold text, so a coerced number or
 * boolean goes back to its canonical string.
 *
 * @param value - The coerced answer.
 */
export function storedForm(value: AnswerValue): string {
  return typeof value === "boolean" ? String(value) : String(value);
}

/**
 * A short, plain-language summary of a definition's constraints, shown beside
 * the question and by `sous vars <name>`. Returns an empty array when the
 * definition constrains nothing beyond its type.
 *
 * @param definition - The variable definition.
 */
export function constraintHints(definition: VariableDefinition): string[] {
  const hints: string[] = [];
  const rules = definition.validate;

  hints.push(`type: ${definition.type}`);
  if (definition.type === "enum" && rules?.enum !== undefined) {
    hints.push(`one of: ${rules.enum.join(", ")}`);
  }
  if (rules?.minLength !== undefined) hints.push(`at least ${rules.minLength} characters`);
  if (rules?.maxLength !== undefined) hints.push(`at most ${rules.maxLength} characters`);
  if (rules?.min !== undefined) hints.push(`no less than ${rules.min}`);
  if (rules?.max !== undefined) hints.push(`no more than ${rules.max}`);
  if (rules?.pattern !== undefined) hints.push(`matching ${rules.pattern}`);
  if (!definition.required) hints.push("optional");

  return hints;
}

/**
 * A character count with the noun in the right number.
 *
 * @param count - How many characters.
 */
function characters(count: number): string {
  return count === 1 ? "1 character" : `${count} characters`;
}

/**
 * One sentence per constraint, in plain words with the raw form the manifest
 * declared in parentheses, so a reader can both understand the rule and find it
 * in the recipe that published it. This is what the advanced view and
 * `sous vars show` list under `@constraints`.
 *
 * @param definition - The variable definition.
 * @returns One sentence per constraint, type first.
 *
 * @example
 * constraintBullets(definition);
 * // -> ["must be a url value (type: url)", "must match the pattern /^https/ (pattern: ^https)"]
 */
export function constraintBullets(definition: VariableDefinition): string[] {
  const rules = definition.validate;
  const bullets: string[] = [`must be a ${definition.type} value (type: ${definition.type})`];

  if (rules?.enum !== undefined) {
    bullets.push(
      `must be one of ${rules.enum.join(", ")} (enum: ${rules.enum.join(", ")})`
    );
  }
  if (rules?.minLength !== undefined) {
    bullets.push(
      `must be at least ${characters(rules.minLength)} long (minLength: ${rules.minLength})`
    );
  }
  if (rules?.maxLength !== undefined) {
    bullets.push(
      `must be at most ${characters(rules.maxLength)} long (maxLength: ${rules.maxLength})`
    );
  }
  if (rules?.min !== undefined) {
    bullets.push(`must be no less than ${rules.min} (min: ${rules.min})`);
  }
  if (rules?.max !== undefined) {
    bullets.push(`must be no more than ${rules.max} (max: ${rules.max})`);
  }
  if (rules?.pattern !== undefined) {
    bullets.push(`must match the pattern /${rules.pattern}/ (pattern: ${rules.pattern})`);
  }
  if (!definition.required) bullets.push("an answer is optional");

  return bullets;
}
