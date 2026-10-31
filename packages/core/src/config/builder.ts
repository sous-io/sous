import { applyPatch, DocNode, formatPath, getAtPath, isPatch, parsePath, parsePatch, PatchRecorder } from "@sous-io/documents";
import {
    BaseReporter,
    Reporting,
    type ConfigBuilder,
    type ContributorInfo,
    type DocumentNode,
    type EntityKind,
    type EntityType,
    type Environment,
    type JsonObject,
    type JsonValue,
    type LogLevel,
    type Monitor,
    type Patch,
    type PatchSet,
    type PathInput,
    type PathSegment,
    type ProjectInfo,
    type ReportDetails,
    type ReportEntryStyle,
    type Reporter,
} from "@sous-io/plugin-api";
import type { EntityRegistry, StoredEntity } from "../entities/entity-registry.js";
import { entitySignature, type Read, type View } from "./reads.js";

/** What a builder needs from the engine. */
export interface BuilderServices {
    readonly entityRegistry: EntityRegistry;
    readonly project: ProjectInfo | undefined;
    readonly env: Environment;
    log(level: LogLevel, message: string, details?: ReportDetails, style?: ReportEntryStyle): void;
}

/** A reporter that names the contributor in front of each message and hands it to the engine's reporter. */
class ContributorReporter extends BaseReporter {
    constructor(
        private readonly contributorId: string,
        private readonly services: BuilderServices,
    ) {
        super();
    }

    protected write(level: LogLevel, message: string, details: ReportDetails | undefined, style: ReportEntryStyle): void {
        this.services.log(level, `${this.contributorId}: ${message}`, details, style);
    }
}

/**
 * The builder object a contributor is given. It shows the view (every other
 * contributor's latest patches), records each read against that view, and records each change as
 * this run's patch set. The contributor's own changes are visible to its later reads, but are never
 * recorded as reads, so a contributor never re-runs because of itself.
 */
export class ConfigBuilderImpl extends Reporting(Object) implements ConfigBuilder {
    /** Everything read, against the view. */
    readonly reads: Read[] = [];
    /** Entities this run added. */
    readonly addedEntities: StoredEntity[] = [];

    private readonly recorder: PatchRecorder;
    private readonly seenPaths = new Set<string>();
    private readonly seenEntityReads = new Set<string>();
    private working: JsonValue;
    private readonly contributorReporter: Reporter;

    constructor(
        private readonly view: View,
        readonly contributor: ContributorInfo,
        private readonly previous: PatchSet | undefined,
        private readonly services: BuilderServices,
        monitors: readonly Monitor[] = [],
    ) {
        super();
        this.contributorReporter = new ContributorReporter(contributor.id, services);
        this.working = view.config;
        this.recorder = new PatchRecorder(contributor.id);

        for (const monitor of monitors) {
            if (typeof monitor === "object" && monitor !== null && !Array.isArray(monitor) && "entities" in monitor) {
                this.recordEntityList(monitor.entities);
            } else {
                this.recordKey(parsePath(monitor as PathInput));
            }
        }
    }

    get project(): ProjectInfo | undefined {
        return this.services.project;
    }

    get env(): Environment {
        return this.services.env;
    }

    /** This run's patch set. */
    patchSet(): PatchSet {
        return this.recorder.result();
    }

    root(): DocumentNode {
        return new DocNode(this.backend, []);
    }

    atPath(path: PathInput): DocumentNode {
        return new DocNode(this.backend, parsePath(path));
    }

    entities<K extends EntityKind>(kind: K): EntityType<K>[] {
        this.recordEntityList(kind);

        const own = this.addedEntities.filter((entity) => entity.kind === kind);
        const base = this.view.entities.records(kind).filter((entity) => !own.some((mine) => mine.id === entity.id));

        return [...base, ...own].map((entity) => entity.entry as EntityType<K>);
    }

    entity<K extends EntityKind>(kind: K, id: string): EntityType<K> | undefined {
        const key = `${kind}\u0000${id}`;
        const found = this.view.entities.records(kind).find((entity) => entity.id === id);

        if (!this.seenEntityReads.has(key)) {
            this.seenEntityReads.add(key);
            this.reads.push({ kind: "entity", entityKind: kind, id, entry: found ? entitySignature(found) : undefined });
        }

        const own = this.addedEntities.filter((entity) => entity.kind === kind && entity.id === id).at(-1);

        return (own ?? found)?.entry as EntityType<K> | undefined;
    }

    addEntity<K extends EntityKind>(kind: K, entry: EntityType<K>): void {
        this.addedEntities.push(this.services.entityRegistry.store(kind, entry, this.contributor.plugin, this.contributor.id));
    }

    previousPatches(): PatchSet | undefined {
        return this.previous;
    }

    apply(patches: Patch | PatchSet | readonly Patch[]): void {
        if (Array.isArray(patches)) {
            for (const patch of patches) {
                this.applyOne(patch);
            }
        } else {
            this.applyOne(patches as Patch | PatchSet);
        }
    }

    options<T = JsonObject>(): T | undefined {
        return this.backend.read(["plugins", "options", this.contributor.plugin]) as T | undefined;
    }

    protected get reporter(): Reporter {
        return this.contributorReporter;
    }

    log(level: LogLevel, message: string, details?: ReportDetails, style?: ReportEntryStyle): void {
        this.contributorReporter.log(level, message, details, style);
    }

    private applyOne(item: Patch | PatchSet): void {
        if (isPatch(item)) {
            this.backend.emit(parsePatch(item));

            return;
        }

        const set = item as PatchSet;

        this.backend.openSet(set.name, set.path);

        try {
            for (const child of set.patches) {
                this.applyOne(child);
            }
        } finally {
            this.backend.closeSet();
        }
    }

    private recordKey(path: readonly PathSegment[]): void {
        const key = formatPath(path);

        if (this.seenPaths.has(key)) {
            return;
        }

        this.seenPaths.add(key);
        this.reads.push({ kind: "key", path: [...path], value: getAtPath(this.view.config, path) });
    }

    private recordEntityList(kind: string): void {
        const key = `${kind}\u0000*`;

        if (this.seenEntityReads.has(key)) {
            return;
        }

        this.seenEntityReads.add(key);
        this.reads.push({ kind: "entities", entityKind: kind, entries: this.view.entities.records(kind).map(entitySignature) });
    }

    private readonly backend = {
        read: (path: readonly PathSegment[]): JsonValue | undefined => {
            this.recordKey(path);

            return getAtPath(this.working, path);
        },
        emit: (patch: Patch): void => {
            this.working = applyPatch(this.working, patch) ?? {};
            this.recorder.add(patch);
        },
        openSet: (name: string, path?: string): void => {
            this.recorder.open(name, path);
        },
        closeSet: (): void => {
            this.recorder.close();
        },
    };
}
