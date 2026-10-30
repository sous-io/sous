import {
    ConfigError,
    type EntityKind,
    type EntityKindOptions,
    type EntityReader,
    type EntityRecord,
    type EntityType,
    type SousSchema,
    validateWithSync,
} from "@sous-io/plugin-api";

/** A defined kind of entity. */
export interface EntityKindRecord {
    readonly kind: string;
    readonly schema: SousSchema;
    readonly plugin: string;
    readonly description: string | undefined;
}

/** An entity as the engine stores it: the checked entry, and whether it was checked yet. */
export interface StoredEntity extends EntityRecord<unknown> {
    /** False when it was added before its kind was defined. */
    readonly checked: boolean;
}

/**
 * Entity kinds, and the entities plugins add in `register()`. Entities the config
 * creates belong to the contributors that add them, and live in each build's snapshot.
 */
export class EntityRegistry {
    private readonly kindMap = new Map<string, EntityKindRecord>();
    private readonly registered: StoredEntity[] = [];

    constructor(private readonly prepareEntry: (kind: string, entry: Record<string, unknown>, plugin: string) => unknown) {}

    /** Defines a kind. Defining one twice is an error naming both plugins. */
    define(kind: string, schema: SousSchema, plugin: string, options: EntityKindOptions = {}): void {
        const existing = this.kindMap.get(kind);

        if (existing) {
            throw new ConfigError(
                `Two plugins define the entity kind "${kind}": ${existing.plugin} and ${plugin}.`,
            );
        }

        this.kindMap.set(kind, { kind, schema, plugin, description: options.description });
    }

    /** The definition of a kind, if any. */
    kind(kind: string): EntityKindRecord | undefined {
        return this.kindMap.get(kind);
    }

    /** Every defined kind. */
    kinds(): EntityKindRecord[] {
        return [...this.kindMap.values()];
    }

    /** Adds an entity from a plugin's `register()`. */
    add(kind: string, entry: unknown, plugin: string): void {
        this.registered.push(this.store(kind, entry, plugin, undefined));
    }

    /** Every entity added in `register()`, by plugins for which `isActive` says yes. */
    registeredEntities(isActive: (plugin: string) => boolean): StoredEntity[] {
        return this.registered.filter((entity) => isActive(entity.plugin));
    }

    /**
     * Checks an entry against its kind's schema (when the kind exists yet) and stores it, with its
     * methods timed.
     */
    store(kind: string, entry: unknown, plugin: string, contributor: string | undefined): StoredEntity {
        const id = (entry as { id?: unknown } | null)?.id;
        const who = contributor ? `contributor "${contributor}" (${plugin})` : plugin;

        if (typeof id !== "string" || id === "") {
            throw new ConfigError(`${who} added a "${kind}" entity without a string id.`);
        }

        const checked = this.check(kind, entry, who);
        const prepared = this.prepareEntry(kind, checked.value as Record<string, unknown>, plugin);

        return contributor === undefined
            ? { kind, id, entry: prepared, plugin, checked: checked.checked }
            : { kind, id, entry: prepared, plugin, contributor, checked: checked.checked };
    }

    /**
     * Checks entities that were added before their kind was defined. Returns them checked, and
     * throws a `ConfigError` for any that fail.
     */
    recheck(entities: readonly StoredEntity[]): StoredEntity[] {
        return entities.map((entity) => {
            if (entity.checked || !this.kindMap.has(entity.kind)) {
                return entity;
            }

            const who = entity.contributor ? `contributor "${entity.contributor}" (${entity.plugin})` : entity.plugin;
            const checked = this.check(entity.kind, entity.entry, who);

            return { ...entity, entry: checked.value, checked: true };
        });
    }

    private check(kind: string, entry: unknown, who: string): { value: unknown; checked: boolean } {
        const definition = this.kindMap.get(kind);

        if (!definition) {
            return { value: entry, checked: false };
        }

        const result = validateWithSync(definition.schema, entry);

        if (result.issues) {
            const id = (entry as { id?: string }).id;

            throw new ConfigError(`${who} added a "${kind}" entity "${id}" that does not match its schema.`, {
                details: result.issues.map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message)),
            });
        }

        return { value: result.value, checked: true };
    }
}

/**
 * The entities of one build (or of one contributor's view): read-only, in the order they were
 * added. When two entries share an id, the later one wins.
 */
export class EntitySnapshot implements EntityReader {
    private readonly byKind = new Map<string, StoredEntity[]>();

    constructor(
        entities: Iterable<StoredEntity>,
        private readonly kindNames: () => string[],
    ) {
        for (const entity of entities) {
            const list = this.byKind.get(entity.kind);

            if (!list) {
                this.byKind.set(entity.kind, [entity]);
                continue;
            }

            const existing = list.findIndex((item) => item.id === entity.id);

            if (existing !== -1) {
                list.splice(existing, 1);
            }

            list.push(entity);
        }
    }

    /** Every stored entity of a kind. */
    records(kind: string): readonly StoredEntity[] {
        return this.byKind.get(kind) ?? [];
    }

    /** Every stored entity. */
    allRecords(): StoredEntity[] {
        return [...this.byKind.values()].flat();
    }

    get<K extends EntityKind>(kind: K, id: string): EntityType<K> | undefined {
        return this.records(kind).find((entity) => entity.id === id)?.entry as EntityType<K> | undefined;
    }

    list<K extends EntityKind>(kind: K): EntityType<K>[] {
        return this.records(kind).map((entity) => entity.entry as EntityType<K>);
    }

    has(kind: string, id: string): boolean {
        return this.records(kind).some((entity) => entity.id === id);
    }

    describe<K extends EntityKind>(kind: K): EntityRecord<EntityType<K>>[] {
        return this.records(kind).map(({ checked: _checked, ...record }) => record as EntityRecord<EntityType<K>>);
    }

    kinds(): string[] {
        return this.kindNames();
    }
}
