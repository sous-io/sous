/**
 * Stand-ins for the plugins plugin-compiler depends on (plugin-host, plugin-variables,
 * plugin-liquid, plugin-refs), written while those plugins were still being built. Each does only
 * what the compiler asks of it, the simple way, under the real plugin's name and version.
 */

import fs from "node:fs";
import path from "node:path";
import { globSync } from "glob";
import { Liquid } from "liquidjs";
import { minimatch } from "minimatch";
import { ConfigError, definePlugin, jsonSchema, type PluginDefinition, type SousSchema } from "@sous-io/plugin-api";
import type { HostGlobs, HostSousHome } from "@sous-io/plugin-host/types";
import type { LiquidEngineOptions, LiquidEngines, LiquidExtensionContext } from "@sous-io/plugin-liquid/types";
import type { HashNameEntity } from "@sous-io/plugin-refs/types";
import type { ScopeRequest, VarScope, VariablesResolver, VariablesSecrets } from "@sous-io/plugin-variables/types";
import "@sous-io/plugin-compiler/types";

const VERSION = "0.2.34";

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

/** plugin-host: `host.globs` and `host.sous-home`. */
export function hostStandIn(): PluginDefinition {
    return definePlugin({
        name: "@sous-io/plugin-host",
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

/** plugin-variables: `variables.resolver` over `_vars` at the four levels, and `variables.secrets`. */
export function variablesStandIn(options: { secrets?: string[] } = {}): PluginDefinition {
    return definePlugin({
        name: "@sous-io/plugin-variables",
        version: VERSION,
        register(sous) {
            sous.entities.add("config-key", { id: "_vars", schema: jsonSchema({ type: "object" }) });
            sous.entities.add("config-key", { id: "_env", schema: jsonSchema({ type: "object" }) });
            sous.services.add(
                "variables.resolver",
                (config, ctx): VariablesResolver => {
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
                    const scope = (request: ScopeRequest = {}): VarScope => {
                        let out: VarScope = resolveBlock(block(config.get("_vars")), auto);
                        const level = request.level ?? "root";

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
                        scopeIn: (_config, request) => scope(request),
                        origins: () => ({}),
                        originsIn: () => ({}),
                        requestAt: () => ({}),
                    };

                    return resolver;
                },
                { lifetime: "config" },
            );
            sous.services.add("variables.secrets", () => testSecrets(options.secrets ?? []), { lifetime: "config" });
        },
    });
}

/** A small version of plugin-variables' secret heuristics: a secret-sounding name, or a known token format. */
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

/** plugin-liquid: `liquid.engine`, registering every `liquid-tag` and `liquid-filter` entity. */
export function liquidStandIn(): PluginDefinition {
    return definePlugin({
        name: "@sous-io/plugin-liquid",
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

/** plugin-refs: the `hash-name` kind and `#project`, plus any `#` names a test adds. */
export function refsStandIn(extra: HashNameEntity[] = []): PluginDefinition {
    return definePlugin({
        name: "@sous-io/plugin-refs",
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
