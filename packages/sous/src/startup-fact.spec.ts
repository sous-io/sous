import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectInfo } from "@sous-io/plugin-api";
import { loadsOnlyBuiltIns, recordStartupFact, startupKey } from "./startup-fact.js";

const made: string[] = [];

function tmp(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "sous-startup-"));

    made.push(dir);

    return dir;
}

afterEach(() => {
    for (const dir of made.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

/** A project with a config file and a lockfile, and an empty sous home beside it. */
function setup(): { project: ProjectInfo; env: Record<string, string>; lock: string } {
    const root = tmp();
    const sousDir = path.join(root, ".sous");
    const home = path.join(root, "home");

    mkdirSync(path.join(sousDir, "conf.d"), { recursive: true });
    mkdirSync(home);
    writeFileSync(path.join(sousDir, "sous.config.jsonc"), "{}");
    writeFileSync(path.join(sousDir, "sous.lock.json"), "{}");

    return {
        project: { root, sousDir, configPath: path.join(sousDir, "sous.config.jsonc"), confDir: path.join(sousDir, "conf.d") },
        env: { SOUS_HOME: home },
        lock: path.join(sousDir, "sous.lock.json"),
    };
}

describe("the startup fact", () => {
    /**
     * A recorded fact answers only for the inputs it was recorded under: changing the lockfile
     * changes the key, so the next run builds the config again.
     */
    it("should hold only while the lockfile and config files are unchanged", () => {
        const { project, env, lock } = setup();
        const key = startupKey(project, env, "1.0.0", "bundle.js");

        expect(loadsOnlyBuiltIns(project, env, key)).toBe(false);

        recordStartupFact(project, env, key, true);

        expect(loadsOnlyBuiltIns(project, env, key)).toBe(true);

        writeFileSync(lock, '{"recipes":{}}');
        utimesSync(lock, new Date(), new Date(Date.now() + 5000));

        expect(startupKey(project, env, "1.0.0", "bundle.js")).not.toBe(key);
        expect(loadsOnlyBuiltIns(project, env, startupKey(project, env, "1.0.0", "bundle.js"))).toBe(false);
    });

    /** A build that loaded another plugin records that, and the fast path stays off. */
    it("should not hold when the build loaded a plugin beyond the built-in ones", () => {
        const { project, env } = setup();
        const key = startupKey(project, env, "1.0.0", "bundle.js");

        recordStartupFact(project, env, key, false);

        expect(loadsOnlyBuiltIns(project, env, key)).toBe(false);
    });

    /** The fact file and the state file change on every run, so they are not part of the key. */
    it("should not count its own file in the key", () => {
        const { project, env } = setup();
        const key = startupKey(project, env, "1.0.0", "bundle.js");

        recordStartupFact(project, env, key, true);
        writeFileSync(path.join(project.sousDir, "sous.state.json"), "{}");

        expect(startupKey(project, env, "1.0.0", "bundle.js")).toBe(key);
    });
});
