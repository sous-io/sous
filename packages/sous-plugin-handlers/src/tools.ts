/**
 * What a handler receives as `sous`: the full context a plugin receives, plus the helpers of
 * spec S13 (`sous.report`, `sous.utils.*`, `sous.editor.file`, `sous.vars.get`, ...). A handler
 * never prints: what it reports is collected here, and the runner hands it to the command.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { SousError, type ConfigBuilder, type Context, type Environment, type ProjectInfo, type ServiceReader } from "@sous-io/sous-plugin-api";
import type {} from "@sous-io/sous-plugin-host/types";
import type {} from "@sous-io/sous-plugin-recipe-answers/types";
import type {} from "@sous-io/sous-plugin-variables/types";
import type { HandlerHelpers, HandlerReportEntry, HandlerTools, HandlerUtils, HandlersSystem } from "./types.js";

/** The service a direct edit goes through, from `@sous-io/sous-plugin-editor`. */
export const EDITOR_SERVICE = "editor";

/** Collects what one handler reports. */
export class ReportCollector {
    readonly entries: HandlerReportEntry[] = [];

    constructor(private readonly handler: string) {}

    readonly report = {
        error: (message: string) => this.add("error", message),
        warn: (message: string) => this.add("warn", message),
        info: (message: string) => this.add("info", message),
    };

    private add(level: HandlerReportEntry["level"], message: unknown): void {
        this.entries.push({ level, message: String(message), handler: this.handler });
    }
}

/** What the helpers are made from. */
export interface HelperSources {
    readonly project: ProjectInfo;
    readonly env: Environment;
    /** Services, read when a helper is called. */
    readonly services: () => ServiceReader | undefined;
    readonly config: { get<T = unknown>(path: string): T | undefined };
    /** A recipe variable's answer. */
    readonly vars: (name: string) => string | undefined;
    /** Why `sous.editor.file` cannot work here, when it cannot. */
    readonly editorUnavailable?: string;
}

/** A path relative to the project's folder, made absolute. */
function inProject(project: ProjectInfo, file: string): string {
    return path.resolve(project.root, file);
}

/** A service, or an error naming the plugin that provides it. */
function needService<T>(services: ServiceReader | undefined, name: string, plugin: string): T {
    if (services === undefined || !services.has(name)) {
        throw new SousError(`This helper needs the "${name}" service, which ${plugin} provides, and it is not available here.`);
    }

    return services.get(name as never) as T;
}

/** The helpers, without the context. */
export function createHelpers(sources: HelperSources, report: ReportCollector["report"]): HandlerHelpers {
    const { project } = sources;
    const system = (): HandlersSystem => needService<HandlersSystem>(sources.services(), "handlers.system", "@sous-io/sous-plugin-handlers");

    const utils: HandlerUtils = {
        system: {
            isAppAvailable: (name) => system().isAppAvailable(name),
            appVersion: (name) => system().appVersion(name),
        },
        process: {
            run(command, args = [], options = {}) {
                const processes = needService<import("@sous-io/sous-plugin-host/types").HostProcesses>(sources.services(), "host.processes", "@sous-io/sous-plugin-host");

                return processes.run(command, args, {
                    cwd: options.cwd === undefined ? project.root : inProject(project, options.cwd),
                    env: sources.env,
                    label: `${command} ${args.slice(0, 1).join(" ")}`.trim(),
                    ...(options.input === undefined ? {} : { input: options.input }),
                    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
                });
            },
        },
        file: {
            async exists(file) {
                try {
                    await fs.access(inProject(project, file));

                    return true;
                } catch {
                    return false;
                }
            },
            async read(file) {
                try {
                    return await fs.readFile(inProject(project, file), "utf8");
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                        return undefined;
                    }

                    throw error;
                }
            },
            async remove(file) {
                const absolute = inProject(project, file);

                try {
                    await fs.rm(absolute);

                    return true;
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                        return false;
                    }

                    throw error;
                }
            },
        },
        files: {
            async removeMatching(pattern) {
                const globs = needService<import("@sous-io/sous-plugin-host/types").HostGlobs>(sources.services(), "host.globs", "@sous-io/sous-plugin-host");
                const matched = await globs.match(pattern, { cwd: project.root, dot: true, onlyFiles: true });

                for (const file of matched) {
                    await fs.rm(inProject(project, file), { force: true });
                }

                return matched;
            },
        },
    };

    return {
        report,
        utils,
        editor: {
            file(file) {
                const services = sources.services();

                if (sources.editorUnavailable !== undefined) {
                    throw new SousError(sources.editorUnavailable);
                }

                if (services === undefined || !services.has(EDITOR_SERVICE)) {
                    throw new SousError(
                        "sous.editor.file needs the document editor (the \"editor\" service of @sous-io/sous-plugin-editor), and it is not loaded.",
                        { details: ["Load @sous-io/sous-plugin-editor, or remove it from plugins.disabled."] },
                    );
                }

                return (services.get(EDITOR_SERVICE as never) as { file(file: string): unknown }).file(file);
            },
        },
        vars: { get: (name) => sources.vars(name) },
        project,
        config: sources.config,
        env: sources.env,
    };
}

/** A recipe variable's answer, from `recipe-answers.answers`. */
function answerFrom(services: ServiceReader, recipe: string | undefined, name: string): string | undefined {
    if (!services.has("recipe-answers.answers")) {
        return undefined;
    }

    const answers = services.get("recipe-answers.answers");

    return recipe === undefined ? answers.get().merged[name] : answers.forRecipe(recipe)[name];
}

/**
 * What a handler run from an intent receives: the context, with the helpers laid over it. The
 * context's own methods keep their `this`.
 */
export function createTools(ctx: Context, project: ProjectInfo, recipe: string | undefined, report: ReportCollector["report"]): HandlerTools {
    const helpers = createHelpers(
        {
            project,
            env: ctx.env,
            services: () => ctx.services,
            config: { get: (key) => ctx.config.get(key) as never },
            vars: (name) => answerFrom(ctx.services, recipe, name),
        },
        report,
    );
    // `config` stays the context's own: the finished config, whose `get` is `sous.config.get`.
    const { config: _config, ...own } = { ...helpers, project } as Record<string, unknown>;

    return new Proxy(ctx as object, {
        get(target, property) {
            if (typeof property === "string" && Object.hasOwn(own, property)) {
                return own[property];
            }

            const value = Reflect.get(target, property, target) as unknown;

            return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        },
        has(target, property) {
            return (typeof property === "string" && Object.hasOwn(own, property)) || Reflect.has(target, property);
        },
    }) as HandlerTools;
}

/**
 * What a `configure` handler receives: the helpers, over the config built so far. There is no
 * finished config and no `ctx`: services and direct edits are not available while the config is built.
 */
export function createConfigureTools(
    config: ConfigBuilder,
    services: () => ServiceReader | undefined,
    recipe: string | undefined,
    report: ReportCollector["report"],
): HandlerHelpers {
    const project = config.project as ProjectInfo;

    return createHelpers(
        {
            project,
            env: config.env,
            services,
            config: { get: (key) => config.atPath(key).get() as never },
            vars: (name) => configureAnswer(config, recipe, name),
            editorUnavailable:
                "sous.editor.file edits a document directly, which cannot happen while the config is built. " +
                "In a configure handler, declare the edit instead: add it to editor.edits through the config builder.",
        },
        report,
    );
}

/** A recipe variable's answer while the config is built, from the `recipe-answers` variable source. */
function configureAnswer(config: ConfigBuilder, recipe: string | undefined, name: string): string | undefined {
    const source = config.entity("variable-source", "recipe-answers");

    if (source === undefined) {
        return undefined;
    }

    const lookup = { project: config.project, env: config.env, config: { get: (key: never) => config.atPath(key).get() as never } };

    return (recipe === undefined ? undefined : source.scoped?.(recipe, lookup)?.[name]) ?? source.variables(lookup)[name];
}
