import { getAtPath, isPatch, parsePath, pathsOverlap } from "@sous-io/documents";
import type {
    BuiltConfig,
    ConfigLayer,
    Contribution,
    JsonObject,
    JsonValue,
    Patch,
    PatchSet,
    PathInput,
    ServiceReader,
} from "@sous-io/plugin-api";
import type { EntitySnapshot } from "../entities/entity-registry.js";
import { type Limits, resolveLimits } from "../limits.js";
import { CORE_PLUGIN } from "../util/names.js";
import type { ActivePlugin, ContributorRecord } from "./build.js";
import { primitiveTarget, WHAT_IF_PLUGIN } from "./build.js";

/** What a built config is made of. */
export interface BuiltConfigData {
    readonly buildNumber: number;
    readonly whatIf: boolean;
    /** The checked config, deep-frozen. */
    readonly config: Readonly<JsonObject>;
    readonly entities: EntitySnapshot;
    readonly records: readonly ContributorRecord[];
    readonly active: ReadonlyMap<string, ActivePlugin>;
    readonly passes: number;
    readonly hash: string;
}

/**
 * A config the engine built: read-only values, with the entities and the `config`-lifetime
 * services that belong to it, and the record of who changed what.
 */
export class BuiltConfigImpl implements BuiltConfig {
    readonly buildNumber: number;
    readonly whatIf: boolean;
    readonly passes: number;
    readonly hash: string;
    readonly entities: EntitySnapshot;
    /** Set by the engine right after construction. */
    services!: ServiceReader;

    private readonly data: BuiltConfigData;
    private limitsCache: Limits | undefined;

    constructor(data: BuiltConfigData, private readonly baseLimits: Readonly<Limits>) {
        this.data = data;
        this.buildNumber = data.buildNumber;
        this.whatIf = data.whatIf;
        this.passes = data.passes;
        this.hash = data.hash;
        this.entities = data.entities;
    }

    /** Whether a plugin is active in this config. Core always is. */
    readonly isActive = (plugin: string): boolean =>
        plugin === CORE_PLUGIN || plugin === WHAT_IF_PLUGIN || this.data.active.has(plugin);

    /** The active plugins, by name. */
    get active(): ReadonlyMap<string, ActivePlugin> {
        return this.data.active;
    }

    /** The loop-detection limits this config sets. */
    get limits(): Limits {
        this.limitsCache ??= resolveLimits(this.baseLimits, this.data.config.limits as JsonObject | undefined);

        return this.limitsCache;
    }

    /** What `services.replace` picks. */
    get servicePicks(): Readonly<Record<string, string>> {
        return pickTable(this.data.config.services);
    }

    /** What `intents.replace` picks. */
    get intentPicks(): Readonly<Record<string, string>> {
        return pickTable(this.data.config.intents);
    }

    get<T = JsonValue>(path: PathInput): T | undefined {
        return getAtPath(this.data.config, parsePath(path)) as T | undefined;
    }

    has(path: PathInput): boolean {
        return this.get(path) !== undefined;
    }

    value(): Readonly<JsonObject> {
        return this.data.config;
    }

    layers(path: PathInput): ConfigLayer[] {
        const target = parsePath(path);
        const layers: ConfigLayer[] = [];

        for (const record of this.data.records) {
            walk(record.patchSet, [], (patch, helpers) => {
                if (pathsOverlap(primitiveTarget(patch), target)) {
                    layers.push({ contributor: record.entry.id, plugin: record.entry.plugin, patch, helpers });
                }
            });
        }

        return layers;
    }

    contributions(): Contribution[] {
        return this.data.records.map((record) => ({
            contributor: record.entry.id,
            plugin: record.entry.plugin,
            stage: record.stage,
            patches: record.patchSet,
            runs: record.runs,
        }));
    }
}

function walk(set: PatchSet, helpers: string[], visit: (patch: Patch, helpers: string[]) => void): void {
    for (const item of set.patches) {
        if (isPatch(item)) {
            visit(item, helpers);
        } else {
            walk(item, [...helpers, item.name], visit);
        }
    }
}

function pickTable(section: JsonValue | undefined): Readonly<Record<string, string>> {
    const replace = (section as JsonObject | undefined)?.replace;

    if (replace === null || typeof replace !== "object" || Array.isArray(replace)) {
        return {};
    }

    return Object.fromEntries(Object.entries(replace).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}
