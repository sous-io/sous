import type { IntentDefinition, Sous } from "@sous-io/plugin-api";
import { describe, expect, it } from "vitest";
import { PLUGIN_NAME, updatePlugin } from "../src/index.js";

/** Registers the plugin against a recording `sous`. */
async function register() {
    const intents: IntentDefinition[] = [];
    const entities: string[] = [];
    const contributors: string[] = [];
    const sous = {
        plugin: { name: PLUGIN_NAME },
        engine: {},
        entities: { define: (kind: string) => void entities.push(kind) },
        intents: { add: (definition: IntentDefinition) => void intents.push(definition) },
        config: { contribute: (definition: { id: string }) => void contributors.push(definition.id) },
    } as unknown as Sous;

    await updatePlugin.register(sous);

    return { intents, entities, contributors };
}

describe("plugin-update registration", () => {
    /** It should define the package-manager kind, add the scan contributor and both intents (C5). */
    it("should register the entity kind, the contributor and the intents", async () => {
        const { intents, entities, contributors } = await register();

        expect(entities).toEqual(["package-manager"]);
        expect(contributors).toEqual(["update.scan"]);
        expect(intents.map((intent) => intent.intent)).toEqual(["update", "plugins.install"]);
    });

    /** The old flags should survive: -y/--force/--yes, --pre, --dry-run, --no-build, --version, --major, --global, --project. */
    it("should keep every flag of sous update", async () => {
        const { intents } = await register();
        const update = intents.find((intent) => intent.intent === "update")!;
        const properties = Object.keys((update.input as any)["~standard"].jsonSchema?.input({ target: "draft-2020-12" }).properties ?? {});

        expect(properties).toEqual(expect.arrayContaining(["major", "version", "prerelease", "global", "project", "yes", "dryRun", "noBuild"]));
        expect(update.cli?.flags).toMatchObject({ yes: { short: "y", aliases: ["force"] }, prerelease: { aliases: ["pre"] } });
    });

    /** `sous update` must run when the config fails to build, since it is how a broken install is repaired. */
    it("should let update run with a broken config", async () => {
        const { intents } = await register();

        expect(intents.find((intent) => intent.intent === "update")?.toleratesConfigErrors).toBe(true);
        expect(intents.find((intent) => intent.intent === "plugins.install")?.toleratesConfigErrors).toBeUndefined();
    });

    /** Both handlers should load lazily. */
    it("should load each handler on demand", async () => {
        const { intents } = await register();

        for (const intent of intents) {
            const loaded = (await intent.load!()) as { default: unknown };

            expect(typeof loaded.default).toBe("function");
        }
    });
});
