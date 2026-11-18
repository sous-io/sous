/**
 * Stand-ins for the plugins sous-plugin-compiler depends on (sous-plugin-host, sous-plugin-variables,
 * sous-plugin-liquid, sous-plugin-refs), written while those plugins were still being built. Each does only
 * what the compiler asks of it, the simple way, under the real plugin's name and version.
 */

import fs from "node:fs";
import path from "node:path";
import { globSync } from "glob";
import { Liquid } from "liquidjs";
import { minimatch } from "minimatch";
import { ConfigError, definePlugin, jsonSchema, type PluginDefinition, type SousSchema } from "@sous-io/plugin-api";
import type { HostGlobs, HostSousHome } from "@sous-io/sous-plugin-host/types";
import type { LiquidEngineOptions, LiquidEngines, LiquidExtensionContext } from "@sous-io/sous-plugin-liquid/types";
import type { HashNameEntity } from "@sous-io/sous-plugin-refs/types";
import type { ScopeRequest, VarScope, VariablesResolver, VariablesSecrets } from "@sous-io/sous-plugin-variables/types";
import "@sous-io/sous-plugin-compiler/types";
import packageJson from "../package.json" with { type: "json" };

const VERSION = packageJson.version;

/** Accepts any entity. */
const anything: SousSchema = { "~standard": { version: 1, vendor: "test", validate: (value: unknown) => ({ value }) } };

/** The static base of a glob pattern (`inferGlobBase`). */
export function staticBase(pattern: string): string {
    const staticParts: string[] = [];

    for (const part of pattern.split("/")) {
        if (/[*?{[]/.test(part)) {
            break;
        }

        staticParts.push(part);
    }

    if (staticParts.length > 0 && staticParts[staticParts.length - 1] === "") {
        staticParts.pop();
    }

    return staticParts.join("/") || "/";
}

/** `host.globs`, on the `glob` and `minimatch` packages. */
export const testGlobs: HostGlobs = {
    async match(patterns, options) {
        return testGlobs.matchSync(patterns, options);
    },
    matchSync(patterns, options) {
        const found = globSync([...(typeof patterns === "string" ? [patterns] : patterns)], {
            cwd: options.cwd,
            dot: options.dot ?? false,
            absolute: options.absolute ?? false,
            nodir: options.onlyFiles ?? true,
            ignore: [...(options.ignore ?? [])],
            posix: true,
        });

        return testGlobs.sortBytewise(found);
    },
    isMatch(file, pattern, options) {
        return (typeof pattern === "string" ? [pattern] : pattern).some((entry) => minimatch(file, entry, { dot: options?.dot ?? false, nocase: options?.nocase ?? false }));
    },
    hasGlob: (text) => /[*?{[]/.test(text),
    staticBase,
    compareBytewise: (left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)),
    sortBytewise: (items) => [...items].sort(testGlobs.compareBytewise),
    isInside(child, parent) {
        const resolved = path.resolve(child);
        const base = path.resolve(parent);

        return resolved === base || resolved.startsWith(base + path.sep);
    },
    realPathInside(file, root) {
        try {
            const real = fs.realpathSync(file);
            const realRoot = fs.realpathSync(root);

            return real === realRoot || real.startsWith(realRoot + path.sep) ? real : undefined;
        } catch {
            return file;
        }
    },
    toPosix: (file) => file.split(path.sep).join("/"),
};

/** sous-plugin-host: `host.globs` and `host.sous-home`. */
export function hostStandIn(): PluginDefinition {
    return definePlugin({
        name: "@sous-io/sous-plugin-host",
        version: VERSION,
        register(sous) {
            sous.services.add("host.globs", () => testGlobs, { lifetime: "singleton" });
            sous.services.add(
                "host.sous-home",
                (_config, ctx): HostSousHome => ({
                    paths(env = ctx.env) {
                        const root = env.SOUS_HOME ?? path.join(env.HOME ?? "/nonexistent-home", ".sous");

                        return {
                            root,
                            store: path.join(root, "cache"),
                            indexCache: path.join(root, "cache", "_indexes"),
                            repos: path.join(root, "repos"),
                            links: path.join(root, "sous.links.json"),
                            readStrategies: path.join(root, "cache", "read-strategies.json"),
                        };
                    },
                    resolve: (...segments) => path.join(ctx.env.SOUS_HOME ?? "", ...segments),
                }),
                { lifetime: "singleton" },
            );
        },
    });
}

/** Replaces every `${name}` the scope knows. */
function substitute(text: string, scope: VarScope): string {
    return text.replace(/\$\{([^}]+)\}/g, (match, name: string) => scope[name] ?? match);
}

/** Resolves a `_vars` block over an inherited scope, values referring to each other in any order. */
function resolveBlock(block: Readonly<Record<string, string>>, inherited: VarScope): Record<string, string> {
    const out: Record<string, string> = { ...inherited, ...block };

    for (let pass = 0; pass < 10; pass++) {
        let changed = false;

        for (const [name, value] of Object.entries(block)) {
            const next = substitute(out[name]!, out);

            if (next !== out[name]) {
                out[name] = next;
                changed = true;
            }
        }

        if (!changed) {
            break;
        }
    }

    return out;
}

/** sous-plugin-variables: `variables.resolver` over `_vars` at the four levels, and `variables.secrets`. */
export function variablesStandIn(options: { secrets?: string[] } = {}): PluginDefinition {
    return definePlugin({
        name: "@sous-io/sous-plugin-variables",
        version: VERSION,
        register(sous) {
            sous.entities.add("config-key", { id: "_vars", schema: jsonSchema({ type: "object" }) });
            sous.entities.add("config-key", { id: "_env", schema: jsonSchema({ type: "object" }) });
            sous.entities.add("config-key", { id: "_recipeVars", schema: jsonSchema({ type: "object" }) });
            // A singleton, as the real one is, so the compiler's contributor can use it while the
            // config is built: `scopeIn` reads through the view it is given (a builder, or a config).
            sous.services.add(
                "variables.resolver",
                (_config, ctx): VariablesResolver => {
                    const auto = {
                        projectRoot: ctx.project?.root ?? "",
                        sousDir: ctx.project?.sousDir ?? "",
                        sousConfigPath: ctx.project?.configPath ?? "",
                        sousConfDir: ctx.project?.confDir ?? "",
                        sousHome: ctx.env.SOUS_HOME ?? "",
                        sousRootPath: "/sous-root",
                        sousVersion: VERSION,
                    };
                    const block = (value: unknown) => (value && typeof value === "object" ? (value as Record<string, string>) : {});
                    const scopeOver = (view: { get(path: (string | number)[] | string): unknown }, request: ScopeRequest = {}): VarScope => {
                        const config = view;
                        let out: VarScope = resolveBlock(block(config.get("_vars")), auto);
                        const level = request.level ?? "root";

                        // Stand-in for a recipe's own variables: `_recipeVars` maps a scope key to a block.
                        if (request.scopeKey !== undefined) {
                            out = resolveBlock(block(block(config.get("_recipeVars"))[request.scopeKey]), out);
                        }

                        if (level !== "root") {
                            out = resolveBlock(block(config.get(["compilation", "_vars"])), out);
                        }

                        if ((level === "target" || level === "output") && request.target !== undefined) {
                            out = resolveBlock(block(config.get(["compilation", "targets", request.target, "_vars"])), out);
                        }

                        if (level === "output" && request.target !== undefined && request.output !== undefined) {
                            out = resolveBlock(block(config.get(["compilation", "targets", request.target, "outputs", request.output, "_vars"])), out);
                        }

                        return { ...out, ...(request.extra ?? {}) };
                    };
                    type View = { get(path: (string | number)[] | string): unknown };
                    const viewOf = (config: unknown): View => {
                        const builder = config as { atPath?: (path: unknown) => { get(): unknown } };

                        return typeof builder.atPath === "function" ? { get: (at) => builder.atPath!(at).get() } : (config as View);
                    };
                    const scope = (request: ScopeRequest = {}): VarScope => scopeOver(viewOf(sous.engine.config), request);
                    const resolver: VariablesResolver = {
                        substitute,
                        substituteStrict(text, inScope, context) {
                            const unknown = resolver.unresolved(text, inScope);

                            if (unknown.length > 0) {
                                throw new ConfigError(`${context}: unknown variable${unknown.length === 1 ? "" : "s"} ${unknown.map((name) => `\${${name}}`).join(", ")}`);
                            }

                            return substitute(text, inScope);
                        },
                        substituteValue: (value) => value,
                        references: (text) => [...text.matchAll(/\$\{([^}]+)\}/g)].map((match) => match[1]!),
                        unresolved: (text, inScope = {}) => resolver.references(text).filter((name) => inScope[name] === undefined),
                        normalizePath(value) {
                            const home = ctx.env.HOME ?? "/nonexistent-home";
                            const expanded = value === "~" ? home : value.startsWith("~/") ? path.join(home, value.slice(2)) : value;

                            return path.normalize(expanded);
                        },
                        resolveBlock: (b, inherited) => resolveBlock(b, inherited),
                        autoVariables: () => auto,
                        isAutoVariable: (name): name is keyof typeof auto => name in auto,
                        scope,
                        scopeIn: (config, request) => scopeOver(viewOf(config), request),
                        origins: () => ({}),
                        originsIn: () => ({}),
                        requestAt: () => ({}),
                    };

                    return resolver;
                },
                { lifetime: "singleton" },
            );
            sous.services.add("variables.secrets", () => testSecrets(options.secrets ?? []), { lifetime: "config" });
        },
    });
}

/** A small version of sous-plugin-variables' secret heuristics: a secret-sounding name, or a known token format. */
export function testSecrets(declaredNames: readonly string[] = []): VariablesSecrets {
    const hasSecretName = (name: string) => /(token|secrets?|passw(?:or)?d|passphrase|credentials?|api_?key|private_?key|access_?key)$/i.test(name.replace(/[^A-Za-z0-9]/g, ""));
    const hasSecretValue = (value: string) => /\bgh[pousr]_[A-Za-z0-9]{36,}|\bglpat-|\bsk-[A-Za-z0-9_-]{20,}|^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i.test(value);

    return {
        hiddenValue: "(hidden)",
        declared: () => new Set(declaredNames),
        isSecret(name, value, declared = new Set(declaredNames)) {
            if (typeof value !== "string") {
                return false;
            }

            if (declared.has(name)) {
                return value.length > 0;
            }

            return value.length > 0 && (hasSecretName(name) || hasSecretValue(value));
        },
        hasSecretName,
        hasSecretValue,
        hide: (scope, declared) => Object.fromEntries(Object.entries(scope).map(([name, value]) => [name, testSecrets(declaredNames).isSecret(name, value, declared) ? "(hidden)" : value])),
    };
}

/** sous-plugin-liquid: `liquid.engine`, registering every `liquid-tag` and `liquid-filter` entity. */
export function liquidStandIn(): PluginDefinition {
    return definePlugin({
        name: "@sous-io/sous-plugin-liquid",
        version: VERSION,
        register(sous) {
            sous.entities.define("liquid-tag", anything);
            sous.entities.define("liquid-filter", anything);
            sous.services.add(
                "liquid.engine",
                (_config, ctx): LiquidEngines => ({
                    create(options: LiquidEngineOptions = {}) {
                        const purpose = options.purpose ?? "template";
                        const engine = new Liquid({
                            ...(options.liquid ?? {}),
                            ...(options.fs ? { fs: options.fs } : {}),
                            ...(options.root ? { root: [...(typeof options.root === "string" ? [options.root] : options.root)] } : {}),
                        });
                        const extension: LiquidExtensionContext = {
                            project: ctx.project,
                            env: ctx.env,
                            services: ctx.services,
                            entities: ctx.entities,
                            purpose,
                            secretNames: new Set(options.secretNames ?? []),
                            data: options.data ?? {},
                        };

                        for (const tag of ctx.entities.list("liquid-tag")) {
                            if (tag.purposes ? tag.purposes.includes(purpose) : purpose !== "config-expression") {
                                engine.registerTag(tag.id, tag.tag(extension));
                            }
                        }

                        for (const filter of ctx.entities.list("liquid-filter")) {
                            if (!filter.purposes || filter.purposes.includes(purpose)) {
                                engine.registerFilter(filter.id, filter.filter(extension));
                            }
                        }

                        return engine;
                    },
                    available: () => ({ tags: [], filters: [] }),
                }),
                { lifetime: "config" },
            );
        },
    });
}

/** sous-plugin-refs: the `hash-name` kind and `#project`, plus any `#` names a test adds. */
export function refsStandIn(extra: HashNameEntity[] = []): PluginDefinition {
    return definePlugin({
        name: "@sous-io/sous-plugin-refs",
        version: VERSION,
        register(sous) {
            sous.entities.define("hash-name", anything);
            if (!extra.some((entity) => entity.id === "project")) sous.entities.add("hash-name", {
                id: "project",
                description: "the project's root directory.",
                bases: (ctx) => (ctx.project ? [ctx.project.root] : []),
            });

            for (const entity of extra) {
                sous.entities.add("hash-name", entity);
            }
        },
    });
}
