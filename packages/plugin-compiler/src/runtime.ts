/**
 * What the compiler's services and intents read from one built config: the compilation settings,
 * the root scope, the aliases and views, the state file and the protected directories. Worked out
 * once per config, on first use.
 */

import path from "node:path";
import type { BuiltConfig, EntityReader, Environment, ProjectInfo, ServiceContext, ServiceReader } from "@sous-io/plugin-api";
import type { HostGlobs, HostSousHome } from "@sous-io/plugin-host/types";
import type { HashNameContext } from "@sous-io/plugin-refs/types";
import type { VarScope, VariablesResolver } from "@sous-io/plugin-variables/types";
import { buildAliasMap, type AliasMap } from "./aliases.js";
import type { IncludeEnvironment, ViewMap } from "./includes.js";
import { DEFAULT_STATE_FILE } from "./schema.js";
import { StateStore } from "./state.js";
import type { AliasesSettings, CompilationSettings, NamespaceResolver } from "./types.js";

/** What the runtime is made from: a service context, or an intent's context. */
export interface RuntimeSource {
    readonly plugin: string;
    readonly config: BuiltConfig;
    readonly services: ServiceReader;
    readonly entities: EntityReader;
    readonly project: ProjectInfo | undefined;
    readonly env: Environment;
}

/** The compilation settings, with every default filled in even when the config was not checked. */
export function compilationSettings(config: Pick<BuiltConfig, "get">): CompilationSettings {
    const value = (config.get("compilation") ?? {}) as Partial<CompilationSettings>;

    return {
        ...value,
        includeSourceComments: value.includeSourceComments ?? false,
        overwriteUntracked: value.overwriteUntracked ?? true,
        stateFile: value.stateFile ?? DEFAULT_STATE_FILE,
        targets: value.targets ?? [],
    };
}

/** The runtime of one config. */
export class CompilerRuntime {
    private cachedScope: VarScope | undefined;
    private cachedNames: { aliases: AliasMap; views: ViewMap } | undefined;
    /** Every file the latest full compile with this config would write, for prune. */
    produced: ReadonlySet<string> | undefined;

    constructor(
        readonly source: RuntimeSource,
        private readonly stores: Map<string, StateStore>,
    ) {}

    /** The service context transforms and `#` names are given. */
    get serviceContext(): ServiceContext {
        const { plugin, config, services, entities, project, env } = this.source;

        return { plugin, config, services, entities, project, env };
    }

    settings(): CompilationSettings {
        return compilationSettings(this.source.config);
    }

    /**
     * `variables.resolver`, with its scopes read from this config: the resolver may be a
     * singleton, and this config need not be the latest.
     */
    resolver(): VariablesResolver {
        const resolver = this.source.services.get("variables.resolver");
        const config = this.source.config;

        return new Proxy(resolver, {
            get(target, key) {
                if (key === "scope") {
                    return (request?: Parameters<VariablesResolver["scope"]>[0]) => target.scopeIn(config, request);
                }

                const value: unknown = Reflect.get(target, key, target);

                return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
            },
        });
    }

    globs(): HostGlobs {
        return this.source.services.get("host.globs");
    }

    /** Where relative paths resolve: the project root. */
    projectRoot(): string {
        return this.source.project?.root ?? path.resolve("/");
    }

    rootScope(): VarScope {
        this.cachedScope ??= this.resolver().scope();

        return this.cachedScope;
    }

    namespaceResolver(): NamespaceResolver | undefined {
        return this.source.services.has("compiler.namespace-resolver") ? this.source.services.get("compiler.namespace-resolver") : undefined;
    }

    /** The `#` names: those standing for directories become aliases, those listing files views. */
    private hashNames(): { aliases: AliasMap; views: ViewMap } {
        if (this.cachedNames) {
            return this.cachedNames;
        }

        const context: HashNameContext = { ...this.serviceContext, scope: this.rootScope() };
        const aliases: AliasMap = {};
        const views: ViewMap = {};

        for (const entity of this.source.entities.list("hash-name")) {
            const name = `#${entity.id}`;

            if (entity.view) {
                views[name] = entity.view(context);
            } else {
                aliases[name] = (entity.bases?.(context) ?? []).map((base) => path.resolve(this.projectRoot(), base));
            }
        }

        this.cachedNames = { aliases, views };

        return this.cachedNames;
    }

    /** Every alias: the `#` names that stand for directories, then `_aliases` over them. */
    aliases(): AliasMap {
        const resolver = this.resolver();
        const scope = this.rootScope();
        const user = this.source.config.get("_aliases") as AliasesSettings | undefined;

        return buildAliasMap({
            builtIns: this.hashNames().aliases,
            userAliases: [user],
            substitute: (text) => path.resolve(this.projectRoot(), resolver.normalizePath(resolver.substitute(text, scope))),
        });
    }

    views(): ViewMap {
        return this.hashNames().views;
    }

    includeEnvironment(): IncludeEnvironment {
        const resolver = this.resolver();
        const home = this.source.env.HOME;

        return {
            aliases: this.aliases(),
            views: this.views(),
            globs: this.globs(),
            namespaceResolver: this.namespaceResolver(),
            substitute: (text, scope) => resolver.substitute(text, scope),
            ...(home ? { home } : {}),
        };
    }

    /** Where the state file is: `_vars.stateFilePath` (as before the refactor), else `compilation.stateFile`. */
    stateFile(): string {
        const scope = this.rootScope();
        const resolver = this.resolver();
        const written = scope.stateFilePath ?? this.settings().stateFile ?? DEFAULT_STATE_FILE;

        return path.resolve(this.projectRoot(), resolver.normalizePath(resolver.substitute(written, scope)));
    }

    /** The state of the state file, shared by everything that reads or writes it in this engine. */
    store(): StateStore {
        const file = this.stateFile();
        let store = this.stores.get(file);

        if (!store) {
            store = new StateStore(file);
            this.stores.set(file, store);
        }

        return store;
    }

    /**
     * Directories nothing is ever removed from, whatever the state file says: the project's linked
     * checkouts, the machine-wide ones, and the recipe store.
     */
    protectedRoots(): string[] {
        const roots: string[] = [];

        if (this.source.project) {
            roots.push(path.join(this.source.project.sousDir, "repos"));
        }

        if (this.source.services.has("host.sous-home")) {
            const home = (this.source.services.get("host.sous-home") as HostSousHome).paths(this.source.env);

            roots.push(home.repos, home.store);
        }

        return roots;
    }
}

/** Keeps one runtime per built config. */
export class RuntimeCache {
    private readonly runtimes = new WeakMap<BuiltConfig, CompilerRuntime>();
    private readonly stores = new Map<string, StateStore>();

    for(source: RuntimeSource): CompilerRuntime {
        let runtime = this.runtimes.get(source.config);

        if (!runtime) {
            runtime = new CompilerRuntime(source, this.stores);
            this.runtimes.set(source.config, runtime);
        }

        return runtime;
    }
}
