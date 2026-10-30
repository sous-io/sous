/**
 * The contract of plugin-liquid: building a configured LiquidJS
 * engine with every tag and filter plugins add. The compiler renders templates with it, and
 * config expressions evaluate with it.
 *
 * Other plugins import this file type-only.
 */

import type { Environment, EntityReader, ProjectInfo, ServiceReader } from "@sous-io/plugin-api";
import type { FS, FilterImplOptions, Liquid, LiquidOptions } from "liquidjs";

export type { FS, FilterImplOptions, Liquid, LiquidOptions };

/** What `Liquid.registerTag` takes: a tag class, or the options LiquidJS turns into one. */
export type LiquidTagImplementation = Parameters<Liquid["registerTag"]>[1];

/** What a tag's or filter's factory gets when an engine is built. */
export interface LiquidExtensionContext {
    readonly project: ProjectInfo | undefined;
    readonly env: Environment;
    readonly services: ServiceReader;
    readonly entities: EntityReader;
    /** What the engine is for: `config-expression`, `template`, or a plugin's own purpose. */
    readonly purpose: LiquidPurpose;
    /** Names declared secret, which tags that dump a scope must hide. */
    readonly secretNames: ReadonlySet<string>;
    /** Whatever the code building the engine handed over (the compiler hands its include context). */
    readonly data: Readonly<Record<string, unknown>>;
}

/** Why an engine is built. */
export type LiquidPurpose = "config-expression" | "template" | (string & {});

/** A `liquid-tag` entity: a Liquid tag any plugin adds. */
export interface LiquidTagEntity {
    /** The tag's name, as written in `{% name %}`. */
    id: string;
    /** What it does, for `plugins show`. */
    description?: string;
    /** The purposes it is registered for. Default: every purpose except `config-expression`. */
    purposes?: readonly LiquidPurpose[];
    /** Makes the tag for one engine. */
    tag(ctx: LiquidExtensionContext): LiquidTagImplementation;
}

/** A `liquid-filter` entity: a Liquid filter any plugin adds; config expressions see it too. */
export interface LiquidFilterEntity {
    /** The filter's name, as written after `|`. */
    id: string;
    description?: string;
    /** The purposes it is registered for. Default: every purpose, config expressions included. */
    purposes?: readonly LiquidPurpose[];
    /** Makes the filter for one engine. A filter config expressions use must give the same result for the same input. */
    filter(ctx: LiquidExtensionContext): FilterImplOptions;
}

/** How to build one engine. */
export interface LiquidEngineOptions {
    /** Default `template`. */
    purpose?: LiquidPurpose;
    /** The file system Liquid reads `{% render %}` and `{% include %}` paths through (the compiler's include resolution). */
    fs?: FS;
    /** Directories partials are looked up in. */
    root?: string | readonly string[];
    /** Names declared secret. */
    secretNames?: Iterable<string>;
    /** Handed to every tag and filter factory as `ctx.data`. */
    data?: Readonly<Record<string, unknown>>;
    /** Only these tags and filters, by id; default every one whose `purposes` allow it. */
    only?: { tags?: readonly string[]; filters?: readonly string[] };
    /** Any other LiquidJS option, passed through. */
    liquid?: Omit<LiquidOptions, "fs" | "root">;
}

/** Building configured LiquidJS engines. */
export interface LiquidEngines {
    /** A new engine with every tag and filter the entities add. */
    create(options?: LiquidEngineOptions): Liquid;
    /** The ids of every tag and filter an engine of a purpose gets. */
    available(purpose?: LiquidPurpose): { tags: string[]; filters: string[] };
}

declare module "@sous-io/plugin-api" {
    interface SousServices {
        /** Building LiquidJS engines. */
        "liquid.engine": LiquidEngines;
    }

    interface SousEntities {
        /** A Liquid tag. */
        "liquid-tag": LiquidTagEntity;
        /** A Liquid filter. */
        "liquid-filter": LiquidFilterEntity;
    }
}
