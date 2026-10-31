import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSousHome, resolveSousHomePaths } from "./sous-home.js";

describe("resolveSousHomePaths()", () => {
    /** Without SOUS_HOME, the home is `~/.sous` and everything sits under it. */
    it("should default to .sous under the user's home directory", () => {
        const paths = resolveSousHomePaths({});
        const root = path.join(os.homedir(), ".sous");

        expect(paths).toEqual({
            root,
            store: path.join(root, "cache"),
            indexCache: path.join(root, "cache", "_indexes"),
            repos: path.join(root, "repos"),
            links: path.join(root, "sous.links.json"),
            readStrategies: path.join(root, "cache", "read-strategies.json"),
        });
    });

    /** An absolute SOUS_HOME is used as given (on Windows it gains the current drive). */
    it("should use an absolute SOUS_HOME", () => {
        expect(resolveSousHomePaths({ SOUS_HOME: "/opt/sous-home" }).root).toBe(path.resolve("/opt/sous-home"));
        expect(resolveSousHomePaths({ SOUS_HOME: "/opt/sous-home" }).store).toBe(path.resolve("/opt/sous-home", "cache"));
    });

    /** A leading tilde is expanded; `~user` is not. */
    it("should expand a leading tilde", () => {
        expect(resolveSousHomePaths({ SOUS_HOME: "~/sous-home" }).root).toBe(path.join(os.homedir(), "sous-home"));
        expect(resolveSousHomePaths({ SOUS_HOME: "~" }).root).toBe(os.homedir());
        expect(resolveSousHomePaths({ SOUS_HOME: "~other/x" }).root).toBe(path.resolve("~other/x"));
    });

    /** A blank value is unset, never the current directory. */
    it("should treat a blank SOUS_HOME as unset", () => {
        for (const SOUS_HOME of ["", "   ", undefined]) {
            expect(resolveSousHomePaths({ SOUS_HOME }).root).toBe(path.join(os.homedir(), ".sous"));
        }
    });

    /** A relative value is resolved to an absolute path. */
    it("should resolve a relative SOUS_HOME", () => {
        expect(path.isAbsolute(resolveSousHomePaths({ SOUS_HOME: "rel/home" }).root)).toBe(true);
    });
});

describe("createSousHome()", () => {
    /** The environment is read on every call, because env files may set SOUS_HOME later. */
    it("should read the environment at call time", () => {
        const env: Record<string, string | undefined> = {};
        const home = createSousHome(() => env);

        env.SOUS_HOME = "/first";
        expect(home.paths().root).toBe(path.resolve("/first"));
        env.SOUS_HOME = "/second";
        expect(home.paths().root).toBe(path.resolve("/second"));
        expect(home.resolve("cache", "x")).toBe(path.resolve("/second", "cache", "x"));
        expect(home.paths({ SOUS_HOME: "/given" }).root).toBe(path.resolve("/given"));
    });
});
