/**
 * Stand-ins part A's specs share: a built config over plain data, a service reader over a map, an
 * in-memory `confd.managed`, and a handler context. The real plugins they stand in for are written
 * by other agents at the same time.
 */

import {
    BufferedReporter,
    IntentOutputs,
    NotFoundError,
    nonInteractivePrompter,
    type BuiltConfig,
    type ConfigLayer,
    type Context,
    type DocumentNode,
    type EntityReader,
    type JsonObject,
    type Prompter,
    type ServiceReader,
} from "@sous-io/plugin-api";
import type { ConfdManaged } from "@sous-io/plugin-confd/types";
import type { Lockfile } from "@sous-io/plugin-formats/types";
import type { NamedRef, RefsFormat, RefsResolver, SousRef } from "@sous-io/plugin-refs/types";
import { vi } from "vitest";
import type { LockDiff, RecipesLock } from "../../src/types.js";
import "../../src/types.js";

/** Reads a value at a dotted or segmented path. */
function at(value: unknown, path: string | readonly (string | number)[]): unknown {
    const segments = typeof path === "string" ? path.split(".") : path;
    let current: unknown = value;

    for (const segment of segments) {
        if (typeof current !== "object" || current === null) {
            return undefined;
        }

        current = (current as Record<string | number, unknown>)[segment];
    }

    return current;
}

/** An entity reader over plain lists. */
export function entityReader(entities: Record<string, Array<{ id: string }>> = {}): EntityReader {
    return {
        get: ((kind: string, id: string) => entities[kind]?.find((entry) => entry.id === id)) as EntityReader["get"],
        list: ((kind: string) => [...(entities[kind] ?? [])]) as EntityReader["list"],
        has: (kind, id) => entities[kind]?.some((entry) => entry.id === id) ?? false,
        describe: (() => []) as EntityReader["describe"],
        kinds: () => Object.keys(entities),
    };
}

/** A service reader over a map. */
export function serviceReader(services: Record<string, unknown>): ServiceReader {
    return {
        get: ((name: string) => {
            if (!(name in services)) {
                throw new NotFoundError("service", name);
            }

            return services[name];
        }) as ServiceReader["get"],
        has: (name) => name in services,
    };
}

/** A built config over plain data; `layers` maps a dotted path to the contributors that set it. */
export function builtConfig(
    data: JsonObject,
    options: { services?: Record<string, unknown>; entities?: Record<string, Array<{ id: string }>>; layers?: Record<string, string[]> } = {},
): BuiltConfig {
    const services = serviceReader(options.services ?? {});

    return {
        get: ((path: string | readonly (string | number)[]) => at(data, path)) as BuiltConfig["get"],
        has: (path) => at(data, path as string) !== undefined,
        value: () => data,
        buildNumber: 1,
        whatIf: false,
        passes: 1,
        hash: "test",
        entities: entityReader(options.entities),
        services,
        layers: (path) => {
            const key = Array.isArray(path) ? path.join(".") : String(path);

            return (options.layers?.[key] ?? []).map(
                (contributor): ConfigLayer => ({ contributor, plugin: "test", patch: { op: "setKey", path: "", key: "x", value: null } as never, helpers: [], applyOrder: 0, actualApplyOrder: 0 }),
            );
        },
        contributions: () => [],
    };
}

/** An in-memory `confd.managed`: each file is a plain object. */
export function memoryManaged(files: Record<string, JsonObject> = {}): ConfdManaged & { files: Record<string, JsonObject> } {
    const node = (root: JsonObject, segments: string[]): DocumentNode => {
        const parentOf = (create: boolean): Record<string, unknown> | undefined => {
            let current: Record<string, unknown> = root;

            for (const segment of segments.slice(0, -1)) {
                if (typeof current[segment] !== "object" || current[segment] === null) {
                    if (!create) {
                        return undefined;
                    }

                    current[segment] = {};
                }

                current = current[segment] as Record<string, unknown>;
            }

            return current;
        };

        return {
            path: segments,
            pathString: segments.join("."),
            atPath: (more: string | readonly (string | number)[]) => node(root, [...segments, ...(Array.isArray(more) ? more.map(String) : String(more).split("."))]),
            set: (value: unknown) => {
                parentOf(true)![segments[segments.length - 1]!] = structuredClone(value);
            },
            delete: () => {
                const parent = parentOf(false);

                if (parent !== undefined) {
                    delete parent[segments[segments.length - 1]!];
                }
            },
            get: () => at(root, segments),
        } as unknown as DocumentNode;
    };

    return {
        files,
        path: (name) => `/project/.sous/conf.d/${name}`,
        read: async (name) => (files[name] === undefined ? undefined : structuredClone(files[name])),
        edit: async (name, edit, options) => {
            const before = JSON.stringify(files[name] ?? null);
            const root = structuredClone(files[name] ?? {}) as JsonObject;

            edit(node(root, []));

            const changed = JSON.stringify(root) !== before;

            if (options?.dryRun !== true) {
                files[name] = root;
            }

            return { file: `/project/.sous/conf.d/${name}`, created: before === "null", changed, patches: { name: "edit", path: "", patches: [] } as never, text: JSON.stringify(root) };
        },
        set: async () => {
            throw new Error("not used");
        },
        delete: async () => {
            throw new Error("not used");
        },
        header: () => "",
    };
}

/** A lock service over an in-memory lockfile. */
export function memoryLock(lockfile: Lockfile): RecipesLock & { current: Lockfile } {
    const diff = (before: Lockfile, after: Lockfile): LockDiff => {
        const added = Object.keys(after.recipes)
            .filter((key) => !before.recipes[key])
            .map((key) => ({ key, to: after.recipes[key]!.version }));
        const removed = Object.keys(before.recipes)
            .filter((key) => !after.recipes[key])
            .map((key) => ({ key, from: before.recipes[key]!.version }));
        const updated = Object.keys(after.recipes)
            .filter((key) => before.recipes[key] && before.recipes[key]!.version !== after.recipes[key]!.version)
            .map((key) => ({ key, from: before.recipes[key]!.version, to: after.recipes[key]!.version }));

        return { added, removed, updated, reposAdded: [], reposRemoved: [], unchanged: added.length + removed.length + updated.length === 0 };
    };
    const lock = {
        current: lockfile,
        path: () => "/project/.sous/sous.lock.json",
        read: () => lock.current,
        write: async (next: Lockfile, options?: { dryRun?: boolean }) => {
            const changes = diff(lock.current, next);

            if (options?.dryRun !== true) {
                lock.current = next;
            }

            return changes;
        },
        diff,
        fromResolved: () => lockfile,
        restore: async () => ({ restored: [], alreadyPresent: [], failed: [] }),
        get: (key: string) => lock.current.recipes[key],
    };

    return lock;
}

/**
 * A ref parser that reads the short forms: `namespace`, `namespace/recipe@range`, `repo:...`.
 * One word reads both as a namespace and as a recipe name.
 */
export function shortRefs(): { resolver: RefsResolver; format: RefsFormat } {
    const read = (input: string): SousRef[] => {
        let text = input.trim();
        let repo: string | undefined;
        const colon = text.indexOf(":");

        if (colon !== -1 && !text.includes("://")) {
            repo = text.slice(0, colon);
            text = text.slice(colon + 1);
        }

        const [body, range] = text.split("@") as [string, string | undefined];
        const repoRef = repo === undefined ? undefined : { kind: "repo" as const, name: repo };
        const slash = body.indexOf("/");

        if (slash !== -1) {
            return [
                {
                    kind: "recipe",
                    name: body.slice(slash + 1),
                    namespace: { kind: "namespace", name: body.slice(0, slash), ...(repoRef === undefined ? {} : { repo: repoRef }) },
                    ...(range === undefined ? {} : { range }),
                },
            ];
        }

        return [
            { kind: "namespace", name: body, ...(repoRef === undefined ? {} : { repo: repoRef }) },
            { kind: "recipe", name: body, ...(repoRef === undefined ? {} : { repo: repoRef }), ...(range === undefined ? {} : { range }) },
            ...(repo === undefined ? [{ kind: "repo" as const, name: body }] : []),
        ];
    };
    const key = (ref: SousRef): string => (ref.kind === "recipe" ? (ref.namespace ? `${ref.namespace.name}/${ref.name}` : ref.name) : (ref as { name: string }).name);

    const resolver = {
        parse: (input: string) => ({ input, refs: read(input), dropped: [], warnings: [], usedLookup: false }),
    } as unknown as RefsResolver;
    const format = {
        key,
        format: (ref: SousRef) => {
            const parts = ref.kind === "recipe" ? ref.namespace?.repo : (ref as NamedRef).kind === "namespace" ? (ref as { repo?: { name?: string } }).repo : undefined;

            return `${parts?.name === undefined ? "" : `${parts.name}:`}${key(ref)}${ref.kind === "recipe" && ref.range ? `@${ref.range}` : ""}`;
        },
        namespaceOfKey: (stored: string) => stored.split("/")[0]!,
        parseNamedRef: (input: string) => read(input).find((ref) => ref.kind === (input.includes("/") ? "recipe" : "namespace")) as NamedRef,
        recipeRef: (namespace: string, name: string, options: { repo?: string; range?: string } = {}) => ({
            kind: "recipe",
            name,
            namespace: { kind: "namespace", name: namespace, ...(options.repo === undefined ? {} : { repo: { kind: "repo", name: options.repo } }) },
            ...(options.range === undefined ? {} : { range: options.range }),
        }),
        partsOf: (ref: SousRef) => ({ ...(ref.kind === "namespace" && ref.repo ? { repo: ref.repo } : {}) }),
    } as unknown as RefsFormat;

    return { resolver, format };
}

/** A handler context over a config, with a buffered reporter and a prompter. */
export function context(config: BuiltConfig, options: { prompter?: Prompter; intents?: string[]; next?: BuiltConfig } = {}): Context & { reporter: BufferedReporter; run: ReturnType<typeof vi.fn>; configChanged: ReturnType<typeof vi.fn> } {
    const intents = new Set(options.intents ?? []);
    const ctx = {
        plugin: "@sous-io/plugin-recipes",
        config,
        entities: config.entities,
        services: config.services,
        reporter: new BufferedReporter(),
        prompter: options.prompter ?? nonInteractivePrompter,
        project: { root: "/project", sousDir: "/project/.sous", configPath: undefined, confDir: "/project/.sous/conf.d" },
        env: {},
        globals: {},
        chain: { id: 1, intent: "test", parallel: false },
        engine: {
            intents: { list: () => [], get: (name: string) => (intents.has(name) ? ({ definition: { intent: name }, plugin: "x" } as never) : undefined) },
            buildConfig: async () => options.next ?? config,
        } as unknown as Context["engine"],
        options: () => undefined,
        run: vi.fn(async (intent: string) => IntentOutputs.of({ ran: intent })),
        emit: vi.fn(async () => ({}) as never),
        configChanged: vi.fn(),
        cwd: "/project",
        // As core does: the rest of the chain reads the newer build.
        refreshConfig: vi.fn(async () => {
            const next = options.next ?? config;

            Object.assign(ctx, { config: next, entities: next.entities, services: next.services });

            return next;
        }),
    };

    return ctx as unknown as Context & { reporter: BufferedReporter; run: ReturnType<typeof vi.fn>; configChanged: ReturnType<typeof vi.fn> };
}
