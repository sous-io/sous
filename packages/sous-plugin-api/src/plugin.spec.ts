import { describe, expect, it } from "vitest";
import { definePlugin } from "./plugin.js";

describe("definePlugin()", () => {
    /**
     * It returns the definition as given, only giving it its type.
     */
    it("should return the definition unchanged", () => {
        const definition = { name: "sous-plugin-diagrams", version: "1.0.0", register() {} };

        expect(definePlugin(definition)).toBe(definition);
    });
});
