/**
 * Ref lookups over variables (S6, "vars and refs"): two `ref-lookup` entities, so plugin-refs
 * knows nothing of variables or answers. Both are opt-in, under the tag `variables`: they answer
 * only callers that ask for them, since narrowing every ref to what defines a variable would hide
 * recipes that define none.
 */

import type { ServiceContext } from "@sous-io/plugin-api";
import type { RefLookupEntity } from "@sous-io/plugin-refs/types";
import { matchVariables } from "./matching.js";
import { buildLadder } from "./sources.js";

/** The tag both lookups answer to. */
export const VARIABLES_TAG = "variables";

/** Variables, and the repositories, namespaces and recipes that publish them. */
export const variableLookup: RefLookupEntity = {
    id: "recipe-answers.variables",
    description: "the variables the active recipes define",
    kinds: ["repo", "namespace", "recipe", "variable"],
    tags: [VARIABLES_TAG],
    optIn: true,
    find: async (candidate, ctx) => variableLookup.findSync!(candidate, ctx),
    findSync: (candidate, ctx: ServiceContext) => matchVariables(ctx.services.get("recipe-answers.definitions").listSync(), candidate),
};

/** Environment names, with the variables each answers. */
export const envVarLookup: RefLookupEntity = {
    id: "recipe-answers.env-vars",
    description: "the environment variable names that answer recipe variables",
    kinds: ["envVar"],
    tags: [VARIABLES_TAG],
    optIn: true,
    find: async (candidate, ctx) => envVarLookup.findSync!(candidate, ctx),
    findSync: (candidate, ctx: ServiceContext) =>
        matchVariables(ctx.services.get("recipe-answers.definitions").listSync(), candidate, buildLadder({ services: ctx.services, env: ctx.env, config: ctx.config })),
};
