import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JsonObject } from "@sous-io/sous-plugin-api";
import { editorProject, type EditorProject } from "../test/engine.js";
import { makeTmpDir } from "../test/helpers.js";
import { editor } from "./chain.js";

let tmp: { path: string; cleanup(): void };
let project: EditorProject;

/** The file as it starts, and no history: each run below starts from here. */
function fresh(): void {
    project.write("cfg.json", `${JSON.stringify({ cfg: { mode: "loose" }, list: ["a", "b"] }, null, 2)}\n`);
    fs.rmSync(path.join(tmp.path, ".sous", "sous.edits.json"), { force: true });
}

beforeEach(() => {
    tmp = makeTmpDir();
    project = editorProject(tmp.path);
    fresh();
});

afterEach(() => {
    tmp.cleanup();
});

/**
 * Two recipes that disagree. a/one's edits imply two automatic assertions, one at `cfg` and one
 * below it; b/two's edits, applied after, make both fail:
 *
 * - a/one `set cfg.mode strict`  -> equals "strict" at cfg.mode   (b/two sets it back to "loose")
 * - a/one `sortKeys cfg`         -> sortedKeys at cfg             (b/two adds the key "aaa" last)
 */
const CONFLICT: JsonObject[] = [
    { file: "cfg.json", recipe: "a/one", set: { path: "cfg.mode", value: "strict" } },
    { file: "cfg.json", recipe: "a/one", sortKeys: { path: "cfg" } },
    { file: "cfg.json", recipe: "b/two", set: { path: "cfg.mode", value: "loose" } },
    { file: "cfg.json", recipe: "b/two", set: { path: "cfg.aaa", value: 1 } },
];

/** a/one's automatic assertions after a run, as `check at path: warned | silenced`. */
async function outcomes(...extra: JsonObject[]): Promise<string[]> {
    fresh();

    const { result, warnings } = await project.apply([...CONFLICT, ...extra]);

    expect(result.ok).toBe(true);

    const mine = result.assertions.filter((item) => item.automatic && item.declarer === "a/one");
    const said = mine.map((item) => `${item.check} at ${item.path}: ${item.silenced ? "silenced" : item.passed ? "passed" : "warned"}`);

    // Every assertion that warned was said once, as a warning naming a/one.
    expect(warnings.filter((warning) => warning.includes("a/one expects"))).toHaveLength(said.filter((line) => line.endsWith("warned")).length);

    return said.sort();
}

describe("silencing through editor.apply", () => {
    /**
     * With nothing silenced, both of a/one's automatic assertions fail as warnings.
     *
     * CONFLICT -> equals at cfg.mode: warned; sortedKeys at cfg: warned
     */
    it("should warn on both automatic assertions when nothing is silenced", async () => {
        expect(await outcomes()).toEqual(["equals at cfg.mode: warned", "sortedKeys at cfg: warned"]);
    });

    /**
     * `silence` at a path reaches that key and everything below it by default (`key-and-below`);
     * `key-only` reaches the key alone; `below` only what is below it.
     *
     * silence { path: cfg }                    -> both silenced
     * silence { path: cfg, scope: key-only }   -> sortedKeys at cfg silenced
     * silence { path: cfg, scope: below }      -> equals at cfg.mode silenced
     */
    it("should silence by scope: key and below, key only, below only", async () => {
        const silence = (extra: JsonObject) => ({ file: "cfg.json", recipe: "a/one", silence: { path: "cfg", ...extra } });

        expect(await outcomes(silence({}))).toEqual(["equals at cfg.mode: silenced", "sortedKeys at cfg: silenced"]);
        expect(await outcomes(silence({ scope: "key-and-below" }))).toEqual(["equals at cfg.mode: silenced", "sortedKeys at cfg: silenced"]);
        expect(await outcomes(silence({ scope: "key-only" }))).toEqual(["equals at cfg.mode: warned", "sortedKeys at cfg: silenced"]);
        expect(await outcomes(silence({ scope: "below" }))).toEqual(["equals at cfg.mode: silenced", "sortedKeys at cfg: warned"]);
    });

    /**
     * `kinds` silences only the kinds named; `except` every kind but those.
     *
     * silence { path: cfg, kinds: [sortedKeys] }  -> sortedKeys silenced, equals warned
     * silence { path: cfg, except: [sortedKeys] } -> equals silenced, sortedKeys warned
     */
    it("should silence the kinds named, or every kind except those", async () => {
        const silence = (extra: JsonObject) => ({ file: "cfg.json", recipe: "a/one", silence: { path: "cfg", ...extra } });

        expect(await outcomes(silence({ kinds: ["sortedKeys"] }))).toEqual(["equals at cfg.mode: warned", "sortedKeys at cfg: silenced"]);
        expect(await outcomes(silence({ kinds: "equals" }))).toEqual(["equals at cfg.mode: silenced", "sortedKeys at cfg: warned"]);
        expect(await outcomes(silence({ except: ["sortedKeys"] }))).toEqual(["equals at cfg.mode: silenced", "sortedKeys at cfg: warned"]);
        expect(await outcomes(silence({ except: ["equals"], scope: "key-only" }))).toEqual(["equals at cfg.mode: warned", "sortedKeys at cfg: silenced"]);
    });

    /**
     * `except` takes `include`, the plugin spelling of `includes`.
     *
     * a/one ensureIncludes "x" and sort; b/two removes "x" and adds "0" last
     * silence { path: list, except: [include] } -> includes warned, sorted silenced
     */
    it("should read include in except as includes", async () => {
        const { result } = await project.apply([
            { file: "cfg.json", recipe: "a/one", ensureIncludes: { path: "list", items: ["x"] }, sort: { path: "list" } },
            { file: "cfg.json", recipe: "b/two", removeValue: { path: "list", value: "x" }, append: { path: "list", item: "0" } },
            { file: "cfg.json", recipe: "a/one", silence: { path: "list", except: ["include"] } },
        ]);
        const mine = result.assertions.filter((item) => item.automatic && item.declarer === "a/one");

        expect(mine.map((item) => [item.check, item.silenced === true, item.passed]).sort()).toEqual([
            ["includes", false, false],
            ["sorted", true, true],
        ]);
    });

    /**
     * `silence: {}` silences every automatic assertion of the declarer's edits to the file, and
     * a declarer silences only its own: b/two's silence leaves a/one's warnings.
     *
     * a/one silence {} -> both silenced; b/two silence {} -> both warned
     */
    it("should silence a whole file, and only the declarer's own assertions", async () => {
        expect(await outcomes({ file: "cfg.json", recipe: "a/one", silence: {} })).toEqual(["equals at cfg.mode: silenced", "sortedKeys at cfg: silenced"]);
        expect(await outcomes({ file: "cfg.json", recipe: "b/two", silence: {} })).toEqual(["equals at cfg.mode: warned", "sortedKeys at cfg: warned"]);
        expect(await outcomes({ file: "other.json", recipe: "a/one", silence: {} })).toEqual(["equals at cfg.mode: warned", "sortedKeys at cfg: warned"]);
    });

    /**
     * `assertion: none` drops one edit's automatic assertion; an assertion of the declarer's own
     * at that path replaces the automatic one there.
     *
     * a/one set cfg.mode with assertion: none -> only sortedKeys warned
     */
    it("should drop one edit's assertion with assertion: none, and the automatic one where the author wrote its own", async () => {
        const { result } = await project.apply([
            { file: "cfg.json", recipe: "a/one", set: { path: "cfg.mode", value: "strict", assertion: "none" } },
            ...CONFLICT.slice(1),
            { file: "cfg.json", recipe: "a/one", assert: { path: "cfg", exists: true } },
        ]);

        expect(result.assertions.filter((item) => item.declarer === "a/one").map((item) => [item.check, item.path, item.automatic])).toEqual([
            ["exists", "cfg", false],
        ]);
    });

    /**
     * The chain's silences record the same entries and act the same: `.silence(path)`,
     * `.thisKeyOnly()`, `.belowOnly()`, `.except(kinds)` and `.withoutAutomaticAssertions()`.
     *
     * settings.silence("cfg").belowOnly() -> equals at cfg.mode silenced, sortedKeys at cfg warned
     */
    it("should silence the same way from the chain", async () => {
        const run = async (silence: (settings: ReturnType<ReturnType<typeof editor>["file"]>) => void): Promise<string[]> => {
            fresh();

            const { result } = await project.apply((config) => {
                const settings = editor(config).file("cfg.json");

                settings.at("cfg.mode").set("strict");
                settings.at("cfg").sortKeys();
                config.atPath("editor.edits").appendValue(CONFLICT[2]!);
                config.atPath("editor.edits").appendValue(CONFLICT[3]!);
                silence(settings);
            });

            return result.assertions
                .filter((item) => item.automatic && item.declarer === "test-declarer")
                .map((item) => `${item.check} at ${item.path}: ${item.silenced ? "silenced" : item.passed ? "passed" : "warned"}`)
                .sort();
        };

        expect(await run(() => {})).toEqual(["equals at cfg.mode: warned", "sortedKeys at cfg: warned"]);
        expect(await run((settings) => settings.silence("cfg"))).toEqual(["equals at cfg.mode: silenced", "sortedKeys at cfg: silenced"]);
        expect(await run((settings) => settings.silence("cfg").thisKeyOnly())).toEqual(["equals at cfg.mode: warned", "sortedKeys at cfg: silenced"]);
        expect(await run((settings) => settings.silence("cfg").belowOnly())).toEqual(["equals at cfg.mode: silenced", "sortedKeys at cfg: warned"]);
        expect(await run((settings) => settings.silence("cfg", ["sortedKeys"]))).toEqual(["equals at cfg.mode: warned", "sortedKeys at cfg: silenced"]);
        expect(await run((settings) => settings.silence("cfg").except("sortedKeys"))).toEqual(["equals at cfg.mode: silenced", "sortedKeys at cfg: warned"]);
        expect(await run((settings) => settings.withoutAutomaticAssertions())).toEqual(["equals at cfg.mode: silenced", "sortedKeys at cfg: silenced"]);
    });
});
