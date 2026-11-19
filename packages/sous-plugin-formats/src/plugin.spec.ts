import { describe, expect, it } from "vitest";
import formatsPlugin, { PLUGIN_NAME } from "./index.js";

describe("the plugin", () => {
    /** It is named and depends on sous-plugin-refs, one way. */
    it("should name itself and depend only on sous-plugin-refs", () => {
        expect(formatsPlugin.name).toBe(PLUGIN_NAME);
        expect(Object.keys(formatsPlugin.dependsOn ?? {})).toEqual(["@sous-io/sous-plugin-refs"]);
    });
});
