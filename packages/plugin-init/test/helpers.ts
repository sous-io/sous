/**
 * Stand-ins for the tests: a context whose host services are the real ones from plugin-host (they
 * only touch the temporary directory) and whose config loader and build are stand-ins.
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { BufferedReporter, type Context, IntentOutputs, scriptedPrompter } from "@sous-io/plugin-api";
import type { BuildResult } from "@sous-io/plugin-build/types";
import type { ConfigFilesLoader } from "@sous-io/plugin-config-files/types";
import { createDirectories, createGitignore } from "@sous-io/plugin-host";

/** The names a config is found under, as the real loader tries them. */
const MAIN_NAMES = ["sous.config.ts", "sous.config.mts", "sous.config.js", "sous.config.mjs", "sous.config.jsonc", "sous.config.json", "sous.config.yaml", "sous.config.yml"];

/** A loader that finds config files by name and reads `.jsonc` and `.js` ones. */
export const fakeLoader: Pick<ConfigFilesLoader, "findMain" | "load"> = {
    findMain(sousDir) {
        const name = MAIN_NAMES.find((candidate) => fs.existsSync(path.join(sousDir, candidate)));

        return name === undefined ? undefined : path.join(sousDir, name);
    },

    async load(file) {
        if (file.endsWith(".js")) {
            const module = (await import(pathToFileURL(file).href)) as { config: unknown };

            return { kind: "module", path: file, format: "js", configure: () => {}, text: JSON.stringify(module.config) } as never;
        }

        const text = fs.readFileSync(file, "utf8");
        const data = JSON.parse(text.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n"));

        return { kind: "data", path: file, format: "jsonc", data, text } as never;
    },
};

/** Options for {@link initContext}. */
export interface InitContextOptions {
    /** The answers the prompter gives, in order; omitted means it cannot ask. */
    answers?: unknown[];
    /** What the `build` intent answers. */
    build?: Partial<BuildResult>;
    version?: string;
    /** Changes to the loader. */
    loader?: Partial<ConfigFilesLoader>;
}

/** What the context saw. */
export interface InitRecorded {
    reporter: BufferedReporter;
    /** Every intent `ctx.run` was asked for. */
    runs: Array<{ intent: string; input: unknown }>;
    configChanged: number;
    /** How many times the config was refreshed, and the runs before each refresh. */
    refreshes: number[];
    asked: string[];
}

/** A `Context` for `init`. */
export function initContext(options: InitContextOptions = {}): { ctx: Context; recorded: InitRecorded } {
    const reporter = new BufferedReporter();
    const prompter = scriptedPrompter([...(options.answers ?? [])]);
    const recorded: InitRecorded = { reporter, runs: [], configChanged: 0, refreshes: [], asked: prompter.asked };
    const services: Record<string, unknown> = {
        "host.package": { identity: () => ({ name: "@sous-io/sous", version: options.version ?? "0.1.1", root: "/x", realRoot: "/x", bin: undefined }) },
        "host.gitignore": createGitignore(),
        "host.directories": createDirectories({
            entities: { list: () => [] } as never,
            sousHome: { paths: () => ({ root: "/nowhere-sous-home" }) } as never,
        }),
        "config-files.loader": { ...fakeLoader, ...options.loader },
    };
    const ctx = {
        plugin: "@sous-io/plugin-init",
        reporter,
        prompter,
        services: { get: (name: string) => services[name], has: (name: string) => name in services },
        entities: { list: () => [] },
        project: undefined,
        env: {},
        configChanged: () => void recorded.configChanged++,
        chain: { id: 1, intent: "init", parallel: false },
        refreshConfig: async () => void recorded.refreshes.push(recorded.runs.length),
        run: async (intent: string, input: unknown) => {
            recorded.runs.push({ intent, input });

            return IntentOutputs.of({ ok: true, dryRun: false, watching: false, ...options.build });
        },
    } as unknown as Context;

    return { ctx, recorded };
}
