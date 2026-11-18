/**
 * The `handlers` block of a recipe manifest: for each purpose, the exported functions Sous runs,
 * in the order listed. Each `file` is one self-contained JavaScript file in the recipe; `handler`
 * names the function it exports.
 *
 * ```yaml
 * handlers:
 *   check:
 *     - file: handlers/prerequisites.js
 *       handler: checkCommands
 * ```
 *
 * It lives in its own module so the manifest schema gains only one key for it.
 */

import { z } from "zod";
import { extensibleObject, relativePathSchema } from "./common.js";

/** The purposes a manifest may list handlers for. The set is fixed for now. */
export const RECIPE_HANDLER_PURPOSES = ["check", "configure", "beforeBuild", "afterBuild", "uninstall", "migrate"] as const;

/** One handler: a file in the recipe and the name of the function it exports. */
export const recipeHandlerSchema = extensibleObject({
  /** The file, relative to the recipe folder: `handlers/prerequisites.js`. */
  file: relativePathSchema("a handler file"),
  /** The name of the exported function: `checkCommands`. */
  handler: z
    .string()
    .regex(/^[A-Za-z_$][\w$]*$/, "a handler must be the name of an exported function, such as checkCommands"),
});

/** Each purpose's handlers, in run order. */
export const recipeHandlersSchema = extensibleObject(
  Object.fromEntries(RECIPE_HANDLER_PURPOSES.map((purpose) => [purpose, z.array(recipeHandlerSchema).optional()])) as Record<
    (typeof RECIPE_HANDLER_PURPOSES)[number],
    z.ZodOptional<z.ZodArray<typeof recipeHandlerSchema>>
  >
);

/** A validated `handlers` block. */
export type RecipeHandlers = z.infer<typeof recipeHandlersSchema>;
