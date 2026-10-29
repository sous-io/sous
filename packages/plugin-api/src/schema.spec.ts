import { describe, expect, it } from "vitest";
import { jsonSchema, validateWithSync } from "./schema.js";

describe("jsonSchema()", () => {
    /**
     * A property that is missing and has no default is optional unless `required` names it.
     *
     * jsonSchema({ type: "object", properties: { short: { type: "string" } } }) accepts { id: "debug" }
     */
    it("should accept a missing optional property", () => {
        const schema = jsonSchema({ type: "object", properties: { id: { type: "string" }, short: { type: "string" } } });

        expect(validateWithSync(schema, { id: "debug" })).toEqual({ value: { id: "debug" } });
    });
});
