import type { ConfigBuilder, Sous } from "@sous-io/plugin-api";
import { describe, expect, it } from "vitest";
import { RESERVED_NAMES_CONTRIBUTOR } from "../src/index.js";
import type { VariableSourceEntity } from "../src/types.js";
import { engineWith, errorText, file, setter } from "./helpers.js";

/** A variable source like recipe answers: root values, one recipe's own values, and a secret. */
const answers: VariableSourceEntity = {
    id: "recipe-answers",
    description: "recipe answers",
    variables: () => ({ owner: "luke", region: "from-answers", deployKey: "abc123", projectRoot: "/nope" }),
    scoped: (key) => (key === "workflow/task-files" ? { owner: "task-files-owner" } : undefined),
    secrets: () => ["deployKey"],
    forbiddenUnder: ["subscriptions", "repos"],
};

describe("auto-variables", () => {
    /**
     * Sous sets the project's own paths, the sous home, the package root and the version.
     *
     * ${projectRoot} → /work/app, ${sousDir} → /work/app/.sous, ...
     */
    it("should set projectRoot, sousDir, sousConfigPath, sousConfDir, sousHome, sousRootPath and sousVersion", async () => {
        const { engine } = engineWith();
        const config = await engine.buildConfig();
        const resolver = config.services.get("variables.resolver");

        expect(resolver.autoVariables()).toEqual({
            projectRoot: "/work/app",
            sousDir: "/work/app/.sous",
            sousConfigPath: "/work/app/.sous/sous.config.jsonc",
            sousConfDir: "/work/app/.sous/conf.d",
            sousHome: "/home/me/.sous",
            sousRootPath: "/opt/sous",
            sousVersion: "9.8.7",
        });
        expect(resolver.scope().projectRoot).toBe("/work/app");
        expect(resolver.isAutoVariable("projectRoot")).toBe(true);
        expect(resolver.isAutoVariable("owner")).toBe(false);
    });

    /** `sousHome` follows SOUS_HOME from the environment sous was given. */
    it("should take sousHome from SOUS_HOME", async () => {
        const { engine } = engineWith({ env: { SOUS_HOME: "/data/sous" } });
        const config = await engine.buildConfig();

        expect(config.services.get("variables.resolver").scope().sousHome).toBe("/data/sous");
    });

    /** Outside a project there is no project root, and no `.sous/` paths. */
    it("should leave the project variables out without a project", async () => {
        const { engine } = engineWith({ project: null });
        const config = await engine.buildConfig();

        expect(Object.keys(config.services.get("variables.resolver").autoVariables()).sort()).toEqual([
            "sousHome",
            "sousRootPath",
            "sousVersion",
        ]);
    });

    /**
     * Setting `projectRoot` in the root `_vars` to anything but the value sous gives it is an error
     * saying sous sets it. Restating it as sous sets it (`${sousDir}/..`, which configs written
     * before it was an auto-variable hold) is accepted.
     *
     * { "_vars": { "projectRoot": "/elsewhere" } }  // ConfigError
     */
    it("should refuse projectRoot in the root _vars, saying sous sets it", async () => {
        const { engine } = engineWith({ contributors: [file("sous.config", { _vars: { projectRoot: "/elsewhere" } })] });
        const config = await engine.buildConfig();

        expect(() => config.services.get("variables.resolver").scope({ level: "root" })).toThrow(/projectRoot.*sous sets itself/);

        const restated = engineWith({ contributors: [file("sous.config", { _vars: { projectRoot: "${sousDir}/.." } })] });
        const restatedConfig = await restated.engine.buildConfig();

        expect(restatedConfig.services.get("variables.resolver").scope({ level: "root" }).projectRoot).toBeDefined();
    });

    /** The same for `_env`, and for any other auto-variable. */
    it("should refuse auto-variables in _env", async () => {
        const { engine } = engineWith({ contributors: [file("sous.config", { _env: { sousDir: "MY_DIR" } })] });

        await expect(engine.buildConfig()).rejects.toSatisfy((error) => /sousDir.*set by sous/s.test(errorText(error)));
    });

    /** ...and in every inner level. */
    it("should refuse projectRoot in compilation._vars", async () => {
        const { engine } = engineWith({
            contributors: [file("sous.config", { compilation: { _vars: { projectRoot: "/x" } } })],
        });
        const config = await engine.buildConfig();
        const resolver = config.services.get("variables.resolver");

        expect(() => resolver.scope({ level: "compilation" })).toThrow(/projectRoot.*sous sets itself/);
    });

    /** A variable source cannot override an auto-variable either. */
    it("should keep auto-variables over variable sources", async () => {
        const { engine } = engineWith({ sources: [answers] });
        const config = await engine.buildConfig();

        expect(config.services.get("variables.resolver").scope().projectRoot).toBe("/work/app");
    });
});

describe("scopes", () => {
    /**
     * auto → variable sources → _env → root _vars, later ones winning.
     */
    it("should lay sources, _env and _vars over the auto-variables in order", async () => {
        const { engine } = engineWith({
            env: { HOME: "/home/me", REGION: "eu" },
            sources: [answers],
            contributors: [
                file("sous.config", {
                    _env: { region: "REGION" },
                    _vars: { docs: "${projectRoot}/docs", out: "${docs}/out", byOwner: "${owner}" },
                }),
            ],
        });
        const config = await engine.buildConfig();
        const resolver = config.services.get("variables.resolver");
        const scope = resolver.scope();

        expect(scope).toMatchObject({ owner: "luke", region: "eu", docs: "/work/app/docs", out: "/work/app/docs/out", byOwner: "luke" });
        expect(resolver.origins()).toMatchObject({
            projectRoot: { from: "auto", value: "/work/app" },
            owner: { from: "recipe-answers", value: "luke" },
            region: { from: "_env", value: "eu" },
            docs: { from: "_vars", value: "/work/app/docs" },
        });
    });

    /** A named scope lays one recipe's own values over the root. */
    it("should lay a named scope from the variable sources over the root", async () => {
        const { engine } = engineWith({ sources: [answers] });
        const config = await engine.buildConfig();
        const resolver = config.services.get("variables.resolver");

        expect(resolver.scope({ scopeKey: "workflow/task-files" }).owner).toBe("task-files-owner");
        expect(resolver.scope({ scopeKey: "other/recipe" }).owner).toBe("luke");
    });

    /**
     * root _vars → compilation._vars → targets[]._vars → outputs[]._vars, inner values winning.
     */
    it("should resolve each of the four levels over the ones above it", async () => {
        const { engine } = engineWith({
            contributors: [
                file("sous.config", {
                    _vars: { name: "root", base: "${projectRoot}" },
                    compilation: {
                        _vars: { name: "compilation", comp: "${base}/c" },
                        targets: [
                            { _vars: { name: "t0" } },
                            {
                                _vars: { name: "t1", target: "${comp}/t1" },
                                outputs: [{ _vars: { name: "o0", output: "${target}/o0" } }, {}],
                            },
                        ],
                    },
                }),
            ],
        });
        const config = await engine.buildConfig();
        const resolver = config.services.get("variables.resolver");

        expect(resolver.scope().name).toBe("root");
        expect(resolver.scope({ level: "compilation" })).toMatchObject({ name: "compilation", comp: "/work/app/c" });
        expect(resolver.scope({ level: "target", target: 0 }).name).toBe("t0");
        expect(resolver.scope({ level: "output", target: 1, output: 0 })).toMatchObject({
            name: "o0",
            output: "/work/app/c/t1/o0",
        });
        expect(resolver.scope({ level: "output", target: 1, output: 1 }).name).toBe("t1");
        expect(resolver.origins({ level: "output", target: 1, output: 0 }).output).toEqual({
            from: "compilation.targets[1].outputs[0]._vars",
            value: "/work/app/c/t1/o0",
        });
        expect(() => resolver.scope({ level: "target" })).toThrow(/target index/);
    });

    /** Extra values are resolved as one more inner level. */
    it("should resolve extra values over the scope", async () => {
        const { engine } = engineWith();
        const config = await engine.buildConfig();
        const resolver = config.services.get("variables.resolver");

        expect(resolver.scope({ extra: { file: "${projectRoot}/x" } }).file).toBe("/work/app/x");
    });

    /** Which levels contain a config path. */
    it("should map a config path to the levels that contain it", async () => {
        const { engine } = engineWith();
        const resolver = (await engine.buildConfig()).services.get("variables.resolver");

        expect(resolver.requestAt('subscriptions."a/b".enabled')).toEqual({ level: "root" });
        expect(resolver.requestAt("compilation.includeSourceComments")).toEqual({ level: "compilation" });
        expect(resolver.requestAt("compilation.targets[2].entryPoint")).toEqual({ level: "target", target: 2 });
        expect(resolver.requestAt(["compilation", "targets", 2, "outputs", 0, "destinationDir"])).toEqual({
            level: "output",
            target: 2,
            output: 0,
        });
    });

    /** An unset `_env` variable is an error naming the project's env files. */
    it("should name the project's .env.local when an _env variable is unset", async () => {
        const { engine } = engineWith({ contributors: [file("sous.config", { _env: { token: "NOT_SET_XYZ" } })] });
        const resolver = (await engine.buildConfig()).services.get("variables.resolver");

        expect(() => resolver.scope()).toThrow(/NOT_SET_XYZ/);
        expect(() => resolver.scope()).toSatisfy(() => {
            try {
                resolver.scope();
            } catch (error) {
                return errorText(error).includes("/work/app/.sous/.env.local");
            }

            return false;
        });
    });

    /** An unresolved root `_vars` value is an error once the config is built. */
    it("should throw for an unresolved _vars value in the built config", async () => {
        const { engine } = engineWith({ contributors: [file("sous.config", { _vars: { a: "${nope}" } })] });
        const resolver = (await engine.buildConfig()).services.get("variables.resolver");

        expect(() => resolver.scope()).toThrow(/Unresolved variables in _vars/);
        expect(resolver.scope({ partial: true }).a).toBeUndefined();
    });

    /** Paths: `~` expands with the HOME sous was given. */
    it("should normalize paths with the given HOME", async () => {
        const { engine } = engineWith({ env: { HOME: "/users/x" } });
        const resolver = (await engine.buildConfig()).services.get("variables.resolver");

        expect(resolver.normalizePath("~/a/../b")).toBe("/users/x/b");
    });
});

describe("reading variables while the config is built", () => {
    /**
     * S2's example: a later file changes a variable an earlier one read, so the earlier one re-runs.
     *
     * sous.config (machineRole: laptop) → 610-browser (reads machineRole) → 700-ci (machineRole: ci)
     */
    it("should re-run a contributor when a variable it read through the builder changes", async () => {
        let runs = 0;
        const seen: Array<string | undefined> = [];
        const { engine } = engineWith({
            contributors: (sous: Sous) => [
                setter("100-sous.config", { "_vars.machineRole": "laptop" }),
                {
                    id: "610-browser",
                    contribute(config: ConfigBuilder) {
                        runs++;
                        const role = sous.services.get("variables.resolver").scopeIn(config).machineRole;

                        seen.push(role);
                        config.atPath("out.enabled").set(role === "laptop");
                    },
                },
                setter("700-ci", { "_vars.machineRole": "ci" }),
            ],
        });
        const config = await engine.buildConfig();

        expect(config.get("out.enabled")).toBe(false);
        expect(seen).toEqual(["laptop", "ci"]);
        expect(runs).toBe(2);
    });

    /** A variable no one has set yet reads as undefined for that pass, not an error. */
    it("should leave a variable unknown during a pass undefined", async () => {
        const seen: Array<string | undefined> = [];
        const { engine } = engineWith({
            env: { HOME: "/home/me" },
            contributors: (sous: Sous) => [
                {
                    id: "100-reader",
                    contribute(config: ConfigBuilder) {
                        const scope = sous.services.get("variables.resolver").scopeIn(config);

                        seen.push(scope.full);
                        config.atPath("out.full").set(scope.full ?? null);
                    },
                },
                file("200-vars", { _vars: { full: "${part}/x" }, _env: { unset: "NOT_SET" } }),
                file("300-vars", { _vars: { part: "${projectRoot}" } }),
            ],
        });
        const config = await engine.buildConfig();

        expect(seen[0]).toBeUndefined();
        expect(config.get("out.full")).toBe("/work/app/x");
    });

    /** Variable sources are read through the builder too: their entity list and what they read. */
    it("should read variable sources and their config reads through the builder", async () => {
        const source: VariableSourceEntity = {
            id: "from-config",
            description: "a value read from the config",
            variables: (ctx) => {
                const flavour = ctx.config.get<string>("out.flavour");

                return flavour === undefined ? ({} as Record<string, string>) : { flavour };
            },
        };
        const { engine } = engineWith({
            sources: [source],
            contributors: (sous: Sous) => [
                {
                    id: "100-reader",
                    contribute(config: ConfigBuilder) {
                        const flavour = sous.services.get("variables.resolver").scopeIn(config).flavour;

                        config.atPath("out.copy").set(flavour ?? null);
                    },
                },
                file("200-flavour", { out: { flavour: "mint" } }),
            ],
        });
        const config = await engine.buildConfig();

        expect(config.get("out.copy")).toBe("mint");
    });

    /** A what-if config has its own scope. */
    it("should build a scope over any built config", async () => {
        const { engine } = engineWith({ contributors: [setter("sous.config", { "_vars.a": "1" })] });
        const real = await engine.buildConfig();
        const whatIf = await engine.buildConfig({ extraContributors: [setter("zz-what-if", { "_vars.a": "2" })] });
        const resolver = real.services.get("variables.resolver");

        expect(resolver.scope().a).toBe("1");
        expect(resolver.scopeIn(whatIf).a).toBe("2");
        expect(resolver.originsIn(whatIf).a).toEqual({ from: "_vars", value: "2" });
        expect(resolver.scopeIn({ get: <T>(path: unknown) => (path === "_vars" ? ({ a: "3", b: "${nope}" } as T) : undefined) })).toMatchObject({
            a: "3",
        });
    });
});

describe("secrets", () => {
    /** The declared names come from the variable sources; the rest by the heuristic. */
    it("should hide declared and probable secrets", async () => {
        const { engine } = engineWith({
            sources: [answers],
            contributors: [file("sous.config", { _vars: { apiToken: "xyz" } })],
        });
        const config = await engine.buildConfig();
        const secrets = config.services.get("variables.secrets");
        const scope = config.services.get("variables.resolver").scope();

        expect([...secrets.declared()]).toEqual(["deployKey"]);
        expect(secrets.hide(scope)).toMatchObject({ deployKey: "(hidden)", apiToken: "(hidden)", owner: "luke" });
    });
});

describe("substitution through the service", () => {
    /** The service gives the one substitution every plugin uses. */
    it("should substitute, list references and resolve blocks", async () => {
        const resolver = (await engineWith().engine.buildConfig()).services.get("variables.resolver");

        expect(resolver.substitute("${a}/${b}", { a: "1" })).toBe("1/${b}");
        expect(() => resolver.substituteStrict("${b}", {}, "here")).toThrow(/\$\{b\} in here/);
        expect(resolver.substituteValue({ x: ["${a}"] }, { a: "1" }, "v")).toEqual({ x: ["1"] });
        expect(resolver.references("${a}${b}")).toEqual(["a", "b"]);
        expect(resolver.unresolved("${a}${b}", { a: "1" })).toEqual(["b"]);
        expect(resolver.resolveBlock({ y: "${x}/y" }, { x: "/x" }, "t")).toEqual({ x: "/x", y: "/x/y" });
    });
});

describe("the plugin", () => {
    /** Names in the reserved sous* namespace are reported, not refused (L6). */
    it("should warn about _vars names in the sous* namespace", async () => {
        const { engine, reporter } = engineWith({ contributors: [file("sous.config", { _vars: { sousCustom: "x" } })] });

        await engine.buildConfig();

        expect(reporter.at("warning").some((message) => message.includes("sousCustom"))).toBe(true);
        expect(RESERVED_NAMES_CONTRIBUTOR).toBe("variables/reserved-names");
    });

    /** `variables.names` is a singleton with no state. */
    it("should provide variables.names", async () => {
        const { engine } = engineWith();
        const config = await engine.buildConfig();

        expect(config.services.get("variables.names").sharedName("apiUrl")).toBe("SOUS_VAR_API_URL");
    });

    /** A `variable-source` entity without a variables function is refused. */
    it("should check variable-source entities", async () => {
        const { engine } = engineWith({ sources: [{ id: "bad", description: "bad" } as unknown as VariableSourceEntity] });

        await expect(engine.buildConfig()).rejects.toSatisfy((error) => /variables function/.test(errorText(error)));
    });

    /** `_vars` values must be strings. */
    it("should refuse non-string _vars values at validation", async () => {
        const { engine } = engineWith({ contributors: [file("sous.config", { _vars: { port: 80 } })] });

        await expect(engine.buildConfig()).rejects.toSatisfy((error) => /_vars.*port.*Expected a string/s.test(errorText(error)));
    });
});
