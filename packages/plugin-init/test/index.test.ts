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
        const [init] = await register();

        expect(init!.intent).toBe("init");
        expect(init!.cli?.positional).toEqual(["directory"]);
        expect(init!.cli?.flags).toMatchObject({ yes: { short: "y", aliases: ["force"] } });

        const schema = (init!.input as any)["~standard"].jsonSchema?.input({ target: "draft-2020-12" });

        expect(Object.keys(schema.properties)).toEqual(["directory", "name", "yes", "moveIncludes", "copyIncludes", "leaveIncludes", "dryRun", "noBuild", "hooks", "pullHooks", "install"]);
        // Left out, these three ask, so none has a default.
        expect([schema.properties.hooks.default, schema.properties.pullHooks.default, schema.properties.install.default]).toEqual([undefined, undefined, undefined]);
    });

    /** It should add `sous init hooks` as a command of its own, under init. */
    it("should register the init.hooks intent as 'sous init hooks'", async () => {
        const [, hooks, ...rest] = await register();

        expect(rest).toEqual([]);
        expect(hooks!.intent).toBe("init.hooks");
        expect(hooks!.cli?.command).toEqual(["init", "hooks"]);

        const schema = (hooks!.input as any)["~standard"].jsonSchema?.input({ target: "draft-2020-12" });

        expect(Object.keys(schema.properties)).toEqual(["directory", "pullHooks", "install", "yes", "dryRun"]);
    });

    /** Its handler should load on demand. */
    it("should load the handler on demand", async () => {
        const [init] = await register();
        const loaded = (await init!.load!()) as { default: unknown };

        expect(typeof loaded.default).toBe("function");
    });
});
