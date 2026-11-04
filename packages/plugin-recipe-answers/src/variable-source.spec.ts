import { describe, expect, it } from "vitest";
import { definition, names, pinnedRecipe, serviceReader } from "../test/stand-ins.js";
import { definitionsFromRecipes } from "./definitions.js";
import { recipeAnswersSource } from "./variable-source.js";

describe("recipeAnswersSource()", () => {
    /**
     * A build renders a holder's files in the holder's own scope. A holder of a version that is not
     * asked a variable (another version of the recipe is) has no variables of its own, and still
     * gets a scope, in which the variable is empty; the holder of the shared version sees the answer.
     *
     * support/base 1.0.0 (lib/one): tone (string), 2.0.0 (lib/two): tone (number); SOUS_VAR_TONE=warm
     * // -> scoped("lib/one"): tone "warm"; scoped("lib/two"): tone ""
     */
    it("should render the variable empty in the scope of a holder of the version not asked", () => {
        const variables = definitionsFromRecipes([
            pinnedRecipe([definition({ name: "tone" })], [{ holder: "lib/two", version: "2.0.0", variables: [definition({ name: "tone", type: "number" })] }]),
        ]);
        const source = recipeAnswersSource(variables, serviceReader({ "variables.names": names }));
        const ctx = { env: { SOUS_VAR_TONE: "warm" }, config: { get: () => undefined } } as never;

        expect(source.variables(ctx)).toEqual({ tone: "warm" });
        expect(source.scoped?.("lib/one", ctx)).toBeUndefined();
        expect(source.scoped?.("lib/two", ctx)).toEqual({ tone: "" });
    });
});
