import { createHash } from "node:crypto";
import path from "node:path";
import { deepFreeze, stableStringify } from "@sous-io/documents";
import {
    type AppInfo,
    type BuildOptions,
    type BuiltConfig,
    BufferedReporter,
    CancelledError,
    ConfigError,
    type ContributorDefinition,
    type EngineHandle,
    type EntityKindOptions,
    type Environment,
    type EventPattern,
    type FrontEndDefinition,
    InputError,
    type IntentCatalog,
    type IntentDefinition,
    type IntentInfo,
    type IntentRequest,
    type IntentWrapper,
    type JsonObject,
    type JsonValue,
    type Listener,
    type ListenerOptions,
    LoopError,
    nonInteractivePrompter,
    NotFoundError,
    type PluginDefinition,
    PluginError,
    type PluginInfo,
    type LogLevel,
    type ReportDetails,
    type ReportEntryStyle,
    type ProjectInfo,
    type RefreshConfigOptions,
    type Reporter,
    type ServiceFactory,
    type ServiceOptions,
    type ServiceWrapper,
    SousError,
    type SousSchema,
    type SubmitOptions,
    type TimingCategory,
    type Timings,
    validateWith,
} from "@sous-io/plugin-api";
import { type ActivePlugin, type BuildOutcome, ConfigBuild, WHAT_IF_PLUGIN } from "./config/build.js";
import { BuiltConfigImpl } from "./config/built-config.js";
import { ContributorRegistry } from "./config/contributor-registry.js";
import { CORE_CONFIG_KEYS } from "./config/core-keys.js";
import { entitySignature, type View } from "./config/reads.js";
import { validateConfig } from "./config/validate.js";
import { type CallHost, type CallState, ChainState, configOf, createContext } from "./context.js";
import { EntityRegistry, EntitySnapshot, type StoredEntity } from "./entities/entity-registry.js";
import { EventBus, type StoredListenerFn } from "./events/event-bus.js";
import { AfterEventImpl, type BaseEvent, BeforeEventImpl, CustomEventImpl, ErrorEventImpl } from "./events/event-objects.js";
import { IntentRegistry } from "./intents/intent-registry.js";
import { DEFAULT_LIMITS, type Limits, resolveLimits } from "./limits.js";
import { definitionFromModule, PluginRegistry, type PluginRecord } from "./plugins/plugin-registry.js";
import { locateWithNode } from "./plugins/resolve.js";
import { createSousApi, type SousApiHost } from "./plugins/sous-api.js";
import { Scheduler } from "./scheduler/scheduler.js";
import { ServiceContainer, type ServiceHost } from "./services/service-container.js";
import { ServiceRegistry } from "./services/service-registry.js";
import { timeFunction } from "./services/timed.js";
import { DEFAULT_BUDGETS, type Budget } from "./timing/budgets.js";
import { describeOverBudget } from "./timing/describe.js";
import { type OverBudget, Timer } from "./timing/timer.js";
import { countFrames, describeFramePath, type Frame, pushFrame } from "./util/frames.js";
import { CORE_PLUGIN, namePrefix, pluginPrefix } from "./util/names.js";
import { stableKey } from "./util/stable.js";

/** How to start an engine. */
export interface EngineOptions {
    /** The project this process serves. */
    project?: ProjectInfo;
    /**
     * Finds the project at or above a directory, for `ctx.refreshConfig({ locateProjectFrom })`
     * after an intent sets a project up. Without it, the engine's project never changes.
     */
    locateProject?: (directory: string) => ProjectInfo | undefined;
    /** The environment variables; `ctx.env`. Default: none. */
    env?: Environment;
    /** Where plugin specifiers resolve from when there is no project. Default: the process's directory. */
    cwd?: string;
    /** The built-in plugins, loaded first, in order. */
    builtIns?: ReadonlyArray<PluginDefinition | string>;
    /** The application's name and version. */
    app?: AppInfo;
    /** Where engine-level messages go. Default: kept until a front end sets one. */
    reporter?: Reporter;
    /** Imports a plugin module by URL. Default: `import()`. */
    importModule?: (url: string) => Promise<unknown>;
    /** Default budgets to use instead of core's. */
    budgets?: Partial<Record<TimingCategory, Budget>>;
    /** Default limits to use instead of core's. */
    limits?: Partial<Limits>;
    /** The clock timings use, in milliseconds. Default: `performance.now()`. */
    now?: () => number;
}

/** Starts an engine. Nothing is loaded until the config is first built. */
export function createEngine(options: EngineOptions = {}): Engine {
    return new Engine(options);
}

/** A front end, ready to start. */
export interface StartableFrontEnd {
    readonly id: string;
    readonly plugin: string;
    start(argv: readonly string[]): Promise<void>;
    /** Whether `argv` needs the built config; asked on the config of the built-in plugins alone. */
    needsConfig(argv: readonly string[]): boolean;
}

interface RebuildTrigger {
    path: string;
}

/** The latest real build, when it failed: its error, and the config it reached. */
interface BuildFailure {
    readonly error: unknown;
    readonly partial: BuiltConfigImpl;
}

/**
 * The sous engine: plugin loading inside the config loop, the config builder, the chain
 * scheduler, intents, events, services, entities, loop detection and budgets. Every project state
 * lives in the engine object, so tests can run many engines in one process.
 */
export class Engine {
    /** The engine as plugins see it. */
    readonly handle: EngineHandle;
    readonly env: Environment;
    readonly app: AppInfo;

    private reporterImpl: Reporter;
    private readonly buffered: BufferedReporter | undefined;
    private readonly plugins = new PluginRegistry();
    private readonly contributors = new ContributorRegistry();
    private readonly entityRegistry: EntityRegistry;
    private readonly intents: IntentRegistry;
    private readonly bus: EventBus;
    private readonly services: ServiceRegistry;
    private readonly singletons = new Map<string, unknown>();
    private readonly frontEnds = new Map<string, { definition: FrontEndDefinition; plugin: string }>();
    private readonly timer: Timer;
    private readonly scheduler: Scheduler;
    private readonly baseLimits: Limits;
    private readonly builtIns: ReadonlyArray<PluginDefinition | string>;
    private readonly importModule: (url: string) => Promise<unknown>;
    private readonly cwd: string;
    private readonly background = new Set<Promise<unknown>>();
    private readonly warnedOnce = new Set<string>();
    private readonly contributorStack: string[] = [];
    private registering = 0;
    private realBuilds = 0;
    private buildCounter = 0;
    private chainCounter = 0;
    private current: BuiltConfigImpl;
    private builtInRecords: PluginRecord[] | undefined;
    private streakTriggers: RebuildTrigger[] | undefined;
    private failure: BuildFailure | undefined;
    private failedPartial: BuiltConfigImpl | undefined;
    private readonly serviceHost: ServiceHost;
    private readonly apiHost: SousApiHost;
    private readonly callHost: CallHost;

    /** The project this process serves; `ctx.refreshConfig({ locateProjectFrom })` may change it. */
    get project(): ProjectInfo | undefined {
        return this.currentProject;
    }

    private currentProject: ProjectInfo | undefined;
    private readonly locateProject: ((directory: string) => ProjectInfo | undefined) | undefined;

    constructor(options: EngineOptions) {
        this.currentProject = options.project;
        this.locateProject = options.locateProject;
        this.env = Object.freeze({ ...(options.env ?? {}) });
        this.app = options.app ?? { name: "sous", version: "0.0.0" };
        this.cwd = options.cwd ?? options.project?.root ?? process.cwd();
        this.builtIns = options.builtIns ?? [];
        this.importModule = options.importModule ?? ((url) => import(url));
        this.baseLimits = { ...DEFAULT_LIMITS, ...options.limits };

        if (options.reporter) {
            this.reporterImpl = options.reporter;
        } else {
            this.buffered = new BufferedReporter();
            this.reporterImpl = this.buffered;
        }

        const pluginIndex = (plugin: string): number => this.plugins.index(plugin);

        this.timer = new Timer({ ...DEFAULT_BUDGETS, ...options.budgets }, (over, batch) => this.reportOverBudget(over, batch), options.now);
        this.entityRegistry = new EntityRegistry((kind, entry, plugin) => this.timeEntityMethods(kind, entry, plugin));
        this.intents = new IntentRegistry(pluginIndex);
        this.bus = new EventBus(pluginIndex);
        this.services = new ServiceRegistry(pluginIndex);
        this.scheduler = new Scheduler(async () => {
            await this.buildConfig();
        });
        const engine = this;

        this.serviceHost = {
            registry: this.services,
            timer: this.timer,
            singletons: this.singletons,
            get project() {
                return engine.project;
            },
            env: this.env,
            cwd: this.cwd,
            building: () => this.realBuilds > 0 || this.contributorStack.length > 0,
        };
        this.handle = this.createHandle();
        this.apiHost = this.createApiHost();
        this.callHost = this.createCallHost();
        this.registerCore();
        this.current = this.emptyConfig();
    }

    // ------------------------------------------------------------------ public

    /** The config as of the latest build. */
    get config(): BuiltConfig {
        return this.current;
    }

    /**
     * The error of the latest real config build, when it failed; `undefined` once a build succeeds.
     * The config is then the partial one the build reached, and only intents that declare
     * `toleratesConfigErrors` run.
     */
    get configError(): unknown {
        return this.failure?.error;
    }

    /** Where engine-level messages go. */
    get reporter(): Reporter {
        return this.reporterImpl;
    }

    /** Every timing so far (`--timings`). */
    get timings(): Timings {
        return this.timer;
    }

    /** Sets where engine-level messages go, first sending any kept so far. */
    setReporter(reporter: Reporter): void {
        this.reporterImpl = reporter;
        this.buffered?.flushTo(reporter);
    }

    /**
     * Loads the built-in plugins and makes a config of what they registered the current one,
     * without building the real config: their intents, entities and front ends are all there, and
     * no contributor ran. A later {@link buildConfig} replaces it. For a command that needs no
     * config values (see `runsWithoutConfig`) when the project loads no other plugin.
     */
    async loadBuiltInsOnly(): Promise<void> {
        const active = new Map<string, ActivePlugin>();
        const add = (record: PluginRecord): void => {
            if (active.has(record.name)) {
                return;
            }

            active.set(record.name, { record, stageShift: 0 });

            for (const child of record.children) {
                const childRecord = this.plugins.get(child);

                if (childRecord) {
                    add(childRecord);
                }
            }
        };

        for (const record of await this.loadBuiltIns()) {
            add(record);
        }

        const entities = new EntitySnapshot(this.entityRegistry.registeredEntities(() => true), () => this.kindNames());

        this.current = this.makeBuilt({ buildNumber: 0, whatIf: false, config: deepFreeze({}), entities, records: [], active, passes: 0, hash: "" });
    }

    /**
     * Builds the real config, replacing the current one, and fires `config.built`. When a
     * `config.built` listener runs an intent that changes the config, the config is rebuilt, up to
     * the rebuild limits.
     *
     * With `extraContributors`, builds a "what if" config instead (see {@link buildWhatIf}).
     */
    async buildConfig(options: BuildOptions = {}): Promise<BuiltConfig> {
        if (options.extraContributors && options.extraContributors.length > 0) {
            return this.buildWhatIf(options);
        }

        try {
            const built = await this.buildAndSettle(options.reportBudgets !== false);

            this.failure = undefined;

            return built;
        } catch (error) {
            // Keep what the build reached, for intents that tolerate a broken config.
            const partial = this.failedPartial ?? this.current;

            this.failedPartial = undefined;
            this.failure = { error, partial };
            this.current = partial;

            throw error;
        }
    }

    /** Builds the real config, then fires `config.built`, rebuilding while its listeners change the config. */
    private async buildAndSettle(reportBudgets = true): Promise<BuiltConfigImpl> {
        const seen = new Map<string, number>();
        let changing = 0;
        let repeating = 0;
        const triggers: RebuildTrigger[] = [];

        for (let rebuild = 0; ; rebuild++) {
            const built = await this.buildOnce(false, [], reportBudgets);

            this.current = built;

            if (rebuild > 0) {
                if (seen.has(built.hash)) {
                    repeating += 1;
                } else {
                    changing += 1;
                }

                const limits = built.limits;

                if (repeating > limits.rebuildsRepeating) {
                    const ago = rebuild - seen.get(built.hash)!;

                    throw new LoopError(
                        "rebuildsRepeating",
                        `The config is going in circles (it was the same as ${ago} rebuild${ago === 1 ? "" : "s"} ago, ${repeating} times).`,
                        { details: uniqueTriggers(triggers) },
                    );
                }

                if (changing > limits.rebuildsChanging) {
                    throw new LoopError(
                        "rebuildsChanging",
                        `The config kept changing: it was rebuilt ${changing} times in a row, and was different each time.`,
                        { details: uniqueTriggers(triggers) },
                    );
                }
            }

            seen.set(built.hash, rebuild);

            this.streakTriggers = [];

            let fired: RebuildTrigger[];

            // An error a listener throws fails the build (an expression still unknown once settled, say).
            try {
                const event = new CustomEventImpl("config.built", { config: built });

                await this.dispatch(event, this.inlineCall(built));
            } finally {
                fired = this.streakTriggers;
                this.streakTriggers = undefined;
            }

            if (fired.length === 0) {
                return built;
            }

            triggers.push(...fired);
        }
    }

    /**
     * Builds a separate "what if" config with extra contributors, never replacing the real one
     *. It gets its own `config` services, and fires no events.
     */
    async buildWhatIf(options: BuildOptions = {}): Promise<BuiltConfig> {
        return this.buildOnce(true, options.extraContributors ?? []);
    }

    /**
     * Submits a chain: one intent, together with every intent it starts. Resolves with the
     * intent's result. A background intent runs outside the scheduler.
     */
    submit(request: IntentRequest, options: SubmitOptions = {}): Promise<unknown> {
        return this.submitWith(request, options, undefined);
    }

    /** A front end, by id. Throws `NotFoundError` when no active plugin adds it. */
    frontEnd(id: string): StartableFrontEnd {
        const found = this.frontEnds.get(id);

        if (!found || !this.current.isActive(found.plugin)) {
            throw new NotFoundError("front end", id);
        }

        return {
            id,
            plugin: found.plugin,
            start: async (argv) => {
                await found.definition.start(this.handle, argv);
            },
            needsConfig: (argv) => found.definition.needsConfig?.(this.handle, argv) ?? true,
        };
    }

    /** Resolves when every background intent has returned. */
    async whenBackgroundIntentsReturn(): Promise<void> {
        while (this.background.size > 0) {
            await Promise.allSettled([...this.background]);
        }
    }

    /** Every loaded plugin, with what it registered. */
    pluginInfo(): PluginInfo[] {
        return this.plugins.list().map((record) => ({
            name: record.name,
            version: record.version,
            active: this.current.isActive(record.name),
            builtIn: record.builtIn,
            loadedBy: record.loadedBy ?? (record.specifier ? "plugins.load" : undefined),
            registrations: [...record.registrations],
            options: this.current.get<JsonObject>(["plugins", "options", record.name]),
        }));
    }

    /** The intents front ends generate commands and tools from. */
    get intentCatalog(): IntentCatalog {
        return this.handle.intents;
    }

    // ------------------------------------------------------------------ building

    private emptyConfig(): BuiltConfigImpl {
        const entities = new EntitySnapshot(this.entityRegistry.registeredEntities(() => true), () => this.kindNames());

        return this.makeBuilt({
            buildNumber: 0,
            whatIf: false,
            config: deepFreeze({}),
            entities,
            records: [],
            active: new Map(),
            passes: 0,
            hash: "",
        });
    }

    private makeBuilt(data: ConstructorParameters<typeof BuiltConfigImpl>[0]): BuiltConfigImpl {
        const built = new BuiltConfigImpl(data, this.baseLimits);

        built.services = new ServiceContainer(this.serviceHost, { config: built, entities: built.entities });

        return built;
    }

    private async buildOnce(whatIf: boolean, extra: readonly ContributorDefinition[], reportBudgets = true): Promise<BuiltConfigImpl> {
        const buildNumber = ++this.buildCounter;
        const label = whatIf ? `what-if #${buildNumber}` : "config";

        if (!whatIf) {
            this.realBuilds += 1;
        }

        this.timer.deferReports();

        const endBuild = this.timer.start("config.build", label);
        let built: BuiltConfigImpl | undefined;
        let build: ConfigBuild | undefined;

        try {
            build = new ConfigBuild(this.buildHost(), extra);
            const outcome = await build.run();

            await this.checkDependencies(outcome.active);

            const entities = new EntitySnapshot(this.entityRegistry.recheck(outcome.entities.allRecords()), () => this.kindNames());
            const config = await this.validate(outcome, entities);

            built = this.makeBuilt({
                buildNumber,
                whatIf,
                config,
                entities,
                records: outcome.records,
                active: outcome.active,
                passes: outcome.passes,
                hash: hashOf(config, entities),
            });

            this.checkConflicts(built);
            this.reportBuildWarnings(outcome, entities);

            return built;
        } catch (error) {
            if (!whatIf && build) {
                this.failedPartial = this.partialConfig(build, buildNumber);
            }

            throw error;
        } finally {
            endBuild();

            if (!whatIf) {
                this.realBuilds -= 1;
            }

            if (built && !whatIf) {
                this.timer.setBudgets(built.get<Record<string, unknown>>("budgets"));
            }

            this.timer.releaseDeferred(reportBudgets);
        }
    }

    /** The config a failed build reached: the plugins it activated and the values merged so far, unchecked. */
    private partialConfig(build: ConfigBuild, buildNumber: number): BuiltConfigImpl | undefined {
        try {
            const partial = build.partial();
            const config = deepFreeze(structuredClone(partial.config));

            return this.makeBuilt({
                buildNumber,
                whatIf: false,
                config,
                entities: partial.entities,
                records: partial.records,
                active: partial.active,
                passes: partial.passes,
                hash: hashOf(config, partial.entities),
            });
        } catch {
            return undefined;
        }
    }

    private buildHost() {
        return {
            entityRegistry: this.entityRegistry,
            timer: this.timer,
            project: this.project,
            env: this.env,
            baseLimits: this.baseLimits,
            contributorsOf: (isActive: (plugin: string) => boolean) => this.contributors.active(isActive),
            loadBuiltIns: () => this.loadBuiltIns(),
            loadSpecifier: (specifier: string, view: View) => this.loadSpecifier(specifier, view),
            plugin: (name: string) => this.plugins.get(name),
            log: (level: LogLevel, message: string, details?: ReportDetails, style?: ReportEntryStyle) => this.reporterImpl.log(level, message, details, style),
            enterContributor: (id: string) => {
                this.contributorStack.push(id);
            },
            leaveContributor: () => {
                this.contributorStack.pop();
            },
            limitsFrom: (config: JsonValue) => resolveLimits(this.baseLimits, (config as JsonObject | null)?.limits as JsonObject | undefined),
        };
    }

    private async validate(outcome: BuildOutcome, entities: EntitySnapshot): Promise<Readonly<JsonObject>> {
        const keys = entities.records("config-key") as StoredEntity[];
        const result = await this.timer.measure("config.validate", "config", undefined, () =>
            validateConfig(outcome.config, keys, (path) => {
                const layers = new BuiltConfigImpl(
                    { buildNumber: 0, whatIf: true, config: outcome.config, entities, records: outcome.records, active: outcome.active, passes: 0, hash: "" },
                    this.baseLimits,
                ).layers(path);

                return layers.at(-1)?.contributor;
            }),
        );

        if (result.issues.length > 0) {
            throw new ConfigError(`The config is not valid (${result.issues.length} problem${result.issues.length === 1 ? "" : "s"}).`, {
                details: result.issues,
            });
        }

        return deepFreeze(result.config);
    }

    /** `dependsOn`: every plugin a plugin needs is active, at a version in the range. */
    private async checkDependencies(active: ReadonlyMap<string, ActivePlugin>): Promise<void> {
        const problems: string[] = [];
        let satisfies: ((version: string, range: string, options: { includePrerelease: boolean }) => boolean) | undefined;

        for (const { record } of active.values()) {
            for (const [dependency, range] of Object.entries(record.definition.dependsOn ?? {})) {
                const needed = active.get(dependency)?.record;

                if (!needed) {
                    problems.push(`${record.name} needs ${dependency} ${range}, which is not loaded.`);
                    continue;
                }

                if (range === "*" || range === "") {
                    continue;
                }

                if (!needed.version) {
                    problems.push(`${record.name} needs ${dependency} ${range}, but ${dependency} declares no version.`);
                    continue;
                }

                satisfies ??= ((await import("semver")) as unknown as { default: { satisfies: typeof satisfies } }).default.satisfies;

                if (!satisfies!(needed.version, range, { includePrerelease: true })) {
                    problems.push(`${record.name} needs ${dependency} ${range}, but ${dependency} ${needed.version} is loaded.`);
                }
            }
        }

        if (problems.length > 0) {
            throw new PluginError(problems[0]!.split(" ")[0]!, problems.length === 1 ? problems[0]! : `${problems.length} plugins are missing what they depend on.`, {
                details: problems.length === 1 ? ["Install the plugin it needs, at a version in that range, or disable the plugin that needs it."] : problems,
            });
        }
    }

    /** Service and intent conflicts stop the build; the config's picks are warned about on every run. */
    private checkConflicts(built: BuiltConfigImpl): void {
        const warnings: string[] = [];

        for (const name of this.services.names()) {
            const choice = this.services.choose(name, built.isActive, built.servicePicks);

            if (choice?.warning) {
                warnings.push(choice.warning);
            }
        }

        for (const name of this.intents.allNames()) {
            const choice = this.intents.resolve(name, built.isActive, built.intentPicks);

            if (choice?.warning) {
                warnings.push(choice.warning);
            }
        }

        if (!built.whatIf) {
            for (const warning of warnings) {
                this.reporterImpl.warning(warning);
            }
        }
    }

    private reportBuildWarnings(outcome: BuildOutcome, entities: EntitySnapshot): void {
        for (const problem of outcome.problems) {
            this.reporterImpl.warning(`The contributor "${problem.contributor}" made a change that could not be applied: ${problem.message}`);
        }

        for (const warning of this.plugins.takeDuplicateWarnings()) {
            this.warnOnce(warning);
        }

        for (const entity of entities.allRecords()) {
            if (!this.entityRegistry.kind(entity.kind)) {
                this.warnOnce(`${entity.plugin} added a "${entity.kind}" entity, but no plugin defines that kind.`);
            }
        }

        this.warnAboutPrefixes(outcome.active);
    }

    /**
     * A name starting with another plugin's prefix is allowed; sous warns once per process, naming
     * both. A name the owning plugin declares `implementable` is expected, and not
     * warned about.
     */
    private warnAboutPrefixes(active: ReadonlyMap<string, ActivePlugin>): void {
        const byPrefix = new Map<string, string>();
        const implementable = new Set<string>();

        for (const [name, { record }] of active) {
            byPrefix.set(pluginPrefix(name), name);

            for (const open of record.definition.implementable ?? []) {
                implementable.add(open);
            }
        }

        for (const { record } of active.values()) {
            const own = pluginPrefix(record.name);

            for (const registration of record.registrations) {
                if (!["service", "intent"].includes(registration.kind) || !registration.name.includes(".")) {
                    continue;
                }

                const prefix = namePrefix(registration.name);
                const owner = byPrefix.get(prefix);

                if (owner && prefix !== own && owner !== record.name && !implementable.has(registration.name)) {
                    this.warnOnce(`${record.name} registers the ${registration.kind} "${registration.name}", which starts with ${owner}'s prefix "${prefix}".`);
                }
            }
        }
    }

    // ------------------------------------------------------------------ plugins

    private registerCore(): void {
        this.entityRegistry.define(
            "config-key",
            {
                "~standard": {
                    version: 1,
                    vendor: "sous",
                    validate: (value: unknown) => {
                        const entry = value as { id?: unknown; schema?: { "~standard"?: unknown } } | null;

                        return typeof entry?.id === "string" && typeof entry.schema?.["~standard"] === "object"
                            ? { value }
                            : { issues: [{ message: "A config-key entity needs an id and a schema." }] };
                    },
                },
            },
            CORE_PLUGIN,
            { description: "A key the config may hold, with its schema." },
        );
        this.entityRegistry.define(
            "plugin-locator",
            {
                "~standard": {
                    version: 1,
                    vendor: "sous",
                    validate: (value: unknown) =>
                        typeof (value as { locate?: unknown } | null)?.locate === "function"
                            ? { value }
                            : { issues: [{ message: "A plugin-locator entity needs a locate function." }] },
                },
            },
            CORE_PLUGIN,
            { description: "Finds a plugin's module from the specifier in plugins.load." },
        );

        for (const key of CORE_CONFIG_KEYS) {
            this.entityRegistry.add("config-key", key, CORE_PLUGIN);
        }
    }

    /**
     * The services plugin code reaches through `sous.services`: the current config's, or, while the
     * config is being built (or a plugin registers), the ones of every loaded plugin, since which
     * plugins are active is only known once the build ends. Only singletons can be used then.
     */
    private directServices(): ServiceContainer {
        if (!this.serviceHost.building() && this.registering === 0) {
            return this.current.services as ServiceContainer;
        }

        const config = Object.create(this.current, {
            isActive: { value: (plugin: string) => plugin === CORE_PLUGIN || this.plugins.get(plugin) !== undefined },
        }) as BuiltConfigImpl;

        return new ServiceContainer({ ...this.serviceHost, building: () => true }, { config, entities: this.current.entities });
    }

    private kindNames(): string[] {
        return this.entityRegistry.kinds().map((kind) => kind.kind);
    }

    private async loadBuiltIns(): Promise<PluginRecord[]> {
        if (!this.builtInRecords) {
            const records: PluginRecord[] = [];

            for (const source of this.builtIns) {
                records.push(await this.loadPlugin(source, { builtIn: true, loadedBy: undefined }));
            }

            this.builtInRecords = records;
        }

        return this.builtInRecords;
    }

    private loadPlugin(source: PluginDefinition | string, options: { builtIn: boolean; loadedBy: string | undefined }, view?: View): Promise<PluginRecord> {
        return this.plugins.load(source, options, {
            resolve: async (specifier) => {
                const definition = await this.resolveSpecifier(specifier, view);

                if (!definition) {
                    throw new PluginError(specifier, `Could not find the plugin "${specifier}".`);
                }

                return definition;
            },
            register: (record) => this.registerPlugin(record),
        });
    }

    private async loadSpecifier(specifier: string, view: View): Promise<PluginRecord | undefined> {
        const known = this.plugins.bySpecifier(specifier) ?? this.plugins.get(specifier);

        if (known) {
            return known;
        }

        const definition = await this.resolveSpecifier(specifier, view);

        if (!definition) {
            return undefined;
        }

        return this.plugins.load(definition, { builtIn: false, loadedBy: undefined, specifier }, {
            resolve: () => Promise.resolve(definition),
            register: (record) => this.registerPlugin(record),
        });
    }

    /**
     * Finds a plugin's definition from a specifier: the `plugin-locator` entities first, in plugin
     * order, then Node's lookup from the project, then from sous's own install.
     */
    private async resolveSpecifier(specifier: string, view: View | undefined): Promise<PluginDefinition | undefined> {
        return this.timer.measure("plugin.load", specifier, undefined, async () => {
            const locators = (view?.entities ?? this.current.entities).list("plugin-locator");

            for (const locator of locators) {
                const found = await locator.locate(specifier, { project: this.project });

                if (found === undefined) {
                    continue;
                }

                if (typeof found === "object" && !(found instanceof URL)) {
                    return found;
                }

                return definitionFromModule(await this.importOrFail(String(found), specifier), specifier);
            }

            const url = locateWithNode(specifier, this.cwd);

            if (url) {
                return definitionFromModule(await this.importOrFail(url, specifier), specifier);
            }

            try {
                return definitionFromModule(await this.importModule(specifier), specifier);
            } catch (error) {
                if (isModuleNotFound(error)) {
                    return undefined;
                }

                throw new PluginError(specifier, `The plugin "${specifier}" could not be loaded: ${messageOf(error)}`, { cause: error });
            }
        });
    }

    private async importOrFail(url: string, specifier: string): Promise<unknown> {
        try {
            return await this.importModule(url);
        } catch (error) {
            throw new PluginError(specifier, `The plugin "${specifier}" could not be loaded: ${messageOf(error)}`, { cause: error });
        }
    }

    private async registerPlugin(record: PluginRecord): Promise<void> {
        const sous = createSousApi(this.apiHost, record);

        this.registering += 1;

        try {
            await this.timer.measure("plugin.register", record.name, record.name, () => record.definition.register(sous));
        } catch (error) {
            if (error instanceof SousError) {
                throw error;
            }

            throw new PluginError(record.name, `The plugin ${record.name} failed to register: ${messageOf(error)}`, { cause: error });
        } finally {
            this.registering -= 1;
        }
    }

    private createApiHost(): SousApiHost {
        const engine = this;

        return {
        handle: this.handle,
        get project() {
            return engine.project;
        },
        env: this.env,
        get reporter(): Reporter {
            return engine.reporterImpl;
        },
        addContributor: (definition: ContributorDefinition, record: PluginRecord) => {
            this.contributors.add(definition, record.name, record.definition);
        },
        addIntent: (definition: IntentDefinition, record: PluginRecord) => {
            this.intents.add(definition, record.name);
        },
        wrapIntent: (intent: string, wrapper: IntentWrapper, record: PluginRecord) => {
            this.intents.wrap(intent, wrapper, record.name);
        },
        addService: (name: string, factory: ServiceFactory<unknown>, options: ServiceOptions, replaces: boolean, record: PluginRecord) => {
            if (typeof factory !== "function") {
                throw new SousError(`${record.name} added the service "${name}" without a factory function.`);
            }

            this.services.addProvider({ name, factory, lifetime: options.lifetime ?? "config", plugin: record.name, replaces });
        },
        wrapService: (name: string, wrapper: ServiceWrapper<unknown>, record: PluginRecord) => {
            this.services.addWrapper(name, wrapper, record.name);
        },
        getService: (name: string) => this.directServices().get(name),
        hasService: (name: string) => this.directServices().has(name),
        defineEntityKind: (kind: string, schema: SousSchema, options: EntityKindOptions, record: PluginRecord) => {
            this.entityRegistry.define(kind, schema, record.name, options);
        },
        addEntity: (kind: string, entry: unknown, record: PluginRecord) => {
            this.entityRegistry.add(kind, entry, record.name);
        },
        entitiesForDirectRead: (record: PluginRecord) => {
            const contributor = this.contributorStack.at(-1);

            // A note for the plugin's author, not its user: shown at the debug level only.
            if (contributor) {
                this.warnOnce(
                    `The contributor "${contributor}" read sous.entities directly while the config was being built (${record.name}). ` +
                        "Read entities through the builder (config.entities), or the contributor will not re-run when they change.",
                    "debug",
                );
            }

            return this.current.entities;
        },
        addPlugin: async (source: PluginDefinition | string, record: PluginRecord) => {
            const child = await this.loadPlugin(source, { builtIn: record.builtIn, loadedBy: record.name });

            if (!record.children.includes(child.name)) {
                record.children.push(child.name);
            }
        },
        addFrontEnd: (definition: FrontEndDefinition, record: PluginRecord) => {
            const existing = this.frontEnds.get(definition.id);

            if (existing && existing.plugin !== record.name) {
                throw new SousError(`Two plugins add the front end "${definition.id}": ${existing.plugin} and ${record.name}.`);
            }

            this.frontEnds.set(definition.id, { definition, plugin: record.name });
        },
        listen: (pattern: EventPattern, listener: Listener<never>, options: ListenerOptions & { once?: boolean }, record: PluginRecord) => {
            if (typeof listener !== "function") {
                throw new SousError(`${record.name} added a listener for "${String(pattern)}" that is not a function.`);
            }

            this.bus.add(pattern, listener as unknown as StoredListenerFn, record.name, options);
        },
        unlisten: (pattern: EventPattern, listener: Listener<never>) => {
            this.bus.remove(pattern, listener);
        },
        emit: (name: string, payload: unknown, record: PluginRecord) => {
            void record;

            return this.emitCustom(name, payload, this.detachedCall());
        },
        };
    }

    // ------------------------------------------------------------------ chains and intents

    private submitWith(request: IntentRequest, options: SubmitOptions, parentFrame: Frame | undefined): Promise<unknown> {
        const info = this.resolveIntent(request.intent, this.current);
        const reporter = options.reporter ?? this.reporterImpl;
        const prompter = options.prompter ?? nonInteractivePrompter;
        const globals = Object.freeze({ ...(options.globals ?? {}) });
        const cwd = options.cwd ?? this.cwd;
        const definition = info.definition;

        if (definition.background) {
            try {
                this.checkBuildFailure(definition, reporter);
            } catch (error) {
                return Promise.reject(error);
            }

            return this.startBackground(request, { reporter, prompter, globals, cwd }, parentFrame);
        }

        const parallel = options.parallel ?? definition.parallel ?? false;
        const tolerant = definition.toleratesConfigErrors === true;

        return this.scheduler.enqueue(
            parallel,
            async (markChanged) => {
                this.checkBuildFailure(definition, reporter);

                const chain = new ChainState(++this.chainCounter, request.intent, parallel, this.current, reporter, prompter, globals);
                const call: CallState = { mode: "chain", chain, frame: parentFrame, config: chain.config, reporter, prompter, globals, cwd };

                try {
                    return await this.timer.measure("chain", request.intent, undefined, () => this.runIntent(request.intent, request.input, call));
                } finally {
                    if (chain.changedConfig) {
                        markChanged();
                    }
                }
            },
            { toleratesConfigErrors: tolerant },
        );
    }

    /**
     * When the latest build failed: an intent that tolerates it runs with the partial config, and
     * the error is reported as a warning; any other fails with the build's error.
     */
    private checkBuildFailure(definition: IntentDefinition, reporter: Reporter): void {
        if (!this.failure) {
            return;
        }

        if (definition.toleratesConfigErrors !== true) {
            throw this.failure.error;
        }

        const error = this.failure.error;
        const details = error instanceof SousError && error.details.length > 0 ? ` (${error.details.join("; ")})` : "";

        reporter.problem(`The config could not be built, so ${definition.intent} runs with what was built before the error.`, { cause: `${messageOf(error)}${details}` });
    }

    /**
     * Rebuilds the config in the middle of a series chain (`ctx.refreshConfig()`): the rest of the
     * chain uses the new config and its services.
     */
    private async refreshChainConfig(call: CallState, options: RefreshConfigOptions = {}): Promise<BuiltConfig> {
        const chain = call.chain;

        if (call.mode !== "chain" || !chain) {
            throw new SousError("ctx.refreshConfig() can only be used inside a chain.", {
                details: ["A config.built listener, a background intent or code outside a chain cannot refresh the config; call ctx.configChanged() instead."],
            });
        }

        if (this.streakTriggers !== undefined || this.realBuilds > 0) {
            throw new SousError("ctx.refreshConfig() cannot be used while the config is being built or its config.built listeners run.", {
                details: ["Call ctx.configChanged() instead; the config is rebuilt when the listeners finish."],
            });
        }

        if (chain.parallel) {
            throw new SousError(`ctx.refreshConfig() cannot be used in a parallel chain (${chain.intent}).`, {
                details: ["Other chains may be using the config. Declare the intent as a series one, or call ctx.configChanged() instead."],
            });
        }

        if (options.locateProjectFrom !== undefined && this.locateProject) {
            const found = this.locateProject(options.locateProjectFrom);

            if (found && found.root !== this.currentProject?.root) {
                this.currentProject = found;
            }
        }

        const built = (await this.buildConfig()) as BuiltConfigImpl;

        chain.config = built;
        chain.changedConfig = false;

        return built;
    }

    private startBackground(
        request: IntentRequest,
        io: { reporter: Reporter; prompter: SubmitOptions["prompter"] & object; globals: Readonly<Record<string, unknown>>; cwd: string },
        parentFrame: Frame | undefined,
    ): Promise<unknown> {
        const call: CallState = { mode: "background", chain: undefined, frame: parentFrame, config: this.current, ...io };
        const running = this.runIntent(request.intent, request.input, call);
        const tracked = running.finally(() => this.background.delete(tracked));

        tracked.catch(() => {});
        this.background.add(tracked);

        return running;
    }

    private resolveIntent(name: string, config: BuiltConfigImpl): IntentInfo {
        const resolved = this.intents.resolve(name, config.isActive, config.intentPicks);

        if (!resolved) {
            throw new NotFoundError("intent", name);
        }

        return resolved.entry;
    }

    /**
     * Runs one intent: checks the limits, checks the input, fires `.before`, runs the
     * wrapped handler, fires `.error` on failure and `.after` on success.
     */
    private async runIntent(name: string, rawInput: unknown, call: CallState): Promise<unknown> {
        const config = configOf(call, () => this.current);
        const info = this.resolveIntent(name, config);
        const definition = info.definition;
        const limits = config.limits;
        const depth = countFrames(call.frame, "intent") + 1;

        if (definition.requiresProject === true && this.currentProject === undefined) {
            throw noProjectError(call.cwd ?? this.cwd);
        }

        if (depth > limits.runDepth) {
            throw new LoopError("runDepth", `Intents are nested ${depth} deep, past the limit of ${limits.runDepth}.`, {
                details: [describeFramePath(pushFrame(call.frame, "intent", name, rawInput))],
            });
        }

        const input = await this.checkInput(definition, rawInput);
        const inputKey = stableKey(input);
        const repeats = countFrames(call.frame, "intent", name, inputKey) + 1;

        if (repeats > limits.sameIntentDepth) {
            throw new LoopError("sameIntentDepth", `"${name}" called itself with the same input, ${repeats} deep (the limit is ${limits.sameIntentDepth}).`, {
                details: [describeFramePath(pushFrame(call.frame, "intent", name, input))],
            });
        }

        const frame = pushFrame(call.frame, "intent", name, input);
        const inner: CallState = { ...call, frame };
        const data = new Map<string, unknown>();
        const before = new BeforeEventImpl(name, input, data);

        await this.dispatch(before, inner);

        if (before.cancelled) {
            throw new CancelledError(name, before.cancelReason ?? "no reason given", before.cancelledBy);
        }

        if (definition.changesConfig) {
            if (call.chain) {
                call.chain.changedConfig = true;
            } else {
                this.scheduler.markDirty();
            }
        }

        let result: unknown;

        try {
            const handler = await this.composeHandler(info, config);
            const ctx = createContext(this.callHost, inner, info.plugin);

            result = await this.timer.measure("intent", name, info.plugin, () => handler(before.input, ctx));
        } catch (error) {
            const failed = new ErrorEventImpl(name, before.input, error, data);

            await this.dispatch(failed, inner);

            if (!failed.recovered) {
                throw error;
            }

            result = failed.recoveredResult;
        }

        const after = new AfterEventImpl(name, before.input, result, data);

        await this.dispatch(after, inner);

        return after.result;
    }

    private async checkInput(definition: IntentDefinition, rawInput: unknown): Promise<unknown> {
        if (!definition.input) {
            return rawInput ?? {};
        }

        const checked = await validateWith(definition.input, rawInput ?? {});

        if (checked.issues) {
            throw new InputError(definition.intent, checked.issues);
        }

        return checked.value;
    }

    private async composeHandler(info: IntentInfo, config: BuiltConfigImpl) {
        let handler = await this.intents.handlerOf(info.definition);

        for (const entry of this.intents.wrappersFor(info.definition.intent, config.isActive)) {
            handler = entry.wrapper(handler);
        }

        return handler;
    }

    /** Runs an intent as its own chain, at once: used by `config.built` listeners. */
    private async runInline(intent: string, input: unknown, call: CallState): Promise<unknown> {
        const chain = new ChainState(++this.chainCounter, intent, false, this.current, call.reporter, call.prompter, call.globals);
        const result = await this.runIntent(intent, input, { ...call, mode: "chain", chain, config: this.current });

        if (chain.changedConfig) {
            this.streakTriggers?.push({ path: describeFramePath(pushFrame(call.frame, "intent", intent, input)) });

            if (!this.streakTriggers) {
                this.scheduler.markDirty();
            }
        }

        return result;
    }

    private createCallHost(): CallHost {
        const engine = this;

        return {
        handle: this.handle,
        get project() {
            return engine.project;
        },
        env: this.env,
        latestConfig: () => this.current,
        run: (intent: string, input: unknown, call: CallState) => {
            switch (call.mode) {
                case "chain":
                    return this.runIntent(intent, input, call);
                case "inline":
                    return this.runInline(intent, input, call);
                default:
                    return this.submitWith(
                        { intent, input: input as never },
                        { reporter: call.reporter, prompter: call.prompter, globals: call.globals, cwd: call.cwd },
                        call.frame,
                    );
            }
        },
        emitCustom: (name: string, payload: unknown, call: CallState) => this.emitCustom(name, payload, call),
        markConfigChanged: () => this.scheduler.markDirty(),
        refreshConfig: (call: CallState, options?: RefreshConfigOptions) => this.refreshChainConfig(call, options),
        };
    }

    private detachedCall(): CallState {
        return {
            mode: "detached",
            chain: undefined,
            frame: undefined,
            config: this.current,
            reporter: this.reporterImpl,
            prompter: nonInteractivePrompter,
            globals: {},
            cwd: this.cwd,
        };
    }

    private inlineCall(config: BuiltConfigImpl): CallState {
        return { mode: "inline", chain: undefined, frame: undefined, config, reporter: this.reporterImpl, prompter: nonInteractivePrompter, globals: {}, cwd: this.cwd };
    }

    // ------------------------------------------------------------------ events

    private async emitCustom(name: string, payload: unknown, call: CallState): Promise<unknown> {
        const event = new CustomEventImpl(name, payload);

        if (this.contributorStack.length > 0 || this.registering > 0) {
            this.warnOnce(
                `"${name}" was emitted while the config was being built, so no listener saw it. ` +
                    "No events fire during config building; contributors take part through the builder.",
            );

            return event;
        }

        await this.dispatch(event, call);

        return event;
    }

    /**
     * Gives an event to every matching listener of an active plugin, in order:
     * priority, then plugin order, then the order they were added. A listener that throws fails the
     * caller.
     */
    private async dispatch(event: BaseEvent, call: CallState): Promise<void> {
        const config = configOf(call, () => this.current);
        const depth = countFrames(call.frame, "event", event.name) + 1;

        if (depth > config.limits.eventDepth) {
            throw new LoopError("eventDepth", `"${event.name}" was emitted ${depth} deep while its own listeners were running (the limit is ${config.limits.eventDepth}).`, {
                details: [describeFramePath(pushFrame(call.frame, "event", event.name))],
            });
        }

        const frame = pushFrame(call.frame, "event", event.name);

        for (const entry of this.bus.matching(event.name)) {
            if (event.propagationStopped) {
                break;
            }

            if (!config.isActive(entry.plugin)) {
                continue;
            }

            if (entry.once) {
                this.bus.removeEntry(entry);
            }

            const ctx = createContext(this.callHost, { ...call, frame: pushFrame(frame, "listener", entry.plugin) }, entry.plugin);

            event.currentPlugin = entry.plugin;

            try {
                await this.timer.measure("listener", `${event.name}:${entry.plugin}`, entry.plugin, () => entry.fn(event, ctx as never));
            } finally {
                event.currentPlugin = undefined;
            }
        }
    }

    // ------------------------------------------------------------------ timing and messages

    private timeEntityMethods(kind: string, entry: Record<string, unknown>, plugin: string): Record<string, unknown> {
        let timed: Record<string, unknown> | undefined;

        for (const [key, value] of Object.entries(entry)) {
            if (typeof value === "function" && !/^[A-Z]/.test(key)) {
                timed ??= { ...entry };
                timed[key] = timeFunction(value as (...args: unknown[]) => unknown, undefined, `${kind}:${String(entry.id)}.${key}`, plugin, this.timer, "entity.method");
            }
        }

        return timed ?? entry;
    }

    private reportOverBudget(over: OverBudget, batch: readonly OverBudget[]): void {
        const { summary, cause, hint } = describeOverBudget(over, batch);

        this.reporterImpl.problem(summary, cause === undefined ? { hint } : { cause, hint });
    }

    private warnOnce(message: string, level: "warning" | "debug" = "warning"): void {
        if (!this.warnedOnce.has(message)) {
            this.warnedOnce.add(message);
            if (level === "debug") {
                this.reporterImpl.debug(message);
            } else {
                this.reporterImpl.warning(message);
            }
        }
    }

    private createHandle(): EngineHandle {
        const engine = this;

        return {
            get config() {
                return engine.current;
            },
            get app() {
                return engine.app;
            },
            intents: {
                list: () => {
                    try {
                        return engine.intents.list(engine.current.isActive, engine.current.intentPicks).map(({ definition, plugin }) => ({ definition, plugin }));
                    } catch {
                        return [];
                    }
                },
                get: (name) => {
                    try {
                        const resolved = engine.intents.resolve(name, engine.current.isActive, engine.current.intentPicks);

                        return resolved ? { definition: resolved.entry.definition, plugin: resolved.entry.plugin } : undefined;
                    } catch {
                        return undefined;
                    }
                },
            },
            get timings() {
                return engine.timer;
            },
            get reporter() {
                return engine.reporterImpl;
            },
            get configError() {
                return engine.configError;
            },
            setReporter: (reporter) => engine.setReporter(reporter),
            submit: ((request: IntentRequest, options?: SubmitOptions) => engine.submit(request, options)) as EngineHandle["submit"],
            buildConfig: (options) => engine.buildWhatIf(options),
            plugins: () => engine.pluginInfo(),
            whenBackgroundIntentsReturn: () => engine.whenBackgroundIntentsReturn(),
        };
    }
}

function hashOf(config: Readonly<JsonObject>, entities: EntitySnapshot): string {
    const ids = entities
        .allRecords()
        .map((entity) => `${entity.kind}/${entitySignature(entity)}`)
        .sort();

    return createHash("sha1").update(stableStringify(config)).update("\u0000").update(ids.join("\n")).digest("hex");
}

function uniqueTriggers(triggers: readonly RebuildTrigger[]): string[] {
    return [...new Set(triggers.map((trigger) => trigger.path))];
}

function isModuleNotFound(error: unknown): boolean {
    const code = (error as { code?: unknown } | null)?.code;

    return code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND" || code === "ERR_PACKAGE_PATH_NOT_EXPORTED";
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export { WHAT_IF_PLUGIN };

/**
 * The error for an intent that needs a project, run outside one. It names the directories sous
 * looked in, as the CLI before 1.0 did.
 */
function noProjectError(cwd: string): ConfigError {
    const looked: string[] = [];

    for (let dir = path.resolve(cwd); looked.length < 8; dir = path.dirname(dir)) {
        looked.push(`    ${path.join(dir, ".sous")}/`);

        if (path.dirname(dir) === dir) {
            break;
        }
    }

    return new ConfigError("No sous config found.", {
        details: [
            `Starting at ${cwd}, sous walked up looking for a .sous/ directory holding a sous.config file.`,
            "Checked:",
            ...looked,
            "To fix this, either:",
            "  1. Set the project up: run 'sous init' in its root directory, or",
            "  2. Pass the config explicitly: sous <command> --config <path>",
        ],
    });
}
