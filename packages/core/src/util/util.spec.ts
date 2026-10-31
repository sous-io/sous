import { describe, expect, it } from "vitest";
import { countFrames, describeFramePath, framePath, pushFrame } from "./frames.js";
import { matchesWildcard, namePrefix, pluginPrefix } from "./names.js";
import { stableKey } from "./stable.js";

describe("stableKey()", () => {
    /**
     * Equal values give equal keys whatever their key order; odd values still give a key.
     *
     * stableKey({ b: 1, a: 2 }) === stableKey({ a: 2, b: 1 })
     */
    it("should give equal keys to equal values", () => {
        const circular: Record<string, unknown> = { a: 1 };

        circular.self = circular;

        expect(stableKey({ b: 1, a: [{ d: 1, c: 2 }] })).toBe('{"a":[{"c":2,"d":1}],"b":1}');
        expect(stableKey(undefined)).toBe("undefined");
        expect(stableKey(() => 1)).toBe("undefined");
        expect(stableKey(circular)).toBe('{"a":1,"self":"[circular]"}');
        expect(stableKey({ big: 1n })).toBe("[unserializable]");
    });
});

describe("frames", () => {
    /**
     * Frames record the path of calls, count matching ones and describe the path as one line.
     */
    it("should record and describe the call path", () => {
        const event = pushFrame(undefined, "event", "config.built");
        const listener = pushFrame(event, "listener", "sous-plugin-foo");
        const intent = pushFrame(listener, "intent", "subscription.enable", { enabled: true });
        const plain = pushFrame(intent, "intent", "build", {});
        const chain = pushFrame(plain, "chain", "#3");

        expect(framePath(chain).map((frame) => frame.name)).toEqual(["config.built", "sous-plugin-foo", "subscription.enable", "build", "#3"]);
        expect(countFrames(chain, "intent")).toBe(2);
        expect(countFrames(chain, "intent", "build")).toBe(1);
        expect(countFrames(chain, "intent", "build", '{"x":1}')).toBe(0);
        expect(describeFramePath(chain)).toBe(
            'config.built → sous-plugin-foo listener → intent "subscription.enable" ({"enabled":true}) → intent "build" → chain #3',
        );
        expect(describeFramePath(undefined)).toBe("");
    });
});

describe("names", () => {
    /**
     * A plugin's prefix drops the scope and the plugin- or sous-plugin- start; wildcards match across
     * dots and slashes.
     */
    it("should find prefixes and match wildcards", () => {
        expect(pluginPrefix("@sous-io/plugin-compiler")).toBe("compiler");
        expect(pluginPrefix("sous-plugin-diagrams")).toBe("diagrams");
        expect(pluginPrefix("plain")).toBe("plain");
        expect(namePrefix("diagrams.render")).toBe("diagrams");
        expect(namePrefix("build")).toBe("build");
        expect(matchesWildcard("*.before", "subscription.add.before")).toBe(true);
        expect(matchesWildcard("confd/*", "confd/610-mac.jsonc")).toBe(true);
        expect(matchesWildcard("confd/*", "confd/610-mac.jsonc")).toBe(true);
        expect(matchesWildcard("a.(b)", "a.(b)")).toBe(true);
        expect(matchesWildcard("a*", "b")).toBe(false);
    });
});
