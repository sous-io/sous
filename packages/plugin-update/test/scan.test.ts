import type { ConfigBuilder, DocumentNode, Sous } from "@sous-io/plugin-api";
import { describe, expect, it } from "vitest";
import { scanContributor } from "../src/scan.js";
import { fakeManager, installedPackage } from "./helpers.js";

/** Runs the contributor against a config of `discover` and `load`, and returns what it appended and logged. */
async function scan(options: { discover?: string; load?: string[]; project?: boolean; managers: ReturnType<typeof fakeManager>[] }) {
    const appended: unknown[] = [];
    const logs: string[] = [];
    const nodes: Record<string, unknown> = { "plugins.discover": options.discover, "plugins.load": options.load };
    const config = {
        project: options.project === false ? undefined : { root: "/p", sousDir: "/p/.sous", configPath: undefined, confDir: "/p/.sous/conf.d" },
        entities: () => options.managers,
        warn: (message: string) => logs.push(message),
        atPath: (path: string): Partial<DocumentNode> => ({
            valueOr: ((fallback: unknown) => nodes[path] ?? fallback) as DocumentNode["valueOr"],
            append: (item: unknown) => void appended.push(item),
        }),
    } as unknown as ConfigBuilder;
    const sous = { plugin: { name: "@sous-io/plugin-update" }, engine: {}, services: {}, entities: {}, project: undefined, env: {} } as unknown as Sous;

    await scanContributor(sous).contribute(config);

    return { appended, logs };
}

describe("update.scan contributor", () => {
    const withPlugins = fakeManager({
        id: "npm",
        detect: { id: "npm", detected: true },
        project: () => [
            installedPackage({ name: "sous-plugin-b", location: "/x/b", isSousPlugin: true }),
            installedPackage({ name: "sous-plugin-a", location: "/x/a", isSousPlugin: true }),
            installedPackage({ name: "sous-plugin-known", location: "/x/k", isSousPlugin: true }),
            installedPackage({ name: "left-pad", location: "/x/l" }),
        ],
    });

    /** It should add every installed sous plugin to plugins.load, in name order, skipping what is already there. */
    it("should add installed plugins when plugins.discover is scan", async () => {
        const { appended } = await scan({ discover: "scan", load: ["sous-plugin-known"], managers: [withPlugins] });

        expect(appended).toEqual(["sous-plugin-a", "sous-plugin-b"]);
    });

    /** It should do nothing unless the config asks for a scan, and nothing outside a project. */
    it("should do nothing when discover is dependencies or there is no project", async () => {
        expect((await scan({ managers: [withPlugins] })).appended).toEqual([]);
        expect((await scan({ discover: "dependencies", managers: [withPlugins] })).appended).toEqual([]);
        expect((await scan({ discover: "scan", project: false, managers: [withPlugins] })).appended).toEqual([]);
    });

    /** It should skip managers that do not own the project, and report one that fails instead of failing the build. */
    it("should skip other managers and report a failing one", async () => {
        const other = fakeManager({ id: "pnpm", detect: undefined, project: () => [installedPackage({ name: "sous-plugin-z", location: "/z", isSousPlugin: true })] });
        const broken = fakeManager({ id: "yarn", detect: () => { throw new Error("no yarn"); } });
        const { appended, logs } = await scan({ discover: "scan", managers: [other, broken, withPlugins] });

        expect(appended).toEqual(["sous-plugin-a", "sous-plugin-b", "sous-plugin-known"]);
        expect(logs).toEqual(["yarn could not list the installed packages: no yarn"]);
    });
});
