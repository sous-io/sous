import { applyPatches, flattenPatchSet, formatPath, parsePath, pathsOverlap, type PatchProblem } from "@sous-io/documents";
import {
    ConfigError,
    type ContributorDefinition,
    type Environment,
    type JsonObject,
    type JsonValue,
    type LogLevel,
    LoopError,
    type Patch,
    type PatchSet,
    type PathSegment,
    PluginError,
    type ProjectInfo,
} from "@sous-io/plugin-api";
import type { EntityRegistry, StoredEntity } from "../entities/entity-registry.js";
import { EntitySnapshot } from "../entities/entity-registry.js";
import type { Limits } from "../limits.js";
import type { PluginRecord } from "../plugins/plugin-registry.js";
import type { Timer } from "../timing/timer.js";
import { CORE_PLUGIN } from "../util/names.js";
import { ConfigBuilderImpl } from "./builder.js";
import { type ContributorEntry, toEntry } from "./contributor-registry.js";
import { sortContributors } from "./order.js";
import { changedReads, firstChangedRead, type Read, type ReadChange, type View } from "./reads.js";

/** The plugin name the extra contributors of a "what if" build are recorded under. */
export const WHAT_IF_PLUGIN = "(what if)";

/** One contributor's latest run in a build. */
export interface ContributorRecord {
    readonly entry: ContributorEntry;
    readonly stage: number;
    readonly patchSet: PatchSet;
    readonly primitives: readonly Patch[];
    readonly entities: readonly StoredEntity[];
    readonly reads: readonly Read[];
    readonly runs: number;
    /** The build version at which its reads were last known to be current. */
    verifiedAt: number;
}

/** An activated plugin in one build, with the stage it was activated in. */
export interface ActivePlugin {
    readonly record: PluginRecord;
    /** Every stage its contributors declare is shifted by this. */
    readonly stageShift: number;
}

/** What a build needs from the engine. */
export interface BuildHost {
    readonly entityRegistry: EntityRegistry;
    readonly timer: Timer;
    readonly project: ProjectInfo | undefined;
    readonly env: Environment;
    /** The limits as the defaults and the previous config set them. */
    readonly baseLimits: Limits;
    /** Every contributor of the given plugins. */
    contributorsOf(isActive: (plugin: string) => boolean): ContributorEntry[];
    /** Loads (and registers) a built-in plugin, or returns it when loaded already. */
    loadBuiltIns(): Promise<PluginRecord[]>;
    /** Finds and loads a plugin by specifier, asking the locators of the view first. */
    loadSpecifier(specifier: string, view: View): Promise<PluginRecord | undefined>;
    /** A loaded plugin, by name. */
    plugin(name: string): PluginRecord | undefined;
    /** Reports through the engine's reporter. */
    log(level: LogLevel, message: string): void;
    /** Called around each contributor run, so the engine can warn about direct entity reads. */
    enterContributor(id: string): void;
    leaveContributor(): void;
    /** Resolves limits from the config's `limits` key. */
    limitsFrom(config: JsonValue): Limits;
}

/** What a finished build hands back. */
export interface BuildOutcome {
    /** The config, before validation. */
    readonly config: JsonObject;
    readonly entities: EntitySnapshot;
    /** Every contributor's latest run, in the order their patches apply. */
    readonly records: readonly ContributorRecord[];
    readonly active: ReadonlyMap<string, ActivePlugin>;
    /** Passes in which something ran, over every stage. */
    readonly passes: number;
    /** Patches that could not be applied to the final config. */
    readonly problems: ReadonlyArray<PatchProblem & { contributor: string }>;
}

interface Trigger {
    readonly stage: number;
    readonly pass: number;
    readonly contributor: string;
    readonly change: ReadChange | undefined;
}

/**
 * One config build: stages from the lowest, and in each stage, passes until nothing
 * anyone read has changed and no plugin was loaded or removed.
 *
 * Within a pass, contributors run in sorted order; each one runs when it is new or when something it
 * read would now read differently, and sees every other contributor's latest patches, applied from
 * an empty config in the sorted order: earlier stages first, and within a stage the order of name,
 * `before` and `after`. A contributor that re-runs keeps its place, so the order is stable and the
 * build settles.
 */
export class ConfigBuild {
    private readonly records = new Map<string, ContributorRecord>();
    private orderCache: { version: number; contributors: number; ids: string[] } | undefined;
    private readonly active = new Map<string, ActivePlugin>();
    private readonly extras: ContributorEntry[];
    private readonly pending = new Set<string>();
    private readonly triggers: Trigger[] = [];
    private readonly loggedFinished = new Set<string>();
    private version = 0;
    private passes = 0;
    private currentStage = 0;
    private registeredCache: { version: number; entities: StoredEntity[] } | undefined;
    private cycleWarned = new Set<string>();

    constructor(
        private readonly host: BuildHost,
        extraContributors: readonly ContributorDefinition[] = [],
    ) {
        this.extras = extraContributors.map((definition) => toEntry(definition, WHAT_IF_PLUGIN, {}, true));
    }

    /** Whether a plugin is active in this build. */
    readonly isActive = (plugin: string): boolean =>
        plugin === CORE_PLUGIN || plugin === WHAT_IF_PLUGIN || this.active.has(plugin);

    /** Runs the build. */
    async run(): Promise<BuildOutcome> {
        for (const record of await this.host.loadBuiltIns()) {
            this.activateTree(record, 0);
        }

        let finished = -Infinity;

        for (let stage = this.nextStage(finished); stage !== undefined; stage = this.nextStage(finished)) {
            this.currentStage = stage;
            await this.host.timer.measure("config.stage", String(stage), undefined, () => this.runStage(stage));
            finished = stage;
        }

        if (this.pending.size > 0) {
            const missing = [...this.pending];

            throw new PluginError(missing[0]!, `Could not find the plugin${missing.length > 1 ? "s" : ""} ${missing.map((m) => `"${m}"`).join(", ")} listed in plugins.load.`, {
                details: ["Install it in the project, or remove it from plugins.load."],
            });
        }

        const problems: Array<PatchProblem & { contributor: string }> = [];
        const view = this.computeView(undefined, (problem, contributor) => problems.push({ ...problem, contributor }));

        return {
            config: (view.config ?? {}) as JsonObject,
            entities: view.entities,
            records: this.applyOrder().map((id) => this.records.get(id)!),
            active: this.active,
            passes: this.passes,
            problems,
        };
    }

    /**
     * What the build reached so far, for a build that failed: the plugins it activated and every
     * patch applied in order, problems ignored.
     */
    partial(): Pick<BuildOutcome, "config" | "entities" | "records" | "active" | "passes"> {
        const view = this.computeView(undefined, () => {});

        return {
            config: (view.config ?? {}) as JsonObject,
            entities: view.entities,
            records: this.applyOrder().map((id) => this.records.get(id)!),
            active: this.active,
            passes: this.passes,
        };
    }

    /** The stage a contributor runs in: its declared stage, shifted by its plugin's activation stage. */
    private stageOf(entry: ContributorEntry): number {
        return entry.declaredStage + (this.active.get(entry.plugin)?.stageShift ?? 0);
    }

    private contributors(): ContributorEntry[] {
        return [...this.host.contributorsOf(this.isActive), ...this.extras];
    }

    private nextStage(after: number): number | undefined {
        let next: number | undefined;

        for (const entry of this.contributors()) {
            const stage = this.stageOf(entry);

            if (stage > after && (next === undefined || stage < next)) {
                next = stage;
            }
        }

        return next;
    }

    private async runStage(stage: number): Promise<void> {
        for (let pass = 1; ; pass++) {
            // The limit is read on every pass, since the config being built may set it.
            const limit = this.host.limitsFrom(this.computeView(undefined).config).configPasses;

            if (pass > limit) {
                throw this.notSettled(stage, limit);
            }

            let ran = false;

            await this.host.timer.measure("config.pass", `${stage}.${pass}`, undefined, async () => {
                for (const entry of this.sorted(stage)) {
                    if (await this.runIfNeeded(entry, stage, pass)) {
                        ran = true;
                    }
                }
            });

            if (ran) {
                this.passes += 1;
            }

            this.watchFinishedStages(stage);

            const pluginsChanged = await this.syncPlugins(stage);

            if (!ran && !pluginsChanged) {
                return;
            }
        }
    }

    private sorted(stage: number): ContributorEntry[] {
        return this.sortStage(stage).order;
    }

    private sortStage(stage: number) {
        const result = sortContributors(this.contributors().filter((entry) => this.stageOf(entry) === stage));

        if (result.cycle.length > 0) {
            const key = result.cycle.join(",");

            if (!this.cycleWarned.has(key)) {
                this.cycleWarned.add(key);
                this.host.log(
                    "warning",
                    `The before and after declarations of ${result.cycle.join(", ")} form a cycle; those contributors run in name order.`,
                );
            }
        }

        return result;
    }

    private async runIfNeeded(entry: ContributorEntry, stage: number, pass: number): Promise<boolean> {
        const record = this.records.get(entry.id);

        if (record && record.verifiedAt === this.version) {
            return false;
        }

        const view = this.computeView(entry.id);
        let change: ReadChange | undefined;

        if (record) {
            change = firstChangedRead(record.reads, view);

            if (!change) {
                record.verifiedAt = this.version;

                return false;
            }
        }

        this.triggers.push({ stage, pass, contributor: entry.id, change });
        await this.runContributor(entry, view, stage, pass, record);

        return true;
    }

    private async runContributor(
        entry: ContributorEntry,
        view: View,
        stage: number,
        pass: number,
        previous: ContributorRecord | undefined,
    ): Promise<void> {
        const runs = (previous?.runs ?? 0) + 1;
        const builder = new ConfigBuilderImpl(
            view,
            { id: entry.id, plugin: entry.plugin, stage, pass, run: runs },
            previous?.patchSet,
            {
                entityRegistry: this.host.entityRegistry,
                project: this.host.project,
                env: this.host.env,
                log: (level, message) => this.host.log(level, message),
            },
            entry.definition.monitors,
        );

        this.host.enterContributor(entry.id);

        try {
            await this.host.timer.measure("contributor", entry.id, entry.plugin, () => entry.definition.contribute(builder));
        } catch (error) {
            if (error instanceof ConfigError || error instanceof LoopError || error instanceof PluginError) {
                throw error;
            }

            throw new ConfigError(`The contributor "${entry.id}" (${entry.plugin}) failed: ${messageOf(error)}`, { cause: error });
        } finally {
            this.host.leaveContributor();
        }

        const patchSet = builder.result();

        this.records.set(entry.id, {
            entry,
            stage,
            patchSet,
            primitives: flattenPatchSet(patchSet),
            entities: builder.addedEntities,
            reads: builder.reads,
            runs,
            verifiedAt: -1,
        });
        this.version += 1;
        this.records.get(entry.id)!.verifiedAt = this.version;
    }

    /**
     * The ids of every contributor that has run, in the order their patches apply: by stage, then
     * by each stage's sorted order. Re-running never moves a contributor.
     */
    private applyOrder(): string[] {
        const contributors = this.contributors();

        if (this.orderCache?.version === this.version && this.orderCache.contributors === contributors.length) {
            return this.orderCache.ids;
        }

        const stages = [...new Set([...this.records.values()].map((record) => record.stage))].sort((a, b) => a - b);
        const ids: string[] = [];

        for (const stage of stages) {
            for (const entry of this.sorted(stage)) {
                if (this.records.get(entry.id)?.stage === stage) {
                    ids.push(entry.id);
                }
            }
        }

        // A contributor that ran but is no longer listed (it cannot happen today) still applies.
        for (const [id, record] of this.records) {
            if (!ids.includes(id)) {
                ids.splice(lastIndexOfStage(ids, this.records, record.stage) + 1, 0, id);
            }
        }

        this.orderCache = { version: this.version, contributors: contributors.length, ids };

        return ids;
    }

    /**
     * The config and entities made from every contributor's latest patch except `exclude`'s,
     * applied to an empty config in the sorted order (see {@link applyOrder}).
     */
    computeView(exclude: string | undefined, onProblem?: (problem: PatchProblem, contributor: string) => void): View {
        let config: JsonValue | undefined = {};
        const entities: StoredEntity[] = [...this.registeredEntities()];

        for (const id of this.applyOrder()) {
            if (id === exclude) {
                continue;
            }

            const record = this.records.get(id)!;

            config = applyPatches(config, record.primitives, onProblem ? { onProblem: (problem) => onProblem(problem, id) } : {});
            entities.push(...record.entities);
        }

        return {
            config: config ?? {},
            entities: new EntitySnapshot(entities, () => this.host.entityRegistry.kinds().map((kind) => kind.kind)),
        };
    }

    private registeredEntities(): StoredEntity[] {
        if (this.registeredCache?.version !== this.version) {
            this.registeredCache = {
                version: this.version,
                entities: this.host.entityRegistry.registeredEntities(this.isActive),
            };
        }

        return this.registeredCache.entities;
    }

    private activateTree(record: PluginRecord, stage: number): void {
        if (this.active.has(record.name)) {
            return;
        }

        this.activate(record, stage);

        for (const child of record.children) {
            const childRecord = this.host.plugin(child);

            if (childRecord) {
                this.activateTree(childRecord, stage);
            }
        }
    }

    private activate(record: PluginRecord, stage: number): void {
        if (this.active.has(record.name)) {
            return;
        }

        this.active.set(record.name, { record, stageShift: stage });
        this.version += 1;
    }

    /**
     * Loads and activates the plugins the config now lists, and deactivates those it no longer does
     *. Returns whether anything changed.
     */
    private async syncPlugins(stage: number): Promise<boolean> {
        const view = this.computeView(undefined);
        const settings = readPluginSettings(view.config);
        const disabled = new Set(settings.disabled);
        const roots: PluginRecord[] = [];

        this.pending.clear();

        for (const record of await this.host.loadBuiltIns()) {
            roots.push(record);
        }

        for (const specifier of settings.load) {
            if (disabled.has(specifier)) {
                continue;
            }

            const record = await this.host.loadSpecifier(specifier, view);

            if (record) {
                roots.push(record);
            } else {
                this.pending.add(specifier);
            }
        }

        const desired = new Map<string, PluginRecord>();
        const visit = (record: PluginRecord): void => {
            if (desired.has(record.name) || disabled.has(record.name) || (record.specifier && disabled.has(record.specifier))) {
                return;
            }

            desired.set(record.name, record);

            for (const child of record.children) {
                const childRecord = this.host.plugin(child);

                if (childRecord) {
                    visit(childRecord);
                }
            }
        };

        roots.forEach(visit);

        let changed = false;

        for (const name of [...this.active.keys()]) {
            if (!desired.has(name)) {
                this.deactivate(name);
                changed = true;
            }
        }

        for (const record of desired.values()) {
            if (!this.active.has(record.name)) {
                this.activate(record, stage);
                changed = true;
            }
        }

        return changed;
    }

    private deactivate(name: string): void {
        this.active.delete(name);

        for (const [id, record] of this.records) {
            if (record.entry.plugin === name) {
                this.records.delete(id);
            }
        }

        this.version += 1;
    }

    /**
     * Logs, at the debug level, every contributor of a finished stage that would have re-run, and why
     * it did not.
     */
    private watchFinishedStages(stage: number): void {
        for (const record of this.records.values()) {
            if (record.stage >= stage) {
                continue;
            }

            const view = this.computeView(record.entry.id);

            for (const change of changedReads(record.reads, view)) {
                const what = describeRead(change.read);
                const key = `${record.entry.id}\u0000${what}`;

                if (this.loggedFinished.has(key)) {
                    continue;
                }

                this.loggedFinished.add(key);

                const writer = change.read.kind === "key" ? this.writerOf(change.read.path, stage) : undefined;
                const who = writer ? `${writer.entry.id}, running in config stage ${stage}, changed` : `In config stage ${stage}, something changed`;

                this.host.log(
                    "debug",
                    `${who} ${what}, which would have made ${record.entry.id} re-run, but ${record.entry.id} is in stage ${record.stage}, so it didn't.`,
                );
            }
        }
    }

    /** The contributor that last wrote a path, optionally only among those in one stage. */
    private writerOf(path: readonly PathSegment[], stage?: number): ContributorRecord | undefined {
        const order = this.applyOrder();

        for (let index = order.length - 1; index >= 0; index--) {
            const record = this.records.get(order[index]!)!;

            if (stage !== undefined && record.stage !== stage) {
                continue;
            }

            if (record.primitives.some((patch) => pathsOverlap(primitiveTarget(patch), path))) {
                return record;
            }
        }

        return undefined;
    }

    private notSettled(stage: number, limit: number): LoopError {
        const recent = this.triggers.filter((trigger) => trigger.stage === stage && trigger.pass > Math.max(1, limit - 3));
        const byRead = new Map<string, { readers: Set<string>; values: Set<string> }>();

        for (const trigger of recent) {
            if (!trigger.change) {
                continue;
            }

            const what = describeRead(trigger.change.read);
            const entry = byRead.get(what) ?? { readers: new Set(), values: new Set() };

            entry.readers.add(trigger.contributor);
            entry.values.add(JSON.stringify(trigger.change.before) ?? "undefined");
            entry.values.add(JSON.stringify(trigger.change.after) ?? "undefined");
            byRead.set(what, entry);
        }

        const details = [...byRead.entries()].map(([what, entry]) => {
            const read = recent.find((trigger) => trigger.change && describeRead(trigger.change.read) === what)!.change!.read;
            const writer = read.kind === "key" ? this.writerOf(read.path) : undefined;
            const writtenBy = writer ? `, written by ${writer.entry.id}` : "";

            return `${what} kept changing (read by ${[...entry.readers].join(", ")}${writtenBy}); it alternated between ${[...entry.values].join(", ")}.`;
        });

        return new LoopError("configPasses", `The config did not settle in ${limit} passes of config stage ${stage}.`, {
            details: details.length > 0 ? details : ["New contributors or plugins kept appearing on every pass."],
        });
    }
}

function lastIndexOfStage(ids: readonly string[], records: ReadonlyMap<string, ContributorRecord>, stage: number): number {
    let last = -1;

    ids.forEach((id, index) => {
        if (records.get(id)!.stage <= stage) {
            last = index;
        }
    });

    return last;
}

/** The plugin settings core reads from the config while it is built. */
export function readPluginSettings(config: JsonValue): { load: string[]; disabled: string[] } {
    const plugins = (config as JsonObject | null)?.plugins as JsonObject | undefined;
    const strings = (value: JsonValue | undefined): string[] =>
        Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

    return { load: strings(plugins?.load), disabled: strings(plugins?.disabled) };
}

/** The path a primitive changes: the key or item it targets. */
export function primitiveTarget(patch: Patch): PathSegment[] {
    const container = parsePathCached(patch.path);

    switch (patch.op) {
        case "setKey":
        case "deleteKey":
        case "renameKey":
            return [...container, patch.key];
        case "insertAt":
            return container;
        default:
            return [...container, patch.index];
    }
}

const pathCache = new Map<string, PathSegment[]>();

function parsePathCached(path: string): PathSegment[] {
    let parsed = pathCache.get(path);

    if (!parsed) {
        parsed = parsePath(path);
        pathCache.set(path, parsed);
    }

    return parsed;
}

function describeRead(read: Read): string {
    switch (read.kind) {
        case "key":
            return read.path.length === 0 ? "the whole config" : formatPath(read.path);
        case "entities":
            return `the ${read.entityKind} list`;
        case "entity":
            return `${read.entityKind} "${read.id}"`;
    }
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
