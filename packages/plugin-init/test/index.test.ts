import type { IntentDefinition, Sous } from "@sous-io/plugin-api";
import { describe, expect, it } from "vitest";
import { initPlugin, PLUGIN_NAME } from "../src/index.js";

/** Registers the plugin against a recording `sous`. */
async function register(): Promise<IntentDefinition[]> {
    const intents: IntentDefinition[] = [];

    await initPlugin.register({ plugin: { name: PLUGIN_NAME }, intents: { add: (definition: IntentDefinition) => void intents.push(definition) } } as unknown as Sous);

    return intents;
}

describe("plugin-init registration", () => {
    /** It should add the init intent, with the directory as its argument and the old flag spellings. */
    it("should register the init intent with every old flag", async () => {
        const [init, ...rest] = await register();

        expect(rest).toEqual([]);
        expect(init!.intent).toBe("init");
        expect(init!.cli?.positional).toEqual(["directory"]);
        expect(init!.cli?.flags).toMatchObject({ yes: { short: "y", aliases: ["force"] } });

        const schema = (init!.input as any)["~standard"].jsonSchema?.input({ target: "draft-2020-12" });

        expect(Object.keys(schema.properties)).toEqual(["directory", "format", "name", "yes", "dryRun", "noBuild"]);
        expect(schema.properties.format.enum).toEqual(["js", "json"]);
    });

    /** Its handler should load on demand. */
    it("should load the handler on demand", async () => {
        const [init] = await register();
        const loaded = (await init!.load!()) as { default: unknown };

        expect(typeof loaded.default).toBe("function");
    });
});
